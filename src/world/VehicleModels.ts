import * as THREE from 'three';
import { VOXEL_SIZE, voxelSurfaceGeometry } from './VoxelSystem';

export type VehicleType = 'car' | 'compact' | 'taxi' | 'pickup' | 'van' | 'jeep' | 'scooter' | 'truck' | 'bus' | 'ambulance';

/**
 * Vehicles use a lattice half as coarse as the standard 0.22 voxel so they can
 * carry real detail (round wheels, lamps, door seams). The size travels in
 * `voxelDimensions.voxelSize`, which every damage routine already honours.
 */
export const VEHICLE_VOXEL_SIZE = VOXEL_SIZE / 2;

const PAINT = 0, SHADE = 1, GLASS = 2, GLASS_DARK = 3, TIRE = 4, ALLOY = 5, HEADLIGHT = 6, TAILLIGHT = 7;
const TRIM = 8, ACCENT = 9, ROOF = 10, WHITE = 11, RED = 12, BLUE = 13, AMBER = 14, UNDER = 15;

const NOMINAL_HEIGHT: Record<VehicleType, number> = {
  car: 22, taxi: 22, compact: 22, pickup: 22, van: 26, ambulance: 26, jeep: 24, scooter: 18, truck: 30, bus: 30
};

/** Dense boolean lattice with per-cell palette index. */
class Lattice {
  readonly mask: Uint8Array;
  readonly shade: Uint8Array;
  constructor(readonly nx: number, readonly ny: number, readonly nz: number) {
    this.mask = new Uint8Array(nx * ny * nz);
    this.shade = new Uint8Array(nx * ny * nz);
  }
  private at(x: number, y: number, z: number) { return x + this.nx * (z + this.nz * y); }
  private inside(x: number, y: number, z: number) { return x >= 0 && x < this.nx && y >= 0 && y < this.ny && z >= 0 && z < this.nz; }
  has(x: number, y: number, z: number) { return this.inside(x, y, z) && this.mask[this.at(x, y, z)] === 1; }
  put(x: number, y: number, z: number, c: number) {
    if (!this.inside(x, y, z)) return;
    const i = this.at(x, y, z); this.mask[i] = 1; this.shade[i] = c;
  }
  /** Recolor only when a voxel already exists. */
  tint(x: number, y: number, z: number, c: number) { if (this.has(x, y, z)) this.shade[this.at(x, y, z)] = c; }
  clear(x: number, y: number, z: number) { if (this.inside(x, y, z)) this.mask[this.at(x, y, z)] = 0; }
  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, c: number) {
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.put(x, y, z, c);
  }
  tintBox(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, c: number) {
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.tint(x, y, z, c);
  }
  /** Mirrored box: x range and its reflection across the centre line. */
  mbox(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, c: number) {
    this.box(x0, x1, y0, y1, z0, z1, c);
    this.box(this.nx - 1 - x1, this.nx - 1 - x0, y0, y1, z0, z1, c);
  }
  mtint(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, c: number) {
    this.tintBox(x0, x1, y0, y1, z0, z1, c);
    this.tintBox(this.nx - 1 - x1, this.nx - 1 - x0, y0, y1, z0, z1, c);
  }
  /** Centered x span of a given width (adjusted to match parity so it stays symmetric). */
  span(width: number): [number, number] {
    const w = width + ((this.nx - width) % 2 === 0 ? 0 : 1);
    const x0 = (this.nx - w) / 2;
    return [x0, x0 + w - 1];
  }
}

/** Side-profile top line: piecewise-linear points authored for a nominal length. */
function profile(nz: number, nominal: number, points: Array<[number, number]>): number[] {
  const scale = (z: number) => Math.round(z * (nz - 1) / (nominal - 1));
  const pts = points.map(([z, h]) => [scale(z), h] as [number, number]);
  const result = new Array<number>(nz).fill(-1);
  for (let i = 0; i < pts.length - 1; i++) {
    const [za, ha] = pts[i], [zb, hb] = pts[i + 1];
    for (let z = za; z <= zb && z < nz; z++) result[z] = Math.round(zb === za ? hb : ha + (hb - ha) * (z - za) / (zb - za));
  }
  return result;
}

interface Shell {
  top: number[];
  low: number[];
  inset: (y: number, z: number) => number;
  chamfer: number;
  chamferFrom: number;
}

function lastAtLeast(values: number[], min: number) {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] >= min) return i;
  return 0;
}

function scaler(nz: number, nominal: number) { return (z: number) => Math.round(z * (nz - 1) / (nominal - 1)); }

function fillShell(l: Lattice, s: Shell) {
  for (let z = 0; z < l.nz; z++) {
    const trim = Math.max(0, s.chamfer - Math.min(z, l.nz - 1 - z));
    for (let y = s.low[z]; y <= s.top[z]; y++) {
      const side = s.inset(y, z) + (y >= s.chamferFrom ? trim : 0);
      l.box(1 + side, l.nx - 2 - side, y, y, z, z, PAINT);
    }
  }
}

function roofRange(s: Shell): [number, number, number] {
  const max = Math.max(...s.top);
  return [s.top.indexOf(max), s.top.lastIndexOf(max), max];
}

/** Side glass whose upper edge follows the roof line. */
function sideWindows(l: Lattice, s: Shell, z0: number, z1: number, y0: number, roofThickness: number, pillars: number[], pillarWidth = 2) {
  for (let z = z0; z <= z1 && z < l.nz; z++) {
    const yTop = s.top[z] - roofThickness;
    if (yTop < y0 + 1) continue;
    const pillar = pillars.some((p) => z >= p && z < p + pillarWidth);
    for (let y = y0; y <= yTop; y++) {
      const edge = 1 + s.inset(y, z) + (Math.max(0, s.chamfer - Math.min(z, l.nz - 1 - z)) && y >= s.chamferFrom ? Math.max(0, s.chamfer - Math.min(z, l.nz - 1 - z)) : 0);
      l.mtint(edge + 1, l.nx / 2 - 1, y, y, z, z, GLASS_DARK);
      if (!pillar) l.mtint(edge, edge, y, y, z, z, GLASS);
    }
  }
}

/** Windshield: every front-facing or sloped tread above the hood becomes glass. */
function frontGlass(l: Lattice, s: Shell, yLow: number, roofThickness: number, pillar = 2, colour = GLASS) {
  const [, roofEnd, roofMax] = roofRange(s);
  for (let z = roofEnd; z < l.nz; z++) {
    const h = s.top[z];
    if (h <= yLow) break;
    const next = z + 1 < l.nz ? s.top[z + 1] : -1;
    const hiY = h === roofMax ? h - roofThickness : h;
    const loY = Math.max(yLow + 1, h === roofMax ? next + 1 : Math.min(next + 1, h));
    for (let y = loY; y <= hiY; y++) {
      const e = 1 + s.inset(y, z) + pillar;
      l.tintBox(e, l.nx - 1 - e, y, y, z, z, colour);
    }
  }
}

function rearGlass(l: Lattice, s: Shell, yLow: number, roofThickness: number, pillar = 2, colour = GLASS_DARK) {
  const [roofStart, , roofMax] = roofRange(s);
  for (let z = roofStart; z >= 0; z--) {
    const h = s.top[z];
    if (h <= yLow) break;
    const prev = z > 0 ? s.top[z - 1] : -1;
    const hiY = h === roofMax ? h - roofThickness : h;
    const loY = Math.max(yLow + 1, h === roofMax ? prev + 1 : Math.min(prev + 1, h));
    for (let y = loY; y <= hiY; y++) {
      const e = 1 + s.inset(y, z) + pillar;
      l.tintBox(e, l.nx - 1 - e, y, y, z, z, colour);
    }
  }
}

function recolorTop(l: Lattice, s: Shell, colour: number, zFrom = 0, zTo = l.nz - 1, xMargin = 0) {
  const [, , roofMax] = roofRange(s);
  for (let z = zFrom; z <= zTo; z++) if (s.top[z] === roofMax) {
    const side = s.inset(roofMax, z) + 1 + xMargin;
    l.tintBox(side, l.nx - 1 - side, roofMax, roofMax, z, z, colour);
  }
}

/** Voxel disc in the YZ plane for tyres; the outer face shows the rim. */
function discCells(diameter: number): Array<[number, number, number]> {
  const r = diameter / 2, c = (diameter - 1) / 2, out: Array<[number, number, number]> = [];
  for (let y = 0; y < diameter; y++) for (let z = 0; z < diameter; z++) {
    const d = Math.hypot(y - c, z - c);
    if (d <= r - 0.05) out.push([y, z, d / r]);
  }
  return out;
}

/** Cut the wheel arch into the body, then mount the tyre. */
function wheel(l: Lattice, zc: number, diameter: number, tread = false, archOnly = false) {
  const r = diameter / 2, c = (diameter - 1) / 2, zs = zc - Math.floor(diameter / 2);
  const arch = r + 1.4;
  for (let y = 0; y < l.ny; y++) for (let z = zs - 3; z <= zs + diameter + 3; z++) {
    const d = Math.hypot(y - c, z - zs - c);
    if (d > arch) continue;
    for (let x = 1; x <= 3; x++) for (const mx of [x, l.nx - 1 - x]) l.clear(mx, y, z);
    for (const mx of [4, l.nx - 5]) if (l.has(mx, y, z)) l.put(mx, y, z, UNDER);
  }
  if (archOnly) return;
  for (const [y, zr, d] of discCells(diameter)) {
    const z = zs + zr;
    for (let x = 0; x <= 3; x++) for (const side of [0, 1]) {
      const mx = side ? l.nx - 1 - x : x;
      let paint = TIRE;
      if (x === 0) paint = d < 0.3 ? TRIM : d < 0.62 ? ALLOY : (tread && (y + z) % 2 === 0 ? UNDER : TIRE);
      else if (tread && d > 0.7 && (y + z + x) % 2 === 0) paint = UNDER;
      l.put(mx, y, z, paint);
    }
  }
}

/** Lamp / grille / plate clusters on the front and rear faces. */
function lampsFront(l: Lattice, z: number, y0: number, y1: number, width: number, grille: [number, number], plate?: [number, number]) {
  l.mbox(2, 1 + width, y0, y1, z, z, HEADLIGHT);
  l.mbox(2, 1 + Math.min(2, width - 1), y0 - 1, y0 - 1, z, z, AMBER);
  const gx = 2 + width + 1;
  l.box(gx, l.nx - 1 - gx, grille[0], grille[1], z, z, TIRE);
  l.box(gx + 1, l.nx - 2 - gx, Math.floor((grille[0] + grille[1]) / 2), Math.floor((grille[0] + grille[1]) / 2), z, z, ALLOY);
  if (plate) { const [a, b] = l.span(6); l.box(a, b, plate[0], plate[1], l.nz - 1, l.nz - 1, WHITE); }
}

function lampsRear(l: Lattice, z: number, y0: number, y1: number, width: number, plate?: [number, number]) {
  l.mbox(2, 1 + width, y0, y1, z, z, TAILLIGHT);
  l.mbox(2, 3, y0 - 1, y0 - 1, z, z, WHITE);
  if (plate) { const [a, b] = l.span(6); l.box(a, b, plate[0], plate[1], 0, 0, WHITE); }
}

function bumpers(l: Lattice, front: number, rear: number, y0: number, y1: number, colour = TRIM) {
  l.tintBox(0, l.nx - 1, y0, y1, front, front, colour);
  l.tintBox(0, l.nx - 1, y0, y1, rear, rear, colour);
}

function underbody(l: Lattice, y0: number, y1: number, inset = 5, z0 = 2, z1 = l.nz - 3) {
  l.box(inset, l.nx - 1 - inset, y0, y1, z0, z1, UNDER);
}

/** Door seams, handles and rocker panels on both flanks. */
function doorDetails(l: Lattice, seams: number[], handles: number[], y0: number, y1: number, handleY: number, outer = 1) {
  for (const z of seams) l.mtint(outer, outer, y0, y1, z, z, SHADE);
  for (const z of handles) l.mtint(outer, outer, handleY, handleY, z, z + 2, ALLOY);
}

// ---------------------------------------------------------------- cars

function buildSedan(l: Lattice, type: 'car' | 'taxi' | 'compact', variant: number) {
  const nz = l.nz, compact = type === 'compact';
  const nominal = compact ? 40 : 48, sz = scaler(nz, nominal);
  const top = compact
    ? profile(nz, 40, [[0, 5], [1, 11], [4, 17], [24, 17], [32, 9], [38, 9], [39, 5]])
    : profile(nz, 48, [[0, 5], [1, 9], [11, 9], [19, 17], [28, 17], [38, 9], [46, 9], [47, 5]]);
  const shell: Shell = {
    top, low: new Array(nz).fill(2), chamfer: 2, chamferFrom: 6,
    inset: (y) => y > 9 ? Math.min(3, 1 + Math.floor((y - 10) / 3)) : 0
  };
  fillShell(l, shell);
  underbody(l, 1, 1, 4, 3, nz - 4);
  bumpers(l, nz - 1, 0, 2, 5);

  // Two-tone roof, racing stripe or plain body, chosen by variant.
  if (variant % 3 === 1) {
    for (let z = 1; z < nz - 2; z++) {
      const [a, b] = l.span(4);
      if (top[z] > 5) l.tintBox(a, b, top[z], top[z], z, z, ACCENT);
    }
  }
  if (variant % 3 === 2 || (compact && variant % 2 === 1)) recolorTop(l, shell, ROOF);

  const [roofStart, roofEnd] = roofRange(shell);
  const pillar = Math.round((roofStart + roofEnd) / 2) - 1;
  sideWindows(l, shell, sz(compact ? 4 : 11), sz(compact ? 31 : 38), 10, 2, [pillar]);
  frontGlass(l, shell, 9, 2);
  rearGlass(l, shell, compact ? 10 : 9, 2);

  const rearAxle = sz(compact ? 8 : 9), frontAxle = sz(compact ? 31 : 36);
  wheel(l, rearAxle, 7); wheel(l, frontAxle, 7);
  // Rocker panels, door seams and handles.
  l.mtint(1, 1, 2, 3, rearAxle + 5, frontAxle - 5, SHADE);
  const dFront = frontAxle - 3, dMid = pillar + 1, dRear = rearAxle + 5;
  doorDetails(l, compact ? [dFront, dRear + 2] : [dFront, dMid, dRear], compact ? [dFront - 5] : [dMid + 2, dRear + 2], 4, 9, 8);
  // Mirrors and side markers.
  const mirrorZ = lastAtLeast(top, 12) - 1;
  l.mbox(0, 1, 11, 12, mirrorZ, mirrorZ + 1, SHADE);
  l.mbox(1, 1, 6, 6, nz - 9, nz - 8, AMBER);

  // Front and rear faces.
  lampsFront(l, nz - 2, 7, 8, 4, [6, 8], [3, 4]);
  if (compact) lampsRear(l, 1, 8, 9, 3, [3, 4]); else lampsRear(l, 1, 7, 8, 4, [3, 4]);
  l.tintBox(0, l.nx - 1, 6, 6, 1, 1, SHADE);

  if (type === 'car' && variant % 3 === 1) { // rear wing
    l.mbox(4, 4, 10, 10, 2, 2, TRIM);
    l.box(2, l.nx - 3, 11, 11, 1, 3, TRIM);
  }
  if (compact && variant % 3 === 2) { // roof rails
    l.mbox(5, 5, 18, 18, roofStart + 1, roofEnd - 1, TRIM);
  }
  if (type === 'car' && variant % 3 === 0) { // shark-fin antenna
    const [a] = l.span(2);
    l.box(a, a + 1, 18, 19, roofStart + 1, roofStart + 2, TRIM);
  }
  if (type === 'taxi') {
    const [sa, sb] = l.span(10), [ba, bb] = l.span(6);
    const z0 = Math.round((roofStart + roofEnd) / 2) - 3, z1 = z0 + 5;
    l.box(ba, bb, 18, 18, z0 + 1, z1 - 1, TRIM);
    l.box(sa, sb, 19, 20, z0, z1, WHITE);
    const [fa, fb] = l.span(6);
    l.box(fa, fb, 20, 20, z1, z1, AMBER); l.box(fa, fb, 20, 20, z0, z0, AMBER);
    for (let z = rearAxle + 5; z <= frontAxle - 5; z++) for (let y = 6; y <= 7; y++) {
      const colour = (Math.floor((z - rearAxle - 5) / 2) + y) % 2 ? WHITE : TIRE;
      l.mtint(1, 1, y, y, z, z, colour);
    }
  }
}

function buildPickup(l: Lattice, variant: number) {
  const nz = l.nz, nx = l.nx, sz = scaler(nz, 54);
  const top = profile(nz, 54, [[0, 5], [1, 11], [24, 11], [25, 18], [34, 18], [41, 9], [52, 9], [53, 5]]);
  const shell: Shell = {
    top, low: new Array(nz).fill(2), chamfer: 2, chamferFrom: 6,
    inset: (y) => y > 11 ? Math.min(3, 1 + Math.floor((y - 12) / 3)) : 0
  };
  fillShell(l, shell);
  underbody(l, 1, 1, 4, 3, nz - 4);
  bumpers(l, nz - 1, 0, 2, 5);
  l.tintBox(0, nx - 1, 3, 5, nz - 1, nz - 1, ALLOY);

  const rearAxle = sz(10), frontAxle = sz(42);
  // Open cargo bed with liner, wheel wells and rails.
  const bedEnd = sz(24);
  l.tintBox(1, nx - 2, 11, 11, 1, bedEnd, SHADE);
  for (let y = 8; y <= 11; y++) for (let z = 4; z < bedEnd - 2; z++) for (let x = 4; x <= nx - 5; x++) l.clear(x, y, z);
  l.box(4, nx - 5, 7, 7, 4, bedEnd - 3, UNDER);
  for (let z = 5; z < bedEnd - 3; z += 4) l.box(4, nx - 5, 7, 7, z, z, TRIM);
  l.mbox(4, 6, 8, 9, rearAxle - 5, rearAxle + 5, SHADE);
  l.box(2, nx - 3, 9, 10, 1, 1, SHADE); // tailgate seam band
  l.tintBox(2, nx - 3, 6, 6, 1, 1, SHADE);

  const [roofStart] = roofRange(shell);
  sideWindows(l, shell, roofStart, sz(36), 12, 2, [roofStart + 4]);
  frontGlass(l, shell, 9, 2);
  rearGlass(l, shell, 12, 2);

  wheel(l, rearAxle, 8); wheel(l, frontAxle, 8);
  l.mtint(1, 1, 2, 3, rearAxle + 6, frontAxle - 6, SHADE);
  const seamFront = frontAxle - 4, seamRear = roofStart + 4;
  doorDetails(l, [seamFront, seamRear, roofStart], [seamFront - 5, seamRear - 5 + 8], 4, 11, 9);
  const mirrorZ = lastAtLeast(top, 14) - 1;
  l.mbox(0, 1, 13, 14, mirrorZ, mirrorZ + 1, SHADE);

  lampsFront(l, nz - 2, 7, 8, 5, [6, 8], [3, 4]);
  lampsRear(l, 1, 8, 10, 3, [3, 4]);
  l.mbox(2, 4, 8, 10, 1, 1, TAILLIGHT);
  const [ha, hb] = l.span(6);
  l.box(ha, hb, 10, 10, 1, 1, TRIM);

  if (variant % 3 === 1) { // cargo crates
    l.box(5, 10, 8, 12, 6, 11, ACCENT);
    l.box(nx - 9, nx - 6, 8, 11, 8, 11, ROOF);
    l.box(5, 10, 10, 10, 6, 11, TRIM);
  } else if (variant % 3 === 2) { // roof light bar
    const [la, lb] = l.span(10);
    const z0 = sz(29);
    l.box(la, lb, 19, 19, z0, z0 + 2, TRIM);
    for (let x = la; x <= lb; x += 2) l.box(x, x, 20, 20, z0 + 1, z0 + 1, HEADLIGHT);
  }
}

// ---------------------------------------------------------------- vans

function buildVan(l: Lattice, ambulance: boolean, variant: number) {
  const nz = l.nz, nx = l.nx, sz = scaler(nz, 56);
  const roof = ambulance ? 21 : 23;
  const top = profile(nz, 56, [[0, 5], [1, roof - 2], [2, roof], [37, roof], [46, 12], [52, 12], [54, 9], [55, 5]]);
  const shell: Shell = {
    top, low: new Array(nz).fill(2), chamfer: 2, chamferFrom: 6,
    inset: (y) => y >= roof ? 1 : 0
  };
  fillShell(l, shell);
  underbody(l, 1, 1, 4, 3, nz - 4);
  bumpers(l, nz - 1, 0, 2, 5);
  if (ambulance) recolorTop(l, shell, ROOF);

  const rearAxle = sz(11), frontAxle = sz(44), cab = sz(37);
  sideWindows(l, shell, cab, sz(46), 13, 3, [cab]);
  frontGlass(l, shell, 11, 3);
  // Rear doors: glass panes, centre seam and handles.
  const [ra, rb] = l.span(14);
  l.box(ra, ra + 5, 14, roof - 4, 1, 1, GLASS_DARK); l.box(rb - 5, rb, 14, roof - 4, 1, 1, GLASS_DARK);
  const [ca, cb] = l.span(2);
  l.box(ca, cb, 7, roof - 1, 1, 1, SHADE);
  l.box(ca - 2, ca - 2, 11, 13, 1, 1, ALLOY); l.box(cb + 2, cb + 2, 11, 13, 1, 1, ALLOY);

  wheel(l, rearAxle, 8); wheel(l, frontAxle, 8);
  l.mtint(1, 1, 2, 3, rearAxle + 6, frontAxle - 6, SHADE);
  // Sliding door on the cargo flank and a lower livery band.
  const doorA = sz(17), doorB = sz(31);
  doorDetails(l, [doorA, doorB, cab - 1], [doorB - 5], 4, roof - 2, 12);
  l.mtint(1, 1, roof - 2, roof - 2, doorA, doorB, SHADE);
  l.mbox(0, 1, 14, 17, sz(44), sz(46), TRIM);
  l.mbox(0, 0, 14, 17, sz(44), sz(46), TRIM);

  lampsFront(l, nz - 2, 7, 8, 5, [6, 8], [3, 4]);
  l.mbox(2, 4, 7, 14, 1, 1, TAILLIGHT);
  const [pa, pb] = l.span(6);
  l.box(pa, pb, 3, 4, 0, 0, WHITE);
  l.mbox(5, 6, 2, 4, 0, 0, ALLOY);

  if (ambulance) {
    l.mtint(1, 1, 8, 10, 2, cab - 2, RED);
    l.box(2, nx - 3, 8, 10, 1, 1, RED);
    const crossZ = sz(20);
    for (const side of [1, nx - 2]) {
      l.box(side, side, 14, 21 - 1, crossZ + 3, crossZ + 5, RED);
      l.box(side, side, 17, 19, crossZ, crossZ + 8, RED);
    }
    const [sa, sb] = l.span(12), mid = nx / 2;
    const bz = cab - 3;
    l.box(sa, sb, 22, 22, bz, bz + 3, TRIM);
    l.box(sa, mid - 2, 23, 24, bz, bz + 3, RED);
    l.box(mid + 1, sb, 23, 24, bz, bz + 3, BLUE);
    l.box(mid - 1, mid, 23, 24, bz, bz + 3, WHITE);
    l.box(sa, sb, 25, 25, bz + 1, bz + 2, ALLOY);
    l.mbox(3, 5, 8, 8, nz - 2, nz - 2, RED); // front warning lamps
    l.mbox(7, 8, 8, 8, nz - 2, nz - 2, BLUE);
    l.mbox(2, 3, 3, 4, 0, 0, RED);
  } else {
    const a = ACCENT;
    l.mtint(1, 1, 7, 8, 2, doorB + 6, a);
    if (variant % 2 === 1) { // logo panel
      l.mbox(1, 1, 12, 17, doorA + 3, doorA + 11, a);
      l.mbox(1, 1, 14, 15, doorA + 5, doorA + 9, WHITE);
    }
    if (variant % 3 === 2) { // roof rack
      l.mbox(4, 4, roof + 1, roof + 1, 4, cab - 3, TRIM);
      for (let z = 5; z <= cab - 3; z += 8) l.box(4, nx - 5, roof + 1, roof + 1, z, z, TRIM);
    } else if (variant % 3 === 1) { // roof vent
      const [va, vb] = l.span(6);
      l.box(va, vb, roof + 1, roof + 2, sz(12), sz(19), ALLOY);
    }
  }
}

// ---------------------------------------------------------------- jeep

function buildJeep(l: Lattice, variant: number) {
  const nz = l.nz, nx = l.nx, sz = scaler(nz, 50);
  const top = profile(nz, 50, [[0, -1], [1, -1], [2, 21], [29, 21], [32, 13], [33, 12], [48, 12], [49, 8]]);
  const low = new Array(nz).fill(4);
  const shell: Shell = { top, low, chamfer: 1, chamferFrom: 13, inset: (y) => y >= 21 ? 1 : 0 };
  fillShell(l, shell);
  underbody(l, 2, 3, 4, 2, nz - 3);
  l.box(1, nx - 2, 4, 8, nz - 1, nz - 1, TRIM); // flat front bumper
  recolorTop(l, shell, ROOF);

  const [roofStart, roofEnd] = roofRange(shell);
  sideWindows(l, shell, roofStart + 1, roofEnd, 14, 2, [sz(16), sz(26)]);
  frontGlass(l, shell, 12, 2);
  rearGlass(l, shell, 14, 2);

  const rearAxle = sz(11), frontAxle = sz(39);
  wheel(l, rearAxle, 10, true); wheel(l, frontAxle, 10, true);
  // Fender flares and rock rails.
  for (const zc of [rearAxle, frontAxle]) {
    const c = 4.5, zs = zc - 5;
    for (let y = 5; y < 14; y++) for (let z = zs - 4; z <= zs + 14; z++) {
      const d = Math.hypot(y - c, z - zs - 4.5);
      if (d >= 6.3 && d <= 7.8 && y >= 5) { l.put(0, y, z, TRIM); l.put(nx - 1, y, z, TRIM); }
    }
  }
  l.mbox(0, 0, 4, 5, rearAxle + 8, frontAxle - 8, TRIM);
  doorDetails(l, [sz(15), sz(25), sz(29)], [sz(20)], 5, 13, 11);
  l.mbox(0, 0, 15, 17, roofEnd + 1, roofEnd + 2, TRIM);

  // Spare tyre on the tailgate.
  const cx = (nx - 1) / 2;
  for (let y = 6; y <= 14; y++) for (let x = 0; x < nx; x++) {
    const d = Math.hypot(x - cx, y - 10);
    if (d > 4.45) continue;
    l.put(x, y, 1, TIRE);
    l.put(x, y, 0, d < 1.3 ? TRIM : d < 2.7 ? ALLOY : TIRE);
  }
  l.mbox(1, 5, 4, 6, 0, 1, TRIM);
  l.mbox(1, 3, 8, 10, 2, 2, TAILLIGHT);

  // Seven-slot grille and round headlamps.
  const front = nz - 2;
  for (let y = 9; y <= 11; y++) for (let x = 7; x <= nx - 8; x++) l.put(x, y, front, (x - 7) % 3 === 2 ? PAINT : TIRE);
  for (const [px, py] of [[3, 10]] as Array<[number, number]>) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const d = Math.hypot(dx, dy);
    if (d > 2.3) continue;
    const c = d < 1.5 ? HEADLIGHT : TRIM;
    l.put(px + dx, py + dy, front, c); l.put(nx - 1 - px - dx, py + dy, front, c);
  }
  l.mbox(1, 2, 9, 9, front + 1, front + 1, AMBER);
  l.mbox(2, 4, 4, 8, nz - 1, nz - 1, ALLOY);

  // Roof rack with optional load.
  l.mbox(3, 3, 22, 22, 4, 27, TRIM);
  for (const z of [5, 11, 17, 23, 27]) l.box(3, nx - 4, 22, 22, z, z, TRIM);
  if (variant % 3 === 1) l.box(5, 8, 23, 25, 5, 9, ACCENT); // jerrycan
  else if (variant % 3 === 2) l.box(nx - 9, nx - 6, 23, 24, 7, 20, TIRE); // roll
}

// ---------------------------------------------------------------- scooter

function buildScooter(l: Lattice, variant: number) {
  const nz = l.nz, nx = l.nx, sz = scaler(nz, 28);
  const [bx0, bx1] = l.span(6), [wx0, wx1] = l.span(2), [fx0, fx1] = l.span(4);
  const rear = sz(5), front = sz(23);
  for (const zc of [rear, front]) {
    const zs = zc - 3;
    for (const [y, zr, d] of discCells(7)) {
      for (let x = wx0; x <= wx1; x++) l.put(x, y, zs + zr, d < 0.3 ? TRIM : d < 0.6 && (x === wx0 || x === wx1) ? ALLOY : TIRE);
    }
  }
  // Engine, floorboard and rear body.
  l.box(bx0 + 1, bx1 - 1, 3, 6, sz(6), sz(12), SHADE);
  l.box(wx0 - 2, wx0 - 1, 3, 4, rear, rear, SHADE); l.box(wx1 + 1, wx1 + 2, 3, 4, rear, rear, SHADE);
  l.box(bx0 - 1, bx1 + 1, 5, 6, sz(12), sz(19), PAINT);
  l.box(bx0, bx1, 6, 6, sz(13), sz(18), TRIM);
  l.box(bx0 + 1, bx1 - 1, 7, 7, sz(2), sz(9), PAINT); // fender
  l.box(bx0, bx1, 8, 9, sz(1), sz(12), PAINT); // seat base
  l.box(bx0, bx1, 10, 11, sz(3), sz(12), TIRE); // saddle
  l.box(bx0 + 1, bx1 - 1, 11, 11, sz(3), sz(11), TIRE);
  l.mtint(bx0, bx0, 10, 10, sz(3), sz(12), TRIM);
  l.box(bx0, bx1, 7, 9, 0, 0, PAINT);
  l.box(bx0 + 1, bx1 - 1, 9, 10, 0, 0, TAILLIGHT);
  l.box(bx0 + 1, bx1 - 1, 7, 8, 0, 0, WHITE);
  l.box(bx1 + 1, bx1 + 1, 3, 4, sz(2), sz(10), ALLOY); // exhaust
  // Leg shield, steering head and fork.
  l.box(fx0, fx1, 7, 10, sz(17), sz(19), PAINT);
  l.box(fx0, fx1, 11, 14, sz(18), sz(20), PAINT);
  l.box(fx0, fx1, 12, 13, sz(21), sz(21), HEADLIGHT);
  const forkZ = (y: number) => y >= 9 ? sz(21) : sz(22);
  for (let y = 3; y <= 12; y++) l.mbox(fx0 - 1, fx0 - 1, y, y, forkZ(y), forkZ(y) + 1, ALLOY);
  l.box(fx0 - 1, fx1 + 1, 3, 3, front, front, ALLOY);
  l.box(wx0, wx1, 7, 7, sz(21), sz(25), SHADE); // front fender
  // Handlebar, grips and mirrors.
  l.box(0, nx - 1, 15, 15, sz(19), sz(20), TRIM);
  l.mbox(0, 1, 15, 15, sz(19), sz(21), TIRE);
  l.mbox(1, 1, 16, 17, sz(19), sz(19), TRIM);
  l.mbox(1, 2, 17, 17, sz(18), sz(18), GLASS_DARK);
  l.box(fx0 + 1, fx1 - 1, 14, 14, sz(18), sz(20), PAINT);
  if (variant % 2 === 1) l.box(fx0 - 1, fx1 + 1, 16, 17, sz(20), sz(20), GLASS); // windscreen
}

// ---------------------------------------------------------------- heavy

function buildTruck(l: Lattice, variant: number) {
  const nz = l.nz, nx = l.nx, sz = scaler(nz, 76);
  const top = profile(nz, 76, [[0, -1], [1, 25], [54, 25], [55, 21], [67, 21], [70, 13], [71, 12], [74, 12], [75, 8]]);
  const cabStart = sz(55);
  const low = top.map((_, z) => z < cabStart ? 11 : 6);
  const shell: Shell = {
    top, low, chamfer: 2, chamferFrom: 10,
    inset: (y, z) => z >= cabStart && y >= 14 ? Math.min(2, 1 + Math.floor((y - 14) / 3)) : y >= 25 ? 1 : 0
  };
  fillShell(l, shell);
  // Cargo box colour, rails, ribs and cap.
  for (let z = 1; z < cabStart; z++) for (let y = 11; y <= 25; y++) l.mtint(1, nx / 2 - 1, y, y, z, z, ACCENT);
  l.mtint(1, 1, 11, 12, 1, cabStart - 1, TRIM);
  for (let z = sz(9); z < cabStart; z += 8) l.mtint(1, 1, 13, 24, z, z, SHADE);
  for (let z = 1; z < cabStart; z++) l.tintBox(2, nx - 3, 25, 25, z, z, ROOF);
  // Chassis, ICC bar, tank.
  underbody(l, 6, 9, 9, 0, nz - 3);
  l.box(4, nx - 5, 7, 8, 0, 1, TRIM);
  l.box(2, 5, 6, 9, sz(32), sz(42), ALLOY);
  l.box(6, 8, 7, 8, sz(34), sz(40), TRIM);
  // Rear doors and lamps.
  const [ca, cb] = l.span(2);
  l.box(ca, cb, 12, 24, 1, 1, SHADE);
  l.box(ca - 2, ca - 2, 14, 22, 1, 1, ALLOY); l.box(cb + 2, cb + 2, 14, 22, 1, 1, ALLOY);
  l.mbox(1, 3, 11, 13, 1, 1, TAILLIGHT);
  const [pa, pb] = l.span(6);
  l.box(pa, pb, 7, 8, 0, 0, WHITE);

  wheel(l, sz(10), 10, true, true); wheel(l, sz(25), 10, true, true);
  wheel(l, sz(64), 10, true);
  for (const zc of [sz(10), sz(25)]) {
    l.box(4, nx - 5, 4, 5, zc - 1, zc + 1, UNDER); // axle joins tyres to the chassis
    for (const [y, zr, d] of discCells(10)) for (let x = 0; x <= 3; x++) for (const side of [0, 1]) {
      const mx = side ? nx - 1 - x : x, z = zc - 5 + zr;
      l.put(mx, y, z, x === 0 ? (d < 0.3 ? TRIM : d < 0.62 ? ALLOY : ((y + z) % 2 ? TIRE : UNDER)) : TIRE);
    }
  }

  // Cab windows, seams, mirrors and lamps.
  sideWindows(l, shell, cabStart + 2, sz(68), 14, 2, [cabStart + 1]);
  frontGlass(l, shell, 13, 2);
  doorDetails(l, [sz(57), sz(68)], [sz(66)], 6, 13, 11);
  l.mbox(0, 0, 15, 19, sz(68), sz(69), TRIM);
  l.mbox(0, 2, 18, 19, sz(68), sz(68), TRIM);
  lampsFront(l, nz - 2, 10, 11, 5, [9, 12], [6, 7]);
  l.tintBox(0, nx - 1, 6, 8, nz - 1, nz - 1, TRIM);
  for (const dx of [-6, -3, 0, 3, 6]) { const [a] = l.span(2); l.box(a + dx, a + dx + 1, 22, 22, sz(60), sz(61), AMBER); }
  if (variant % 2 === 1) { // roof fairing
    for (let z = cabStart; z < cabStart + 9; z++) l.box(4, nx - 5, 22, 24 - Math.floor((z - cabStart) / 3), z, z, PAINT);
  }
}

function buildBus(l: Lattice, variant: number) {
  const nz = l.nz, nx = l.nx, sz = scaler(nz, 84);
  const top = profile(nz, 84, [[0, 9], [1, 23], [2, 25], [3, 26], [80, 26], [81, 25], [82, 21], [83, 9]]);
  const shell: Shell = { top, low: new Array(nz).fill(5), chamfer: 2, chamferFrom: 10, inset: (y) => y >= 26 ? 1 : 0 };
  fillShell(l, shell);
  underbody(l, 2, 4, 6, 2, nz - 3);
  bumpers(l, nz - 1, 0, 5, 9);
  recolorTop(l, shell, ROOF);
  l.mtint(1, 1, 10, 11, 1, nz - 2, ACCENT);
  l.tintBox(2, nx - 3, 10, 11, 1, 1, ACCENT);

  // Window band with regular pillars.
  const pillars: number[] = [];
  for (let z = sz(12); z < sz(70); z += 12) pillars.push(z);
  sideWindows(l, shell, 4, sz(80), 14, 5, pillars);
  // Front windshield, destination sign and lamps.
  const f = sz(82);
  l.box(3, nx - 4, 13, 18, f, f, GLASS);
  const [da, db] = l.span(2);
  l.box(da, db, 13, 18, f, f, PAINT);
  l.box(3, nx - 4, 19, 21, f, f, GLASS_DARK);
  for (let x = 5; x <= nx - 6; x += 2) l.put(x, 20, f, AMBER);
  l.tintBox(2, nx - 3, 22, 25, f - 1, f - 1, PAINT);
  l.mbox(2, 6, 6, 7, nz - 1, nz - 1, HEADLIGHT);
  const [pa, pb] = l.span(6);
  l.box(pa, pb, 6, 7, nz - 1, nz - 1, WHITE);
  l.box(8, nx - 9, 10, 12, f, f, TIRE);
  // Rear window, engine grille and lamps.
  l.box(4, nx - 5, 14, 21, 1, 1, GLASS_DARK);
  l.box(da - 1, db + 1, 14, 21, 1, 1, PAINT);
  l.box(6, nx - 7, 10, 13, 1, 1, TIRE);
  for (let x = 6; x <= nx - 7; x += 2) l.box(x, x, 11, 12, 1, 1, ALLOY);
  l.mbox(1, 3, 6, 13, 1, 1, TAILLIGHT);
  l.box(pa, pb, 6, 7, 0, 0, WHITE);

  const rearAxle = sz(18), frontAxle = sz(66);
  wheel(l, rearAxle, 10, true); wheel(l, frontAxle, 10, true);

  // Passenger door on the kerb side.
  const d0 = sz(71), d1 = sz(78);
  l.box(1, 1, 8, 21, d0, d1, GLASS_DARK);
  for (const z of [d0, sz(75), d1]) l.box(1, 1, 8, 21, z, z, PAINT);
  l.box(1, 1, 8, 8, d0, d1, ALLOY);
  l.box(0, 0, 6, 6, d0, d1, ALLOY);
  l.mbox(0, 0, 16, 20, sz(79), sz(80), TRIM);

  // Roof air-conditioning units.
  const [aa, ab] = l.span(10);
  for (const [z0, z1] of [[sz(10), sz(30)], [sz(40), sz(58)]]) {
    l.box(aa, ab, 27, 28, z0, z1, ROOF);
    l.box(aa + 1, ab - 1, 29, 29, z0 + 2, z0 + 4, ALLOY);
    l.box(aa + 1, ab - 1, 29, 29, z1 - 4, z1 - 2, ALLOY);
  }
  if (variant % 2 === 1) l.box(aa + 2, ab - 2, 27, 27, sz(62), sz(72), TRIM);
}

// ---------------------------------------------------------------- factory

/** Every visible vehicle part occupies the same 0.11-unit voxel lattice. */
export function createVehicleModel(type: VehicleType, hex: string, variant: number, width: number, length: number): THREE.Mesh {
  const voxel = VEHICLE_VOXEL_SIZE;
  const nx = Math.max(8, Math.round(width / voxel));
  const nz = Math.max(20, Math.round(length / voxel));
  const ny = NOMINAL_HEIGHT[type];
  const l = new Lattice(nx, ny, nz);

  switch (type) {
    case 'car': case 'taxi': case 'compact': buildSedan(l, type, variant); break;
    case 'pickup': buildPickup(l, variant); break;
    case 'van': buildVan(l, false, variant); break;
    case 'ambulance': buildVan(l, true, variant); break;
    case 'jeep': buildJeep(l, variant); break;
    case 'scooter': buildScooter(l, variant); break;
    case 'truck': buildTruck(l, variant); break;
    case 'bus': buildBus(l, variant); break;
  }

  const tone = new THREE.Color(hex);
  const cargo = ['#e8e2cf', '#7fa6b8', '#d7a05a'][((variant % 3) + 3) % 3];
  const accent = type === 'taxi' ? '#151e27' : type === 'truck' ? cargo : type === 'bus' ? '#f1e6bf' : type === 'jeep' ? '#d9a441' : '#efc678';
  const roof = type === 'ambulance' ? '#f4f0e6' : type === 'jeep' ? '#cdbb8a' : type === 'bus' ? '#d6dad2' : type === 'truck' ? '#d7d3c2' : '#e6e2d3';
  const palette = [
    tone, tone.clone().multiplyScalar(0.68), new THREE.Color('#9bd6df'), new THREE.Color('#47778b'),
    new THREE.Color('#263640'), new THREE.Color('#aebfc1'), new THREE.Color('#fff1c2'),
    new THREE.Color('#e86667'), new THREE.Color('#405761'), new THREE.Color(accent),
    new THREE.Color(roof), new THREE.Color('#f8f4e6'), new THREE.Color('#d94a47'),
    new THREE.Color('#4a7fe0'), new THREE.Color('#f0a53a'), new THREE.Color('#1f2b32')
  ];

  const colors = new Float32Array(l.mask.length * 3);
  for (let index = 0; index < l.mask.length; index++) {
    if (!l.mask[index]) continue;
    const paint = palette[l.shade[index]];
    colors[index * 3] = paint.r;
    colors[index * 3 + 1] = paint.g;
    colors[index * 3 + 2] = paint.b;
  }
  const geometry = voxelSurfaceGeometry(nx, ny, nz, l.mask, false, colors, voxel);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, roughness: 0.7, metalness: 0.11 }));
  mesh.position.y = ny * voxel / 2;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.voxelDimensions = { nx, ny, nz, voxelSize: voxel };
  mesh.userData.voxelMask = l.mask;
  mesh.userData.voxelPalette = colors;
  mesh.userData.vehicleCore = true;
  mesh.userData.vehicleType = type;
  return mesh;
}
