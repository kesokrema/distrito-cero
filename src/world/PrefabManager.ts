import { UrbanLandscape } from './UrbanLandscape';
import { natureTree, naturePatch } from './NaturePrefabs';
import * as THREE from 'three';
import { GridSystem, type BlockBounds, type Cell, type District } from './GridSystem';
import { VOXEL_SIZE, VOXELS_PER_CELL, voxelCuboid, voxelSurfaceGeometry, type VoxelDimensions } from './VoxelSystem';
import { CITY_VOXEL_SIZE, CITY_VOXELS_PER_CELL, CITY_VOXELS_PER_FLOOR, FLOOR_HEIGHT } from './VoxelConstants';
import { buildingPrefab, ROOM_PREFABS, storeyHeight, voxelUnits, type RoofFeature, type StructureUse } from './StructurePrefabCatalog';
import { createVehicleModel, type VehicleType } from './VehicleModels';
import { planBlock, frontageZ, frontageDirection, stairBay, circulationCell, type BuildingPlan } from './BuildingLayout';
import { roomParts } from './RoomFurnishings';
import { buildingArchitecture, WALL_DIRECTIONS } from './BuildingArchitecture';
import { createHumanoid } from '../actors/HumanoidModel';
import { MERGED_VOXEL_OWNER } from './GreedyMesher';
import { meshVoxelCells } from './GreedyMesher';
import { meshTerrainSurface } from './SurfacePatches';
import { animateCanalFlow, CANAL_BED_Y, CANAL_SURFACE_Y } from './CanalWater';
import { meshVoxelDecorations, snapVoxelMeshToGrid } from './VoxelDecorationMesher';
import { createRoofFeatureMesh, type RoofVoxel } from './RoofPrefabRenderer';

export interface Voxel {
  x: number; y: number; z: number; alive: boolean; hp: number; cellIndex: number; color: THREE.Color; voxelSize: number;
  details: THREE.Object3D[]; pieces: Float32Array; positions: Float32Array; damaged: boolean; roof: boolean; structural?: boolean;
  buildingUse?: StructureUse; baseY?: number;
  mesh?: THREE.InstancedMesh; localIndex?: number;
}
export interface InteractiveProp { position: THREE.Vector3; kind: 'water' | 'electric'; mesh: THREE.Group; active: boolean }
export interface InteriorStation {
  position: THREE.Vector3;
  kind: 'shop' | 'rest' | 'reception' | 'workshop' | 'cabinet' | 'supply';
  used: boolean;
  group: THREE.Group;
  room: { x0: number; x1: number; z0: number; z1: number };
}
export interface InteriorPiece {
  mesh: THREE.Mesh;
  center: THREE.Vector3;
  bounds: THREE.Box3;
  alive: boolean;
  dimensions: VoxelDimensions;
  health: Float32Array;
  mask: Uint8Array;
  palette?: Float32Array;
  ownsGeometry: boolean;
  ownsState?: boolean;
  groundObstacle?: boolean;
  batch?: { mesh: THREE.InstancedMesh; index: number; parent: THREE.Group };
  aggregate?: { mesh: THREE.Mesh; pieces: InteriorPiece[] };
}
export interface PedestrianAnchor { cell: Cell; type: BuildingPlan['type']; district: District }
export interface PublicAnchor { cell: Cell; activity: 'rest' | 'browse' | 'wait' }
export type CityLightAnchor = { object: THREE.Object3D; position: THREE.Vector3; kind: 'street' | 'signal' | 'interior'; color: string; power: number; range: number };
type GroundMark = { x: number; z: number; radius: number };
type BlockAssets = {
  bx: number; bz: number; props: THREE.Group; meshes: THREE.Object3D[]; interiors: THREE.Group[];
  waterFlow?: THREE.InstancedMesh;
  firstVoxel: number; lastVoxel: number; regions: Map<string, ShellRegion>; distance: number;
  active: boolean; released: boolean; mode: 'near' | 'far' | 'off';
};
type ShellRegion = {
  key: string; rx: number; rz: number; voxelIndexes: number[];
  mesh: THREE.Mesh | null; ready: boolean; dirty: boolean; revision: number; pendingRevision: number | null;
};
type FarMeshResult = {
  id: number; positions: Float32Array; normals: Float32Array; colors: Float32Array;
  indexes: Uint32Array; voxelForFace: Uint32Array; exposedFaces: number; quads: number;
};
type MeshRequest = { assets: BlockAssets; region: ShellRegion; revision: number };
const SHELL_REGION_CELLS = 4;
const SURFACE_GAP = 0.025;
const FACADE_BAND_COLOR = '#dfceb0';
const voxelDecorationMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.92, vertexColors: true });
const streetLampMaterial = new THREE.MeshStandardMaterial({ color: '#fff0b8', roughness: 0.78,
  emissive: '#ffe2a0', emissiveIntensity: 0, vertexColors: true });
export interface InteriorStaircase {
  position: THREE.Vector3;
  room: { x0: number; x1: number; z0: number; z1: number };
  maxLevel: number;
  group: THREE.Group;
  startZ: number;
  endZ: number;
  centerX: number;
  steps: Array<Array<THREE.Mesh | null>>;
  treadCount: number;
  storeyHeight: number;
  laneOffset: number;
  laneHalfWidth: number;
}

const pristineStates = new Map<number, { health: Float32Array; mask: Uint8Array }>();
function pristineState(count: number): { health: Float32Array; mask: Uint8Array } {
  let state = pristineStates.get(count);
  if (!state) { state = { health: new Float32Array(count).fill(0.8), mask: new Uint8Array(count).fill(1) }; pristineStates.set(count, state); }
  return state;
}

const color = (hex: string) => new THREE.Color(hex);
const wallColors: Record<District, string[]> = {
  industrial: ['#c89469', '#d9b686', '#879c9e', '#b67660', '#d19b79', '#91aaa2', '#bc8e72'],
  commercial: ['#f2ac80', '#69bcb4', '#e9bf6e', '#e48283', '#9ba9d0', '#d3a3b7', '#a6c778', '#df9775'],
  residential: ['#f2d5ad', '#d5a895', '#a7d2bc', '#e6b876', '#b9c6e3', '#e2a6aa', '#a8c7d4', '#e6c984'],
  park: ['#8fbb70']
};
const roofColors = ['#c5745e', '#bc8467', '#798f94', '#bba777', '#879769', '#b58a9a', '#d4a66f'];
const districtForType = (type: BuildingPlan['type']): District => ['factory', 'workshop'].includes(type) ? 'industrial' : ['shop', 'hotel'].includes(type) ? 'commercial' : 'residential';
const fineCube = voxelCuboid;
const cityCube = (width: number, height: number, depth: number, hex: string, roughness = 0.85): THREE.Mesh =>
  voxelCuboid(width, height, depth, hex, roughness, CITY_VOXEL_SIZE);
// Give substantial static scenery the coarser city lattice; narrow trim and
// small interactive details stay fine instead of being rounded out of shape.
const cube = (width: number, height: number, depth: number, hex: string, roughness = 0.85): THREE.Mesh =>
  Math.min(width, height, depth) >= CITY_VOXEL_SIZE * 0.82
    ? cityCube(width, height, depth, hex, roughness)
    : fineCube(width, height, depth, hex, roughness);

/** A module is an addressable part of a building, not a 2.2-unit cube. Its
 * actual geometry is a one-voxel-thick wall or roof, leaving usable space inside. */
const moduleCache = new Map<string, Float32Array>();
function modulePositions(roof: boolean, wallMask: number, floorHeightVoxels = CITY_VOXELS_PER_FLOOR): Float32Array {
  const key = `${Number(roof)}:${wallMask}:${floorHeightVoxels}:${CITY_VOXEL_SIZE}`;
  const cached = moduleCache.get(key);
  if (cached) return cached;
  const positions: number[] = [];
  const n = CITY_VOXELS_PER_CELL;
  const local = (coordinate: number) => (coordinate - (n - 1) / 2) * CITY_VOXEL_SIZE;
  for (let iy = 0; iy < floorHeightVoxels; iy++) for (let iz = 0; iz < n; iz++) for (let ix = 0; ix < n; ix++) {
    const exposed = roof ? iy === 0 :
      Boolean((wallMask & 1) && ix === 0 || (wallMask & 2) && ix === n - 1 ||
        (wallMask & 4) && iz === 0 || (wallMask & 8) && iz === n - 1);
    if (exposed) positions.push(local(ix), (iy - (floorHeightVoxels - 1) / 2) * CITY_VOXEL_SIZE, local(iz));
  }
  const result = new Float32Array(positions);
  moduleCache.set(key, result);
  return result;
}

/** One-voxel parapet ring, aligned to the roof lattice and closed at corners. */
function roofParapetPositions(plan: BuildingPlan, x: number, z: number, heightVoxels: number): Float32Array {
  const layout = buildingArchitecture(plan), level = layout.roofLevel(x, z);
  const positions: number[] = [], n = CITY_VOXELS_PER_CELL;
  for (let y = 1; y <= heightVoxels; y++) for (let iz = 0; iz < n; iz++) for (let ix = 0; ix < n; ix++) {
    const edge = (ix === 0 && layout.roofLevel(x - 1, z) < level) || (ix === n - 1 && layout.roofLevel(x + 1, z) < level) ||
      (iz === 0 && layout.roofLevel(x, z - 1) < level) || (iz === n - 1 && layout.roofLevel(x, z + 1) < level);
    if (edge) positions.push((ix - (n - 1) / 2) * CITY_VOXEL_SIZE, (y - (CITY_VOXELS_PER_FLOOR - 1) / 2) * CITY_VOXEL_SIZE, (iz - (n - 1) / 2) * CITY_VOXEL_SIZE);
  }
  return Float32Array.from(positions);
}

function signFace(text: string, background: string, foreground: string, width: number, height: number): THREE.Mesh {
  const canvas = document.createElement('canvas');
  canvas.width = 1024; canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = background; ctx.fillRect(0, 0, 1024, 256);
  ctx.strokeStyle = foreground; ctx.lineWidth = 12; ctx.strokeRect(16, 16, 992, 224);
  ctx.fillStyle = foreground; ctx.font = `900 ${text.length > 8 ? 115 : 155}px Arial, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, 512, 134, 900);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  const nx = Math.max(1, Math.round(width / VOXEL_SIZE));
  const ny = Math.max(1, Math.round(height / VOXEL_SIZE));
  const mesh = new THREE.Mesh(voxelSurfaceGeometry(nx, ny, 1, undefined, true), new THREE.MeshBasicMaterial({ map: texture }));
  mesh.userData.voxelDimensions = { nx, ny, nz: 1, signUv: true } satisfies VoxelDimensions;
  return mesh;
}

export class PrefabManager {
  readonly voxels: Voxel[] = [];
  readonly buildings = new THREE.Group();
  readonly interactiveProps: InteractiveProp[] = [];
  readonly interiorStations: InteriorStation[] = [];
  readonly interiorPieces: InteriorPiece[] = [];
  readonly pedestrianAnchors: PedestrianAnchor[] = [];
  readonly publicAnchors: PublicAnchor[] = [];
  readonly staircases: InteriorStaircase[] = [];
  readonly vehicles: THREE.Group[] = [];
  private blockAssets = new Map<string, BlockAssets>();
  private interiorLodGroups: THREE.Group[] = [];
  private interiorPieceByMesh = new WeakMap<THREE.Object3D, InteriorPiece>();
  private scenePieceByBatch = new WeakMap<THREE.InstancedMesh, InteriorPiece[]>();
  private aggregatePiecesByMesh = new WeakMap<THREE.Mesh, InteriorPiece[]>();
  private interiorPiecesByCell = new Map<number, InteriorPiece[]>();
  private navigationChanges = new Set<number>();
  private vehicleParts = new WeakMap<THREE.Group, InteriorPiece[]>();
  private upperFloorSlabsByCell = new Map<number, InteriorPiece[]>();
  private interiorObstaclesByCell = new Map<number, InteriorPiece[]>();
  private buildingDecorations: Array<{ first: number; last: number; group: THREE.Group; occupied: number[] }> = [];
  private interiorAreas: Array<{ x0: number; x1: number; z0: number; z1: number; upper: number[] }> = [];
  private dummy = new THREE.Object3D();
  private voxelsByCell = new Map<number, number[]>();
  private entranceApproaches = new Set<number>();
  private curbGeometry = new THREE.PlaneGeometry(VOXEL_SIZE, 0.07);
  private tileMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1 });
  private groundTiles: THREE.Mesh[] = [];
  readonly lightAnchors: CityLightAnchor[] = [];
  readonly overlapRemovals = { shell: 0, static: 0 };
  private readonly groundMarks: GroundMark[] = [];
  private groundVisible = true;
  private meshWorker: Worker;
  private nextMeshRequest = 1;
  private meshRequests = new Map<number, MeshRequest>();
  private shellMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.91, vertexColors: true });
  private landmarkCell: Cell;
  private pendingBlock: Generator<void, BlockBounds> | null = null;
  private visibleCenter = '';
  private readonly plansByBlock = new Map<string, BuildingPlan[]>();
  private readonly viewFrustum = new THREE.Frustum();
  private readonly viewMatrix = new THREE.Matrix4();
  private readonly viewSphere = new THREE.Sphere();
  private waterTime = 0;

  private facadePaint(district: District, gx: number, gz: number): THREE.Color {
    const block = this.grid.blockAt(gx, gz);
    const profile = this.grid.blockProfile(block.bx, block.bz);
    const palette = wallColors[district];
    const base = color(palette[Math.floor(this.grid.hash(gx, gz, 91) * palette.length)]);
    const hue = [-0.012, 0.012, -0.023, 0.026][profile.palette];
    return base.offsetHSL(hue, (profile.density - 0.5) * 0.085, (profile.greenery - 0.5) * 0.055);
  }

  constructor(private scene: THREE.Scene, readonly grid: GridSystem, private streetActivity = 1) {
    if (Math.abs(grid.cellSize - VOXELS_PER_CELL * VOXEL_SIZE) > 1e-9) throw new Error('La celda debe contener un número entero de voxels estándar');
    // Tint the exposed shell by its real world-lattice cell in the material.
    // Greedy walls stay as two triangles while individual voxels retain a
    // stable, visible tone even after a damaged region is remeshed.
    this.shellMaterial.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('void main() {', 'varying vec3 vCityVoxelWorld;\nvarying vec3 vCityVoxelNormal;\nvoid main() {')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vCityVoxelWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
          vCityVoxelNormal = normalize(mat3(modelMatrix) * normal);`);
      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', `varying vec3 vCityVoxelWorld;
          varying vec3 vCityVoxelNormal;
          float cityVoxelHash(vec3 p) {
            p = fract(p * vec3(0.1031, 0.11369, 0.13787));
            p += dot(p, p.yzx + 19.19);
            return fract((p.x + p.y) * p.z);
          }
          void main() {`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          vec3 cell = floor(vCityVoxelWorld / ${CITY_VOXEL_SIZE.toFixed(2)} + 0.5 - vCityVoxelNormal * 0.002);
          float fine = cityVoxelHash(cell) - 0.5;
          float patchTone = cityVoxelHash(floor(cell / 3.0)) - 0.5;
          float warm = cityVoxelHash(cell + vec3(19.0, 3.0, 11.0)) - 0.5;
          vec3 footprint = fwidth(vCityVoxelWorld);
          float pixelSpan = max(max(footprint.x, footprint.y), footprint.z);
          float detail = clamp(${CITY_VOXEL_SIZE.toFixed(2)} / max(pixelSpan * 1.7, 0.001), 0.0, 1.0);
          float tone = (fine * 0.23 + patchTone * 0.11) * detail;
          diffuseColor.rgb *= vec3(1.0 + tone + warm * 0.065 * detail,
                                   1.0 + tone,
                                   1.0 + tone - warm * 0.05 * detail);`);
    };
    // Ground only needs its exposed surface; curbs retain the raised sidewalk edge.
    this.curbGeometry = new THREE.PlaneGeometry(grid.cellSize, 0.07);
    this.meshWorker = new Worker(new URL('../workers/mesh.worker.ts', import.meta.url), { type: 'module' });
    this.meshWorker.onmessage = (event: MessageEvent<FarMeshResult>) => this.receiveFarMesh(event.data);
    scene.add(this.buildings);
    // Fix the entire city's parcel/building blueprint before any detailed
    // chunk geometry is built. The geometry and occupants remain streamed.
    for (let bz = 0; bz < grid.roadZ.length - 1; bz++) for (let bx = 0; bx < grid.roadX.length - 1; bx++) {
      const bounds = grid.blockBounds(bx, bz);
      const district = grid.blockProfile(bx, bz).district;
      this.plansByBlock.set(`${bx}:${bz}`, planBlock(grid, bounds, district));
    }
    this.landmarkCell = grid.landmark('park');
    const spawn = grid.blockAt(grid.center + 1, grid.center + 1);
    this.ensureAround(spawn.bx, spawn.bz, 1, Infinity);
  }

  setStreetActivity(activity: number): void { this.streetActivity = THREE.MathUtils.clamp(activity, 0.2, 1); }
  updateWater(dt: number): void {
    this.waterTime += dt;
    for (const assets of this.blockAssets.values()) if (assets.active && assets.waterFlow)
      animateCanalFlow(assets.waterFlow, this.waterTime);
  }
  setNightLightLevel(darkness: number): void { streetLampMaterial.emissiveIntensity = Math.max(0, darkness) * 1.3; }

  toggleGround(): boolean {
    this.groundVisible = !this.groundVisible;
    for (const tiles of this.groundTiles) tiles.visible = this.groundVisible;
    return this.groundVisible;
  }

  dispose(): void {
    this.meshWorker.terminate();
    for (const assets of this.blockAssets.values()) for (const region of assets.regions.values()) region.mesh?.geometry.dispose();
    this.shellMaterial.dispose();
  }

  ensureAround(bx: number, bz: number, radius = 2, maxBlocks = 1): BlockBounds[] {
    const deadline = maxBlocks === Infinity ? Infinity : performance.now() + 4;
    const generated: BlockBounds[] = [];
    while (generated.length < maxBlocks && performance.now() < deadline) {
      if (!this.pendingBlock) {
        const pending: Array<{ bx: number; bz: number; distance: number }> = [];
        for (let dz = -radius; dz <= radius; dz++) for (let dx = -radius; dx <= radius; dx++) {
          const x = bx + dx, z = bz + dz;
          if (x < 0 || z < 0 || x >= this.grid.roadX.length - 1 || z >= this.grid.roadZ.length - 1 || this.grid.activeBlocks.has(`${x}:${z}`)) continue;
          pending.push({ bx: x, bz: z, distance: dx * dx + dz * dz });
        }
        pending.sort((a, b) => a.distance - b.distance);
        if (!pending.length) break;
        this.pendingBlock = this.generateBlockAssets(this.grid.blockBounds(pending[0].bx, pending[0].bz));
      }
      const result = this.pendingBlock.next();
      if (result.done) { generated.push(result.value); this.pendingBlock = null; }
    }
    const center = `${bx}:${bz}`;
    if (generated.length || this.visibleCenter !== center) {
      this.visibleCenter = center;
      this.updateVisibleBlocks(bx, bz);
    }
    return generated;
  }

  blueprintStats(): { blocks: number; buildings: number } {
    let buildings = 0;
    for (const plans of this.plansByBlock.values()) buildings += plans.length;
    return { blocks: this.plansByBlock.size, buildings };
  }

  /** Build only blocks in the camera's buffered view, plus the player's
   * immediate neighborhood for collision, navigation and spawn continuity. */
  ensureCameraVisible(camera: THREE.Camera, player: THREE.Vector3, maxBlocks = 1): BlockBounds[] {
    this.prepareFrustum(camera);
    const [pgx, pgz] = this.grid.grid(player.x, player.z);
    const playerBlock = this.grid.blockAt(pgx, pgz);
    const [cgx, cgz] = this.grid.grid(camera.position.x, camera.position.z);
    const cameraBlock = this.grid.blockAt(cgx, cgz);
    const candidates: Array<{ bx: number; bz: number; score: number }> = [];
    const seen = new Set<string>();
    const collect = (centerX: number, centerZ: number, radius: number) => {
      for (let bz = Math.max(0, centerZ - radius); bz <= Math.min(this.grid.roadZ.length - 2, centerZ + radius); bz++)
        for (let bx = Math.max(0, centerX - radius); bx <= Math.min(this.grid.roadX.length - 2, centerX + radius); bx++) {
          const key = `${bx}:${bz}`;
          if (seen.has(key) || this.grid.activeBlocks.has(key)) continue;
          seen.add(key);
          const adjacent = Math.max(Math.abs(bx - playerBlock.bx), Math.abs(bz - playerBlock.bz)) <= 1;
          if (!adjacent && !this.blockInView(bx, bz, player)) continue;
          const bounds = this.grid.blockBounds(bx, bz);
          const [x, z] = this.grid.world((bounds.x0 + bounds.x1) >> 1, (bounds.z0 + bounds.z1) >> 1);
          candidates.push({ bx, bz, score: Math.hypot(x - player.x, z - player.z) + (adjacent ? -160 : 0) });
        }
    };
    collect(playerBlock.bx, playerBlock.bz, 5);
    collect(cameraBlock.bx, cameraBlock.bz, 5);
    candidates.sort((a, b) => a.score - b.score);
    const generated: BlockBounds[] = [];
    const deadline = performance.now() + 4;
    while (generated.length < maxBlocks && performance.now() < deadline) {
      if (!this.pendingBlock) {
        const next = candidates.shift();
        if (!next) break;
        this.pendingBlock = this.generateBlockAssets(this.grid.blockBounds(next.bx, next.bz));
      }
      const result = this.pendingBlock.next();
      if (result.done) { generated.push(result.value); this.pendingBlock = null; }
    }
    this.updateCameraVisibility(camera, player);
    return generated;
  }

  private prepareFrustum(camera: THREE.Camera): void {
    camera.updateMatrixWorld();
    this.viewFrustum.setFromProjectionMatrix(this.viewMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  }

  private blockInView(bx: number, bz: number, player: THREE.Vector3): boolean {
    const bounds = this.grid.blockBounds(bx, bz);
    const [x0, z0] = this.grid.world(bounds.x0, bounds.z0);
    const [x1, z1] = this.grid.world(bounds.x1, bounds.z1);
    const x = (x0 + x1) / 2, z = (z0 + z1) / 2;
    if (Math.hypot(x - player.x, z - player.z) > 155) return false;
    this.viewSphere.center.set(x, 9, z);
    this.viewSphere.radius = Math.hypot((x1 - x0) / 2, (z1 - z0) / 2, 9) + 15;
    return this.viewFrustum.intersectsSphere(this.viewSphere);
  }

  updateCameraVisibility(camera: THREE.Camera, player: THREE.Vector3): void {
    this.prepareFrustum(camera);
    const [gx, gz] = this.grid.grid(player.x, player.z);
    const block = this.grid.blockAt(gx, gz);
    for (const assets of this.blockAssets.values()) {
      assets.distance = Math.max(Math.abs(assets.bx - block.bx), Math.abs(assets.bz - block.bz));
      this.setBlockVisible(assets, this.blockInView(assets.bx, assets.bz, player), assets.distance);
    }
  }

  isWorldActive(x: number, z: number): boolean {
    const [gx, gz] = this.grid.grid(x, z);
    const block = this.grid.blockAt(gx, gz);
    return this.blockAssets.get(`${block.bx}:${block.bz}`)?.active ?? false;
  }

  private *generateBlockAssets(bounds: BlockBounds): Generator<void, BlockBounds> {
    const cells = this.grid.activateBlock(bounds.bx, bounds.bz);
    const interiorCount = this.interiorLodGroups.length, firstVoxel = this.voxels.length;
    const firstPiece = this.interiorPieces.length;
    const roots: THREE.Object3D[] = [];
    const capture = (generate: () => void) => {
      const before = new Set(this.scene.children);
      generate();
      roots.push(...this.scene.children.filter((object) => !before.has(object)));
    };
    const landscape=new UrbanLandscape(this.grid).build(bounds);
    capture(() => this.drawTiles(cells, bounds));
    yield;
    const district = this.grid.districtAt(Math.floor((bounds.x0 + bounds.x1) / 2), Math.floor((bounds.z0 + bounds.z1) / 2));
    const plans = this.accessiblePlans(bounds, this.plansByBlock.get(`${bounds.bx}:${bounds.bz}`) || []);
    for (const plan of plans) {
      const firstRoot = roots.length;
      capture(() => this.createBuilding(plan));
      const buildingRoots = roots.slice(firstRoot);
      this.registerStaticPieces(buildingRoots);
      yield;
    }
    const firstPropRoot = roots.length;
    capture(() => {
      this.scene.add(landscape);
      this.addSkybridges(plans);
      this.addBlockConnections(bounds, plans, district);
      this.addRoadDetails(bounds);
      this.addBlockProps(bounds, cells, plans);
    });
    const decorationRoots = roots.slice(firstPropRoot);
    for(const root of decorationRoots) {
      if(root.userData.terrainApplied)continue;
      const box=new THREE.Box3().setFromObject(root), center=box.getCenter(new THREE.Vector3());
      root.position.y+=this.grid.groundHeight(center.x,center.z);
    }
    this.snapVoxelDecorations(decorationRoots);
    yield;
    this.registerStaticPieces(decorationRoots);
    this.resolveStaticVoxelOverlaps(firstVoxel, this.voxels.length, firstPiece);
    this.aggregateStaticSurfaces(roots);
    this.aggregateVoxelDecorations(decorationRoots);
    this.registerCityLights(roots);
    const props = this.collectBlockProps(roots);
    this.batchStaticSubtrees(props);
    this.scene.add(props);
    props.updateMatrixWorld(true);
    props.traverse((object) => { object.matrixAutoUpdate = false; object.matrixWorldAutoUpdate = false; });
    const assets: BlockAssets = {
      bx: bounds.bx, bz: bounds.bz, props, meshes: [], interiors: this.interiorLodGroups.slice(interiorCount),
      waterFlow: props.getObjectByName('canal-flow') as THREE.InstancedMesh | undefined,
      firstVoxel, lastVoxel: this.voxels.length, regions: new Map(),
      distance: 0, active: true, released: false, mode: 'near'
    };
    for (let index = firstVoxel; index < assets.lastVoxel; index++) {
      const cell = this.grid.cells[this.voxels[index].cellIndex];
      if (!cell) continue;
      const rx = Math.floor((cell.x - bounds.x0) / SHELL_REGION_CELLS);
      const rz = Math.floor((cell.z - bounds.z0) / SHELL_REGION_CELLS);
      const key = `${rx}:${rz}`;
      let region = assets.regions.get(key);
      if (!region) {
        region = { key, rx, rz, voxelIndexes: [], mesh: null, ready: false, dirty: true, revision: 0, pendingRevision: null };
        assets.regions.set(key, region);
      }
      region.voxelIndexes.push(index);
    }
    this.blockAssets.set(`${bounds.bx}:${bounds.bz}`, assets);
    return bounds;
  }

  streamingStats(): { generatedBlocks: number; renderedBlocks: number; queuedMeshes: number; shellTriangles: number; unmergedShellTriangles: number; groundTriangles: number; unmergedGroundTriangles: number; logicalVoxels: number } {
    let shellTriangles = 0, unmergedShellTriangles = 0, renderedBlocks = 0, groundTriangles = 0, unmergedGroundTriangles = 0;
    for (const block of this.blockAssets.values()) if (block.active) {
      renderedBlocks++;
      for (const region of block.regions.values()) {
        const stats = region.mesh?.geometry.userData.surfaceStats;
        if (stats) { shellTriangles += stats.quads * 2; unmergedShellTriangles += stats.exposedFaces * 2; }
      }
      block.props.traverse((object) => {
        if (object instanceof THREE.Mesh && object.name === 'chunk-ground') {
          groundTriangles += object.geometry.index!.count / 3;
          unmergedGroundTriangles += (object.geometry.userData.surfaceStats?.cells ?? 0) * 2;
        }
      });
    }
    return { generatedBlocks: this.blockAssets.size, renderedBlocks, queuedMeshes: this.meshRequests.size, shellTriangles, unmergedShellTriangles, groundTriangles, unmergedGroundTriangles, logicalVoxels: this.voxels.reduce((n, v) => n + v.pieces.length, 0) };
  }

  private updateVisibleBlocks(bx: number, bz: number): void {
    for (const assets of this.blockAssets.values()) {
      const distance = Math.max(Math.abs(assets.bx - bx), Math.abs(assets.bz - bz));
      assets.distance = distance;
      this.setBlockVisible(assets, distance <= 2, distance);
    }
  }

  private setBlockVisible(assets: BlockAssets, visible: boolean, distance: number): void {
      if (!visible) {
        if (assets.active) {
          this.scene.remove(assets.props);
          for (const mesh of assets.meshes) this.buildings.remove(mesh);
          for (const region of assets.regions.values()) if (region.mesh) this.buildings.remove(region.mesh);
          assets.active = false;
          assets.mode = 'off';
        }
        if (distance > 4 && !assets.released) {
          for (const region of assets.regions.values()) region.mesh?.geometry.dispose();
          assets.props.traverse((object) => {
            if (!(object instanceof THREE.Mesh) || object.name !== 'chunk-ground') return;
            object.geometry.dispose();
            (object.material as THREE.MeshStandardMaterial).map?.dispose();
          });
          assets.released = true;
        }
        return;
      }
      if (!assets.active) {
        this.scene.add(assets.props);
        assets.props.traverse((object) => {
          if (object instanceof THREE.Mesh && object.name === 'chunk-ground') {
            const texture = (object.material as THREE.MeshStandardMaterial).map;
            if (texture) texture.needsUpdate = true;
          }
        });
        assets.active = true;
      }
      assets.released = false;
      assets.props.traverse(o=>{if(o.userData.microNature)o.visible=distance<=1;});
      for (const group of assets.interiors) group.visible = distance <= 1;
      for (const mesh of assets.meshes) if (mesh.parent !== this.buildings) this.buildings.add(mesh);
      for (const region of assets.regions.values()) if (region.mesh?.parent !== this.buildings && region.mesh) this.buildings.add(region.mesh);
      assets.mode = [...assets.regions.values()].every((region) => region.mesh !== null) ? 'far' : 'near';
  }

  private collectBlockProps(roots: THREE.Object3D[]): THREE.Group {
    const props = new THREE.Group();
    const batches = new Map<string, THREE.Mesh[]>();
    for (const object of roots) {
      if (object.userData.dynamicVehicle) continue;
      if (!(object instanceof THREE.Mesh) || object instanceof THREE.InstancedMesh || !object.visible || Array.isArray(object.material)) {
        props.add(object);
        continue;
      }
      const key = `${object.geometry.uuid}:${object.material.uuid}:${Number(object.castShadow)}:${Number(object.receiveShadow)}`;
      let meshes = batches.get(key);
      if (!meshes) { meshes = []; batches.set(key, meshes); }
      meshes.push(object);
    }
    for (const meshes of batches.values()) {
      if (meshes.length === 1) { props.add(meshes[0]); continue; }
      const first = meshes[0];
      const batch = new THREE.InstancedMesh(first.geometry, first.material, meshes.length);
      batch.castShadow = first.castShadow;
      batch.receiveShadow = first.receiveShadow;
      meshes.forEach((mesh, index) => {
        mesh.updateMatrix();
        batch.setMatrixAt(index, mesh.matrix);
        const piece = this.interiorPieceByMesh.get(mesh);
        if (piece) piece.batch = { mesh: batch, index, parent: props };
        this.scene.remove(mesh);
      });
      this.scenePieceByBatch.set(batch, meshes.map((mesh) => this.interiorPieceByMesh.get(mesh)!));
      batch.instanceMatrix.needsUpdate = true;
      props.add(batch);
    }
    return props;
  }

  /** Align all static road and park decorations before registering their hit boxes. */
  private snapVoxelDecorations(roots: THREE.Object3D[]): void {
    for (const root of roots) {
      if (root.userData.dynamicVehicle) continue;
      root.updateMatrixWorld(true);
      root.traverse((object) => {
        if (object instanceof THREE.Mesh && !(object instanceof THREE.InstancedMesh)) snapVoxelMeshToGrid(object);
      });
    }
  }

  /**
   * Render static voxel scenery from one shared fine lattice. Internal faces
   * between touching or intersecting decorative pieces are removed, while
   * source meshes remain addressable so their voxel damage still works.
   */
  private aggregateVoxelDecorations(roots: THREE.Object3D[]): void {
    const pieces: InteriorPiece[] = [];
    for (const root of roots) {
      if (root.userData.dynamicVehicle || root.userData.microNature) continue;
      root.traverse((object) => {
        if (!(object instanceof THREE.Mesh) || object instanceof THREE.InstancedMesh) return;
        for(let ancestor:THREE.Object3D|null=object;ancestor;ancestor=ancestor.parent)if(ancestor.userData.microNature)return;
        const piece = this.interiorPieceByMesh.get(object);
        const dimensions = piece?.dimensions;
        const material = object.material;
        if (piece?.alive && dimensions && !dimensions.signUv && !piece.palette && !object.userData.cityLight &&
            material instanceof THREE.MeshStandardMaterial && !material.map) pieces.push(piece);
      });
    }
    if (pieces.length < 2) return;

    const surface = meshVoxelDecorations(pieces.map((piece) => piece.mesh));
    if (!surface?.indexes.length) return;
    const geometry = new THREE.BufferGeometry();
    const positions = surface.positions;
    for (let index = 0; index < positions.length; index++) positions[index] *= VOXEL_SIZE;
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(surface.normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(surface.colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(surface.indexes, 1));
    geometry.userData.decorationPieceForFace = surface.voxelForFace;
    geometry.userData.surfaceStats = { exposedFaces: surface.exposedFaces, quads: surface.quads };
    geometry.computeBoundingSphere();

    const mesh = new THREE.Mesh(geometry, voxelDecorationMaterial);
    mesh.castShadow = pieces.some((piece) => piece.mesh.castShadow);
    mesh.receiveShadow = true;
    mesh.userData.aggregateSurface = true;
    mesh.userData.surfaceKind = 'decoration';
    mesh.userData.surfaceStats = { originalPieces: pieces.length, triangles: surface.quads * 2 };
    const aggregateRoot = new THREE.Group();
    aggregateRoot.userData.voxelDecorationAggregate = true;
    aggregateRoot.add(mesh);
    this.scene.add(aggregateRoot);
    roots.push(aggregateRoot);

    const state = { mesh, pieces };
    this.aggregatePiecesByMesh.set(mesh, pieces);
    for (const piece of pieces) {
      piece.aggregate = state;
      piece.mesh.visible = false;
    }
  }

  /** Batch repeated steps, floors and furnishing parts in their own local frame. Logical meshes keep their identity for damage and interactions. */
  private batchStaticSubtrees(root: THREE.Group): void {
    for (const child of [...root.children]) if (child instanceof THREE.Group) this.batchStaticSubtrees(child);
    const groups = new Map<string, THREE.Mesh[]>();
    for (const child of root.children) {
      if (!(child instanceof THREE.Mesh) || child instanceof THREE.InstancedMesh || !this.interiorPieceByMesh.has(child) || !child.visible) continue;
      const key = `${child.geometry.uuid}:${Array.isArray(child.material) ? '' : child.material.uuid}`;
      let list = groups.get(key); if (!list) { list = []; groups.set(key, list); } list.push(child);
    }
    for (const meshes of groups.values()) {
      if (meshes.length < 2) continue;
      const batch = new THREE.InstancedMesh(meshes[0].geometry, meshes[0].material, meshes.length);
      batch.castShadow = meshes.some((mesh) => mesh.castShadow); batch.receiveShadow = true;
      meshes.forEach((mesh, index) => {
        mesh.updateMatrix(); batch.setMatrixAt(index, mesh.matrix); mesh.visible = false;
        this.interiorPieceByMesh.get(mesh)!.batch = { mesh: batch, index, parent: root };
      });
      this.scenePieceByBatch.set(batch, meshes.map((mesh) => this.interiorPieceByMesh.get(mesh)!));
      batch.instanceMatrix.needsUpdate = true; batch.computeBoundingSphere(); root.add(batch);
    }
  }

  private walkSurfacePieces=new Map<string,InteriorPiece[]>();
  private registerStaticPieces(roots: THREE.Object3D[]): void {
    for (const root of roots) {
      if (root.userData.dynamicVehicle || root instanceof THREE.InstancedMesh) continue;
      root.updateMatrixWorld(true);
      root.traverse((object) => {
        if (!(object instanceof THREE.Mesh) || object instanceof THREE.InstancedMesh || this.interiorPieceByMesh.has(object)) return;
        const dimensions = object.userData.voxelDimensions as VoxelDimensions | undefined;
        if (!dimensions) return;
        const count = dimensions.nx * dimensions.ny * dimensions.nz;
        const customMask = object.userData.voxelMask as Uint8Array | undefined;
        const state = customMask ? { health: new Float32Array(count).fill(0.8), mask: customMask.slice() } : pristineState(count);
        const piece: InteriorPiece = {
          mesh: object, center: object.getWorldPosition(new THREE.Vector3()), bounds: new THREE.Box3().setFromObject(object),
          alive: true, dimensions, ...state, ownsState: Boolean(customMask),
          palette: object.userData.voxelPalette as Float32Array | undefined,
          ownsGeometry: Boolean(dimensions.signUv || object.userData.ownsVoxelGeometry), groundObstacle: Boolean(object.parent?.userData.groundFurniture)
        };
        this.interiorPieces.push(piece);
        this.interiorPieceByMesh.set(object, piece);
        for(const id of object.userData.walkSurfaceIds??[]) {
          const surface=this.grid.surfaces.surfaces.get(id),pieces=this.walkSurfacePieces.get(id)??[];
          pieces.push(piece);this.walkSurfacePieces.set(id,pieces);
          if(surface)surface.enabled=(x,z)=>pieces.some(p=>p.alive&&this.pieceOccupies(p,x,this.grid.surfaces.height(surface,x,z)-VOXEL_SIZE/2,z));
        }
        const cell = this.grid.cellAtWorld(piece.center.x, piece.center.z);
        if (!cell) return;
        const cellIndex = this.grid.index(cell.x, cell.z);
        if (!this.interiorPiecesByCell.has(cellIndex)) this.interiorPiecesByCell.set(cellIndex, []);
        this.interiorPiecesByCell.get(cellIndex)!.push(piece);
        if (object.userData.floorLevel) {
          if (!this.upperFloorSlabsByCell.has(cellIndex)) this.upperFloorSlabsByCell.set(cellIndex, []);
          this.upperFloorSlabsByCell.get(cellIndex)!.push(piece);
        }
        if (object.parent?.userData.furniture && !object.userData.noObstacle) {
          const [x0,z0] = this.grid.grid(piece.bounds.min.x, piece.bounds.min.z);
          const [x1,z1] = this.grid.grid(piece.bounds.max.x, piece.bounds.max.z);
          for (let z=z0;z<=z1;z++) for (let x=x0;x<=x1;x++) {
            const key=this.grid.index(x,z);
            if (!this.interiorObstaclesByCell.has(key)) this.interiorObstaclesByCell.set(key, []);
            this.interiorObstaclesByCell.get(key)!.push(piece);
          }
        }
      });
    }
  }

  /** Resolve solid occupancy once for every generated block. A fine lattice
   * also represents the larger shell voxels, so prefab boundaries cannot
   * leave two destructible voxels in the same volume. */
  private resolveStaticVoxelOverlaps(firstVoxel: number, lastVoxel: number, firstPiece: number): void {
    const occupied = new Set<string>();
    const keysAt = (point: THREE.Vector3, size: number): string[] => {
      const ratio = Math.round(size / VOXEL_SIZE);
      if (ratio < 1 || Math.abs(ratio * VOXEL_SIZE - size) > 0.001) return [];
      const sx = Math.round((point.x - size / 2) / VOXEL_SIZE);
      const sy = Math.round((point.y - size / 2) / VOXEL_SIZE);
      const sz = Math.round((point.z - size / 2) / VOXEL_SIZE);
      const result: string[] = [];
      for (let y = 0; y < ratio; y++) for (let z = 0; z < ratio; z++) for (let x = 0; x < ratio; x++)
        result.push(`${sx + x}:${sy + y}:${sz + z}`);
      return result;
    };
    const reserve = (keys: string[]): boolean => {
      if (!keys.length || keys.some((key) => occupied.has(key))) return false;
      keys.forEach((key) => occupied.add(key));
      return true;
    };
    for (let index = firstVoxel; index < lastVoxel; index++) {
      const voxel = this.voxels[index];
      for (let sub = 0; sub < voxel.pieces.length; sub++) {
        if (voxel.pieces[sub] <= 0) continue;
        if (!reserve(keysAt(this.piecePosition(voxel, sub), voxel.voxelSize))) {
          voxel.pieces[sub] = 0;
          this.overlapRemovals.shell++;
        }
      }
      voxel.alive = this.hasPieces(voxel);
    }
    const point = new THREE.Vector3();
    for (const piece of this.interiorPieces.slice(firstPiece)) {
      if (!piece.alive || piece.dimensions.signUv || piece.mesh.userData.dynamicVehicle) continue;
      const { nx, ny, nz } = piece.dimensions;
      const size = piece.dimensions.voxelSize ?? VOXEL_SIZE;
      piece.mesh.updateWorldMatrix(true, false);
      const matrix = piece.mesh.matrixWorld.elements;
      // Non-cardinal rotations cannot be represented exactly on the lattice.
      if ([0, 4, 8].some((column) => {
        const values = [matrix[column], matrix[column + 1], matrix[column + 2]];
        return values.filter((value) => Math.abs(value) > 0.001).length !== 1 ||
          values.some((value) => Math.abs(value) > 0.001 && Math.abs(Math.abs(value) - 1) > 0.001);
      })) continue;
      let changed = false;
      for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
        const sub = x + nx * (z + nz * y);
        if (!piece.mask[sub]) continue;
        point.set((x - (nx - 1) / 2) * size, (y - (ny - 1) / 2) * size,
          (z - (nz - 1) / 2) * size).applyMatrix4(piece.mesh.matrixWorld);
        const keys = keysAt(point, size);
        if (reserve(keys)) continue;
        this.preparePieceDamage(piece);
        piece.mask[sub] = 0;
        piece.health[sub] = 0;
        this.overlapRemovals.static++;
        changed = true;
      }
      if (!changed) continue;
      piece.mesh.userData.voxelMask = piece.mask;
      piece.alive = piece.mask.some(Boolean);
      if (piece.ownsGeometry) piece.mesh.geometry.dispose();
      piece.mesh.geometry = voxelSurfaceGeometry(nx, ny, nz, piece.mask, false, piece.palette, size);
      piece.ownsGeometry = true;
      piece.mesh.visible = piece.alive;
    }
  }

  private registerCityLights(roots: THREE.Object3D[]): void {
    for (const root of roots) root.traverse((object) => {
      const kind = object.userData.cityLight as CityLightAnchor['kind'] | undefined;
      if (!kind) return;
      this.lightAnchors.push({ object, position: object.getWorldPosition(new THREE.Vector3()),
        kind, color: object.userData.lightColor || (kind === 'signal' ? '#f58e72' : '#ffe0a4'),
        power: kind === 'interior' ? 18 : kind === 'signal' ? 6 : 28, range: kind === 'interior' ? 8 : 11 });
    });
  }

  cityLightActive(anchor: CityLightAnchor): boolean {
    if (!anchor.object.parent || !this.isWorldActive(anchor.position.x, anchor.position.z)) return false;
    if (anchor.object instanceof THREE.Mesh) {
      const piece = this.interiorPieceByMesh.get(anchor.object);
      return !piece || piece.alive;
    }
    let active = false;
    anchor.object.traverse((object) => {
      const piece = this.interiorPieceByMesh.get(object);
      if (piece?.alive) active = true;
    });
    return active;
  }

  scorchGround(x: number, z: number, radius: number): void {
    const mark = { x, z, radius: Math.max(0.3, radius) };
    this.groundMarks.push(mark);
    if (this.groundMarks.length > 128) this.groundMarks.shift();
    for (const ground of this.groundTiles) this.paintGroundMark(ground, mark);
  }

  private paintGroundMark(ground: THREE.Mesh, mark: GroundMark): void {
    const bounds = ground.userData.groundBounds as { x0: number; z0: number; width: number; depth: number; size: number } | undefined;
    const pixels = ground.userData.groundPixels as Uint8Array | undefined;
    if (!bounds || !pixels) return;
    const x0 = Math.max(0, Math.floor((mark.x - mark.radius - bounds.x0) / bounds.size));
    const x1 = Math.min(bounds.width - 1, Math.ceil((mark.x + mark.radius - bounds.x0) / bounds.size));
    const z0 = Math.max(0, Math.floor((mark.z - mark.radius - bounds.z0) / bounds.size));
    const z1 = Math.min(bounds.depth - 1, Math.ceil((mark.z + mark.radius - bounds.z0) / bounds.size));
    if (x0 > x1 || z0 > z1) return;
    for (let iz = z0; iz <= z1; iz++) for (let ix = x0; ix <= x1; ix++) {
      const worldX = bounds.x0 + (ix + 0.5) * bounds.size;
      const worldZ = bounds.z0 + (iz + 0.5) * bounds.size;
      const distance = Math.hypot(worldX - mark.x, worldZ - mark.z) / mark.radius;
      if (distance >= 1) continue;
      const grain = this.grid.hash(Math.floor(worldX / bounds.size), Math.floor(worldZ / bounds.size), 731);
      const soot = Math.max(0, 1 - distance * distance) * (0.44 + grain * 0.2);
      const at = (iz * bounds.width + ix) * 4;
      for (let channel = 0; channel < 3; channel++) pixels[at + channel] = Math.round(pixels[at + channel] * (1 - soot));
    }
    const material = ground.material as THREE.MeshStandardMaterial;
    if (material.map) material.map.needsUpdate = true;
  }

  /** Greedy-mesh every compatible static voxel piece by material and storey, regardless of prefab role. */
  private aggregateStaticSurfaces(roots: THREE.Object3D[]): void {
    const interiorGroups = new Set(this.interiorLodGroups);
    for (const root of roots) {
      if (!(root instanceof THREE.Group) || !root.userData.waitingForShell) continue;
      const groups = new Map<string, { pieces: InteriorPiece[]; container: THREE.Object3D }>();
      root.updateMatrixWorld(true);
      root.traverse((object) => {
        if (!(object instanceof THREE.Mesh) || object instanceof THREE.InstancedMesh || Array.isArray(object.material)) return;
        const piece = this.interiorPieceByMesh.get(object);
        const paint = object.material;
        if (!piece || !piece.alive || piece.palette || !(paint instanceof THREE.MeshStandardMaterial) || !paint.vertexColors || paint.map) return;
        // Only a unit, axis-aligned voxel lattice can be merged without altering a prefab's shape.
        const e = object.matrixWorld.elements;
        for (const column of [0, 4, 8]) {
          let length = 0;
          for (let row = 0; row < 3; row++) {
            const value = e[column + row];
            if (Math.abs(value - Math.round(value)) > 0.0001) return;
            length += value * value;
          }
          if (Math.abs(length - 1) > 0.0001) return;
        }
        const { nx, ny, nz } = piece.dimensions;
        const voxelSize = piece.dimensions.voxelSize ?? VOXEL_SIZE;
        const firstX = -(nx - 1) * voxelSize / 2, firstY = -(ny - 1) * voxelSize / 2, firstZ = -(nz - 1) * voxelSize / 2;
        const offsets: number[] = [];
        for (let axis = 0; axis < 3; axis++) {
          const world = e[12 + axis] + e[axis] * firstX + e[4 + axis] * firstY + e[8 + axis] * firstZ;
          const scaled = world / voxelSize;
          const integerAligned = Math.abs(scaled - Math.round(scaled)) < 0.001;
          const halfAligned = Math.abs(scaled - 0.5 - Math.round(scaled - 0.5)) < 0.001;
          if (!integerAligned && !halfAligned) return;
          offsets.push(integerAligned ? 0 : 0.5);
        }
        let child: THREE.Object3D = object;
        while (child.parent && child.parent !== root) child = child.parent;
        const container = interiorGroups.has(child as THREE.Group) ? child : root;
        const storey = Math.floor((piece.center.y + 0.001) / FLOOR_HEIGHT);
        const key = `${container.id}:${storey}:${paint.uuid}:${voxelSize}:${offsets.join(',')}`;
        let group = groups.get(key);
        if (!group) { group = { pieces: [], container }; groups.set(key, group); }
        group.pieces.push(piece);
      });
      for (const { pieces, container } of groups.values()) {
        if (pieces.length < 2) continue;
        const cells: number[] = [];
        const voxelSize = pieces[0].dimensions.voxelSize ?? VOXEL_SIZE;
        const latticeOffset: [number, number, number] = (() => {
          const piece = pieces[0], { nx, ny, nz } = piece.dimensions, e = piece.mesh.matrixWorld.elements;
          const local = [-(nx - 1) * voxelSize / 2, -(ny - 1) * voxelSize / 2, -(nz - 1) * voxelSize / 2];
          return [0, 1, 2].map((axis) => {
            const world = e[12 + axis] + e[axis] * local[0] + e[4 + axis] * local[1] + e[8 + axis] * local[2];
            return Math.abs(world / voxelSize - Math.round(world / voxelSize)) < 0.001 ? 0 : 0.5;
          }) as [number, number, number];
        })();
        for (const piece of pieces) {
          const { nx, ny, nz } = piece.dimensions;
          const e = piece.mesh.matrixWorld.elements;
          for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
            if (!piece.mask[x + nx * (z + nz * y)]) continue;
            const lx = (x - (nx - 1) / 2) * voxelSize;
            const ly = (y - (ny - 1) / 2) * voxelSize;
            const lz = (z - (nz - 1) / 2) * voxelSize;
            const worldX = e[0] * lx + e[4] * ly + e[8] * lz + e[12];
            const worldY = e[1] * lx + e[5] * ly + e[9] * lz + e[13];
            const worldZ = e[2] * lx + e[6] * ly + e[10] * lz + e[14];
            cells.push(Math.round(worldX / voxelSize - latticeOffset[0]), Math.round(worldY / voxelSize - latticeOffset[1]),
              Math.round(worldZ / voxelSize - latticeOffset[2]), 1, 1, 1);
          }
        }
      const surface = meshVoxelCells(Float32Array.from(cells), new Uint32Array(cells.length / 6), true);
      const originalTriangles = pieces.reduce((sum, piece) => sum + (piece.mesh.geometry.index?.count ?? piece.mesh.geometry.getAttribute('position').count) / 3, 0);
      if (surface.quads * 2 >= originalTriangles * 0.9) continue;
      for (let i = 0; i < surface.positions.length; i++) {
        const axis = i % 3;
        surface.positions[i] = (surface.positions[i] + latticeOffset[axis] - 0.5) * voxelSize;
      }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(surface.positions, 3));
        geometry.setAttribute('normal', new THREE.BufferAttribute(surface.normals, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(surface.colors, 3));
        geometry.setIndex(new THREE.BufferAttribute(surface.indexes, 1));
        geometry.computeBoundingSphere();
        const first = pieces[0].mesh;
        const aggregate = new THREE.Mesh(geometry, first.material);
        aggregate.castShadow = pieces.some((piece) => piece.mesh.castShadow);
        aggregate.receiveShadow = true;
        aggregate.userData.aggregateSurface = true;
        aggregate.userData.surfaceKind = pieces.every((piece) => piece.mesh.userData.floorLevel !== undefined) ? 'floor' : 'detail';
        aggregate.userData.surfaceStats = { originalTriangles, triangles: surface.quads * 2 };
        container.add(aggregate);
        aggregate.position.y = -container.getWorldPosition(new THREE.Vector3()).y;
        this.aggregatePiecesByMesh.set(aggregate, pieces);
        const state = { mesh: aggregate, pieces };
        for (const piece of pieces) { piece.aggregate = state; piece.mesh.visible = false; }
      }
    }
  }

  private queueShellRegion(assets: BlockAssets, region: ShellRegion): void {
    if (region.pendingRevision !== null || !region.dirty || this.meshRequests.size >= 2) return;
    const bounds = this.grid.blockBounds(assets.bx, assets.bz);
    const x0 = bounds.x0 + region.rx * SHELL_REGION_CELLS;
    const x1 = Math.min(bounds.x1, x0 + SHELL_REGION_CELLS);
    const z0 = bounds.z0 + region.rz * SHELL_REGION_CELLS;
    const z1 = Math.min(bounds.z1, z0 + SHELL_REGION_CELLS);
    // Include a one-cell halo so faces touching another remesh region are
    // occluded correctly. Only faces whose owner lies inside this region draw.
    const haloVoxels = new Set<number>(region.voxelIndexes);
    for (let z = z0 - 1; z <= z1; z++) for (let x = x0 - 1; x <= x1; x++) {
      for (const index of this.voxelsByCell.get(this.grid.index(x, z)) || []) {
        if (index >= assets.firstVoxel && index < assets.lastVoxel) haloVoxels.add(index);
      }
    }
    let count = 0;
    for (const index of haloVoxels) {
      const voxel = this.voxels[index];
      if (voxel.alive) for (const health of voxel.pieces) if (health > 0) count++;
    }
    const pieces = new Float32Array(count * 6);
    const references = new Uint32Array(count);
    const renderOwners = new Uint8Array(count);
    let next = 0;
    for (const index of haloVoxels) {
      const voxel = this.voxels[index];
      if (!voxel.alive) continue;
      const cell = this.grid.cells[voxel.cellIndex];
      const renderOwner = cell && cell.x >= x0 && cell.x < x1 && cell.z >= z0 && cell.z < z1;
      for (let sub = 0; sub < voxel.pieces.length; sub++) {
        if (voxel.pieces[sub] <= 0) continue;
        const offset = sub * 3, base = next * 6;
        const baseHealth = voxel.roof ? 1.1 : voxel.structural === false ? 0.7 : 0.78;
        const damageShade = voxel.pieces[sub] < baseHealth - 0.001 ? 0.82 : 1;
        pieces[base] = voxel.x + voxel.positions[offset];
        pieces[base + 1] = voxel.y + voxel.positions[offset + 1];
        pieces[base + 2] = voxel.z + voxel.positions[offset + 2];
        pieces[base + 3] = voxel.color.r * damageShade;
        pieces[base + 4] = voxel.color.g * damageShade;
        pieces[base + 5] = voxel.color.b * damageShade;
        references[next] = index;
        renderOwners[next] = Number(renderOwner);
        next++;
      }
    }
    if (!count || !next) {
      if (region.mesh) {
        this.buildings.remove(region.mesh);
        region.mesh.geometry.dispose();
        region.mesh = null;
      }
      region.ready = true;
      region.dirty = false;
      this.showShellDecorationsWhenReady(assets);
      return;
    }
    const id = this.nextMeshRequest++;
    region.pendingRevision = region.revision;
    this.meshRequests.set(id, { assets, region, revision: region.revision });
    const voxelSize = this.voxels[region.voxelIndexes[0]]?.voxelSize ?? CITY_VOXEL_SIZE;
    this.meshWorker.postMessage({ id, pieces, references, renderOwners, voxelSize, latticeOffset: [0, 0.5, 0] },
      [pieces.buffer, references.buffer, renderOwners.buffer]);
  }

  private receiveFarMesh(data: FarMeshResult): void {
    const request = this.meshRequests.get(data.id);
    if (!request) return;
    this.meshRequests.delete(data.id);
    const { assets, region, revision } = request;
    region.pendingRevision = null;
    if (revision !== region.revision || !assets.active) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.indexes, 1));
    geometry.userData.voxelForFace = data.voxelForFace;
    geometry.userData.surfaceStats = { exposedFaces: data.exposedFaces, quads: data.quads };
    geometry.computeBoundingSphere();
    if (region.mesh) {
      // Preserve the render object identity while replacing just its geometry;
      // raycasts and interaction references can safely survive a local remesh.
      region.mesh.geometry.dispose();
      region.mesh.geometry = geometry;
    } else region.mesh = new THREE.Mesh(geometry, this.shellMaterial);
    region.mesh.castShadow = true;
    region.mesh.receiveShadow = true;
    region.ready = true;
    region.dirty = false;
    const regionsReady = this.showShellDecorationsWhenReady(assets);
    if (assets.active) {
      this.buildings.add(region.mesh);
      assets.mode = regionsReady ? 'far' : 'near';
    }
  }

  private showShellDecorationsWhenReady(assets: BlockAssets): boolean {
    const ready = [...assets.regions.values()].every((region) => region.ready);
    if (ready) assets.props.traverse((object) => {
      if (object.userData.waitingForShell) { object.visible = true; object.userData.waitingForShell = false; }
    });
    return ready;
  }

  flushFarMeshes(): void {
    const pending = [...this.blockAssets.values()].filter((assets) => assets.active);
    pending.sort((a, b) => a.distance - b.distance);
    for (const assets of pending) {
      for (const region of assets.regions.values()) {
        this.queueShellRegion(assets, region);
        if (this.meshRequests.size >= 2) return;
      }
    }
  }

  private roadMarkings(bounds: BlockBounds): Array<{ x: number; z: number; w: number; d: number; paint: string }> {
    const [x0, z0] = this.grid.world(bounds.x0, bounds.z0);
    const centerX = x0 + this.grid.cellSize;
    const centerZ = z0 + this.grid.cellSize;
    const marks: Array<{ x: number; z: number; w: number; d: number; paint: string }> = [];
    for (let z = bounds.z0 + 3; z < bounds.z1 - 1; z += 3) marks.push({ x: centerX, z: this.grid.world(bounds.x0, z)[1], w: VOXEL_SIZE * 1.3, d: 0.9, paint: '#f4de9c' });
    for (let x = bounds.x0 + 3; x < bounds.x1 - 1; x += 3) marks.push({ x: this.grid.world(x, bounds.z0)[0], z: centerZ, w: 0.9, d: VOXEL_SIZE * 1.3, paint: '#f4de9c' });
    const walkZ = this.grid.world(bounds.x0, bounds.z0 + 1)[1];
    const walkX = this.grid.world(bounds.x0 + 1, bounds.z0)[0];
    for (let stripe = 0; stripe < 6; stripe++) {
      const offset = (stripe - 2.5) * 0.62;
      marks.push({ x: centerX + offset, z: walkZ, w: 0.38, d: 1.13, paint: '#fff4dc' });
      marks.push({ x: walkX, z: centerZ + offset, w: 1.13, d: 0.38, paint: '#fff4dc' });
    }
    if (this.grid.hash(bounds.bx, bounds.bz, 95) > 0.55) {
      const mz = this.grid.world(bounds.x0, bounds.z0 + 5)[1];
      marks.push({ x: centerX, z: mz, w: 0.72, d: 0.86, paint: '#91a29f' });
      marks.push({ x: centerX, z: mz, w: 0.55, d: 0.69, paint: '#2b424c' });
    }
    return marks;
  }

  private drawTiles(cells: Cell[], bounds: BlockBounds): void {
    const profile = this.grid.blockProfile(bounds.bx, bounds.bz);
    // The asphalt continues across chunk boundaries. Building palettes may
    // change per block, but a road must not acquire a rectangular color seam.
    const roadPaint = '#42525d';
    const walkPaint = ['#ddd1b9', '#d4d2c4', '#d9c6b6', '#d5d5bd'][profile.palette];
    const grassPaint = ['#78bd5b', '#8cc96e', '#65b786', '#a2c65b'][profile.palette];
    const lotPaint = profile.district === 'industrial' ? '#c4b19a' : ['#d3bca0', '#c9baa8', '#d3bea6', '#cbbfa3'][profile.palette];
    const width = (bounds.x1 - bounds.x0) * CITY_VOXELS_PER_CELL;
    const depth = (bounds.z1 - bounds.z0) * CITY_VOXELS_PER_CELL;
    const pixels = new Uint8Array(width * depth * 4);
    const marks = this.roadMarkings(bounds);
    const palette = new Map<string, THREE.Color>();
    const paint = (hex: string) => {
      let result = palette.get(hex);
      if (!result) { result = new THREE.Color(hex).convertLinearToSRGB(); palette.set(hex, result); }
      return result;
    };
    const cellWidth = bounds.x1 - bounds.x0, cellDepth = bounds.z1 - bounds.z0;
    const heights = new Float32Array(cellWidth * cellDepth).fill(NaN);
    const edges: Array<{ x: number; z: number; dx: number; dz: number }> = [];
    for (const cell of cells) {
      const [x, z] = this.grid.world(cell.x, cell.z);
      const cx = (cell.x - bounds.x0) * CITY_VOXELS_PER_CELL, cz = (cell.z - bounds.z0) * CITY_VOXELS_PER_CELL;
      const parkPath = cell.tile === 'park' && this.grid.parkPathAt(bounds, cell.x, cell.z);
      for (let iz = 0; iz < CITY_VOXELS_PER_CELL; iz++) for (let ix = 0; ix < CITY_VOXELS_PER_CELL; ix++) {
        const px = x + (ix - (CITY_VOXELS_PER_CELL - 1) / 2) * CITY_VOXEL_SIZE;
        const pz = z + (iz - (CITY_VOXELS_PER_CELL - 1) / 2) * CITY_VOXEL_SIZE;
        let hex = cell.tile === 'road' ? roadPaint : cell.tile === 'sidewalk' ? walkPaint : cell.tile === 'park' ? grassPaint : lotPaint;
        if (parkPath) hex = profile.parkStyle === 'plaza' ? '#e1cfb3' : '#dccbab';
        else if (cell.tile === 'park' && this.grid.hash(cell.x, cell.z, 205) > 0.8) hex = ['#8bcf70', '#a0d38b', '#71c18a', '#b0cf69'][profile.palette];
        if (cell.tile === 'road') for (const mark of marks) if (Math.abs(px - mark.x) <= mark.w / 2 && Math.abs(pz - mark.z) <= mark.d / 2) hex = mark.paint;
        const worldVoxelX = cell.x * CITY_VOXELS_PER_CELL + ix;
        const worldVoxelZ = cell.z * CITY_VOXELS_PER_CELL + iz;
        // Low-frequency color drift gives asphalt, paving and lawns a soft
        // material grain without drawing a hard square around every voxel.
        const patchTone = this.grid.hash(Math.floor(worldVoxelX / 4), Math.floor(worldVoxelZ / 4), 208);
        const grain = this.grid.hash(worldVoxelX, worldVoxelZ, 209);
        const variation = cell.tile === 'road' ? 0.075 : cell.tile === 'park' ? 0.065 : 0.05;
        let tone = 1 + (patchTone - 0.5) * variation + (grain - 0.5) * 0.016;
        const pavingRow = Math.floor(worldVoxelZ / 4);
        const stagger = pavingRow % 2 ? 3 : 0;
        const paverJoint = (cell.tile === 'sidewalk' || parkPath) &&
          (worldVoxelZ % 4 === 0 || (worldVoxelX + stagger) % 6 === 0);
        if (paverJoint) tone *= 0.945;
        const rgb = paint(hex);
        const at = ((cz + iz) * width + cx + ix) * 4;
        pixels[at] = Math.min(255, rgb.r * 255 * tone); pixels[at + 1] = Math.min(255, rgb.g * 255 * tone); pixels[at + 2] = Math.min(255, rgb.b * 255 * tone); pixels[at + 3] = 255;
      }
      heights[(cell.z - bounds.z0) * cellWidth + cell.x - bounds.x0] = cell.tile === 'road' ? 0 : 0.07;
      if (cell.tile !== 'road') for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        if (this.grid.cell(cell.x + dx, cell.z + dz)?.tile === 'road') edges.push({ x, z, dx, dz });
      }
    }
    const texture = new THREE.DataTexture(pixels, width, depth);
    texture.colorSpace = THREE.SRGBColorSpace; texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter; texture.generateMipmaps = true; texture.needsUpdate = true;
    const [firstX, firstZ] = this.grid.world(bounds.x0, bounds.z0);
    const cutouts=[...this.grid.surfaces.surfaces.values()].filter(s=>s.solid);
    if(bounds.bx===this.grid.terrain.canalColumn) {
      const canal=this.grid.terrain.canalBounds();
      cutouts.push({id:'canal',kind:'promenade',height:0,x0:canal.x0-2.2,x1:canal.x1+2.2,
        z0:firstZ+this.grid.cellSize*2.5,z1:firstZ+cellDepth*this.grid.cellSize-this.grid.cellSize/2});
    }
    const surface = meshTerrainSurface(cellWidth, cellDepth, heights, this.grid.cellSize,
      firstX - this.grid.cellSize / 2, firstZ - this.grid.cellSize / 2,
      (x,z)=>this.grid.terrain.height(x,z),()=>false,cutouts);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(surface.positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(surface.uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(surface.indexes, 1));
    geometry.computeVertexNormals(); geometry.computeBoundingSphere();
    geometry.userData.surfaceStats = { cells: cells.length, quads: surface.quads };
    const ground = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ map: texture, roughness: 1 }));
    ground.name = 'chunk-ground'; ground.receiveShadow = true; ground.visible = this.groundVisible;
    ground.userData.groundPixels = pixels;
    ground.userData.groundBounds = { x0: firstX - this.grid.cellSize / 2, z0: firstZ - this.grid.cellSize / 2,
      width, depth, size: CITY_VOXEL_SIZE };
    for (const mark of this.groundMarks) this.paintGroundMark(ground, mark);
    this.groundTiles.push(ground); this.scene.add(ground);
    if (edges.length) {
      const curbs = new THREE.InstancedMesh(this.curbGeometry, this.tileMaterial, edges.length);
      for (let i = 0; i < edges.length; i++) {
        const { x, z, dx, dz } = edges[i];
        this.dummy.position.set(x + dx * this.grid.cellSize / 2, this.grid.terrain.height(x + dx * this.grid.cellSize / 2,z + dz * this.grid.cellSize / 2) + 0.035, z + dz * this.grid.cellSize / 2);
        this.dummy.rotation.set(0, dx ? dx * Math.PI / 2 : dz > 0 ? 0 : Math.PI, 0);
        this.dummy.scale.setScalar(1); this.dummy.updateMatrix(); curbs.setMatrixAt(i, this.dummy.matrix);
      }
      curbs.receiveShadow = true; curbs.visible = this.groundVisible;
      this.groundTiles.push(curbs); this.scene.add(curbs);
    }
  }

  /** Reserve entrances before any street or courtyard props are placed. */
  private accessiblePlans(bounds: BlockBounds, candidates: BuildingPlan[]): BuildingPlan[] {
    for (const plan of candidates) {
      const direction = frontageDirection(plan), front = frontageZ(plan);
      const target = direction > 0 ? bounds.z1 - 1 : bounds.z0 + 3;
      const doorX = plan.x + Math.floor(plan.width / 2);
      for (let z = front + direction; direction > 0 ? z <= target : z >= target; z += direction) {
        const doors = [doorX, ...(buildingPrefab(plan.type).facade.loadingBay && plan.width >= 6 ? [plan.x + 1] : [])];
        for (const door of doors) for (let x = door - 1; x <= door + 1; x++) this.entranceApproaches.add(this.grid.index(x, z));
      }
    }
    return candidates;
  }

  private entranceClear(cell: Cell | undefined): boolean {
    return !!cell && !this.entranceApproaches.has(this.grid.index(cell.x, cell.z));
  }

  private createBuilding(plan: BuildingPlan): void {
    const prefab = buildingPrefab(plan.type);
    if (plan.width < prefab.minimumFootprintCells || plan.depth < prefab.minimumFootprintCells) plan = { ...plan, height: 2 };
    const firstVoxel = this.voxels.length;
    const firstStation = this.interiorStations.length, firstStair = this.staircases.length;
    const baseY = this.grid.terrain.plateau(this.grid.blockAt(plan.x,plan.z).bx,this.grid.blockAt(plan.x,plan.z).bz);
    const firstSceneChild = this.scene.children.length;
    const district = districtForType(plan.type);
    const main = this.facadePaint(district, plan.x, plan.z);
    const doorX = plan.x + Math.floor(plan.width / 2);
    const frontZ = frontageZ(plan);
    const architecture = buildingArchitecture(plan);
    const roofStair = stairBay(plan);
    const interior = { x0: plan.x, x1: plan.x + plan.width, z0: plan.z, z1: plan.z + plan.depth, upper: [] as number[] };
    for (let z = plan.z; z < plan.z + plan.depth; z++) for (let x = plan.x; x < plan.x + plan.width; x++) {
      const cell = this.grid.cell(x, z)!;
      const edge = x === plan.x || z === plan.z || x === plan.x + plan.width - 1 || z === plan.z + plan.depth - 1;
      const entrance = x === doorX && z === frontZ;
      const loadingBay = prefab.facade.loadingBay && plan.width >= 6 && x === plan.x + 1 && z === frontZ;
      cell.blocked = edge && !entrance && !loadingBay;
      const columnHeight = architecture.roofLevel(x, z) + 1;
      for (let y = 0; y < columnHeight; y++) {
        const roof = y === columnHeight - 1;
        if (y === 0 && !edge) continue;
        const wallMask = roof ? 0 : architecture.wallMask(x, z, y);
        if (!roof && !wallMask) continue;
        // Keep a real two-cell exit through the destructible roof shell.
        if (roof && x === roofStair.x && (z === roofStair.z0 || z === roofStair.z1)) continue;
        if (y === 0 && (entrance || loadingBay)) {
          if (entrance) this.addEntrance(x, z, plan);
          if (loadingBay) this.addLoadingBay(x, z, plan);
          continue;
        }
        const [wx, wz] = this.grid.world(x, z);
        const voxelColor = roof ? color(district === 'residential' ? roofColors[plan.variant % roofColors.length] : district === 'industrial' ? ['#596f70', '#727e78', '#8b8171'][plan.variant % 3] : ['#50727a', '#bf8a76', '#7a9d96', '#b5a280'][plan.variant % 4]) : main.clone();
        const positions = modulePositions(roof, wallMask, CITY_VOXELS_PER_FLOOR);
        const edgePositions = roof ? roofParapetPositions(plan, x, z, Math.max(2, prefab.roof.parapetVoxels)) : new Float32Array(0);
        const storyHeight = storeyHeight(prefab);
        // The pale floor-line trim is a row of the same destructible shell
        // voxels. It replaces the old coplanar fascia overlay.
        let wallPositions = positions;
        let bandPositions = new Float32Array(0);
        if (!roof && positions.length) {
          const wall: number[] = [], band: number[] = [];
          const bandY = ((CITY_VOXELS_PER_FLOOR - 1) / 2) * CITY_VOXEL_SIZE;
          for (let offset = 0; offset < positions.length; offset += 3) {
            const target = Math.abs(positions[offset + 1] - bandY) < 0.001 ? band : wall;
            target.push(positions[offset], positions[offset + 1], positions[offset + 2]);
          }
          wallPositions = Float32Array.from(wall);
          bandPositions = Float32Array.from(band);
        }
        const addShellVoxel = (piecePositions: Float32Array, pieceColor: THREE.Color, isRoof = roof): number => {
          const voxelIndex = this.voxels.length;
          this.voxels.push({ x: wx, y: storyHeight / 2 + y * storyHeight, z: wz, alive: true, hp: roof ? 1.4 : 2.4,
            cellIndex: this.grid.index(x, z), color: pieceColor, voxelSize: CITY_VOXEL_SIZE, details: [], positions: piecePositions,
            pieces: new Float32Array(piecePositions.length / 3).fill(roof ? 1.1 : 0.78), damaged: false, roof: isRoof, buildingUse: plan.type });
          if (!this.voxelsByCell.has(this.grid.index(x, z))) this.voxelsByCell.set(this.grid.index(x, z), []);
          this.voxelsByCell.get(this.grid.index(x, z))!.push(voxelIndex);
          return voxelIndex;
        };
        const index = addShellVoxel(wallPositions, voxelColor);
        if (y > 0) interior.upper.push(index);
        if (edgePositions.length) {
          const edgeIndex = addShellVoxel(edgePositions, color(FACADE_BAND_COLOR), false);
          if (y > 0) interior.upper.push(edgeIndex);
        }
        if (bandPositions.length) {
          const bandIndex = addShellVoxel(bandPositions, color(FACADE_BAND_COLOR));
          if (y > 0) interior.upper.push(bandIndex);
        }
        if (!roof) {
          const storefront = y === 0 && district === 'commercial';
          for (const direction of WALL_DIRECTIONS) {
            if (!(wallMask & direction.bit)) continue;
            const door = architecture.doors.some((d) => d.x === x && d.z === z && d.level === y && d.face === direction.bit);
            if (door) this.carveTerraceDoor(this.voxels[index], direction.bit);
            else if ((direction.dx ? z : x) % 2 === 0 || y === 0)
              this.addWindow(index, direction.bit === 1 ? 'left' : direction.bit === 2 ? 'x' : direction.bit === 4 ? 'back' : 'z', district, storefront, plan.variant);
          }
        }
      }
    }
    this.addRoofDetail(plan);
    this.interiorAreas.push(interior);
    const interiorStart = this.scene.children.length;
    const occupied = this.addInterior(plan);
    this.addUpperInteriors(plan);
    const interiorDetails = new THREE.Group();
    for (const object of this.scene.children.slice(interiorStart)) interiorDetails.add(object);
    this.scene.add(interiorDetails);
    this.interiorLodGroups.push(interiorDetails);
    this.addFacadeDetails(plan);
    const approach = this.grid.cell(doorX, frontZ + frontageDirection(plan)) || this.grid.cell(doorX, frontZ);
    if (approach && !approach.blocked) this.pedestrianAnchors.push({ cell: approach, type: plan.type, district });
    if (prefab.facade.loadingBay && plan.width >= 6) {
      const bayApproach = this.grid.cell(plan.x + 1, frontZ + frontageDirection(plan));
      if (bayApproach && !bayApproach.blocked) this.pedestrianAnchors.push({ cell: bayApproach, type: plan.type, district });
    }
    const decorations = new THREE.Group();
    for (const object of this.scene.children.slice(firstSceneChild)) decorations.add(object);
    decorations.position.y = baseY;
    for(let i=firstVoxel;i<this.voxels.length;i++){this.voxels[i].y+=baseY;this.voxels[i].baseY=baseY;}
    for(let i=firstStation;i<this.interiorStations.length;i++)this.interiorStations[i].position.y+=baseY;
    for(let i=firstStair;i<this.staircases.length;i++)this.staircases[i].position.y+=baseY;
    decorations.traverse(o=>{if(o.userData.roofSupportY!==undefined)o.userData.roofSupportY+=baseY;});
    decorations.userData.waitingForShell = true;
    decorations.visible = false;
    this.scene.add(decorations);
    this.buildingDecorations.push({ first: firstVoxel, last: this.voxels.length, group: decorations, occupied });
  }

  refreshDecorations(): InteriorPiece[] {
    const collapsed: InteriorPiece[] = [];
    for (const building of this.buildingDecorations) {
      if (!building.group.visible) continue;
      let supported = false;
      for (let index = building.first; index < building.last; index++) {
        const voxel = this.voxels[index];
        if (voxel.alive && voxel.structural !== false && !voxel.roof && voxel.y - (voxel.baseY ?? 0) < FLOOR_HEIGHT) { supported = true; break; }
      }
      if (supported) continue;
      building.group.traverse((object) => {
        const piece = this.interiorPieceByMesh.get(object);
        if (piece?.alive) collapsed.push(piece);
      });
      building.group.visible = false;
      for (const index of building.occupied) {
        this.grid.cells[index].blocked = false;
        this.navigationChanges.add(index);
      }
    }
    return collapsed;
  }

  attachedPieces(voxel: Voxel): InteriorPiece[] {
    const pieces: InteriorPiece[] = [];
    for (const detail of voxel.details) detail.traverse((object) => {
      const piece = this.interiorPieceByMesh.get(object);
      if (piece?.alive) pieces.push(piece);
    });
    return pieces;
  }

  takeNavigationChanges(): number[] {
    const cells = [...this.navigationChanges];
    this.navigationChanges.clear();
    return cells;
  }

  interiorPieceForHit(hit: THREE.Intersection): InteriorPiece | undefined {
    if (hit.instanceId !== undefined && hit.object instanceof THREE.InstancedMesh) return this.scenePieceByBatch.get(hit.object)?.[hit.instanceId];
    if (hit.object.userData.aggregateSurface && hit.face) {
      const surface = hit.object as THREE.Mesh;
      const owners = surface.geometry.userData.decorationPieceForFace as Uint32Array | undefined;
      const pieces = this.aggregatePiecesByMesh.get(surface);
      if (owners && pieces && hit.faceIndex !== undefined && hit.faceIndex !== null) {
        const owner = owners[hit.faceIndex];
        if (owner !== undefined && owner < pieces.length) return pieces[owner];
      }
      const normal = hit.face.normal.clone().transformDirection(surface.matrixWorld);
      const state = pieces?.find((piece) => {
        const size = piece.dimensions.voxelSize ?? VOXEL_SIZE;
        return piece.alive && piece.bounds.containsPoint(hit.point.clone().addScaledVector(normal, -size * 0.08));
      });
      if (state) return state;
    }
    return this.interiorPieceByMesh.get(hit.object);
  }

  interiorVoxelForHit(hit: THREE.Intersection): number | null {
    const piece = this.interiorPieceForHit(hit);
    if (!piece || !hit.face) return null;
    piece.mesh.updateWorldMatrix(true, false);
    const normal = hit.object.userData.aggregateSurface
      ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld).transformDirection(piece.mesh.matrixWorld.clone().invert())
      : hit.face.normal;
    const voxelSize = piece.dimensions.voxelSize ?? VOXEL_SIZE;
    const point = piece.mesh.worldToLocal(hit.point.clone()).addScaledVector(normal, -voxelSize * 0.01);
    const { nx, ny, nz } = piece.dimensions;
    const x = Math.max(0, Math.min(nx - 1, Math.floor(point.x / voxelSize + nx / 2)));
    const y = Math.max(0, Math.min(ny - 1, Math.floor(point.y / voxelSize + ny / 2)));
    const z = Math.max(0, Math.min(nz - 1, Math.floor(point.z / voxelSize + nz / 2)));
    const sub = x + nx * (z + nz * y);
    return piece.mask[sub] ? sub : null;
  }

  sceneVoxelPosition(piece: InteriorPiece, sub: number): THREE.Vector3 {
    const { nx, ny, nz } = piece.dimensions;
    const voxelSize = piece.dimensions.voxelSize ?? VOXEL_SIZE;
    const x = sub % nx, z = Math.floor(sub / nx) % nz, y = Math.floor(sub / (nx * nz));
    piece.mesh.updateWorldMatrix(true, false);
    return piece.mesh.localToWorld(new THREE.Vector3((x - (nx - 1) / 2) * voxelSize,
      (y - (ny - 1) / 2) * voxelSize, (z - (nz - 1) / 2) * voxelSize));
  }

  sceneVoxelsInRadius(piece: InteriorPiece, center: THREE.Vector3, radius: number): Array<{ sub: number; point: THREE.Vector3 }> {
    const { nx, ny, nz } = piece.dimensions;
    const voxelSize = piece.dimensions.voxelSize ?? VOXEL_SIZE;
    piece.mesh.updateWorldMatrix(true, false);
    const local = piece.mesh.worldToLocal(center.clone());
    const range = radius / voxelSize;
    const low = (coordinate: number, count: number) => Math.max(0, Math.floor(coordinate / voxelSize + count / 2 - range));
    const high = (coordinate: number, count: number) => Math.min(count - 1, Math.ceil(coordinate / voxelSize + count / 2 + range));
    const result: Array<{ sub: number; point: THREE.Vector3 }> = [];
    for (let iy = low(local.y, ny); iy <= high(local.y, ny); iy++) {
      for (let iz = low(local.z, nz); iz <= high(local.z, nz); iz++) {
        for (let ix = low(local.x, nx); ix <= high(local.x, nx); ix++) {
          const sub = ix + nx * (iz + nz * iy);
          if (!piece.mask[sub]) continue;
          const point = new THREE.Vector3((ix - (nx - 1) / 2) * voxelSize,
            (iy - (ny - 1) / 2) * voxelSize, (iz - (nz - 1) / 2) * voxelSize).applyMatrix4(piece.mesh.matrixWorld);
          if (Math.hypot(point.x - center.x, point.z - center.z, (point.y - center.y) * 0.72) <= radius) result.push({ sub, point });
        }
      }
    }
    return result;
  }

  private pieceOccupies(piece: InteriorPiece, x: number, y: number, z: number): boolean {
    const point = piece.mesh.worldToLocal(new THREE.Vector3(x, y, z));
    const { nx, ny, nz } = piece.dimensions;
    const voxelSize = piece.dimensions.voxelSize ?? VOXEL_SIZE;
    const ix = Math.floor(point.x / voxelSize + nx / 2);
    const iy = Math.floor(point.y / voxelSize + ny / 2);
    const iz = Math.floor(point.z / voxelSize + nz / 2);
    return ix >= 0 && ix < nx && iy >= 0 && iy < ny && iz >= 0 && iz < nz && !!piece.mask[ix + nx * (iz + nz * iy)];
  }

  preparePieceDamage(piece: InteriorPiece): void {
    if (piece.ownsState) return;
    piece.health = piece.health.slice(); piece.mask = piece.mask.slice(); piece.ownsState = true;
  }

  eraseSceneVoxels(piece: InteriorPiece, subs: readonly number[]): void {
    if (!subs.length || !piece.alive) return;
    this.preparePieceDamage(piece);
    if (piece.aggregate) {
      const { mesh, pieces } = piece.aggregate;
      mesh.parent?.remove(mesh);
      mesh.geometry.dispose();
      for (const entry of pieces) { entry.aggregate = undefined; entry.mesh.visible = entry.alive; }
    }
    if (piece.batch) {
      const { mesh, index, parent } = piece.batch;
      mesh.getMatrixAt(index, this.dummy.matrix);
      this.dummy.position.setFromMatrixPosition(this.dummy.matrix);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.setScalar(0.0001);
      this.dummy.updateMatrix();
      mesh.setMatrixAt(index, this.dummy.matrix);
      mesh.instanceMatrix.needsUpdate = true;
      parent.add(piece.mesh);
      piece.mesh.visible = true;
      piece.batch = undefined;
    }
    for (const sub of subs) {
      if (sub < 0 || sub >= piece.mask.length) continue;
      piece.mask[sub] = 0;
      piece.health[sub] = 0;
    }
    if(piece.mesh.userData.walkSurfaceIds) {
      const [x0,z0]=this.grid.grid(piece.bounds.min.x,piece.bounds.min.z),[x1,z1]=this.grid.grid(piece.bounds.max.x,piece.bounds.max.z);
      for(let z=z0;z<=z1;z++)for(let x=x0;x<=x1;x++)this.navigationChanges.add(this.grid.index(x,z));
    }
    piece.alive = piece.mask.some((value) => value !== 0);
    const voxelSize = piece.dimensions.voxelSize ?? VOXEL_SIZE;
    if (piece.ownsGeometry) piece.mesh.geometry.dispose();
    if (piece.alive) {
      const { nx, ny, nz, signUv } = piece.dimensions;
      piece.mesh.geometry = voxelSurfaceGeometry(nx, ny, nz, piece.mask, signUv, piece.palette, voxelSize, piece.dimensions.suppressBottomBoundary);
      piece.ownsGeometry = true;
    } else {
      piece.mesh.visible = false;
      const cell = this.grid.cellAtWorld(piece.center.x, piece.center.z);
      if (cell?.blocked) {
        const index = this.grid.index(cell.x, cell.z);
        const insideBuilding = this.interiorAreas.some((area) => cell.x >= area.x0 && cell.x < area.x1 && cell.z >= area.z0 && cell.z < area.z1);
        const occupants = this.interiorPiecesByCell.get(index) || [];
        const clear = insideBuilding ? piece.groundObstacle && !occupants.some((other) => other.alive && other.groundObstacle)
          : !occupants.some((other) => other.alive);
        if (clear) { cell.blocked = false; this.navigationChanges.add(index); }
      }
    }
  }

  interiorPiecesNear(x: number, z: number, radius: number): InteriorPiece[] {
    const [gx, gz] = this.grid.grid(x, z);
    const cells = Math.ceil(radius / this.grid.cellSize) + 1;
    const pieces: InteriorPiece[] = [];
    for (let dz = -cells; dz <= cells; dz++) for (let dx = -cells; dx <= cells; dx++) {
      const cell = this.grid.cell(gx + dx, gz + dz);
      if (!cell) continue;
      for (const piece of this.interiorPiecesByCell.get(this.grid.index(cell.x, cell.z)) || []) {
        const half = Math.max(piece.bounds.max.x - piece.bounds.min.x, piece.bounds.max.z - piece.bounds.min.z) / 2;
        if (piece.alive && Math.hypot(piece.center.x - x, piece.center.z - z) < radius + half) pieces.push(piece);
      }
    }
    // Reject a vehicle as one object before touching all of its component transforms.
    for (const vehicle of this.vehicles) {
      if (!vehicle.parent || vehicle.userData.destroyed || Math.hypot(vehicle.position.x - x, vehicle.position.z - z) > radius + 8) continue;
      vehicle.updateWorldMatrix(true, true);
      for (const piece of this.vehicleParts.get(vehicle) || []) {
        if (!piece.alive || !piece.mesh.parent?.visible) continue;
        piece.mesh.getWorldPosition(piece.center);
        if (Math.hypot(piece.center.x - x, piece.center.z - z) > radius + 4) continue;
        piece.bounds.setFromObject(piece.mesh); pieces.push(piece);
      }
    }
    return pieces;
  }

  interiorMeshesNear(x: number, z: number, radius: number): THREE.Mesh[] {
    const meshes = new Set<THREE.Mesh>();
    for (const piece of this.interiorPiecesNear(x, z, radius)) {
      if (piece.batch) { meshes.add(piece.batch.mesh); continue; }
      if (piece.mesh.visible && piece.mesh.parent?.visible !== false && piece.mesh.parent?.parent?.visible !== false &&
        piece.mesh.parent?.parent?.parent?.visible !== false) meshes.add(piece.mesh);
    }
    return [...meshes];
  }

  stationIntact(station: InteriorStation): boolean {
    return station.group.children.some((child) => this.interiorPieceByMesh.get(child)?.alive === true);
  }

  interiorObstacleAt(x: number, z: number, feetY: number): boolean {
    for (const index of this.voxelIndexesNear(x, z, 0.4)) {
      const voxel = this.voxels[index];
      if (!voxel.alive || voxel.roof || Math.abs(voxel.x - x) > this.grid.cellSize / 2 + 0.4 || Math.abs(voxel.z - z) > this.grid.cellSize / 2 + 0.4 || voxel.y + FLOOR_HEIGHT / 2 < feetY + 0.3 || voxel.y - FLOOR_HEIGHT / 2 > feetY + 2.2) continue;
      for (let sub = 0; sub < voxel.pieces.length; sub++) {
        if (voxel.pieces[sub] <= 0) continue;
        const offset = sub * 3, height = voxel.y + voxel.positions[offset + 1];
        if (height < feetY + 0.3 || height > feetY + 2.2) continue;
        if (Math.abs(voxel.x + voxel.positions[offset] - x) < voxel.voxelSize / 2 + 0.27 &&
            Math.abs(voxel.z + voxel.positions[offset + 2] - z) < voxel.voxelSize / 2 + 0.27) return true;
      }
    }
    const cell = this.grid.cellAtWorld(x, z);
    if (!cell) return false;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const nearby = this.grid.cell(cell.x + dx, cell.z + dz);
      if (!nearby) continue;
      for (const piece of this.interiorObstaclesByCell.get(this.grid.index(nearby.x, nearby.z)) || []) {
        if (!piece.alive || piece.mesh.parent?.visible === false) continue;
        const box = piece.bounds;
        if (box.max.y < feetY + 0.25 || box.min.y > feetY + 1.55) continue;
        if (x <= box.min.x - 0.27 || x >= box.max.x + 0.27 || z <= box.min.z - 0.27 || z >= box.max.z + 0.27) continue;
        for (const ox of [-0.23, 0, 0.23]) for (const oz of [-0.23, 0, 0.23]) {
          for (const rise of [0.36, 0.88, 1.4]) {
            if (this.pieceOccupies(piece, x + ox, feetY + rise, z + oz)) return true;
          }
        }
      }
    }
    return false;
  }

  floorHeightAt(x:number,z:number,level:number):number {
    const cell=this.grid.cellAtWorld(x,z),base=this.grid.terrain.height(x,z)+level*FLOOR_HEIGHT;
    if(!cell||level===0)return this.grid.groundHeight(x,z);
    let height=-Infinity;
    for(let dz=-1;dz<=1;dz++)for(let dx=-1;dx<=1;dx++) {
      const index=this.grid.index(cell.x+dx,cell.z+dz);
      for(const piece of this.upperFloorSlabsByCell.get(index)??[])if(piece.alive&&piece.mesh.userData.floorLevel===level&&
        x>=piece.bounds.min.x&&x<=piece.bounds.max.x&&z>=piece.bounds.min.z&&z<=piece.bounds.max.z&&this.pieceOccupies(piece,x,piece.center.y,z))height=Math.max(height,piece.bounds.max.y);
    }
    for(const index of this.voxelsByCell.get(this.grid.index(cell.x,cell.z))??[]) {
      const voxel=this.voxels[index];if(!voxel.alive||!voxel.roof||Math.round((voxel.y-(voxel.baseY??0))/FLOOR_HEIGHT-.5)!==level)continue;
      for(let sub=0;sub<voxel.pieces.length;sub++)if(voxel.pieces[sub]>0&&
        Math.abs(voxel.x+voxel.positions[sub*3]-x)<=voxel.voxelSize*.51&&Math.abs(voxel.z+voxel.positions[sub*3+2]-z)<=voxel.voxelSize*.51)
          height=Math.max(height,voxel.y+voxel.positions[sub*3+1]+voxel.voxelSize/2);
    }
    return Number.isFinite(height)?height:base;
  }
  supportHeight(x:number,z:number,y:number):number {
    let ground=this.grid.water.at(x,z)&&y<CANAL_SURFACE_Y+1.2?CANAL_BED_Y:this.grid.groundHeight(x,z);
    const level=Math.floor((y-this.grid.terrain.height(x,z)+.3)/FLOOR_HEIGHT);
    for(let floor=Math.max(0,level);floor>0;floor--) if(this.upperFloorPresent(x,z,floor)) {ground=this.floorHeightAt(x,z,floor);break;}
    return this.grid.surfaces.below(x,z,y,ground);
  }

  upperFloorPresent(x: number, z: number, level: number): boolean {
    if (level === 0) return true;
    const cell = this.grid.cellAtWorld(x, z);
    if (!cell) return false;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const nearby = this.grid.cell(cell.x + dx, cell.z + dz);
      if (!nearby) continue;
      for (const piece of this.upperFloorSlabsByCell.get(this.grid.index(nearby.x, nearby.z)) || []) {
        const box = piece.bounds;
        if (piece.alive && piece.mesh.userData.floorLevel === level && x >= box.min.x - 0.12 && x <= box.max.x + 0.12 && z >= box.min.z - 0.12 && z <= box.max.z + 0.12 &&
          this.pieceOccupies(piece, x, piece.center.y, z)) return true;
      }
    }
    // The roof itself is the top walking surface. Check its surviving small
    // voxels so a blasted hole cannot remain an invisible floor.
    for (const index of this.voxelsByCell.get(this.grid.index(cell.x, cell.z)) || []) {
      const voxel = this.voxels[index];
      if (!voxel.alive || !voxel.roof || !voxel.buildingUse) continue;
      const storey = storeyHeight(buildingPrefab(voxel.buildingUse));
      if (Math.round((voxel.y-(voxel.baseY??0)) / storey - 0.5) !== level) continue;
      for (let sub = 0; sub < voxel.pieces.length; sub++) {
        if (voxel.pieces[sub] <= 0) continue;
        const at = sub * 3;
        if (Math.abs(voxel.x + voxel.positions[at] - x) <= voxel.voxelSize * 0.56 &&
            Math.abs(voxel.z + voxel.positions[at + 2] - z) <= voxel.voxelSize * 0.56) return true;
      }
    }
    return false;
  }

  interiorWalkable(x: number, z: number): boolean {
    const cell = this.grid.cellAtWorld(x, z);
    if (!cell?.active || !cell.blocked || cell.rubble) return false;
    for (const room of this.interiorAreas) {
      if (cell.x < room.x0 || cell.x >= room.x1 || cell.z < room.z0 || cell.z >= room.z1) continue;
      const margin = this.grid.cellSize / 2;
      const left = this.grid.world(room.x0, room.z0)[0] - margin;
      const right = this.grid.world(room.x1 - 1, room.z0)[0] + margin;
      const back = this.grid.world(room.x0, room.z0)[1] - margin;
      const front = this.grid.world(room.x0, room.z1 - 1)[1] + margin;
      if (x > left && x < right && z > back && z < front) return true;
    }
    return false;
  }

  stairSurface(x: number, z: number, currentY: number): { height: number; room: InteriorStaircase['room'] } | null {
    let best: { height: number; room: InteriorStaircase['room'] } | null = null;
    let bestDistance = Infinity;
    for (const stairs of this.staircases) {
      if (stairs.group.parent?.visible === false || stairs.group.parent?.parent?.visible === false) continue;
      if (z < stairs.endZ - 0.12 || z > stairs.startZ + 0.12) continue;
      for (let level = 0; level < stairs.maxLevel; level++) {
        const laneX = stairs.centerX + (level % 2 ? stairs.laneOffset : -stairs.laneOffset);
        if (Math.abs(x - laneX) > stairs.laneHalfWidth) continue;
        const ascendingFromFront = level % 2 === 0;
        const fraction = THREE.MathUtils.clamp(ascendingFromFront ? (stairs.startZ - z) / (stairs.startZ - stairs.endZ) : (z - stairs.endZ) / (stairs.startZ - stairs.endZ), 0, 1);
        const stepIndex = Math.min(stairs.treadCount - 1, Math.floor(fraction * stairs.treadCount));
        if (level === 0 && stepIndex === 0) {
          // The ground-floor slab is already the first tread. A second voxel
          // here had an identical top face and flickered against that floor.
          const cell = this.grid.cellAtWorld(x, z);
          const floor = cell && this.interiorPiecesByCell.get(this.grid.index(cell.x, cell.z))?.some((piece) =>
            piece.alive && piece.mesh.userData.floorLevel === 0 && this.pieceOccupies(piece, x, piece.center.y, z));
          const height = stairs.position.y + CITY_VOXEL_SIZE / 2;
          const distance = Math.abs(currentY - height);
          if (floor && distance <= 0.52 && distance < bestDistance) { best = { height, room: stairs.room }; bestDistance = distance; }
          continue;
        }
        const tread = stairs.steps[level]?.[stepIndex];
        if (!tread || this.interiorPieceByMesh.get(tread)?.alive === false) continue;
        const height = this.interiorPieceByMesh.get(tread)?.bounds.max.y ?? stairs.position.y + (level + (stepIndex+1)/stairs.treadCount) * stairs.storeyHeight;
        const distance = Math.abs(currentY - height);
        if (distance <= 0.52 && distance < bestDistance) { best = { height, room: stairs.room }; bestDistance = distance; }
      }
    }
    return best;
  }

  private addFacadeDetails(plan: BuildingPlan): void {
    const prefab = buildingPrefab(plan.type), direction = frontageDirection(plan);
    const block = this.grid.blockAt(plan.x, plan.z);
    const theme = this.grid.blockProfile(block.bx, block.bz).palette;
    const [left, front] = this.grid.world(plan.x, frontageZ(plan));
    const width = plan.width * this.grid.cellSize;
    const group = new THREE.Group(); group.position.set(left + (plan.width - 1) * this.grid.cellSize / 2, 0, front);
    group.rotation.y = direction < 0 ? Math.PI : 0;
    // Keep facade overlays clear of the shell's exposed side plane.
    const outer = this.grid.cellSize / 2 + VOXEL_SIZE / 2 + SURFACE_GAP;
    // Floor seams come from the shell itself. Adding a separate fascia over
    // every seam caused coplanar faces and visible z-fighting at distance.
    if (prefab.facade.shopCanopy) {
      const canopyY = voxelUnits(16.5);
      for (let segment = 0; segment < plan.width * 2; segment++) {
        const roof = cube(voxelUnits(5), VOXEL_SIZE, voxelUnits(4), segment % 2 ? '#fff0d4' :
          ['#dc755c', '#448c89', '#d2a44f', '#ba7ea3', '#78a961'][((plan.variant % 5) + theme) % 5]);
        roof.position.set(-width / 2 + voxelUnits(segment * 5 + 2.5), canopyY, outer + voxelUnits(2.5)); group.add(roof);
      }
      const names = plan.type === 'hotel' ? ['HOTEL', 'HOSTAL'] : ['MERCADO', 'CAFÉ', 'FARMACIA', 'LIBROS', 'PANADERÍA'];
      const sign = signFace(names[plan.variant % names.length], '#263e47', '#fff2d9', voxelUnits(12), voxelUnits(2));
      const doorOffset = (Math.floor(plan.width / 2) - (plan.width - 1) / 2) * this.grid.cellSize;
      sign.position.set(doorOffset * direction, canopyY - voxelUnits(1.5), outer + voxelUnits(5)); group.add(sign);
    }
    if (prefab.facade.balconies && plan.width >= 5) {
      for (let level = 1; level < plan.height - 1; level++) {
        const balconyX = direction > 0 ? plan.x + 1 : plan.x + plan.width - 2;
        if (buildingArchitecture(plan).roofLevel(balconyX, frontageZ(plan)) <= level) continue;
        const slab = cube(voxelUnits(7), VOXEL_SIZE, voxelUnits(4), '#d2c4aa');
        slab.position.set(-width / 2 + this.grid.cellSize * 1.5, level * storeyHeight(prefab) + VOXEL_SIZE / 2, outer + voxelUnits(2.5)); group.add(slab);
        const rail = cube(voxelUnits(7), voxelUnits(4), VOXEL_SIZE, '#456b70');
        rail.position.set(slab.position.x, slab.position.y + voxelUnits(2.5), outer + voxelUnits(5)); group.add(rail);
      }
    }
    if(plan.type==='house'||plan.type==='apartment') {
      const architecture=buildingArchitecture(plan),gx=plan.x,gz=plan.front==='north'?plan.z+plan.depth-1:plan.z;
      const [vx,vz]=this.grid.world(gx,gz),vine=new THREE.Group();vine.name='facade-climber';
      for(let row=1;row<architecture.roofLevel(gx,gz)*CITY_VOXELS_PER_FLOOR-1;row++) {
        if((row+plan.variant)%5===0)continue;
        const leaf=cityCube(CITY_VOXEL_SIZE,CITY_VOXEL_SIZE,CITY_VOXEL_SIZE,row%3?'#709759':'#95b46c');
        leaf.position.set(vx-this.grid.cellSize/2-CITY_VOXEL_SIZE/2,row*CITY_VOXEL_SIZE+.22,vz+(row%3-1)*CITY_VOXEL_SIZE);vine.add(leaf);
      }
      this.scene.add(vine);
    }
    this.scene.add(group);
  }

  private addDetailVoxels(source: Voxel, positions: number[], hex: string): void {
    if (!positions.length) return;
    const index = this.voxels.length;
    const offsets = Float32Array.from(positions);
    this.voxels.push({ x: source.x, y: source.y, z: source.z, alive: true, hp: 1, cellIndex: source.cellIndex, voxelSize: source.voxelSize,
      color: color(hex), details: [], positions: offsets, pieces: new Float32Array(offsets.length / 3).fill(0.7), damaged: false, roof: false, structural: false });
    if (!this.voxelsByCell.has(source.cellIndex)) this.voxelsByCell.set(source.cellIndex, []);
    this.voxelsByCell.get(source.cellIndex)!.push(index);
  }

  private addRoomPrefab(parent: THREE.Group, station: keyof typeof ROOM_PREFABS, variant = 0, use?: StructureUse, level = 0): void {
    for (const part of roomParts(station, variant, use, level)) {
      const [sx, sy, sz] = part.size;
      const [ox, oy, oz] = part.offset;
      const paint = new THREE.Color(part.paint).offsetHSL(0, 0, ((variant % 3) - 1) * 0.025);
      // Keep furniture and interactive fixtures on the finer actor lattice.
      const mesh = fineCube(voxelUnits(sx), voxelUnits(sy), voxelUnits(sz), `#${paint.getHexString()}`);
      mesh.position.set(voxelUnits(ox), voxelUnits(oy), voxelUnits(oz));
      mesh.castShadow = sy > 1;
      mesh.userData.prefabRole = part.role;
      parent.add(mesh);
    }
  }

  private addWindow(index: number, face: 'x' | 'left' | 'z' | 'back', district: District, storefront: boolean, variant: number): void {
    const voxel = this.voxels[index], prefab = buildingPrefab(voxel.buildingUse ?? 'house');
    const spec = storefront ? prefab.storefrontWindow : prefab.regularWindow;
    const width = Math.min(CITY_VOXELS_PER_CELL - 1, Math.max(1, Math.round((spec.widthVoxels + 2) * VOXEL_SIZE / CITY_VOXEL_SIZE)));
    const height = Math.max(1, Math.round((spec.heightVoxels + 2) * VOXEL_SIZE / CITY_VOXEL_SIZE));
    const x0 = Math.floor((CITY_VOXELS_PER_CELL - width) / 2);
    const y0 = Math.round((storefront ? 3 : 5) * VOXEL_SIZE / CITY_VOXEL_SIZE);
    const outer = (CITY_VOXELS_PER_CELL - 1) * CITY_VOXEL_SIZE / 2;
    const sideX = face === 'x' || face === 'left', direction = face === 'left' || face === 'back' ? -1 : 1;
    const frame: number[] = [], glass: number[] = [];
    for (let sub = 0; sub < voxel.pieces.length; sub++) {
      const at = sub * 3, px = voxel.positions[at], py = voxel.positions[at + 1], pz = voxel.positions[at + 2];
      if (Math.abs((sideX ? px : pz) - outer * direction) > 0.001) continue;
      const col = Math.round((sideX ? pz : px) / CITY_VOXEL_SIZE + (CITY_VOXELS_PER_CELL - 1) / 2);
      const row = Math.round(py / CITY_VOXEL_SIZE + (CITY_VOXELS_PER_FLOOR - 1) / 2);
      if (col < x0 || col >= x0 + width || row < y0 || row >= y0 + height) continue;
      voxel.pieces[sub] = 0;
      const border = col === x0 || col === x0 + width - 1 || row === y0 || row === y0 + height - 1;
      (border ? frame : glass).push(px, py, pz);
    }
    this.addDetailVoxels(voxel, frame, district === 'residential' ? '#fff1d8' : '#244f58');
    this.addDetailVoxels(voxel, glass, variant % 3 === 0 ? '#b1d4d0' : '#619fa8');
  }

  private carveTerraceDoor(voxel: Voxel, face: number): void {
    const frame: number[] = [], sideX = face < 4, sign = face === 1 || face === 4 ? -1 : 1;
    for (let sub = 0; sub < voxel.pieces.length; sub++) {
      const at = sub * 3, x = voxel.positions[at], y = voxel.positions[at + 1], z = voxel.positions[at + 2];
      if (Math.abs((sideX ? x : z) - sign * CITY_VOXEL_SIZE * 2) > .001) continue;
      const col = Math.round((sideX ? z : x) / CITY_VOXEL_SIZE), row = Math.round(y / CITY_VOXEL_SIZE + 4);
      if (row < 1 || row > 7) continue;
      voxel.pieces[sub] = 0;
      if (Math.abs(col) === 2 || row === 7) frame.push(x, y, z);
    }
    this.addDetailVoxels(voxel, frame, '#e9d9bb');
  }

  private addEntrance(x: number, z: number, plan: BuildingPlan): void {
    const [wx, wz] = this.grid.world(x, z), prefab = buildingPrefab(plan.type);
    const district = districtForType(plan.type);
    const wall = `#${this.facadePaint(district, plan.x, plan.z).getHexString()}`;
    const framePaint = district === 'residential' ? '#ead8bb' : '#244f58';
    const group = new THREE.Group(); group.position.set(wx, 0, wz);
    group.rotation.y = frontageDirection(plan) < 0 ? Math.PI : 0;
    group.userData.furniture = true;
    const width = voxelUnits(6), height = voxelUnits(13), outer = voxelUnits(4.5);
    const add = (w: number, h: number, d: number, paint: string, px: number, py: number, pz: number) => {
      const mesh = cube(w, h, d, paint); mesh.position.set(px, py, pz); group.add(mesh); return mesh;
    };
    for (const side of [-1, 1]) {
      add(VOXEL_SIZE, storeyHeight(prefab), VOXEL_SIZE, wall, side * voxelUnits(4.5), storeyHeight(prefab) / 2, outer);
      add(VOXEL_SIZE, height + VOXEL_SIZE, VOXEL_SIZE, framePaint, side * voxelUnits(3.5), (height + VOXEL_SIZE) / 2, outer);
    }
    add(voxelUnits(6), VOXEL_SIZE, VOXEL_SIZE, framePaint, 0, height + VOXEL_SIZE / 2, outer);
    add(voxelUnits(8), voxelUnits(4), VOXEL_SIZE, wall, 0, voxelUnits(16), outer);
    // The leaf is physically open along the inside jamb, leaving a real walkable aperture.
    const door = add(VOXEL_SIZE, height, width, district === 'residential' ? '#a26a4d' : '#527f85', -voxelUnits(3.5), height / 2, outer - width / 2);
    door.userData.prefabRole = 'open-door';
    add(VOXEL_SIZE, VOXEL_SIZE, VOXEL_SIZE, '#e7bd77', -voxelUnits(2.5), voxelUnits(6.5), outer - width + voxelUnits(1.5));
    add(voxelUnits(8), VOXEL_SIZE, voxelUnits(3), '#cfb997', 0, VOXEL_SIZE / 2, outer + VOXEL_SIZE);
    this.scene.add(group);
  }

  private addLoadingBay(x: number, z: number, plan: BuildingPlan): void {
    const [wx, wz] = this.grid.world(x, z);
    const group = new THREE.Group(); group.position.set(wx, 0, wz);
    group.rotation.y = frontageDirection(plan) < 0 ? Math.PI : 0;
    group.userData.furniture = true;
    for (const side of [-1, 1]) {
      const post = cube(VOXEL_SIZE, voxelUnits(18), VOXEL_SIZE, '#526b70');
      post.position.set(side * voxelUnits(4.5), voxelUnits(9), voxelUnits(4.5)); group.add(post);
    }
    const rolled = cube(voxelUnits(8), voxelUnits(5), VOXEL_SIZE, '#94a5a1');
    rolled.position.set(0, voxelUnits(15.5), voxelUnits(4.5)); group.add(rolled);
    this.scene.add(group);
  }

  private addRoofDetail(plan: BuildingPlan): void {
    const prefab = buildingPrefab(plan.type), layout = buildingArchitecture(plan), stair = stairBay(plan);
    const roofRoot = new THREE.Group(); roofRoot.name = `roof-prefabs-${plan.type}-${layout.form}`;
    roofRoot.userData.architecture = layout.form;
    const n = CITY_VOXELS_PER_CELL, half = Math.floor(n / 2);
    const reserved = new Set<string>(), used = new Set<string>();
    const counts = new Map<number, number>();
    const candidates: Array<{x: number; z: number}> = [];
    for (let z = plan.z; z < plan.z + plan.depth; z++) for (let x = plan.x; x < plan.x + plan.width; x++) candidates.push({x,z});
    candidates.sort((a,b) => this.grid.hash(a.x,a.z,plan.variant+731) - this.grid.hash(b.x,b.z,plan.variant+731));
    for (const anchor of candidates) {
      const level = layout.roofLevel(anchor.x, anchor.z), terrace = level < plan.height - 1;
      if ((counts.get(level) ?? 0) >= (terrace ? 2 : 3)) continue;
      const choices: readonly RoofFeature[] = terrace ? ['garden', 'seating', 'pergola', 'laundry'] : prefab.roof.features;
      for (let attempt = 0; attempt < choices.length; attempt++) {
        const feature = choices[(plan.variant + attempt) % choices.length];
        if (used.has(`${level}:${feature}`)) continue;
        const voxels = this.roofFeatureVoxels(feature, plan.variant + level);
        const minX = Math.min(...voxels.map(v=>v.x)), maxX = Math.max(...voxels.map(v=>v.x));
        const minZ = Math.min(...voxels.map(v=>v.z)), maxZ = Math.max(...voxels.map(v=>v.z));
        const keys: string[] = []; let fits = true;
        // Reserve the entire footprint plus a voxel border, not just its anchor.
        for (let z = minZ - 1; z <= maxZ + 1 && fits; z++) for (let x = minX - 1; x <= maxX + 1; x++) {
          const vx = anchor.x * n + half + x, vz = anchor.z * n + half + z;
          const gx = Math.floor(vx / n), gz = Math.floor(vz / n), key = `${level}:${vx}:${vz}`;
          const stairClear = gx === stair.x && gz >= stair.z0 - 1 && gz <= stair.z1 + 1;
          const doorClear = layout.doors.some(d => d.level === level && Math.abs(d.x-gx)+Math.abs(d.z-gz) <= 1);
          if (layout.roofLevel(gx,gz) !== level || stairClear || doorClear || reserved.has(key) ||
              (vx % n === 0 && layout.roofLevel(gx-1,gz) !== level) ||
              (vx % n === n - 1 && layout.roofLevel(gx+1,gz) !== level) ||
              (vz % n === 0 && layout.roofLevel(gx,gz-1) !== level) ||
              (vz % n === n - 1 && layout.roofLevel(gx,gz+1) !== level)) { fits = false; break; }
          keys.push(key);
        }
        if (!fits) continue;
        const mesh = createRoofFeatureMesh(voxels, feature); if (!mesh) continue;
        const [wx,wz] = this.grid.world(anchor.x, anchor.z);
        const fixture = new THREE.Group(); fixture.userData.furniture = true;
        fixture.userData.roofLevel = level; fixture.userData.roofSupportY = level * FLOOR_HEIGHT + CITY_VOXEL_SIZE;
        fixture.position.set(wx, fixture.userData.roofSupportY + CITY_VOXEL_SIZE / 2, wz);
        fixture.add(mesh); roofRoot.add(fixture);
        keys.forEach(key=>reserved.add(key)); used.add(`${level}:${feature}`);
        counts.set(level,(counts.get(level)??0)+1); break;
      }
    }
    this.scene.add(roofRoot);
  }

  private roofFeatureVoxels(feature: RoofFeature, seed: number): RoofVoxel[] {
    const voxels: RoofVoxel[] = [];
    const box = (cx: number, cy: number, cz: number, width: number, height: number, depth: number, paint: string): void => {
      const x0 = cx - Math.floor(width / 2), z0 = cz - Math.floor(depth / 2);
      for (let y = cy; y < cy + height; y++) for (let z = z0; z < z0 + depth; z++) for (let x = x0; x < x0 + width; x++)
        voxels.push({ x, y, z, paint });
    };
    const frame = (width: number, depth: number, y: number, paint: string, thickness = 1): void => {
      box(0, y, -Math.floor(depth / 2), width, thickness, 1, paint);
      box(0, y, Math.floor(depth / 2), width, thickness, 1, paint);
      box(-Math.floor(width / 2), y, 0, 1, thickness, depth, paint);
      box(Math.floor(width / 2), y, 0, 1, thickness, depth, paint);
    };
    const solarPaint = seed % 2 ? '#315f73' : '#3b7380';
    switch (feature) {
      case 'seating':
        box(0, 0, -1, 5, 1, 2, '#85674e'); box(0, 1, -1, 5, 1, 2, '#d6af79');
        box(0, 1, -2, 5, 2, 1, '#b58c59');
        box(0, 0, 2, 1, 1, 1, '#7d7765'); box(0, 1, 2, 3, 1, 2, '#e1caa0'); break;
      case 'chimney':
        box(0, 0, 0, 3, 6, 3, '#a76550'); box(0, 6, 0, 5, 1, 5, '#596a68'); break;
      case 'solar':
        box(0, 0, 0, 8, 1, 6, '#788985'); box(0, 1, 0, 8, 1, 6, solarPaint);
        for (const x of [-2, 0, 2]) box(x, 1, 0, 1, 1, 6, '#8bb0ad');
        box(0, 1, -2, 8, 1, 1, '#8bb0ad'); break;
      case 'hvac':
        box(0, 0, 0, 7, 3, 6, '#aebbb0'); box(0, 3, 0, 6, 1, 5, '#71817d');
        box(-1, 4, 0, 3, 1, 1, '#415b60'); box(2, 4, 1, 1, 1, 3, '#4e6b70'); break;
      case 'vent':
        box(0, 0, 0, 3, 2, 3, '#71817d'); box(0, 2, 0, 1, 4, 1, '#8f9f9a');
        box(0, 6, 0, 4, 1, 4, '#586b69'); break;
      case 'coolingTower':
        box(0, 0, 0, 6, 4, 6, '#82958c'); frame(7, 7, 4, '#536f6f');
        box(0, 4, 0, 1, 1, 5, '#364f55'); box(-2, 4, 0, 5, 1, 1, '#364f55'); break;
      case 'waterTank':
        box(0, 0, 0, 5, 5, 5, '#668f8c'); box(0, 1, -3, 5, 1, 1, '#a9c7bb');
        box(0, 5, 0, 6, 1, 6, '#4b686b'); break;
      case 'garden':
        box(0, 0, 0, 3, 2, 3, '#705c43'); frame(5, 5, 0, '#9e765e', 2); box(0, 2, 0, 3, 2, 3, seed % 2 ? '#6e9b65' : '#80a96d');
        box(-2, 2, -2, 1, 2, 1, '#e7bd66'); box(2, 2, 1, 1, 2, 1, '#d98677');
        box(1, 2, -2, 1, 2, 1, '#d98677'); break;
      case 'pergola':
        for (const x of [-4, 4]) for (const z of [-3, 3]) box(x, 0, z, 1, 5, 1, '#8c654f');
        frame(9, 7, 5, '#a67b5d');
        for (const z of [-2, 0, 2]) box(0, 5, z, 9, 1, 1, '#d3b17c'); break;
      case 'greenhouse':
        frame(8, 8, 0, '#7e9a89'); frame(8, 8, 5, '#567b72'); box(0, 5, 0, 7, 1, 7, '#b0d1be');
        box(-3, 1, 0, 1, 4, 6, '#8bb9a4'); box(3, 1, 0, 1, 4, 6, '#8bb9a4');
        box(0, 1, -3, 6, 4, 1, '#8bb9a4'); box(0, 1, 3, 6, 4, 1, '#8bb9a4');
        box(-1, 1, 0, 1, 2, 1, '#72a36b'); box(1, 1, 0, 1, 2, 1, '#d4b866'); break;
      case 'laundry':
        box(-3, 0, 0, 1, 5, 1, '#657d7a'); box(3, 0, 0, 1, 5, 1, '#657d7a');
        box(0, 4, 0, 7, 1, 1, '#d9c7a8');
        box(-2, 1, 0, 1, 3, 1, '#6fabb4'); box(0, 1, 0, 1, 3, 1, '#d77764'); box(2, 1, 0, 1, 3, 1, '#e4ca75'); break;
      case 'antenna':
        box(0, 0, 0, 3, 1, 3, '#687978'); box(0, 1, 0, 1, 7, 1, '#526a70');
        box(0, 6, 0, 5, 1, 1, '#899e9c'); box(0, 4, 0, 1, 1, 5, '#899e9c'); break;
      case 'skylight':
        frame(8, 6, 0, '#7a8882'); box(0, 0, 0, 6, 1, 4, '#79abb0');
        box(-3, 1, 0, 1, 1, 6, '#d2c7aa'); box(3, 1, 0, 1, 1, 6, '#d2c7aa'); break;
      case 'pool':
        frame(8, 8, 0, '#ddc8a4', 1); box(0, 0, 0, 6, 1, 6, '#69b8bd');
        box(-3, 1, 0, 1, 1, 8, '#f0d9b0'); break;
      case 'billboard':
        box(-3, 0, 2, 1, 5, 1, '#354f58'); box(3, 0, 2, 1, 5, 1, '#354f58');
        box(0, 5, 2, 8, 4, 1, seed % 2 ? '#b4554e' : '#375d6a');
        box(-2, 6, 1, 1, 2, 1, '#f1ce80'); box(0, 6, 1, 1, 2, 1, '#f1ce80'); box(2, 6, 1, 1, 2, 1, '#f1ce80'); break;
    }
    return voxels;
  }

  private addInterior(plan: BuildingPlan): number[] {
    if (plan.width < 3 || plan.depth < 3) return [];
    const district = districtForType(plan.type);
    const room = { x0: plan.x, x1: plan.x + plan.width, z0: plan.z, z1: plan.z + plan.depth };
    const prefab = buildingPrefab(plan.type);
    const areaPrefab = prefab.area;
    const aisleStart = plan.x + Math.floor((plan.width - areaPrefab.aisleCells) / 2);
    const aisleEnd = aisleStart + areaPrefab.aisleCells;
    const aisleX = aisleStart + Math.floor(areaPrefab.aisleCells / 2);
    const backZ = plan.z + areaPrefab.stationOffsetCells;
    const frontZ = plan.z + plan.depth - 1 - areaPrefab.stationOffsetCells;
    const occupied: number[] = [];
    const floorColor = district === 'commercial' ? '#c9a77e' : district === 'industrial' ? '#8d9b97' : '#dfc8a5';
    const occupy = (gx: number, gz: number): void => {
      if (gx >= aisleStart && gx < aisleEnd) return;
      const cell = this.grid.cell(gx, gz);
      if (cell && !cell.blocked) { cell.blocked = true; occupied.push(this.grid.index(gx, gz)); }
    };
    for (let gz = plan.z; gz < plan.z + plan.depth; gz++) for (let gx = plan.x; gx < plan.x + plan.width; gx++) {
      const [wx, wz] = this.grid.world(gx, gz);
      const edgeX = gx === plan.x || gx === plan.x + plan.width - 1;
      const edgeZ = gz === plan.z || gz === plan.z + plan.depth - 1;
      const floorWidth = this.grid.cellSize - (edgeX ? CITY_VOXEL_SIZE : 0);
      const floorDepth = this.grid.cellSize - (edgeZ ? CITY_VOXEL_SIZE : 0);
      const floorX = gx === plan.x ? CITY_VOXEL_SIZE / 2 : gx === plan.x + plan.width - 1 ? -CITY_VOXEL_SIZE / 2 : 0;
      const floorZ = gz === plan.z ? CITY_VOXEL_SIZE / 2 : gz === plan.z + plan.depth - 1 ? -CITY_VOXEL_SIZE / 2 : 0;
      const floor = cityCube(floorWidth, CITY_VOXEL_SIZE, floorDepth, floorColor, 1);
      floor.position.set(wx + floorX, 0, wz + floorZ);
      floor.receiveShadow = true; floor.userData.floorLevel = 0; this.scene.add(floor);
    }
    const [artX, backWorldZ] = this.grid.world(aisleX, plan.front === 'north' ? plan.z + plan.depth - 1 : plan.z);
    const artColor = district === 'industrial' ? '#d9ab78' : district === 'commercial' ? '#7bbdb6' : '#dd977b';
    const art = cube(voxelUnits(4), voxelUnits(3), VOXEL_SIZE, artColor);
    art.position.set(artX, voxelUnits(6), backWorldZ - frontageDirection(plan) * voxelUnits(3.5)); this.scene.add(art);
    const kind: InteriorStation['kind'] = areaPrefab.groundStation;
    const furnished = new Set<string>();
    const fixture = (gx: number, gz: number, fixtureKind: InteriorStation['kind'], interactive: boolean): void => {
      if (circulationCell(plan, gx, gz) || furnished.has(`${gx}:${gz}`)) return;
      furnished.add(`${gx}:${gz}`);
      const [wx, wz] = this.grid.world(gx, gz);
      const group = new THREE.Group(); group.position.set(wx, 0, wz); group.userData.furniture = true; group.userData.groundFurniture = true;
      this.addRoomPrefab(group, fixtureKind, plan.variant + gx + gz, plan.type);
      this.scene.add(group);
      occupy(gx, gz);
      if (interactive) this.interiorStations.push({ position: new THREE.Vector3(wx, 0, wz), kind: fixtureKind, used: false, group, room });
    };
    const leftX = aisleStart - 1;
    if (leftX > plan.x) fixture(leftX, backZ, kind, true);
    const rightX = aisleEnd;
    if (rightX < plan.x + plan.width - 1) fixture(rightX, backZ, kind === 'workshop' ? 'supply' : 'cabinet', true);
    if (plan.depth >= 5) {
      const sideX = rightX < plan.x + plan.width - 1 ? rightX : leftX;
      if (sideX !== aisleX && !circulationCell(plan, sideX, frontZ)) {
        const [wx, wz] = this.grid.world(sideX, frontZ);
        const decor = new THREE.Group(); decor.position.set(wx, 0, wz); decor.userData.furniture = true; decor.userData.groundFurniture = true;
        this.addRoomPrefab(decor, plan.type === 'hotel' ? 'reception' : kind, plan.variant + 1, plan.type);
        this.scene.add(decor);
        occupy(sideX, frontZ); furnished.add(`${sideX}:${frontZ}`);
      }
      if (leftX !== aisleX && leftX !== sideX && !circulationCell(plan, leftX, frontZ)) {
        const [wx, wz] = this.grid.world(leftX, frontZ);
        const corner = new THREE.Group(); corner.position.set(wx, 0, wz); corner.userData.furniture = true; corner.userData.groundFurniture = true;
        this.addRoomPrefab(corner, kind === 'reception' ? 'cabinet' : kind, plan.variant + 2, plan.type);
        this.scene.add(corner);
        occupy(leftX, frontZ); furnished.add(`${leftX}:${frontZ}`);
      }
    }
    for (let gz = plan.z + 2; gz < plan.z + plan.depth - 2; gz += 2)
      for (const gx of [plan.x + 1, plan.x + plan.width - 2])
        fixture(gx, gz, plan.type === 'house' || plan.type === 'apartment' ? 'rest' : plan.type === 'hotel' ? 'reception' : kind, true);
    const [lampX, lampZ] = this.grid.world(aisleX, plan.z + 1);
    const ceilingLight = new THREE.Group(); ceilingLight.position.set(lampX, storeyHeight(prefab) - VOXEL_SIZE, lampZ);
    this.addRoomPrefab(ceilingLight, 'ceilingLight', plan.variant); ceilingLight.userData.cityLight = 'interior'; this.scene.add(ceilingLight);
    return occupied;
  }

  private addUpperInteriors(plan: BuildingPlan): void {
    const maxLevel = plan.height - 1;
    if (maxLevel < 1 || plan.width < 4 || plan.depth < 4) return;
    const room = { x0: plan.x, x1: plan.x + plan.width, z0: plan.z, z1: plan.z + plan.depth };
    const prefab = buildingPrefab(plan.type);
    const aisleStart = plan.x + Math.floor((plan.width - prefab.area.aisleCells) / 2);
    const aisleX = aisleStart + Math.floor(prefab.area.aisleCells / 2);
    // Keep the entrance bay clear. Put the stair flight along a side wall at
    // the rear of the building so it does not emerge in front of the door.
    const bay = stairBay(plan);
    const stairZ = bay.z0;
    const stairCellX = bay.x;
    const [stairX, stairWorldZ] = this.grid.world(stairCellX, stairZ);
    const stairCenterZ = stairWorldZ + this.grid.cellSize / 2;
    const staircase = new THREE.Group();
    staircase.position.set(stairX, 0, stairCenterZ);
    const steps: Array<Array<THREE.Mesh | null>> = [];
    for (let level = 0; level < maxLevel; level++) {
      const fromFront = level % 2 === 0;
      const laneX = fromFront ? -voxelUnits(2.5) : voxelUnits(2.5);
      const flight: Array<THREE.Mesh | null> = [];
      for (let step = 0; step < prefab.floorHeightVoxels; step++) {
        if (level === 0 && step === 0) { flight.push(null); continue; }
        const tread = cube(voxelUnits(5), VOXEL_SIZE, VOXEL_SIZE, step % 2 ? '#dfc39c' : '#ebd1aa');
        const runCenter = ((prefab.floorHeightVoxels - 1) / 2 - step) * VOXEL_SIZE;
        tread.position.set(laneX, level * storeyHeight(prefab) + (step + 0.5) * VOXEL_SIZE, fromFront ? runCenter : -runCenter);
        tread.castShadow = true;
        staircase.add(tread);
        flight.push(tread);
      }
      steps.push(flight);

    }
    const lastFlight = maxLevel - 1;
    const exitFront = lastFlight % 2 === 0;
    const roofLanding = cube(voxelUnits(5), VOXEL_SIZE, voxelUnits(5), '#c9bda2');
    roofLanding.position.set(exitFront ? -voxelUnits(2.5) : voxelUnits(2.5),
      maxLevel * storeyHeight(prefab) + VOXEL_SIZE / 2,
      (exitFront ? -1 : 1) * (voxelUnits((prefab.floorHeightVoxels - 1) / 2) + VOXEL_SIZE));
    roofLanding.userData.floorLevel = maxLevel;
    roofLanding.receiveShadow = true;
    staircase.add(roofLanding);
    const roofGuard = new THREE.Group();
    roofGuard.userData.furniture = true;
    const roofY = maxLevel * storeyHeight(prefab);
    const railPaint = plan.type === 'factory' || plan.type === 'workshop' ? '#607b7c' : '#d4c3a7';
    for (const side of [-1, 1]) {
      const rail = cube(VOXEL_SIZE, voxelUnits(2), voxelUnits(VOXELS_PER_CELL * 2), railPaint);
      rail.position.set(side * (this.grid.cellSize / 2 - VOXEL_SIZE / 2), roofY + voxelUnits(1.5), 0);
      roofGuard.add(rail);
    }
    const backRail = cube(voxelUnits(VOXELS_PER_CELL), voxelUnits(2), VOXEL_SIZE, railPaint);
    backRail.position.set(0, roofY + voxelUnits(1.5), (exitFront ? 1 : -1) * (this.grid.cellSize - VOXEL_SIZE / 2));
    roofGuard.add(backRail);
    staircase.add(roofGuard);
    this.scene.add(staircase);
    const stairRun = voxelUnits((prefab.floorHeightVoxels - 1) / 2);
    this.staircases.push({ position: new THREE.Vector3(stairX, 0, stairCenterZ), room, maxLevel, group: staircase, startZ: stairCenterZ + stairRun, endZ: stairCenterZ - stairRun, centerX: stairX, steps,
      treadCount: prefab.floorHeightVoxels, storeyHeight: storeyHeight(prefab), laneOffset: voxelUnits(2.5), laneHalfWidth: voxelUnits(2.5) });

    for (let level = 1; level <= maxLevel; level++) {
      if (level === maxLevel) continue; // The roof shell supplies this level's floor.
      const floor = new THREE.Group();
      floor.visible = true;
      const height = level * storeyHeight(prefab);
      const basePaint = plan.type === 'factory' || plan.type === 'workshop' ? '#94a6a4' : plan.type === 'hotel' ? '#dcc2a5' : '#d9c2a1';
      for (let gz = plan.z; gz < plan.z + plan.depth; gz++) for (let gx = plan.x; gx < plan.x + plan.width; gx++) {
        if (buildingArchitecture(plan).roofLevel(gx, gz) <= level) continue;
        if (gx === stairCellX && (gz === stairZ || gz === stairZ + 1)) continue;
        const [wx, wz] = this.grid.world(gx, gz);
        const mask = buildingArchitecture(plan).wallMask(gx, gz, level);
        const left = Number(!!(mask & 1)), right = Number(!!(mask & 2));
        const back = Number(!!(mask & 4)), front = Number(!!(mask & 8));
        const floorWidth = this.grid.cellSize - (left + right) * CITY_VOXEL_SIZE;
        const floorDepth = this.grid.cellSize - (back + front) * CITY_VOXEL_SIZE;
        const floorX = (left - right) * CITY_VOXEL_SIZE / 2;
        const floorZ = (back - front) * CITY_VOXEL_SIZE / 2;
        const tile = cityCube(floorWidth, CITY_VOXEL_SIZE, floorDepth, gx < aisleX ? basePaint : '#e9d8b8');
        tile.position.set(wx + floorX, height, wz + floorZ);
        tile.receiveShadow = true; tile.userData.floorLevel = level; floor.add(tile);
      }
      for (const side of [-1, 1]) {
        const landing = cube(voxelUnits(VOXELS_PER_CELL), voxelUnits(prefab.floorThicknessVoxels), voxelUnits(1), basePaint);
        landing.position.set(stairX, height + voxelUnits(prefab.floorThicknessVoxels) / 2, stairCenterZ + side * voxelUnits(9.5));
        landing.receiveShadow = true;
        landing.userData.floorLevel = level;
        floor.add(landing);
      }
      this.addRoomPartitions(plan, level, floor);
      let furnishingIndex = 0;
      for (let gz = plan.z + 1; gz < plan.z + plan.depth - 1; gz += 2) for (let gx = plan.x + 1; gx < plan.x + plan.width - 1; gx++) {
        const architecture = buildingArchitecture(plan);
        if (architecture.roofLevel(gx, gz) <= level || architecture.wallMask(gx, gz, level) ||
          architecture.doors.some(d => d.level === level && Math.abs(d.x - gx) + Math.abs(d.z - gz) <= 1)) continue;
        if (circulationCell(plan, gx, gz) || Math.abs(gx - aisleX) < 1) continue;
        const [wx, wz] = this.grid.world(gx, gz);
        const furnishing = new THREE.Group(); furnishing.position.set(wx, height, wz); furnishing.userData.furniture = true;
        const kind = prefab.area.upperStations[(plan.variant + level + furnishingIndex++) % prefab.area.upperStations.length];
        this.addRoomPrefab(furnishing, kind, plan.variant + level + gx + gz, plan.type, level); floor.add(furnishing);
        this.interiorStations.push({ position: new THREE.Vector3(wx, height, wz), kind, used: false, group: furnishing, room });
      }
      const [lightX, lightZ] = this.grid.world(aisleX, plan.z + Math.floor(plan.depth / 2));
      const light = new THREE.Group(); light.position.set(lightX, height + storeyHeight(prefab) - voxelUnits(2), lightZ);
      if (buildingArchitecture(plan).roofLevel(aisleX, plan.z + Math.floor(plan.depth / 2)) > level) {
        this.addRoomPrefab(light, 'ceilingLight', plan.variant + level); light.userData.cityLight = 'interior'; floor.add(light);
      }
      this.scene.add(floor);
    }
  }

  private addRoomPartitions(plan: BuildingPlan, level: number, floor: THREE.Group): void {
    if (plan.type === 'factory' || plan.type === 'workshop' || plan.type === 'shop') return;
    const layout = buildingArchitecture(plan), stair = stairBay(plan), aisle = plan.x + Math.floor(plan.width / 2);
    const height = FLOOR_HEIGHT - CITY_VOXEL_SIZE, base = level * FLOOR_HEIGHT + VOXEL_SIZE;
    for (const side of [-1, 1]) {
      const x0 = side < 0 ? plan.x : aisle + 1, x1 = side < 0 ? aisle - 1 : plan.x + plan.width - 1;
      if (x1 - x0 < 1) continue;
      for (let z0 = plan.z + 1; z0 + 1 < plan.z + plan.depth - 1; z0 += 2) {
        let fits = true;
        for (let z = z0; z <= z0 + 1; z++) for (let x = x0; x <= x1; x++) {
          if (layout.roofLevel(x,z) <= level || (Math.abs(x-stair.x)<=1 && z>=stair.z0-1 && z<=stair.z1+1) ||
              layout.doors.some(d=>d.level===level && Math.abs(d.x-x)+Math.abs(d.z-z)<=1)) fits = false;
        }
        if (!fits) continue;
        const [outerX, wz] = this.grid.world(side < 0 ? x1 : x0, z0);
        const hallX = outerX - side * (this.grid.cellSize / 2 - VOXEL_SIZE / 2);
        const group = new THREE.Group(); group.userData.furniture = true; group.name = 'room-partition-with-door';
        const add = (w: number,h: number,d: number,x: number,y: number,z: number,paint: string): void => {
          const mesh = fineCube(w,h,d,paint); mesh.position.set(x,y,z); mesh.castShadow=true; mesh.receiveShadow=true; group.add(mesh);
        };
        // A full panel next to the furnished cell, then an open 1.32m door
        // next to the empty cell. Doors face the continuous central hallway.
        const doorWidth = voxelUnits(6), doorHeight = voxelUnits(13);
        add(VOXEL_SIZE,height,this.grid.cellSize,hallX,base+height/2,wz,'#dfcfb4');
        const jambWidth = (this.grid.cellSize-doorWidth)/2, doorZ = wz+this.grid.cellSize;
        for (const end of [-1,1]) add(VOXEL_SIZE,height,jambWidth,hallX,base+height/2,doorZ+end*(doorWidth+jambWidth)/2,'#dfcfb4');
        add(VOXEL_SIZE,height-doorHeight,doorWidth,hallX,base+doorHeight+(height-doorHeight)/2,doorZ,'#c49a71');
        const roomWidth = (x1-x0+1)*this.grid.cellSize-CITY_VOXEL_SIZE;
        const [centerX] = this.grid.world((x0+x1)/2,z0);
        add(roomWidth,height,VOXEL_SIZE,centerX+side*CITY_VOXEL_SIZE/2,base+height/2,wz-this.grid.cellSize/2+VOXEL_SIZE/2,'#e3d4ba');
        floor.add(group);
      }
    }
  }

  private addSkybridges(plans:BuildingPlan[]):void {
    for(let i=0;i<plans.length;i++)for(let j=i+1;j<plans.length;j++) {
      let a=plans[i],b=plans[j];if(a.x>b.x)[a,b]=[b,a];
      const gap=b.x-(a.x+a.width);if(gap<1||gap>3)continue;
      const first=Math.max(a.z,b.z)+1,last=Math.min(a.z+a.depth,b.z+b.depth)-2;
      for(let z=first;z<=last;z++){
        const ax=a.x+a.width-1,bx=b.x,level=buildingArchitecture(a).roofLevel(ax,z);
        if(level!==buildingArchitecture(b).roofLevel(bx,z)||level<1)continue;
        const [left,wz]=this.grid.world(ax,z),[right]=this.grid.world(bx,z),base=this.grid.terrain.height(left,wz);
        const height=base+level*FLOOR_HEIGHT+CITY_VOXEL_SIZE;
        const root=new THREE.Group();root.name='terrace-skybridge';root.userData.terrainApplied=true;root.userData.furniture=true;
        const x0=left+.66,x1=right-.66,width=x1-x0;
        const deck=fineCube(width,.22,1.76,'#baab8e');deck.position.set((x0+x1)/2,height-.11,wz);deck.receiveShadow=true;deck.castShadow=true;root.add(deck);
        for(const side of [-1,1]){
          const rail=fineCube(width,.22,.22,'#557574');rail.position.set((x0+x1)/2,height+.88,wz+side*.88);root.add(rail);
          for(const x of [x0+.11,x1-.11]){const post=fineCube(.22,.88,.22,'#557574');post.position.set(x,height+.44,wz+side*.88);root.add(post);}
        }
        // Cut only the two existing parapet openings, keeping the roof deck.
        for(const x of [ax,bx])for(const index of this.voxelsByCell.get(this.grid.index(x,z))??[]) {
          const voxel=this.voxels[index];if(voxel.roof)continue;
          for(let sub=0;sub<voxel.pieces.length;sub++) {
            const y=voxel.y+voxel.positions[sub*3+1],vx=voxel.x+voxel.positions[sub*3],vz=voxel.z+voxel.positions[sub*3+2];
            if(y>height&&y<height+1.4&&Math.abs(vz-wz)<.9&&vx>=x0-.22&&vx<=x1+.22)voxel.pieces[sub]=0;
          }
        }
        deck.userData.walkSurfaceIds=[`bridge:${a.x}:${b.x}:${z}`];
        this.grid.surfaces.add({id:`bridge:${a.x}:${b.x}:${z}`,kind:'bridge',x0,x1,z0:wz-.77,z1:wz+.77,height,
          enabled:(x,z)=>{const p=this.interiorPieceByMesh.get(deck);return !p||p.alive&&this.pieceOccupies(p,x,p.center.y,z);}});
        this.scene.add(root);break;
      }
    }
  }

  private addBlockConnections(bounds: BlockBounds, plans: BuildingPlan[], district: District): void {
    if (!plans.length) return;
    if (district === 'industrial') {
      const pipeCell = this.grid.cell(bounds.x1 - 3, bounds.z1 - 3);
      if (this.entranceClear(pipeCell)) {
        const [x, z] = this.grid.world(bounds.x1 - 3, bounds.z1 - 3);
        const pipe = cube(0.29, 0.29, 4.3, '#d58161'); pipe.position.set(x, 2.1, z - 0.7); this.scene.add(pipe);
        for (const dz of [-2.3, 0.85]) { const support = cube(0.16, 2.2, 0.16, '#667c7d'); support.position.set(x, 1.05, z + dz); this.scene.add(support); }
      }
      for (let i = 0; i < 4; i++) {
        const [fx, fz] = this.grid.world(bounds.x1 - 2, bounds.z0 + 3 + i);
        const post = cube(0.1, 1.34, 0.1, '#566e72'); post.position.set(fx, 0.68, fz); this.scene.add(post);
        if (i < 3) { const rail = cube(0.1, 0.08, this.grid.cellSize, '#829696'); rail.position.set(fx, 1.18, fz + this.grid.cellSize / 2); this.scene.add(rail); }
      }
      return;
    }
    if (district === 'residential' && plans.length > 1) {
      const a = plans[0], b = plans[1];
      const [ax, az] = this.grid.world(a.x + a.width - 1, a.z + 1);
      const [bx, bz] = this.grid.world(b.x, b.z + 1);
      const distance = Math.hypot(bx - ax, bz - az);
      if (distance > 2 && distance < 16) {
        const line = cube(distance, 0.045, 0.045, '#657270');
        line.position.set((ax + bx) / 2, 2.22, (az + bz) / 2);
        line.rotation.y = -Math.atan2(bz - az, bx - ax); this.scene.add(line);
        for (let i = 0; i < 3; i++) {
          const t = (i + 1) / 4;
          const cloth = cube(0.38, 0.53, 0.08, ['#ef8d79', '#75bcae', '#f0c16d'][i]);
          cloth.position.set(THREE.MathUtils.lerp(ax, bx, t), 1.93, THREE.MathUtils.lerp(az, bz, t)); this.scene.add(cloth);
        }
      }
      for (let x = bounds.x0 + 3; x < bounds.x1 - 2; x += 2) {
        if (!this.entranceClear(this.grid.cell(x, bounds.z1 - 2))) continue;
        const [fx, fz] = this.grid.world(x, bounds.z1 - 2);
        const planter = cube(0.72, 0.32, 0.53, '#d18a67'); planter.position.set(fx, 0.26, fz + 0.68);
        const shrub = cube(0.63, 0.48, 0.44, '#6cab72'); shrub.position.set(fx, 0.63, fz + 0.68);
        this.scene.add(planter, shrub);
      }
    }
  }

  private addRoadDetails(bounds: BlockBounds): void {
    if (this.grid.hash(bounds.bx, bounds.bz, 93) > 0.38) {
      const [px, pz] = this.grid.world(bounds.x0 + 3, bounds.z0 + 3);
      const pole = cube(0.12, 2.7, 0.12, '#425e63'); pole.position.set(px + 0.9, 1.36, pz - 0.73);
      const light = cube(0.34, 0.75, 0.28, '#273d45'); light.position.set(px + 0.9, 2.51, pz - 0.73);
      const signal = cube(0.19, 0.18, 0.06, this.grid.hash(bounds.bx, bounds.bz, 94) > 0.5 ? '#77cd89' : '#ed7765');
      signal.position.set(px + 0.9, 2.63, pz - 0.56);
      signal.userData.cityLight = 'signal';
      signal.userData.lightColor = (signal.material as THREE.MeshStandardMaterial).color.getHexString() === '77cd89' ? '#77cd89' : '#ed7765';
      this.scene.add(pole, light, signal);
    }
  }

  private addBlockProps(bounds: BlockBounds, cells: Cell[], plans: BuildingPlan[]): void {
    const district = this.grid.districtAt(Math.floor((bounds.x0 + bounds.x1) / 2), Math.floor((bounds.z0 + bounds.z1) / 2));
    const profile = this.grid.blockProfile(bounds.bx, bounds.bz);
    if (bounds.bx === this.grid.terrain.canalColumn) {
      this.addSidewalkDetails(bounds,district);
    } else if (district === 'park') {
      const midX = Math.floor((bounds.x0 + bounds.x1) / 2);
      const midZ = Math.floor((bounds.z0 + bounds.z1) / 2);
      for (const cell of cells) {
        if (cell.tile !== 'park') continue;
        const [x, z] = this.grid.world(cell.x, cell.z);
        if (this.grid.parkPathAt(bounds, cell.x, cell.z) || this.grid.surfaces.at(x,z).length) continue;
        if (Math.hypot(cell.x - this.landmarkCell.x, cell.z - this.landmarkCell.z) < 2.3) continue;
        const chance = this.grid.hash(cell.x, cell.z, 37);
        if (chance > (profile.parkStyle === 'grove' ? 0.31 : profile.parkStyle === 'plaza' ? 0.14 : 0.23)) continue;
        const jitterX = (this.grid.hash(cell.x, cell.z, 42) - 0.5) * 0.82;
        const jitterZ = (this.grid.hash(cell.x, cell.z, 43) - 0.5) * 0.82;
        const tx = x + jitterX, tz = z + jitterZ;
        if (chance > (profile.parkStyle === 'grove' ? 0.14 : 0.10)) {
          const bush = cube(0.78, 0.48, 0.73, ['#4d914c', '#91c15d', '#4b9a76'][Math.floor(this.grid.hash(cell.x, cell.z, 45) * 3)]);
          bush.position.set(tx, 0.38, tz); bush.castShadow = true; this.scene.add(bush);
          for (let flowerIndex = 0; flowerIndex < 3; flowerIndex++) {
            const flower = cube(0.18, 0.2, 0.18, ['#f28f8d', '#ffd66f', '#d59ad9'][flowerIndex]);
            flower.position.set(tx + (flowerIndex - 1) * 0.32, 0.68, tz + (flowerIndex % 2 ? 0.22 : -0.16)); this.scene.add(flower);
          }
          continue;
        }
        cell.blocked = true;
        const tree=natureTree(Math.floor(this.grid.hash(cell.x,cell.z,38)*1000));tree.position.set(tx,0,tz);this.scene.add(tree);
        if(this.grid.hash(cell.x,cell.z,47)>.45){const patch=naturePatch(cell.x+cell.z);patch.position.set(tx+.88,0,tz+.88);this.scene.add(patch);}

      }
      if (this.landmarkCell.x >= bounds.x0 && this.landmarkCell.x < bounds.x1 && this.landmarkCell.z >= bounds.z0 && this.landmarkCell.z < bounds.z1) this.addFountain(this.landmarkCell);
      else if (profile.parkStyle === 'plaza' && this.grid.hash(bounds.bx, bounds.bz, 47) > 0.35) {
        const center = this.grid.cell(midX, midZ);
        if (center && !center.blocked) this.addFountain(center);
      }
      else if (profile.parkStyle !== 'plaza' && this.grid.hash(bounds.bx, bounds.bz, 47) > 0.42) {
        const pond = this.grid.cell(midX - 2, midZ + 2);
        if (pond?.tile === 'park' && !pond.blocked) this.addPond(pond);
      }
      for (const [dx, dz] of profile.parkStyle === 'plaza' ? [[-3, -2], [3, 2], [-3, 2]] : [[-2, -1], [2, 1]]) {
        const benchCell = this.grid.cell(midX + dx, midZ + dz);
        if (benchCell?.tile === 'park' && !benchCell.blocked) this.addBench(benchCell);
      }
      const flowerPalette = ['#ffc95f', '#f28a91', '#d29bdd', '#fff0c1', '#ef7d72'];
      for (let i = 0; i < 12; i++) {
        const gx = bounds.x0 + 3 + Math.floor(this.grid.hash(bounds.bx, i, 53) * Math.max(1, bounds.x1 - bounds.x0 - 5));
        const gz = bounds.z0 + 3 + Math.floor(this.grid.hash(bounds.bz, i, 54) * Math.max(1, bounds.z1 - bounds.z0 - 5));
        const cell = this.grid.cell(gx, gz);
        if (cell?.tile !== 'park' || cell.blocked || this.grid.parkPathAt(bounds, gx, gz)) continue;
        const [x, z] = this.grid.world(gx, gz);
        const paletteOffset = Math.floor(this.grid.hash(gx, gz, 604) * flowerPalette.length);
        for (let bloom = 0; bloom < 3; bloom++) {
          const flower = cube(0.25, 0.33, 0.25, flowerPalette[(paletteOffset + bloom) % flowerPalette.length]);
          flower.position.set(x + (bloom - 1) * 0.31 + this.grid.hash(gx, bloom, 606) * 0.08, 0.28,
            z + (bloom === 1 ? 0.2 : -0.1) + this.grid.hash(gz, bloom, 607) * 0.08);
          this.scene.add(flower);
        }
      }
      this.addParkLandscaping(bounds, midX, midZ);
      this.addParkFeatures(bounds, midX, midZ);
    } else {
      if (profile.form === 'pocket') this.addPocketPark(bounds);
      this.addDistrictActivity(district, plans);
      const sidewalk = cells.find((cell) => cell.tile === 'sidewalk' && cell.x === bounds.x0 + 3 && cell.z === bounds.z0 + 3);
      if (this.entranceClear(sidewalk)) this.addLamp(sidewalk!);
      const farLamp = cells.filter((cell) => cell.tile === 'sidewalk' && this.entranceClear(cell) &&
        (!sidewalk || Math.hypot(cell.x - sidewalk.x, cell.z - sidewalk.z) > 6))
        .sort((a, b) => Math.hypot(a.x - bounds.x1 + 3, a.z - bounds.z1 + 3) -
          Math.hypot(b.x - bounds.x1 + 3, b.z - bounds.z1 + 3))[0];
      if (farLamp && this.grid.hash(bounds.bx, bounds.bz, 735) > 0.2) this.addLamp(farLamp);
      const first = this.grid.cell(bounds.x1 - 2, bounds.z0 + 3);
      if (first?.active && first.tile === 'sidewalk' && this.entranceClear(first)) this.addPlanter(first);
      const second = this.grid.cell(bounds.x0 + 3, bounds.z1 - 2);
      if (second?.active && second.tile === 'sidewalk' && this.entranceClear(second) && this.grid.hash(bounds.bx, bounds.bz, 70) > 0.35) this.addStreetProp(second, district);
      const hazard = this.grid.cell(bounds.x0 + 3, bounds.z0 + 5);
      if (hazard?.active && hazard.tile === 'sidewalk' && this.entranceClear(hazard) && this.grid.hash(bounds.bx, bounds.bz, 72) > 0.66) this.addHazardProp(hazard, district === 'industrial' ? 'electric' : 'water');
      this.addSidewalkDetails(bounds, district);
      this.addCourtyardVegetation(bounds, district);
      if (profile.form === 'yard' || profile.form === 'courtyard') this.addCourtyardFeature(bounds, district, plans);
      if (district === 'industrial') {
        const yard = this.grid.cell(bounds.x1 - 2, bounds.z1 - 2);
        if (yard?.active && !yard.blocked && this.entranceClear(yard)) this.addContainer(yard, bounds.bx + bounds.bz);
      }
    }
    const spawnBlock = this.grid.blockAt(this.grid.center + 1, this.grid.center + 1);
    if (bounds.bx === spawnBlock.bx && bounds.bz === spawnBlock.bz) {
      const starter = this.grid.cell(this.grid.center, this.grid.center + 1);
      if (starter?.active) this.addVehicle(starter, 80, { type: 'scooter', horizontal: false });
    }
    const traffic = district === 'commercial' ? 0.56 : district === 'residential' ? 0.48 : district === 'industrial' ? 0.45 : 0.32;
    const parking = [
      [bounds.x0 + 1, bounds.z0 + 6, 201, 0],
      [bounds.x0 + 1, bounds.z1 - 4, 202, 0],
      [bounds.x0 + 6, bounds.z0 + 1, 203, 1],
      [bounds.x1 - 4, bounds.z0 + 1, 204, 1]
    ];
    for (const [gx, gz, salt, horizontal] of parking) {
      if (this.grid.hash(bounds.bx, bounds.bz, salt) > traffic * (0.45 + this.streetActivity * 0.55)) continue;
      const road = this.grid.cell(gx, gz);
      if (road?.active && road.tile === 'road') this.addVehicle(road, Math.floor(this.grid.hash(gx, gz, salt + 20) * 100), { horizontal: Boolean(horizontal) });
    }
    const flowing = [[bounds.x0 + 1, bounds.z0 + 6, 211, 0], [bounds.x0 + 6, bounds.z0 + 1, 212, 1]];
    for (const [gx, gz, salt, horizontal] of flowing) {
      if (this.grid.hash(bounds.bx, bounds.bz, salt) > 0.63 * this.streetActivity) continue;
      const road = this.grid.cell(gx, gz);
      if (road?.active && road.tile === 'road') this.addVehicle(road, Math.floor(this.grid.hash(gx, gz, salt + 30) * 100), { moving: true, horizontal: Boolean(horizontal), type: this.grid.hash(gx, gz, salt + 31) > 0.78 ? 'scooter' : undefined });
    }
  }

  private addPocketPark(bounds: BlockBounds): void {
    const start = this.grid.pocketStart(bounds);
    const centerX = (bounds.x0 + bounds.x1) >> 1;
    const candidates: Cell[] = [];
    for (let gz = start; gz < bounds.z1 - 1; gz++) for (let gx = bounds.x0 + 4; gx < bounds.x1 - 1; gx++) {
      const cell = this.grid.cell(gx, gz);
      if (cell?.active && cell.tile === 'park' && !cell.blocked && !this.grid.parkPathAt(bounds, gx, gz)) candidates.push(cell);
    }
    candidates.sort((a, b) => this.grid.hash(a.x, a.z, 601) - this.grid.hash(b.x, b.z, 601));
    let trees = 0, flowers = 0;
    for (const cell of candidates) {
      if (trees < 3 && cell.x !== centerX + 1 && this.grid.hash(cell.x, cell.z, 602) < 0.25) {
        this.addStreetTree(cell, this.grid.blockProfile(bounds.bx, bounds.bz).district, 0);
        cell.blocked = true;
        trees++;
      } else if (flowers < 4 && this.grid.hash(cell.x, cell.z, 603) < 0.18) {
        const [x, z] = this.grid.world(cell.x, cell.z);
        const soil = cube(0.92, 0.16, 0.87, '#b69374'); soil.position.set(x, 0.16, z); this.scene.add(soil);
        for (const side of [-1, 0, 1]) {
          const bloom = cube(0.23, 0.41, 0.22, ['#ec9198', '#eccb72', '#a79ed1'][side + 1]);
          bloom.position.set(x + side * 0.27, 0.46, z); this.scene.add(bloom);
        }
        flowers++;
      }
    }
    const bench = this.grid.cell(centerX + 2, Math.min(bounds.z1 - 3, start + 1));
    if (bench?.active && bench.tile === 'park' && !bench.blocked && this.entranceClear(bench)) this.addBench(bench);
  }

  private addDistrictActivity(district: District, plans: BuildingPlan[]): void {
    for (const plan of plans) {
      const front = frontageZ(plan), direction = frontageDirection(plan);
      const door = plan.x + Math.floor(plan.width / 2);
      const candidates = [plan.x, plan.x + plan.width - 1];
      const side = candidates.find((gx) => Math.abs(gx - door) > 1 && this.entranceClear(this.grid.cell(gx, front + direction)));
      if (side === undefined) continue;
      const propCell = this.grid.cell(side, front + direction);
      if (!propCell?.active || propCell.blocked || propCell.tile === 'road') continue;
      const [x, z] = this.grid.world(propCell.x, propCell.z);
      if (plan.type === 'shop' && this.grid.hash(plan.x, plan.z, 610) < 0.78) {
        const stand = cube(0.86, 0.75, 0.58, ['#e6ae69', '#77aaa8', '#df897b'][plan.variant % 3]);
        stand.position.set(x, 0.43, z - direction * 0.58); stand.castShadow = true; this.scene.add(stand);
        const goods = cube(0.72, 0.19, 0.52, ['#e9cf76', '#9bc777', '#e79d8c'][plan.variant % 3]);
        goods.position.set(x, 0.93, z - direction * 0.58); this.scene.add(goods);
      } else if ((plan.type === 'factory' || plan.type === 'workshop') && this.grid.hash(plan.x, plan.z, 611) < 0.7) {
        const pallet = cube(0.91, 0.18, 0.82, '#987b60'); pallet.position.set(x, 0.18, z - direction * 0.48); this.scene.add(pallet);
        const parcel = cube(0.65, 0.65, 0.61, district === 'industrial' ? '#d99d6e' : '#90b4a4');
        parcel.position.set(x, 0.58, z - direction * 0.48); this.scene.add(parcel);
      }
      const anchor = this.grid.cell(side + (side < door ? 1 : -1), front + direction);
      if (anchor?.active && !anchor.blocked && anchor.tile !== 'road') this.publicAnchors.push({ cell: anchor, activity: plan.type === 'shop' ? 'browse' : 'wait' });
    }
  }

  private addCourtyardFeature(bounds: BlockBounds, district: District, plans: BuildingPlan[]): void {
    const midX = (bounds.x0 + bounds.x1) >> 1, midZ = (bounds.z0 + bounds.z1) >> 1;
    const offsets = [[0, 0], [2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [-2, -2]];
    const cell = offsets.map(([dx, dz]) => this.grid.cell(midX + dx, midZ + dz)).find((candidate) =>
      candidate?.active && candidate.tile === 'lot' && !candidate.blocked && this.entranceClear(candidate) &&
      !plans.some((plan) => candidate.x >= plan.x && candidate.x < plan.x + plan.width && candidate.z >= plan.z && candidate.z < plan.z + plan.depth));
    if (!cell) return;
    const variant = Math.floor(this.grid.hash(bounds.bx, bounds.bz, 635) * 3);
    if (district === 'residential' && variant === 0) { this.addBench(cell); return; }
    const [x, z] = this.grid.world(cell.x, cell.z);
    if (district === 'industrial') {
      if (variant === 0) {
        const pad = cube(1.62, 0.26, 1.52, '#9eaaa4'); pad.position.set(x, 0.2, z); this.scene.add(pad);
        for (const side of [-1, 1]) {
          const support = cube(0.2, 3.65, 0.2, '#647e80'); support.position.set(x + side * 0.58, 2.12, z); this.scene.add(support);
        }
        const tank = cube(1.55, 1.12, 1.38, '#cc9d76'); tank.position.set(x, 4.18, z); tank.castShadow = true; this.scene.add(tank);
        const cap = cube(1.72, 0.18, 1.53, '#546f75'); cap.position.set(x, 4.84, z); this.scene.add(cap);
      } else {
        const pallet = cube(1.7, 0.22, 1.5, '#a8805c'); pallet.position.set(x, 0.18, z); this.scene.add(pallet);
        for (const side of [-1, 0, 1]) {
          const cargo = cube(0.46, side === 0 ? 1.1 : 0.72, 0.67, side === 0 ? '#6995a0' : '#cf9970');
          cargo.position.set(x + side * 0.52, side === 0 ? 0.84 : 0.65, z); this.scene.add(cargo);
        }
      }
    } else if (district === 'residential') {
      const planter = cube(1.54, 0.27, 0.72, '#d39372'); planter.position.set(x, 0.27, z); this.scene.add(planter);
      for (const side of [-1, 0, 1]) {
        const bloom = cube(0.38, 0.65, 0.36, side === 0 ? '#e9a0a6' : '#86b87f');
        bloom.position.set(x + side * 0.46, 0.71, z); this.scene.add(bloom);
      }
      if (variant === 2) {
        for (const side of [-1, 1]) {
          const post = cube(0.14, 2.0, 0.14, '#8f765e'); post.position.set(x + side * 0.76, 1.06, z + 0.53); this.scene.add(post);
        }
        const line = cube(1.58, 0.08, 0.08, '#f5e4c5'); line.position.set(x, 1.93, z + 0.53); this.scene.add(line);
        const cloth = cube(0.62, 0.54, 0.08, '#81b8bb'); cloth.position.set(x - 0.31, 1.60, z + 0.53); this.scene.add(cloth);
      }
    } else if (variant === 1) {
      const table = cube(1.25, 0.13, 0.88, '#b6835c'); table.position.set(x, 0.78, z); this.scene.add(table);
      const stem = cube(0.12, 2.35, 0.12, '#5c7977'); stem.position.set(x, 1.24, z); this.scene.add(stem);
      const parasol = cube(2.0, 0.18, 1.83, '#e7a36f'); parasol.position.set(x, 2.45, z); this.scene.add(parasol);
      for (const side of [-1, 1]) {
        const stool = cube(0.43, 0.14, 0.43, '#86aaa0'); stool.position.set(x + side * 0.85, 0.48, z); this.scene.add(stool);
      }
    } else {
      const booth = cube(1.36, 1.32, 1.1, ['#77aaa2', '#d8a36f', '#cf8b96'][variant]);
      booth.position.set(x, 0.72, z); booth.castShadow = true; this.scene.add(booth);
      const canopy = cube(1.8, 0.18, 1.52, '#edcc85'); canopy.position.set(x, 1.92, z); this.scene.add(canopy);
    }
    cell.blocked = true;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const neighbor = this.grid.cell(cell.x + dx, cell.z + dz);
      if (neighbor?.active && !neighbor.blocked && neighbor.tile !== 'road' && this.entranceClear(neighbor)) {
        this.publicAnchors.push({ cell: neighbor, activity: district === 'commercial' ? 'browse' : 'wait' });
        break;
      }
    }
  }

  private addFountain(cell: Cell): void {
    cell.blocked = true;
    const [x, z] = this.grid.world(cell.x, cell.z);
    const base = cube(3.6, 0.5, 3.6, '#d9d0b5'); base.position.set(x, 0.34, z); base.castShadow = true; this.scene.add(base);
    const water = cube(2.8, 0.09, 2.8, '#5ac3d0', 0.36); water.position.set(x, 0.64, z); this.scene.add(water);
    const spout = cube(0.52, 1.35, 0.52, '#e6d9bc'); spout.position.set(x, 1.24, z); this.scene.add(spout);
    for (const [dx, dz] of [[-2.2, 0], [2.2, 0], [0, -2.2], [0, 2.2]]) { const flower = cube(0.4, 0.43, 0.4, '#f3909b'); flower.position.set(x + dx, 0.26, z + dz); this.scene.add(flower); }
  }

  private addBench(cell: Cell): void {
    cell.blocked = true;
    const [x, z] = this.grid.world(cell.x, cell.z);
    const bench = new THREE.Group();
    const seat = cube(1.65, 0.16, 0.5, '#a87752'); seat.position.y = 0.62; bench.add(seat);
    const back = cube(1.65, 0.73, 0.13, '#a87752'); back.position.set(0, 1.03, -0.29); bench.add(back);
    for (const side of [-1, 1]) { const leg = cube(0.1, 0.55, 0.48, '#3d5356'); leg.position.set(side * 0.63, 0.31, 0); bench.add(leg); }
    bench.position.set(x, 0, z); this.scene.add(bench);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const next = this.grid.cell(cell.x + dx, cell.z + dz);
      if (next?.active && !next.blocked && this.entranceClear(next) &&
          (next.tile === 'park' || cell.tile === 'lot' && next.tile === 'lot')) {
        this.publicAnchors.push({ cell: next, activity: 'rest' });
        break;
      }
    }
  }

  private addPond(cell: Cell): void {
    cell.blocked = true;
    const [x, z] = this.grid.world(cell.x, cell.z);
    const rim = cube(2.05, 0.16, 1.77, '#ddd0af'); rim.position.set(x, 0.18, z); this.scene.add(rim);
    const water = cube(1.71, 0.025, 1.45, '#64bbc5'); water.position.set(x, 0.28, z); this.scene.add(water);
    for (const side of [-1, 1]) {
      const reeds = cube(0.18, 0.48, 0.18, '#77a96f'); reeds.position.set(x + side * 0.73, 0.51, z - 0.53); this.scene.add(reeds);
    }
  }

  private addParkLandscaping(bounds: BlockBounds, midX: number, midZ: number): void {
    const style = this.grid.blockProfile(bounds.bx, bounds.bz).parkStyle;
    const stone = '#cfc6aa';
    const [frontX, frontZ] = this.grid.world(midX, bounds.z1 - 3);
    const isCentral = this.landmarkCell.x >= bounds.x0 && this.landmarkCell.x < bounds.x1 && this.landmarkCell.z >= bounds.z0 && this.landmarkCell.z < bounds.z1;
    if (style !== 'grove') for (let gx = bounds.x0 + 3; gx < bounds.x1 - 2; gx++) {
      if (Math.abs(gx - midX) <= 1) continue;
      for (const gz of [bounds.z0 + 3, bounds.z1 - 3]) {
        const cell = this.grid.cell(gx, gz);
        if (!cell?.active || cell.tile !== 'park' || cell.blocked) continue;
        const [x, z] = this.grid.world(gx, gz);
        const wall = cube(2.15, 0.48, 0.34, stone); wall.position.set(x, 0.34, z + (gz < midZ ? -0.7 : 0.7)); wall.castShadow = true; this.scene.add(wall);
        cell.blocked = true;
      }
    }
    if (style === 'garden') for (let gz = bounds.z0 + 4; gz < bounds.z1 - 3; gz++) {
      if (Math.abs(gz - midZ) <= 1) continue;
      for (const gx of [bounds.x0 + 3, bounds.x1 - 3]) {
        const cell = this.grid.cell(gx, gz);
        if (!cell?.active || cell.tile !== 'park' || cell.blocked) continue;
        const [x, z] = this.grid.world(gx, gz);
        const wall = cube(0.34, 0.48, 2.15, stone); wall.position.set(x + (gx < midX ? -0.7 : 0.7), 0.34, z); wall.castShadow = true; this.scene.add(wall);
        cell.blocked = true;
      }
    }
    const sign = signFace(isCentral ? 'PARQUE CENTRAL' : style === 'grove' ? 'BOSQUE URBANO' : style === 'plaza' ? 'PLAZA CÍVICA' : 'JARDÍN', '#526a5c', '#fff4d9', 3.6, 0.52);
    sign.position.set(frontX + 3.3, 0.75, frontZ + 1.0); this.scene.add(sign);
    const signBase = cube(3.8, 0.66, 0.2, '#bfb9a0'); signBase.position.set(frontX + 3.3, 0.73, frontZ + 0.89); this.scene.add(signBase);
    for (const [gx, gz] of [[bounds.x0 + 3, bounds.z0 + 3], [bounds.x1 - 2, bounds.z1 - 2]]) {
      const cell = this.grid.cell(gx, gz);
      if (cell?.active && cell.tile === 'sidewalk') this.addLamp(cell);
    }
    for (let i = 0; i < 18; i++) {
      const gx = bounds.x0 + 3 + Math.floor(this.grid.hash(bounds.bx + i, bounds.bz, 510) * Math.max(1, bounds.x1 - bounds.x0 - 5));
      const gz = bounds.z0 + 3 + Math.floor(this.grid.hash(bounds.bx, bounds.bz + i, 511) * Math.max(1, bounds.z1 - bounds.z0 - 5));
      const cell = this.grid.cell(gx, gz);
      if (!cell?.active || cell.tile !== 'park' || gx === midX || gz === midZ) continue;
      const [x, z] = this.grid.world(gx, gz);
      for (let petal = 0; petal < 3; petal++) {
        const shrub = cube(0.34, 0.28, 0.34, petal % 2 ? '#79ad67' : '#6a9e64');
        shrub.position.set(x + (petal - 1) * 0.32, 0.25, z + (petal % 2) * 0.25); this.scene.add(shrub);
        const bloom = cube(0.17, 0.19, 0.17, ['#efa28b', '#f4d376', '#e7a3ba'][petal]);
        bloom.position.set(x + (petal - 1) * 0.32, 0.49, z + (petal % 2) * 0.25); this.scene.add(bloom);
      }
    }
  }

  private addParkFeatures(bounds: BlockBounds, midX: number, midZ: number): void {
    type Feature = 'pergola' | 'chess' | 'picnic' | 'sculpture' | 'market' | 'exercise';
    const style = this.grid.blockProfile(bounds.bx, bounds.bz).parkStyle;
    const choices: Record<typeof style, Feature[]> = {
      garden: ['pergola', 'chess', 'picnic'],
      plaza: ['sculpture', 'market', 'chess'],
      grove: ['picnic', 'exercise', 'pergola']
    };
    const options = choices[style];
    const first = Math.floor(this.grid.hash(bounds.bx, bounds.bz, 713) * options.length);
    const candidates: Cell[] = [];
    for (let gz = bounds.z0 + 4; gz < bounds.z1 - 3; gz++) for (let gx = bounds.x0 + 4; gx < bounds.x1 - 3; gx++) {
      const cell = this.grid.cell(gx, gz);
      if (!cell?.active || cell.tile !== 'park' || cell.blocked || this.grid.parkPathAt(bounds, gx, gz) ||
          Math.hypot(gx - midX, gz - midZ) < 3.1 || !this.entranceClear(cell)) continue;
      candidates.push(cell);
    }
    candidates.sort((a, b) => this.grid.hash(a.x, a.z, 714) - this.grid.hash(b.x, b.z, 714));
    const used: Cell[] = [];
    for (let index = 0; index < 2; index++) {
      const cell = candidates.find((candidate) => !candidate.blocked && used.every((other) =>
        Math.hypot(candidate.x - other.x, candidate.z - other.z) >= 3));
      if (!cell) break;
      const feature = options[(first + index) % options.length];
      const [x, z] = this.grid.world(cell.x, cell.z);
      const group = new THREE.Group(); group.position.set(x, 0, z);
      const add = (w: number, h: number, d: number, paint: string, px: number, py: number, pz: number): void => {
        const part = cube(w, h, d, paint); part.position.set(px, py, pz); group.add(part);
      };
      if (feature === 'pergola') {
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(0.22, 2.2, 0.22, '#8b7056', sx * 0.77, 1.12, sz * 0.77);
        for (const side of [-1, 0, 1]) add(1.9, 0.16, 0.2, side === 0 ? '#678f67' : '#a78261', 0, 2.25, side * 0.63);
        add(1.1, 0.24, 0.44, '#a87f5c', 0, 0.67, 0);
      } else if (feature === 'chess') {
        add(1.18, 0.13, 1.18, '#eee3c8', 0, 0.84, 0);
        add(0.22, 0.7, 0.22, '#775f51', 0, 0.43, 0);
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
          add(0.31, 0.04, 0.31, sx === sz ? '#566d68' : '#d4ae80', sx * 0.29, 0.93, sz * 0.29);
        }
        for (const side of [-1, 1]) {
          add(0.44, 0.1, 0.48, '#c98964', side * 0.83, 0.53, 0);
          add(0.18, 0.49, 0.18, '#626f6b', side * 0.83, 0.29, 0);
        }
      } else if (feature === 'picnic') {
        add(1.45, 0.14, 0.72, '#bb8e62', 0, 0.77, 0);
        for (const side of [-1, 1]) {
          add(1.28, 0.12, 0.32, '#a97654', 0, 0.43, side * 0.7);
          add(0.17, 0.68, 0.17, '#6b6f64', side * 0.45, 0.38, 0);
        }
        add(0.22, 0.31, 0.22, '#efbd74', 0.33, 1.0, 0.1);
      } else if (feature === 'sculpture') {
        add(1.65, 0.28, 1.65, '#d6c9ad', 0, 0.22, 0);
        add(0.72, 0.7, 0.72, '#e08671', -0.27, 0.71, 0.12);
        add(0.46, 0.9, 0.46, '#69aca9', 0.24, 1.17, -0.19);
        add(0.72, 0.22, 0.45, '#e9be71', 0.12, 1.72, 0.13);
      } else if (feature === 'market') {
        add(1.65, 0.16, 0.72, '#9c7457', 0, 0.81, 0);
        for (const side of [-1, 1]) add(0.16, 1.9, 0.16, '#596e68', side * 0.7, 1.08, 0);
        for (let stripe = -2; stripe <= 2; stripe++) add(0.35, 0.15, 1.5, stripe % 2 ? '#f5e9d3' : '#df846b', stripe * 0.35, 2.03, 0);
        for (const side of [-1, 0, 1]) add(0.27, 0.22, 0.27, side === 0 ? '#efbd77' : '#85b976', side * 0.38, 1.03, 0);
      } else {
        add(1.8, 0.08, 1.8, '#acb9a3', 0, 0.16, 0);
        for (const side of [-1, 1]) add(0.2, 2.1, 0.2, '#567982', side * 0.68, 1.13, 0);
        add(1.55, 0.18, 0.18, '#e9bd75', 0, 2.14, 0);
        add(0.65, 0.14, 0.34, '#719f83', 0, 0.63, 0.45);
      }
      group.rotation.y = this.grid.hash(cell.x, cell.z, 715) > 0.5 ? Math.PI / 2 : 0;
      this.scene.add(group);
      cell.blocked = true;
      used.push(cell);
      const nearby = [[1, 0], [-1, 0], [0, 1], [0, -1]]
        .map(([dx, dz]) => this.grid.cell(cell.x + dx, cell.z + dz))
        .find((neighbor) => neighbor?.active && neighbor.tile === 'park' && !neighbor.blocked);
      if (nearby) this.publicAnchors.push({ cell: nearby, activity: feature === 'market' || feature === 'sculpture' ? 'browse' : 'rest' });
    }
  }

  private addCourtyardVegetation(bounds: BlockBounds, district: District): void {
    const candidates: Cell[] = [];
    for (let gz = bounds.z0 + 3; gz < bounds.z1 - 2; gz++) for (let gx = bounds.x0 + 3; gx < bounds.x1 - 2; gx++) {
      const cell = this.grid.cell(gx, gz);
      if (!cell?.active || cell.tile !== 'lot' || cell.blocked || !this.entranceClear(cell)) continue;
      if (this.interiorAreas.some((room) => gx >= room.x0 && gx < room.x1 && gz >= room.z0 && gz < room.z1)) continue;
      candidates.push(cell);
    }
    candidates.sort((a, b) => this.grid.hash(b.x, b.z, 498) - this.grid.hash(a.x, a.z, 498));
    const selected: Cell[] = [];
    for (const cell of candidates) {
      if (selected.some((other) => Math.abs(other.x - cell.x) + Math.abs(other.z - cell.z) < 3)) continue;
      selected.push(cell);
      if (selected.length >= (district === 'industrial' ? 5 : district === 'commercial' ? 5 : 7)) break;
    }
    for (let index = 0; index < selected.length; index++) {
      const cell = selected[index];
      const gx = cell.x, gz = cell.z;
      const [x, z] = this.grid.world(gx, gz);
      if (district === 'industrial' && index % 2 === 0) {
        if (index === 0) this.addContainer(cell, index + bounds.bx);
        else {
          const pallet = cube(1.42, 0.17, 1.32, '#9d7855'); pallet.position.set(x, 0.2, z); this.scene.add(pallet);
          for (const side of [-1, 1]) {
            const crate = cube(0.55, 0.64 + (side + 1) * 0.17, 0.57, side < 0 ? '#c88d61' : '#739299');
            crate.position.set(x + side * 0.35, 0.54, z); crate.castShadow = true; this.scene.add(crate);
          }
          cell.blocked = true;
        }
        continue;
      }
      if (district === 'commercial' && index % 3 === 1) {
        this.addStreetProp(cell, 'commercial');
        cell.blocked = true;
        continue;
      }
      if (district === 'residential' && index % 3 === 0) {
        this.addStreetTree(cell, district, 0);
        cell.blocked = true;
        continue;
      }
      const bed = cube(1.32, 0.09, 1.28, district === 'industrial' ? '#a69d80' : '#a68165'); bed.position.set(x, 0.12, z); this.scene.add(bed);
      for (const side of [-1, 0, 1]) {
        const leafy = cube(0.48, 0.43 + (side === 0 ? 0.18 : 0), 0.45, district === 'industrial' ? '#6b936e' : side === 0 ? '#6ca764' : '#8ebd67');
        leafy.position.set(x + side * 0.39, 0.39, z + (side % 2) * 0.16); leafy.castShadow = true; this.scene.add(leafy);
        if (district !== 'industrial' && side !== 0) {
          const bloom = cube(0.18, 0.21, 0.18, side < 0 ? '#ed918c' : '#eec77b');
          bloom.position.set(x + side * 0.39, 0.7, z); this.scene.add(bloom);
        }
      }
    }
  }

  private addStreetTree(cell: Cell, _district: District, offsetX: number): void {
    const [x,z]=this.grid.world(cell.x,cell.z),seed=Math.floor(this.grid.hash(cell.x,cell.z,481)*1000);
    const tree=natureTree(seed);tree.position.set(x+offsetX,.22,z);this.scene.add(tree);
    const planter=cube(1.32,.44,1.32,'#bb8264');planter.position.set(x+offsetX,.22,z);this.scene.add(planter);
  }

  private addSidewalkDetails(bounds: BlockBounds, district: District): void {
    const places: Array<{ gx: number; gz: number; ox: number; oz: number; horizontal: boolean }> = [];
    for (let gx = bounds.x0 + 3; gx < bounds.x1 - 2; gx += 2) {
      places.push({ gx, gz: bounds.z0 + 3, ox: 0, oz: 0.72, horizontal: true });
      places.push({ gx, gz: bounds.z1 - 2, ox: 0, oz: -0.72, horizontal: true });
    }
    for (let gz = bounds.z0 + 4; gz < bounds.z1 - 3; gz += 2) {
      places.push({ gx: bounds.x0 + 3, gz, ox: 0.72, oz: 0, horizontal: false });
      places.push({ gx: bounds.x1 - 2, gz, ox: -0.72, oz: 0, horizontal: false });
    }
    for (const place of places) {
      const cell = this.grid.cell(place.gx, place.gz);
      if (!cell?.active || cell.tile !== 'sidewalk' || cell.blocked || !this.entranceClear(cell)) continue;
      const chance = this.grid.hash(place.gx, place.gz, 490);
      const [wx, wz] = this.grid.world(place.gx, place.gz);
      if (chance > 0.78) {
        const inset = cube(place.horizontal ? 0.82 : 0.12, 0.014, place.horizontal ? 0.12 : 0.82, district === 'commercial' ? '#e8ac78' : district === 'industrial' ? '#8ba3a1' : '#d4ad86');
        inset.position.set(wx - place.ox * 0.9, 0.13, wz - place.oz * 0.9); this.scene.add(inset);
      }
      if (chance > 0.55) continue;
      const variant = Math.floor(this.grid.hash(place.gx, place.gz, 491) * 5);
      const furniture = new THREE.Group(); furniture.position.set(wx + place.ox, 0, wz + place.oz);
      if (!place.horizontal) furniture.rotation.y = Math.PI / 2;
      if (variant === 0) {
        const bin = cube(0.48, 0.68, 0.46, district === 'industrial' ? '#708d91' : '#5a9b8d'); bin.position.y = 0.4; furniture.add(bin);
        const lid = cube(0.58, 0.1, 0.55, '#344e52'); lid.position.y = 0.78; furniture.add(lid);
        const badge = cube(0.25, 0.09, 0.02, '#f0e1b8'); badge.position.set(0, 0.48, 0.25); furniture.add(badge);
      } else if (variant === 1) {
        for (const side of [-1, 1]) {
          const stand = cube(0.08, 0.55, 0.08, '#6a8181'); stand.position.set(side * 0.31, 0.34, 0); furniture.add(stand);
        }
        const rail = cube(0.73, 0.08, 0.08, '#a7b7aa'); rail.position.y = 0.61; furniture.add(rail);
        const wheel = cube(0.15, 0.43, 0.43, '#354e56'); wheel.position.set(0.1, 0.31, 0.12); furniture.add(wheel);
      } else if (variant === 2) {
        const planter = cube(0.68, 0.35, 0.58, '#c98266'); planter.position.y = 0.3; furniture.add(planter);
        for (const side of [-1, 0, 1]) {
          const flower = cube(0.24, 0.38, 0.24, ['#ffd06a', '#63b786', '#f18b91'][side + 1]);
          flower.position.set(side * 0.19, 0.66, 0); furniture.add(flower);
        }
      } else if (variant === 3 && district === 'commercial') {
        const table = cube(0.86, 0.09, 0.72, '#eac591'); table.position.y = 0.8; furniture.add(table);
        const foot = cube(0.1, 0.75, 0.1, '#6d817b'); foot.position.y = 0.4; furniture.add(foot);
        const stool = cube(0.4, 0.09, 0.35, '#dd8871'); stool.position.set(0.62, 0.49, 0); furniture.add(stool);
      } else {
        const post = cube(0.13, 1.35, 0.13, '#48666b'); post.position.y = 0.72; furniture.add(post);
        const panel = cube(0.56, 0.54, 0.12, district === 'commercial' ? '#f0bc66' : '#8dc0b1'); panel.position.set(0, 1.21, 0); furniture.add(panel);
        const cap = cube(0.68, 0.09, 0.18, '#324e55'); cap.position.set(0, 1.53, 0); furniture.add(cap);
      }
      this.scene.add(furniture);
    }
    const treeCell = this.grid.cell(bounds.x1 - 2, bounds.z0 + 5);
    const greenery = this.grid.blockProfile(bounds.bx, bounds.bz).greenery;
    if (treeCell?.tile === 'sidewalk' && !treeCell.blocked && this.entranceClear(treeCell) && this.grid.hash(bounds.bx, bounds.bz, 493) > 0.56 - greenery * 0.42) {
      this.addStreetTree(treeCell, district, -0.7);
    }
    const otherTree = this.grid.cell(bounds.x0 + 3, bounds.z1 - 5);
    if (otherTree?.tile === 'sidewalk' && !otherTree.blocked && this.entranceClear(otherTree) && district !== 'industrial' && this.grid.hash(bounds.bx, bounds.bz, 495) > 0.69 - greenery * 0.42) this.addStreetTree(otherTree, district, 0.7);
    const shelterCell = this.grid.cell(bounds.x0 + 4, bounds.z0 + 3);
    if (district !== 'industrial' && shelterCell?.tile === 'sidewalk' && this.entranceClear(shelterCell) && this.grid.hash(bounds.bx, bounds.bz, 494) > 0.66) {
      const [x, z] = this.grid.world(shelterCell.x, shelterCell.z);
      const shelter = new THREE.Group(); shelter.position.set(x, 0, z + 0.62);
      const roof = cube(1.86, 0.14, 1.03, district === 'commercial' ? '#df876d' : '#79aaa6'); roof.position.y = 2.22; shelter.add(roof);
      for (const side of [-1, 1]) {
        const post = cube(0.12, 2.05, 0.12, '#4e7075'); post.position.set(side * 0.82, 1.12, 0.28); shelter.add(post);
      }
      const back = cube(1.68, 1.12, 0.08, '#9dbfc0'); back.position.set(0, 1.13, 0.38); shelter.add(back);
      const seat = cube(1.4, 0.15, 0.35, '#d3ad7c'); seat.position.set(0, 0.67, 0.13); shelter.add(seat);
      const sign = cube(0.45, 0.31, 0.08, '#f5e2ac'); sign.position.set(0.53, 1.68, 0.45); shelter.add(sign);
      this.scene.add(shelter);
    }
  }

  private addLamp(cell: Cell): void {
    const [x, z] = this.grid.world(cell.x, cell.z);
    const post = cube(0.14, 3.8, 0.14, '#344c55'); post.position.set(x + 0.7, 1.9, z + 0.7); post.castShadow = true;
    const cap = cube(0.73, 0.14, 0.73, '#344c55'); cap.position.set(x + 1.14, 3.75, z + 0.7);
    const lamp = cube(0.51, 0.28, 0.51, '#fff0b8'); lamp.position.set(x + 1.14, 3.53, z + 0.7);
    lamp.material = streetLampMaterial;
    lamp.userData.cityLight = 'street';
    this.scene.add(post, cap, lamp);
  }

  private addPlanter(cell: Cell): void {
    const [x, z] = this.grid.world(cell.x, cell.z);
    const pot = cube(0.82, 0.45, 0.82, '#d57d64'); pot.position.set(x, 0.29, z);
    const bush = cube(0.92, 0.74, 0.92, '#5fab70'); bush.position.set(x, 0.81, z); bush.castShadow = true;
    this.scene.add(pot, bush);
  }

  private addStreetProp(cell: Cell, district: District): void {
    const [x, z] = this.grid.world(cell.x, cell.z);
    if (district === 'commercial') {
      const stand = cube(0.74, 1.25, 0.62, '#e8c16e'); stand.position.set(x, 0.63, z); stand.castShadow = true; this.scene.add(stand);
      const top = cube(0.88, 0.14, 0.76, '#ed7869'); top.position.set(x, 1.32, z); this.scene.add(top);
    } else {
      const body = cube(0.8, 0.89, 0.68, district === 'industrial' ? '#668fa0' : '#e5ba64'); body.position.set(x, 0.46, z); body.castShadow = true; this.scene.add(body);
      const top = cube(0.92, 0.12, 0.78, '#3b5661'); top.position.set(x, 0.96, z); this.scene.add(top);
    }
  }

  private addContainer(cell: Cell, index: number): void {
    cell.blocked = true;
    const [x, z] = this.grid.world(cell.x, cell.z);
    const paint = ['#c87953', '#6596a0', '#d7b76c'][index % 3];
    const body = cube(1.98, 1.45, 1.98, paint); body.position.set(x, 0.76, z); body.castShadow = true; this.scene.add(body);
    for (let rib = -1; rib <= 1; rib++) { const strip = cube(0.06, 1.34, 2.03, '#516b6b'); strip.position.set(x + rib * 0.58, 0.76, z); this.scene.add(strip); }
  }

  private addHazardProp(cell: Cell, kind: 'water' | 'electric'): void {
    const [x, z] = this.grid.world(cell.x, cell.z);
    const group = new THREE.Group(); group.position.set(x, 0, z);
    const body = cube(kind === 'water' ? 0.53 : 0.84, kind === 'water' ? 0.86 : 1.18, 0.53, kind === 'water' ? '#e4675c' : '#dfc66e');
    body.position.y = kind === 'water' ? 0.47 : 0.61; body.castShadow = true; group.add(body);
    const top = cube(kind === 'water' ? 0.71 : 0.95, 0.14, kind === 'water' ? 0.71 : 0.63, kind === 'water' ? '#ffe2bd' : '#4a6465');
    top.position.y = kind === 'water' ? 0.96 : 1.26; group.add(top);
    this.scene.add(group);
    this.interactiveProps.push({ position: new THREE.Vector3(x, 0, z), kind, mesh: group, active: true });
  }

  private addVehicle(cell: Cell, index: number, options: { type?: 'scooter'; moving?: boolean; horizontal?: boolean } = {}): void {
    const roll = index % 100;
    const chosenType = options.type ?? (roll < 24 ? 'car' : roll < 40 ? 'compact' : roll < 52 ? 'taxi' : roll < 63 ? 'pickup' : roll < 74 ? 'van' : roll < 82 ? 'jeep' : roll < 88 ? 'scooter' : roll < 94 ? 'truck' : roll < 98 ? 'bus' : 'ambulance');
    const type = chosenType as VehicleType;
    let [x, z] = this.grid.world(cell.x, cell.z);
    const horizontal = options.horizontal ?? cell.z === this.grid.roadZ[this.grid.blockAt(cell.x, cell.z).bz] + 1;
    const autonomous = options.moving === true;
    const trafficDirection = this.grid.roadDirection(horizontal ? 'x' : 'z', horizontal ? cell.z : cell.x);
    const laneDirection = autonomous ? trafficDirection : -trafficDirection;
    if (horizontal) z = this.grid.roadLane('x', cell.z, laneDirection);
    else x = this.grid.roadLane('z', cell.x, laneDirection);
    const length = type === 'truck' ? 8.36 : type === 'bus' ? 9.24 : type === 'ambulance' ? 6.16 : type === 'van' ? 6.16 : type === 'pickup' ? 5.94 : type === 'jeep' ? 5.5 : type === 'compact' ? 4.4 : type === 'scooter' ? 3.08 : 5.28;
    const width = type === 'bus' || type === 'truck' ? 2.86 : type === 'van' || type === 'ambulance' || type === 'jeep' ? 2.64 : type === 'compact' ? 2.2 : type === 'scooter' ? 1.1 : 2.42;
    const [laneGx, laneGz] = this.grid.grid(x, z);
    const footprint = this.vehicleFootprint(laneGx, laneGz, horizontal, length);
    if (footprint.some((candidate) => !candidate.active || candidate.tile !== 'road' || candidate.blocked)) return;
    if (this.vehicles.some((vehicle) => {
      const otherSize = vehicle.userData.vehicle as { length: number; width: number } | undefined;
      const otherLength = otherSize?.length || 4;
      const otherHorizontal = vehicle.userData.trafficAxis === 'x';
      const dx = Math.abs(vehicle.position.x - x), dz = Math.abs(vehicle.position.z - z);
      if (horizontal && otherHorizontal) return dz < 2.4 && dx < (length + otherLength) / 2 + 0.65;
      if (!horizontal && !otherHorizontal) return dx < 2.4 && dz < (length + otherLength) / 2 + 0.65;
      return horizontal
        ? dx < length / 2 + (otherSize?.width || 2.2) / 2 + 0.5 && dz < width / 2 + otherLength / 2 + 0.5
        : dx < width / 2 + otherLength / 2 + 0.5 && dz < length / 2 + (otherSize?.width || 2.2) / 2 + 0.5;
    })) return;
    const car = new THREE.Group();
    const paint = type === 'taxi' ? '#edc84d' : type === 'ambulance' ? '#e9f0e9' : type === 'jeep' ? '#72917d' :
      ['#df815e', '#598fb7', '#91b494', '#b36b70', '#e8ae70', '#b87b55', '#68aaa5'][index % 7];
    car.add(createVehicleModel(type, paint, index, width, length));
    if (type === 'scooter' && options.moving) this.addScooterRider(car, index);
    car.position.set(x, 0, z);
    if (horizontal) car.rotation.y = trafficDirection > 0 ? Math.PI / 2 : -Math.PI / 2;
    else if (trafficDirection < 0) car.rotation.y = Math.PI;
    car.userData.vehicle = { type, paint, length, width, wheelbase: type === 'bus' || type === 'truck' ? 3.8 : type === 'van' || type === 'ambulance' ? 3.1 : type === 'scooter' ? 1.7 : 2.6, maxSpeed: type === 'bus' || type === 'truck' ? 12 : type === 'van' || type === 'ambulance' ? 14 : type === 'scooter' ? 19 : 17, impact: type === 'bus' ? 1.7 : type === 'truck' ? 1.55 : type === 'van' || type === 'ambulance' ? 1.35 : type === 'scooter' ? 0.5 : 1 };
    car.userData.autonomous = autonomous;
    car.userData.dynamicVehicle = true;
    car.userData.trafficAxis = horizontal ? 'x' : 'z';
    car.userData.trafficDirection = trafficDirection;
    car.userData.parkedCellIndexes = autonomous ? [] : footprint.map((candidate) => this.grid.index(candidate.x, candidate.z));
    if (!autonomous) footprint.forEach((candidate) => { candidate.blocked = true; });
    this.scene.add(car); this.vehicles.push(car);
    car.updateMatrixWorld(true);
    const parts: InteriorPiece[] = [];
    car.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const dimensions = object.userData.voxelDimensions as VoxelDimensions | undefined;
      if (!dimensions) return;
      const count = dimensions.nx * dimensions.ny * dimensions.nz;
      const mask = object.userData.voxelMask as Uint8Array | undefined;
      const piece: InteriorPiece = {
        mesh: object, center: object.getWorldPosition(new THREE.Vector3()), bounds: new THREE.Box3().setFromObject(object),
        alive: true, dimensions, health: new Float32Array(count).fill(0.8), mask: mask ? mask.slice() : new Uint8Array(count).fill(1), ownsState: true,
        palette: object.userData.voxelPalette as Float32Array | undefined, ownsGeometry: true
      };
      parts.push(piece);
      this.interiorPieceByMesh.set(object, piece);
    });
    this.vehicleParts.set(car, parts);
  }

  private addScooterRider(car: THREE.Group, index: number): void {
    const rider = createHumanoid({
      shirt: index % 2 ? '#e98467' : '#63a6b2', accent: '#f3d18b', pants: '#354c63', shoes: '#243844',
      skin: index % 3 ? '#d8a87f' : '#ad765e', hair: '#2d3844', style: index
    });
    rider.root.position.set(0, -0.08, -0.24);
    rider.body.rotation.x = 0.1;
    for (const arm of rider.arms) {
      arm.shoulder.rotation.x = -1.05;
      arm.elbow.rotation.x = -0.35;
    }
    for (const leg of rider.legs) {
      leg.hip.rotation.x = -1.1;
      leg.knee.rotation.x = 1.48;
    }
    rider.root.userData.scooterRider = true;
    car.add(rider.root);
  }

  disableVehicle(core: InteriorPiece): { parts: InteriorPiece[]; cells: number[] } | null {
    if (!core.mesh.userData.vehicleCore) return null;
    const car = core.mesh.parent;
    if (!(car instanceof THREE.Group) || car.userData.destroyed) return null;
    car.userData.destroyed = true;
    const cells = this.setVehicleParked(car, false);
    const parts = this.vehicleParts.get(car) || [];
    // Keep the surviving voxel shell as a persistent, visibly damaged wreck.
    car.visible = true;
    return { parts, cells };
  }

  vehicleDisabled(piece: InteriorPiece): boolean {
    if (!piece.mesh.userData.vehicleCore || !piece.alive) return Boolean(piece.mesh.userData.vehicleCore);
    const mask = piece.mesh.userData.voxelMask as Uint8Array;
    let initial = 0, remaining = 0;
    for (let index = 0; index < mask.length; index++) {
      if (!mask[index]) continue;
      initial++;
      if (piece.mask[index]) remaining++;
    }
    return remaining < initial * 0.12;
  }

  private vehicleFootprint(gx: number, gz: number, horizontal: boolean, length: number): Cell[] {
    const offsets = length < 3.5 ? [0] : length > 6.5 ? [-2, -1, 0, 1, 2] : [-1, 0, 1];
    return offsets.map((offset) => this.grid.cell(gx + (horizontal ? offset : 0), gz + (horizontal ? 0 : offset))).filter((cell): cell is Cell => !!cell);
  }

  setVehicleParked(vehicle: THREE.Group, parked: boolean): number[] {
    if (!parked) {
      const previous = vehicle.userData.parkedCellIndexes as number[] | undefined;
      for (const index of previous || []) this.grid.cells[index].blocked = false;
      vehicle.userData.parkedCellIndexes = [];
      return previous || [];
    }
    const [gx, gz] = this.grid.grid(vehicle.position.x, vehicle.position.z);
    const specs = vehicle.userData.vehicle as { length: number };
    const horizontal = Math.abs(Math.sin(vehicle.rotation.y)) > Math.abs(Math.cos(vehicle.rotation.y));
    const indexes = this.vehicleFootprint(gx, gz, horizontal, specs.length).filter((cell) => cell.active && cell.tile === 'road' && !cell.blocked).map((cell) => this.grid.index(cell.x, cell.z));
    for (const index of indexes) this.grid.cells[index].blocked = true;
    vehicle.userData.parkedCellIndexes = indexes;
    return indexes;
  }

  releaseVehicle(vehicle: THREE.Group): void {
    this.scene.attach(vehicle);
  }

  vehicleDamageParts(vehicle: THREE.Group): readonly InteriorPiece[] {
    return this.vehicleParts.get(vehicle) || [];
  }

  setVehicleRendered(vehicle: THREE.Group, rendered: boolean): void {
    if (rendered && vehicle.parent !== this.scene) this.scene.add(vehicle);
    else if (!rendered && vehicle.parent === this.scene) this.scene.remove(vehicle);
  }

  voxelIndexesInCell(cellIndex: number): readonly number[] {
    return this.voxelsByCell.get(cellIndex) || [];
  }

  voxelIndexesNear(x: number, z: number, radius: number): number[] {
    const [gx, gz] = this.grid.grid(x, z);
    const extent = Math.ceil(radius / this.grid.cellSize) + 1;
    const result: number[] = [];
    for (let cz = gz - extent; cz <= gz + extent; cz++) for (let cx = gx - extent; cx <= gx + extent; cx++) {
      const cell = this.grid.cell(cx, cz);
      if (cell) result.push(...this.voxelIndexesInCell(this.grid.index(cx, cz)));
    }
    return result;
  }

  voxelForHit(hit: THREE.Intersection): number | null {
    if (hit.instanceId !== undefined) {
      const indexes = (hit.object as THREE.InstancedMesh).userData.voxelForInstance as Uint32Array | undefined;
      return indexes && hit.instanceId < indexes.length ? indexes[hit.instanceId] : null;
    }
    const indexes = (hit.object as THREE.Mesh).geometry.userData.voxelForFace as Uint32Array | undefined;
    if (!indexes || hit.faceIndex == null || hit.faceIndex >= indexes.length) return null;
    const owner = indexes[hit.faceIndex];
    return owner === MERGED_VOXEL_OWNER ? this.voxelAtMergedSurfacePoint(hit) : owner;
  }

  private voxelAtMergedSurfacePoint(hit: THREE.Intersection): number | null {
    const normal = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new THREE.Vector3();
    const [gx, gz] = this.grid.grid(hit.point.x, hit.point.z);
    // Greedy quads can span many voxel owners. Resolve the precise logical
    // owner from the hit coordinate so damage remains voxel accurate.
    const findInCellRadius = (radius: number): number | null => {
      let selected: number | null = null;
      let selectedDistance = Infinity;
      for (let dz = -radius; dz <= radius; dz++) for (let dx = -radius; dx <= radius; dx++) {
        const cellIndex = this.grid.index(gx + dx, gz + dz);
        for (const index of this.voxelsByCell.get(cellIndex) || []) {
          const voxel = this.voxels[index];
          if (!voxel.alive) continue;
          const voxelSize = voxel.voxelSize;
          const inside = hit.point.clone().addScaledVector(normal, -voxelSize * 0.12);
          const last = voxel.positions.length - 3;
          const minY = voxel.y + voxel.positions[1] - voxelSize * 0.5;
          const maxY = voxel.y + voxel.positions[last + 1] + voxelSize * 0.5;
          if (inside.y < minY - voxelSize * 0.05 || inside.y > maxY + voxelSize * 0.05) continue;
          for (let sub = 0; sub < voxel.pieces.length; sub++) {
            if (voxel.pieces[sub] <= 0) continue;
            const offset = sub * 3;
            const px = voxel.x + voxel.positions[offset];
            const py = voxel.y + voxel.positions[offset + 1];
            const pz = voxel.z + voxel.positions[offset + 2];
            const ax = Math.abs(inside.x - px), ay = Math.abs(inside.y - py), az = Math.abs(inside.z - pz);
            if (ax > voxelSize * 0.55 || ay > voxelSize * 0.55 || az > voxelSize * 0.55) continue;
            const distance = ax * ax + ay * ay + az * az;
            if (distance < selectedDistance) { selected = index; selectedDistance = distance; }
          }
        }
      }
      return selected;
    };
    return findInCellRadius(0) ?? findInCellRadius(1);
  }

  pieceForHit(hit: THREE.Intersection): number | null {
    if (hit.instanceId !== undefined) {
      const indexes = (hit.object as THREE.InstancedMesh).userData.pieceForInstance as Uint16Array | undefined;
      return indexes && hit.instanceId < indexes.length ? indexes[hit.instanceId] : null;
    }
    const index = this.voxelForHit(hit);
    if (index === null) return null;
    const voxel = this.voxels[index];
    const voxelSize = voxel.voxelSize;
    const point = hit.point.clone().addScaledVector(hit.face?.normal ?? new THREE.Vector3(), -voxelSize * 0.01);
    for (let sub = 0; sub < voxel.pieces.length; sub++) {
      const offset = sub * 3;
      if (voxel.pieces[sub] > 0 && Math.abs(point.x - voxel.x - voxel.positions[offset]) <= voxelSize / 2 + 0.001 &&
        Math.abs(point.y - voxel.y - voxel.positions[offset + 1]) <= voxelSize / 2 + 0.001 &&
        Math.abs(point.z - voxel.z - voxel.positions[offset + 2]) <= voxelSize / 2 + 0.001) return sub;
    }
    return null;
  }

  piecePosition(voxel: Voxel, sub: number): THREE.Vector3 {
    const offset = sub * 3;
    return new THREE.Vector3(voxel.x + voxel.positions[offset], voxel.y + voxel.positions[offset + 1], voxel.z + voxel.positions[offset + 2]);
  }

  pieceVisible(voxel: Voxel, sub: number): boolean {
    return voxel.alive && sub >= 0 && sub < voxel.pieces.length && voxel.pieces[sub] > 0;
  }

  hasPieces(voxel: Voxel): boolean {
    for (let sub = 0; sub < voxel.pieces.length; sub++) if (this.pieceVisible(voxel, sub)) return true;
    return false;
  }

  tintPiece(index: number, sub: number): void {
    const voxel = this.voxels[index]; if (!voxel) return;
    this.markFarDirty(voxel);
    if (!voxel.mesh || voxel.localIndex === undefined) return;
    const shade = Math.max(0.48, voxel.pieces[sub] / (voxel.roof ? 1.1 : 0.78));
    voxel.mesh.setColorAt(voxel.localIndex + sub, voxel.color.clone().multiplyScalar(shade));
    if (voxel.mesh.instanceColor) voxel.mesh.instanceColor.needsUpdate = true;
  }

  tintVoxel(index: number, factor: number): void {
    const voxel = this.voxels[index]; if (!voxel) return;
    this.markFarDirty(voxel);
    if (!voxel.mesh || voxel.localIndex === undefined) return;
    for (let sub = 0; sub < voxel.pieces.length; sub++) voxel.mesh.setColorAt(voxel.localIndex + sub, voxel.color.clone().multiplyScalar(factor).offsetHSL(0, 0, (this.grid.hash(index, sub, 105) - 0.5) * 0.075));
    if (voxel.mesh.instanceColor) voxel.mesh.instanceColor.needsUpdate = true;
  }

  private markFarDirty(voxel: Voxel): void {
    const cell = this.grid.cells[voxel.cellIndex];
    if (!cell) return;
    const block = this.grid.blockAt(cell.x, cell.z);
    const assets = this.blockAssets.get(`${block.bx}:${block.bz}`);
    if (!assets) return;
    const bounds = this.grid.blockBounds(block.bx, block.bz);
    const rx = Math.floor((cell.x - bounds.x0) / SHELL_REGION_CELLS);
    const rz = Math.floor((cell.z - bounds.z0) / SHELL_REGION_CELLS);
    const localX = cell.x - bounds.x0 - rx * SHELL_REGION_CELLS;
    const localZ = cell.z - bounds.z0 - rz * SHELL_REGION_CELLS;
    const xOffsets = localX === 0 ? [-1, 0] : localX === SHELL_REGION_CELLS - 1 ? [0, 1] : [0];
    const zOffsets = localZ === 0 ? [-1, 0] : localZ === SHELL_REGION_CELLS - 1 ? [0, 1] : [0];
    for (const dz of zOffsets) for (const dx of xOffsets) {
      const region = assets.regions.get(`${rx + dx}:${rz + dz}`);
      if (region) { region.dirty = true; region.revision++; }
    }
  }

  writeVoxel(index: number, changed = true): void {
    const voxel = this.voxels[index];
    const visible = voxel.alive;
    if (voxel.mesh && voxel.localIndex !== undefined) {
      for (let sub = 0; sub < voxel.pieces.length; sub++) {
        const offset = sub * 3;
        this.dummy.position.set(voxel.x + voxel.positions[offset], voxel.y + voxel.positions[offset + 1], voxel.z + voxel.positions[offset + 2]);
        this.dummy.rotation.set(0, 0, 0); this.dummy.scale.setScalar(visible && this.pieceVisible(voxel, sub) ? 1 : 0.0001); this.dummy.updateMatrix();
        voxel.mesh.setMatrixAt(voxel.localIndex + sub, this.dummy.matrix);
      }
      voxel.mesh.instanceMatrix.needsUpdate = true;
    }
    voxel.details.forEach((detail) => { detail.visible = visible; });
    if (changed) this.markFarDirty(voxel);
  }

}
