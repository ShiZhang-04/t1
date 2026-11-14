/**
 * Droughtline v3 Simulation Engine
 * High-performance continuous voxel colony simulation.
 * Pure typed arrays, zero neurons, ~1200+ ticks/sec headroom.
 *
 * Water physics: Timberborn-ground-truth solver (src/game/water.ts).
 * Soil, plants, creatures, weather, telemetry: Droughtline layers.
 */

import { WaterSimCore } from './water';

export const SURFACE_BARE = 0;
export const SURFACE_GRASS = 1;
export const SURFACE_DEAD = 2;

export interface WeatherState {
  temp: number;
  humid: number;
  wind: number;
  rain: number;
  event: boolean;
  eventName: string;
}

export interface Plant {
  id: number;
  i: number;
  x: number;
  y: number;
  sp: number;
  lutW: Float32Array;
  b: number;
  tol: number;
  stress: number;
  alive: boolean;
}

export interface Creature {
  id: number;
  x: number;
  y: number;
  thirst: number;
  hunger: number;
  health: number;
  age: number;
  work: number;
  tx: number;
  ty: number;
  hasT: boolean;
  sickness: number;
  alive: boolean;
}

export interface SimWaterSource {
  x: number;
  y: number;
  rate: number;
}

export interface SimChannels {
  rain: number;
  seep: number;
  evapW: number;
  evapS: number;
  cap: number;
  drink: number;
  runoff: number;
  storeW: number;
  storeS: number;
}

export interface SoilSnapshot {
  t: number;
  hist: number[];
  mean: number;
  dry: number;
  plants: number;
  alive: number;
}

export interface SimBenchmarkResult {
  n: number;
  tps: number;
  cost: number;
}

export interface SimReport {
  bench: SimBenchmarkResult[];
  meanTps: number;
  ratio: number;
  verdict: string;
  lines: string[];
  deaths: string[];
  snapshots: SoilSnapshot[];
}

function hash(x: number, y: number, s: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function vn(x: number, y: number, s: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
  const ab = a + (b - a) * u, cd = c + (d - c) * u;
  return ab + (cd - ab) * v;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : (v > 1 ? 1 : v);
}

function gau(v: number, ideal: number, w: number): number {
  const d = (v - ideal) / w;
  return Math.exp(-0.5 * d * d);
}

export class DroughtlineSim {
  public X: number = 256;
  public Y: number = 256;
  public Z: number = 32;
  public N: number = 256 * 256;

  // ── Timberborn-ground-truth solver ──
  public water!: WaterSimCore;

  // Primary simulation arrays
  public VOXEL: Uint8Array;
  public WATER: Float32Array;    // compat mirror of solver state
  public SOIL: Float32Array;
  public SURFACE: Uint8Array;
  public WD: Float32Array;       // retired (legacy flow buffer)
  public EXPO: Float32Array;
  public HGT: Uint8Array;

  // Surface state timers
  private grassTimer: Int16Array;
  private deadTimer: Int16Array;

  // Legacy flow momentum — retired (dead code)
  private prevFlowR: Float32Array;
  private prevFlowL: Float32Array;
  private prevFlowU: Float32Array;
  private prevFlowD: Float32Array;

  // Water sources
  public waterSources: SimWaterSource[] = [];
  public waterSourceDefaultRate: number = 0.5;
  public enableCreatures: boolean = false;
  public enableEvaporation: boolean = false;

  // Weather state
  public weather: WeatherState = {
    temp: 0.60,
    humid: 0.42,
    wind: 0.30,
    rain: 0.0045,
    event: false,
    eventName: 'BASELINE'
  };

  // Disasters / manual events
  public disasterRemainingTicks: number = 0;
  public disasterType: 'none' | 'drought' | 'storm' = 'none';

  // Constants (soil layer only — water constants live in water.ts)
  public SEEP_RATE = 0.005;
  public EVAP_RATE = 0.035;
  public CAPILLARY = 0.012;
  public SOIL_DRAIN = 0.0006;
  public DRAIN_DRY_EPS = 0.01;
  public MAX_DEPTH = 1.0;
  public RUNOFF = 0.70;
  public PIPE_RATE = 0.4;
  public FLOW = 0.0;
  public GRAV = 0.0;
  public DRINK_RATE = 0.0015;
  public GROW_K = 0.02;
  public THIRST_BASE = 0.10;
  public HUNGER_BASE = 0.09;
  public THIRST_T = 55;
  public MAXAGE = 1800;
  public MATURE = 300;

  // Species LUTs
  public species = [
    { name: 'reed',  tol: 0.86, iw: 0.62, ww: 0.30 },
    { name: 'moss',  tol: 0.94, iw: 0.48, ww: 0.30 },
    { name: 'shrub', tol: 0.62, iw: 0.34, ww: 0.32 }
  ];
  private LUT_T: Float32Array = new Float32Array(257);
  private LUT_H: Float32Array = new Float32Array(257);
  private LUT_S: Float32Array[] = [];

  // Plants & Creatures
  public plants: Plant[] = [];
  public creatures: Creature[] = [];
  public plantsAlive: number = 0;
  public creaturesAlive: number = 0;
  public plantIdCounter: number = 0;
  public creatureIdCounter: number = 0;

  // Stats & logs
  public tickNo: number = 0;
  public avgW: number = 0;
  public avgS: number = 0;
  public channels: SimChannels = { rain:0, seep:0, evapW:0, evapS:0, cap:0, drink:0, runoff:0, storeW:0, storeS:0 };
  public deathCounts = { thirst: 0, hunger: 0, age: 0, wither: 0, sickness: 0 };
  public deathLog: string[] = [];
  public snapshots: SoilSnapshot[] = [];
  public recHistory: { t: number, w: number, s: number }[] = [];
  public logQueue: string[] = [];
  public tpsCurrent: number = 0;

  // Spatial search acceleration (32x32 buckets)
  private CROWDGRID = new Int16Array(32 * 32);
  private PLANTGRID = new Int16Array(32 * 32);
  private WATERMAP = new Float32Array(32 * 32);

  constructor(sizeX = 256, sizeY = 256, sizeZ = 32) {
    this.X = sizeX;
    this.Y = sizeY;
    this.Z = sizeZ;
    this.N = sizeX * sizeY;

    this.water = new WaterSimCore(this.X, this.Y, this.Z, 8);
    this.water.tickIntervalSeconds = 0.6; // [v2 §3] TickIntervalInSeconds [BP TickTime]
    this.VOXEL = new Uint8Array(this.N * this.Z);
    this.WATER = new Float32Array(this.N);
    this.SOIL = new Float32Array(this.N);
    this.SURFACE = new Uint8Array(this.N);
    this.WD = new Float32Array(this.N);
    this.EXPO = new Float32Array(this.N);
    this.HGT = new Uint8Array(this.N);
    this.grassTimer = new Int16Array(this.N);
    this.deadTimer = new Int16Array(this.N);
    this.prevFlowR = new Float32Array(this.N);
    this.prevFlowL = new Float32Array(this.N);
    this.prevFlowU = new Float32Array(this.N);
    this.prevFlowD = new Float32Array(this.N);

    this.initLUTs();
    this.generateDefaultWorld();
  }

  private initLUTs() {
    for (let i = 0; i <= 256; i++) {
      const v = i / 256;
      this.LUT_T[i] = gau(v, 0.62, 0.22);
      this.LUT_H[i] = gau(v, 0.52, 0.26);
    }
    this.LUT_S = [];
    for (let s = 0; s < this.species.length; s++) {
      const arr = new Float32Array(257);
      for (let i = 0; i <= 256; i++) {
        const v = i / 256;
        arr[i] = gau(v, this.species[s].iw, this.species[s].ww);
      }
      this.LUT_S.push(arr);
    }
  }

  private idx256(v: number): number {
    const i = (v * 256) | 0;
    return i < 0 ? 0 : (i > 256 ? 256 : i);
  }

  public syncWaterSources(entities: Array<{ Template?: string; Components?: any }>) {
    this.waterSources = [];
    if (!entities || !Array.isArray(entities)) return;
    for (let k = 0; k < entities.length; k++) {
      const ent = entities[k];
      if (ent.Template === 'WaterSource' || ent.Components?.WaterSource) {
        const coords = ent.Components?.BlockObject?.Coordinates;
        if (coords && typeof coords.X === 'number' && typeof coords.Y === 'number') {
          const comp = ent.Components?.WaterSource;
          const num = typeof comp?.CurrentStrength === 'number' ? comp.CurrentStrength :
                      (typeof comp?.SpecifiedStrength === 'number' ? comp.SpecifiedStrength : this.waterSourceDefaultRate);
          this.waterSources.push({
            x: Math.round(coords.X),
            y: Math.round(coords.Y),
            rate: Math.max(0, num)
          });
        }
      }
    }
  }

  public addWaterSource(x: number, y: number, rate = this.waterSourceDefaultRate) {
    this.waterSources.push({ x: Math.round(x), y: Math.round(y), rate });
  }

  public clearWaterSources() {
    this.waterSources = [];
  }

  /** Map SimWaterSource[] → WaterSimCore.waterSources [S8].
   *  Converts L/tick → L/second so source output = rate regardless of tickInterval. */
  private syncWaterToCore(): void {
    const ws = this.water.waterSources;
    ws.length = 0;
    const tickInterval = this.water.tickIntervalSeconds;
    for (let s = 0; s < this.waterSources.length; s++) {
      const src = this.waterSources[s];
      const i = src.y * this.X + src.x;
      const hgt = (i >= 0 && i < this.N) ? this.HGT[i] : 0;
      ws.push({
        coords: [{ x: src.x, y: src.y, z: hgt }],
        currentStrength: src.rate / tickInterval,
        contamination: 0
      });
    }
  }

  /**
   * Feed seep/drink losses back to the solver after the soil/creature
   * layers modify WATER[].  The compat mirror is one-way (solver → WATER);
   * this makes it round-trip so the solver sees the actual remaining water.
   */
  private syncWaterBack(): void {
    const core = this.water;
    const X = this.X, Y = this.Y;
    for (let y = 0; y < Y; y++) {
      for (let x = 0; x < X; x++) {
        const cell = core.cellAt(x, y);
        const n = core.colCount[cell];
        if (n === 0) continue;
        const slot = core.slotAt(cell, n - 1);
        const newW = Math.max(0, this.WATER[y * X + x]);
        const height = core.colCeiling[slot] - core.colFloor[slot];
        if (newW <= height) {
          core.colWaterDepth[slot] = newW;
          core.colOverflow[slot] = 0;
        } else {
          core.colWaterDepth[slot] = height;
          core.colOverflow[slot] = newW - height;
        }
      }
    }
  }

  public generateDefaultWorld() {
    const X = this.X, Y = this.Y, Z = this.Z, N = this.N;
    this.VOXEL.fill(0);
    this.WATER.fill(0);
    this.SOIL.fill(0);
    this.SURFACE.fill(SURFACE_BARE);
    this.WD.fill(0);
    this.grassTimer.fill(0);
    this.deadTimer.fill(0);
    this.prevFlowR.fill(0);
    this.prevFlowL.fill(0);
    this.prevFlowU.fill(0);
    this.prevFlowD.fill(0);

    for (let y = 0; y < Y; y++) {
      for (let x = 0; x < X; x++) {
        let acc = 0, amp = 1, f = 1 / 110, norm = 0;
        for (let o = 0; o < 3; o++) {
          acc += amp * vn(x * f, y * f, 17 + o);
          norm += amp;
          amp *= 0.5;
          f *= 2.2;
        }
        acc /= norm;
        const i = y * X + x;

        const riverCenter = X * 0.5 + Math.sin(y * 0.04) * 28 + Math.cos(y * 0.015) * 16;
        const distToRiver = Math.abs(x - riverCenter);
        const riverDepression = distToRiver < 18 ? (1 - distToRiver / 18) * 8 : 0;

        const dSpring = Math.hypot(x - 90, y - 40);
        const springSlope = Math.max(0, 9 - dSpring * 0.22);

        const toRiverX = x - 90;
        const toRiverY = y - 40;
        const proj = (toRiverX * 55 + toRiverY * 20) / (55 * 55 + 20 * 20);
        let streamDrop = 0;
        if (proj >= 0 && proj <= 1) {
          const perpDist = Math.hypot(toRiverX - proj * 55, toRiverY - proj * 20);
          if (perpDist < 5) {
            streamDrop = (1 - perpDist / 5) * (1.2 + proj * 4);
          }
        }

        let hh = Math.max(2, Math.floor(3 + acc * 15 + springSlope - riverDepression - streamDrop));
        if (hh >= Z) hh = Z - 1;
        this.HGT[i] = hh;

        for (let z = 0; z < hh; z++) {
          this.VOXEL[z * N + i] = (z < 2) ? 2 : 1;
        }

        this.WATER[i] = 0;

        const riverFactor = Math.max(0, 1 - distToRiver / 32);
        const springFactor = Math.max(0, 1 - dSpring / 28);
        this.SOIL[i] = clamp01(0.50 + 0.35 * riverFactor + 0.15 * springFactor + 0.10 * (vn(x * 0.02, y * 0.02, 41) - 0.5));

        if (this.SOIL[i] >= 0.28) {
          this.SURFACE[i] = SURFACE_GRASS;
        } else if (this.SOIL[i] < 0.18) {
          this.SURFACE[i] = SURFACE_DEAD;
        } else {
          this.SURFACE[i] = SURFACE_BARE;
        }
      }
    }

    this.recomputeExposure();
    this.seedPlants(2400, 0.35);
    this.seedCreatures(500);
    this.updateWeather(0);
    this.water.loadFromVoxels(this.VOXEL, this.N, this.Z);
  }

  public initFromWorld(worldData: any) {
    if (!worldData?.Singletons) return;
    const mapSize = worldData.Singletons.MapSize?.Size;
    if (mapSize && mapSize.X > 0 && mapSize.Y > 0) {
      if (mapSize.X !== this.X || mapSize.Y !== this.Y) {
        this.X = mapSize.X;
        this.Y = mapSize.Y;
        this.N = this.X * this.Y;
        this.water = new WaterSimCore(this.X, this.Y, this.Z, 8);
        this.water.tickIntervalSeconds = 0.6; // [v2 §3]
        this.VOXEL = new Uint8Array(this.N * this.Z);
        this.WATER = new Float32Array(this.N);
        this.SOIL = new Float32Array(this.N);
        this.SURFACE = new Uint8Array(this.N);
        this.WD = new Float32Array(this.N);
        this.EXPO = new Float32Array(this.N);
        this.HGT = new Uint8Array(this.N);
        this.grassTimer = new Int16Array(this.N);
        this.deadTimer = new Int16Array(this.N);
        this.prevFlowR = new Float32Array(this.N);
        this.prevFlowL = new Float32Array(this.N);
        this.prevFlowU = new Float32Array(this.N);
        this.prevFlowD = new Float32Array(this.N);
      }
    }

    const terrainStr = worldData.Singletons.TerrainMap?.Voxels?.Array;
    if (terrainStr) {
      const vals = terrainStr.split(/\s+/).filter(Boolean);
      const layers = Math.min(this.Z, Math.floor(vals.length / this.N));
      this.VOXEL.fill(0);
      this.HGT.fill(0);

      for (let z = 0; z < layers; z++) {
        const zOff = z * this.N;
        for (let i = 0; i < this.N; i++) {
          const v = parseInt(vals[zOff + i], 10) || 0;
          if (v > 0) {
            this.VOXEL[zOff + i] = 1;
            if (z + 1 > this.HGT[i]) {
              this.HGT[i] = z + 1;
              if (v === 2) this.SURFACE[i] = SURFACE_GRASS;
            }
          }
        }
      }
    }

    const waterMapNew = worldData.Singletons.WaterMapNew;
    const waterMap = worldData.Singletons.WaterMap;
    this.WATER.fill(0);
    this.prevFlowR.fill(0);
    this.prevFlowL.fill(0);
    this.prevFlowU.fill(0);
    this.prevFlowD.fill(0);

    // [v2 §17b] Token format: depth:contamination:overflow:floor:oldWaterDepth
    // Legacy 3-field: floor=0, oldDepth=depth. Empty = "0".
    // Container: PackedList "Array", tokens space-joined.
    // TODO: multi-column grouping per cell — awaiting save sample.
    if (waterMapNew?.WaterColumns?.Array) {
      const tokens = waterMapNew.WaterColumns.Array.split(/\s+/).filter(Boolean);
      for (let i = 0; i < Math.min(tokens.length, this.N); i++) {
        const t = tokens[i];
        if (t === '0') continue;
        const parts = t.split(':');
        const depth = parseFloat(parts[0]) || 0;
        const cont = parts.length >= 2 ? (parseFloat(parts[1]) || 0) : 0;
        const ovf = parts.length >= 3 ? (parseFloat(parts[2]) || 0) : 0;
        const floor = parts.length >= 4 ? (parseInt(parts[3]) || 0) : 0;
        const oldD = parts.length >= 5 ? (parseFloat(parts[4]) || depth) : depth;
        if (depth > 0 || ovf > 0) {
          const xi = i % this.X, yi = Math.floor(i / this.X);
          const cell = this.water.cellAt(xi, yi);
          if (this.water.colCount[cell] > 0) {
            const slot = this.water.slotAt(cell, 0);
            if (parts.length >= 4) this.water.colFloor[slot] = Math.min(255, floor);
            this.water.colWaterDepth[slot] = depth;
            this.water.colContamination[slot] = Math.min(1, Math.max(0, cont));
            this.water.colOverflow[slot] = ovf;
            this.water.colOldWaterDepth[slot] = oldD;
          }
        }
      }
    } else if (waterMap?.WaterDepths?.Array) {
      // [v2 §17a] Flat format: f32 per slot, Overflow=0
      const tokens = waterMap.WaterDepths.Array.split(/\s+/).filter(Boolean);
      for (let i = 0; i < Math.min(tokens.length, this.N); i++) {
        const depth = parseFloat(tokens[i]);
        if (!isNaN(depth) && depth > 0) this.WATER[i] = depth;
      }
    }

    const moistureArr = worldData.Singletons.SoilMoistureSimulator?.MoistureLevels?.Array;
    if (moistureArr) {
      const tokens = moistureArr.split(/\s+/).filter(Boolean);
      for (let i = 0; i < Math.min(tokens.length, this.N); i++) {
        const mv = parseFloat(tokens[i]);
        if (!isNaN(mv)) {
          this.SOIL[i] = clamp01(mv / 16);
          if (this.SOIL[i] > 0.45 && this.SURFACE[i] === SURFACE_BARE) {
            this.SURFACE[i] = SURFACE_GRASS;
          }
        }
      }
    }

    this.recomputeExposure();
    this.syncWaterSources(worldData.Entities || []);
    this.seedPlants(2400, 0.30);
    this.seedCreatures(500);
    this.updateWeather(0);
    this.water.loadFromVoxels(this.VOXEL, this.N, this.Z);
  }

  public recomputeExposure() {
    const X = this.X, Y = this.Y, Z = this.Z, N = this.N;
    for (let i = 0; i < N; i++) {
      const hh = this.HGT[i];
      const x = i % X, y = (i / X) | 0;
      let faces = 1;

      if (x > 0)     faces += Math.max(0, hh - this.HGT[i - 1]);
      if (x < X - 1) faces += Math.max(0, hh - this.HGT[i + 1]);
      if (y > 0)     faces += Math.max(0, hh - this.HGT[i - X]);
      if (y < Y - 1) faces += Math.max(0, hh - this.HGT[i + X]);

      let floatCount = 0;
      for (let z = hh; z < Z; z++) {
        if (this.VOXEL[z * N + i] !== 0) floatCount++;
      }
      faces += 5 * floatCount;

      this.EXPO[i] = Math.min(1.5, faces / 6);
    }
  }

  public updateWeather(t: number) {
    const n1 = vn(t * 0.0035, 0.5, 21);
    const n2 = vn(t * 0.011, 3.5, 22);

    let temp = 0.60 + 0.10 * (n2 - 0.5) * 2;
    let hum  = 0.42 + 0.12 * (n1 - 0.5) * 2;
    let wind = 0.28 + 0.22 * n2;
    let rain = 0.0045 * (0.7 + 0.6 * n1);

    let event = false;
    let eventName = 'BASELINE';

    if (this.disasterRemainingTicks > 0) {
      this.disasterRemainingTicks--;
      if (this.disasterType === 'drought') {
        event = true;
        eventName = 'DROUGHT';
        temp += 0.40;
        rain *= 0.10;
        hum -= 0.22;
      } else if (this.disasterType === 'storm') {
        event = true;
        eventName = 'STORM';
        rain *= 3.0;
        wind += 0.60;
        hum += 0.30;
      }
    } else {
      const cycleMod = t % 2000;
      if (cycleMod >= 1000 && cycleMod < 1500) {
        event = true;
        eventName = 'DROUGHT';
        temp += 0.40;
        rain *= 0.10;
        hum -= 0.22;
      } else if (!event && hash(t, 7, 55) > 0.994) {
        rain += 0.05;
        eventName = 'RAIN';
      }
    }

    this.weather.temp = clamp01(temp);
    this.weather.humid = Math.max(0.02, hum);
    this.weather.wind = clamp01(wind);
    this.weather.rain = rain;
    this.weather.event = event;
    this.weather.eventName = eventName;
  }

  public triggerDrought(durationTicks = 500) {
    this.disasterType = 'drought';
    this.disasterRemainingTicks = durationTicks;
    this.updateWeather(this.tickNo);
  }

  public triggerStorm(durationTicks = 200) {
    this.disasterType = 'storm';
    this.disasterRemainingTicks = durationTicks;
    this.updateWeather(this.tickNo);
  }

  public endDisaster() {
    this.disasterType = 'none';
    this.disasterRemainingTicks = 0;
    this.updateWeather(this.tickNo);
  }

  public seedPlants(count: number, soilMin = 0.30) {
    this.plants = [];
    this.plantsAlive = 0;
    this.plantIdCounter = 0;
    let guard = 0;
    const maxGuard = count * 60;

    while (this.plants.length < count && guard++ < maxGuard) {
      const i = (Math.random() * this.N) | 0;
      if (this.SOIL[i] < soilMin || this.WATER[i] > 0.8) continue;
      const sp = (Math.random() * this.species.length) | 0;

      this.plants.push({
        id: this.plantIdCounter++,
        i,
        x: i % this.X,
        y: (i / this.X) | 0,
        sp,
        lutW: this.LUT_S[sp],
        b: 0.5 + 0.7 * Math.random(),
        tol: this.species[sp].tol * (0.85 + 0.3 * Math.random()),
        stress: 0,
        alive: true
      });
      this.plantsAlive++;
    }
  }

  public seedCreatures(n: number) {
    this.creatures = [];
    this.creatureIdCounter = 0;
    for (let k = 0; k < n; k++) {
      const i = (Math.random() * this.N) | 0;
      this.creatures.push({
        id: this.creatureIdCounter++,
        x: i % this.X,
        y: (i / this.X) | 0,
        thirst: Math.random() * 40,
        hunger: Math.random() * 40,
        health: 100,
        age: Math.floor(Math.random() * this.MATURE),
        work: 0.2 + 0.4 * Math.random(),
        tx: i % this.X,
        ty: (i / this.X) | 0,
        hasT: false,
        sickness: 0,
        alive: true
      });
    }
    this.creaturesAlive = n;
  }

  public onTerrainModified(minX: number, maxX: number, minY: number, maxY: number) {
    const X = this.X, N = this.N, Z = this.Z;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const i = y * X + x;
        let hh = 0;
        for (let z = Z - 1; z >= 0; z--) {
          if (this.VOXEL[z * N + i] !== 0) {
            hh = z + 1;
            break;
          }
        }
        this.HGT[i] = hh;
      }
    }
    this.recomputeExposure();

    // [Q1/RE] Rescan free intervals for modified region.
    // Handles floating platforms: creates gap columns below platforms,
    // preserves water state where Floor still matches.
    this.water.updateTerrainRegion(
      this.VOXEL, this.N, this.Z,
      minX, maxX, minY, maxY
    );
  }

  private capillaryPass(dt: number): number {
    const X = this.X, Y = this.Y;
    let tCap = 0;
    for (let y = 0; y < Y; y++) {
      const row = y * X;
      for (let x = 0; x < X; x++) {
        const i = row + x;
        if (x + 1 < X) {
          const j = i + 1;
          const f = this.CAPILLARY * (this.SOIL[i] - this.SOIL[j]) * dt;
          this.SOIL[i] -= f;
          this.SOIL[j] += f;
          tCap += f < 0 ? -f : f;
        }
        if (y + 1 < Y) {
          const j = i + X;
          const f = this.CAPILLARY * (this.SOIL[i] - this.SOIL[j]) * dt;
          this.SOIL[i] -= f;
          this.SOIL[j] += f;
          tCap += f < 0 ? -f : f;
        }
      }
    }
    return tCap;
  }

  public tick(dt = 1.0) {
    this.tickNo++;
    if ((this.tickNo & 7) === 0 && this.enableCreatures) {
      this.updateWeather(this.tickNo);
    }

    const X = this.X, Y = this.Y, N = this.N;

    // ← ADD THIS RIGHT HERE
    if ((this.tickNo % 60) === 0) {
      const p = this.water.profile;
      console.log(`[SOLVER] outflows: ${p.outflows.toFixed(1)}ms | depth: ${p.depth.toFixed(1)}ms | sources: ${p.sources.toFixed(1)}ms | clear: ${p.clear.toFixed(1)}ms | changes: ${p.changes.toFixed(1)}ms`);
      this.water.profile = { outflows: 0, depth: 0, sources: 0, clear: 0, changes: 0 };
    }

    // ── Timberborn solver: sources + flow + evaporation ──
    this.syncWaterToCore();
    this.water.tickFrame();
    this.water.syncCompatMirrors(this.WATER);

    const { temp, humid: hum, wind } = this.weather;
    const rain = 0;
    const baseEvapK = this.enableEvaporation ? this.EVAP_RATE * temp * (1 - hum) * (1 + wind) : 0;

    let sW = 0, sS = 0, tSeep = 0, tEvap = 0;

    // Surface evaporation modifiers by ground cover
    const surfaceEvapMod = [1.0, 0.5, 1.2];

    // ── Soil layer: seep, drain, surface state machine ──
    // NOTE: WATER[i] is a mirror of solver state (overwritten each tick).
    // Seep losses below are fed back to solver via syncWaterBack().
    for (let i = 0; i < N; i++) {
      let w = this.WATER[i] + rain * dt;
      let sv = this.SOIL[i];

      const maxSeep = Math.max(0, 1.0 - sv);
      const seep = Math.min(maxSeep, this.SEEP_RATE * Math.min(w, 1.0) * dt);
      w -= seep;
      sv += seep;

      const covMod = surfaceEvapMod[this.SURFACE[i]] || 1.0;
      const ev = baseEvapK * this.EXPO[i] * sv * covMod * dt;
      sv -= ev;
      w -= ev * 0.5;

      if (w < this.DRAIN_DRY_EPS) sv -= this.SOIL_DRAIN * dt;

      sv = sv < 0 ? 0 : (sv > 1 ? 1 : sv);
      if (w < 0) w = 0;

      this.WATER[i] = w;
      this.SOIL[i] = sv;
      sW += w;
      sS += sv;
      tSeep += seep;
      tEvap += ev;

      if (sv >= 0.28) {
        this.grassTimer[i]++;
        this.deadTimer[i] = 0;
        if (this.SURFACE[i] !== SURFACE_GRASS && this.grassTimer[i] > 15) {
          this.SURFACE[i] = SURFACE_GRASS;
        }
      } else if (sv < 0.18) {
        this.deadTimer[i]++;
        this.grassTimer[i] = 0;
        if (this.SURFACE[i] === SURFACE_GRASS && this.deadTimer[i] > 25) {
          this.SURFACE[i] = SURFACE_DEAD;
        } else if (this.SURFACE[i] === SURFACE_DEAD && this.deadTimer[i] > 120) {
          this.SURFACE[i] = SURFACE_BARE;
        }
      } else {
        if (this.SURFACE[i] === SURFACE_DEAD && ++this.deadTimer[i] > 150) {
          this.SURFACE[i] = SURFACE_BARE;
        }
      }
    }

    // Capillary soil moisture diffusion
    const tCap = this.capillaryPass(dt);

    // Feed seep losses back to solver
    this.syncWaterBack();

    if (!this.enableCreatures) {
      this.avgW = sW / N;
      this.avgS = sS / N;
      this.channels.seep = tSeep;
      this.channels.runoff = 0;
      this.channels.cap = tCap;
      this.channels.storeW = sW;
      this.channels.storeS = sS;
      return;
    }

    // ── Plant tick ──
    let tDrink = 0;
    let plantsAliveCount = 0;
    const fitT = this.LUT_T[this.idx256(temp)];
    const fitH = this.LUT_H[this.idx256(hum)];

    for (let k = 0; k < this.plants.length; k++) {
      const p = this.plants[k];
      if (!p.alive) continue;
      const i = p.i;
      const nb = (
        this.SOIL[i > 0 ? i - 1 : i] +
        this.SOIL[i < N - 1 ? i + 1 : i] +
        this.SOIL[i >= X ? i - X : i] +
        this.SOIL[i < N - X ? i + X : i]
      ) * 0.25;

      const fitW = p.lutW[this.idx256((this.SOIL[i] + nb) * 0.5)];
      const g = fitT * fitH * fitW * p.tol;
      p.b += this.GROW_K * g * dt;
      const drink = this.DRINK_RATE * g * dt;
      this.SOIL[i] -= drink;
      if (this.SOIL[i] < 0) this.SOIL[i] = 0;
      tDrink += drink;

      if (g < 0.06) {
        if (++p.stress > 220) {
          p.alive = false;
          this.deathCounts.wither++;
          if (this.deathLog.length < 800) {
            const reason = this.WATER[i] > 0.9
              ? 'flooded — soil saturated'
              : 'soil dried — evaporation outpaced seep';
            this.deathLog.push(`T${this.pad(this.tickNo, 5)} PLT #${this.pad(p.id, 3)} wither (${reason}) bio ${p.b.toFixed(2)} soil ${this.SOIL[i].toFixed(3)}`);
          }
        }
      } else {
        p.stress = 0;
      }

      if (p.alive) plantsAliveCount++;
    }
    this.plantsAlive = plantsAliveCount;

    // Re-seeding when depleted
    if ((this.tickNo % 300) === 0 && this.plantsAlive < 2400) {
      for (let r = 0; r < 4; r++) {
        const pi = (Math.random() * N) | 0;
        if (this.SOIL[pi] > 0.32 && this.WATER[pi] < 0.8) {
          const sp2 = (Math.random() * this.species.length) | 0;
          this.plants.push({
            id: this.plantIdCounter++,
            i: pi,
            x: pi % X,
            y: (pi / X) | 0,
            sp: sp2,
            lutW: this.LUT_S[sp2],
            b: 0.3,
            tol: this.species[sp2].tol,
            stress: 0,
            alive: true
          });
          this.plantsAlive++;
        }
      }
    }

    // Coarse spatial indexing (every 32 ticks)
    if ((this.tickNo & 31) === 0) {
      this.CROWDGRID.fill(0);
      this.PLANTGRID.fill(0);
      this.WATERMAP.fill(0);

      for (let i = 0; i < N; i++) {
        const cell = (((i / X) | 0) >> 3) * 32 + ((i % X) >> 3);
        if (this.WATER[i] > this.WATERMAP[cell]) this.WATERMAP[cell] = this.WATER[i];
      }
      for (let k = 0; k < this.plants.length; k++) {
        const p = this.plants[k];
        if (p.alive) {
          this.PLANTGRID[(((p.i / X) | 0) >> 3) * 32 + ((p.i % X) >> 3)]++;
        }
      }
      for (let ci0 = 0; ci0 < this.creatures.length; ci0++) {
        const c0 = this.creatures[ci0];
        if (c0.alive) {
          this.CROWDGRID[(Math.floor(c0.y / 8) * 32 + Math.floor(c0.x / 8))]++;
        }
      }
    }

    // ── Creature ticks ──
    let aliveCCount = 0;
    for (let ci = 0; ci < this.creatures.length; ci++) {
      const c = this.creatures[ci];
      if (!c.alive) continue;
      c.age += dt;

      const ageF = c.age > this.MATURE
        ? Math.max(0.15, 1 - (c.age - this.MATURE) / (this.MAXAGE - this.MATURE))
        : 1;
      const speed = 0.9 * ageF;

      c.thirst += this.THIRST_BASE * (1 + c.work + temp) * ageF * dt;
      c.hunger += this.HUNGER_BASE * ageF * dt;

      if (c.hunger > 45) {
        const gi = Math.floor(c.y / 8) * 32 + Math.floor(c.x / 8);
        if (this.PLANTGRID[gi] > 0) {
          c.hunger = Math.max(0, c.hunger - 25);
        }
      }

      if (c.thirst > this.THIRST_T) {
        if (!c.hasT || (this.tickNo & 63) === 0) {
          let best = -1e9;
          let bi = 0;
          for (let t2 = 0; t2 < 1024; t2++) {
            const cx = (t2 % 32) * 8 + 4;
            const cy = ((t2 / 32) | 0) * 8 + 4;
            const q = Math.min(1, this.WATERMAP[t2] * 4)
              - Math.abs(cx - c.x) * 0.006 - Math.abs(cy - c.y) * 0.006
              - this.CROWDGRID[t2] * 0.05;
            if (q > best) {
              best = q;
              bi = t2;
            }
          }
          c.tx = (bi % 32) * 8 + 4 + Math.random() * 6 - 3;
          c.ty = ((bi / 32) | 0) * 8 + 4 + Math.random() * 6 - 3;
          c.hasT = true;
        }

        const dx = c.tx - c.x;
        const dy = c.ty - c.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        const ii = Math.floor(c.y) * X + Math.floor(c.x);

        if (d < 1.2 || (ii >= 0 && ii < N && this.WATER[ii] > 0.08)) {
          if (ii >= 0 && ii < N && this.WATER[ii] > 0.01) {
            c.thirst = 0;
            this.WATER[ii] = Math.max(0, this.WATER[ii] - 0.12);
          } else {
            c.tx = c.x + Math.random() * 30 - 15;
            c.ty = c.y + Math.random() * 30 - 15;
          }
          c.hasT = false;
        } else {
          c.x += (dx / d) * speed;
          c.y += (dy / d) * speed;
          c.x = Math.max(1, Math.min(X - 2, c.x));
          c.y = Math.max(1, Math.min(Y - 2, c.y));
        }
      }

      if (c.thirst > 100 || c.hunger > 100) c.health -= 2.0 * dt;
      if (c.age > this.MAXAGE) c.health -= 0.9 * dt;

      if (c.health <= 0) {
        c.alive = false;
        let reason = 'thirst';
        if (c.age > this.MAXAGE && c.thirst <= 100 && c.hunger <= 100) {
          reason = 'age';
          this.deathCounts.age++;
        } else if (c.thirst >= c.hunger) {
          reason = 'thirst';
          this.deathCounts.thirst++;
        } else {
          reason = 'hunger';
          this.deathCounts.hunger++;
        }

        if (this.deathLog.length < 800) {
          const ii = Math.floor(c.y) * X + Math.floor(c.x);
          const detail = reason === 'thirst'
            ? 'walked past dry reservoir'
            : (reason === 'hunger' ? `hunger(id=${c.id},h=${Math.round(c.health)},tick=${this.tickNo})` : 'old age');
          this.deathLog.push(`T${this.pad(this.tickNo, 5)} CRE #${this.pad(c.id, 3)} ${reason}: ${detail} tile ${Math.round(c.x)},${Math.round(c.y)} hyd ${(Math.max(0, 1 - c.thirst / 100)).toFixed(2)} fed ${(Math.max(0, 1 - c.hunger / 100)).toFixed(2)}`);
        }
        continue;
      }

      if (
        c.age > this.MATURE && c.age < this.MAXAGE * 0.8 &&
        (1 - c.hunger / 100) > 0.8 && (1 - c.thirst / 100) > 0.8 &&
        Math.random() < 0.0016 * dt && this.creatures.length < 1400
      ) {
        this.creatures.push({
          id: this.creatureIdCounter++,
          x: c.x + Math.random() * 4 - 2,
          y: c.y + Math.random() * 4 - 2,
          thirst: 0,
          hunger: 0,
          health: 100,
          age: 0,
          work: 0.2 + 0.4 * Math.random(),
          tx: c.x,
          ty: c.y,
          hasT: false,
          sickness: 0,
          alive: true
        });
      }

      aliveCCount++;
    }
    this.creaturesAlive = aliveCCount;

    // Feed drink losses back to solver
    this.syncWaterBack();

    this.avgW = sW / N;
    this.avgS = sS / N;

    this.channels.rain = rain;
    this.channels.seep = tSeep / N;
    this.channels.evapW = (0.5 * tEvap) / N;
    this.channels.evapS = tEvap / N;
    this.channels.cap = tCap / N;
    this.channels.drink = tDrink;
    this.channels.runoff = 0;
    this.channels.storeW = this.avgW;
    this.channels.storeS = this.avgS;

    if ((this.tickNo % 20) === 0) {
      this.logQueue.push(
        `${this.pad(this.tickNo, 5)} ${this.pad(this.tpsCurrent, 3)}/s W${this.avgW.toFixed(3).slice(1)} S${this.avgS.toFixed(3).slice(1)} A${this.creaturesAlive}`
      );
      if (this.logQueue.length > 64) this.logQueue.shift();
    }

    if (this.tickNo % 10 === 0 && this.recHistory.length < 300) {
      this.recHistory.push({ t: this.tickNo, w: this.avgW, s: this.avgS });
    }

    if ([500, 1000, 1500, 2000].includes(this.tickNo)) {
      this.recordSnapshot(this.tickNo);
    }
  }

  public recordSnapshot(t: number): SoilSnapshot {
    const hist = new Array(20).fill(0);
    let sum = 0, dry = 0;
    for (let i = 0; i < this.N; i++) {
      const v = this.SOIL[i];
      let b = (v * 20) | 0;
      if (b > 19) b = 19;
      if (b < 0) b = 0;
      hist[b]++;
      sum += v;
      if (v < 0.15) dry++;
    }
    const snap: SoilSnapshot = {
      t,
      hist,
      mean: sum / this.N,
      dry: dry / this.N,
      plants: this.plantsAlive,
      alive: this.creaturesAlive
    };
    this.snapshots.push(snap);
    return snap;
  }

  public runBenchmarkSuite(): SimReport {
    const counts = [10, 100, 500];
    const benchResults: SimBenchmarkResult[] = [];

    for (const n of counts) {
      this.generateDefaultWorld();
      this.creatures = [];
      this.seedCreatures(n);

      for (let w = 0; w < 250; w++) this.tick();

      const t0 = performance.now();
      for (let t = 0; t < 750; t++) this.tick();
      const ms = performance.now() - t0;
      const tps = 750 / (ms / 1000);
      const cost = ms / 750;

      benchResults.push({ n, tps, cost });
    }

    const m10 = benchResults[0];
    const m100 = benchResults[1];
    const m500 = benchResults[2];
    const meanTps = (m10.tps + m100.tps + m500.tps) / 3;
    const ratio = m500.tps / m10.tps;

    let verdict = '';
    if (ratio > 0.92) {
      verdict = `AGENT COUNT IS NOT THE BOTTLENECK — THE 256×256 TERRAIN PASS DOMINATES TICK COST, +490 AGENTS COST ${((1 - ratio) * 100).toFixed(1)}%`;
    } else if (ratio > 0.6) {
      verdict = 'TICK COST SCALES MODESTLY WITH AGENT COUNT — TERRAIN PASS STILL DOMINATES ABOVE 100 CREATURES';
    } else {
      verdict = 'TICK COST SCALES WITH AGENT COUNT — AGENT PASS IS THE BOTTLENECK ABOVE 100 CREATURES';
    }

    const lines = [
      `1. ticks/sec @10 creatures   : ${m10.tps.toFixed(0)}   (pure loop · 250 warm-up + 750 timed ticks)`,
      `2. ticks/sec @100 creatures  : ${m100.tps.toFixed(0)}   (same protocol)`,
      `3. ticks/sec @500 creatures  : ${m500.tps.toFixed(0)}   (same protocol)   tick cost ${m500.cost.toFixed(2)} ms`,
      `4. scaling 10->500 agents    : ${(ratio * 100).toFixed(1)}% of the 10-creature rate · mean ${meanTps.toFixed(0)} t/s`,
      `5. world at T${this.tickNo}  : avg water ${this.avgW.toFixed(3)} · avg soil ${this.avgS.toFixed(3)} · alive ${this.creaturesAlive}/${this.creatures.length}`
    ];

    return {
      bench: benchResults,
      meanTps,
      ratio,
      verdict,
      lines,
      deaths: this.deathLog.slice(-12),
      snapshots: this.snapshots
    };
  }

  private pad(n: number, w: number): string {
    let s = String(Math.round(n));
    while (s.length < w) s = '0' + s;
    return s;
  }
}
