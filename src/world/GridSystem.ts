import { UrbanTerrain } from './UrbanTerrain';
import { CanalWater, CANAL_BED_Y } from './CanalWater';
import { SurfaceNetwork } from './SurfaceNetwork';
import { VOXEL_SIZE, VOXELS_PER_CELL } from './VoxelSystem';

export type District = 'industrial' | 'commercial' | 'residential' | 'park';
export type Tile = 'road' | 'sidewalk' | 'lot' | 'park';
export type BlockForm = 'row' | 'courtyard' | 'corner' | 'yard' | 'pocket';
export type ParkStyle = 'garden' | 'plaza' | 'grove';
export interface BlockProfile {
  district: District;
  form: BlockForm;
  parkStyle: ParkStyle;
  density: number;
  greenery: number;
  palette: number;
}

export interface Cell {
  x: number;
  z: number;
  tile: Tile;
  district: District;
  blocked: boolean;
  rubble: boolean;
  active: boolean;
}

export type BlockBounds = { bx: number; bz: number; x0: number; x1: number; z0: number; z1: number };

export class GridSystem {
  readonly size: number;
  readonly cellSize = VOXEL_SIZE * VOXELS_PER_CELL;
  readonly center: number;
  readonly cells: Cell[] = [];
  readonly activeCells: Cell[] = [];
  readonly activeBlocks = new Set<string>();
  readonly roadX: number[];
  readonly roadZ: number[];
  readonly seed: number;
  readonly terrain: UrbanTerrain;
  readonly water: CanalWater;
  readonly surfaces = new SurfaceNetwork(this.cellSize);
  private state: number;
  private districtCache = new Map<string, District>();
  private profileCache = new Map<string, BlockProfile>();

  constructor(seed = Math.floor(Math.random() * 999999), size = 1025) {
    this.size = size;
    this.center = Math.floor(size / 2);
    this.seed = seed;
    this.state = seed || 1;
    this.roadX = this.makeAxis(17);
    this.roadZ = this.makeAxis(61);
    this.terrain = new UrbanTerrain(this.roadX,this.roadZ,this.center,this.cellSize);
    this.water = new CanalWater(this.terrain);

  }

  hash(x: number, z: number, salt = 0): number {
    let value = (Math.imul(x + 129, 374761393) + Math.imul(z + 71, 668265263) + Math.imul(this.seed + salt, 1442695041)) | 0;
    value = Math.imul(value ^ (value >>> 13), 1274126177);
    return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
  }

  private makeAxis(salt: number): number[] {
    const starts = [this.center];
    let cursor = this.center;
    while (cursor > 0) {
      const span = cursor === this.center ? 18 : 15 + Math.floor(this.hash(cursor, salt, 1) * 8);
      const next = Math.max(0, cursor - span);
      starts.push(next);
      cursor = next;
    }
    cursor = this.center;
    while (cursor < this.size - 1) {
      const span = cursor === this.center ? 18 : 15 + Math.floor(this.hash(cursor, salt, 2) * 8);
      const next = Math.min(this.size - 1, cursor + span);
      starts.push(next);
      cursor = next;
    }
    return starts.sort((a, b) => a - b);
  }

  random(): number {
    this.state ^= this.state << 13;
    this.state ^= this.state >>> 17;
    this.state ^= this.state << 5;
    return (this.state >>> 0) / 4294967296;
  }

  /** Smooth, seeded neighborhood traits make nearby blocks related without repeating them. */
  private neighborhoodField(bx: number, bz: number, salt: number): number {
    const scale = 5, gx = bx / scale, gz = bz / scale;
    const ix = Math.floor(gx), iz = Math.floor(gz);
    const sx = (gx - ix) ** 2 * (3 - 2 * (gx - ix));
    const sz = (gz - iz) ** 2 * (3 - 2 * (gz - iz));
    const north = this.hash(ix, iz, salt) * (1 - sx) + this.hash(ix + 1, iz, salt) * sx;
    const south = this.hash(ix, iz + 1, salt) * (1 - sx) + this.hash(ix + 1, iz + 1, salt) * sx;
    return north * (1 - sz) + south * sz;
  }

  districtAt(x: number, z: number): District {
    const block = this.blockAt(x, z);
    const key = `${block.bx}:${block.bz}`;
    const cached = this.districtCache.get(key);
    if (cached) return cached;
    const centerPark = this.blockAt(this.center - 1, this.center + 1);
    let result: District;
    const green = this.neighborhoodField(block.bx, block.bz, 84);
    const besideCentralPark = Math.max(Math.abs(block.bx - centerPark.bx), Math.abs(block.bz - centerPark.bz)) <= 1;
    if (block.bx === centerPark.bx && block.bz === centerPark.bz ||
        this.hash(block.bx, block.bz, 86) < (besideCentralPark ? 0.045 : 0.065 + green * 0.24)) result = 'park';
    else {
      if (Math.abs(x - this.center) < 36 && Math.abs(z - this.center) < 36) {
        if (x < this.center && z < this.center) result = 'industrial';
        else if (x >= this.center && z < this.center) result = 'commercial';
        else result = 'residential';
      } else {
        const zoneX = Math.floor((x - this.center) / 55);
        const zoneZ = Math.floor((z - this.center) / 55);
        result = (['industrial', 'commercial', 'residential'] as District[])[Math.floor(this.hash(zoneX, zoneZ, 85) * 3)];
      }
    }
    this.districtCache.set(key, result);
    return result;
  }

  blockProfile(bx: number, bz: number): BlockProfile {
    const key = `${bx}:${bz}`;
    const cached = this.profileCache.get(key);
    if (cached) return cached;
    const bounds = this.blockBounds(bx, bz);
    const district = this.districtAt((bounds.x0 + bounds.x1) >> 1, (bounds.z0 + bounds.z1) >> 1);
    const density = this.neighborhoodField(bx, bz, 116);
    const greenery = this.neighborhoodField(bx, bz, 84);
    const palette = Math.floor(this.hash(Math.floor(bx / 5), Math.floor(bz / 5), 119) * 4);
    const roll = this.hash(bx, bz, 120);
    const form: BlockForm = district === 'industrial' ? roll < 0.5 ? 'yard' : roll < 0.76 ? 'row' : 'courtyard' :
      roll < 0.22 ? 'row' : roll < 0.50 ? 'courtyard' : roll < 0.78 ? 'corner' : 'pocket';
    const parkStyle: ParkStyle = (['garden', 'plaza', 'grove'] as const)[Math.floor(this.hash(bx, bz, 121) * 3)];
    const profile = { district, form, parkStyle, density, greenery, palette };
    this.profileCache.set(key, profile);
    return profile;
  }

  pocketStart(bounds: BlockBounds): number {
    return bounds.z0 + Math.max(9, Math.floor((bounds.z1 - bounds.z0) * 0.59));
  }

  parkPathAt(bounds: BlockBounds, x: number, z: number): boolean {
    if(this.surfaces.at(...this.world(x,z)).length)return true;
    const profile = this.blockProfile(bounds.bx, bounds.bz);
    const midX = (bounds.x0 + bounds.x1) >> 1, midZ = (bounds.z0 + bounds.z1) >> 1;
    if (profile.district !== 'park') return profile.form === 'pocket' && x === midX;
    if (profile.parkStyle === 'plaza') return Math.abs(x - midX) <= 1 || Math.abs(z - midZ) <= 1;
    if (profile.parkStyle === 'grove') return x === midX + Math.round(Math.sin((z - bounds.z0) * 0.45) * 2);
    return x === midX || z === midZ;
  }

  private axisBlock(value: number, axis: number[]): number {
    let low = 0, high = axis.length - 2;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (value < axis[middle]) high = middle - 1;
      else if (value >= axis[middle + 1]) low = middle + 1;
      else return middle;
    }
    return Math.max(0, Math.min(axis.length - 2, low));
  }

  blockAt(x: number, z: number): { bx: number; bz: number } {
    return { bx: this.axisBlock(x, this.roadX), bz: this.axisBlock(z, this.roadZ) };
  }

  roadDirection(axis: 'x' | 'z', coordinate: number): number {
    const road = this.axisBlock(coordinate, axis === 'x' ? this.roadZ : this.roadX);
    return (road + (axis === 'z' ? 1 : 0)) % 2 === 0 ? 1 : -1;
  }

  /** World coordinate across a three-cell road. Moving traffic occupies one
   * side; the opposite side is available for parked vehicles. */
  roadLane(axis: 'x' | 'z', coordinate: number, direction: number): number {
    const roads = axis === 'x' ? this.roadZ : this.roadX;
    const road = this.axisBlock(coordinate, roads);
    const side = axis === 'x' ? -Math.sign(direction) : Math.sign(direction);
    return (roads[road] + 1 + side * 0.76 - this.center) * this.cellSize;
  }

  blockBounds(bx: number, bz: number): BlockBounds {
    return { bx, bz, x0: this.roadX[bx], x1: this.roadX[bx + 1], z0: this.roadZ[bz], z1: this.roadZ[bz + 1] };
  }

  activateBlock(bx: number, bz: number): Cell[] {
    if (bx < 0 || bz < 0 || bx >= this.roadX.length - 1 || bz >= this.roadZ.length - 1) return [];
    const key = `${bx}:${bz}`;
    if (this.activeBlocks.has(key)) return [];
    this.activeBlocks.add(key);
    const bounds = this.blockBounds(bx, bz);
    const added: Cell[] = [];
    for (let z = bounds.z0; z < bounds.z1; z++) for (let x = bounds.x0; x < bounds.x1; x++) {
      const cell = this.cell(x, z)!;
      cell.active = true;
      this.activeCells.push(cell);
      added.push(cell);
    }
    return added;
  }

  landmark(district: District): Cell {
    let best: Cell | undefined;
    let distance = Infinity;
    for (let bz = 0; bz < this.roadZ.length - 1; bz++) for (let bx = 0; bx < this.roadX.length - 1; bx++) {
      const bounds = this.blockBounds(bx, bz);
      const x = Math.floor((bounds.x0 + bounds.x1) / 2);
      const z = Math.floor((bounds.z0 + bounds.z1) / 2);
      if (this.districtAt(x, z) !== district) continue;
      const score = Math.abs(x - this.center) + Math.abs(z - this.center);
      if (score < distance) { best = this.cell(x, z); distance = score; }
    }
    return best || this.cell(this.center + 1, this.center + 1)!;
  }

  index(x: number, z: number): number { return z * this.size + x; }
  cell(x: number, z: number): Cell | undefined {
    if (x < 0 || z < 0 || x >= this.size || z >= this.size) return undefined;
    const index = this.index(x, z);
    if (!this.cells[index]) {
      const block = this.blockAt(x, z), bounds = this.blockBounds(block.bx, block.bz);
      const lx = x - bounds.x0, lz = z - bounds.z0;
      const road = lx < 3 || lz < 3;
      const sidewalk = lx === 3 || x === bounds.x1 - 1 || lz === 3 || z === bounds.z1 - 1;
      const profile = this.blockProfile(block.bx, block.bz);
      const district = profile.district;
      const pocket = profile.form === 'pocket' && district !== 'park' && z >= this.pocketStart(bounds);
      this.cells[index] = { x, z, district, tile: road ? 'road' : sidewalk ? 'sidewalk' : district === 'park' || pocket ? 'park' : 'lot', blocked: this.terrain.waterAt(...this.world(x,z)), rubble: false, active: false };
    }
    return this.cells[index];
  }
  world(x: number, z: number): [number, number] {
    return [(x - this.center) * this.cellSize, (z - this.center) * this.cellSize];
  }
  grid(x: number, z: number): [number, number] {
    return [Math.round(x / this.cellSize + this.center), Math.round(z / this.cellSize + this.center)];
  }
  cellAtWorld(x: number, z: number): Cell | undefined {
    const [gx, gz] = this.grid(x, z);
    return this.cell(gx, gz);
  }
  /** Independent navigation layers let pedestrians pass under an occupied road. */
  navigationLayers(cell:Cell):number[] {
    const [x,z]=this.world(cell.x,cell.z),base=this.groundHeight(x,z);
    const layers=[base];
    for(const surface of this.surfaces.at(x,z)) {
      if(surface.navigable===false)continue;
      const height=this.surfaces.height(surface,x,z);
      if(!layers.some(h=>Math.abs(h-height)<.1))layers.push(height);
    }
    return layers;
  }
  navigationIndex(x:number,z:number,y:number):number {
    const cell=this.cellAtWorld(x,z);if(!cell)return 0;
    const heights=this.navigationLayers(cell);
    let layer=0;for(let i=1;i<heights.length;i++)if(Math.abs(heights[i]-y)<Math.abs(heights[layer]-y))layer=i;
    return this.index(cell.x,cell.z)+layer*this.size*this.size;
  }
  navigationData(cells:Cell[]) {
    const indexes:number[]=[],blocked:number[]=[],heights:number[]=[],costs:number[]=[];
    for(const cell of cells) {
      const layers=this.navigationLayers(cell);
      // Clear missing upper nodes when a deck has been destroyed.
      for(let layer=0;layer<4;layer++) {
        indexes.push(this.index(cell.x,cell.z)+layer*this.size*this.size);
        heights.push(layers[layer]??0);costs.push(layer?2:this.travelCost(cell));
        blocked.push(Number(!cell.active||layers[layer]===undefined||(layer===0&&(cell.blocked||cell.rubble))));
      }
    }
    return {indexes:Uint32Array.from(indexes),blocked:Uint8Array.from(blocked),heights:Float32Array.from(heights),costs:Uint8Array.from(costs)};
  }
  groundHeight(x:number,z:number):number {
    return this.surfaces.ground(x,z,this.terrain.waterAt(x,z)?CANAL_BED_Y:this.terrain.height(x,z));
  }
  walkable(x: number, z: number): boolean {
    if(this.terrain.waterAt(x,z)) return false;
    const cell = this.cellAtWorld(x, z);
    return !!cell && cell.active && !cell.blocked && !cell.rubble;
  }
  openCells(): Cell[] { return this.activeCells.filter((cell) => !cell.blocked && !cell.rubble); }
  randomOpen(): Cell {
    let cell: Cell;
    do { cell = this.activeCells[Math.floor(this.random() * this.activeCells.length)]; }
    while (!cell || cell.blocked || cell.rubble);
    return cell;
  }
  blockedSnapshot(): Uint8Array {
    const result = new Uint8Array(this.size * this.size).fill(1);
    for (const cell of this.activeCells) result[this.index(cell.x, cell.z)] = Number(cell.blocked || cell.rubble);
    return result;
  }
  travelCost(cell: Cell): number { return cell.tile === 'sidewalk' || cell.tile === 'park' ? 1 : cell.tile === 'road' ? 4 : 2; }
  travelCostSnapshot(): Uint8Array {
    const result = new Uint8Array(this.size * this.size);
    for (const cell of this.activeCells) result[this.index(cell.x, cell.z)] = this.travelCost(cell);
    return result;
  }
}
