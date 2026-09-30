import * as THREE from 'three';
import { voxelShape } from '../world/VoxelSystem';
import { createFaceDecal, type FaceExpression } from './FaceTextures';

export type JointArm = { shoulder: THREE.Group; elbow: THREE.Group; wrist: THREE.Group };
export type JointLeg = { hip: THREE.Group; knee: THREE.Group; foot: THREE.Group };
export type BodyPart = 'torso' | 'head' | 'leftUpperArm' | 'leftForearm' | 'rightUpperArm' | 'rightForearm' |
  'leftThigh' | 'leftShin' | 'rightThigh' | 'rightShin';
export type HumanoidRig = {
  root: THREE.Group; body: THREE.Group; hips: THREE.Group; torso: THREE.Group; neck: THREE.Group; head: THREE.Group; face: THREE.Mesh;
  arms: [JointArm, JointArm]; legs: [JointLeg, JointLeg]; weaponMount: THREE.Group;
};
export type Outfit = { shirt: string; accent: string; pants: string; shoes: string; skin: string; hair: string; style: number };

const materials = new Map<string, THREE.MeshStandardMaterial>();
const material = (hex: string): THREE.MeshStandardMaterial => {
  let found = materials.get(hex);
  if (!found) { found = new THREE.MeshStandardMaterial({ color: hex, roughness: 0.86 }); materials.set(hex, found); }
  return found;
};

const shapeCache = new Map<string, THREE.BufferGeometry>();

/** Compact articulated voxel figure: one head, one torso, two cuboids per limb. */
export function createHumanoid(outfit: Outfit, expression: FaceExpression = 'normal'): HumanoidRig {
  const root = new THREE.Group();
  const body = new THREE.Group(); body.name = 'HumanoidBody'; root.add(body);
  const hips = new THREE.Group(); hips.name = 'mixamorigHips'; hips.position.y = 1.32; body.add(hips);
  const torso = new THREE.Group(); torso.name = 'mixamorigSpine2'; torso.position.y = 0.16; hips.add(torso);
  const neck = new THREE.Group(); neck.name = 'mixamorigNeck'; neck.position.y = 0.52; torso.add(neck);
  const head = new THREE.Group(); head.name = 'mixamorigHead'; head.position.y = 0.14; neck.add(head);
  const shirt = material(outfit.shirt), accent = material(outfit.accent), shoes = material(outfit.shoes);
  const pants = material(outfit.pants);
  const skin = material(outfit.skin);
  const add = (parent: THREE.Group, w: number, h: number, d: number, paint: THREE.Material, x: number, y: number, z: number, part?: BodyPart): THREE.Mesh => {
    const key = `${w}:${h}:${d}`;
    let geometry = shapeCache.get(key);
    if (!geometry) {
      // Geometry is shared by every NPC with the same proportions. This avoids
      // allocating dozens of unique geometries each time a block is populated.
      const shape = voxelShape(w, h, d, paint);
      geometry = shape.geometry;
      shapeCache.set(key, geometry);
    }
    const mesh = new THREE.Mesh(geometry, paint);
    mesh.position.set(x, y, z);
    if (part) mesh.userData.bodyPart = part;
    // Dynamic actors do not each need a shadow draw call; the city sun and
    // ambient occlusion carry the contact and silhouette cues.
    mesh.castShadow = false;
    parent.add(mesh);
    return mesh;
  };

  // One skin-colored voxel head with a face decal just outside its actual
  // quantized front surface. Outfit variation stays in the torso and limbs.
  head.position.y = 0.14;
  torso.position.y = 0.16;
  add(torso, 0.52, 0.68, 0.34, shirt, 0, 0, 0, 'torso');
  add(head, 0.58, 0.58, 0.58, skin, 0, 0, 0, 'head');
  const face = createFaceDecal(expression);
  head.add(face);

  const arms = [-1, 1].map((side, index): JointArm => {
    const prefix = index === 0 ? 'left' : 'right';
    const shoulder = new THREE.Group(); shoulder.name = index === 0 ? 'mixamorigLeftArm' : 'mixamorigRightArm';
    shoulder.position.set(side * 0.39, 0.24, 0); torso.add(shoulder);
    add(shoulder, 0.25, 0.46, 0.27, shirt, 0, -0.23, 0, `${prefix}UpperArm` as BodyPart);
    const elbow = new THREE.Group(); elbow.name = index === 0 ? 'mixamorigLeftForeArm' : 'mixamorigRightForeArm';
    elbow.position.y = -0.46; shoulder.add(elbow);
    add(elbow, 0.23, 0.46, 0.25, outfit.style % 3 === 0 ? accent : skin, 0, -0.23, 0, `${prefix}Forearm` as BodyPart);
    const wrist = new THREE.Group(); wrist.name = index === 0 ? 'mixamorigLeftHand' : 'mixamorigRightHand';
    wrist.position.y = -0.46; elbow.add(wrist);
    add(wrist, 0.22, 0.16, 0.22, skin, 0, -0.035, 0.02);
    return { shoulder, elbow, wrist };
  }) as [JointArm, JointArm];
  const legs = [-1, 1].map((side, index): JointLeg => {
    const prefix = index === 0 ? 'left' : 'right';
    const hip = new THREE.Group(); hip.name = index === 0 ? 'mixamorigLeftUpLeg' : 'mixamorigRightUpLeg';
    hip.position.set(side * 0.17, 0, 0); hips.add(hip);
    add(hip, 0.27, 0.66, 0.3, pants, 0, -0.33, 0, `${prefix}Thigh` as BodyPart);
    const knee = new THREE.Group(); knee.name = index === 0 ? 'mixamorigLeftLeg' : 'mixamorigRightLeg';
    knee.position.y = -0.66; hip.add(knee);
    add(knee, 0.25, 0.66, 0.29, pants, 0, -0.33, 0, `${prefix}Shin` as BodyPart);
    const foot = new THREE.Group(); foot.name = index === 0 ? 'mixamorigLeftFoot' : 'mixamorigRightFoot';
    foot.position.y = -0.66; knee.add(foot);
    add(foot, 0.29, 0.14, 0.34, shoes, 0, 0.03, 0.08);
    return { hip, knee, foot };
  }) as [JointLeg, JointLeg];
  const weaponMount = new THREE.Group(); weaponMount.position.set(0, 0, 0.04); arms[1].wrist.add(weaponMount);
  return { root, body, hips, torso, neck, head, face, arms, legs, weaponMount };
}
