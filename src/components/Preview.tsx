// Barrel re-export — all existing imports from './components/Preview' keep working.
// Implementation lives in the individual modules below.

export { TerrainPreview, SelectionPreview, SelectionBoxOverlay } from './TerrainPreview';
export type { TerrainPreviewHandle, SelectionBoxHandle } from './TerrainPreview';
export { EntitiesPreview } from './EntitiesPreview';
export { WaterPreview } from './WaterPreview';
export type { WaterDisplayMode } from './WaterPreview';
export { MapOverlayPreview, HolePreview, VoxelHighlightPreview } from './MapOverlays';
export { SimCreaturesPreview } from './SimCreaturesPreview';
export { FrameMetricsTracker, StatsTracker } from './PerfTrackers';

// Shared utilities (re-exported for any external consumers)
export { nullRaycast, getSharedWaterTexture, getSharedWaterData, customTerrainRaycast, customInstancedMeshRaycast, MIN_WATER_DEPTH, MIN_WATER_DEPTH_GLSL } from './renderShared';
