import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { Weapon } from '../actors/InventorySystem';
import { createWeaponModel } from '../actors/WeaponModel';
import { voxelShape } from '../world/VoxelSystem';
import { AtmosphereSystem } from './AtmosphereSystem';
import type { CityClock } from './CityClock';

export type CameraMode = 'isometric' | 'perspective' | 'firstPerson';

export class RenderEngine {
  readonly scene = new THREE.Scene();
  private readonly isometricCamera = new THREE.OrthographicCamera(-32, 32, 20, -20, 0.1, 300);
  private readonly perspectiveCamera = new THREE.PerspectiveCamera(68, 1, 0.08, 300);
  camera: THREE.OrthographicCamera | THREE.PerspectiveCamera = this.isometricCamera;
  mode: CameraMode = 'isometric';
  readonly renderer: THREE.WebGLRenderer;
  readonly raycaster = new THREE.Raycaster();
  private cameraTarget = new THREE.Vector3();
  private cameraOffset = new THREE.Vector3();
  private panOffset = new THREE.Vector3();
  private yaw = Math.PI / 4;
  private isometricYaw = Math.PI / 4;
  private pitch = 0;
  private zoomHeight = 20.5;
  private thirdDistance = 7.8;
  private thirdHeight = 4.15;
  private orbitHold = 0;
  private collisionProbe: ((from: THREE.Vector3, to: THREE.Vector3) => number | null) | null = null;
  private collisionTime = 0;
  private collisionDistance: number | null = null;
  private readonly composer: EffectComposer;
  private readonly renderPass: RenderPass;
  private readonly ssao: SSAOPass;
  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private skyFill: THREE.DirectionalLight;
  private sunOffset = new THREE.Vector3(-34, 68, 26);
  private readonly atmosphere: AtmosphereSystem;
  private readonly viewWeapon = new THREE.Group();
  private viewTime = 0;
  private ads = false;
  private lastViewWeapon: Weapon = 'fists';
  private readonly viewCloth = new THREE.MeshStandardMaterial({ color: '#25b9ac', roughness: 0.85 });
  private readonly viewSkin = new THREE.MeshStandardMaterial({ color: '#e8bd98', roughness: 0.87 });
  private readonly wireframeMaterial = new THREE.MeshBasicMaterial({
    color: '#d7f5ea', wireframe: true, side: THREE.DoubleSide, fog: true, toneMapped: false
  });
  private groundProbe:((x:number,z:number,y:number)=>number)|null=null;
  setGroundProbe(probe:(x:number,z:number,y:number)=>number):void{this.groundProbe=probe;}
  private wireframeEnabled = false;
  private cockpitVehicle: THREE.Group | null = null;

  constructor(container: HTMLElement) {
    // A pale blue-green haze keeps the far blocks readable while giving the
    // city the warm, sunlit contrast of the visual target.
    this.scene.background = new THREE.Color('#b8c9c4');
    this.scene.fog = new THREE.Fog('#b8c9c4', 145, 300);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.14;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);
    this.hemi = new THREE.HemisphereLight('#e5efff', '#596d47', 0.86);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight('#ffd29b', 2.84);
    this.sun.position.set(-34, 68, 26);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.left = -42;
    this.sun.shadow.camera.right = 42;
    this.sun.shadow.camera.top = 42;
    this.sun.shadow.camera.bottom = -42;
    this.sun.shadow.bias = -0.00025;
    this.sun.shadow.normalBias = 0.018;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.skyFill = new THREE.DirectionalLight('#9ec9e3', 0.32);
    this.skyFill.position.set(26, 35, -31);
    this.scene.add(this.skyFill);
    this.atmosphere = new AtmosphereSystem(this.scene);
    this.perspectiveCamera.add(this.viewWeapon);
    this.viewWeapon.scale.setScalar(0.62);
    this.scene.add(this.perspectiveCamera);
    this.setViewWeapon('pistol');
    this.updateCameraOffset();
    this.camera.position.copy(this.cameraOffset);
    this.camera.lookAt(0, 0, 0);
    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);
    this.ssao = new SSAOPass(this.scene, this.camera, 1, 1, 12);
    // Three.js defaults this shader to perspective depth even when given an
    // orthographic camera. Without this override the AO texture is white.
    this.ssao.ssaoMaterial.defines.PERSPECTIVE_CAMERA = 0;
    this.ssao.ssaoMaterial.needsUpdate = true;
    this.ssao.kernelRadius = 2.7;
    this.ssao.minDistance = 0.001;
    this.ssao.maxDistance = 0.055;
    const aoMode = new URLSearchParams(window.location.search).get('ao');
    if (aoMode === '0') this.ssao.enabled = false;
    this.composer.addPass(this.ssao);
    this.composer.addPass(new OutputPass());
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize(): void {
    const width = this.renderer.domElement.parentElement?.clientWidth || window.innerWidth;
    const height = this.renderer.domElement.parentElement?.clientHeight || window.innerHeight;
    const aspect = width / Math.max(1, height);
    const halfHeight = this.zoomHeight + (window.innerWidth < 700 ? 1.5 : 0);
    this.isometricCamera.left = -halfHeight * aspect;
    this.isometricCamera.right = halfHeight * aspect;
    this.isometricCamera.top = halfHeight;
    this.isometricCamera.bottom = -halfHeight;
    this.isometricCamera.updateProjectionMatrix();
    this.perspectiveCamera.aspect = aspect;
    this.perspectiveCamera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.composer.setSize(width, height);
    // AO is blurred before composition, so its internal buffers can be smaller
    // while the city, silhouettes, and final image stay at full resolution.
    const aoScale = this.renderer.getPixelRatio() * 0.55;
    this.ssao.setSize(Math.max(1, Math.round(width * aoScale)), Math.max(1, Math.round(height * aoScale)));
  }

  setTimeOfDay(clock: CityClock): void {
    const day = clock.daylight;
    const sunset = Math.min(1, clock.sunset);
    const ambient = Math.max(day, sunset * 0.5);
    const sky = new THREE.Color('#17283f').lerp(new THREE.Color('#b8c9c4'), day)
      .lerp(new THREE.Color('#e99b78'), sunset * 0.52);
    (this.scene.background as THREE.Color).copy(sky);
    (this.scene.fog as THREE.Fog).color.copy(sky);
    this.hemi.intensity = 0.4 + ambient * 0.46;
    this.hemi.color.set('#9eb7d8').lerp(new THREE.Color('#e5efff'), day);
    this.skyFill.intensity = 0.16 + ambient * 0.16;
    this.sun.intensity = 0.22 + day * 2.62 + sunset * 0.55;
    this.sun.color.set('#ffd29b').lerp(new THREE.Color('#ff9968'), sunset * 0.66);
    this.sun.castShadow = day > 0.13 || sunset > 0.3;
    this.renderer.toneMappingExposure = 0.96 + ambient * 0.18;
    const angle = clock.hour * Math.PI / 12;
    this.sunOffset.set(Math.cos(angle) * 50, 15 + 55 * Math.max(0.05, Math.sin((clock.hour - 6) * Math.PI / 12)), Math.sin(angle) * 38);
    this.atmosphere.setTimeOfDay(day, sunset);
  }

  private updateCameraOffset(): void {
    this.cameraOffset.set(Math.sin(this.yaw) * 59, 53, Math.cos(this.yaw) * 59);
  }

  setCollisionProbe(probe: (from: THREE.Vector3, to: THREE.Vector3) => number | null): void {
    this.collisionProbe = probe;
  }

  setMode(mode: CameraMode, position: THREE.Vector3, heading: number): void {
    if (mode === this.mode) return;
    if (this.mode === 'isometric') this.isometricYaw = this.yaw;
    const previousMode = this.mode;
    this.mode = mode;
    this.viewWeapon.visible = mode === 'firstPerson';
    if (mode === 'isometric') this.yaw = this.isometricYaw;
    else if (previousMode === 'isometric') this.yaw = heading + Math.PI;
    this.pitch = 0;
    this.panOffset.set(0, 0, 0);
    this.orbitHold = 0;
    this.collisionTime = 0;
    this.cameraTarget.copy(position);
    this.camera = mode === 'isometric' ? this.isometricCamera : this.perspectiveCamera;
    this.renderPass.camera = this.camera;
    this.ssao.camera = this.camera;
    this.ssao.ssaoMaterial.defines.PERSPECTIVE_CAMERA = mode === 'isometric' ? 0 : 1;
    this.ssao.ssaoMaterial.needsUpdate = true;
    this.ssao.kernelRadius = mode === 'isometric' ? 2.7 : mode === 'perspective' ? 1.9 : 1.2;
    this.updateCameraOffset();
    this.resize();
    this.follow(position, 1);
  }

  orbit(deltaX: number, deltaY = 0): void {
    // forward() points toward -sin(yaw); reducing yaw turns the view right.
    this.yaw -= deltaX * 0.006;
    if (this.mode === 'isometric') this.isometricYaw = this.yaw;
    if (this.mode === 'firstPerson') this.pitch = THREE.MathUtils.clamp(this.pitch - deltaY * 0.004, -1.2, 1.2);
    else if (this.mode === 'perspective') this.thirdHeight = THREE.MathUtils.clamp(this.thirdHeight + deltaY * 0.022, 2.1, 7);
    else this.updateCameraOffset();
    this.orbitHold = 2.5;
  }

  pan(deltaX: number, deltaY: number): void {
    if (this.mode !== 'isometric') { this.orbit(deltaX, deltaY); return; }
    const scale = this.zoomHeight * 2 / Math.max(1, this.renderer.domElement.clientHeight);
    this.panOffset.x += (-Math.cos(this.yaw) * deltaX - Math.sin(this.yaw) * deltaY) * scale;
    this.panOffset.z += (Math.sin(this.yaw) * deltaX - Math.cos(this.yaw) * deltaY) * scale;
    this.panOffset.clampLength(0, 44);
  }

  zoom(deltaY: number): void {
    if (this.mode === 'isometric') this.zoomHeight = THREE.MathUtils.clamp(this.zoomHeight * Math.exp(deltaY * 0.0011), 11, 30);
    else if (this.mode === 'perspective') this.thirdDistance = THREE.MathUtils.clamp(this.thirdDistance * Math.exp(deltaY * 0.001), 4.2, 13);
    else this.perspectiveCamera.fov = THREE.MathUtils.clamp(this.perspectiveCamera.fov + deltaY * 0.02, 52, 88);
    this.resize();
  }

  setViewWeapon(weapon: Weapon, visible = true): void {
    this.viewWeapon.scale.setScalar(weapon === 'charge' ? 0.34 : 0.62);
    if (weapon !== this.lastViewWeapon) {
      this.viewWeapon.clear();
      this.lastViewWeapon = weapon;
      const gun = createWeaponModel(weapon);
      gun.rotation.y = Math.PI;
      gun.traverse((part) => { if (part instanceof THREE.Mesh) part.castShadow = false; });
      this.viewWeapon.add(gun);
      for (const side of [-1, 1]) {
        const sleeve = voxelShape(0.22, 0.22, 0.55, this.viewCloth);
        sleeve.position.set(side * 0.24, -0.30, 0.37);
        const hand = voxelShape(0.22, 0.22, 0.22, this.viewSkin);
        hand.position.set(side * 0.17, -0.18, 0.07);
        this.viewWeapon.add(sleeve, hand);
      }
    }
    this.viewWeapon.visible = visible && this.mode === 'firstPerson';
  }

  setAiming(enabled: boolean): void {
    this.ads = enabled;
  }

  updateViewWeapon(dt: number, movementSpeed: number, recoil: number): void {
    if (this.mode !== 'firstPerson') return;
    this.viewTime += dt * (2 + movementSpeed * 1.3);
    const blend = Math.min(1, dt * 14);
    const bob = Math.min(1, movementSpeed / 9);
    const launcher = this.lastViewWeapon === 'charge';
    const targetX = launcher ? (this.ads ? 0.31 : 0.53) : this.ads ? 0 : 0.28;
    const targetY = launcher ? (this.ads ? -0.37 : -0.48) : this.ads ? -0.20 : -0.31;
    this.viewWeapon.position.x = THREE.MathUtils.lerp(this.viewWeapon.position.x, targetX + Math.sin(this.viewTime) * 0.012 * bob, blend);
    this.viewWeapon.position.y = THREE.MathUtils.lerp(this.viewWeapon.position.y, targetY + Math.abs(Math.cos(this.viewTime)) * 0.012 * bob - recoil * 0.12, blend);
    this.viewWeapon.position.z = THREE.MathUtils.lerp(this.viewWeapon.position.z, launcher ? -1.2 : this.ads ? -0.83 : -0.98, blend);
    this.viewWeapon.rotation.x = THREE.MathUtils.lerp(this.viewWeapon.rotation.x, recoil * 0.24, blend);
    const fov = this.ads ? 52 : 68;
    if (Math.abs(this.perspectiveCamera.fov - fov) > 0.05) {
      this.perspectiveCamera.fov = THREE.MathUtils.lerp(this.perspectiveCamera.fov, fov, blend);
      this.perspectiveCamera.updateProjectionMatrix();
    }
  }

  resetCamera(heading = 0): void {
    this.yaw = this.mode === 'isometric' ? Math.PI / 4 : heading + Math.PI;
    if (this.mode === 'isometric') this.isometricYaw = this.yaw;
    this.pitch = 0;
    this.zoomHeight = 20.5;
    this.thirdDistance = 7.8;
    this.thirdHeight = 4.15;
    this.perspectiveCamera.fov = 68;
    this.panOffset.set(0, 0, 0);
    this.collisionTime = 0;
    this.updateCameraOffset();
    this.resize();
  }

  forward(): THREE.Vector3 {
    return new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  movementVector(forward: number, right: number): THREE.Vector2 {
    return new THREE.Vector2(-Math.sin(this.yaw) * forward + Math.cos(this.yaw) * right, -Math.cos(this.yaw) * forward - Math.sin(this.yaw) * right);
  }

  private seatFor(vehicle: THREE.Group): { x: number; y: number; z: number } {
    const specs = vehicle.userData.vehicle as { type: string; width: number; length: number };
    if (specs.type === 'scooter') return { x: 0, y: 1.88, z: -0.24 };
    const tall = ['bus', 'truck'].includes(specs.type);
    const boxy = ['van', 'ambulance', 'bus', 'truck'].includes(specs.type);
    return { x: -specs.width * 0.22, y: tall ? 2.25 : boxy ? 1.86 : specs.type === 'jeep' ? 1.75 : 1.54,
      z: specs.type === 'pickup' || specs.type === 'truck' ? specs.length * 0.23 : boxy ? specs.length * 0.18 : specs.length * 0.03 };
  }

  private buildCockpit(vehicle: THREE.Group): THREE.Group {
    const specs = vehicle.userData.vehicle as { type: string; paint: string; width: number; length: number };
    const seat = this.seatFor(vehicle);
    const cockpit = new THREE.Group();
    cockpit.name = 'firstPersonCockpit';
    const dark = new THREE.MeshBasicMaterial({ color: '#27363f' });
    const trim = new THREE.MeshBasicMaterial({ color: '#465b63' });
    const paint = new THREE.MeshBasicMaterial({ color: specs.paint });
    const lamp = new THREE.MeshBasicMaterial({ color: '#9bdacb' });
    const handPaint = new THREE.MeshBasicMaterial({ color: '#e8bd98' });
    const sleevePaint = new THREE.MeshBasicMaterial({ color: '#25b9ac' });
    const add = (parent: THREE.Group, w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material): void => {
      const mesh = voxelShape(w, h, d, mat); mesh.position.set(x, y, z); parent.add(mesh);
    };
    const x = seat.x, y = seat.y, z = seat.z;
    if (specs.type === 'scooter') {
      add(cockpit, 0.88, 0.22, 0.22, 0, y - 0.43, z + 0.65, dark);
      add(cockpit, 0.44, 0.44, 0.66, 0, y - 0.82, z + 0.96, paint);
      add(cockpit, 0.22, 0.22, 0.22, 0, y - 0.37, z + 0.67, lamp);
      for (const side of [-1, 1]) {
        add(cockpit, 0.22, 0.22, 0.22, side * 0.42, y - 0.4, z + 0.43, handPaint);
        add(cockpit, 0.22, 0.44, 0.22, side * 0.43, y - 0.69, z + 0.22, sleevePaint);
      }
    } else {
      add(cockpit, specs.width - 0.22, 0.22, 0.22, 0, y - 0.7, z + 1.95, dark);
      add(cockpit, specs.width - 0.44, 0.11, 0.22, 0, y - 0.59, z + 1.96, paint);
      add(cockpit, specs.width - 0.22, 0.22, 0.88, 0, y - 1.08, z + 2.35, paint);
      add(cockpit, 0.44, 0.22, 0.22, x, y - 0.54, z + 1.79, lamp);
      for (const side of [-1, 1]) {
        add(cockpit, 0.11, 1.1, 0.22, side * (specs.width / 2 - 0.11), y + 0.18, z + 2.0, paint);
        add(cockpit, 0.22, 0.22, 0.66, side * (specs.width / 2 - 0.11), y - 0.85, z + 1.62, trim);
      }
      add(cockpit, specs.width - 0.22, 0.11, 0.22, 0, y + 0.83, z + 2.0, paint);
      const wheel = new THREE.Group(); wheel.name = 'steeringWheel'; wheel.position.set(x, y - 0.45, z + 1.7);
      for (const side of [-1, 1]) {
        add(wheel, 0.11, 0.44, 0.11, side * 0.22, 0, 0, dark);
        add(wheel, 0.22, 0.22, 0.22, side * 0.22, 0.08, -0.11, handPaint);
        add(wheel, 0.22, 0.33, 0.22, side * 0.22, -0.27, -0.22, sleevePaint);
      }
      for (const side of [-1, 1]) add(wheel, 0.44, 0.11, 0.11, 0, side * 0.22, 0, dark);
      add(wheel, 0.22, 0.22, 0.22, 0, 0, 0.08, trim);
      cockpit.add(wheel);
    }
    vehicle.add(cockpit);
    cockpit.visible = false;
    return cockpit;
  }

  private syncCockpit(vehicle: THREE.Group | null, steering: number): void {
    if (this.cockpitVehicle && this.cockpitVehicle !== vehicle) {
      this.cockpitVehicle.children[0].visible = true;
      const old = this.cockpitVehicle.getObjectByName('firstPersonCockpit');
      if (old) old.visible = false;
    }
    this.cockpitVehicle = vehicle;
    if (!vehicle) return;
    const cockpit = (vehicle.getObjectByName('firstPersonCockpit') as THREE.Group | undefined) || this.buildCockpit(vehicle);
    const drivingView = this.mode === 'firstPerson';
    vehicle.children[0].visible = !drivingView;
    cockpit.visible = drivingView;
    const wheel = cockpit.getObjectByName('steeringWheel');
    if (wheel) wheel.rotation.z = -steering * 0.8;
  }

  follow(position: THREE.Vector3, dt: number, vehicleHeading: number | null = null, vehicle: THREE.Group | null = null, steering = 0): void {
    this.syncCockpit(vehicle, steering);
    this.orbitHold = Math.max(0, this.orbitHold - dt);
    if (this.mode !== 'isometric' && vehicleHeading !== null && this.orbitHold === 0) {
      const targetYaw = vehicleHeading + Math.PI;
      this.yaw += Math.atan2(Math.sin(targetYaw - this.yaw), Math.cos(targetYaw - this.yaw)) * Math.min(1, dt * 2.2);
    }
    const focus = new THREE.Vector3(position.x, position.y, position.z).add(this.mode === 'isometric' ? this.panOffset : new THREE.Vector3());
    this.cameraTarget.lerp(focus, this.mode === 'firstPerson' ? 1 : Math.min(1, dt * (this.mode === 'isometric' ? 2.3 : 7)));
    if (this.mode === 'isometric') {
      this.camera.position.copy(this.cameraTarget).add(this.cameraOffset);
      this.camera.lookAt(this.cameraTarget);
    } else if (this.mode === 'perspective') {
      const forward = this.forward();
      const anchorHeight = vehicle ? Math.max(1.55, this.seatFor(vehicle).y) : 1.4;
      const anchor = this.cameraTarget.clone().add(new THREE.Vector3(0, anchorHeight, 0));
      const distance = vehicle ? Math.max(this.thirdDistance, (vehicle.userData.vehicle as { length: number }).length * 1.18) : this.thirdDistance;
      const desired = anchor.clone().addScaledVector(forward, -distance).add(new THREE.Vector3(0, this.thirdHeight + (vehicle ? 1.7 : 0), 0));
      this.collisionTime -= dt;
      if (this.collisionTime <= 0) {
        this.collisionDistance = this.collisionProbe?.(anchor, desired) ?? null;
        this.collisionTime = 0.09;
      }
      if (this.collisionDistance !== null) {
        const ray = desired.clone().sub(anchor);
        const safeDistance = Math.max(0.12, Math.min(ray.length(), this.collisionDistance - 0.3));
        desired.copy(anchor).addScaledVector(ray.normalize(), safeDistance);
      }
      this.camera.position.copy(desired);
      this.camera.lookAt(anchor.addScaledVector(forward, vehicle ? 3 : 6));
    } else {
      const forward = this.forward();
      // Human eye height matches the compact body proportions; 2.24 placed the
      // camera inside nearby voxel heads and made them fill the whole screen.
      const eye = this.cameraTarget.clone().add(new THREE.Vector3(0, vehicle ? this.seatFor(vehicle).y : 1.78, 0));
      if (vehicle) {
        const seat = this.seatFor(vehicle);
        eye.x += Math.cos(vehicle.rotation.y) * seat.x + Math.sin(vehicle.rotation.y) * seat.z;
        eye.z += -Math.sin(vehicle.rotation.y) * seat.x + Math.cos(vehicle.rotation.y) * seat.z;
      }
      const direction = forward.multiplyScalar(Math.cos(this.pitch)).add(new THREE.Vector3(0, Math.sin(this.pitch), 0));
      this.camera.position.copy(eye);
      this.camera.lookAt(eye.add(direction));
    }
    this.sun.target.position.copy(this.cameraTarget);
    this.sun.position.copy(this.cameraTarget).add(this.sunOffset);
    this.atmosphere.update(dt, this.cameraTarget, this.mode);
  }

  groundPoint(clientX: number, clientY: number): THREE.Vector3 | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(pointer, this.camera);
    const point = new THREE.Vector3();
    if(this.groundProbe) {
      const ray=this.raycaster.ray;
      for(let distance=1;distance<=220;distance+=2.2) {
        ray.at(distance,point);
        if(point.y>this.groundProbe(point.x,point.z,point.y))continue;
        let lo=Math.max(0,distance-2.2),hi=distance;
        for(let i=0;i<9;i++) {
          const mid=(lo+hi)/2;ray.at(mid,point);
          if(point.y>this.groundProbe(point.x,point.z,point.y))lo=mid;else hi=mid;
        }
        return ray.at((lo+hi)/2,point);
      }
      return this.mode==='isometric'?null:ray.at(28,point);
    }
    return this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), point) ||
      (this.mode === 'isometric' ? null : this.raycaster.ray.at(28, point));
  }

  setWireframe(enabled: boolean): void {
    if (enabled === this.wireframeEnabled) return;
    this.wireframeEnabled = enabled;
    // Keep the override on the beauty render pass. SSAOPass temporarily sets
    // scene.overrideMaterial and clears it to null after drawing its depth
    // buffers, which otherwise makes a scene-wide wireframe last one frame.
    this.renderPass.overrideMaterial = enabled ? this.wireframeMaterial : null;
  }

  get isWireframe(): boolean { return this.wireframeEnabled; }

  render(): void { this.composer.render(); }
  dispose(): void {
    this.atmosphere.dispose();
    this.viewCloth.dispose(); this.viewSkin.dispose(); this.wireframeMaterial.dispose();
    this.composer.dispose(); this.renderer.dispose();
  }
}
