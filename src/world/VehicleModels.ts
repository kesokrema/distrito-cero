import * as THREE from 'three';
import { VOXEL_SIZE, voxelSurfaceGeometry } from './VoxelSystem';

export type VehicleType = 'car' | 'compact' | 'taxi' | 'pickup' | 'van' | 'jeep' | 'scooter' | 'truck' | 'bus' | 'ambulance';

const PAINT = 0, SHADE = 1, GLASS = 2, GLASS_DARK = 3, TIRE = 4, ALLOY = 5;
const HEADLIGHT = 6, TAILLIGHT = 7, TRIM = 8, ACCENT = 9, ROOF = 10, WHITE = 11;

/** Every visible vehicle part occupies the same 0.22-unit voxel lattice. */
export function createVehicleModel(type: VehicleType, hex: string, variant: number, width: number, length: number): THREE.Mesh {
  const nx = Math.max(4, Math.round(width / VOXEL_SIZE));
  const nz = Math.max(8, Math.round(length / VOXEL_SIZE));
  const ny = type === 'bus' || type === 'truck' ? 15 : type === 'ambulance' || type === 'van' ? 13 : type === 'jeep' ? 12 : type === 'scooter' ? 9 : 11;
  const mask = new Uint8Array(nx * ny * nz);
  const shades = new Uint8Array(mask.length);
  const tone = new THREE.Color(hex);
  const palette = [
    tone, tone.clone().multiplyScalar(0.68), new THREE.Color('#9bd6df'), new THREE.Color('#47778b'),
    new THREE.Color('#263640'), new THREE.Color('#aebfc1'), new THREE.Color('#fff1c2'),
    new THREE.Color('#e86667'), new THREE.Color('#405761'), new THREE.Color(type === 'taxi' ? '#151e27' : '#efc678'),
    new THREE.Color(type === 'ambulance' ? '#f4f0e6' : '#e6e2d3'), new THREE.Color('#f8f4e6')
  ];
  const at = (x: number, y: number, z: number) => x + nx * (z + nz * y);
  const put = (x: number, y: number, z: number, shade: number) => {
    if (x < 0 || x >= nx || y < 0 || y >= ny || z < 0 || z >= nz) return;
    const index = at(x, y, z);
    mask[index] = 1; shades[index] = shade;
  };
  const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, shade: number) => {
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) put(x, y, z, shade);
  };
  const side = (y: number, z: number, shade: number) => { put(1, y, z, shade); put(nx - 2, y, z, shade); };
  const axleRear = type === 'scooter' ? 1 : Math.max(2, Math.round(nz * 0.19));
  const axleFront = type === 'scooter' ? nz - 2 : Math.min(nz - 3, Math.round(nz * 0.78));

  if (type === 'scooter') {
    const left = Math.floor(nx / 2) - 1, right = Math.floor(nx / 2);
    box(left, right, 2, 3, 2, nz - 3, PAINT);
    box(left, right, 3, 4, 1, 4, PAINT);
    box(left, right, 5, 5, 2, 5, TIRE);
    box(left, right, 4, 6, nz - 3, nz - 2, PAINT);
    box(0, nx - 1, 7, 7, nz - 3, nz - 3, TRIM);
    put(0, 8, nz - 3, GLASS_DARK); put(nx - 1, 8, nz - 3, GLASS_DARK);
    box(left, right, 5, 5, nz - 1, nz - 1, HEADLIGHT);
    box(left, right, 4, 4, 0, 0, TAILLIGHT);
    box(left, right, 2, 2, 5, 6, SHADE);
    for (const z of [axleRear, axleFront]) {
      for (let y = 0; y <= 2; y++) for (let dz = -1; dz <= 1; dz++) {
        if (Math.abs(y - 1) + Math.abs(dz) > 1) continue;
        box(left, right, y, y, z + dz, z + dz, TIRE);
      }
      put(right, 1, z, ALLOY);
    }
  } else {
    // Chassis and shaped front and rear ends.
    box(1, nx - 2, 2, 4, 1, nz - 2, PAINT);
    box(2, nx - 3, 1, 2, 2, nz - 3, SHADE);
    box(1, nx - 2, 2, 2, 0, 0, TRIM);
    box(1, nx - 2, 2, 2, nz - 1, nz - 1, TRIM);
    box(2, nx - 3, 4, 4, nz - 3, nz - 2, PAINT);
    box(2, nx - 3, 4, 4, 1, 2, SHADE);
    const high = type === 'bus' || type === 'truck' ? 13 : type === 'ambulance' || type === 'van' ? 11 : type === 'jeep' ? 10 : 9;
    let cabinBack = Math.round(nz * 0.29);
    let cabinFront = Math.round(nz * 0.73);
    if (type === 'compact') { cabinBack = 3; cabinFront = nz - 4; }
    if (type === 'pickup') { cabinBack = Math.round(nz * 0.52); cabinFront = nz - 4; }
    if (type === 'van' || type === 'ambulance' || type === 'bus') { cabinBack = 2; cabinFront = nz - 3; }
    if (type === 'truck') { cabinBack = Math.round(nz * 0.59); cabinFront = nz - 3; }
    if (type === 'jeep') { cabinBack = 3; cabinFront = nz - 4; }
    const boxy = ['van', 'ambulance', 'bus', 'truck', 'jeep'].includes(type);
    const roofBack = boxy ? cabinBack : cabinBack + 1;
    const roofFront = boxy ? cabinFront : cabinFront - 1;
    box(2, nx - 3, 5, high - 1, roofBack, roofFront, GLASS_DARK);
    box(2, nx - 3, high, high, roofBack, roofFront, type === 'ambulance' ? WHITE : PAINT);
    for (let z = cabinBack; z <= cabinFront; z++) {
      const edge = z === cabinBack || z === cabinFront;
      side(5, z, edge ? TRIM : GLASS);
      if (high >= 7) side(6, z, edge ? PAINT : GLASS);
      if (boxy && high >= 9) for (let y = 7; y < high; y++) side(y, z, type === 'truck' && z < cabinFront - 3 ? PAINT : z % 5 === 0 ? TRIM : GLASS_DARK);
    }
    box(2, nx - 3, 5, high - 1, cabinFront, cabinFront, GLASS);
    box(2, nx - 3, 5, high - 1, cabinBack, cabinBack, type === 'pickup' ? PAINT : GLASS_DARK);
    box(1, nx - 2, high, high, roofBack, roofFront, type === 'ambulance' ? WHITE : PAINT);
    // Narrow roof trim and windows establish a recognizable silhouette.
    for (const z of [roofBack, roofFront]) box(1, nx - 2, high, high, z, z, TRIM);
    if (type === 'car' || type === 'taxi' || type === 'compact') {
      for (const z of [Math.round((cabinBack + cabinFront) / 2)]) {
        side(5, z, TRIM); side(6, z, TRIM);
      }
      for (const z of [cabinBack + 1, cabinFront - 1]) {
        side(4, z, TRIM);
        side(3, z, SHADE);
      }
      if (type === 'compact') {
        box(2, nx - 3, 4, 6, 1, 2, GLASS_DARK);
        box(2, nx - 3, high + 1, high + 1, 2, 2, TRIM);
        box(2, nx - 3, 3, 3, 0, 0, TAILLIGHT);
      } else {
        box(2, nx - 3, 5, 5, cabinFront + 1, cabinFront + 1, GLASS);
        box(2, nx - 3, 5, 5, cabinBack - 1, cabinBack - 1, GLASS_DARK);
      }
    }
    if (type === 'taxi') {
      box(Math.floor(nx / 2) - 1, Math.floor(nx / 2), high + 1, high + 1, Math.floor(nz / 2) - 1, Math.floor(nz / 2) + 1, WHITE);
      for (let z = 3; z < nz - 3; z++) side(3, z, z % 2 ? TIRE : WHITE);
    }
    if (type === 'pickup') {
      box(2, nx - 3, 4, 4, 2, cabinBack - 2, TIRE);
      for (const x of [1, nx - 2]) box(x, x, 5, 5, 1, cabinBack - 1, PAINT);
      box(1, nx - 2, 5, 5, 1, 1, PAINT);
      box(1, nx - 2, 5, 5, cabinBack - 1, cabinBack - 1, TRIM);
      for (let z = 3; z < cabinBack - 1; z += 3) box(2, nx - 3, 5, 5, z, z, SHADE);
    }
    if (type === 'jeep') {
      for (const x of [1, nx - 2]) box(x, x, high + 1, high + 1, cabinBack, cabinFront, TRIM);
      box(2, nx - 3, high + 1, high + 1, cabinBack, cabinBack, TRIM);
      box(Math.floor(nx / 2) - 1, Math.floor(nx / 2), 4, 6, 0, 0, TIRE);
      put(Math.floor(nx / 2), 5, 0, ALLOY);
      for (const z of [2, nz - 3]) box(0, nx - 1, 3, 3, z, z, TRIM);
      for (let x = 2; x < nx - 2; x += 2) put(x, 4, nz - 1, TRIM);
      box(2, nx - 3, high + 1, high + 1, cabinFront, cabinFront, TRIM);
    }
    if (type === 'van' || type === 'ambulance') {
      for (const z of [Math.floor(nz * 0.45), Math.floor(nz * 0.47)]) for (const y of [5, 6, 7]) side(y, z, TRIM);
      side(4, Math.floor(nz * 0.47), ALLOY);
      if (type === 'ambulance') {
        for (const z of [4, 5, 6]) side(6, z, TAILLIGHT);
        for (const y of [5, 6, 7]) side(y, 5, TAILLIGHT);
        box(2, nx - 3, high + 1, high + 1, cabinFront - 1, cabinFront, TAILLIGHT);
        box(2, nx - 3, 3, 3, 1, nz - 2, TAILLIGHT);
      } else {
        box(2, nx - 3, 3, 3, 1, nz - 2, ACCENT);
        for (const x of [1, nx - 2]) box(x, x, 7, high - 1, 2, Math.floor(nz * 0.4), PAINT);
      }
      box(Math.floor(nx / 2), Math.floor(nx / 2), 4, high - 1, 1, 1, TRIM);
    }
    if (type === 'truck') {
      box(1, nx - 2, 5, 10, 2, cabinBack - 2, ACCENT);
      box(2, nx - 3, 11, 11, 2, cabinBack - 2, ROOF);
      for (let z = 3; z < cabinBack - 2; z += 4) {
        for (const x of [1, nx - 2]) box(x, x, 5, 10, z, z, TRIM);
      }
      box(2, nx - 3, 3, 3, cabinFront + 1, nz - 2, TRIM);
    }
    if (type === 'bus') {
      for (let z = 3; z < nz - 3; z += 5) for (let y = 6; y <= 8; y++) side(y, z, TRIM);
      box(1, nx - 2, 3, 3, 1, nz - 2, ACCENT);
      for (const x of [1, nx - 2]) box(x, x, 4, 5, nz - 7, nz - 7, TRIM);
      box(2, nx - 3, 6, 9, 1, 1, GLASS_DARK);
      box(2, nx - 3, high + 1, high + 1, 3, nz - 4, ROOF);
      for (const x of [1, nx - 2]) box(x, x, 4, 8, nz - 6, nz - 5, TRIM);
      box(2, nx - 3, 10, 10, nz - 2, nz - 2, ACCENT);
    }
    // Modern front and rear lamp clusters, grille, plate and side mirrors.
    const lampSpan = Math.max(1, Math.round(nx * 0.2));
    for (let x = 1; x <= lampSpan; x++) {
      put(x, 4, nz - 1, HEADLIGHT); put(nx - 1 - x, 4, nz - 1, HEADLIGHT);
      put(x, 4, 0, TAILLIGHT); put(nx - 1 - x, 4, 0, TAILLIGHT);
    }
    box(2, nx - 3, 3, 3, nz - 1, nz - 1, type === 'jeep' ? TRIM : TIRE);
    box(Math.floor(nx / 2) - 1, Math.floor(nx / 2), 2, 2, nz - 1, nz - 1, ALLOY);
    box(Math.floor(nx / 2) - 1, Math.floor(nx / 2), 2, 2, 0, 0, WHITE);
    for (const x of [0, nx - 1]) {
      put(x, 5, cabinFront, TRIM); put(x, 5, cabinFront + 1, GLASS_DARK);
    }
    for (const z of [axleRear, axleFront]) for (const x of [0, nx - 1]) {
      for (let y = 0; y <= 2; y++) for (let dz = -1; dz <= 1; dz++) {
        if (Math.abs(y - 1) + Math.abs(dz) > 1) continue;
        put(x, y, z + dz, TIRE);
      }
      put(x, 1, z, ALLOY);
      for (const dz of [-1, 0, 1]) put(x, 3, z + dz, SHADE);
      if (z > 1) put(x === 0 ? 1 : nx - 2, 3, z, SHADE);
    }
    if (variant % 3 === 1 && type !== 'bus' && type !== 'truck') {
      box(2, nx - 3, high + 1, high + 1, roofBack + 1, roofBack + 1, type === 'ambulance' ? TAILLIGHT : TRIM);
    }
  }

  const colors = new Float32Array(mask.length * 3);
  for (let index = 0; index < mask.length; index++) {
    if (!mask[index]) continue;
    const paint = palette[shades[index]];
    colors[index * 3] = paint.r;
    colors[index * 3 + 1] = paint.g;
    colors[index * 3 + 2] = paint.b;
  }
  const geometry = voxelSurfaceGeometry(nx, ny, nz, mask, false, colors);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, roughness: 0.7, metalness: 0.11 }));
  mesh.position.y = ny * VOXEL_SIZE / 2;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.voxelDimensions = { nx, ny, nz };
  mesh.userData.voxelMask = mask;
  mesh.userData.voxelPalette = colors;
  mesh.userData.vehicleCore = true;
  mesh.userData.vehicleType = type;
  return mesh;
}
