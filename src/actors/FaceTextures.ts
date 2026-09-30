import * as THREE from 'three';
import { VOXEL_SIZE } from '../world/VoxelConstants';

export type FaceExpression = 'normal' | 'annoyed' | 'scared' | 'dead' | 'happy';

const urls: Record<FaceExpression, string> = {
  normal: new URL('../assets/faces/normal.png', import.meta.url).href,
  annoyed: new URL('../assets/faces/annoyed.png', import.meta.url).href,
  scared: new URL('../assets/faces/scared.png', import.meta.url).href,
  dead: new URL('../assets/faces/dead.png', import.meta.url).href,
  happy: new URL('../assets/faces/happy.png', import.meta.url).href
};

const geometry = new THREE.PlaneGeometry(0.6, 0.6);
const materials = new Map<FaceExpression, THREE.MeshBasicMaterial>();

function faceMaterial(expression: FaceExpression): THREE.MeshBasicMaterial {
  let material = materials.get(expression);
  if (material) return material;
  // Trim the transparent border and boost the dark generated pixels. At the
  // normal city zoom the old 128px decal occupied only a couple of pixels.
  // Physics tests run without image elements and use an invisible placeholder.
  let texture: THREE.CanvasTexture | null = null;
  if (typeof Image !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = 48; canvas.height = 48;
    const context = canvas.getContext('2d')!;
    context.imageSmoothingEnabled = false;
    texture = new THREE.CanvasTexture(canvas);
    const image = new Image();
    image.onload = () => {
      const scan = document.createElement('canvas');
      scan.width = image.width; scan.height = image.height;
      const scanContext = scan.getContext('2d')!;
      scanContext.drawImage(image, 0, 0);
      const pixels = scanContext.getImageData(0, 0, scan.width, scan.height).data;
      let left = scan.width, right = 0, top = scan.height, bottom = 0;
      for (let y = 0; y < scan.height; y += 2) for (let x = 0; x < scan.width; x += 2) {
        if (pixels[(y * scan.width + x) * 4 + 3] < 100) continue;
        left = Math.min(left, x); right = Math.max(right, x);
        top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
      context.clearRect(0, 0, 48, 48);
      if (right > left && bottom > top) {
        const width = right - left, height = bottom - top;
        context.drawImage(image, Math.max(0, left - width * 0.12), Math.max(0, top - height * 0.12),
          width * 1.24, height * 1.24, 1, 1, 46, 46);
        const face = context.getImageData(0, 0, 48, 48);
        for (let i = 0; i < face.data.length; i += 4) {
          if (face.data[i + 3] < 95) { face.data[i + 3] = 0; continue; }
          face.data[i] = 32; face.data[i + 1] = 26; face.data[i + 2] = 29;
          face.data[i + 3] = 255;
        }
        context.putImageData(face, 0, 0);
      }
      texture!.needsUpdate = true;
    };
    image.src = urls[expression];
  }
  if (texture) {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.minFilter = THREE.NearestFilter;
    texture.anisotropy = 1;
  }
  material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, alphaTest: 0.35,
    depthWrite: false, side: THREE.FrontSide, toneMapped: false, visible: Boolean(texture) });
  materials.set(expression, material);
  return material;
}

/** The head is rounded to whole voxels, so use its rendered depth. */
export function createFaceDecal(expression: FaceExpression = 'normal'): THREE.Mesh {
  const face = new THREE.Mesh(geometry, faceMaterial(expression));
  face.name = 'pixel-face';
  face.position.z = Math.round(0.58 / VOXEL_SIZE) * VOXEL_SIZE / 2 + 0.012;
  face.userData.expression = expression;
  face.renderOrder = 3;
  return face;
}

export function setFaceExpression(face: THREE.Mesh, expression: FaceExpression): void {
  if (face.userData.expression === expression) return;
  face.material = faceMaterial(expression);
  face.userData.expression = expression;
}
