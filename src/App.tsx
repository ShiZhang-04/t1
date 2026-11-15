import React, {useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Vector3, Color, AmbientLight, DirectionalLight, HemisphereLight, Fog } from 'three';
import { PerspectiveCamera, Stars, Environment, Stats, Sky } from '@react-three/drei';
import { JsonView, allExpanded, darkStyles } from 'react-json-view-lite';
import 'react-json-view-lite/dist/index.css';
import { Upload, Download, Eye, Code, Save, FileJson, Map as MapIcon, Info, AlertCircle, X, Layers, Maximize, Zap, ZapOff, Copy, Volume2, VolumeX, Camera, Video, MousePointer2, Hammer, Eraser, Crop, Mountain, Waves, Droplet, EyeOff, Box, Activity, Crosshair, Grid, Search, Sprout, Scissors, RefreshCw, Play, Pause, Flame, CloudRain, RotateCcw, Biohazard } from 'lucide-react';
import { useEntityDictionary } from './contexts/EntityDictionaryContext';
import { motion, AnimatePresence } from 'motion/react';
import { loadTimberFile, saveTimberFile, getMapInfo, exportWorldAsJson } from './services/timberService';
import { TimberSave, Entity, WorldData } from './types';
import { TerrainPreview, EntitiesPreview, WaterPreview, MapOverlayPreview, VoxelHighlightPreview, HolePreview, StatsTracker, SelectionPreview, SimCreaturesPreview, FrameMetricsTracker } from './components/Preview';
import { CameraController } from './components/CameraController';
import { ResizeOverlay } from './components/ResizeOverlay';
import { ModelEditor } from './components/ModelEditor';
import { EnglishCurriculum } from './components/EnglishCurriculum';
import { DroughtlineHUD } from './components/DroughtlineHUD';
import { RenderStatsOverlay, HeaderFpsBadge } from './components/RenderStatsOverlay';
import { DroughtlineSim } from './game/sim';
import { WaterBridge } from './game/waterBridge';
import { cn } from './lib/utils';
import { soundManager } from './utils/sound';
import { clearCameraPose } from './lib/cameraPose';
import { frameMetrics } from './utils/frameMetrics';
import type { WaterDisplayMode } from './components/Preview';

function createSaveFromSim(sim: DroughtlineSim): TimberSave {
  const X = sim.X, Y = sim.Y, Z = sim.Z;
  const vals: string[] = new Array(X * Y * Z);
  const total = X * Y;
  for (let z = 0; z < Z; z++) {
    const zOff = z * total;
    for (let i = 0; i < total; i++) {
      vals[zOff + i] = String(sim.VOXEL[zOff + i]);
    }
  }

  // Place a real WaterSource entity on a prominent hill (elevation ~14)
  const hillX = 90;
  const hillY = 40;
  const hillZ = sim.HGT[hillY * X + hillX] || 14;

  const defaultSpring: Entity = {
    Id: 'spring-hill-1',
    Template: 'WaterSource',
    Components: {
      BlockObject: {
        Coordinates: { X: hillX, Y: hillY, Z: hillZ },
        Orientation: 'Cw0'
      },
      WaterSource: {
        SpecifiedStrength: 0.5,
        CurrentStrength: 0.5
      }
    }
  };

  const world: WorldData = {
    Singletons: {
      MapSize: { Size: { X, Y } },
      TerrainMap: { Voxels: { Array: vals.join(' ') } },
      CameraService: { Target: { X: hillX, Y: hillY, Z: hillZ }, ZoomLevel: 0.6 }
    },
    Entities: [defaultSpring]
  };

  sim.syncWaterSources(world.Entities);

  return {
    world,
    metadata: { MapName: 'Droughtline Colony Map', PlayTime: '00:00:00' },
    originalFiles: {}
  };
}

const COL_TWILIGHT_END = new Color('#fff8ed');

const DayNightLighting: React.FC<{ sim: DroughtlineSim; isCinematic: boolean }> = ({ sim, isCinematic }) => {
  const ambRef = useRef<AmbientLight>(null);
  const dirRef = useRef<DirectionalLight>(null);
  const hemiRef = useRef<HemisphereLight>(null);
  const fogRef = useRef<Fog>(null);
  const colorTmp = useMemo(() => new Color(), []);
  const fogTmp = useMemo(() => new Color(), []);
  const lastLightStateRef = useRef<{ tod: number; wName: string; cin: boolean }>({ tod: -1, wName: '', cin: false });

  useFrame(() => {
    const tod = sim.timeOfDay;
    const wName = sim.weather.eventName;
    const last = lastLightStateRef.current;
    if (Math.abs(tod - last.tod) < 0.0002 && wName === last.wName && isCinematic === last.cin) {
      return;
    }
    last.tod = tod;
    last.wName = wName;
    last.cin = isCinematic;

    // 0.0 = midnight, 0.25 = 06:00 sunrise, 0.5 = 12:00 noon, 0.75 = 18:00 sunset
    const angle = (tod - 0.25) * Math.PI * 2;
    const sunElev = Math.sin(angle); // -1..1
    const daylight = Math.max(0, Math.min(1, (sunElev + 0.15) / 1.15));
    const twilight = Math.max(0, 1 - Math.abs(sunElev) * 4.5);

    const isStorm = wName === 'STORM' || wName === 'MONSOON';
    const isDrought = wName === 'DROUGHT';
    const stormDim = isStorm ? 0.65 : 1.0;

    if (dirRef.current) {
      const rx = Math.cos(angle) * 160;
      const ry = Math.max(18, sunElev * 180 + 25);
      const rz = 90 + Math.sin(angle * 0.5) * 35;
      dirRef.current.position.set(rx, ry, rz);

      const baseDir = isCinematic ? 2.4 : 1.85;
      dirRef.current.intensity = (0.35 + daylight * baseDir) * stormDim;

      if (twilight > 0.1) {
        colorTmp.set('#ffaa66').lerp(COL_TWILIGHT_END, Math.max(0, sunElev));
      } else if (daylight < 0.15) {
        colorTmp.set('#7fa3d9'); // cool moonlight
      } else if (isDrought) {
        colorTmp.set('#ffdfb0');
      } else if (isStorm) {
        colorTmp.set('#b8c8d8');
      } else {
        colorTmp.set('#fff9ef');
      }
      dirRef.current.color.copy(colorTmp);
    }

    if (ambRef.current) {
      const baseAmb = isCinematic ? 0.55 : 0.72;
      ambRef.current.intensity = (0.32 + daylight * baseAmb) * (isStorm ? 0.85 : 1.0);
    }

    if (hemiRef.current) {
      hemiRef.current.intensity = 0.25 + daylight * 0.35;
    }

    if (fogRef.current) {
      if (isCinematic) {
        fogTmp.set('#ffccaa');
      } else if (isStorm) {
        fogTmp.set('#1f262e');
      } else if (daylight < 0.2) {
        fogTmp.set('#0e131c');
      } else if (twilight > 0.25) {
        fogTmp.set('#332520');
      } else if (isDrought) {
        fogTmp.set('#2b2118');
      } else {
        fogTmp.set('#181c22');
      }
      fogRef.current.color.copy(fogTmp);
    }
  });

  return (
    <>
      <fog ref={fogRef} attach="fog" args={[isCinematic ? '#ffccaa' : '#181c22', 120, isCinematic ? 1000 : 560]} />
      <ambientLight ref={ambRef} intensity={0.75} />
      <directionalLight
        ref={dirRef}
        position={[100, 150, 100]}
        intensity={1.9}
        color={isCinematic ? '#ffccaa' : '#fff9ef'}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-200}
        shadow-camera-right={200}
        shadow-camera-top={200}
        shadow-camera-bottom={-200}
      />
      <hemisphereLight ref={hemiRef} intensity={0.45} groundColor="#1a1612" />
    </>
  );
};

export default function App() {
  const tReactStart = performance.now();
  const simRef = useRef<DroughtlineSim>(new DroughtlineSim(256, 256, 32));
  const sim = simRef.current;
  const bridgeRef = useRef<WaterBridge | null>(null);
  const [waterBridgeReady, setWaterBridgeReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const bridge = new WaterBridge();
    bridgeRef.current = bridge;
    bridge.init(sim.X, sim.Y, sim.Z, 8, sim.VOXEL, sim.N, sim.Z, 0.6)
      .then(() => {
        if (cancelled) return;
        sim.waterBridge = bridge;
        sim.syncWaterSourcesToBridge();
        setWaterBridgeReady(true);
        console.log('[WaterSolver] worker ready');
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('[WaterSolver] worker init failed, falling back to main-thread solver:', err);
          sim.waterBridge = null;
          setWaterBridgeReady(false);
        }
      });
    return () => {
      cancelled = true;
      if (sim.waterBridge === bridge) {
        sim.waterBridge = null;
      }
      setWaterBridgeReady(false);
      bridge.dispose();
    };
  }, [sim]);

  const [save, setSave] = useState<TimberSave | null>(() => createSaveFromSim(sim));
  const [isSimRunning, setIsSimRunning] = useState(true);
  const [simSpeed, setSimSpeed] = useState<number>(1);
  const [showHUD, setShowHUD] = useState(true);
  const simRenderVersionRef = useRef(0);
  const setSimRenderVersion = useCallback((_action?: any) => {
    simRenderVersionRef.current++;
  }, []);

  useLayoutEffect(() => {
    frameMetrics.recordReactRender(performance.now() - tReactStart);
  });

  useEffect(() => {
    (window as any).sim = sim;
    (window as any).placeSpring = (x: number, y: number, rate = 0.5, contamination = 0) => {
      const z = sim.HGT[y * sim.X + x] || 10;
      const isBad = contamination > 0;
      const newEntity: Entity = {
        Id: `${isBad ? 'badwater' : 'spring'}-${Date.now()}`,
        Template: isBad ? 'BadwaterSource' : 'WaterSource',
        Components: {
          BlockObject: { Coordinates: { X: x, Y: y, Z: z }, Orientation: 'Cw0' },
          WaterSource: { SpecifiedStrength: rate, CurrentStrength: rate, Contamination: contamination }
        }
      };
      if (save?.world) {
        const updated = {
          ...save.world,
          Entities: [...(save.world.Entities || []), newEntity]
        };
        setSave({ ...save, world: updated });
        sim.syncWaterSources(updated.Entities);
      } else {
        sim.addWaterSource(x, y, rate, contamination);
      }
      console.log(`Placed ${newEntity.Template} at (${x}, ${y}, ${z}) rate=${rate} contam=${contamination}`);
    };
    (window as any).placeStreamGauge = (x: number, y: number, zOverride?: number) => {
      const cx = Math.max(0, Math.min(sim.X - 1, Math.round(x)));
      const cy = Math.max(0, Math.min(sim.Y - 1, Math.round(y)));
      const cz = typeof zOverride === 'number' ? Math.round(zOverride) : (sim.HGT[cy * sim.X + cx] || 1);
      const gaugeEnt: Entity = {
        Id: `stream-gauge-${Date.now()}`,
        Template: 'StreamGauge.Folktails',
        Components: {
          BlockObject: { Coordinates: { X: cx, Y: cy, Z: cz }, Orientation: 'Cw0' },
          StreamGauge: { DepthThreshold: 0.5, ContaminationThreshold: 0.1 }
        }
      };
      if (save?.world) {
        const updated = {
          ...save.world,
          Entities: [...(save.world.Entities || []), gaugeEnt]
        };
        setSave({ ...save, world: updated });
        setSelectedEntity(gaugeEnt);
        setSelectedVoxel(null);
      }
      console.log(`Placed StreamGauge.Folktails at (${cx}, ${cy}, ${cz})`);
      return gaugeEnt;
    };
  }, [save, sim]);

  const headerClockRef = useRef<HTMLSpanElement | null>(null);
  const headerWeatherRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const updateHeaderTime = () => {
      if (headerClockRef.current) {
        headerClockRef.current.textContent = `DAY ${sim.day} · ${sim.formattedTime}`;
      }
      if (headerWeatherRef.current) {
        headerWeatherRef.current.textContent = sim.weather.eventName;
      }
    };
    updateHeaderTime();
    const t = setInterval(updateHeaderTime, 250);
    return () => clearInterval(t);
  }, [sim]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'preview' | 'json'>('preview');
  const [selectedEntity, setSelectedEntity] = useState<Entity | null>(null);
  const [selectedSimCreatureId, setSelectedSimCreatureId] = useState<number | null>(null);
  const [selectedSimPlantId, setSelectedSimPlantId] = useState<number | null>(null);
  const [hoveredEntity, setHoveredEntity] = useState<Entity | null>(null);
  const [jumpTarget, setJumpTarget] = useState<{ x: number, y: number, z: number } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [isEditingEntity, setIsEditingEntity] = useState(true);
  const [, setInspectorPulse] = useState(0);
  const [currentTool, setCurrentTool] = useState<'select' | 'terrain' | 'resize' | 'cut_zone' | 'plant_zone'>('terrain');
  const [terrainSubTool, setTerrainSubTool] = useState<'add' | 'remove'>('add');
  const [cutSubTool, setCutSubTool] = useState<'add' | 'remove'>('add');
  const [plantSubTool, setPlantSubTool] = useState<'add' | 'remove'>('add');
  const [selectionStart, setSelectionStart] = useState<{ x: number, y: number, z: number } | null>(null);
  const [selectionNormal, setSelectionNormal] = useState<{ x: number, y: number, z: number } | null>(null);
  const [selectionEnd, setSelectionEnd] = useState<{ x: number, y: number, z: number } | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [waterDisplayMode, setWaterDisplayMode] = useState<WaterDisplayMode>('depth');

  // [FIX] Only zone tools may start a drag rectangle — Select and Resize never sculpt
  const handlePointerDown = (v: { x: number, y: number, z: number }, button: number, normal?: { x: number, y: number, z: number }) => {
    const isZoneTool = currentTool === 'terrain' || currentTool === 'cut_zone' || currentTool === 'plant_zone';
    if (button === 0 && isZoneTool) {
      setSelectionStart(v);
      setSelectionEnd(v);
      setSelectionNormal(normal || null);
      setIsSelecting(true);
    }
  };

  const handlePointerMove = (v: { x: number, y: number, z: number }, buttons: number) => {
    if (isSelecting && buttons === 1) {
      setSelectionEnd({ ...v, z: selectionStart?.z ?? v.z });
    }
  };

  const handlePointerUp = (v: { x: number, y: number, z: number }, button: number) => {
    if (isSelecting && button === 0 && selectionStart && selectionEnd && save?.world) {
      const minX = Math.min(selectionStart.x, selectionEnd.x);
      const maxX = Math.max(selectionStart.x, selectionEnd.x);
      const minY = Math.min(selectionStart.y, selectionEnd.y);
      const maxY = Math.max(selectionStart.y, selectionEnd.y);
      const z = selectionStart.z;

      const newWorld = { ...save.world };
      newWorld.Singletons = { ...newWorld.Singletons };
      const { sizeX, sizeY, numLayers } = getMapInfo(newWorld);

      // [FIX] Remove 'select' — terrain edits only when Terrain tool is active
      if (currentTool === 'terrain') {
        newWorld.Singletons.TerrainMap = { ...newWorld.Singletons.TerrainMap };
        newWorld.Singletons.TerrainMap.Voxels = { ...newWorld.Singletons.TerrainMap.Voxels };
        const terrainArray = newWorld.Singletons.TerrainMap.Voxels.Array;
        const vals = terrainArray.split(/\s+/).filter(val => val.length > 0);

        let targetZ = z;
        if (terrainSubTool === 'add' && selectionNormal?.z === 1) {
          targetZ = Math.min(z + 1, numLayers - 1);
        }

        for (let x = minX; x <= maxX; x++) {
          for (let y = minY; y <= maxY; y++) {
            const idx = targetZ * (sizeX * sizeY) + y * sizeX + x;
            if (idx >= 0 && idx < vals.length) {
              const val = terrainSubTool === 'add' ? '1' : '0';
              vals[idx] = val;
              if (idx < sim.VOXEL.length) {
                sim.VOXEL[idx] = terrainSubTool === 'add' ? 1 : 0;
              }
            }
          }
        }
        sim.onTerrainModified(minX, maxX, minY, maxY);
        newWorld.Singletons.TerrainMap.Voxels.Array = vals.join(' ');
        setSave({ ...save, world: newWorld });
        setSimRenderVersion(v => v + 1);
        soundManager.playClick();
      } else if (currentTool === 'cut_zone') {
        const tca = { ...((newWorld.Singletons as any).TreeCuttingArea || { CuttingArea: [] }) };
        const area = [...(tca.CuttingArea || [])];

        for (let x = minX; x <= maxX; x++) {
          for (let y = minY; y <= maxY; y++) {
            const existingIdx = area.findIndex((c: any) => c.X === x && c.Y === y);
            if (cutSubTool === 'add') {
              if (existingIdx < 0) {
                area.push({ X: x, Y: y });
              }
            } else {
              if (existingIdx >= 0) {
                area.splice(existingIdx, 1);
              }
            }
          }
        }

        tca.CuttingArea = area;
        (newWorld.Singletons as any).TreeCuttingArea = tca;
        setSave({ ...save, world: newWorld });
        soundManager.playClick();
      } else if (currentTool === 'plant_zone') {
        let ps = (newWorld.Singletons as any).PlantingService;
        if (!ps) {
          ps = { PlantingMap: {} };
          (newWorld.Singletons as any).PlantingService = ps;
        }
        const pm = { ...(ps.PlantingMap || {}) };
        const cattails = [...(pm.Cattail || [])];

        let targetZ = z;
        if (plantSubTool === 'add' && selectionNormal?.z === 1) {
          targetZ = Math.min(z + 1, numLayers - 1);
        }

        for (let x = minX; x <= maxX; x++) {
          for (let y = minY; y <= maxY; y++) {
            const existingIdx = cattails.findIndex((c: any) => c.X === x && c.Y === y);
            if (plantSubTool === 'add') {
              if (existingIdx < 0) {
                cattails.push({ X: x, Y: y, Z: targetZ });
              }
            } else {
              if (existingIdx >= 0) {
                cattails.splice(existingIdx, 1);
              }
            }
          }
        }

        pm.Cattail = cattails;
        ps.PlantingMap = pm;
        setSave({ ...save, world: newWorld });
        soundManager.playClick();
      }
    }
    setIsSelecting(false);
    setSelectionStart(null);
    setSelectionEnd(null);
    setSelectionNormal(null);
  };

  const handleSearch = (query: string) => {
    setSearchQuery(query);
    if (!query || !save?.world) return;

    const trimmed = query.trim();
    const creMatch = trimmed.match(/^(?:CRE\s*#?|C#)(\d+)$/i);
    if (creMatch) {
      const cid = parseInt(creMatch[1], 10);
      const foundC = sim.creatures.find(c => c.id === cid && c.alive);
      if (foundC) {
        setSelectedSimCreatureId(foundC.id);
        setSelectedSimPlantId(null);
        setSelectedEntity(null);
        setSelectedVoxel(null);
        const cx = Math.max(0, Math.min(sim.X - 1, Math.floor(foundC.x)));
        const cy = Math.max(0, Math.min(sim.Y - 1, Math.floor(foundC.y)));
        const cz = sim.HGT[cy * sim.X + cx] || 1;
        setJumpTarget({ x: cx, y: cy, z: cz });
        return;
      }
    }

    const pltMatch = trimmed.match(/^(?:PLT\s*#?|P#)(\d+)$/i);
    if (pltMatch) {
      const pid = parseInt(pltMatch[1], 10);
      const foundP = sim.plants.find(p => p.id === pid && p.alive);
      if (foundP) {
        setSelectedSimPlantId(foundP.id);
        setSelectedSimCreatureId(null);
        setSelectedEntity(null);
        setSelectedVoxel(null);
        const cz = sim.HGT[foundP.i] || 1;
        setJumpTarget({ x: foundP.x, y: foundP.y, z: cz });
        return;
      }
    }

    const entityById = save.world.Entities.find(e => e.Id === trimmed);
    if (entityById) {
      setSelectedEntity(entityById);
      setSelectedSimCreatureId(null);
      setSelectedSimPlantId(null);
      setSelectedVoxel(null);

      const blockObj = entityById.Components?.BlockObject;
      const character = entityById.Components?.Character;
      let coords = null;
      if (blockObj) coords = blockObj.Coordinates;
      else if (character) coords = { X: character.Position.X, Y: character.Position.Z, Z: character.Position.Y };

      if (coords) {
        setJumpTarget({ x: coords.X, y: coords.Y, z: coords.Z });
      }
      return;
    }

    const coordsMatch = query.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (coordsMatch) {
      const x = parseInt(coordsMatch[1]);
      const y = parseInt(coordsMatch[2]);
      const z = parseInt(coordsMatch[3]);

      const entityAtCoords = save.world.Entities.find(e => {
        const blockObj = e.Components?.BlockObject;
        if (blockObj) {
          return blockObj.Coordinates.X === x && blockObj.Coordinates.Y === y && blockObj.Coordinates.Z === z;
        }
        return false;
      });

      if (entityAtCoords) {
        setSelectedEntity(entityAtCoords);
        setSelectedSimCreatureId(null);
        setSelectedSimPlantId(null);
        setSelectedVoxel(null);
      } else {
        setSelectedEntity(null);
        setSelectedSimCreatureId(null);
        setSelectedSimPlantId(null);
        setSelectedVoxel({ x, y, z, val: 0 });
      }
      setJumpTarget({ x, y, z });
    }
  };
  const [selectedVoxel, setSelectedVoxel] = useState<{ x: number, y: number, z: number, val: number } | null>(null);

  useEffect(() => {
    if (selectedSimCreatureId === null && selectedSimPlantId === null && !selectedEntity && !selectedVoxel) return;
    const timer = setInterval(() => {
      setInspectorPulse(p => (p + 1) & 0x3fffffff);
    }, 250);
    return () => clearInterval(timer);
  }, [selectedSimCreatureId, selectedSimPlantId, selectedEntity, selectedVoxel]);
  const [hoveredVoxel, setHoveredVoxel] = useState<{ x: number, y: number, z: number, val: number } | null>(null);
  const [sliceZ, setSliceZ] = useState<number | null>(null);
  const [showOrigin, setShowOrigin] = useState(false);
  const [showWireframe, setShowWireframe] = useState(false);
  const [showHoles, setShowHoles] = useState(true);
  const [isThinkingMode, setIsThinkingMode] = useState(false);
  const [isLowQuality, setIsLowQuality] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<string | null>(null);
  const [showModelEditor, setShowModelEditor] = useState(false);
  const [showTerrain, setShowTerrain] = useState(true);
  const [showWater, setShowWater] = useState(true);
  const [showShallowWater, setShowShallowWater] = useState(false);
  const [transparentWater, setTransparentWater] = useState(false);
  const [showEntities, setShowEntities] = useState(true);
  const [showStats, setShowStats] = useState(false);
  const [isPerformancePanelOpen, setIsPerformancePanelOpen] = useState(false);
  const [isCinematic, setIsCinematic] = useState(false);
  const [isPhotoMode, setIsPhotoMode] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [beaverMode, setBeaverMode] = useState(false);
  const [beavers, setBeavers] = useState<{ id: string, x: number, y: number, z: number }[]>([]);
  const [gpuLost, setGpuLost] = useState(false);
  const [canvasKey, setCanvasKey] = useState(0);
  const [dictFingerprint, setDictFingerprint] = useState<string | null>(null);
  const [dictStale, setDictStale] = useState(false);
  const [reloadMenuOpen, setReloadMenuOpen] = useState(false);
  const [isReloading, setIsReloading] = useState(false);
  const [reloadStatus, setReloadStatus] = useState<string | null>(null);
  const [reloadMenuPos, setReloadMenuPos] = useState<{ top: number; left: number } | null>(null);
  const reloadBtnRef = useRef<HTMLButtonElement>(null);
  const activeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const intentionalRemountRef = useRef(false);

  const { applyDictionary } = useEntityDictionary();
  const canvasContainerRef = useRef<HTMLDivElement>(null);

  const remountCanvas = useCallback(() => {
    intentionalRemountRef.current = true;
    activeCanvasRef.current = null;
    setGpuLost(false);
    setCanvasKey(k => k + 1);
  }, []);

  const flashReloadStatus = useCallback((msg: string) => {
    setReloadStatus(msg);
    window.setTimeout(() => setReloadStatus(null), 2500);
  }, []);

  useEffect(() => {
    soundManager.setEnabled(soundEnabled);
  }, [soundEnabled]);

  useEffect(() => {
    let lastHovered: HTMLElement | null = null;

    const handleMouseOver = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const btn = target.closest('button') || target.closest('a') || target.closest('[role="button"]');

      if (btn && btn !== lastHovered) {
        soundManager.playHover();
        lastHovered = btn as HTMLElement;
      } else if (!btn) {
        lastHovered = null;
      }
    };

    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('button') || target.closest('a') || target.closest('[role="button"]')) {
        soundManager.playClick();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsCinematic(false);
        setIsPhotoMode(false);
      }
    };

    document.addEventListener('mouseover', handleMouseOver);
    document.addEventListener('click', handleClick);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mouseover', handleMouseOver);
      document.removeEventListener('click', handleClick);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  // High-performance live simulation tick loop with accumulator & sculpt priority
  useEffect(() => {
    let animId: number;
    let lastTime = performance.now();
    let lastRenderTime = performance.now();
    let accumulator = 0;
    let tickCounter = 0;
    let windowStartTime = performance.now();

    const loop = (now: number) => {
      const dt = Math.min(100, now - lastTime);
      lastTime = now;

      if (isSelecting) {
        accumulator = 0;
      } else if (isSimRunning) {
        // Performance-optimal TPS profile:
        // 0.5x=5 TPS, 1x=10 TPS (1 tick / 6 frames @ 60fps), 10x=50 TPS, 100x=100 TPS
        const targetTPS = simSpeed === 100 ? 100 : (simSpeed === 10 ? 50 : (simSpeed === 1 ? 10 : 5));
        const tickStep = 1000 / targetTPS;
        accumulator += dt;

        if (accumulator > tickStep * 3) {
          accumulator = tickStep * 3;
        }

        const maxTicksPerFrame = simSpeed === 100 ? 2 : (simSpeed === 10 ? 2 : 1);
        let ticksExecuted = 0;
        const t0 = performance.now();

        while (accumulator >= tickStep && ticksExecuted < maxTicksPerFrame) {
          if (sim.waterBridge) sim.waterBridge.tick();
          sim.tick();
          accumulator -= tickStep;
          ticksExecuted++;
          tickCounter++;
          if (performance.now() - t0 > 4) {
            break;
          }
        }
        frameMetrics.recordTick(performance.now() - t0);

        if (accumulator > tickStep) {
          accumulator = 0;
        }

        const elapsed = now - windowStartTime;
        if (elapsed >= 500) {
          sim.tpsCurrent = (tickCounter * 1000) / elapsed;
          tickCounter = 0;
          windowStartTime = now;
        }

        const renderInterval = simSpeed === 100 ? 66 : 33;
        if (now - lastRenderTime >= renderInterval) {
          lastRenderTime = now;
          simRenderVersionRef.current++;
        }
      } else {
        frameMetrics.recordTick(0);
      }
      animId = requestAnimationFrame(loop);
    };

    animId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animId);
  }, [isSimRunning, simSpeed, sim, isSelecting]);

  // Simulation keyboard hotkeys — [FIX] W and D moved behind Alt modifier
  useEffect(() => {
    const handleSimKeys = (e: KeyboardEvent) => {
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
      if (e.code === 'Space') {
        e.preventDefault();
        setIsSimRunning(r => !r);
        soundManager.playClick();
      } else if (e.key === '1') {
        setSimSpeed(1);
        soundManager.playClick();
      } else if (e.key === '2') {
        setSimSpeed(10);
        soundManager.playClick();
      } else if (e.key === '3') {
        setSimSpeed(100);
        soundManager.playClick();
      } else if (e.key.toLowerCase() === 'h') {
        setShowHUD(h => !h);
        soundManager.playClick();
      } else if (e.altKey && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        sim.triggerDrought(500);
        soundManager.playClick();
        setSimRenderVersion(v => v + 1);
      } else if (e.altKey && e.key.toLowerCase() === 'w') {
        e.preventDefault();
        setShowWater(w => {
          const next = !w;
          flashReloadStatus(`[WATER ${next ? 'VISIBLE' : 'HIDDEN'}] Mesh drawing ${next ? 'enabled' : 'skipped'}`);
          console.log(`[DEBUG TOGGLE] Water mesh drawing set to: ${next ? 'VISIBLE' : 'HIDDEN'} (terrain, sim, camera unchanged)`);
          return next;
        });
        soundManager.playClick();
      } else if (e.key.toLowerCase() === 'b') {
        window.dispatchEvent(new CustomEvent('start-diagnostic-benchmark'));
        flashReloadStatus('[BENCHMARK] Running 10-second measurement...');
        soundManager.playClick();
      }
    };
    window.addEventListener('keydown', handleSimKeys);
    return () => window.removeEventListener('keydown', handleSimKeys);
  }, [sim, flashReloadStatus]);

  const toggleFullscreen = () => {
    if (!canvasContainerRef.current) return;
    if (!document.fullscreenElement) {
      canvasContainerRef.current.requestFullscreen().catch(err => {
        console.error(`Error attempting to enable full-screen mode: ${err.message}`);
      });
    } else {
      document.exitFullscreen();
    }
  };

  const fetchDictionaryFromServer = useCallback(async () => {
    const res = await fetch('/dictionary');
    if (!res.ok) throw new Error(`GET /dictionary failed: ${res.status}`);
    return res.json() as Promise<{
      dictionary: Record<string, import('./types').EntityStyle>;
      fingerprint: string;
      mtime: number;
    }>;
  }, []);

  const reloadEntitiesOnly = useCallback(async () => {
    setIsReloading(true);
    setReloadMenuOpen(false);
    try {
      const data = await fetchDictionaryFromServer();
      const n = Object.keys(data.dictionary || {}).length;
      applyDictionary(data.dictionary);
      setDictFingerprint(data.fingerprint);
      setDictStale(false);
      flashReloadStatus(`Entities reloaded (${n} custom styles)`);
    } catch (err) {
      console.error('Reload entities failed:', err);
      flashReloadStatus(`Reload failed: ${err instanceof Error ? err.message : 'error'}`);
    } finally {
      setIsReloading(false);
    }
  }, [applyDictionary, fetchDictionaryFromServer, flashReloadStatus]);

  const reloadFullScene = useCallback(() => {
    remountCanvas();
    setReloadMenuOpen(false);
    flashReloadStatus('3D scene remounted');
  }, [flashReloadStatus, remountCanvas]);

  const reloadEverything = useCallback(async () => {
    setIsReloading(true);
    setReloadMenuOpen(false);
    try {
      const data = await fetchDictionaryFromServer();
      const n = Object.keys(data.dictionary || {}).length;
      applyDictionary(data.dictionary);
      setDictFingerprint(data.fingerprint);
      setDictStale(false);
      remountCanvas();
      flashReloadStatus(`Full reload (${n} styles + scene)`);
    } catch (err) {
      console.error('Reload everything failed:', err);
      remountCanvas();
      flashReloadStatus('Scene remounted (dictionary fetch failed)');
    } finally {
      setIsReloading(false);
    }
  }, [applyDictionary, fetchDictionaryFromServer, flashReloadStatus, remountCanvas]);

  const smartReload = useCallback(async () => {
    if (gpuLost) {
      await reloadEverything();
      setGpuLost(false);
      return;
    }
    setIsReloading(true);
    setReloadMenuOpen(false);
    try {
      const data = await fetchDictionaryFromServer();
      if (dictFingerprint !== null && data.fingerprint === dictFingerprint) {
        setDictStale(false);
        flashReloadStatus('Dictionary already current');
        return;
      }
      const n = Object.keys(data.dictionary || {}).length;
      applyDictionary(data.dictionary);
      setDictFingerprint(data.fingerprint);
      setDictStale(false);
      flashReloadStatus(`Entities reloaded (${n} custom styles)`);
    } catch (err) {
      console.error('Smart reload failed:', err);
      flashReloadStatus(`Reload failed: ${err instanceof Error ? err.message : 'error'}`);
    } finally {
      setIsReloading(false);
    }
  }, [gpuLost, dictFingerprint, applyDictionary, fetchDictionaryFromServer, reloadEverything, flashReloadStatus]);

  useEffect(() => {
    let cancelled = false;
    fetchDictionaryFromServer()
      .then((data) => {
        if (!cancelled) {
          setDictFingerprint(data.fingerprint);
          setDictStale(false);
        }
      })
      .catch(() => { /* server may not be up yet */ });
    return () => { cancelled = true; };
  }, [fetchDictionaryFromServer]);

  const dictFingerprintRef = useRef<string | null>(null);
  useEffect(() => {
    dictFingerprintRef.current = dictFingerprint;
  }, [dictFingerprint]);

  useEffect(() => {
    let busy = false;
    const checkAndApply = async () => {
      if (busy) return;
      busy = true;
      try {
        const data = await fetchDictionaryFromServer();
        const prev = dictFingerprintRef.current;
        if (prev !== null && data.fingerprint !== prev) {
          applyDictionary(data.dictionary);
          setDictFingerprint(data.fingerprint);
          setDictStale(false);
          flashReloadStatus('Entities updated from disk');
        } else if (prev === null) {
          setDictFingerprint(data.fingerprint);
          setDictStale(false);
        }
      } catch {
        /* server may be down */
      } finally {
        busy = false;
      }
    };
    const onFocus = () => { void checkAndApply(); };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void checkAndApply();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [applyDictionary, fetchDictionaryFromServer, flashReloadStatus]);

  useEffect(() => {
    const el = canvasContainerRef.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      if (e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        setSliceZ(prev => {
          if (!save?.world) return prev;
          const { numLayers } = getMapInfo(save.world);
          let current = prev === null ? numLayers : prev;
          if (e.deltaY > 0) current -= 1;
          else current += 1;
          const newSlice = Math.max(1, Math.min(numLayers, current));
          return newSlice === numLayers ? null : newSlice;
        });
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.shiftKey && e.key === 'F') {
        e.preventDefault();
        toggleFullscreen();
      }
    };
    el.addEventListener('wheel', handleWheel, { passive: false, capture: true });
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      el.removeEventListener('wheel', handleWheel, { capture: true });
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [save, toggleFullscreen]);

  const waterData = useMemo(() => {
    if (!save?.world) return { columns: [], depths: [] };
    const world = save.world;
    const waterMapNew = (world.Singletons as any).WaterMapNew;
    const waterMap = (world.Singletons as any).WaterMap;

    return {
      columns: waterMapNew?.WaterColumns?.Array?.split(/\s+/).filter((v: string) => v.length > 0) || [],
      depths: waterMap?.WaterDepths?.Array?.split(/\s+/).filter((v: string) => v.length > 0) || []
    };
  }, [save?.world]);

  const soilData = useMemo(() => {
    if (!save?.world) return { moisture: [], contamination: [] };
    const world = save.world;
    const moistureSim = (world.Singletons as any).SoilMoistureSimulator;
    const contamSim = (world.Singletons as any).SoilContaminationSimulator;
    const contamArr = contamSim?.ContaminationLevels?.Array || contamSim?.ContaminationCandidates?.Array;

    return {
      moisture: moistureSim?.MoistureLevels?.Array?.split(/\s+/).filter((v: string) => v.length > 0) || [],
      contamination: contamArr?.split(/\s+/).filter((v: string) => v.length > 0) || []
    };
  }, [save?.world]);
  const [jsonText, setJsonText] = useState('');
  const [isEditingJson, setIsEditingJson] = useState(false);

  const updateEntityComponent = useCallback((entityId: string, componentName: string, path: string[], value: any) => {
    if (!save) return;

    try {
      const updatedWorld = JSON.parse(JSON.stringify(save.world));
      const entity = updatedWorld.Entities.find((e: Entity) => e.Id === entityId);

      if (entity && entity.Components) {
        if (!entity.Components[componentName]) {
          entity.Components[componentName] = {};
        }
        let obj = entity.Components[componentName];

        for (let i = 0; i < path.length - 1; i++) {
          if (!obj[path[i]]) {
            console.warn(`Path does not exist: ${path.slice(0, i + 1).join('.')}`);
            return;
          }
          obj = obj[path[i]];
        }

        const lastKey = path[path.length - 1];
        if (obj && typeof obj === 'object') {
          obj[lastKey] = value;

          setSave({ ...save, world: updatedWorld });
          setSelectedEntity(entity);
          setJsonText(JSON.stringify(updatedWorld, null, 2));
          sim.syncWaterSources(updatedWorld.Entities);
        }
      }
    } catch (err) {
      console.error('Error updating entity component:', err);
      alert('Failed to update entity value. Please check the console for details.');
    }
  }, [save]);

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    setError(null);
    try {
      const loadedSave = await loadTimberFile(file);
      clearCameraPose();
      sim.initFromWorld(loadedSave.world);
      setSave(loadedSave);
      setJsonText(JSON.stringify(loadedSave.world, null, 2));
      setSelectedEntity(null);
      setSimRenderVersion(v => v + 1);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'Failed to load file');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleJsonSave = () => {
    try {
      const newData = JSON.parse(jsonText);
      if (save) {
        setSave({ ...save, world: newData });
        sim.syncWaterSources(newData.Entities || []);
        setIsEditingJson(false);
      }
    } catch (err) {
      alert('Invalid JSON format');
    }
  };

  const handleSave = useCallback(async () => {
    if (!save || isSaving) return;
    setIsSaving(true);
    try {
      console.log('[SAVE] Starting save operation...');
      await new Promise(resolve => setTimeout(resolve, 50));
      sim.syncToWorld(save.world);

      const blob = await saveTimberFile(save);
      console.log('[SAVE] Save completed, downloading...');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `edited_${save.metadata?.MapName || 'save'}.timber`;
      a.click();
      URL.revokeObjectURL(url);
      console.log('[SAVE] Download initiated');
      soundManager.playClick();
    } catch (err) {
      console.error('[SAVE] Error:', err);
      setError('Failed to save file');
      soundManager.playError();
    } finally {
      setIsSaving(false);
    }
  }, [save, isSaving, sim]);

  const handleExportJson = useCallback(() => {
    if (!save) return;
    try {
      sim.syncToWorld(save.world);
      const blob = exportWorldAsJson(save.world);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${save.metadata?.MapName || 'world'}_debug.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError('Failed to export JSON');
    }
  }, [save, sim]);

  const sizeX = save?.world ? getMapInfo(save.world).sizeX : 100;
  const sizeY = save?.world ? getMapInfo(save.world).sizeY : 100;

  return (
    <div className="h-screen bg-[#0a0a0a] text-zinc-100 font-sans selection:bg-emerald-500/30 flex flex-col overflow-hidden">
      {/* Header */}
      {!isPhotoMode && (
        <header className="border-b border-white/5 bg-black/40 backdrop-blur-md shrink-0 z-50">
          <div className="max-w-[1800px] mx-auto px-6 h-16 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-amber-600 rounded-xl flex items-center justify-center shadow-lg shadow-amber-900/30">
                <Flame className="w-6 h-6 text-white" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-base font-black tracking-wider text-white">DROUGHTLINE v3</h1>
                  <span ref={headerClockRef} className="text-[10px] bg-zinc-800 text-amber-300 border border-white/10 px-2 py-0.5 rounded font-mono font-bold">
                    DAY {sim.day} · {sim.formattedTime}
                  </span>
                  <span ref={headerWeatherRef} className="text-[10px] bg-amber-500/20 text-[#ffa028] px-2 py-0.5 rounded font-mono font-bold">
                    {sim.weather.eventName}
                  </span>
                </div>
                <p className="text-[10px] text-zinc-500 font-mono tracking-wider">Voxel Colony World &amp; Weather Engine</p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              {/* Simulation Quick Controls */}
              <div className="flex items-center gap-1.5 bg-zinc-900 border border-white/10 rounded-xl p-1">
                <button
                  onClick={() => {
                    soundManager.playClick();
                    setIsSimRunning(r => !r);
                  }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all ${
                    isSimRunning ? 'bg-amber-500 text-black shadow-md' : 'bg-emerald-600 text-white'
                  }`}
                  title="Toggle Play / Pause (Space)"
                >
                  {isSimRunning ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                  {isSimRunning ? 'PAUSE' : 'PLAY'}
                </button>

                <div className="flex bg-black/40 rounded-lg p-0.5 border border-white/5">
                  {[0.5, 1, 10, 100].map(s => (
                    <button
                      key={s}
                      onClick={() => {
                        soundManager.playClick();
                        setSimSpeed(s);
                      }}
                      className={`px-2 py-1 text-xs font-mono font-bold rounded ${
                        simSpeed === s ? 'bg-[#ffa028] text-black' : 'text-zinc-400 hover:text-white'
                      }`}
                      title={`Run at ${s}x speed`}
                    >
                      {s}×
                    </button>
                  ))}
                </div>

                <button
                  onClick={() => {
                    soundManager.playClick();
                    sim.triggerDrought(480);
                    setSimRenderVersion(v => v + 1);
                  }}
                  className={`px-2.5 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1 transition-all ${
                    sim.weather.event && sim.disasterType === 'drought'
                      ? 'bg-amber-600 text-black shadow-lg animate-pulse'
                      : 'bg-amber-950/60 hover:bg-amber-900 border border-amber-500/30 text-[#ffa028]'
                  }`}
                  title="Trigger 2-day drought (Alt+D key)"
                >
                  <Flame className="w-3.5 h-3.5" />
                  DROUGHT
                </button>

                {/* Quick Badwater Source spawn / inspect */}
                <button
                  onClick={() => {
                    soundManager.playClick();
                    if (!save?.world) return;
                    const existing = save.world.Entities?.find(
                      e => e.Template === 'BadwaterSource' || (e.Components?.WaterSource?.Contamination ?? 0) > 0
                    );
                    if (existing) {
                      setIsPhotoMode(false);
                      setSelectedEntity(existing);
                      setSelectedVoxel(null);
                      const coords = existing.Components?.BlockObject?.Coordinates;
                      if (coords) setJumpTarget({ x: coords.X, y: coords.Y, z: coords.Z });
                    } else {
                      const bx = 195, by = 45;
                      const bz = sim.HGT[by * sim.X + bx] || 12;
                      const badEnt: Entity = {
                        Id: `badwater-spring-${Date.now()}`,
                        Template: 'BadwaterSource',
                        Components: {
                          BlockObject: { Coordinates: { X: bx, Y: by, Z: bz }, Orientation: 'Cw0' },
                          WaterSource: { SpecifiedStrength: 0.4, CurrentStrength: 0.4, Contamination: 1.0 }
                        }
                      };
                      const updated = { ...save.world, Entities: [...(save.world.Entities || []), badEnt] };
                      setSave({ ...save, world: updated });
                      sim.syncWaterSources(updated.Entities);
                      setSelectedEntity(badEnt);
                      setSelectedVoxel(null);
                      setJumpTarget({ x: bx, y: by, z: bz });
                    }
                  }}
                  className="px-2.5 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1 bg-orange-950/70 hover:bg-orange-900 border border-orange-500/40 text-orange-400 transition-all"
                  title="Spawn or inspect Badwater Source"
                >
                  <Biohazard className="w-3.5 h-3.5" />
                  BADWATER
                </button>

                {/* Quick Water Source flow rate & selector */}
                <button
                  onClick={() => {
                    soundManager.playSelect();
                    const spring = save?.world?.Entities?.find(e => e.Template === 'WaterSource' || e.Components?.WaterSource);
                    if (spring) {
                      setIsPhotoMode(false);
                      setSelectedEntity(spring);
                      setSelectedVoxel(null);
                      const coords = spring.Components?.BlockObject?.Coordinates;
                      if (coords) {
                        setJumpTarget({ x: coords.X, y: coords.Y, z: coords.Z });
                      }
                    }
                  }}
                  className="px-2.5 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 bg-sky-950/70 hover:bg-sky-900 border border-sky-500/40 text-sky-400 transition-all hover:scale-105"
                  title="Click to view & edit Water Source flow specs"
                >
                  <Droplet className="w-3.5 h-3.5 text-sky-400" />
                  <span className="font-mono">
                    Spring: {((save?.world?.Entities?.find(e => e.Template === 'WaterSource' || e.Components?.WaterSource)?.Components?.WaterSource?.CurrentStrength ?? 0.5)).toFixed(1)} L/t
                  </span>
                </button>

                <button
                  onClick={() => {
                    soundManager.playClick();
                    setShowHUD(h => !h);
                  }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all ${
                    showHUD ? 'bg-indigo-600 text-white' : 'text-zinc-400 hover:text-white hover:bg-white/5'
                  }`}
                  title="Toggle Telemetry HUD (H key)"
                >
                  <Activity className="w-3.5 h-3.5" />
                  HUD [H]
                </button>

                <HeaderFpsBadge />
              </div>

              {save && (
                <div className="flex bg-zinc-900 rounded-lg p-1 border border-white/10">
                  <button
                    onClick={() => setView('preview')}
                    className={cn(
                      "px-3 py-1.5 rounded-md text-sm font-semibold transition-all flex items-center gap-1.5",
                      view === 'preview' ? "bg-zinc-700 text-white shadow-sm" : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
                    )}
                  >
                    <MapIcon className="w-4 h-4" /> Map
                  </button>
                  <button
                    onClick={() => {
                      if (!editingTemplate) setEditingTemplate('Path');
                      setShowModelEditor(!showModelEditor);
                    }}
                    className={cn(
                      "px-3 py-1.5 rounded-md text-sm font-semibold transition-all flex items-center gap-1.5",
                      showModelEditor ? "bg-zinc-700 text-white shadow-sm" : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
                    )}
                  >
                    <Layers className="w-4 h-4" /> Models
                  </button>
                  <button
                    onClick={() => {
                      sim.syncToWorld(save.world);
                      setView('json');
                    }}
                    className={cn(
                      "px-3 py-1.5 rounded-md text-sm font-semibold transition-all flex items-center gap-1.5",
                      view === 'json' ? "bg-zinc-700 text-white shadow-sm" : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
                    )}
                  >
                    <Code className="w-4 h-4" /> JSON
                  </button>
                </div>
              )}

              <button
                onClick={() => {
                  soundManager.playClick();
                  sim.generateDefaultWorld();
                  setSave(createSaveFromSim(sim));
                  setSimRenderVersion(v => v + 1);
                }}
                className="bg-zinc-800 hover:bg-zinc-700 text-zinc-300 px-3 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 border border-white/10"
                title="Reset / Generate fresh colony map"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                New Colony
              </button>

              <label
                onMouseEnter={() => soundManager.playHover()}
                onClick={() => soundManager.playClick()}
                className="cursor-pointer bg-zinc-800 hover:bg-zinc-700 border border-white/10 text-white px-3 py-2 rounded-xl text-xs font-medium transition-all flex items-center gap-1.5 active:scale-95"
                title="Upload custom .timber save file"
              >
                <Upload className="w-3.5 h-3.5 text-emerald-400" />
                Upload
                <input type="file" accept=".timber" onChange={handleFileUpload} className="hidden" />
              </label>

              {save && (
                <>
                  <button
                    onClick={() => {
                      if (!isSaving) {
                        soundManager.playClick();
                        handleSave();
                      }
                    }}
                    disabled={isSaving}
                    onMouseEnter={() => !isSaving && soundManager.playHover()}
                    className={cn(
                      "bg-zinc-100 hover:bg-white text-black px-5 py-2 rounded-xl text-sm font-medium transition-all flex items-center gap-2 active:scale-95",
                      isSaving && "opacity-75 cursor-not-allowed active:scale-100"
                    )}
                  >
                    {isSaving ? (
                      <>
                        <div className="w-4 h-4 border-2 border-black/20 border-t-black rounded-full animate-spin" />
                        Saving...
                      </>
                    ) : (
                      <>
                        <Download className="w-4 h-4" /> Download
                      </>
                    )}
                  </button>
                  <button
                    onClick={() => {
                      soundManager.playClick();
                      handleExportJson();
                    }}
                    onMouseEnter={() => soundManager.playHover()}
                    className="bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-400 px-5 py-2 rounded-xl text-sm font-medium transition-all flex items-center gap-2 active:scale-95"
                    title="Export as plain JSON (for debugging)"
                  >
                    <FileJson className="w-4 h-4" /> Export JSON
                  </button>
                </>
              )}
            </div>
          </div>
        </header>
      )}

      <main className="max-w-[1800px] mx-auto px-6 py-8 flex-1 flex flex-col min-h-0 w-full">
        <AnimatePresence mode="wait">
          {!save && !loading && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="flex flex-col items-center justify-center flex-1 text-center"
            >
              <div className="w-24 h-24 bg-zinc-900 rounded-3xl flex items-center justify-center mb-8 border border-white/5 shadow-2xl">
                <FileJson className="w-12 h-12 text-zinc-700" />
              </div>
              <h2 className="text-3xl font-light tracking-tight mb-4">Ready to modify your colony?</h2>
              <p className="text-zinc-500 max-w-md mx-auto mb-10 leading-relaxed">
                Upload a Timberborn save file to preview the terrain, inspect entities, and edit the raw world data.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-3xl w-full">
                {[
                  { icon: MapIcon, title: "3D Preview", desc: "Visualize the voxel terrain and entity locations." },
                  { icon: Code, title: "Raw Editing", desc: "Modify inventory, growth progress, and more." },
                  { icon: Info, title: "Metadata", desc: "View map name, play time, and version info." }
                ].map((feature, i) => (
                  <div key={i} className="bg-zinc-900/50 border border-white/5 p-6 rounded-2xl text-left">
                    <feature.icon className="w-6 h-6 text-emerald-500 mb-4" />
                    <h3 className="font-medium mb-2">{feature.title}</h3>
                    <p className="text-sm text-zinc-500 leading-relaxed">{feature.desc}</p>
                  </div>
                ))}
              </div>
            </motion.div>
          )}

          {loading && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex flex-col items-center justify-center py-48"
            >
              <div className="w-12 h-12 border-4 border-emerald-500/20 border-t-emerald-500 rounded-full animate-spin mb-6" />
              <p className="text-zinc-400 font-mono text-sm animate-pulse">CHEWING ON BEAVER DATA...</p>
            </motion.div>
          )}

          {error && (
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              className="max-w-md mx-auto bg-red-500/10 border border-red-500/20 p-6 rounded-2xl flex items-start gap-4"
            >
              <AlertCircle className="w-6 h-6 text-red-500 shrink-0" />
              <div>
                <h3 className="font-medium text-red-500 mb-1">Upload Failed</h3>
                <p className="text-sm text-red-400/80">{error}</p>
              </div>
            </motion.div>
          )}

          {save && !loading && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className={cn(
                "grid gap-8 flex-1 min-h-0",
                view === 'preview' ? "grid-cols-1" : "grid-cols-1 lg:grid-cols-4"
              )}
            >
              {/* Sidebar Info - Hidden in Preview Mode */}
              {view !== 'preview' && (
                <div className="lg:col-span-1 space-y-6">
                  <div className="bg-zinc-900 rounded-2xl border border-white/5 overflow-hidden">
                    {save.thumbnail ? (
                      <img src={save.thumbnail} alt="Save Thumbnail" className="w-full aspect-video object-cover" referrerPolicy="no-referrer" />
                    ) : (
                      <div className="w-full aspect-video bg-zinc-800 flex items-center justify-center">
                        <MapIcon className="w-12 h-12 text-zinc-700" />
                      </div>
                    )}
                    <div className="p-5 space-y-4">
                      <div>
                        <h3 className="text-xs font-mono uppercase tracking-widest text-zinc-500 mb-1">Map Name</h3>
                        <p className="font-medium">{save.metadata?.MapName || 'Unknown'}</p>
                      </div>
                      <div>
                        <h3 className="text-xs font-mono uppercase tracking-widest text-zinc-500 mb-1">Play Time</h3>
                        <p className="font-medium">{save.metadata?.PlayTime || 'Unknown'}</p>
                      </div>
                      <div>
                        <h3 className="text-xs font-mono uppercase tracking-widest text-zinc-500 mb-1">Version</h3>
                        <p className="font-medium text-sm text-zinc-400">{save.version || 'Unknown'}</p>
                      </div>
                    </div>
                  </div>

                  <div className="bg-emerald-500/5 border border-emerald-500/10 p-5 rounded-2xl">
                    <div className="flex items-center gap-3 mb-3">
                      <Info className="w-5 h-5 text-emerald-500" />
                      <h3 className="font-medium text-emerald-500">Editor Tip</h3>
                    </div>
                    <p className="text-sm text-emerald-400/70 leading-relaxed">
                      Use the JSON tab to modify specific values like resource counts or building states. Changes are applied instantly to the preview.
                    </p>
                  </div>
                </div>
              )}

              {/* Main View */}
              <div className={cn(
                "bg-zinc-900 rounded-3xl border border-white/5 overflow-hidden flex flex-col shadow-2xl min-h-0",
                view === 'preview' ? "col-span-1" : "lg:col-span-3"
              )}>
                {view === 'preview' ? (
                  <div className="flex-1 relative" ref={canvasContainerRef}>
                    <Canvas
                      key={canvasKey}
                      onCreated={({ gl }) => {
                        const canvas = gl.domElement as HTMLCanvasElement;
                        activeCanvasRef.current = canvas;
                        intentionalRemountRef.current = false;
                        setGpuLost(false);

                        canvas.addEventListener('webglcontextlost', (e) => {
                          e.preventDefault();
                          if (intentionalRemountRef.current) return;
                          if (activeCanvasRef.current !== canvas) return;
                          setGpuLost(true);
                        });
                        canvas.addEventListener('webglcontextrestored', () => {
                          if (activeCanvasRef.current !== canvas) return;
                          setGpuLost(false);
                        });
                      }}
                      frameloop="always"
                      shadows={!isLowQuality ? { type: 1 } : false}
                      gl={{
                        antialias: !isLowQuality,
                        powerPreference: 'high-performance',
                        stencil: false,
                        depth: true
                      }}
                      dpr={isLowQuality ? 1 : [1, 2]}
                    >
                      <PerspectiveCamera makeDefault position={[sizeX, Math.max(sizeX, sizeY), sizeY]} fov={45} />
                      <axesHelper args={[200]} />
                      {isCinematic && <Sky sunPosition={[100, 20, 100]} turbidity={0.1} rayleigh={0.5} />}
                      <DayNightLighting sim={sim} isCinematic={isCinematic} />
                      <Environment preset={isCinematic ? "sunset" : "city"} environmentIntensity={0.25} />
                      <Stars radius={1000} depth={500} count={10000} factor={7} saturation={0} fade speed={1} />

                      <React.Suspense fallback={null}>
                        {(() => {
                          const { sizeX, sizeY, numLayers } = getMapInfo(save.world);
                          return (
                            <>
                              <CameraController
                                sizeX={sizeX}
                                sizeY={sizeY}
                                world={save.world}
                                jumpTarget={jumpTarget}
                                isCinematic={isCinematic}
                                mode={currentTool === 'resize' ? 'resize' : 'normal'}
                              />
                              <FrameMetricsTracker showWater={showWater} isSimRunning={isSimRunning} />
                              {showStats && <Stats parent={canvasContainerRef} className="!absolute !top-auto !bottom-4 !left-4" />}
                              {showStats && <StatsTracker />}
                              {showTerrain && (
                                <TerrainPreview
                                  world={save.world}
                                  sizeX={sizeX}
                                  sizeY={sizeY}
                                  numLayers={numLayers}
                                  sliceZ={sliceZ}
                                  showWireframe={showWireframe}
                                  simSurface={sim.SURFACE}
                                  simSoil={sim.SOIL}
                                  simContam={sim.SOIL_CONTAM}
                                  simVersion={simRenderVersionRef.current}
                                  raycastEnabled={true}
                                  onPointerDown={handlePointerDown}
                                  onPointerMove={handlePointerMove}
                                  onPointerUp={handlePointerUp}
                                  onPointerHover={(v) => {
                                    if (currentTool === 'select') {
                                      setHoveredVoxel(v);
                                    } else {
                                      setHoveredVoxel(null);
                                    }
                                  }}
                                  onTerrainClick={(v, button, normal) => {
                                    // [FIX] Explicit tool check — replaces fragile isSelecting guard
                                    if (currentTool !== 'select') return;
                                    if (button === 2) {
                                      setSelectedEntity(null);
                                      setSelectedSimCreatureId(null);
                                      setSelectedSimPlantId(null);
                                      setSelectedVoxel(null);
                                    } else {
                                      soundManager.playSelect();
                                      setSelectedVoxel(v);
                                      setSelectedEntity(null);
                                      setSelectedSimCreatureId(null);
                                      setSelectedSimPlantId(null);
                                    }
                                  }}
                                />
                              )}
                              {isSelecting && selectionStart && selectionEnd && (
                                <SelectionPreview
                                  start={selectionStart}
                                  end={selectionEnd}
                                  color={
                                    currentTool === 'terrain' ? (terrainSubTool === 'add' ? '#10b981' : '#ef4444') :
                                    currentTool === 'cut_zone' ? (cutSubTool === 'add' ? '#fbbf24' : '#ef4444') :
                                    currentTool === 'plant_zone' ? (plantSubTool === 'add' ? '#4ade80' : '#ef4444') :
                                    '#3b82f6'
                                  }
                                />
                              )}
                              {showEntities && (
                                <>
                                  <EntitiesPreview
                                    world={save.world}
                                    sizeX={sizeX}
                                    sizeY={sizeY}
                                    sliceZ={sliceZ}
                                    showOrigin={showOrigin}
                                    showWireframe={showWireframe}
                                    selectedEntity={selectedEntity}
                                    hoveredEntity={hoveredEntity}
                                    raycastEnabled={currentTool === 'select'}
                                    onEntityClick={(e, button) => {
                                      if (currentTool !== 'select') return;
                                      if (button === 2) {
                                        setSelectedEntity(null);
                                        setSelectedSimCreatureId(null);
                                        setSelectedSimPlantId(null);
                                        setSelectedVoxel(null);
                                      } else {
                                        soundManager.playSelect();
                                        setSelectedEntity(e);
                                        setSelectedSimCreatureId(null);
                                        setSelectedSimPlantId(null);
                                        setSelectedVoxel(null);
                                        if (e.Template) {
                                          setEditingTemplate(e.Template);
                                        }
                                      }
                                    }}
                                    onEntityHover={(e) => {
                                      if (currentTool === 'select') {
                                        setHoveredEntity(e);
                                      } else {
                                        setHoveredEntity(null);
                                      }
                                    }}
                                  />
                                  <SimCreaturesPreview
                                    sim={sim}
                                    simVersion={simRenderVersionRef.current}
                                    raycastEnabled={currentTool === 'select'}
                                    selectedCreatureId={selectedSimCreatureId}
                                    selectedPlantId={selectedSimPlantId}
                                    onCreatureClick={(creatureId, button) => {
                                      if (currentTool !== 'select') return;
                                      if (button === 2) {
                                        setSelectedSimCreatureId(null);
                                        setSelectedSimPlantId(null);
                                      } else {
                                        soundManager.playSelect();
                                        setSelectedSimCreatureId(creatureId);
                                        setSelectedSimPlantId(null);
                                        setSelectedEntity(null);
                                        setSelectedVoxel(null);
                                      }
                                    }}
                                    onPlantClick={(plantId, button) => {
                                      if (currentTool !== 'select') return;
                                      if (button === 2) {
                                        setSelectedSimCreatureId(null);
                                        setSelectedSimPlantId(null);
                                      } else {
                                        soundManager.playSelect();
                                        setSelectedSimPlantId(plantId);
                                        setSelectedSimCreatureId(null);
                                        setSelectedEntity(null);
                                        setSelectedVoxel(null);
                                      }
                                    }}
                                  />
                                </>
                              )}
                              {showWater && (
                                <WaterPreview
                                  world={save.world}
                                  sizeX={sizeX}
                                  sizeY={sizeY}
                                  sliceZ={sliceZ}
                                  isLowQuality={isLowQuality}
                                  showWireframe={showWireframe}
                                  showShallowWater={showShallowWater}
                                  displayMode={waterDisplayMode}
                                  simWater={sim.WATER}
                                  simHgt={sim.HGT}
                                  simVersion={simRenderVersionRef.current}
                                  raycastEnabled={false}
                                  simWaterMulti={waterBridgeReady && sim.waterBridge?.ready ? sim.waterBridge.waterMulti : sim.water.waterMulti}
                                  maxWaterLevels={(sim as any).water?.maxWaterLevels ?? 3}
                                  onWaterClick={(v, button) => {
                                    if (button === 2) {
                                      setSelectedEntity(null);
                                      setSelectedSimCreatureId(null);
                                      setSelectedSimPlantId(null);
                                      setSelectedVoxel(null);
                                    } else {
                                      soundManager.playSelect();
                                      setSelectedVoxel(v);
                                      setSelectedEntity(null);
                                      setSelectedSimCreatureId(null);
                                      setSelectedSimPlantId(null);
                                    }
                                  }}
                                />
                              )}
                              {showHoles && showTerrain && <HolePreview world={save.world} sizeX={sizeX} sizeY={sizeY} sliceZ={sliceZ} showWireframe={showWireframe} />}
                              <MapOverlayPreview
                                world={save.world}
                                sizeX={sizeX}
                                sizeY={sizeY}
                                sliceZ={sliceZ}
                                showCuttingArea={currentTool === 'cut_zone'}
                                showPlantingArea={currentTool === 'plant_zone'}
                              />
                              {selectedVoxel && <VoxelHighlightPreview voxel={selectedVoxel} />}
                              {currentTool === 'select' && hoveredVoxel && !selectedVoxel && (
                                <VoxelHighlightPreview voxel={hoveredVoxel} />
                              )}
                            </>
                          );
                        })()}
                      </React.Suspense>
                    </Canvas>

                    {/* Leaf component: direct DOM updates via ref (zero React re-renders) */}
                    <RenderStatsOverlay visible={showStats && !isPhotoMode} />

                    {/* Exit Photo Mode Hint */}
                    {isPhotoMode && (
                      <div className="absolute top-8 left-1/2 -translate-x-1/2 bg-black/40 backdrop-blur-md px-6 py-2 rounded-full border border-white/10 text-xs text-zinc-400 animate-pulse z-50">
                        Press <span className="text-white font-bold">ESC</span> to exit Photo Mode
                      </div>
                    )}

                    {sliceZ !== null && save?.world && !isPhotoMode && (
                      <div className="absolute top-4 left-4 bg-slate-900/80 backdrop-blur-sm text-white px-3 py-1.5 rounded-lg border border-slate-700/50 text-sm font-mono shadow-lg flex items-center gap-2">
                        <Layers className="w-4 h-4 text-indigo-400" />
                        <span>Z-Slice: {sliceZ} / {getMapInfo(save.world).numLayers}</span>
                      </div>
                    )}

                    {currentTool === 'resize' && save?.world && (
                      <ResizeOverlay
                        world={save.world}
                        onApply={(newWorld) => {
                          setSave({ ...save, world: newWorld });
                          setCurrentTool('select');
                        }}
                        onCancel={() => setCurrentTool('select')}
                      />
                    )}

                    {/* Tool Palette (Bottom) */}
                    {!isPhotoMode && (
                      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex flex-col items-center gap-3 z-20">
                        <div className="bg-amber-500/10 border border-amber-500/20 backdrop-blur-md px-4 py-1.5 rounded-full flex items-center gap-2 text-amber-400/80">
                          <AlertCircle className="w-3.5 h-3.5" />
                          <span className="text-[10px] font-medium tracking-wide">Note: The game will delete any floating terrain or entities upon loading.</span>
                        </div>

                        <div className="flex items-center gap-2 bg-zinc-900/90 backdrop-blur-md border border-white/10 p-2 rounded-2xl shadow-2xl">
                          <button
                            onClick={() => {
                              soundManager.playClick();
                              setCurrentTool('select');
                            }}
                            onMouseEnter={() => soundManager.playHover()}
                            className={cn(
                              "p-3 rounded-xl transition-all flex flex-col items-center gap-1 min-w-[72px]",
                              currentTool === 'select' ? "bg-emerald-500/20 text-emerald-400" : "text-zinc-400 hover:bg-white/5 hover:text-white"
                            )}
                            title="Select"
                          >
                            <MousePointer2 className="w-5 h-5" />
                            <span className="text-[10px] font-medium">Select</span>
                          </button>
                          <div className="w-px h-8 bg-white/10 mx-1" />

                          <div className="relative group">
                            <button
                              onClick={() => {
                                soundManager.playClick();
                                setCurrentTool('terrain');
                              }}
                              onMouseEnter={() => soundManager.playHover()}
                              className={cn(
                                "p-3 rounded-xl transition-all flex flex-col items-center gap-1 min-w-[72px]",
                                currentTool === 'terrain' ? "bg-amber-500/20 text-amber-400" : "text-zinc-400 hover:bg-white/5 hover:text-white"
                              )}
                              title="Terrain Tool"
                            >
                              <Mountain className="w-5 h-5" />
                              <span className="text-[10px] font-medium">Terrain</span>
                            </button>

                            {currentTool === 'terrain' && (
                              <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 flex gap-1 bg-zinc-900/95 border border-white/10 p-1.5 rounded-xl shadow-xl">
                                <button
                                  onClick={() => setTerrainSubTool('add')}
                                  className={cn(
                                    "px-3 py-1.5 rounded-lg text-[10px] font-bold transition-all",
                                    terrainSubTool === 'add' ? "bg-emerald-500 text-white" : "text-zinc-400 hover:bg-white/5"
                                  )}
                                >
                                  ADD
                                </button>
                                <button
                                  onClick={() => setTerrainSubTool('remove')}
                                  className={cn(
                                    "px-3 py-1.5 rounded-lg text-[10px] font-bold transition-all",
                                    terrainSubTool === 'remove' ? "bg-rose-500 text-white" : "text-zinc-400 hover:bg-white/5"
                                  )}
                                >
                                  DEL
                                </button>
                              </div>
                            )}
                          </div>

                          <div className="relative group">
                            <button
                              onClick={() => {
                                soundManager.playClick();
                                setCurrentTool('cut_zone');
                              }}
                              onMouseEnter={() => soundManager.playHover()}
                              className={cn(
                                "p-3 rounded-xl transition-all flex flex-col items-center gap-1 min-w-[72px]",
                                currentTool === 'cut_zone' ? "bg-amber-500/20 text-amber-400" : "text-zinc-400 hover:bg-white/5 hover:text-white"
                              )}
                              title="Edit Cutting Zone"
                            >
                              <Scissors className="w-5 h-5" />
                              <span className="text-[10px] font-medium">Cut Zone</span>
                            </button>
                            {currentTool === 'cut_zone' && (
                              <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 flex gap-1 bg-zinc-900/95 border border-white/10 p-1.5 rounded-xl shadow-xl">
                                <button
                                  onClick={() => setCutSubTool('add')}
                                  className={cn(
                                    "px-3 py-1.5 rounded-lg text-[10px] font-bold transition-all",
                                    cutSubTool === 'add' ? "bg-amber-500 text-white" : "text-zinc-400 hover:bg-white/5"
                                  )}
                                >
                                  ADD
                                </button>
                                <button
                                  onClick={() => setCutSubTool('remove')}
                                  className={cn(
                                    "px-3 py-1.5 rounded-lg text-[10px] font-bold transition-all",
                                    cutSubTool === 'remove' ? "bg-rose-500 text-white" : "text-zinc-400 hover:bg-white/5"
                                  )}
                                >
                                  DEL
                                </button>
                              </div>
                            )}
                          </div>

                          <div className="relative group">
                            <button
                              onClick={() => {
                                soundManager.playClick();
                                setCurrentTool('plant_zone');
                              }}
                              onMouseEnter={() => soundManager.playHover()}
                              className={cn(
                                "p-3 rounded-xl transition-all flex flex-col items-center gap-1 min-w-[72px]",
                                currentTool === 'plant_zone' ? "bg-emerald-500/20 text-emerald-400" : "text-zinc-400 hover:bg-white/5 hover:text-white"
                              )}
                              title="Edit Planting Zone"
                            >
                              <Sprout className="w-5 h-5" />
                              <span className="text-[10px] font-medium">Plant Zone</span>
                            </button>
                            {currentTool === 'plant_zone' && (
                              <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 flex gap-1 bg-zinc-900/95 border border-white/10 p-1.5 rounded-xl shadow-xl">
                                <button
                                  onClick={() => setPlantSubTool('add')}
                                  className={cn(
                                    "px-3 py-1.5 rounded-lg text-[10px] font-bold transition-all",
                                    plantSubTool === 'add' ? "bg-emerald-500 text-white" : "text-zinc-400 hover:bg-white/5"
                                  )}
                                >
                                  ADD
                                </button>
                                <button
                                  onClick={() => setPlantSubTool('remove')}
                                  className={cn(
                                    "px-3 py-1.5 rounded-lg text-[10px] font-bold transition-all",
                                    plantSubTool === 'remove' ? "bg-rose-500 text-white" : "text-zinc-400 hover:bg-white/5"
                                  )}
                                >
                                  DEL
                                </button>
                              </div>
                            )}
                          </div>
                          <div className="w-px h-8 bg-white/10 mx-1" />
                          <button
                            onClick={() => {
                              soundManager.playClick();
                              setCurrentTool('resize');
                            }}
                            onMouseEnter={() => soundManager.playHover()}
                            className={cn(
                              "p-3 rounded-xl transition-all flex flex-col items-center gap-1 min-w-[72px]",
                              currentTool === 'resize' ? "bg-blue-500/20 text-blue-400" : "text-zinc-400 hover:bg-white/5 hover:text-white"
                            )}
                            title="Resize Map"
                          >
                            <Maximize className="w-5 h-5" />
                            <span className="text-[10px] font-medium">Resize</span>
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Visibility Toggles (Left) */}
                    {!isPhotoMode && (
                      <div className="absolute top-1/2 -translate-y-1/2 left-6 flex flex-col gap-2 z-20 bg-zinc-900/90 backdrop-blur-md border border-white/10 p-2 rounded-2xl shadow-2xl max-h-[80vh] overflow-y-auto custom-scrollbar">
                        {[
                          { label: 'Terrain', state: showTerrain, setter: setShowTerrain, color: 'text-emerald-400', icon: Mountain },
                          { label: 'Water', state: showWater, setter: setShowWater, color: 'text-blue-400', icon: Waves },
                          {
                            label: 'Water: Base',
                            state: waterDisplayMode === 'base',
                            action: () => setWaterDisplayMode('base'),
                                      color: 'text-blue-400',
                                      icon: Droplet
                          },
                          {
                            label: 'Water: Depth',
                            state: waterDisplayMode === 'depth',
                            action: () => setWaterDisplayMode('depth'),
                                      color: 'text-sky-400',
                                      icon: Droplet
                          },
                          {
                            label: 'Water: Transparent',
                            state: waterDisplayMode === 'transparent',
                            action: () => setWaterDisplayMode('transparent'),
                                      color: 'text-cyan-400',
                                      icon: Eye
                          },
                          { label: 'Entities', state: showEntities, setter: setShowEntities, color: 'text-amber-400', icon: Box },
                          { label: 'Sounds', state: soundEnabled, setter: setSoundEnabled, icon: soundEnabled ? Volume2 : VolumeX, color: 'text-purple-400' },
                          { label: 'Stats', state: showStats, setter: setShowStats, color: 'text-rose-400', icon: Activity },
                          { divider: true },
                          { label: 'Low Quality', state: isLowQuality, setter: setIsLowQuality, icon: isLowQuality ? Zap : ZapOff, color: 'text-amber-500' },
                          { label: 'Origin Points', state: showOrigin, setter: setShowOrigin, color: 'text-zinc-300', icon: Crosshair },
                          { label: 'Wireframe', state: showWireframe, setter: setShowWireframe, color: 'text-zinc-300', icon: Grid },
                          { label: 'Hole Detection', state: showHoles, setter: setShowHoles, color: 'text-amber-500', icon: Search },
                          { divider: true },
                          { label: 'Fullscreen', action: toggleFullscreen, icon: Maximize, color: 'text-zinc-400' }
                        ].map((item, idx) => {
                          if ((item as any).divider) {
                            return <div key={`div-${idx}`} className="w-8 h-px bg-white/10 mx-auto my-1" />;
                          }
                          return (
                            <button
                              key={item.label}
                              onClick={() => {
                                soundManager.playClick();
                                if ((item as any).action) (item as any).action();
                                else if ((item as any).setter) (item as any).setter(!(item as any).state);
                              }}
                              onMouseEnter={() => soundManager.playHover()}
                              className={cn(
                                "p-3 rounded-xl transition-all relative group",
                                (item as any).state !== undefined && (item as any).state ? "bg-white/10 " + item.color : "text-zinc-500 hover:bg-white/5 hover:text-zinc-300",
                                (item as any).state === undefined && item.color
                              )}
                            >
                              {item.icon && <item.icon className="w-5 h-5" />}
                              <div className="absolute left-full ml-4 top-1/2 -translate-y-1/2 px-2 py-1 bg-black/80 text-white text-xs rounded opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap transition-opacity flex items-center gap-2">
                                {item.label}
                                {(item as any).state !== undefined && (
                                  <span className={cn("w-2 h-2 rounded-full", (item as any).state ? "bg-emerald-500" : "bg-zinc-600")} />
                                )}
                              </div>
                            </button>
                          );
                        })}
                        <div className="w-8 h-px bg-white/10 mx-auto my-1" />
                        <button
                          ref={reloadBtnRef}
                          onClick={() => {
                            soundManager.playClick();
                            smartReload();
                          }}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            soundManager.playClick();
                            const rect = reloadBtnRef.current?.getBoundingClientRect();
                            if (rect) {
                              setReloadMenuPos({ top: rect.top, left: rect.right + 8 });
                            }
                            setReloadMenuOpen((o) => !o);
                          }}
                          onMouseEnter={() => soundManager.playHover()}
                          disabled={isReloading}
                          className={cn(
                            "p-3 rounded-xl transition-all relative group",
                            gpuLost
                              ? "bg-red-600/30 text-red-400"
                              : dictStale
                                ? "bg-amber-500/20 text-amber-400"
                                : "text-zinc-500 hover:bg-white/5 hover:text-zinc-300",
                            isReloading && "opacity-50 cursor-wait"
                          )}
                          title="LMB: smart reload — RMB: menu"
                        >
                          <RefreshCw className={cn("w-5 h-5", isReloading && "animate-spin")} />
                          {(dictStale || gpuLost) && (
                            <span className={cn(
                              "absolute top-1.5 right-1.5 w-2 h-2 rounded-full",
                              gpuLost ? "bg-red-500" : "bg-amber-400"
                            )} />
                          )}
                        </button>
                      </div>
                    )}

                    {/* Fixed RMB menu */}
                    {reloadMenuOpen && reloadMenuPos && (
                      <div
                        className="fixed z-[200] min-w-[200px] bg-zinc-900 border border-white/15 rounded-xl shadow-2xl py-1 text-xs"
                        style={{ top: reloadMenuPos.top, left: reloadMenuPos.left }}
                        onMouseLeave={() => setReloadMenuOpen(false)}
                      >
                        <button
                          className="w-full text-left px-3 py-2.5 hover:bg-white/10 text-zinc-200"
                          onClick={() => { soundManager.playClick(); reloadEntitiesOnly(); }}
                        >
                          Reload entities only
                        </button>
                        <button
                          className="w-full text-left px-3 py-2.5 hover:bg-white/10 text-zinc-200"
                          onClick={() => { soundManager.playClick(); reloadFullScene(); }}
                        >
                          Reload full scene
                        </button>
                        <button
                          className="w-full text-left px-3 py-2.5 hover:bg-white/10 text-zinc-200"
                          onClick={() => { soundManager.playClick(); reloadEverything(); }}
                        >
                          Reload everything
                        </button>
                        <button
                          className="w-full text-left px-3 py-2 hover:bg-white/5 text-zinc-500 border-t border-white/5"
                          onClick={() => setReloadMenuOpen(false)}
                        >
                          Cancel
                        </button>
                      </div>
                    )}

                    {reloadStatus && (
                      <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[200] px-4 py-2 rounded-xl bg-zinc-900/95 border border-white/10 text-xs text-zinc-200 shadow-xl pointer-events-none">
                        {reloadStatus}
                      </div>
                    )}

                    <AnimatePresence>
                      {(selectedEntity || selectedVoxel || selectedSimCreatureId !== null || selectedSimPlantId !== null) && !isPhotoMode && (() => {
                        const inspectedCreature = selectedSimCreatureId !== null
                          ? sim.creatures.find(c => c.id === selectedSimCreatureId) ?? null
                          : null;
                        const inspectedPlant = selectedSimPlantId !== null
                          ? sim.plants.find(p => p.id === selectedSimPlantId) ?? null
                          : null;
                        const inspectorKey = selectedEntity?.Id
                          || (selectedSimCreatureId !== null ? `cre-${selectedSimCreatureId}` : null)
                          || (selectedSimPlantId !== null ? `plt-${selectedSimPlantId}` : null)
                          || `voxel-${selectedVoxel?.x}-${selectedVoxel?.y}-${selectedVoxel?.z}`;
                        return (
                        <motion.div
                          key={inspectorKey}
                          initial={{ opacity: 0, x: 20 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={{ opacity: 0, x: 20 }}
                          className="absolute top-6 right-6 bottom-6 w-80 bg-zinc-900/95 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl overflow-hidden flex flex-col z-10"
                          onContextMenu={(e) => {
                            if (e.target === e.currentTarget) {
                              e.preventDefault();
                              setSelectedEntity(null);
                              setSelectedSimCreatureId(null);
                              setSelectedSimPlantId(null);
                              setSelectedVoxel(null);
                            }
                          }}
                        >
                          <div className="p-4 border-b border-white/5 flex flex-col gap-3 bg-emerald-600/10">
                            <div className="flex items-center justify-between">
                              <div>
                                <h3 className="text-sm font-bold text-emerald-400">
                                  {selectedEntity
                                    ? 'Entity Inspector'
                                    : inspectedCreature
                                      ? 'Creature Entity'
                                      : inspectedPlant
                                        ? 'Plant Entity'
                                        : 'Terrain Inspector'}
                                </h3>
                                <p className="text-[11px] font-mono text-emerald-300/80 uppercase tracking-tight truncate w-44">
                                  {selectedEntity
                                    ? selectedEntity.Id
                                    : inspectedCreature
                                      ? `CRE #${inspectedCreature.id} · ${inspectedCreature.alive ? 'ALIVE' : 'DEAD'}`
                                      : inspectedPlant
                                        ? `PLT #${inspectedPlant.id} · ${sim.species[inspectedPlant.sp]?.name || 'flora'}`
                                        : `Voxel at ${selectedVoxel?.x}, ${selectedVoxel?.y}, ${selectedVoxel?.z}`}
                                </p>
                              </div>
                              <div className="flex gap-1">
                                {selectedEntity && (
                                  <>
                                    <button
                                      onClick={() => setIsEditingEntity(!isEditingEntity)}
                                      className={cn(
                                        "p-1.5 rounded-lg transition-colors",
                                        !isEditingEntity
                                          ? "bg-amber-500/20 text-amber-400"
                                          : "text-emerald-400 bg-emerald-500/20"
                                      )}
                                      title={!isEditingEntity ? "Enable Edit Mode" : "Disable Edit Mode"}
                                    >
                                      <Code className="w-4 h-4" />
                                    </button>
                                    <button
                                      onClick={() => navigator.clipboard.writeText(selectedEntity.Id)}
                                      className="p-1.5 hover:bg-white/10 rounded-lg transition-colors text-zinc-400 hover:text-emerald-400"
                                      title="Copy Entity ID"
                                    >
                                      <Copy className="w-4 h-4" />
                                    </button>
                                  </>
                                )}
                                <button
                                  onClick={() => {
                                    setSelectedEntity(null);
                                    setSelectedSimCreatureId(null);
                                    setSelectedSimPlantId(null);
                                    setSelectedVoxel(null);
                                    setIsEditingEntity(false);
                                  }}
                                  className="p-1.5 hover:bg-white/5 rounded-lg transition-colors"
                                >
                                  <X className="w-4 h-4 text-zinc-400" />
                                </button>
                              </div>
                            </div>

                            <div className="relative group/search">
                              <input
                                type="text"
                                placeholder="ID, C#12, P#45, or X,Y,Z"
                                value={searchQuery}
                                onChange={(e) => handleSearch(e.target.value)}
                                onContextMenu={async (e) => {
                                  e.stopPropagation();
                                }}
                                className="w-full bg-zinc-900/50 border border-white/10 rounded-lg pl-3 pr-10 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:border-emerald-500/50"
                              />
                              <button
                                onClick={async () => {
                                  try {
                                    const text = await navigator.clipboard.readText();
                                    handleSearch(text);
                                  } catch (err) {
                                    console.error('Failed to read clipboard', err);
                                  }
                                }}
                                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 hover:bg-white/10 rounded text-zinc-500 hover:text-emerald-400 transition-colors"
                                title="Paste from Clipboard"
                              >
                                <Copy className="w-3 h-3" />
                              </button>
                            </div>
                          </div>

                          <div className="flex-1 overflow-auto p-4 custom-scrollbar">
                            <div className="space-y-6">
                              {inspectedCreature && (() => {
                                const cx = Math.max(0, Math.min(sim.X - 1, Math.floor(inspectedCreature.x)));
                                const cy = Math.max(0, Math.min(sim.Y - 1, Math.floor(inspectedCreature.y)));
                                const cz = sim.HGT[cy * sim.X + cx] || 0;
                                const hydration = Math.max(0, Math.min(100, 100 - inspectedCreature.thirst));
                                const satiety = Math.max(0, Math.min(100, 100 - inspectedCreature.hunger));
                                const agePct = Math.min(100, (inspectedCreature.age / sim.MAXAGE) * 100);
                                const intentLabel = (inspectedCreature.intent || 'wander').replace('_', ' ').toUpperCase();
                                const intentBadge = inspectedCreature.intent === 'drink'
                                  ? 'bg-sky-500/20 text-sky-300 border-sky-500/30'
                                  : inspectedCreature.intent === 'forage'
                                    ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
                                    : inspectedCreature.intent === 'avoid_badwater'
                                      ? 'bg-purple-500/20 text-purple-300 border-purple-500/30'
                                      : 'bg-zinc-700/50 text-zinc-300 border-white/10';
                                return (
                                  <>
                                    <div className="flex items-center justify-between bg-zinc-800/60 border border-white/10 rounded-xl p-3">
                                      <div>
                                        <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-400 block">Current Instinct</span>
                                        <span className={`inline-block mt-1 px-2 py-0.5 rounded text-[11px] font-mono font-bold border ${intentBadge}`}>
                                          {intentLabel}
                                        </span>
                                      </div>
                                      <button
                                        onClick={() => setJumpTarget({ x: cx, y: cy, z: Math.max(1, cz) })}
                                        className="px-2.5 py-1.5 rounded-lg bg-indigo-600/80 hover:bg-indigo-500 text-white text-[11px] font-semibold transition-colors"
                                      >
                                        Focus
                                      </button>
                                    </div>

                                    <div className="space-y-3 bg-zinc-800/40 border border-white/5 rounded-xl p-3">
                                      {[
                                        { label: 'Health', val: inspectedCreature.health, bar: 'bg-emerald-500', text: 'text-emerald-300' },
                                        { label: 'Hydration', val: hydration, bar: 'bg-sky-500', text: 'text-sky-300' },
                                        { label: 'Satiety (Food)', val: satiety, bar: 'bg-amber-400', text: 'text-amber-300' },
                                        { label: 'Sickness', val: inspectedCreature.sickness, bar: 'bg-purple-500', text: 'text-purple-300' },
                                      ].map(s => (
                                        <div key={s.label}>
                                          <div className="flex justify-between text-[11px] font-mono mb-1">
                                            <span className="text-zinc-400">{s.label}</span>
                                            <span className={s.text}>{s.val.toFixed(1)}%</span>
                                          </div>
                                          <div className="h-1.5 bg-zinc-900 rounded-full overflow-hidden">
                                            <div className={`h-full ${s.bar} transition-all`} style={{ width: `${Math.max(0, Math.min(100, s.val))}%` }} />
                                          </div>
                                        </div>
                                      ))}
                                      <div>
                                        <div className="flex justify-between text-[11px] font-mono mb-1">
                                          <span className="text-zinc-400">Age</span>
                                          <span className="text-zinc-200">{Math.round(inspectedCreature.age)} / {sim.MAXAGE}t ({agePct.toFixed(0)}%)</span>
                                        </div>
                                        <div className="h-1.5 bg-zinc-900 rounded-full overflow-hidden">
                                          <div className="h-full bg-zinc-400 transition-all" style={{ width: `${agePct}%` }} />
                                        </div>
                                      </div>
                                    </div>

                                    <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                                      <div className="bg-zinc-800/50 rounded-lg p-2.5 border border-white/5">
                                        <span className="text-[10px] text-zinc-400 block uppercase">Position</span>
                                        <span className="text-zinc-200">{inspectedCreature.x.toFixed(1)}, {inspectedCreature.y.toFixed(1)}, z{cz}</span>
                                      </div>
                                      <div className="bg-zinc-800/50 rounded-lg p-2.5 border border-white/5">
                                        <span className="text-[10px] text-zinc-400 block uppercase">Target</span>
                                        <span className="text-zinc-200">{inspectedCreature.hasT ? `${inspectedCreature.tx.toFixed(1)}, ${inspectedCreature.ty.toFixed(1)}` : 'Idle'}</span>
                                      </div>
                                    </div>

                                    <div>
                                      <label className="text-[11px] font-mono uppercase tracking-wider text-zinc-400 block mb-2">Manage Entity</label>
                                      <div className="grid grid-cols-2 gap-2">
                                        <button
                                          onClick={() => { inspectedCreature.thirst = 0; setInspectorPulse(p => p + 1); }}
                                          className="py-1.5 px-2 rounded-lg bg-sky-500/20 hover:bg-sky-500/30 border border-sky-500/30 text-sky-200 text-xs font-medium"
                                        >
                                          Hydrate
                                        </button>
                                        <button
                                          onClick={() => { inspectedCreature.hunger = 0; setInspectorPulse(p => p + 1); }}
                                          className="py-1.5 px-2 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/30 text-amber-200 text-xs font-medium"
                                        >
                                          Feed
                                        </button>
                                        <button
                                          onClick={() => { inspectedCreature.sickness = 0; inspectedCreature.health = 100; setInspectorPulse(p => p + 1); }}
                                          className="py-1.5 px-2 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/30 text-emerald-200 text-xs font-medium"
                                        >
                                          Heal / Cure
                                        </button>
                                        <button
                                          onClick={() => {
                                            inspectedCreature.alive = false;
                                            sim.animalSim.creaturesAlive = sim.creatures.filter(c => c.alive).length;
                                            setSelectedSimCreatureId(null);
                                          }}
                                          className="py-1.5 px-2 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/30 text-rose-200 text-xs font-medium"
                                        >
                                          Remove
                                        </button>
                                      </div>
                                    </div>
                                  </>
                                );
                              })()}

                              {inspectedPlant && (() => {
                                const spName = sim.species[inspectedPlant.sp]?.name || 'flora';
                                const cz = sim.HGT[inspectedPlant.i] || 0;
                                const localSoil = sim.SOIL[inspectedPlant.i] || 0;
                                const localCont = sim.SOIL_CONTAM[inspectedPlant.i] || 0;
                                return (
                                  <>
                                    <div className="flex items-center justify-between bg-zinc-800/60 border border-white/10 rounded-xl p-3">
                                      <div>
                                        <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-400 block">Flora Species</span>
                                        <span className="text-sm font-bold text-emerald-300 capitalize">{spName}</span>
                                      </div>
                                      <button
                                        onClick={() => setJumpTarget({ x: inspectedPlant.x, y: inspectedPlant.y, z: Math.max(1, cz) })}
                                        className="px-2.5 py-1.5 rounded-lg bg-indigo-600/80 hover:bg-indigo-500 text-white text-[11px] font-semibold transition-colors"
                                      >
                                        Focus
                                      </button>
                                    </div>

                                    <div className="space-y-3 bg-zinc-800/40 border border-white/5 rounded-xl p-3 font-mono text-xs">
                                      <div className="flex justify-between">
                                        <span className="text-zinc-400">Biomass:</span>
                                        <span className="text-emerald-300">{inspectedPlant.b.toFixed(2)}</span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span className="text-zinc-400">Tolerance:</span>
                                        <span className="text-zinc-200">{inspectedPlant.tol.toFixed(2)}</span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span className="text-zinc-400">Stress:</span>
                                        <span className={inspectedPlant.stress > 100 ? 'text-amber-400' : 'text-zinc-200'}>{Math.round(inspectedPlant.stress)} / 220</span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span className="text-zinc-400">Soil Moisture:</span>
                                        <span className="text-sky-300">{(localSoil * 100).toFixed(1)}%</span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span className="text-zinc-400">Soil Contam:</span>
                                        <span className={localCont > 0.15 ? 'text-purple-400' : 'text-zinc-300'}>{(localCont * 100).toFixed(1)}%</span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span className="text-zinc-400">Coordinates:</span>
                                        <span className="text-zinc-200">{inspectedPlant.x}, {inspectedPlant.y}, z{cz}</span>
                                      </div>
                                    </div>

                                    <div className="grid grid-cols-2 gap-2">
                                      <button
                                        onClick={() => { inspectedPlant.b = Math.min(2.0, inspectedPlant.b + 0.5); inspectedPlant.stress = 0; setInspectorPulse(p => p + 1); }}
                                        className="py-1.5 px-2 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/30 text-emerald-200 text-xs font-medium"
                                      >
                                        Boost Growth
                                      </button>
                                      <button
                                        onClick={() => {
                                          inspectedPlant.alive = false;
                                          sim.plantSim.plantsAlive = sim.plants.filter(p => p.alive).length;
                                          sim.plantSim.rebuildGrid(sim.X);
                                          setSelectedSimPlantId(null);
                                        }}
                                        className="py-1.5 px-2 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/30 text-rose-200 text-xs font-medium"
                                      >
                                        Remove
                                      </button>
                                    </div>
                                  </>
                                );
                              })()}

                              {selectedEntity && (
                                <>
                                  <div className="flex justify-end">
                                    <button
                                      onClick={() => setShowModelEditor(true)}
                                      className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium rounded-lg transition-colors flex items-center gap-2"
                                    >
                                      <Code className="w-3 h-3" /> Open Editor
                                    </button>
                                  </div>

                                  <div>
                                    <label className="text-[11px] font-mono uppercase tracking-wider text-zinc-400 block mb-1">Template</label>
                                    <div className="flex gap-2 items-center">
                                      <div className="flex-1 bg-zinc-800/50 rounded-lg px-3 py-1.5 border border-white/5 text-sm font-semibold text-zinc-200">
                                        {selectedEntity.Template}
                                      </div>
                                      <button
                                        onClick={() => navigator.clipboard.writeText(selectedEntity.Template || '')}
                                        className="p-2 hover:bg-white/10 rounded-lg transition-colors text-zinc-400 hover:text-emerald-400"
                                        title="Copy Template"
                                      >
                                        <Copy className="w-4 h-4" />
                                      </button>
                                    </div>
                                  </div>

                                  {selectedEntity.Components?.BlockObject && (
                                    <div>
                                      <label className="text-[11px] font-mono uppercase tracking-wider text-zinc-400 block mb-1">Coordinates</label>
                                      <div className="grid grid-cols-3 gap-2">
                                        {['X', 'Y', 'Z'].map((axis) => (
                                          <div key={axis} className="bg-zinc-800/50 rounded-lg px-2 py-1 border border-white/5 text-center">
                                            <span className="text-[11px] text-zinc-400 block">{axis}</span>
                                            <span className="text-xs font-mono text-zinc-200">{(selectedEntity.Components.BlockObject!.Coordinates as any)[axis]}</span>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  )}

                                  {(selectedEntity.Template === 'WaterSource' || selectedEntity.Template?.includes('BadwaterSource') || selectedEntity.Components?.WaterSource || selectedEntity.Components?.BadwaterSource) && (
                                    <div className="bg-sky-950/40 rounded-xl p-3 border border-sky-500/30 space-y-3">
                                      <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-2">
                                          <Droplet className="w-4 h-4 text-sky-400" />
                                          <span className="text-xs font-bold text-sky-200">Water Source Specifications</span>
                                        </div>
                                        <span className={`text-[10px] px-2 py-0.5 rounded font-mono font-bold ${
                                          (selectedEntity.Components?.WaterSource?.Contamination ?? (selectedEntity.Template?.includes('BadwaterSource') ? 1 : 0)) > 0.1
                                            ? 'bg-orange-500/20 text-orange-300 border border-orange-500/40'
                                            : (selectedEntity.Components?.WaterSource?.CurrentStrength ?? 0) > 0
                                              ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                                              : 'bg-zinc-800 text-zinc-400 border border-zinc-700'
                                        }`}>
                                          {(selectedEntity.Components?.WaterSource?.Contamination ?? (selectedEntity.Template?.includes('BadwaterSource') ? 1 : 0)) > 0.1
                                            ? 'BADWATER'
                                            : ((selectedEntity.Components?.WaterSource?.CurrentStrength ?? 0) > 0 ? 'EMITTING' : 'OFF')}
                                        </span>
                                      </div>
                                      {selectedEntity.Components?.BlockObject?.Coordinates && (() => {
                                        const sc = selectedEntity.Components.BlockObject.Coordinates;
                                        const sIdx = Math.round(sc.Y) * sim.X + Math.round(sc.X);
                                        const liveD = (sIdx >= 0 && sIdx < sim.N) ? sim.WATER[sIdx] : 0;
                                        const liveC = (sIdx >= 0 && sIdx < sim.N) ? sim.WATER_CONTAM[sIdx] : 0;
                                        return (
                                          <div className="grid grid-cols-2 gap-2 text-[11px] font-mono bg-zinc-900/60 rounded-lg p-2 border border-white/5">
                                            <div><span className="text-zinc-400">Live Depth: </span><span className="text-sky-300">{liveD.toFixed(3)}</span></div>
                                            <div><span className="text-zinc-400">Contam: </span><span className={liveC > 0.05 ? 'text-orange-300' : 'text-zinc-300'}>{(liveC * 100).toFixed(0)}%</span></div>
                                          </div>
                                        );
                                      })()}

                                      {/* Contamination Slider */}
                                      <div>
                                        <div className="flex justify-between items-center text-xs mb-1">
                                          <span className="text-zinc-300 font-medium">Badwater Contamination:</span>
                                          <span className="font-mono text-orange-400 font-bold">
                                            {Math.round((selectedEntity.Components?.WaterSource?.Contamination ?? (selectedEntity.Template?.includes('BadwaterSource') ? 1 : 0)) * 100)}%
                                          </span>
                                        </div>
                                        <div className="flex gap-2 items-center">
                                          <input
                                            type="range"
                                            min="0"
                                            max="1"
                                            step="0.05"
                                            value={selectedEntity.Components?.WaterSource?.Contamination ?? (selectedEntity.Template?.includes('BadwaterSource') ? 1 : 0)}
                                            onChange={(e) => {
                                              const val = parseFloat(e.target.value);
                                              updateEntityComponent(selectedEntity.Id, 'WaterSource', ['Contamination'], val);
                                            }}
                                            className="flex-1 accent-orange-500 cursor-pointer h-1.5 bg-zinc-800 rounded-lg"
                                          />
                                          <button
                                            onClick={() => {
                                              const cur = selectedEntity.Components?.WaterSource?.Contamination ?? (selectedEntity.Template?.includes('BadwaterSource') ? 1 : 0);
                                              updateEntityComponent(selectedEntity.Id, 'WaterSource', ['Contamination'], cur > 0.1 ? 0 : 1.0);
                                            }}
                                            className="px-2 py-0.5 text-[10px] font-bold rounded bg-orange-950/60 hover:bg-orange-900 border border-orange-500/30 text-orange-300"
                                          >
                                            Toggle
                                          </button>
                                        </div>
                                      </div>

                                      {/* Current Flow Rate */}
                                      <div>
                                        <div className="flex justify-between items-center text-xs mb-1">
                                          <span className="text-zinc-300 font-medium">
                                            Current Flow ({sim.isTimberbornSourceRate ? 'cms' : 'L/tick'}):
                                          </span>
                                          <span className="font-mono text-sky-400 font-bold">
                                            {(selectedEntity.Components?.WaterSource?.CurrentStrength ?? 0.5).toFixed(2)} {sim.isTimberbornSourceRate ? 'cms' : 'L/t'}
                                          </span>
                                        </div>
                                        <div className="flex gap-2 items-center">
                                          <input
                                            type="range"
                                            min="0"
                                            max="10"
                                            step="0.1"
                                            value={selectedEntity.Components?.WaterSource?.CurrentStrength ?? 0.5}
                                            onChange={(e) => {
                                              const val = parseFloat(e.target.value);
                                              updateEntityComponent(selectedEntity.Id, 'WaterSource', ['CurrentStrength'], val);
                                            }}
                                            className="flex-1 accent-sky-400 cursor-pointer h-1.5 bg-zinc-800 rounded-lg"
                                          />
                                          <input
                                            type="number"
                                            min="0"
                                            max="100"
                                            step="0.1"
                                            value={selectedEntity.Components?.WaterSource?.CurrentStrength ?? 0.5}
                                            onChange={(e) => {
                                              const val = Math.max(0, parseFloat(e.target.value) || 0);
                                              updateEntityComponent(selectedEntity.Id, 'WaterSource', ['CurrentStrength'], val);
                                            }}
                                            className="w-16 bg-zinc-900 border border-sky-500/30 rounded px-1.5 py-0.5 text-xs font-mono text-right text-sky-300 focus:outline-none focus:border-sky-400"
                                          />
                                        </div>
                                      </div>

                                      {/* Max / Specified Flow Rate */}
                                      <div>
                                        <div className="flex justify-between items-center text-xs mb-1">
                                          <span className="text-zinc-300 font-medium">
                                            Max Flow / Specified ({sim.isTimberbornSourceRate ? 'cms' : 'L/tick'}):
                                          </span>
                                          <span className="font-mono text-cyan-400 font-bold">
                                            {(selectedEntity.Components?.WaterSource?.SpecifiedStrength ?? 0.5).toFixed(2)} {sim.isTimberbornSourceRate ? 'cms' : 'L/t'}
                                          </span>
                                        </div>
                                        <div className="flex gap-2 items-center">
                                          <input
                                            type="range"
                                            min="0"
                                            max="10"
                                            step="0.1"
                                            value={selectedEntity.Components?.WaterSource?.SpecifiedStrength ?? 0.5}
                                            onChange={(e) => {
                                              const val = parseFloat(e.target.value);
                                              updateEntityComponent(selectedEntity.Id, 'WaterSource', ['SpecifiedStrength'], val);
                                            }}
                                            className="flex-1 accent-cyan-400 cursor-pointer h-1.5 bg-zinc-800 rounded-lg"
                                          />
                                          <input
                                            type="number"
                                            min="0"
                                            max="100"
                                            step="0.1"
                                            value={selectedEntity.Components?.WaterSource?.SpecifiedStrength ?? 0.5}
                                            onChange={(e) => {
                                              const val = Math.max(0, parseFloat(e.target.value) || 0);
                                              updateEntityComponent(selectedEntity.Id, 'WaterSource', ['SpecifiedStrength'], val);
                                            }}
                                            className="w-16 bg-zinc-900 border border-cyan-500/30 rounded px-1.5 py-0.5 text-xs font-mono text-right text-cyan-300 focus:outline-none focus:border-cyan-400"
                                          />
                                        </div>
                                      </div>

                                      {/* Quick Preset Buttons */}
                                      <div>
                                        <div className="text-[10px] uppercase font-mono text-zinc-400 mb-1.5">Flow Presets:</div>
                                        <div className="grid grid-cols-4 gap-1.5">
                                          {[
                                            { label: 'Off', rate: 0.0 },
                                            { label: '0.2 L', rate: 0.2 },
                                            { label: '0.5 L', rate: 0.5 },
                                            { label: '1.0 L', rate: 1.0 },
                                            { label: '2.0 L', rate: 2.0 },
                                            { label: '3.0 L', rate: 3.0 },
                                            { label: '5.0 L', rate: 5.0 },
                                            { label: 'Torrent', rate: 8.0 }
                                          ].map(preset => (
                                            <button
                                              key={preset.label}
                                              onClick={() => {
                                                soundManager.playClick();
                                                updateEntityComponent(selectedEntity.Id, 'WaterSource', ['CurrentStrength'], preset.rate);
                                                updateEntityComponent(selectedEntity.Id, 'WaterSource', ['SpecifiedStrength'], preset.rate);
                                              }}
                                              className={`py-1 px-1.5 rounded text-[11px] font-mono transition-colors text-center border ${
                                                Math.abs((selectedEntity.Components?.WaterSource?.CurrentStrength ?? 0.5) - preset.rate) < 0.05
                                                  ? 'bg-sky-500/30 border-sky-400 text-sky-200 font-bold'
                                                  : 'bg-zinc-800/80 border-white/5 text-zinc-400 hover:bg-zinc-700 hover:text-white'
                                              }`}
                                            >
                                              {preset.label}
                                            </button>
                                          ))}
                                        </div>
                                      </div>
                                    </div>
                                  )}

                                  {(/StreamGauge|WaterLevelMeter|WaterMeter|DepthGauge/i.test(selectedEntity.Template || '') ||
                                    Boolean(selectedEntity.Components?.StreamGauge || selectedEntity.Components?.StreamGaugeMono)) &&
                                    selectedEntity.Components?.BlockObject?.Coordinates && (() => {
                                    const gc = selectedEntity.Components.BlockObject!.Coordinates;
                                    const sample = sim.sampleWaterAt(gc.X, gc.Y, gc.Z);
                                    const contPct = sample.contamination * 100;
                                    const contStatus = sample.depth <= 0.002
                                      ? { label: 'DRY', cls: 'bg-zinc-800 text-zinc-400 border-zinc-700' }
                                      : sample.contamination > 0.6
                                        ? { label: 'BADWATER', cls: 'bg-orange-500/20 text-orange-300 border-orange-500/40' }
                                        : sample.contamination > 0.05
                                          ? { label: 'MIXED', cls: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' }
                                          : { label: 'CLEAN', cls: 'bg-sky-500/20 text-sky-300 border-sky-500/40' };
                                    const angleDeg = sample.speed > 0.01 ? Math.round((Math.atan2(sample.vy, sample.vx) * 180) / Math.PI) : null;
                                    return (
                                      <div className="bg-cyan-950/35 rounded-xl p-3 border border-cyan-500/30 space-y-3">
                                        <div className="flex items-center justify-between">
                                          <div className="flex items-center gap-2">
                                            <Waves className="w-4 h-4 text-cyan-400" />
                                            <span className="text-xs font-bold text-cyan-200">Stream Gauge (Live)</span>
                                          </div>
                                          <span className={`text-[10px] px-2 py-0.5 rounded font-mono font-bold border ${contStatus.cls}`}>
                                            {contStatus.label}
                                          </span>
                                        </div>

                                        <div className="space-y-2.5 bg-zinc-900/60 rounded-lg p-2.5 border border-white/5 font-mono text-xs">
                                          <div>
                                            <div className="flex justify-between mb-1">
                                              <span className="text-zinc-400">Water Level (Depth)</span>
                                              <span className="text-sky-300 font-bold">{sample.depth.toFixed(3)} m</span>
                                            </div>
                                            <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                                              <div
                                                className="h-full bg-sky-400 transition-all"
                                                style={{ width: `${Math.min(100, (sample.depth / 3.0) * 100)}%` }}
                                              />
                                            </div>
                                            <div className="flex justify-between text-[10px] text-zinc-500 mt-1">
                                              <span>Bed Z: {sample.floor}</span>
                                              <span>Surface Z: {sample.surfaceZ.toFixed(2)}</span>
                                            </div>
                                          </div>

                                          <div>
                                            <div className="flex justify-between mb-1">
                                              <span className="text-zinc-400">Flow Speed</span>
                                              <span className="text-cyan-300 font-bold">
                                                {sample.saturated ? `≥ ${sample.speed.toFixed(2)}` : sample.speed.toFixed(3)} v/s
                                              </span>
                                            </div>
                                            <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                                              <div
                                                className="h-full bg-cyan-400 transition-all"
                                                style={{ width: `${Math.min(100, (sample.speed / 1.25) * 100)}%` }}
                                              />
                                            </div>
                                            <div className="flex justify-between text-[10px] text-zinc-500 mt-1">
                                              <span>Vec: ({sample.vx.toFixed(2)}, {sample.vy.toFixed(2)})</span>
                                              <span>{angleDeg !== null ? `${angleDeg}°` : 'Still'}</span>
                                            </div>
                                          </div>

                                          <div>
                                            <div className="flex justify-between mb-1">
                                              <span className="text-zinc-400">Contamination</span>
                                              <span className={contPct > 5 ? 'text-orange-300 font-bold' : 'text-emerald-300 font-bold'}>
                                                {contPct.toFixed(1)}%
                                              </span>
                                            </div>
                                            <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                                              <div
                                                className={`h-full transition-all ${contPct > 60 ? 'bg-orange-500' : contPct > 5 ? 'bg-emerald-400' : 'bg-sky-500'}`}
                                                style={{ width: `${Math.min(100, contPct)}%` }}
                                              />
                                            </div>
                                          </div>
                                        </div>
                                      </div>
                                    );
                                  })()}

                                  <div>
                                    <label className="text-[11px] font-mono uppercase tracking-wider text-zinc-400 block mb-1">Components</label>
                                    <div className="space-y-2">
                                      {Object.keys(selectedEntity.Components).filter(k => k !== 'BlockObject').map(compName => (
                                        <div key={compName} className="bg-zinc-800/30 rounded-xl border border-white/5 overflow-hidden">
                                          <div className="px-3 py-1.5 bg-zinc-800/50 border-b border-white/5 text-[11px] font-semibold text-zinc-200">
                                            {compName}
                                          </div>
                                          {isEditingEntity ? (
                                            <div className="p-2 space-y-1.5">
                                              {(() => {
                                                const comp = selectedEntity.Components[compName];
                                                const renderEditFields = (obj: any, path: string[] = []): React.ReactNode => {
                                                  return Object.keys(obj).map(key => {
                                                    const val = obj[key];
                                                    const newPath = [...path, key];

                                                    if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
                                                      return (
                                                        <div key={key} className="ml-2 border-l border-white/10 pl-2">
                                                          <div className="text-[11px] text-zinc-400 font-mono">{key}</div>
                                                          {renderEditFields(val, newPath)}
                                                        </div>
                                                      );
                                                    } else if (typeof val === 'boolean') {
                                                      return (
                                                        <div key={key} className="flex gap-2 items-center justify-between">
                                                          <label className="text-[11px] text-zinc-400">{key}</label>
                                                          <button
                                                            onClick={() => {
                                                              const newVal = !val;
                                                              updateEntityComponent(selectedEntity.Id, compName, newPath, newVal);
                                                            }}
                                                            className={cn(
                                                              "px-2 py-0.5 rounded text-[10px] font-bold transition-colors",
                                                              val
                                                                ? "bg-emerald-600 text-white"
                                                                : "bg-zinc-700 text-zinc-300 hover:bg-zinc-600"
                                                            )}
                                                          >
                                                            {val ? 'ON' : 'OFF'}
                                                          </button>
                                                        </div>
                                                      );
                                                    } else {
                                                      return (
                                                        <div key={key} className="flex gap-2 items-center">
                                                          <label className="text-[11px] text-zinc-400 w-24 truncate">{key}</label>
                                                          <input
                                                            type="text"
                                                            defaultValue={String(val)}
                                                            onBlur={(e) => {
                                                              let parsedVal: any = e.target.value;
                                                              try {
                                                                parsedVal = JSON.parse(e.target.value);
                                                              } catch {
                                                                // Keep as string if not valid JSON
                                                              }
                                                              updateEntityComponent(selectedEntity.Id, compName, newPath, parsedVal);
                                                            }}
                                                            className="flex-1 bg-zinc-700 border border-white/10 rounded px-2 py-1 text-[11px] text-white font-mono focus:outline-none focus:border-amber-400"
                                                          />
                                                        </div>
                                                      );
                                                    }
                                                  });
                                                };

                                                return renderEditFields(comp);
                                              })()}
                                            </div>
                                          ) : (
                                            <div className="p-2 text-[11px] font-mono text-zinc-300 overflow-x-auto">
                                              <pre>{JSON.stringify(selectedEntity.Components[compName], null, 2)}</pre>
                                            </div>
                                          )}
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                </>
                              )}

                              {selectedVoxel && (
                                <>
                                  <div>
                                    <label className="text-[11px] font-mono uppercase tracking-wider text-zinc-400 block mb-1">Voxel Type</label>
                                    <div className="bg-zinc-800/50 rounded-lg px-3 py-1.5 border border-white/5 text-sm font-semibold flex items-center gap-3 text-zinc-200">
                                      <div className={cn(
                                        "w-3 h-3 rounded-full",
                                        selectedVoxel.val === 2 ? "bg-[#3b82f6]" : selectedVoxel.val === 1 ? "bg-[#795548]" : "bg-[#33691e]"
                                      )} />
                                      {selectedVoxel.val === 2 ? 'Water' : selectedVoxel.val === 1 ? 'Dirt' : 'Grass'}
                                      <span className="text-zinc-400 text-xs font-mono ml-auto">ID: {selectedVoxel.val}</span>
                                    </div>
                                  </div>

                                  <div>
                                    <label className="text-[11px] font-mono uppercase tracking-wider text-zinc-400 block mb-1">Coordinates</label>
                                    <div className="grid grid-cols-3 gap-2">
                                      {['X', 'Y', 'Z'].map((axis) => (
                                        <div key={axis} className="bg-zinc-800/50 rounded-lg px-2 py-1 border border-white/5 text-center">
                                          <span className="text-[11px] text-zinc-400 block">{axis}</span>
                                          <span className="text-xs font-mono text-zinc-200">{(selectedVoxel as any)[axis.toLowerCase()]}</span>
                                        </div>
                                      ))}
                                    </div>
                                  </div>

                                  <div>
                                    <div className="flex justify-between items-center mb-1">
                                      <label className="text-[11px] font-mono uppercase tracking-wider text-zinc-400 block">Live Water Data</label>
                                      {(() => {
                                        const idx = selectedVoxel.y * sizeX + selectedVoxel.x;
                                        const raw = waterData.columns[idx] || (sim.WATER[idx] > 0 ? `${sim.WATER[idx].toFixed(3)}:${sim.WATER_CONTAM[idx].toFixed(3)}` : '0');
                                        return (
                                          <button
                                            onClick={() => navigator.clipboard.writeText(raw)}
                                            className="p-1 hover:bg-white/10 rounded-lg transition-colors text-zinc-400 hover:text-emerald-400"
                                            title="Copy Water Data"
                                          >
                                            <Copy className="w-3 h-3" />
                                          </button>
                                        );
                                      })()}
                                    </div>
                                    <div className="bg-zinc-800/50 rounded-lg px-3 py-1.5 border border-white/5 text-sm font-mono text-blue-300">
                                      {(() => {
                                        const idx = selectedVoxel.y * sizeX + selectedVoxel.x;
                                        const sample = sim.sampleWaterAt(selectedVoxel.x, selectedVoxel.y, selectedVoxel.z);
                                        const raw = waterData.columns[idx] || '';
                                        const parts = raw.includes(':') ? raw.split(':') : null;
                                        return (
                                          <div className="space-y-0.5 text-xs">
                                            <div className="flex justify-between"><span>Depth:</span> <span>{sample.depth.toFixed(3)} m</span></div>
                                            <div className="flex justify-between">
                                              <span>Speed:</span>
                                              <span className="text-cyan-300">
                                                {sample.saturated ? `≥ ${sample.speed.toFixed(2)}` : sample.speed.toFixed(3)} v/s
                                              </span>
                                            </div>
                                            <div className="flex justify-between">
                                              <span>Contam:</span>
                                              <span className={sample.contamination > 0.05 ? 'text-amber-400 font-semibold' : ''}>
                                                {(sample.contamination * 100).toFixed(1)}%
                                              </span>
                                            </div>
                                            {parts && (
                                              <div className="flex justify-between text-zinc-400"><span>Saved Floor:</span> <span>{parts[3] || '0'}</span></div>
                                            )}
                                            {save?.world && (
                                              <button
                                                onClick={() => {
                                                  soundManager.playClick();
                                                  const gx = selectedVoxel.x;
                                                  const gy = selectedVoxel.y;
                                                  const gz = sim.HGT[gy * sim.X + gx] || Math.max(1, selectedVoxel.z + 1);
                                                  const gaugeEnt: Entity = {
                                                    Id: `stream-gauge-${Date.now()}`,
                                                    Template: 'StreamGauge.Folktails',
                                                    Components: {
                                                      BlockObject: { Coordinates: { X: gx, Y: gy, Z: gz }, Orientation: 'Cw0' },
                                                      StreamGauge: { DepthThreshold: 0.5, ContaminationThreshold: 0.1 }
                                                    }
                                                  };
                                                  const updated = { ...save.world, Entities: [...(save.world.Entities || []), gaugeEnt] };
                                                  setSave({ ...save, world: updated });
                                                  setSelectedEntity(gaugeEnt);
                                                  setSelectedVoxel(null);
                                                }}
                                                className="mt-2 w-full py-1 px-2 rounded bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/30 text-cyan-200 text-[11px] font-sans font-medium transition-colors"
                                              >
                                                Place Stream Gauge Here
                                              </button>
                                            )}
                                          </div>
                                        );
                                      })()}
                                    </div>
                                  </div>

                                  <div>
                                    <label className="text-[11px] font-mono uppercase tracking-wider text-zinc-400 block mb-1">Live Soil Data</label>
                                    <div className="grid grid-cols-2 gap-2">
                                      <div className="bg-zinc-800/50 rounded-lg px-3 py-1.5 border border-white/5">
                                        <span className="text-[11px] text-zinc-400 block mb-0.5">Moisture</span>
                                        <span className="text-sm font-mono text-emerald-300">
                                          {(() => {
                                            const idx = selectedVoxel.y * sizeX + selectedVoxel.x;
                                            return (sim.SOIL[idx] ?? 0).toFixed(3);
                                          })()}
                                        </span>
                                      </div>
                                      <div className="bg-zinc-800/50 rounded-lg px-3 py-1.5 border border-white/5">
                                        <span className="text-[11px] text-zinc-400 block mb-0.5">Contamination</span>
                                        <span className="text-sm font-mono text-purple-300">
                                          {(() => {
                                            const idx = selectedVoxel.y * sizeX + selectedVoxel.x;
                                            return (sim.SOIL_CONTAM[idx] ?? 0).toFixed(3);
                                          })()}
                                        </span>
                                      </div>
                                    </div>
                                  </div>
                                </>
                              )}
                            </div>
                          </div>
                        </motion.div>
                        );
                      })()}
                    </AnimatePresence>

                    {showModelEditor && editingTemplate && (
                      <ModelEditor
                        template={editingTemplate}
                        setTemplate={setEditingTemplate}
                        onClose={() => setShowModelEditor(false)}
                      />
                    )}

                    {showHUD ? (
                      <DroughtlineHUD
                        sim={sim}
                        isRunning={isSimRunning}
                        onTogglePlay={() => {
                          soundManager.playClick();
                          setIsSimRunning(r => !r);
                        }}
                        speed={simSpeed}
                        onChangeSpeed={(s) => {
                          soundManager.playClick();
                          setSimSpeed(s);
                        }}
                        onTriggerDrought={() => {
                          soundManager.playClick();
                          sim.triggerDrought(500);
                          setSimRenderVersion(v => v + 1);
                        }}
                        onTriggerStorm={() => {
                          soundManager.playClick();
                          sim.triggerStorm(200);
                          setSimRenderVersion(v => v + 1);
                        }}
                        onResetWorld={() => {
                          soundManager.playClick();
                          sim.generateDefaultWorld();
                          setSave(createSaveFromSim(sim));
                          setSimRenderVersion(v => v + 1);
                        }}
                        onClose={() => setShowHUD(false)}
                      />
                    ) : (
                      <button
                        onClick={() => {
                          soundManager.playClick();
                          setShowHUD(true);
                        }}
                        className="fixed top-20 right-6 z-50 bg-[#0d0b09]/95 border border-amber-500/40 text-[#ffa028] px-3 py-1.5 rounded-xl font-mono text-xs flex items-center gap-2 hover:bg-amber-950/60 shadow-xl backdrop-blur-md"
                      >
                        <Activity className="w-3.5 h-3.5" />
                        <span>OPEN HUD</span>
                      </button>
                    )}

                  </div>
                ) : (
                  <div className="flex-1 overflow-hidden flex flex-col">
                    <div className="p-6 border-b border-white/5 flex items-center justify-between bg-black/20">
                      <div>
                        <h3 className="text-sm font-mono text-zinc-500 uppercase tracking-widest">world.json editor</h3>
                        <p className="text-[10px] text-zinc-600 mt-1">MODIFY RAW WORLD DATA CAREFULLY</p>
                      </div>
                      <div className="flex gap-2">
                        {isEditingJson ? (
                          <>
                            <button
                              onClick={() => setIsEditingJson(false)}
                              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-all"
                            >
                              Cancel
                            </button>
                            <button
                              onClick={handleJsonSave}
                              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-500 transition-all flex items-center gap-2"
                            >
                              <Save className="w-3 h-3" /> Apply Changes
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={() => {
                              setJsonText(JSON.stringify(save.world, null, 2));
                              setIsEditingJson(true);
                            }}
                            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-800 text-zinc-200 hover:bg-zinc-700 transition-all flex items-center gap-2"
                          >
                            <Code className="w-3 h-3" /> Edit Raw JSON
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="flex-1 overflow-auto p-6 custom-scrollbar bg-black/40">
                      {isEditingJson ? (
                        <textarea
                          value={jsonText}
                          onChange={(e) => setJsonText(e.target.value)}
                          className="w-full h-full bg-transparent font-mono text-sm text-emerald-400/90 outline-none resize-none selection:bg-emerald-500/20"
                          spellCheck={false}
                        />
                      ) : (
                        <div className="rounded-xl">
                          <JsonView
                            data={save.world}
                            shouldExpandNode={allExpanded}
                            style={darkStyles}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {gpuLost && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100]">
          <button
            onClick={() => { soundManager.playClick(); reloadEverything(); }}
            className="px-4 py-2 rounded bg-red-600 text-white shadow-lg"
          >
            GPU context lost — click to rebuild view
          </button>
        </div>
      )}

      <footer className="max-w-[1800px] mx-auto px-6 py-4 border-t border-white/5 text-center shrink-0">
        <p className="text-zinc-600 text-[10px] font-medium uppercase tracking-widest">
          Timberborn Save Editor &bull; Built by a beaver who's definitely smarter than you. Don't break the dams.
        </p>
      </footer>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 8px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.1);
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.2);
        }
      `}</style>
    </div>
  );
}
