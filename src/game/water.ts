/**
 * Droughtline — Timberborn-ground-truth water solver.
 * WATER_SPEC.md v2 (final). Ground truth: Timberborn.WaterSystem.dll IL.
 *
 * ── PORT RULES (§19) ───────────────────────────────────────────────
 *  R1  f32 everywhere except diffusion-limit f64 compares.
 *  R2  unordered compares: NaN => branch taken. uge/ule/une.
 *  R3  ceil() = Math.ceil then |0.
 *  R4  iteration orders semantic.
 *  R5  DirectedFlow entries NOT unique — SUM.
 *  R6  contamination clamps asymmetric — copy as-is.
 *  R7  quirks verbatim.
 *  R8  Floor/Ceiling bytes 0..255 asserted.
 * ────────────────────────────────────────────────────────────────────
 */

const F32 = Math.fround;
const fadd = (a: number, b: number) => F32(a + b);
const fsub = (a: number, b: number) => F32(a - b);
const fmul = (a: number, b: number) => F32(a * b);
const fdiv = (a: number, b: number) => F32(a / b);
const fneg = (a: number) => F32(-a);
const fmax = (a: number, b: number) => F32(Math.max(a, b));
const fmin = (a: number, b: number) => F32(Math.min(a, b));
function fclamp01(v: number): number { return v < 0 ? 0 : (v > 1 ? 1 : v); }
function fclamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : (v > hi ? hi : v);
}
const uge = (a: number, b: number) => !(a < b);
const ule = (a: number, b: number) => !(a > b);
const une = (a: number, b: number) => a !== b;

// ── [§3] Constants ─────────────────────────────────────────────────
// [v2 erratum 1] effective = 2.25 × dt(0.3), pre-multiplied at load
const K_WATERFLOWFACTOR_EFFECTIVE = 0.675;
const K_WATERSPILLTHRESHOLD = 0.1;
const K_OVERFLOWPRESSUREFACTOR = 8.0;
const K_OUTFLOWBALANCINGSCALER = 0.8;
const K_SOFTDAMOFFSET = 0.1;
const K_HARDDAMOFFSET = 0.1;
const K_HARDDAMSMOOTHINGFACTOR = 2.25;
const K_MINHARDDAMSMOOTHING = 0.5;
const K_MAXHARDDAMSMOOTHING = 2.0;
const K_MAXHARDDAMDECREASE = 0.02;
const K_NORMALEVAPORATIONSPEED = 0.0001;
const K_FASTEVAPORATIONSPEED = 0.001;
const K_FASTEVAPORATIONDEPTHTHRESHOLD = 0.02;
const K_DIFFUSIONRATE = 0.45;
const K_DIFFUSIONOUTFLOWLIMIT = 0.125;
const K_DIFFUSIONDEPTHLIMIT = 0.1;
const K_MAXWATERCONTAMINATION = 1.0;
const K_FLOWRETENTION = 0.999;
const K_HARDDAMRETENTION = 0.995;
const K_SUBSTEPCOUNT = 2;
const K_DEAD_TARGET = -1;
const F32_MAX = 3.4028234663852886e38;

// [v2 erratum 2] Evap modifier table from clusterSaturation (u8 0–9)
// s=0 → 1.0 (special case, NOT formula 7.68)
const EVAP_MOD_TABLE = [1.0, 6.45, 5.34, 4.34, 3.47, 2.71, 2.08, 1.56, 1.16, 0.88];

const OFF_BOTTOM = 0, OFF_LEFT = 1, OFF_TOP = 2, OFF_RIGHT = 3;

function assertByte(v: number, what: string): number {
  const i = v | 0;
  if (i !== v || i < 0 || i > 255) throw new Error(`R8: ${what}=${v} not a byte`);
  return i;
}

export interface WaterSourceDef {
  coords: Array<{ x: number; y: number; z: number }>;
  currentStrength: number;
  contamination: number;
}
export interface WaterChangeDef {
  x: number; y: number; z: number;
  depthChange: number; contaminationChange: number;
}
export interface WaterModification {
  kind: 'obstacle' | 'inflowLimit' | 'heightLimit' | 'directionLimit';
  added: boolean; x: number; y: number; z: number;
  obstacleType?: 0 | 1 | 2; value?: number;
}

export class WaterSimCore {
  readonly mapX: number;
  readonly mapY: number;
  readonly mapHeight: number;
  readonly maxColumnHeight: number;
  readonly stride: number;
  readonly verticalStride: number;
  readonly cellCount: number;
  readonly maxLevels: number;
  readonly slots: number;

  // Columns (SoA per slot) [§1]
  readonly colFloor: Uint8Array;
  readonly colCeiling: Uint8Array;
  readonly colWaterDepth: Float32Array;
  readonly colOldWaterDepth: Float32Array;
  readonly colContamination: Float32Array;
  readonly colOverflow: Float32Array;
  readonly colCount: Uint8Array;

  readonly baseLevelFlows: Float32Array;
  readonly baseLevelDiffusions: Uint8Array;

  private dfFlow!: Float32Array;
  private dfTarget!: Int32Array;
  private dfOrigin!: Int32Array;
  private dfStart!: Int32Array;
  private dfLen!: Int32Array;
  private dfCursor = 0;

  private tdTarget!: Int32Array;
  private tdOrigin!: Int32Array;
  private tdStart!: Int32Array;
  private tdLen!: Int32Array;
  private tdCursor = 0;
  readonly targetedDiffusionCount: Uint8Array;

  private outSideFlow: Float32Array;
  private outSideTarget: Int32Array;
  private olFlow!: Float32Array;
  private olTarget!: Int32Array;
  private olStart: Int32Array;
  private olLen: Int32Array;
  private olCursor = 0;

  readonly heightLimits: Float32Array;
  readonly inflowLimits: Float32Array;
  readonly limitedDirections: Int32Array;
  readonly clusterSaturation: Uint8Array;
  readonly contaminationsBuffer: Float32Array;

  waterSources: WaterSourceDef[] = [];
  waterChanges: WaterChangeDef[] = [];
  removedWater = new Map<number, { clean: number; contaminated: number }>();
  private modQueue: WaterModification[] = [];

  tickIntervalSeconds = NaN;
  hasContamination = false;
  onSubstep: ((substep: number, core: WaterSimCore) => void) | null = null;

  // [v2 visual] renderer multi-column buffer
  readonly maxWaterLevels: number;
  readonly waterMulti: Float32Array;

  // Profiling
  profile = { outflows: 0, depth: 0, sources: 0, clear: 0, changes: 0 };

  constructor(mapX: number, mapY: number, mapHeight: number, maxLevels = 8) {
    this.mapX = mapX;
    this.mapY = mapY;
    this.mapHeight = mapHeight;
    this.maxColumnHeight = mapHeight + 1;
    this.stride = mapX + 2;
    this.cellCount = (mapX + 2) * (mapY + 2);
    this.verticalStride = this.cellCount;
    this.maxLevels = maxLevels;
    this.slots = maxLevels * this.cellCount;

    const S = this.slots, C = this.cellCount;
    this.colFloor = new Uint8Array(S);
    this.colCeiling = new Uint8Array(S);
    this.colWaterDepth = new Float32Array(S);
    this.colOldWaterDepth = new Float32Array(S);
    this.colContamination = new Float32Array(S);
    this.colOverflow = new Float32Array(S);
    this.colCount = new Uint8Array(C);

    this.baseLevelFlows = new Float32Array(C * 4);
    this.baseLevelDiffusions = new Uint8Array(C * 4);
    this.targetedDiffusionCount = new Uint8Array(S);

    const d0 = Math.max(1024, C * 4);
    this.dfFlow = new Float32Array(d0);
    this.dfTarget = new Int32Array(d0);
    this.dfOrigin = new Int32Array(d0);
    this.dfStart = new Int32Array(C);
    this.dfLen = new Int32Array(C);

    this.tdTarget = new Int32Array(d0);
    this.tdOrigin = new Int32Array(d0);
    this.tdStart = new Int32Array(C);
    this.tdLen = new Int32Array(C);

    this.outSideFlow = new Float32Array(S * 4);
    this.outSideTarget = new Int32Array(S * 4);
    this.outSideTarget.fill(K_DEAD_TARGET);
    const ol0 = Math.max(1024, S);
    this.olFlow = new Float32Array(ol0);
    this.olTarget = new Int32Array(ol0);
    this.olStart = new Int32Array(S);
    this.olLen = new Int32Array(S);

    const ZC = (mapHeight + 2) * C;
    this.heightLimits = new Float32Array(ZC).fill(-F32_MAX);
    this.inflowLimits = new Float32Array(ZC).fill(F32_MAX);
    this.limitedDirections = new Int32Array(S);
    this.clusterSaturation = new Uint8Array(C);
    this.contaminationsBuffer = new Float32Array(S);

    this.maxWaterLevels = Math.min(maxLevels, 3);
    this.waterMulti = new Float32Array(mapX * mapY * this.maxWaterLevels * 4);
  }

  slotAt(cell: number, level: number): number {
    return level * this.verticalStride + cell;
  }
  cellAt(x: number, y: number): number {
    return (y + 1) * this.stride + (x + 1);
  }

  // ═══════════════════════════════════════════════════════════════
  //  [§16] TERRAIN INIT
  //  Free-interval scan: one column per contiguous free interval.
  //  Same result as §16 AddFullObstacle loop, but O(cells×z) without
  //  per-voxel split/merge overhead.
  // ═══════════════════════════════════════════════════════════════

  loadFromVoxels(voxel: Uint8Array, voxelN: number, voxelZ: number): void {
    const N = voxelN, Z = voxelZ;
    for (let y = 0; y < this.mapY; y++) {
      for (let x = 0; x < this.mapX; x++) {
        const cell = this.cellAt(x, y);
        const vi = y * this.mapX + x;
        this.colCount[cell] = 0;

        let inFree = false, freeStart = 0;
        for (let z = 0; z < Z; z++) {
          const solid = voxel[z * N + vi] !== 0;
          if (!solid && !inFree) {
            inFree = true;
            freeStart = z;
          } else if (solid && inFree) {
            this.createColumn(cell, freeStart, z, 0, 0);
            inFree = false;
          }
        }
        if (inFree) this.createColumn(cell, freeStart, this.maxColumnHeight, 0, 0);
        if (this.colCount[cell] === 0) this.createColumn(cell, 0, this.maxColumnHeight, 0, 0);
      }
    }
    this.initBorderRing();
  }

  // ── [§14] Border rings ─────────────────────────────────────────
  private initBorderRing(): void {
    const st = this.stride, H = this.mapY + 2;
    for (let bx = 0; bx < st; bx++) {
      this.initBorderCell(bx);
      this.initBorderCell((H - 1) * st + bx);
    }
    for (let by = 1; by < H - 1; by++) {
      this.initBorderCell(by * st);
      this.initBorderCell(by * st + st - 1);
    }
  }

  private initBorderCell(cell: number): void {
    if (this.colCount[cell] > 0) return;
    const slot = this.slotAt(cell, 0);
    this.colFloor[slot] = 0;
    this.colCeiling[slot] = assertByte(this.maxColumnHeight, 'border');
    this.colWaterDepth[slot] = 0;
    this.colOldWaterDepth[slot] = 0;
    this.colContamination[slot] = 0;
    this.colOverflow[slot] = 0;
    this.colCount[cell] = 1;
  }

  // [v2 §14] Wall ring: sentinel [mapTop, mapTop) = zero capacity
  fullyBlockCell(cell: number): void {
    this.colCount[cell] = 1;
    const slot = this.slotAt(cell, 0);
    this.colFloor[slot] = assertByte(this.maxColumnHeight, 'wall');
    this.colCeiling[slot] = assertByte(this.maxColumnHeight, 'wall');
    this.colWaterDepth[slot] = 0;
    this.colOldWaterDepth[slot] = 0;
    this.colContamination[slot] = 0;
    this.colOverflow[slot] = 0;
    this.resetOutflowRecord(slot);
  }

  unblockCell(cell: number): void {
    this.colCount[cell] = 1;
    const slot = this.slotAt(cell, 0);
    this.colFloor[slot] = 0;
    this.colCeiling[slot] = assertByte(this.maxColumnHeight, 'unblock');
    this.colWaterDepth[slot] = 0;
    this.colOldWaterDepth[slot] = 0;
    this.colContamination[slot] = 0;
    this.colOverflow[slot] = 0;
    this.resetOutflowRecord(slot);
  }

  private createColumn(cell: number, floor: number, ceiling: number,
                        depth: number, cont: number): void {
    const vs = this.verticalStride;
    const k = this.colCount[cell];
    if (k >= this.maxLevels) throw new Error('R8: stack overflow');
    const slot = cell + k * vs;
    this.colFloor[slot] = assertByte(floor, 'create floor');
    this.colCeiling[slot] = assertByte(ceiling, 'create ceiling');
    this.colWaterDepth[slot] = F32(depth);
    this.colOldWaterDepth[slot] = 0;
    this.colContamination[slot] = F32(cont);
    this.colOverflow[slot] = 0;
    this.resetOutflowRecord(slot);
    this.colCount[cell] = k + 1;
  }

  updateTerrainRegion(voxel: Uint8Array, voxelN: number, voxelZ: number,
                      minX: number, maxX: number, minY: number, maxY: number): void {
    const N = voxelN, Z = voxelZ;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const cell = this.cellAt(x, y);
        const vi = y * this.mapX + x;
        const newCols: Array<{ floor: number; ceiling: number }> = [];
        let inFree = false, freeStart = 0;

        for (let z = 0; z < Z; z++) {
          const solid = voxel[z * N + vi] !== 0;
          if (!solid && !inFree) { inFree = true; freeStart = z; }
          else if (solid && inFree) {
            newCols.push({ floor: freeStart, ceiling: z }); inFree = false;
          }
        }
        if (inFree) newCols.push({ floor: freeStart, ceiling: this.maxColumnHeight });

        const vs = this.verticalStride;
        const saved = new Map<number, { d: number; c: number; o: number; od: number }>();
        for (let k = 0; k < this.colCount[cell]; k++) {
          const slot = cell + k * vs;
          saved.set(this.colFloor[slot], {
            d: this.colWaterDepth[slot], c: this.colContamination[slot],
            o: this.colOverflow[slot], od: this.colOldWaterDepth[slot]
          });
        }

        this.colCount[cell] = 0;
        for (const nc of newCols) {
          const s = saved.get(nc.floor);
          this.createColumn(cell, nc.floor, nc.ceiling, s ? s.d : 0, s ? s.c : 0);
          if (s) {
            const slot = cell + (this.colCount[cell] - 1) * vs;
            this.colOverflow[slot] = s.o;
            this.colOldWaterDepth[slot] = s.od;
          }
        }
        if (this.colCount[cell] === 0) {
          this.createColumn(cell, 0, this.maxColumnHeight, 0, 0);
        }
      }
    }
  }

  // ── pool helpers ─────────────────────────────────────────────────
  private dfEnsure(extra: number): void {
    if (this.dfCursor + extra <= this.dfFlow.length) return;
    let n = this.dfFlow.length * 2;
    while (n < this.dfCursor + extra) n *= 2;
    const gf = new Float32Array(n); gf.set(this.dfFlow.subarray(0, this.dfCursor));
    const gt = new Int32Array(n); gt.set(this.dfTarget.subarray(0, this.dfCursor));
    const go = new Int32Array(n); go.set(this.dfOrigin.subarray(0, this.dfCursor));
    this.dfFlow = gf; this.dfTarget = gt; this.dfOrigin = go;
  }
  private tdEnsure(extra: number): void {
    if (this.tdCursor + extra <= this.tdTarget.length) return;
    let n = this.tdTarget.length * 2;
    while (n < this.tdCursor + extra) n *= 2;
    const gt = new Int32Array(n); gt.set(this.tdTarget.subarray(0, this.tdCursor));
    const go = new Int32Array(n); go.set(this.tdOrigin.subarray(0, this.tdCursor));
    this.tdTarget = gt; this.tdOrigin = go;
  }
  addDirectedFlow(cell: number, flow: number, tgt: number, orig: number): void {
    this.dfEnsure(1);
    const i = this.dfCursor++;
    this.dfFlow[i] = flow; this.dfTarget[i] = tgt; this.dfOrigin[i] = orig;
    this.dfLen[cell]++;
    if (this.dfLen[cell] === 1) this.dfStart[cell] = i;
  }
  addTargetedDiffusion(cell: number, tgt: number, orig: number): void {
    this.tdEnsure(1);
    const i = this.tdCursor++;
    this.tdTarget[i] = tgt; this.tdOrigin[i] = orig;
    this.tdLen[cell]++;
    if (this.tdLen[cell] === 1) this.tdStart[cell] = i;
  }
  sumDirected(cell: number, orig: number, tgt: number): number {
    const s = this.dfStart[cell], n = this.dfLen[cell];
    let acc = 0;
    for (let k = 0; k < n; k++) {
      const i = s + k;
      if (this.dfOrigin[i] === orig && this.dfTarget[i] === tgt) acc = fadd(acc, this.dfFlow[i]);
    }
    return acc;
  }

  resetOutflowRecord(slot: number): void {
    const b = slot * 4;
    for (let s = 0; s < 4; s++) {
      this.outSideFlow[b + s] = 0;
      this.outSideTarget[b + s] = K_DEAD_TARGET;
    }
    this.olLen[slot] = 0;
  }
  publishSideFlow(slot: number, side: number, flow: number, tgt: number): void {
    const b = slot * 4 + side;
    if (this.outSideTarget[b] === K_DEAD_TARGET) {
      this.outSideTarget[b] = tgt;
      this.outSideFlow[b] = flow;
    } else if (this.outSideTarget[b] === tgt) {
      this.outSideFlow[b] = fadd(this.outSideFlow[b], flow);
    } else {
      this.publishListFlow(slot, flow, tgt);
    }
  }
  publishListFlow(slot: number, flow: number, tgt: number): void {
    if (this.olCursor + 1 > this.olFlow.length) {
      const n = this.olFlow.length * 2;
      const gf = new Float32Array(n); gf.set(this.olFlow.subarray(0, this.olCursor));
      const gi = new Int32Array(n); gi.set(this.olTarget.subarray(0, this.olCursor));
      this.olFlow = gf; this.olTarget = gi;
    }
    const i = this.olCursor++;
    this.olFlow[i] = flow; this.olTarget[i] = tgt;
    this.olLen[slot]++;
    if (this.olLen[slot] === 1) this.olStart[slot] = i;
  }
  readPrevFlow(originSlot: number, targetSlot: number): number {
    const b = originSlot * 4;
    for (let side = 0; side < 4; side++)
      if (this.outSideTarget[b + side] === targetSlot) return this.outSideFlow[b + side];
    const s = this.olStart[originSlot], n = this.olLen[originSlot];
    for (let k = 0; k < n; k++)
      if (this.olTarget[s + k] === targetSlot) return this.olFlow[s + k];
    return 0;
  }
  baseFlowToward(cell: number, delta: number): number {
    const b = cell * 4, st = this.stride;
    if (delta === st) return this.baseLevelFlows[b + OFF_TOP];
    if (delta === 1) return this.baseLevelFlows[b + OFF_RIGHT];
    if (delta === -st) return this.baseLevelFlows[b + OFF_BOTTOM];
    if (delta === -1) return this.baseLevelFlows[b + OFF_LEFT];
    throw new Error('bad offset');
  }

  // ═══════════════════════════════════════════════════════════════
  //  [§4] TICK FRAME
  // ═══════════════════════════════════════════════════════════════
  tickFrame(): void {
    if (!(this.tickIntervalSeconds > 0)) throw new Error('set tickIntervalSeconds');
    this.applyQueuedModifications();
    const dt = fdiv(F32(this.tickIntervalSeconds), F32(K_SUBSTEPCOUNT));
    for (let s = 0; s < K_SUBSTEPCOUNT; s++) {
      const tc = performance.now();
      this.clearBuffers();
      const t1 = performance.now();
      this.outflowsUpdate(dt);
      const t2 = performance.now();
      this.waterParametersUpdate(dt);
      const t3 = performance.now();
      if (this.hasContamination) {
        this.simulateContamination(dt);
        this.updateContamination(dt);
      }
      this.updateWaterSources(dt);
      const t4 = performance.now();
      if (this.onSubstep) this.onSubstep(s, this);
      this.profile.clear += t1 - tc;
      this.profile.outflows += t2 - t1;
      this.profile.depth += t3 - t2;
      this.profile.sources += t4 - t3;
    }
    const t5 = performance.now();
    this.updateWaterChanges();
    this.profile.changes += performance.now() - t5;
  }

  private clearBuffers(): void {
    this.contaminationsBuffer.fill(0);
    this.targetedDiffusionCount.fill(0);
    this.baseLevelFlows.fill(0);
    this.baseLevelDiffusions.fill(0);
    this.dfLen.fill(0); this.dfCursor = 0;
    this.tdLen.fill(0); this.tdCursor = 0;
  }

  // ═══════════════════════════════════════════════════════════════
  //  [§5] FLOW PASS
  // ═══════════════════════════════════════════════════════════════
  private outflowsUpdate(dt: number): void {
    const stride = this.stride, vs = this.verticalStride;
    for (let y = 0; y < this.mapY; y++) {
      const rowBase = (y + 1) * stride + 1;
      for (let x = 0; x < this.mapX; x++) {
        const cell = rowBase + x;
        const levels = this.colCount[cell];
        for (let level = 0; level < levels; level++) {
          this.updateColumnOutflows(cell, level * vs + cell, dt);
        }
      }
    }
  }

  private updateColumnOutflows(index: number, index3D: number, dt: number): void {
    const available = fadd(this.colWaterDepth[index3D], this.colOverflow[index3D]);
    if (available === 0) return;
    let sum = 0;
    const dfBefore = this.dfCursor;
    sum = fadd(sum, this.outflowDir(index, index3D, -this.stride, OFF_BOTTOM));
    sum = fadd(sum, this.outflowDir(index, index3D, -1, OFF_LEFT));
    sum = fadd(sum, this.outflowDir(index, index3D, this.stride, OFF_TOP));
    sum = fadd(sum, this.outflowDir(index, index3D, 1, OFF_RIGHT));
    if (sum === 0) return;
    const scale = fdiv(available, fmul(sum, dt));
    if (uge(scale, 1.0)) return;
    if (index === index3D) {
      const b = index * 4;
      for (let s = 0; s < 4; s++) this.baseLevelFlows[b + s] = fmul(this.baseLevelFlows[b + s], scale);
    }
    for (let i = dfBefore; i < this.dfCursor; i++) this.dfFlow[i] = fmul(this.dfFlow[i], scale);
  }

  private outflowDir(index: number, index3D: number, offset: number, side: number): number {
    const cell = index + offset, vs = this.verticalStride, cc = this.cellCount;
    const oFloor = this.colFloor[index3D];
    const surf = fadd(F32(oFloor), this.colWaterDepth[index3D]);
    let sum = 0;
    for (let k = 0; k < this.colCount[cell]; k++) {
      const tSlot = cell + k * vs;
      if (this.colCeiling[tSlot] <= oFloor) continue;
      if (F32(this.colFloor[tSlot]) >= surf) break;
      let f = this.getOutflow(index3D, tSlot, offset);
      if (!(f > 0)) continue;
      const infIdx = this.colFloor[tSlot] * cc + cell;
      if (infIdx < this.inflowLimits.length) {
        const lim = this.inflowLimits[infIdx];
        if (f > lim) f = lim;
      }
      if (index === index3D && k === 0) this.baseLevelFlows[index * 4 + side] = f;
      else this.addDirectedFlow(index, f, tSlot, index3D);
      sum = fadd(sum, f);
    }
    return sum;
  }

  private getOutflow(originSlot: number, targetSlot: number, offset: number): number {
    const dir = offset;
    const of = this.colFloor[originSlot], tf = this.colFloor[targetSlot];
    const tLim = this.limitedDirections[targetSlot];
    if (!(tLim === 0 || tLim === dir)) return 0;
    const oLim = this.limitedDirections[originSlot];
    if (!(oLim === 0 || oLim === dir || oLim === -dir)) return 0;

    const F = F32(K_OVERFLOWPRESSUREFACTOR);
    const oWd = this.colWaterDepth[originSlot], oOvf = this.colOverflow[originSlot];
    const tWd = this.colWaterDepth[targetSlot], tOvf = this.colOverflow[targetSlot];
    const osurf = fadd(F32(of), oWd);
    const oceil = Math.ceil(osurf) | 0;
    const oovf = fmul(oOvf, F);
    const tsurf = fadd(F32(tf), tWd);
    const tovf = fmul(tOvf, F);
    const diff = fsub(fadd(osurf, oovf), fadd(tsurf, tovf));

    let drive: number;
    if (diff > 0) {
      const headroom = fsub(F32(this.colCeiling[targetSlot]), tsurf);
      const E = fmax(fmin(diff, oovf), fsub(diff, headroom));
      drive = fadd(fsub(diff, E), fdiv(E, F));
    } else {
      const headroom = fsub(F32(this.colCeiling[originSlot]), osurf);
      const over = fneg(diff);
      const E = fmax(fmin(over, tovf), fsub(over, headroom));
      drive = fsub(fadd(diff, E), fdiv(E, F));
    }

    let prev = fmul(this.readPrevFlow(originSlot, targetSlot), F32(K_FLOWRETENTION));
    const limit = this.getHeightLimit(targetSlot, Math.max(of, tf), oceil);

    if (limit >= 0) {
      prev = fmul(prev, F32(K_HARDDAMRETENTION));
      const excess = fsub(fadd(osurf, oovf), F32(tf));
      if (uge(excess, limit)) {
        const above = fsub(excess, limit);
        if (above < K_SOFTDAMOFFSET && drive > 0)
          drive = fmul(drive, fdiv(above, F32(K_SOFTDAMOFFSET)));
      } else {
        const closeness = fclamp01(fdiv(fsub(limit, excess), F32(K_HARDDAMOFFSET)));
        const rise = fsub(osurf, fadd(F32(of), this.colOldWaterDepth[originSlot]));
        const smoothing = fclamp(
          fsub(1, fmul(rise, F32(K_HARDDAMSMOOTHINGFACTOR))),
          F32(K_MINHARDDAMSMOOTHING), F32(K_MAXHARDDAMSMOOTHING));
        return fsub(prev, fmul(F32(K_MAXHARDDAMDECREASE), fclamp01(fmul(closeness, smoothing))));
      }
    } else {
      if (fadd(tWd, tOvf) === 0 && of === tf)
        drive = fsub(drive, F32(K_WATERSPILLTHRESHOLD));
    }

    return fadd(prev, fmul(F32(K_WATERFLOWFACTOR_EFFECTIVE), drive));
  }

  private getHeightLimit(targetSlot: number, maxFloor: number, oceil: number): number {
    const cell = targetSlot % this.verticalStride, cc = this.cellCount;
    const hl = this.heightLimits, maxIdx = hl.length;
    for (let z = maxFloor; z < oceil; z++) {
      const idx = z * cc + cell;
      if (idx >= maxIdx) break;
      const v = hl[idx];
      if (v >= 0) return v;
    }
    return -F32_MAX;
  }

  // ═══════════════════════════════════════════════════════════════
  //  [§6] DEPTH PASS
  // ═══════════════════════════════════════════════════════════════
  private waterParametersUpdate(dt: number): void {
    const stride = this.stride, vs = this.verticalStride;
    const offsets = [-stride, -1, stride, 1];
    const dfLen = this.dfLen; // [perf] alias for hot loop

    for (let y = 0; y < this.mapY; y++) {
      const rowBase = (y + 1) * stride + 1;
      for (let x = 0; x < this.mapX; x++) {
        const cell = rowBase + x;
        const levels = this.colCount[cell];
        for (let level = 0; level < levels; level++) {
          const index3D = level * vs + cell;

          let balance = 0;
          this.resetOutflowRecord(index3D);

          // ── base-level flows [§6] ──
          if (cell === index3D) {
            const b = cell * 4;
            for (let side = 0; side < 4; side++) {
              const out = this.baseLevelFlows[b + side];
              const nCell = cell + offsets[side];
              const inFlow = this.baseFlowToward(nCell, -offsets[side]);
              balance = fadd(balance, fsub(inFlow, out));
              if (out > 0) {
                const v = fsub(out, fmul(inFlow, F32(K_OUTFLOWBALANCINGSCALER)));
                if (v > 0) this.publishSideFlow(index3D, side, v, nCell);
              }
            }
          }

          // ── directed flows [§6] ──
          // [perf] only scan if this cell or neighbors have DirectedFlow entries
          if (dfLen[cell] > 0 || dfLen[cell - stride] > 0 || dfLen[cell - 1] > 0 ||
              dfLen[cell + stride] > 0 || dfLen[cell + 1] > 0) {
            for (let dirIdx = 0; dirIdx < 4; dirIdx++) {
              const nCell = cell + offsets[dirIdx];
              // [perf] skip neighbor with no flows from/to this cell
              if (dfLen[cell] === 0 && dfLen[nCell] === 0) continue;
              for (let k = 0; k < this.colCount[nCell]; k++) {
                if (k === 0 && cell === index3D) continue;
                const tgt3D = nCell + k * vs;
                const mine = this.sumDirected(cell, index3D, tgt3D);
                const theirs = this.sumDirected(nCell, tgt3D, index3D);
                balance = fadd(balance, fsub(theirs, mine));
                const v = fsub(mine, fmul(theirs, F32(K_OUTFLOWBALANCINGSCALER)));
                if (v > 0) this.publishSideFlow(index3D, dirIdx, v, tgt3D);
              }
            }
          }

          // ── evaporation + depth update [§6] ──
          const depth = this.colWaterDepth[index3D];
          const ovf = this.colOverflow[index3D];
          if (depth === 0 && ovf === 0 && balance === 0) continue;

          const speed = uge(depth, F32(K_FASTEVAPORATIONDEPTHTHRESHOLD))
            ? F32(K_NORMALEVAPORATIONSPEED) : F32(K_FASTEVAPORATIONSPEED);
          const s = this.clusterSaturation[cell];
          const evapMod = F32(EVAP_MOD_TABLE[s > 9 ? 9 : s]);
          const delta = fmul(fsub(balance, fmul(speed, evapMod)), dt);
          this.setWaterDepth(index3D, delta);
        }
      }
    }
  }

  /** [§7] SetWaterDepth. mapTop = maxColumnHeight. */
  private setWaterDepth(index3D: number, delta: number): void {
    const floor = F32(this.colFloor[index3D]);
    const ceiling = F32(this.colCeiling[index3D]);
    const wd = this.colWaterDepth[index3D];
    const ovf = this.colOverflow[index3D];
    const total = fadd(fadd(wd, ovf), delta);
    const height = fsub(ceiling, floor);
    this.colOldWaterDepth[index3D] = wd;
    if (total < 0) {
      this.colWaterDepth[index3D] = 0;
      this.colOverflow[index3D] = 0;
    } else if (total > height) {
      this.colWaterDepth[index3D] = height;
      const cap = fdiv(fsub(F32(this.maxColumnHeight), ceiling), F32(K_OVERFLOWPRESSUREFACTOR));
      this.colOverflow[index3D] = fmin(fsub(total, height), cap);
    } else {
      this.colWaterDepth[index3D] = total;
      this.colOverflow[index3D] = 0;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  [§8] CONTAMINATION (skipped when hasContamination is false)
  // ═══════════════════════════════════════════════════════════════
  private simulateContamination(dt: number): void {
    const vs = this.verticalStride, stride = this.stride;
    const offsets = [-stride, -1, stride, 1];
    for (let y = 0; y < this.mapY; y++) {
      const rowBase = (y + 1) * stride + 1;
      for (let x = 0; x < this.mapX; x++) {
        const cell = rowBase + x;
        const levels = this.colCount[cell];
        for (let level = 0; level < levels; level++) {
          const index3D = level * vs + cell;
          let inVol = 0, inContMass = 0;
          for (let d = 0; d < 4; d++) {
            const nCell = cell + offsets[d];
            for (let k = 0; k < this.colCount[nCell]; k++) {
              const tgt3D = nCell + k * vs;
              const net = fsub(this.readPrevFlow(tgt3D, index3D), this.readPrevFlow(index3D, tgt3D));
              if (net === 0) continue;
              const vol = fmul(net, dt);
              if (vol > 0) {
                inVol = fadd(inVol, vol);
                inContMass = fadd(inContMass, fmul(vol, this.colContamination[tgt3D]));
              }
              if (this.canDiffuse(index3D, tgt3D, net, cell, nCell)) {
                if (cell === index3D && k === 0) this.baseLevelDiffusions[cell * 4 + d] = 1;
                else this.addTargetedDiffusion(cell, tgt3D, index3D);
                this.targetedDiffusionCount[index3D]++;
              }
            }
          }
          const eff = fadd(this.colWaterDepth[index3D],
            fmul(this.colOverflow[index3D], F32(K_OVERFLOWPRESSUREFACTOR)));
          if (inVol > 0) {
            const cont = this.colContamination[index3D];
            const r = fadd(cont, fdiv(fsub(inContMass, fmul(cont, inVol)), eff));
            this.contaminationsBuffer[index3D] = (r < 0) ? 0 : fmin(r, F32(K_MAXWATERCONTAMINATION));
          } else {
            this.contaminationsBuffer[index3D] = this.colContamination[index3D];
          }
        }
      }
    }
  }

  private canDiffuse(src3D: number, tgt3D: number, net: number,
                     srcCell: number, tgtCell: number): boolean {
    if (!(Math.abs(net) < K_DIFFUSIONOUTFLOWLIMIT)) return false;
    const srcDepth = this.colWaterDepth[src3D], tgtDepth = this.colWaterDepth[tgt3D];
    const maxFloor = Math.max(this.colFloor[src3D], this.colFloor[tgt3D]);
    const hlIdx = maxFloor * this.cellCount + tgtCell;
    const hasHL = hlIdx < this.heightLimits.length && this.heightLimits[hlIdx] >= 0;
    if (!((srcDepth > 1 && tgtDepth > 1) || !hasHL)) return false;
    const dir = tgtCell - srcCell;
    if (!(this.limitedDirections[tgt3D] === 0 || this.limitedDirections[tgt3D] === dir)) return false;
    if (!(this.limitedDirections[src3D] === 0 || this.limitedDirections[src3D] === -dir)) return false;
    const F = F32(K_OVERFLOWPRESSUREFACTOR);
    const srcSurf = fadd(fadd(F32(this.colFloor[src3D]), srcDepth), fmul(this.colOverflow[src3D], F));
    const tgtSurf = fadd(fadd(F32(this.colFloor[tgt3D]), tgtDepth), fmul(this.colOverflow[tgt3D], F));
    return Math.abs(fsub(srcSurf, tgtSurf)) <= K_DIFFUSIONDEPTHLIMIT;
  }

  private calculateDiffusion(srcCont: number, srcDepth: number, tgt3D: number, frac: number): number {
    const tgtCont = this.contaminationsBuffer[tgt3D];
    const tgtDepth = this.colWaterDepth[tgt3D];
    const delta = fsub(tgtCont, srcCont);
    const amt = delta > 0 ? fmin(delta, fmul(frac, tgtCont)) : fmax(delta, fneg(fmul(frac, srcCont)));
    return fmul(fdiv(tgtDepth, fadd(srcDepth, tgtDepth)), fmul(amt, F32(K_DIFFUSIONRATE)));
  }

  private updateContamination(dt: number): void {
    const vs = this.verticalStride, stride = this.stride;
    const offsets = [-stride, -1, stride, 1];
    for (let y = 0; y < this.mapY; y++) {
      const rowBase = (y + 1) * stride + 1;
      for (let x = 0; x < this.mapX; x++) {
        const cell = rowBase + x;
        const levels = this.colCount[cell];
        for (let level = 0; level < levels; level++) {
          const index3D = level * vs + cell;
          const depth = this.colWaterDepth[index3D];
          if (!(depth > 0)) { this.colContamination[index3D] = 0; continue; }
          let sum = 0;
          const frac = fdiv(1, F32(Math.max(1, this.targetedDiffusionCount[index3D])));
          if (cell === index3D) {
            for (let side = 0; side < 4; side++) {
              if (this.baseLevelDiffusions[cell * 4 + side]) {
                sum = fadd(sum, this.calculateDiffusion(this.colContamination[index3D], depth, cell + offsets[side], frac));
              }
            }
          }
          const tdS = this.tdStart[cell], tdN = this.tdLen[cell];
          for (let k = 0; k < tdN; k++) {
            const i = tdS + k;
            if (this.tdOrigin[i] === index3D)
              sum = fadd(sum, this.calculateDiffusion(this.colContamination[index3D], depth, this.tdTarget[i], frac));
          }
          const r = fadd(this.contaminationsBuffer[index3D], fmul(sum, dt));
          this.colContamination[index3D] = fmin(r, F32(K_MAXWATERCONTAMINATION));
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  [§9] SOURCES
  // ═══════════════════════════════════════════════════════════════
  getColumnSlot(cell: number, z: number): number {
    const vs = this.verticalStride;
    for (let k = 0; k < this.colCount[cell]; k++) {
      const slot = cell + k * vs;
      if (this.colFloor[slot] <= z && z < this.colCeiling[slot]) return slot;
    }
    return -1;
  }

  private updateWaterSources(dt: number): void {
    const F = F32(K_OVERFLOWPRESSUREFACTOR);
    for (let s = 0; s < this.waterSources.length; s++) {
      const src = this.waterSources[s];
      const count = src.coords.length;
      if (count === 0) continue;
      const per = fdiv(fmul(dt, F32(src.currentStrength)), F32(count));
      for (let c = 0; c < count; c++) {
        const coord = src.coords[c];
        const cell = this.cellAt(coord.x, coord.y);
        const col = this.getColumnSlot(cell, coord.z);
        if (col < 0) continue;
        const effOld = fadd(this.colWaterDepth[col], fmul(this.colOverflow[col], F));
        this.setWaterDepth(col, per);
        const effNew = fadd(this.colWaterDepth[col], fmul(this.colOverflow[col], F));
        if (effNew === 0) { this.colContamination[col] = 0; continue; }
        const r = fdiv(
          fadd(fmul(this.colContamination[col], effOld),
               fmul(F32(src.contamination), fsub(effNew, effOld))),
          effNew);
        this.colContamination[col] = (r >= 0) ? fmin(r, F32(K_MAXWATERCONTAMINATION)) : 0;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  [§10] WATER CHANGES
  // ═══════════════════════════════════════════════════════════════
  private updateWaterChanges(): void {
    this.removedWater.clear();
    const F = F32(K_OVERFLOWPRESSUREFACTOR);
    for (let i = 0; i < this.waterChanges.length; i++) {
      const wc = this.waterChanges[i];
      const cell = this.cellAt(wc.x, wc.y);
      const col = this.getColumnSlot(cell, wc.z);
      if (col < 0) continue;
      const effOld = fadd(this.colWaterDepth[col], fmul(this.colOverflow[col], F));
      const c = this.colContamination[col];
      const volOld = fadd(this.colWaterDepth[col], this.colOverflow[col]);
      const dc = F32(wc.depthChange), dcc = F32(wc.contaminationChange);
      const clean = fmax(0, fadd(fmul(effOld, fsub(1, c)), fmul(dc, fsub(1, dcc))));
      const cont = fmax(0, fadd(fmul(effOld, c), fmul(dc, dcc)));
      this.setWaterDepth(col, fsub(fadd(clean, cont), effOld));
      const newTotal = fadd(clean, cont);
      this.colContamination[col] = (newTotal === 0) ? 0 : fmin(fdiv(cont, newTotal), F32(K_MAXWATERCONTAMINATION));
      if (wc.depthChange < 0) {
        const after = fadd(this.colWaterDepth[col], this.colOverflow[col]);
        const cN = this.colContamination[col];
        const key = wc.y * this.mapX + wc.x;
        const entry = this.removedWater.get(key) || { clean: 0, contaminated: 0 };
        entry.clean = fadd(entry.clean, fsub(fmul(volOld, fsub(1, c)), fmul(after, fsub(1, cN))));
        entry.contaminated = fadd(entry.contaminated, fsub(fmul(volOld, c), fmul(after, cN)));
        this.removedWater.set(key, entry);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  [§11][§12][§13] TOPOLOGY + LIMITS
  // ═══════════════════════════════════════════════════════════════
  private applyQueuedModifications(): void {
    while (this.modQueue.length > 0) {
      const mod = this.modQueue.shift()!;
      const cell = this.cellAt(mod.x, mod.y);
      switch (mod.kind) {
        case 'obstacle':
          if (mod.added) this.addObstacle(cell, mod.z, mod.obstacleType!);
          else this.removeObstacle(cell, mod.z, mod.obstacleType!);
          break;
        case 'inflowLimit': {
          const idx = mod.z * this.cellCount + cell;
          this.inflowLimits[idx] = mod.added ? F32(mod.value!) : F32_MAX;
          break;
        }
        case 'heightLimit': {
          const idx = mod.z * this.cellCount + cell;
          this.heightLimits[idx] = mod.added ? F32(mod.value!) : -F32_MAX;
          break;
        }
        case 'directionLimit': {
          const vs = this.verticalStride;
          for (let k = 0; k < this.colCount[cell]; k++)
            this.limitedDirections[cell + k * vs] = mod.added ? (mod.value! | 0) : 0;
          break;
        }
      }
    }
  }

  private addObstacle(cell: number, z: number, type: 0 | 1 | 2): void {
    if (type !== 0) return;
    const col = this.getColumnSlot(cell, z);
    if (col < 0) return;
    const floor = this.colFloor[col], ceiling = this.colCeiling[col];
    if (floor === z) {
      if (ceiling - 1 === z) this.removeColumn(cell, col);
      else {
        this.colFloor[col] = (z + 1) | 0;
        this.colWaterDepth[col] = fmax(0, fsub(this.colWaterDepth[col], 1));
      }
    } else if (ceiling - 1 === z) {
      this.colCeiling[col] = z | 0;
    } else {
      this.splitColumn(cell, col, z);
    }
  }

  private removeObstacle(cell: number, z: number, type: 0 | 1 | 2): void {
    if (type !== 0) return;
    const vs = this.verticalStride;
    let belowSlot = -1, aboveSlot = -1;
    for (let k = 0; k < this.colCount[cell]; k++) {
      const slot = cell + k * vs;
      if (this.colCeiling[slot] === z) belowSlot = slot;
      if (this.colFloor[slot] === z + 1) aboveSlot = slot;
    }
    if (belowSlot >= 0 && aboveSlot >= 0) this.mergeColumns(cell, belowSlot, aboveSlot);
    else if (belowSlot >= 0) this.colCeiling[belowSlot] = assertByte(z + 1, 'restore');
    else if (aboveSlot >= 0) this.colFloor[aboveSlot] = assertByte(z, 'restore');
    else this.insertColumn(cell, z, z + 1, 0, 0);
  }

  insertColumn(cell: number, floor: number, ceiling: number, depth: number, cont: number): void {
    const vs = this.verticalStride;
    const count = this.colCount[cell];
    if (count >= this.maxLevels) throw new Error('R8: stack overflow');
    let insertLevel = count;
    for (let k = 0; k < count; k++) {
      if (this.colFloor[cell + k * vs] > floor) { insertLevel = k; break; }
    }
    for (let k = count - 1; k >= insertLevel; k--) {
      const o = cell + k * vs, n = cell + (k + 1) * vs;
      this.colFloor[n] = this.colFloor[o]; this.colCeiling[n] = this.colCeiling[o];
      this.colWaterDepth[n] = this.colWaterDepth[o]; this.colOldWaterDepth[n] = this.colOldWaterDepth[o];
      this.colContamination[n] = this.colContamination[o]; this.colOverflow[n] = this.colOverflow[o];
      this.retargetSlotRefs(cell, o, n);
    }
    const slot = cell + insertLevel * vs;
    this.colFloor[slot] = assertByte(floor, 'ins floor');
    this.colCeiling[slot] = assertByte(ceiling, 'ins ceil');
    this.colWaterDepth[slot] = F32(depth);
    this.colOldWaterDepth[slot] = 0;
    this.colContamination[slot] = F32(cont);
    this.colOverflow[slot] = 0;
    this.resetOutflowRecord(slot);
    this.colCount[cell] = count + 1;
  }

  removeColumn(cell: number, slot: number): void {
    const vs = this.verticalStride;
    const level = (((slot - cell) / vs) | 0);
    const count = this.colCount[cell];
    this.retargetSlotRefs(cell, slot, K_DEAD_TARGET);
    for (let k = level; k < count - 1; k++) {
      const o = cell + (k + 1) * vs, n = cell + k * vs;
      this.colFloor[n] = this.colFloor[o]; this.colCeiling[n] = this.colCeiling[o];
      this.colWaterDepth[n] = this.colWaterDepth[o]; this.colOldWaterDepth[n] = this.colOldWaterDepth[o];
      this.colContamination[n] = this.colContamination[o]; this.colOverflow[n] = this.colOverflow[o];
      this.retargetSlotRefs(cell, o, n);
    }
    const tail = cell + (count - 1) * vs;
    this.colFloor[tail] = 0; this.colCeiling[tail] = 0;
    this.colWaterDepth[tail] = 0; this.colOldWaterDepth[tail] = 0;
    this.colContamination[tail] = 0; this.colOverflow[tail] = 0;
    this.resetOutflowRecord(tail);
    this.colCount[cell] = count - 1;
  }

  /** [§11] Split at z. Block [z, z+1). Upper [z+1, oldCeiling). */
  private splitColumn(cell: number, slot: number, z: number): void {
    const floor = this.colFloor[slot], ceiling = this.colCeiling[slot];
    const depth = this.colWaterDepth[slot], cont = this.colContamination[slot];
    const surface = floor + depth;
    this.colCeiling[slot] = assertByte(z, 'split');
    let upperDepth = 0, upperCont = 0;
    if (surface > z + 1) {
      upperDepth = surface - (z + 1);
      upperCont = cont;
      this.colWaterDepth[slot] = z - floor;
    }
    this.insertColumn(cell, z + 1, ceiling, upperDepth, upperCont);
  }

  private mergeColumns(cell: number, lo: number, hi: number): void {
    const d1 = this.colWaterDepth[lo], d2 = this.colWaterDepth[hi];
    const c1 = this.colContamination[lo], c2 = this.colContamination[hi];
    this.colCeiling[lo] = this.colCeiling[hi];
    this.colWaterDepth[lo] = fadd(d1, d2);
    const total = fadd(d1, d2);
    if (total > 0) this.colContamination[lo] = fdiv(fadd(fmul(d1, c1), fmul(d2, c2)), total);
    this.removeColumn(cell, hi);
  }

  private retargetSlotRefs(cell: number, oldSlot: number, newSlot: number): void {
    const stride = this.stride, vs = this.verticalStride;
    const offsets = [-stride, -1, stride, 1];
    for (let d = 0; d < 4; d++) {
      const nCell = cell + offsets[d];
      for (let k = 0; k < this.colCount[nCell]; k++) {
        const nSlot = nCell + k * vs;
        const b = nSlot * 4;
        for (let s = 0; s < 4; s++)
          if (this.outSideTarget[b + s] === oldSlot) this.outSideTarget[b + s] = newSlot;
        const olS = this.olStart[nSlot], olN = this.olLen[nSlot];
        for (let i = olS; i < olS + olN; i++)
          if (this.olTarget[i] === oldSlot) this.olTarget[i] = newSlot;
      }
    }
  }

  queueModification(mod: WaterModification): void { this.modQueue.push(mod); }

  syncCompatMirrors(water: Float32Array): void {
    const maxWL = this.maxWaterLevels;
    for (let y = 0; y < this.mapY; y++) {
      for (let x = 0; x < this.mapX; x++) {
        const cell = this.cellAt(x, y);
        const n = this.colCount[cell];
        const i = y * this.mapX + x;
        if (n === 0) {
          water[i] = 0;
          for (let l = 0; l < maxWL; l++) {
            const off = (i * maxWL + l) * 4;
            this.waterMulti[off] = 0; this.waterMulti[off + 1] = 0;
            this.waterMulti[off + 2] = 0; this.waterMulti[off + 3] = 0;
          }
          continue;
        }
        const topSlot = this.slotAt(cell, n - 1);
        water[i] = fadd(this.colWaterDepth[topSlot], this.colOverflow[topSlot]);
        for (let l = 0; l < maxWL; l++) {
          const off = (i * maxWL + l) * 4;
          if (l < n) {
            const s2 = this.slotAt(cell, l);
            this.waterMulti[off]     = this.colFloor[s2];
            this.waterMulti[off + 1] = this.colContamination[s2];
            this.waterMulti[off + 2] = fadd(this.colWaterDepth[s2], this.colOverflow[s2]);
            this.waterMulti[off + 3] = 1.0;
          } else {
            this.waterMulti[off] = 0; this.waterMulti[off + 1] = 0;
            this.waterMulti[off + 2] = 0; this.waterMulti[off + 3] = 0;
          }
        }
      }
    }
  }
}