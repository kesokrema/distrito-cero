import * as THREE from 'three';
import type { Weapon } from './InventorySystem';
import { voxelShape, voxelSurfaceGeometry, VOXEL_SIZE } from '../world/VoxelSystem';

const cache = new Map<string, THREE.MeshStandardMaterial>();
const mat = (hex: string): THREE.MeshStandardMaterial => {
  let item = cache.get(hex);
  if (!item) { item = new THREE.MeshStandardMaterial({ color: hex, metalness: 0.32, roughness: 0.48 }); cache.set(hex, item); }
  return item;
};

/** Block-built firearm shared by the world character and the first-person view. */
export function createWeaponModel(kind: Weapon): THREE.Group {
  const root = new THREE.Group();
  const dark = mat('#202e37'), steel = mat('#667987'), highlight = mat('#b4bdba');
  const wood = mat('#a57652'), orange = mat('#ed9a53');
  const box = (w: number, h: number, d: number, color: THREE.Material, x: number, y: number, z: number): void => {
    const mesh = voxelShape(w, h, d, color); mesh.position.set(x, y, z); mesh.castShadow = false; root.add(mesh);
  };
  if (kind === 'fists') return root;
  if (kind === 'charge') {
    // One occupied voxel lattice: the launcher has no intersecting component faces.
    const nx = 6, ny = 7, nz = 10;
    const mask = new Uint8Array(nx * ny * nz);
    const colors = new Float32Array(mask.length * 3);
    const palette = ['#37464d', '#788c83', '#dd9b4b', '#1b272d', '#ddc494'].map((hex) => new THREE.Color(hex));
    const put = (x: number, y: number, z: number, shade: number): void => {
      if (x < 0 || x >= nx || y < 0 || y >= ny || z < 0 || z >= nz) return;
      const index = x + nx * (z + nz * y), color = palette[shade];
      mask[index] = 1;
      colors[index * 3] = color.r; colors[index * 3 + 1] = color.g; colors[index * 3 + 2] = color.b;
    };
    for (let z = 1; z < 9; z++) for (let y = 3; y <= 5; y++) for (let x = 1; x <= 4; x++) {
      if (x === 1 || x === 4 || y === 3 || y === 5) put(x, y, z, z >= 7 ? 2 : z === 2 || z === 6 ? 1 : 0);
    }
    for (let z = 0; z <= 2; z++) for (let x = 2; x <= 3; x++) put(x, 3, z, 3);
    for (let y = 0; y <= 2; y++) for (let x = 2; x <= 3; x++) put(x, y, 5, 3);
    for (let z = 4; z <= 6; z++) for (let x = 1; x <= 4; x++) put(x, 6, z, z === 5 ? 4 : 3);
    for (let x = 0; x < nx; x++) { put(x, 3, 8, 2); put(x, 4, 1, 1); }
    const launcher = new THREE.Mesh(voxelSurfaceGeometry(nx, ny, nz, mask, false, colors),
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0.24 }));
    launcher.position.set(0, -0.08, 0.66);
    launcher.castShadow = false;
    launcher.userData.voxelSize = VOXEL_SIZE;
    root.add(launcher);
    return root;
  }
  const long = kind !== 'pistol';
  const receiverLength = long ? 0.66 : 0.44;
  const receiverZ = receiverLength / 2;
  box(long ? 0.33 : 0.22, 0.22, receiverLength, dark, 0, 0, receiverZ);
  box(0.22, 0.22, kind === 'rifle' ? 0.88 : kind === 'shotgun' ? 0.66 : kind === 'smg' ? 0.44 : 0.22,
    steel, 0, 0, receiverLength + (kind === 'rifle' ? 0.44 : kind === 'shotgun' ? 0.33 : kind === 'smg' ? 0.22 : 0.11));
  const muzzle = kind === 'rifle' ? 1.65 : kind === 'shotgun' ? 1.32 : kind === 'smg' ? 1.10 : 0.77;
  box(0.22, 0.22, 0.22, dark, 0, 0, muzzle);
  box(0.22, 0.44, 0.22, dark, 0, -0.33, 0.22);
  if (long) {
    box(0.33, 0.22, 0.44, kind === 'shotgun' ? wood : dark, 0, 0, -0.22);
    box(0.44, 0.44, 0.22, kind === 'shotgun' ? wood : steel, 0, -0.11, -0.55);
    box(0.22, 0.22, 0.22, highlight, 0, 0.22, 0.22);
  }
  if (kind === 'smg' || kind === 'rifle') {
    box(0.22, kind === 'rifle' ? 0.66 : 0.44, 0.22, steel, 0, kind === 'rifle' ? -0.44 : -0.33, 0.55);
    box(0.22, 0.22, 0.22, highlight, 0, 0.22, muzzle - 0.22);
  }
  if (kind === 'shotgun') {
    box(0.33, 0.22, 0.44, wood, 0, -0.22, 0.88);
    box(0.22, 0.22, 0.22, orange, 0, 0.22, 0.55);
  }
  if (kind === 'pistol') box(0.22, 0.11, 0.22, steel, 0, 0.165, 0.22);
  return root;
}
