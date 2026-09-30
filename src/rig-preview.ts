import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createHumanoid } from './actors/HumanoidModel';
import { MixamoAnimationSystem, type MixamoState } from './actors/MixamoAnimationSystem';

const scene = new THREE.Scene();
scene.background = new THREE.Color('#a9c4d0');
scene.fog = new THREE.Fog('#a9c4d0', 13, 28);
const camera = new THREE.PerspectiveCamera(36, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 3.0, 7.4);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.28, 0);
controls.enableDamping = true;
controls.minDistance = 3.3;
controls.maxDistance = 12;
controls.maxPolarAngle = Math.PI * 0.48;
controls.update();

scene.add(new THREE.HemisphereLight('#e5f4ff', '#596c52', 2.1));
const sun = new THREE.DirectionalLight('#fff3d8', 3.0);
sun.position.set(-3.5, 7, 4);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = -5; sun.shadow.camera.right = 5;
sun.shadow.camera.top = 6; sun.shadow.camera.bottom = -3;
scene.add(sun);

const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.MeshStandardMaterial({ color: '#718578', roughness: 0.92 }));
floor.rotation.x = -Math.PI / 2; floor.position.y = -0.035; floor.receiveShadow = true; scene.add(floor);
const grid = new THREE.GridHelper(20, 40, '#d0ddc9', '#aabdaf');
grid.position.y = -0.025; (grid.material as THREE.Material).transparent = true; (grid.material as THREE.Material).opacity = 0.24; scene.add(grid);

const model = createHumanoid({ shirt: '#1ebaa8', accent: '#f3ce83', pants: '#263f50', shoes: '#172e3b',
  skin: '#d9a982', hair: '#3a2e2b', style: 2 });
model.root.position.y = 0;
model.root.traverse((object) => { if (object instanceof THREE.Mesh) { object.castShadow = true; object.receiveShadow = true; } });
scene.add(model.root);

const demoWeapon = new THREE.Group();
const weaponPaint = new THREE.MeshStandardMaterial({ color: '#303a40', roughness: 0.58, metalness: 0.24 });
const weaponAccent = new THREE.MeshStandardMaterial({ color: '#9b633d', roughness: 0.83 });
const weaponPart = (size: [number, number, number], position: [number, number, number], paint = weaponPaint): void => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), paint);
  mesh.position.set(...position); mesh.castShadow = true; demoWeapon.add(mesh);
};
weaponPart([0.14, 0.105, 0.36], [0, -0.015, 0.2]);
weaponPart([0.045, 0.045, 0.32], [0, 0.005, 0.52]);
weaponPart([0.055, 0.16, 0.08], [0, -0.12, 0.18], weaponAccent);
weaponPart([0.12, 0.065, 0.15], [0, -0.02, -0.035], weaponAccent);
model.weaponMount.add(demoWeapon);

const jointMaterial = [new THREE.MeshBasicMaterial({ color: '#ffd064', depthTest: false, depthWrite: false }),
  new THREE.MeshBasicMaterial({ color: '#ff8d64', depthTest: false, depthWrite: false }),
  new THREE.MeshBasicMaterial({ color: '#75e2d1', depthTest: false, depthWrite: false })];
const jointObjects = [model.hips, model.torso, model.arms[0].shoulder, model.arms[0].elbow,
  model.arms[1].shoulder, model.arms[1].elbow, model.legs[0].hip, model.legs[0].knee,
  model.legs[1].hip, model.legs[1].knee];
const markers = jointObjects.map((_, index) => {
  const marker = new THREE.Mesh(new THREE.SphereGeometry(index < 2 ? 0.055 : 0.07, 10, 8), jointMaterial[index < 2 ? 0 : index < 6 ? 1 : 2]);
  marker.castShadow = false; marker.renderOrder = 5; scene.add(marker); return marker;
});

const animations = new MixamoAnimationSystem();
const status = document.querySelector<HTMLElement>('#status')!;
let selected: 'tpose' | MixamoState = 'tpose';
let loaded = false;

function resetTargetPose(): void {
  model.body.rotation.set(0, 0, 0);
  model.hips.position.y = 1.32; model.hips.rotation.set(0, 0, 0);
  model.torso.position.y = 0.16; model.torso.rotation.set(0, 0, 0);
  model.neck.rotation.set(0, 0, 0); model.head.rotation.set(0, 0, 0);
  for (const arm of model.arms) { arm.shoulder.rotation.set(0, 0, 0); arm.elbow.rotation.set(0, 0, 0); arm.wrist.rotation.set(0, 0, 0); }
  for (const leg of model.legs) { leg.hip.rotation.set(0, 0, 0); leg.knee.rotation.set(0, 0, 0); leg.foot.rotation.set(0, 0, 0); }
}

function setPose(pose: 'tpose' | MixamoState): void {
  selected = pose;
  animations.stop(model.body);
  resetTargetPose();
  if (pose === 'tpose') {
    model.arms[0].shoulder.rotation.z = -Math.PI / 2;
    model.arms[1].shoulder.rotation.z = Math.PI / 2;
    status.textContent = 'T POSE · hombros, codos, cadera y rodillas visibles';
  } else if (pose === 'walk' || pose === 'run' || pose === 'aim') {
    status.textContent = `${pose === 'aim' ? 'APUNTADO A DOS MANOS' : 'LOCOMOCIÓN PROCEDURAL'} · ${pose.toUpperCase()}`;
  } else {
    status.textContent = loaded ? `ANIMACIÓN · ${pose.toUpperCase()}` : 'Cargando animaciones Mixamo…';
  }
  demoWeapon.visible = pose === 'aim';
  document.querySelectorAll<HTMLButtonElement>('[data-pose]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.pose === pose));
  });
}

let gaitPhase = 0;
function applyDemoGait(dt: number, running: boolean): void {
  const frequency = running ? 10.2 : 6.4;
  const strideLength = running ? 0.76 : 0.43;
  const kneeLift = running ? 0.94 : 0.66;
  gaitPhase += dt * frequency;
  const cycle = Math.sin(gaitPhase);
  model.hips.position.y = 1.32 + (running ? 0.045 : 0.018) * (0.5 + 0.5 * Math.cos(gaitPhase * 2));
  model.hips.rotation.z = Math.sin(gaitPhase) * (running ? 0.035 : 0.02);
  model.torso.rotation.x = (running ? 0.16 : 0.055) + Math.sin(gaitPhase * 2) * 0.025;
  model.torso.rotation.z = -model.hips.rotation.z * 0.55;
  for (let side = 0; side < 2; side++) {
    const swing = cycle * (side === 0 ? 1 : -1);
    const leg = model.legs[side], arm = model.arms[side];
    leg.hip.rotation.x = swing * strideLength;
    leg.knee.rotation.x = Math.max(0, -swing) * kneeLift;
    leg.foot.rotation.x = -leg.knee.rotation.x * 0.5 - Math.max(0, swing) * 0.12;
    arm.shoulder.rotation.x = -swing * (running ? 0.68 : 0.43);
    arm.elbow.rotation.x = running ? -0.28 - Math.max(0, swing) * 0.5 : -0.12 - Math.max(0, swing) * 0.24;
    arm.wrist.rotation.x = -arm.elbow.rotation.x * 0.18;
  }
}

function aimArm(side: 0 | 1, target: THREE.Vector3): void {
  const arm = model.arms[side];
  const down = new THREE.Vector3(0, -1, 0);
  const start = arm.shoulder.position.clone();
  const direction = target.clone().sub(start);
  const distance = Math.min(0.86, direction.length());
  direction.normalize();
  const preferred = new THREE.Vector3(side === 0 ? -0.36 : 0.36, -0.58, -0.34);
  const bend = preferred.addScaledVector(direction, -preferred.dot(direction)).normalize();
  const half = distance * 0.5;
  const elbowPoint = start.clone().addScaledVector(direction, half)
    .addScaledVector(bend, Math.sqrt(Math.max(0, 0.46 * 0.46 - half * half)));
  const upper = elbowPoint.sub(start).normalize();
  arm.shoulder.quaternion.setFromUnitVectors(down, upper);
  const elbowWorld = start.clone().addScaledVector(down.clone().applyQuaternion(arm.shoulder.quaternion), 0.46);
  const lower = target.clone().sub(elbowWorld).applyQuaternion(arm.shoulder.quaternion.clone().invert()).normalize();
  arm.elbow.quaternion.setFromUnitVectors(down, lower);
  // Keep the barrel aligned with the character's forward axis even though
  // the forearm bends toward the shared grip point.
  arm.wrist.quaternion.copy(arm.shoulder.quaternion).multiply(arm.elbow.quaternion).invert();
}

function applyDemoAim(): void {
  model.hips.position.y = 1.32;
  model.torso.rotation.x = 0.045;
  aimArm(1, new THREE.Vector3(0.14, 0.08, 0.72));
  aimArm(0, new THREE.Vector3(-0.12, 0.03, 0.52));
}

document.querySelectorAll<HTMLButtonElement>('[data-pose]').forEach((button) => {
  button.addEventListener('click', () => setPose(button.dataset.pose as 'tpose' | MixamoState));
});
setPose('tpose');
void animations.load().then(() => {
  loaded = true;
  status.textContent = selected === 'tpose' ? 'T POSE · listo para inspección' : `ANIMACIÓN · ${selected.toUpperCase()}`;
});

let previous = performance.now();
function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min((now - previous) / 1000, 0.05); previous = now;
  if (selected === 'walk') applyDemoGait(dt, false);
  else if (selected === 'run') applyDemoGait(dt, true);
  else if (selected === 'aim') applyDemoAim();
  else if (loaded && selected !== 'tpose') animations.update(model.body, dt, selected as MixamoState);
  model.root.updateWorldMatrix(true, true);
  jointObjects.forEach((joint, index) => {
    markers[index].position.copy(joint.getWorldPosition(new THREE.Vector3()));
    markers[index].position.z += 0.15;
  });
  controls.update();
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix(); renderer.setSize(window.innerWidth, window.innerHeight);
});
