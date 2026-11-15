import React, { useMemo, useRef, useLayoutEffect, useEffect, useImperativeHandle } from 'react';
import {
  Color,
  Vector3,
  Ray,
  Matrix4,
  Group,
  Mesh,
  MeshBasicMaterial,
  BufferGeometry,
  BufferAttribute,
  DoubleSide,
  BackSide,
  DataTexture,
  RGBAFormat,
  UnsignedByteType,
  NearestFilter,
  SRGBColorSpace,
  MeshStandardMaterial,
  Raycaster,
  Intersection,
} from 'three';
import { useFrame, ThreeEvent } from '@react-three/fiber';
import { WorldData } from '../types';
import { parseIntArray, parseFloatArray, MALFORMED } from '../lib/worldArrays';
import { frameMetrics } from '../utils/frameMetrics';
import { nullRaycast, getSharedWaterTexture, MIN_WATER_DEPTH_GLSL } from './renderShared';

export interface TerrainPreviewHandle {
  setVoxel: (x: number, y: number, z: number, val: number) => void;
  setVoxelsBatch: (edits: Array<{ x: number; y: number; z: number; val: number }>) => void;
  getValues: () => Int32Array | null;
}

export interface SelectionBoxHandle {
  update: (
    start: { x: number; y: number; z: number },
    end: { x: number; y: number; z: number },
    color?: string
  ) => void;
  hide: () => void;
}

interface TerrainPreviewProps {
  world: WorldData;
  sizeX: number;
  sizeY: number;
  numLayers: number;
  sliceZ?: number | null;
  showWireframe?: boolean;
  simSurface?: Uint8Array;
  simSoil?: Float32Array;
  simContam?: Float32Array;
  simWater?: Float32Array;
  waterTexture?: DataTexture;
  simVersion?: number;
  simVersionRef?: React.RefObject<number>;
  raycastEnabled?: boolean;
  terrainRef?: React.Ref<TerrainPreviewHandle>;
  onTerrainClick?: (voxel: { x: number, y: number, z: number, val: number }, button: number, normal?: { x: number, y: number, z: number }) => void;
  onPointerDown?: (voxel: { x: number, y: number, z: number, val: number }, button: number, normal: { x: number, y: number, z: number }) => void;
  onPointerMove?: (voxel: { x: number, y: number, z: number, val: number }, button: number, normal: { x: number, y: number, z: number }) => void;
  onPointerUp?: (voxel: { x: number, y: number, z: number, val: number }, button: number, normal: { x: number, y: number, z: number }) => void;
  onPointerHover?: (voxel: { x: number, y: number, z: number, val: number } | null) => void;
}

export const SelectionPreview: React.FC<{ start: { x: number, y: number, z: number }, end: { x: number, y: number, z: number }, color?: string }> = ({ start, end, color = '#3b82f6' }) => {
  const minX = Math.min(start.x, end.x);
  const maxX = Math.max(start.x, end.x);
  const minY = Math.min(start.y, end.y);
  const maxY = Math.max(start.y, end.y);
  const minZ = Math.min(start.z, end.z);
  const maxZ = Math.max(start.z, end.z);

  const width = maxX - minX + 1;
  const depth = maxY - minY + 1;
  const height = maxZ - minZ + 1;

  const centerX = minY + depth / 2;
  const centerY = minZ + height / 2;
  const centerZ = minX + width / 2;

  return (
    <mesh position={[centerX, centerY, centerZ]} raycast={nullRaycast}>
    <boxGeometry args={[depth + 0.05, height + 0.05, width + 0.05]} />
    <meshBasicMaterial color={color} side={BackSide} transparent opacity={0.6} depthTest={true} />
    </mesh>
  );
};

// Zero-render imperative selection preview (avoids React re-renders on clicks/drags)
export const SelectionBoxOverlay = React.forwardRef<SelectionBoxHandle>((_, ref) => {
  const meshRef = useRef<Mesh>(null);
  const matRef = useRef<MeshBasicMaterial>(null);

  useImperativeHandle(ref, () => ({
    update(start, end, color = '#3b82f6') {
      const mesh = meshRef.current;
      if (!mesh) return;
      const minX = Math.min(start.x, end.x);
      const maxX = Math.max(start.x, end.x);
      const minY = Math.min(start.y, end.y);
      const maxY = Math.max(start.y, end.y);
      const minZ = Math.min(start.z, end.z);
      const maxZ = Math.max(start.z, end.z);

      const width = maxX - minX + 1;
      const depth = maxY - minY + 1;
      const height = maxZ - minZ + 1;

      mesh.position.set(minY + depth / 2, minZ + height / 2, minX + width / 2);
      mesh.scale.set(depth + 0.05, height + 0.05, width + 0.05);
      if (matRef.current) matRef.current.color.set(color);
      mesh.visible = true;
    },
    hide() {
      if (meshRef.current) meshRef.current.visible = false;
    },
  }), []);

  return (
    <mesh ref={meshRef} visible={false} raycast={nullRaycast}>
    <boxGeometry args={[1, 1, 1]} />
    <meshBasicMaterial ref={matRef} color="#3b82f6" side={BackSide} transparent opacity={0.6} depthTest={true} />
    </mesh>
  );
});

// ---- RE Tiled Terrain Constants & Precomputed Colors ---------------
const TILE_SHIFT = 5; // 32x32x32 tiles -> max 64 draw calls on 256x256x32
const TILE_SIZE = 1 << TILE_SHIFT;
const TILE_AREA = TILE_SIZE * TILE_SIZE;

const EXP_TOP   = 1;
const EXP_POS_X = 2;
const EXP_NEG_X = 4;
const EXP_POS_Y = 8;
const EXP_NEG_Y = 16;

const ALERT_VAL = 255;
const LAYER_BRIGHTNESS = [1.12, 0.88, 1.04, 0.96];
const FACE_TOP = 0, FACE_FRONT = 1, FACE_BACK = 2, FACE_LEFT = 3, FACE_RIGHT = 4;

const COLOR_ALERT = new Color('#ff2d55');
const COLOR_VAL1  = new Color('#795548');
const COLOR_VAL2  = new Color('#558b2f');
const COLOR_OTHER = new Color().setHSL(0.1, 0.4, 0.3);

const NEIGHBOR_OFFSETS_4: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [1, 0], [-1, 0], [0, 1], [0, -1],
];
const NEIGHBORS_8_AND_SELF: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
];

// Reusable math for 3D DDA raycast (zero per-ray allocations)
const _ddaInvMat = new Matrix4();
const _ddaLocalRay = new Ray();
const _ddaNormal = new Vector3();

interface DdaVoxelMeta {
  tbX: number;
  tbY: number;
  tbZ: number;
  nx: number;
  ny: number;
  nz: number;
}

interface TerrainHeightChange {
  x: number;
  y: number;
  from: number;
  to: number;
  setTerrain: boolean;
}

class TileMeshBuilder {
  private pos = new Float32Array(1 << 15);
  private norm = new Float32Array(1 << 15);
  private col = new Float32Array(1 << 15);
  private uv = new Float32Array(1 << 15);
  private idx = new Uint32Array(1 << 15);
  private vCount = 0;
  private iCount = 0;
  readonly topMask = new Int32Array(TILE_AREA);

  reset(): void {
    this.vCount = 0;
    this.iCount = 0;
  }

  get isEmpty(): boolean {
    return this.vCount === 0;
  }

  private ensureCapacity(addVerts: number, addIndices: number): void {
    const reqVerts = this.vCount + addVerts;
    const req3 = reqVerts * 3;
    if (req3 > this.pos.length) {
      let next = this.pos.length;
      while (next < req3) next <<= 1;
      const p = new Float32Array(next); p.set(this.pos); this.pos = p;
      const n = new Float32Array(next); n.set(this.norm); this.norm = n;
      const c = new Float32Array(next); c.set(this.col); this.col = c;
    }
    const req2 = reqVerts * 2;
    if (req2 > this.uv.length) {
      let next = this.uv.length;
      while (next < req2) next <<= 1;
      const u = new Float32Array(next); u.set(this.uv); this.uv = u;
    }
    const reqIdx = this.iCount + addIndices;
    if (reqIdx > this.idx.length) {
      let next = this.idx.length;
      while (next < reqIdx) next <<= 1;
      const ix = new Uint32Array(next); ix.set(this.idx); this.idx = ix;
    }
  }

  emitQuad(
    face: number,
    px: number, py: number, pz: number,
    nx: number, ny: number, nz: number,
    r: number, g: number, b: number,
    cellX: number, cellY: number, widthW: number, depthD: number,
    sizeX: number, sizeY: number
  ): void {
    let ax = 0, ay = 0, az = 0;
    let bx = 0, by = 0, bz = 0;
    let cx = 0, cy = 0, cz = 0;
    let dx = 0, dy = 0, dz = 0;
    let fnX = 0, fnY = 0, fnZ = 0;

    switch (face) {
      case FACE_TOP:
        ax = px; ay = ny; az = nz; bx = nx; by = ny; bz = nz;
        cx = nx; cy = ny; cz = pz; dx = px; dy = ny; dz = pz;
        fnY = 1;
        break;
      case FACE_FRONT:
        ax = px; ay = py; az = nz; bx = nx; by = py; bz = nz;
        cx = nx; cy = ny; cz = nz; dx = px; dy = ny; dz = nz;
        fnZ = 1;
        break;
      case FACE_BACK:
        ax = nx; ay = py; az = pz; bx = px; by = py; bz = pz;
        cx = px; cy = ny; cz = pz; dx = nx; dy = ny; dz = pz;
        fnZ = -1;
        break;
      case FACE_LEFT:
        ax = px; ay = py; az = pz; bx = px; by = py; bz = nz;
        cx = px; cy = ny; cz = nz; dx = px; dy = ny; dz = pz;
        fnX = -1;
        break;
      case FACE_RIGHT:
        ax = nx; ay = py; az = nz; bx = nx; by = py; bz = pz;
        cx = nx; cy = ny; cz = pz; dx = nx; dy = ny; dz = nz;
        fnX = 1;
        break;
      default:
        return;
    }

    this.ensureCapacity(4, 6);

    const vBase = this.vCount;
    const pOff = vBase * 3;
    const uOff = vBase * 2;
    const iOff = this.iCount;

    const pos = this.pos;
    pos[pOff]     = ax; pos[pOff + 1]  = ay; pos[pOff + 2]  = az;
    pos[pOff + 3] = bx; pos[pOff + 4]  = by; pos[pOff + 5]  = bz;
    pos[pOff + 6] = cx; pos[pOff + 7]  = cy; pos[pOff + 8]  = cz;
    pos[pOff + 9] = dx; pos[pOff + 10] = dy; pos[pOff + 11] = dz;

    const norm = this.norm;
    norm[pOff]     = fnX; norm[pOff + 1]  = fnY; norm[pOff + 2]  = fnZ;
    norm[pOff + 3] = fnX; norm[pOff + 4]  = fnY; norm[pOff + 5]  = fnZ;
    norm[pOff + 6] = fnX; norm[pOff + 7]  = fnY; norm[pOff + 8]  = fnZ;
    norm[pOff + 9] = fnX; norm[pOff + 10] = fnY; norm[pOff + 11] = fnZ;

    const col = this.col;
    const uv = this.uv;

    const uvX0 = cellX / sizeX;
    const uvX1 = (cellX + widthW) / sizeX;
    const uvY0 = cellY / sizeY;
    const uvY1 = (cellY + depthD) / sizeY;

    if (fnY === 0) {
      const sideFactor = Math.abs(fnX) > 0.5 ? 0.5 : 0.8;
      const fr = r * sideFactor;
      const fg = g * sideFactor;
      const fb = b * sideFactor;
      const dark = 0.7;
      col[pOff]     = fr * dark; col[pOff + 1]  = fg * dark; col[pOff + 2]  = fb * dark;
      col[pOff + 3] = fr * dark; col[pOff + 4]  = fg * dark; col[pOff + 5]  = fb * dark;
      col[pOff + 6] = fr;        col[pOff + 7]  = fg;        col[pOff + 8]  = fb;
      col[pOff + 9] = fr;        col[pOff + 10] = fg;        col[pOff + 11] = fb;
    } else {
      const fr = fnY > 0 ? r : r * 0.2;
      const fg = fnY > 0 ? g : g * 0.2;
      const fb = fnY > 0 ? b : b * 0.2;
      col[pOff]     = fr; col[pOff + 1]  = fg; col[pOff + 2]  = fb;
      col[pOff + 3] = fr; col[pOff + 4]  = fg; col[pOff + 5]  = fb;
      col[pOff + 6] = fr; col[pOff + 7]  = fg; col[pOff + 8]  = fb;
      col[pOff + 9] = fr; col[pOff + 10] = fg; col[pOff + 11] = fb;
    }

    uv[uOff]     = uvX1; uv[uOff + 1] = uvY0;
    uv[uOff + 2] = uvX1; uv[uOff + 3] = uvY1;
    uv[uOff + 4] = uvX0; uv[uOff + 5] = uvY1;
    uv[uOff + 6] = uvX0; uv[uOff + 7] = uvY0;

    const idx = this.idx;
    idx[iOff]     = vBase;
    idx[iOff + 1] = vBase + 1;
    idx[iOff + 2] = vBase + 2;
    idx[iOff + 3] = vBase;
    idx[iOff + 4] = vBase + 2;
    idx[iOff + 5] = vBase + 3;

    this.vCount = vBase + 4;
    this.iCount = iOff + 6;
  }

  buildGeometry(): BufferGeometry {
    const geo = new BufferGeometry();
    const v3 = this.vCount * 3;
    const v2 = this.vCount * 2;
    geo.setAttribute('position', new BufferAttribute(this.pos.slice(0, v3), 3));
    geo.setAttribute('normal', new BufferAttribute(this.norm.slice(0, v3), 3));
    geo.setAttribute('color', new BufferAttribute(this.col.slice(0, v3), 3));
    geo.setAttribute('uv', new BufferAttribute(this.uv.slice(0, v2), 2));
    const indexSlice = this.vCount <= 65535
    ? new Uint16Array(this.idx.subarray(0, this.iCount))
    : this.idx.slice(0, this.iCount);
    geo.setIndex(new BufferAttribute(indexSlice, 1));
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return geo;
  }
}

interface TileComponents {
  tx: number;
  ty: number;
  tz: number;
  mesh: Mesh;
}

interface TerrainEngineState {
  sizeX: number;
  sizeY: number;
  numLayers: number;
  maxZ: number;
  total: number;
  tilesX: number;
  tilesY: number;
  tilesZ: number;
  values: Int32Array;
  surfaceCodes: Uint8Array;
  tileVisibleCount: Int32Array;
  tiles: Map<number, TileComponents>;
  dirtyCodes: Set<number>;
  invalidTiles: Set<number>;
  builder: TileMeshBuilder;
}

function getValColor(val: number): Color {
  if (val === ALERT_VAL) return COLOR_ALERT;
  if (val === 1) return COLOR_VAL1;
  if (val === 2) return COLOR_VAL2;
  return COLOR_OTHER;
}

function computeExposureCode(
  values: Int32Array,
  x: number,
  y: number,
  z: number,
  sizeX: number,
  sizeY: number,
  maxZ: number,
  total: number
): number {
  if (z >= maxZ) return 0;
  const idx = z * total + y * sizeX + x;
  if (values[idx] <= 0) return 0;

  let code = 0;
  if (z + 1 >= maxZ || values[idx + total] === 0) code |= EXP_TOP;
  if (x + 1 >= sizeX || values[idx + 1] === 0) code |= EXP_POS_X;
  if (x <= 0 || values[idx - 1] === 0) code |= EXP_NEG_X;
  if (y + 1 >= sizeY || values[idx + sizeX] === 0) code |= EXP_POS_Y;
  if (y <= 0 || values[idx - sizeX] === 0) code |= EXP_NEG_Y;
  return code;
}

// Fast Amanatides-Woo 3D grid DDA directly against state.values (O(distance), 0 triangle tests)
function raycastVoxelGridDDA(
  state: TerrainEngineState,
  rayProxy: Mesh,
  raycaster: Raycaster,
  intersects: Intersection[]
): void {
  const { sizeX, sizeY, maxZ, total, values } = state;
  if (sizeX <= 0 || sizeY <= 0 || maxZ <= 0) return;

  _ddaInvMat.copy(rayProxy.matrixWorld).invert();
  _ddaLocalRay.copy(raycaster.ray).applyMatrix4(_ddaInvMat);

  const ox = _ddaLocalRay.origin.x;
  const oy = _ddaLocalRay.origin.y;
  const oz = _ddaLocalRay.origin.z;
  const dx = _ddaLocalRay.direction.x;
  const dy = _ddaLocalRay.direction.y;
  const dz = _ddaLocalRay.direction.z;

  // Slab intersection against Three.js grid box [0, sizeY] x [0, maxZ] x [0, sizeX]
  let tMin = raycaster.near;
  let tMax = raycaster.far;
  let entryAxis = -1;

  if (Math.abs(dx) < 1e-12) {
    if (ox < 0 || ox > sizeY) return;
  } else {
    const inv = 1 / dx;
    let t1 = (0 - ox) * inv;
    let t2 = (sizeY - ox) * inv;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tMin) { tMin = t1; entryAxis = 0; }
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return;
  }

  if (Math.abs(dy) < 1e-12) {
    if (oy < 0 || oy > maxZ) return;
  } else {
    const inv = 1 / dy;
    let t1 = (0 - oy) * inv;
    let t2 = (maxZ - oy) * inv;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tMin) { tMin = t1; entryAxis = 1; }
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return;
  }

  if (Math.abs(dz) < 1e-12) {
    if (oz < 0 || oz > sizeX) return;
  } else {
    const inv = 1 / dz;
    let t1 = (0 - oz) * inv;
    let t2 = (sizeX - oz) * inv;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tMin) { tMin = t1; entryAxis = 2; }
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return;
  }

  const tProbe = tMin + 1e-5;
  if (tProbe > tMax) return;

  let iy = Math.max(0, Math.min(sizeY - 1, Math.floor(ox + dx * tProbe)));
  let iz = Math.max(0, Math.min(maxZ - 1, Math.floor(oy + dy * tProbe)));
  let ix = Math.max(0, Math.min(sizeX - 1, Math.floor(oz + dz * tProbe)));

  const pushHit = (tHit: number, wxNorm: number, wyNorm: number, wzNorm: number, hx: number, hy: number, hz: number) => {
    const hitPoint = new Vector3(ox + dx * tHit, oy + dy * tHit, oz + dz * tHit).applyMatrix4(rayProxy.matrixWorld);
    _ddaNormal.set(wxNorm, wyNorm, wzNorm);
    const distance = hitPoint.distanceTo(raycaster.ray.origin);
    if (distance < raycaster.near || distance > raycaster.far) return;

    const hit: Intersection & { _ddaVoxel?: DdaVoxelMeta } = {
      distance,
      point: hitPoint,
      face: {
        a: 0,
        b: 0,
        c: 0,
        normal: _ddaNormal.clone(),
        materialIndex: 0,
      },
      object: rayProxy,
      _ddaVoxel: {
        tbX: hx,
        tbY: hy,
        tbZ: hz,
        nx: wzNorm,
        ny: wxNorm,
        nz: wyNorm,
      },
    };
    intersects.push(hit);
  };

  // Hit right on outer bounding box face
  if (entryAxis !== -1 && values[iz * total + iy * sizeX + ix] > 0) {
    const nx = entryAxis === 0 ? (dx > 0 ? -1 : 1) : 0;
    const ny = entryAxis === 1 ? (dy > 0 ? -1 : 1) : 0;
    const nz = entryAxis === 2 ? (dz > 0 ? -1 : 1) : 0;
    pushHit(tMin, nx, ny, nz, ix, iy, iz);
    return;
  }

  const stepWx = dx > 0 ? 1 : (dx < 0 ? -1 : 0);
  const stepWy = dy > 0 ? 1 : (dy < 0 ? -1 : 0);
  const stepWz = dz > 0 ? 1 : (dz < 0 ? -1 : 0);

  const tDeltaWx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaWy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  const tDeltaWz = dz !== 0 ? Math.abs(1 / dz) : Infinity;

  let tMaxWx = stepWx > 0 ? ((iy + 1 - ox) / dx) : (stepWx < 0 ? ((iy - ox) / dx) : Infinity);
  let tMaxWy = stepWy > 0 ? ((iz + 1 - oy) / dy) : (stepWy < 0 ? ((iz - oy) / dy) : Infinity);
  let tMaxWz = stepWz > 0 ? ((ix + 1 - oz) / dz) : (stepWz < 0 ? ((ix - oz) / dz) : Infinity);

  const maxSteps = sizeX + sizeY + maxZ + 8;
  for (let step = 0; step < maxSteps; step++) {
    let tHit: number;
    let hnx = 0, hny = 0, hnz = 0;

    if (tMaxWx < tMaxWy) {
      if (tMaxWx < tMaxWz) {
        tHit = tMaxWx;
        iy += stepWx;
        tMaxWx += tDeltaWx;
        hnx = -stepWx;
      } else {
        tHit = tMaxWz;
        ix += stepWz;
        tMaxWz += tDeltaWz;
        hnz = -stepWz;
      }
    } else {
      if (tMaxWy < tMaxWz) {
        tHit = tMaxWy;
        iz += stepWy;
        tMaxWy += tDeltaWy;
        hny = -stepWy;
      } else {
        tHit = tMaxWz;
        ix += stepWz;
        tMaxWz += tDeltaWz;
        hnz = -stepWz;
      }
    }

    if (tHit > tMax || ix < 0 || ix >= sizeX || iy < 0 || iy >= sizeY || iz < 0 || iz >= maxZ) {
      return;
    }

    if (values[iz * total + iy * sizeX + ix] > 0) {
      pushHit(tHit, hnx, hny, hnz, ix, iy, iz);
      return;
    }
  }
}

export const TerrainPreview: React.FC<TerrainPreviewProps> = ({
  world, sizeX, sizeY, numLayers, sliceZ, showWireframe = false,
  simSurface, simSoil, simContam, simWater, simVersion, simVersionRef, waterTexture: externalWaterTexture,
  raycastEnabled = true, terrainRef,
  onTerrainClick, onPointerDown, onPointerMove, onPointerUp, onPointerHover
}) => {
  const waterTexture = useMemo(
    () => externalWaterTexture || getSharedWaterTexture(sizeX, sizeY),
                               [externalWaterTexture, sizeX, sizeY]
  );

  const terrainArray = world?.Singletons?.TerrainMap?.Voxels?.Array ?? '';
  const moistureArrayStr = world?.Singletons?.SoilMoistureSimulator?.MoistureLevels?.Array;
  const contamArrayStr =
  world?.Singletons?.SoilContaminationSimulator?.ContaminationLevels?.Array ||
  world?.Singletons?.SoilContaminationSimulator?.ContaminationCandidates?.Array;

  const moistureLevels = useMemo(
    () => (moistureArrayStr ? parseFloatArray(moistureArrayStr) : null),
                                 [moistureArrayStr]
  );
  const contaminationLevels = useMemo(
    () => (contamArrayStr ? parseFloatArray(contamArrayStr) : null),
                                      [contamArrayStr]
  );

  const tilesGroupRef = useRef<Group>(null);
  const rayProxyRef = useRef<Mesh>(null);
  const hoverMeshRef = useRef<Mesh>(null);
  const engineRef = useRef<TerrainEngineState | null>(null);
  const lastTerrainArrayRef = useRef<string>('');
  const lastDimsRef = useRef<{ sizeX: number; sizeY: number; numLayers: number } | null>(null);

  // Track camera dragging (MMB/RMB) locally so DDA skips raycasting while orbiting
  const isCamDragRef = useRef(false);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (e.button === 1 || e.button === 2) isCamDragRef.current = true;
    };
      const onUp = (e: PointerEvent) => {
        if (e.button === 1 || e.button === 2) isCamDragRef.current = false;
      };
        const onBlur = () => {
          isCamDragRef.current = false;
        };
        window.addEventListener('pointerdown', onDown, { capture: true, passive: true });
        window.addEventListener('pointerup', onUp, { capture: true, passive: true });
        window.addEventListener('blur', onBlur, { passive: true });
        return () => {
          window.removeEventListener('pointerdown', onDown, { capture: true });
          window.removeEventListener('pointerup', onUp, { capture: true });
          window.removeEventListener('blur', onBlur);
        };
  }, []);

  const ddaRaycast = useMemo(() => {
    return function (this: Mesh, raycaster: Raycaster, intersects: Intersection[]) {
      if (isCamDragRef.current) return;
      const state = engineRef.current;
      if (!state) return;
      raycastVoxelGridDDA(state, this, raycaster, intersects);
    };
  }, []);

  const colorMapData = useMemo(() => {
    const data = new Uint8Array(Math.max(1, sizeX * sizeY) * 4);
    const wetGrass = [46, 125, 50];
    const deadDark = [92, 64, 40];
    for (let y = 0; y < sizeY; y++) {
      const rowOff = y * sizeX;
      for (let x = 0; x < sizeX; x++) {
        const mapIdx = rowOff + x;
        const pixelIdx = mapIdx * 4;
        const surf = simSurface && mapIdx < simSurface.length ? simSurface[mapIdx] : 1;
        const m = simSoil && mapIdx < simSoil.length ? Math.max(0, Math.min(1, simSoil[mapIdx])) : 0.5;

        let r = 121, g = 85, b = 72;
        if (surf === 1) {
          const gr = 67, gg = 160, gb = 71;
          const factor = 0.3 + m * 0.7;
          r = Math.round(gr + (wetGrass[0] - gr) * factor);
          g = Math.round(gg + (wetGrass[1] - gg) * factor);
          b = Math.round(gb + (wetGrass[2] - gb) * factor);
        } else if (surf === 2) {
          const dr = 158, dg = 125, db = 59;
          const factor = m * 0.4;
          r = Math.round(dr + (deadDark[0] - dr) * factor);
          g = Math.round(dg + (deadDark[1] - dg) * factor);
          b = Math.round(db + (deadDark[2] - db) * factor);
        }
        data[pixelIdx]     = r;
        data[pixelIdx + 1] = g;
        data[pixelIdx + 2] = b;
        data[pixelIdx + 3] = 255;
      }
    }
    return data;
  }, [sizeX, sizeY, simSurface, simSoil]);

  const colorMapTexture = useMemo(() => {
    const tex = new DataTexture(colorMapData, Math.max(1, sizeX), Math.max(1, sizeY), RGBAFormat, UnsignedByteType);
    tex.magFilter = NearestFilter;
    tex.minFilter = NearestFilter;
    tex.colorSpace = SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  }, [colorMapData, sizeX, sizeY]);

  useEffect(() => {
    return () => {
      colorMapTexture.dispose();
    };
  }, [colorMapTexture]);

  const uniformsRef = useRef({
    uColorMap: { value: colorMapTexture },
    uWaterTexture: { value: waterTexture },
  });

  useEffect(() => {
    uniformsRef.current.uColorMap.value = colorMapTexture;
    uniformsRef.current.uWaterTexture.value = waterTexture;
  }, [colorMapTexture, waterTexture]);

  const terrainMaterial = useMemo(() => {
    const mat = new MeshStandardMaterial({
      roughness: 0.8,
      metalness: 0.0,
      envMapIntensity: 0.35,
      vertexColors: true,
      wireframe: showWireframe,
    });

    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uColorMap = uniformsRef.current.uColorMap;
      shader.uniforms.uWaterTexture = uniformsRef.current.uWaterTexture;

      shader.vertexShader = `
      varying vec2 vTerrainUv;
      varying float vIsTopFace;
      ${shader.vertexShader}
      `.replace(
        '#include <uv_vertex>',
        `
        #include <uv_vertex>
        vTerrainUv = uv;
        vIsTopFace = normal.y > 0.5 ? 1.0 : 0.0;
        `
      );

      shader.fragmentShader = `
      uniform sampler2D uColorMap;
      uniform sampler2D uWaterTexture;
      varying vec2 vTerrainUv;
      varying float vIsTopFace;
      ${shader.fragmentShader}
      `.replace(
        '#include <color_fragment>',
        `
        #include <color_fragment>
        if (vIsTopFace > 0.5) {
          vec4 surfCol = texture2D(uColorMap, vTerrainUv);
          diffuseColor.rgb = surfCol.rgb * vColor.rgb;
        } else {
          diffuseColor.rgb = vColor.rgb;
        }

        vec4 wData = texture2D(uWaterTexture, vTerrainUv);
        float wDepth = wData.b;
        if (wDepth > ${MIN_WATER_DEPTH_GLSL}) {
          float tintFactor = min(wDepth / 3.0, 0.7);
          vec3 submergedColor = vec3(0.04, 0.22, 0.28);
          diffuseColor.rgb = mix(diffuseColor.rgb, submergedColor, tintFactor);
        }
        `
      );
    };

    return mat;
  }, [showWireframe]);

  const terrainMaterialRef = useRef(terrainMaterial);
  terrainMaterialRef.current = terrainMaterial;

  useEffect(() => {
    return () => {
      terrainMaterial.dispose();
    };
  }, [terrainMaterial]);

  const disposeAllTiles = (state: TerrainEngineState | null) => {
    const group = tilesGroupRef.current;
    if (state) {
      state.tiles.forEach((tc) => {
        tc.mesh.geometry.dispose();
        if (group) group.remove(tc.mesh);
      });
        state.tiles.clear();
    }
    if (group) {
      group.clear();
    }
  };

  const markTerrainHeightChanged = (state: TerrainEngineState, change: TerrainHeightChange) => {
    const { x, y, from, to } = change;
    const zMin = Math.max(0, from - 1);
    const zMax = Math.min(state.maxZ - 1, to + 1);
    if (zMin > zMax) return;

    const total = state.total;
    const sx = state.sizeX;
    const sy = state.sizeY;
    const tilesX = state.tilesX;
    const tilesXY = tilesX * state.tilesY;

    for (let z = zMin; z <= zMax; z++) {
      const zOff = z * total;
      for (let i = 0; i < NEIGHBOR_OFFSETS_4.length; i++) {
        const nx = x + NEIGHBOR_OFFSETS_4[i][0];
        const ny = y + NEIGHBOR_OFFSETS_4[i][1];
        if (nx >= 0 && nx < sx && ny >= 0 && ny < sy) {
          state.dirtyCodes.add(zOff + ny * sx + nx);
        }
      }
    }

    const tzMin = zMin >> TILE_SHIFT;
    const tzMax = zMax >> TILE_SHIFT;
    for (let i = 0; i < NEIGHBORS_8_AND_SELF.length; i++) {
      const nx = x + NEIGHBORS_8_AND_SELF[i][0];
      const ny = y + NEIGHBORS_8_AND_SELF[i][1];
      if (nx < 0 || nx >= sx || ny < 0 || ny >= sy) continue;
      const tx = nx >> TILE_SHIFT;
      const ty = ny >> TILE_SHIFT;
      for (let tz = tzMin; tz <= tzMax; tz++) {
        state.invalidTiles.add(tz * tilesXY + ty * tilesX + tx);
      }
    }
  };

  const updateCodeForCoords = (state: TerrainEngineState, idx: number) => {
    const total = state.total;
    const z = Math.floor(idx / total);
    const rem = idx - z * total;
    const y = Math.floor(rem / state.sizeX);
    const x = rem - y * state.sizeX;

    const oldCode = state.surfaceCodes[idx];
    const newCode = computeExposureCode(
      state.values, x, y, z, state.sizeX, state.sizeY, state.maxZ, total
    );
    if (oldCode === newCode) return;

    state.surfaceCodes[idx] = newCode;
    const tx = x >> TILE_SHIFT;
    const ty = y >> TILE_SHIFT;
    const tz = z >> TILE_SHIFT;
    const tileId = tz * (state.tilesX * state.tilesY) + ty * state.tilesX + tx;
    if (oldCode === 0) state.tileVisibleCount[tileId]++;
    else if (newCode === 0) state.tileVisibleCount[tileId]--;
  };

    const updateTile = (state: TerrainEngineState, tileId: number) => {
      const group = tilesGroupRef.current;
      if (!group) return;

      const tilesX = state.tilesX;
      const tilesXY = tilesX * state.tilesY;
      const tz = Math.floor(tileId / tilesXY);
      const rem = tileId - tz * tilesXY;
      const ty = Math.floor(rem / tilesX);
      const tx = rem - ty * tilesX;

      let tc = state.tiles.get(tileId);

      if (state.tileVisibleCount[tileId] <= 0) {
        if (tc) tc.mesh.visible = false;
        return;
      }

      const x0 = tx << TILE_SHIFT;
      const y0 = ty << TILE_SHIFT;
      const z0 = tz << TILE_SHIFT;
      const x1 = Math.min(state.sizeX, x0 + TILE_SIZE);
      const y1 = Math.min(state.sizeY, y0 + TILE_SIZE);
      const z1 = Math.min(state.maxZ, z0 + TILE_SIZE);

      if (x0 >= x1 || y0 >= y1 || z0 >= z1) {
        if (tc) tc.mesh.visible = false;
        return;
      }

      const tileW = x1 - x0;
      const tileH = y1 - y0;
      const sx = state.sizeX;
      const sy = state.sizeY;
      const total = state.total;
      const values = state.values;
      const surfaceCodes = state.surfaceCodes;
      const builder = state.builder;
      const topMask = builder.topMask;

      builder.reset();

      for (let z = z0; z < z1; z++) {
        const zOff = z * total;
        const py = z;
        const ny = z + 1;
        const layerShade = (0.7 + (z / 16) * 0.3) * LAYER_BRIGHTNESS[z % 4];

        let hasTop = false;
        topMask.fill(0);
        for (let ly = 0; ly < tileH; ly++) {
          const gy = y0 + ly;
          const rowOff = zOff + gy * sx + x0;
          const maskRow = ly * tileW;
          for (let lx = 0; lx < tileW; lx++) {
            const idx = rowOff + lx;
            if ((surfaceCodes[idx] & EXP_TOP) !== 0) {
              topMask[maskRow + lx] = values[idx];
              hasTop = true;
            }
          }
        }

        if (hasTop) {
          for (let ly = 0; ly < tileH; ly++) {
            const maskRow = ly * tileW;
            for (let lx = 0; lx < tileW; lx++) {
              const key = topMask[maskRow + lx];
              if (key === 0) continue;

              let w = 1;
              while (lx + w < tileW && topMask[maskRow + lx + w] === key) w++;

              let d = 1;
              expand: while (ly + d < tileH) {
                const nextRow = (ly + d) * tileW + lx;
                for (let rw = 0; rw < w; rw++) {
                  if (topMask[nextRow + rw] !== key) break expand;
                }
                d++;
              }

              for (let dy = 0; dy < d; dy++) {
                const clearRow = (ly + dy) * tileW + lx;
                for (let dx = 0; dx < w; dx++) topMask[clearRow + dx] = 0;
              }

              const gx = x0 + lx;
              const gy = y0 + ly;
              builder.emitQuad(
                FACE_TOP,
                gy, py, gx, gy + d, ny, gx + w,
                layerShade, layerShade, layerShade,
                gx, gy, w, d, sx, sy
              );
            }
          }
        }

        for (let lx = 0; lx < tileW; lx++) {
          const gx = x0 + lx;
          let ly = 0;
          while (ly < tileH) {
            const idx = zOff + (y0 + ly) * sx + gx;
            if ((surfaceCodes[idx] & EXP_POS_X) === 0) {
              ly++;
              continue;
            }
            const key = values[idx];
            let d = 1;
            while (ly + d < tileH) {
              const nIdx = idx + d * sx;
              if ((surfaceCodes[nIdx] & EXP_POS_X) === 0 || values[nIdx] !== key) break;
              d++;
            }
            const c = getValColor(key);
            const gy = y0 + ly;
            builder.emitQuad(
              FACE_FRONT,
              gy, py, gx, gy + d, ny, gx + 1,
              c.r * layerShade, c.g * layerShade, c.b * layerShade,
              gx, gy, 1, d, sx, sy
            );
            ly += d;
          }

          ly = 0;
          while (ly < tileH) {
            const idx = zOff + (y0 + ly) * sx + gx;
            if ((surfaceCodes[idx] & EXP_NEG_X) === 0) {
              ly++;
              continue;
            }
            const key = values[idx];
            let d = 1;
            while (ly + d < tileH) {
              const nIdx = idx + d * sx;
              if ((surfaceCodes[nIdx] & EXP_NEG_X) === 0 || values[nIdx] !== key) break;
              d++;
            }
            const c = getValColor(key);
            const gy = y0 + ly;
            builder.emitQuad(
              FACE_BACK,
              gy, py, gx, gy + d, ny, gx + 1,
              c.r * layerShade, c.g * layerShade, c.b * layerShade,
              gx, gy, 1, d, sx, sy
            );
            ly += d;
          }
        }

        for (let ly = 0; ly < tileH; ly++) {
          const gy = y0 + ly;
          const rowOff = zOff + gy * sx + x0;
          let lx = 0;
          while (lx < tileW) {
            const idx = rowOff + lx;
            if ((surfaceCodes[idx] & EXP_NEG_Y) === 0) {
              lx++;
              continue;
            }
            const key = values[idx];
            let w = 1;
            while (lx + w < tileW) {
              const nIdx = idx + w;
              if ((surfaceCodes[nIdx] & EXP_NEG_Y) === 0 || values[nIdx] !== key) break;
              w++;
            }
            const c = getValColor(key);
            const gx = x0 + lx;
            builder.emitQuad(
              FACE_LEFT,
              gy, py, gx, gy + 1, ny, gx + w,
              c.r * layerShade, c.g * layerShade, c.b * layerShade,
              gx, gy, w, 1, sx, sy
            );
            lx += w;
          }

          lx = 0;
          while (lx < tileW) {
            const idx = rowOff + lx;
            if ((surfaceCodes[idx] & EXP_POS_Y) === 0) {
              lx++;
              continue;
            }
            const key = values[idx];
            let w = 1;
            while (lx + w < tileW) {
              const nIdx = idx + w;
              if ((surfaceCodes[nIdx] & EXP_POS_Y) === 0 || values[nIdx] !== key) break;
              w++;
            }
            const c = getValColor(key);
            const gx = x0 + lx;
            builder.emitQuad(
              FACE_RIGHT,
              gy, py, gx, gy + 1, ny, gx + w,
              c.r * layerShade, c.g * layerShade, c.b * layerShade,
              gx, gy, w, 1, sx, sy
            );
            lx += w;
          }
        }
      }

      if (builder.isEmpty) {
        if (tc) tc.mesh.visible = false;
        return;
      }

      const newGeo = builder.buildGeometry();
      if (!tc) {
        const mesh = new Mesh(newGeo, terrainMaterialRef.current);
        mesh.name = `TerrainTile (${tx},${ty},${tz})`;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        mesh.raycast = nullRaycast; // DDA rayProxy handles all terrain raycasts
        group.add(mesh);
        tc = { tx, ty, tz, mesh };
        state.tiles.set(tileId, tc);
      } else {
        tc.mesh.geometry.dispose();
        tc.mesh.geometry = newGeo;
        tc.mesh.material = terrainMaterialRef.current;
        tc.mesh.visible = true;
      }
    };

    const flushDirty = (state: TerrainEngineState) => {
      if (state.dirtyCodes.size > 0) {
        state.dirtyCodes.forEach((idx) => updateCodeForCoords(state, idx));
        state.dirtyCodes.clear();
      }
      if (state.invalidTiles.size > 0) {
        state.invalidTiles.forEach((tileId) => updateTile(state, tileId));
        state.invalidTiles.clear();
      }
    };

    const applyEdits = (edits: Array<{ x: number; y: number; z: number; val: number }>) => {
      const state = engineRef.current;
      if (!state || edits.length === 0) return;

      const byCol = new Map<number, Array<{ z: number; setTerrain: boolean }>>();
      for (let i = 0; i < edits.length; i++) {
        const { x, y, z, val } = edits[i];
        if (x < 0 || x >= state.sizeX || y < 0 || y >= state.sizeY || z < 0 || z >= state.numLayers) continue;
        const idx = z * state.total + y * state.sizeX + x;
        const normalized = val === MALFORMED ? ALERT_VAL : val;
        if (state.values[idx] === normalized) continue;
        state.values[idx] = normalized;
        const colKey = y * state.sizeX + x;
        let list = byCol.get(colKey);
        if (!list) {
          list = [];
          byCol.set(colKey, list);
        }
        list.push({ z, setTerrain: normalized > 0 });
      }

      if (byCol.size === 0) return;

      byCol.forEach((list, colKey) => {
        list.sort((a, b) => a.z - b.z);
        const y = Math.floor(colKey / state.sizeX);
        const x = colKey - y * state.sizeX;
        let runStart = list[0].z;
        let runEnd = list[0].z;
        let runSet = list[0].setTerrain;
        for (let i = 1; i < list.length; i++) {
          const cur = list[i];
          if (cur.z === runEnd + 1 && cur.setTerrain === runSet) {
            runEnd = cur.z;
          } else {
            markTerrainHeightChanged(state, { x, y, from: runStart, to: runEnd, setTerrain: runSet });
            runStart = cur.z;
            runEnd = cur.z;
            runSet = cur.setTerrain;
          }
        }
        markTerrainHeightChanged(state, { x, y, from: runStart, to: runEnd, setTerrain: runSet });
      });

      flushDirty(state);
    };

    useImperativeHandle(terrainRef, () => ({
      setVoxel(x: number, y: number, z: number, val: number) {
        applyEdits([{ x, y, z, val }]);
      },
      setVoxelsBatch(edits) {
        applyEdits(edits);
      },
      getValues() {
        return engineRef.current ? engineRef.current.values : null;
      },
    }));

    useLayoutEffect(() => {
      const group = tilesGroupRef.current;
      if (!group) return;

      const targetMaxZ =
      sliceZ !== undefined && sliceZ !== null ? Math.min(sliceZ, numLayers) : numLayers;

      if (!terrainArray || sizeX <= 0 || sizeY <= 0 || numLayers <= 0 || targetMaxZ <= 0) {
        disposeAllTiles(engineRef.current);
        engineRef.current = null;
        lastTerrainArrayRef.current = '';
        lastDimsRef.current = null;
        return;
      }

      const prevDims = lastDimsRef.current;
      const dimsChanged =
      !prevDims ||
      prevDims.sizeX !== sizeX ||
      prevDims.sizeY !== sizeY ||
      prevDims.numLayers !== numLayers ||
      !engineRef.current;

      if (dimsChanged) {
        disposeAllTiles(engineRef.current);
        const parsed = parseIntArray(terrainArray);
        const total = sizeX * sizeY;
        const voxelCount = total * numLayers;
        const values = new Int32Array(voxelCount);
        const copyLen = Math.min(parsed.length, voxelCount);
        for (let i = 0; i < copyLen; i++) {
          const raw = parsed[i];
          values[i] = raw === MALFORMED ? ALERT_VAL : raw;
        }

        const tilesX = Math.ceil(sizeX / TILE_SIZE);
        const tilesY = Math.ceil(sizeY / TILE_SIZE);
        const tilesZ = Math.ceil(numLayers / TILE_SIZE);
        const totalTiles = tilesX * tilesY * tilesZ;

        const state: TerrainEngineState = {
          sizeX,
          sizeY,
          numLayers,
          maxZ: targetMaxZ,
          total,
          tilesX,
          tilesY,
          tilesZ,
          values,
          surfaceCodes: new Uint8Array(voxelCount),
                    tileVisibleCount: new Int32Array(totalTiles),
                    tiles: new Map(),
                    dirtyCodes: new Set(),
                    invalidTiles: new Set(),
                    builder: new TileMeshBuilder(),
        };

        const tilesXY = tilesX * tilesY;
        for (let z = 0; z < targetMaxZ; z++) {
          const zOff = z * total;
          const tz = z >> TILE_SHIFT;
          for (let y = 0; y < sizeY; y++) {
            const rowOff = zOff + y * sizeX;
            const ty = y >> TILE_SHIFT;
            for (let x = 0; x < sizeX; x++) {
              const idx = rowOff + x;
              const code = computeExposureCode(values, x, y, z, sizeX, sizeY, targetMaxZ, total);
              if (code !== 0) {
                state.surfaceCodes[idx] = code;
                const tileId = tz * tilesXY + ty * tilesX + (x >> TILE_SHIFT);
                state.tileVisibleCount[tileId]++;
                state.invalidTiles.add(tileId);
              }
            }
          }
        }

        engineRef.current = state;
        lastDimsRef.current = { sizeX, sizeY, numLayers };
        lastTerrainArrayRef.current = terrainArray;
        flushDirty(state);
        return;
      }

      const state = engineRef.current!;

      if (terrainArray !== lastTerrainArrayRef.current) {
        const parsed = parseIntArray(terrainArray);
        const total = state.total;
        const voxelCount = total * state.numLayers;
        const copyLen = Math.min(parsed.length, voxelCount);
        const values = state.values;

        for (let y = 0; y < sizeY; y++) {
          const rowOff = y * sizeX;
          for (let x = 0; x < sizeX; x++) {
            let runStart = -1;
            let runSet = false;
            for (let z = 0; z < numLayers; z++) {
              const idx = z * total + rowOff + x;
              const raw = idx < copyLen ? parsed[idx] : 0;
              const nextVal = raw === MALFORMED ? ALERT_VAL : raw;
              if (nextVal !== values[idx]) {
                values[idx] = nextVal;
                const isSet = nextVal > 0;
                if (runStart === -1) {
                  runStart = z;
                  runSet = isSet;
                } else if (isSet !== runSet) {
                  markTerrainHeightChanged(state, { x, y, from: runStart, to: z - 1, setTerrain: runSet });
                  runStart = z;
                  runSet = isSet;
                }
              } else if (runStart !== -1) {
                markTerrainHeightChanged(state, { x, y, from: runStart, to: z - 1, setTerrain: runSet });
                runStart = -1;
              }
            }
            if (runStart !== -1) {
              markTerrainHeightChanged(state, { x, y, from: runStart, to: numLayers - 1, setTerrain: runSet });
            }
          }
        }
        lastTerrainArrayRef.current = terrainArray;
      }

      if (state.maxZ !== targetMaxZ) {
        const oldMaxZ = state.maxZ;
        state.maxZ = targetMaxZ;
        const zLo = Math.max(0, Math.min(oldMaxZ, targetMaxZ) - 1);
        const zHi = Math.min(numLayers - 1, Math.max(oldMaxZ, targetMaxZ) - 1);
        const tilesX = state.tilesX;
        const tilesXY = tilesX * state.tilesY;

        for (let z = zLo; z <= zHi; z++) {
          const zOff = z * state.total;
          const tz = z >> TILE_SHIFT;
          for (let y = 0; y < sizeY; y++) {
            const rowOff = zOff + y * sizeX;
            const ty = y >> TILE_SHIFT;
            for (let x = 0; x < sizeX; x++) {
              state.dirtyCodes.add(rowOff + x);
              state.invalidTiles.add(tz * tilesXY + ty * tilesX + (x >> TILE_SHIFT));
            }
          }
        }
      }

      flushDirty(state);
    }, [terrainArray, sizeX, sizeY, numLayers, sliceZ]);

    useEffect(() => {
      const state = engineRef.current;
      if (!state) return;
      state.tiles.forEach((tc) => {
        tc.mesh.material = terrainMaterial;
      });
    }, [terrainMaterial]);

    useEffect(() => {
      return () => {
        disposeAllTiles(engineRef.current);
        engineRef.current = null;
      };
    }, []);

    const lastTerrainUploadRef = useRef(0);
    const lastSimVersionRef = useRef<number | undefined>(undefined);

    useFrame(() => {
      const state = engineRef.current;
      if (state && (state.dirtyCodes.size > 0 || state.invalidTiles.size > 0)) {
        flushDirty(state);
      }

      const curSimVer = simVersionRef ? simVersionRef.current : simVersion;
      if (curSimVer !== undefined && curSimVer === lastSimVersionRef.current) {
        return;
      }

      const now = performance.now();
      if (now - lastTerrainUploadRef.current < 66) return;
      lastTerrainUploadRef.current = now;
      lastSimVersionRef.current = curSimVer;

      const tUploadStart = performance.now();
      const contamR = 136, contamG = 0, contamB = 143;
      let dirty = false;

      for (let y = 0; y < sizeY; y++) {
        const rowOff = y * sizeX;
        for (let x = 0; x < sizeX; x++) {
          const mapIdx = rowOff + x;
          const pixelIdx = mapIdx * 4;

          let r = 121, g = 85, b = 72;
          let m = 0;
          let c = 0;
          const surf = simSurface && mapIdx < simSurface.length ? simSurface[mapIdx] : 0;

          if (simSoil && mapIdx < simSoil.length) {
            m = Math.max(0, Math.min(1, simSoil[mapIdx]));
          } else if (moistureLevels && mapIdx < moistureLevels.length) {
            m = Math.max(0, Math.min(1, moistureLevels[mapIdx] / 16));
          }
          if (simContam && mapIdx < simContam.length) {
            c = Math.max(0, Math.min(1, simContam[mapIdx]));
          } else if (contaminationLevels && mapIdx < contaminationLevels.length) {
            c = contaminationLevels[mapIdx];
          }

          if (surf === 1) {
            const factor = 0.3 + m * 0.7;
            r = Math.round(67 + (46 - 67) * factor);
            g = Math.round(160 + (125 - 160) * factor);
            b = Math.round(71 + (50 - 71) * factor);
          } else if (surf === 2) {
            const factor = m * 0.4;
            r = Math.round(158 + (92 - 158) * factor);
            g = Math.round(125 + (64 - 125) * factor);
            b = Math.round(59 + (40 - 59) * factor);
          } else {
            const factor = m * 0.4;
            r = Math.round(121 + (85 - 121) * factor);
            g = Math.round(85 + (139 - 85) * factor);
            b = Math.round(72 + (47 - 72) * factor);
          }

          if (c > 0) {
            const factor = c > 0.5 ? 0.75 : 0.4;
            r = Math.round(r + (contamR - r) * factor);
            g = Math.round(g + (contamG - g) * factor);
            b = Math.round(b + (contamB - b) * factor);
          }

          if (
            colorMapData[pixelIdx] !== r ||
            colorMapData[pixelIdx + 1] !== g ||
            colorMapData[pixelIdx + 2] !== b
          ) {
            colorMapData[pixelIdx] = r;
            colorMapData[pixelIdx + 1] = g;
            colorMapData[pixelIdx + 2] = b;
            colorMapData[pixelIdx + 3] = 255;
            dirty = true;
          }
        }
      }
      if (dirty) {
        colorMapTexture.needsUpdate = true;
      }
      frameMetrics.recordUploadTerrain(performance.now() - tUploadStart);
    });

    const pointerDownPos = useRef<{ x: number; y: number } | null>(null);
    const lastHoverKeyRef = useRef<string>('');
    const tmpVecA = useMemo(() => new Vector3(), []);
    const tmpVecB = useMemo(() => new Vector3(), []);
    const unitZ = useMemo(() => new Vector3(0, 0, 1), []);

    const hitToVoxel = (e: ThreeEvent<PointerEvent>): DdaVoxelMeta => {
      const dda = (e as unknown as { _ddaVoxel?: DdaVoxelMeta })._ddaVoxel
      ?? (e.intersections?.[0] as unknown as { _ddaVoxel?: DdaVoxelMeta } | undefined)?._ddaVoxel;
      if (dda) return dda;

      tmpVecA.copy(e.face!.normal).multiplyScalar(0.05);
      tmpVecB.copy(e.point).sub(tmpVecA);
      return {
        tbX: Math.max(0, Math.min(sizeX - 1, Math.floor(tmpVecB.z))),
        tbY: Math.max(0, Math.min(sizeY - 1, Math.floor(tmpVecB.x))),
        tbZ: Math.max(0, Math.min(numLayers - 1, Math.floor(tmpVecB.y))),
        nx: Math.round(e.face!.normal.z),
        ny: Math.round(e.face!.normal.x),
        nz: Math.round(e.face!.normal.y),
      };
    };

    const handlePointerDown = raycastEnabled
    ? (e: ThreeEvent<PointerEvent>) => {
      pointerDownPos.current = { x: e.screenX, y: e.screenY };
      if (onPointerDown && e.face) {
        e.stopPropagation();
        const { tbX, tbY, tbZ, nx, ny, nz } = hitToVoxel(e);
        onPointerDown({ x: tbX, y: tbY, z: tbZ, val: 0 }, e.button, { x: nx, y: ny, z: nz });
      }
    }
    : undefined;

    const handlePointerMove = raycastEnabled
    ? (e: ThreeEvent<PointerEvent>) => {
      if (!e.face) return;
      e.stopPropagation();
      const { tbX, tbY, tbZ, nx, ny, nz } = hitToVoxel(e);

      if (onPointerMove) {
        onPointerMove({ x: tbX, y: tbY, z: tbZ, val: 0 }, e.buttons, { x: nx, y: ny, z: nz });
      }
      if (onPointerHover) onPointerHover({ x: tbX, y: tbY, z: tbZ, val: 0 });
      if (onTerrainClick && hoverMeshRef.current) {
        const key = `${tbX},${tbY},${tbZ},${nx},${ny},${nz}`;
        if (key !== lastHoverKeyRef.current) {
          lastHoverKeyRef.current = key;
          tmpVecA.copy(e.face.normal).multiplyScalar(0.501);
          hoverMeshRef.current.position.set(tbY + 0.5 + tmpVecA.x, tbZ + 0.5 + tmpVecA.y, tbX + 0.5 + tmpVecA.z);
          hoverMeshRef.current.quaternion.setFromUnitVectors(unitZ, e.face.normal);
        }
        hoverMeshRef.current.visible = true;
      }
    }
    : undefined;

    const handlePointerOut = raycastEnabled
    ? () => {
      lastHoverKeyRef.current = '';
      if (hoverMeshRef.current) hoverMeshRef.current.visible = false;
    }
    : undefined;

    const handlePointerUp = raycastEnabled
    ? (e: ThreeEvent<PointerEvent>) => {
      if (onPointerUp && e.face) {
        e.stopPropagation();
        const { tbX, tbY, tbZ, nx, ny, nz } = hitToVoxel(e);
        onPointerUp({ x: tbX, y: tbY, z: tbZ, val: 0 }, e.button, { x: nx, y: ny, z: nz });
      }
      if (!pointerDownPos.current) return;
      const dist = Math.hypot(
        e.screenX - pointerDownPos.current.x,
        e.screenY - pointerDownPos.current.y
      );
      pointerDownPos.current = null;
      if (dist < 5 && onTerrainClick && e.point && e.face) {
        e.stopPropagation();
        const { tbX, tbY, tbZ, nx, ny, nz } = hitToVoxel(e);
        const state = engineRef.current;
        if (state && tbX >= 0 && tbX < sizeX && tbY >= 0 && tbY < sizeY && tbZ >= 0 && tbZ < numLayers) {
          const idx = tbZ * state.total + tbY * sizeX + tbX;
          const val = state.values[idx];
          if (val > 0) {
            onTerrainClick({ x: tbX, y: tbY, z: tbZ, val }, e.button, { x: nx, y: ny, z: nz });
          }
        }
      }
    }
    : undefined;

    if (!terrainArray) return null;

    return (
      <group>
      <group ref={tilesGroupRef} />
      {/* Zero-draw DDA raycast proxy: 1 mesh, 0 WebGL draw calls, 0 triangle tests */}
      <mesh
      ref={rayProxyRef}
      raycast={raycastEnabled ? ddaRaycast : nullRaycast}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerOut={handlePointerOut}
      onPointerUp={handlePointerUp}
      >
      <boxGeometry args={[1, 1, 1]} />
      <meshBasicMaterial visible={false} />
      </mesh>
      <mesh
      ref={hoverMeshRef}
      visible={false}
      renderOrder={10}
      raycast={nullRaycast}
      >
      <planeGeometry args={[1, 1]} />
      <meshBasicMaterial color="#ffffff" transparent opacity={0.3} side={DoubleSide} depthTest={false} />
      </mesh>
      </group>
    );
};
