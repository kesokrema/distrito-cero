import { GroundPhysics } from '../engine/GroundPhysics';
import * as THREE from 'three';
import { GridSystem } from '../world/GridSystem';
import type { Weapon } from './InventorySystem';
import { createHumanoid, type JointArm, type JointLeg } from './HumanoidModel';
import { createWeaponModel } from './WeaponModel';
import { FLOOR_HEIGHT } from '../world/VoxelConstants';
import { CANAL_BED_Y, CANAL_SURFACE_Y } from '../world/CanalWater';

export class LocomotionIK {
  readonly group = new THREE.Group();
  readonly velocity = new THREE.Vector3();
  private bodyRig = new THREE.Group();
  private torso = new THREE.Group();
  private head = new THREE.Group();
  private arms: [JointArm, JointArm];
  private legs: [JointLeg, JointLeg];
  private weaponMount = new THREE.Group();
  private raycaster = new THREE.Raycaster();
  private feetHeight = [0, 0];
  private time = 0;
  private vaultTime = 0;
  private jumpCooldown = 0;
  private aimTimer = 0;
  private aimHeading = 0;
  private aimPitch = 0;
  private fireRecoil = 0;
  private meleeTime = 0;
  private reloadTime = 0;
  private useTime = 0;
  private actorCollision: ((x: number, z: number) => boolean) | null = null;
  private surfaceHeight = 0;
  private readonly contactPhysics = new GroundPhysics();
  private readonly waterCurrent = new THREE.Vector3();
  floorLevel = 0;
  health = 100;
  stamina = 100;

  constructor(private grid: GridSystem, scene: THREE.Scene, private interiorWalkable?: (x: number, z: number) => boolean,
    private stairSurface?: (x: number, z: number, currentY: number) => { height: number; room: { x0: number; x1: number; z0: number; z1: number } } | null,
    private interiorObstacleAt?: (x: number, z: number, feetY: number) => boolean,
    private upperFloorPresent?: (x: number, z: number, level: number) => boolean,
    private floorHeightAt?: (x:number,z:number,level:number)=>number) {
    const model = createHumanoid({ shirt: '#25b9ac', accent: '#126f77', pants: '#344f5e', shoes: '#1c3038', skin: '#e8bd98', hair: '#263540', style: 1 });
    this.bodyRig = model.body;
    this.torso = model.torso;
    this.head = model.head;
    this.arms = model.arms;
    this.legs = model.legs;
    this.weaponMount = model.weaponMount;
    // The visible third-person gun uses the torso frame. A wrist-mounted
    // barrel inherits the arm's pitch and points skyward while aiming.
    this.weaponMount.removeFromParent();
    this.torso.add(this.weaponMount);
    this.weaponMount.position.set(0.42, -0.18, 0.52);
    this.group.add(model.root);
    scene.add(this.group);
    this.setWeapon('pistol');
  }

  setWeapon(weapon: Weapon): void {
    this.weaponMount.clear();
    this.weaponMount.position.x = weapon === 'rifle' || weapon === 'shotgun' ? 0.32 : 0.42;
    if (weapon !== 'fists') this.weaponMount.add(createWeaponModel(weapon));
  }

  setActorCollision(test: (x: number, z: number) => boolean): void { this.actorCollision = test; }

  setFirstPerson(enabled: boolean): void {
    this.bodyRig.visible = !enabled;
  }

  aimAt(target: THREE.Vector3): void {
    this.aimHeading = Math.atan2(target.x - this.group.position.x, target.z - this.group.position.z);
    const horizontal = Math.hypot(target.x - this.group.position.x, target.z - this.group.position.z);
    this.aimPitch = THREE.MathUtils.clamp(Math.atan2(target.y - this.group.position.y - 1.48, Math.max(0.5, horizontal)), -0.32, 0.42);
    this.aimTimer = 0.42;
  }

  animateFire(): void { this.fireRecoil = 0.25; }
  animateMelee(): void { this.meleeTime = 0.42; }
  animateReload(duration: number): void { this.reloadTime = duration; }
  animateUseItem(): void { this.useTime = 0.55; }
  jump(): boolean {
    if (this.jumpCooldown > 0 || this.stamina < 12 || !this.contactPhysics.jump(8.2)) return false;
    this.jumpCooldown = 0.24;
    this.stamina -= 12;
    return true;
  }
  get recoil(): number { return this.fireRecoil / 0.25; }

  setFloor(level: number, _room: { x0: number; x1: number; z0: number; z1: number } | null): void {
    this.floorLevel = level;
    this.group.position.y = this.floorHeightAt?.(this.group.position.x,this.group.position.z,level) ?? this.grid.terrain.height(this.group.position.x,this.group.position.z)+level * FLOOR_HEIGHT;
    this.surfaceHeight = this.group.position.y;
    this.contactPhysics.reset();
    this.velocity.set(0, 0, 0);
  }

  private supportAt(x:number,z:number) {
    const feet=this.group.position.y,base=this.grid.terrain.height(x,z);
    const stair=this.stairSurface?.(x,z,feet);
    if(stair&&Math.abs(stair.height-feet)<=.52)
      return {height:stair.height,level:Math.max(0,Math.round((stair.height-base)/FLOOR_HEIGHT)),stair:true,deck:true};
    const outdoor=this.grid.surfaces.reachable(x,z,feet,.52);
    if(outdoor)return {height:outdoor.height,level:0,stair:false,deck:true};
    // Resolve the actual surviving floor under the feet, including roofs reached
    // from another building. An old room rectangle cannot fence off a new roof.
    for(let level=Math.max(0,Math.floor((feet-base+.52)/FLOOR_HEIGHT));level>0;level--) {
      if(!this.upperFloorPresent?.(x,z,level))continue;
      const height=this.floorHeightAt?.(x,z,level)??base+level*FLOOR_HEIGHT;
      if(height<=feet+.52)return {height,level,stair:false,deck:true};
    }
    const ground=this.grid.water.at(x,z)&&feet<CANAL_SURFACE_Y+1.2?CANAL_BED_Y:this.grid.groundHeight(x,z);
    return {height:this.grid.surfaces.below(x,z,feet,ground),level:0,stair:false,deck:false};
  }

  private canWalk(x: number, z: number): boolean {
    const support=this.supportAt(x,z);
    if(support.height-this.group.position.y>.52)return false;
    if(this.interiorObstacleAt?.(x,z,Math.max(this.group.position.y,support.height))||this.actorCollision?.(x,z))return false;
    // Leaving a roof or bridge is a fall, even when the cell below is water
    // or an otherwise unwalkable parcel. Obstacles still stop the body.
    return support.deck || this.grid.walkable(x,z) || this.grid.water.at(x,z) || this.interiorWalkable?.(x,z)===true ||
      support.height < this.group.position.y-.52;
  }

  update(dt: number, input: THREE.Vector2, colliders: THREE.Object3D[], sprint: boolean): void {
    this.time += dt;
    this.aimTimer = Math.max(0, this.aimTimer - dt);
    this.fireRecoil = Math.max(0, this.fireRecoil - dt * 3.6);
    this.meleeTime = Math.max(0, this.meleeTime - dt);
    this.reloadTime = Math.max(0, this.reloadTime - dt);
    this.useTime = Math.max(0, this.useTime - dt);
    this.jumpCooldown = Math.max(0, this.jumpCooldown - dt);
    const wantsSprint = sprint && input.lengthSq() > 0 && this.stamina > 2;
    this.stamina = THREE.MathUtils.clamp(this.stamina + dt * (wantsSprint ? -19 : 13), 0, 100);
    const desired = new THREE.Vector3(input.x, 0, input.y);
    if (desired.lengthSq() > 1) desired.normalize();
    desired.multiplyScalar(wantsSprint ? 11.5 : 7.8);
    if(this.grid.water.currentAt(this.group.position.x,this.group.position.y,this.group.position.z,this.waterCurrent)) {
      desired.x=desired.x*.42+this.waterCurrent.x;
      desired.z=desired.z*.42+this.waterCurrent.z;
    }
    this.velocity.lerp(desired, Math.min(1, dt * (desired.lengthSq() > 0 ? 7.3 : 4.5)));
    if (this.velocity.lengthSq() < 0.005) this.velocity.set(0, 0, 0);
    // Sweep in short segments so low frame rates cannot skip a thin wall or
    // several stair risers. Vertical contact advances with each movement step.
    const steps=Math.max(1,Math.ceil(this.velocity.length()*Math.min(dt,.1)/.12));
    const stepDt=Math.min(dt,.1)/steps;
    let stair=false;
    for(let i=0;i<steps;i++) {
      const nextX=this.group.position.x+this.velocity.x*stepDt;
      if(this.canWalk(nextX,this.group.position.z))this.group.position.x=nextX;
      else this.velocity.x*=.22;
      const nextZ=this.group.position.z+this.velocity.z*stepDt;
      if(this.canWalk(this.group.position.x,nextZ))this.group.position.z=nextZ;
      else this.velocity.z*=.22;
      const support=this.supportAt(this.group.position.x,this.group.position.z);
      stair=support.stair;this.surfaceHeight=support.height;this.floorLevel=support.level;
      this.group.position.y=this.contactPhysics.step(this.group.position.y,this.surfaceHeight,stepDt);
    }
    if (this.velocity.lengthSq() > 0.12 || this.aimTimer > 0) {
      const heading = this.aimTimer > 0 ? this.aimHeading : Math.atan2(this.velocity.x, this.velocity.z);
      const delta = Math.atan2(Math.sin(heading - this.group.rotation.y), Math.cos(heading - this.group.rotation.y));
      this.group.rotation.y += delta * Math.min(1, dt * (this.aimTimer > 0 ? 13 : 9));
      this.torso.rotation.z = THREE.MathUtils.lerp(this.torso.rotation.z, -delta * 0.13, dt * 7);
    } else this.torso.rotation.z *= Math.max(0, 1 - dt * 7);
    const speed = Math.min(1, this.velocity.length() / 8);
    const phase = this.time * (wantsSprint ? 15 : 10.5);
    const stride = Math.sin(phase) * speed;
    this.legs[0].hip.rotation.x = stride * 0.58;
    this.legs[1].hip.rotation.x = -stride * 0.58;
    this.legs[0].knee.rotation.x = Math.max(0, -stride) * 0.78;
    this.legs[1].knee.rotation.x = Math.max(0, stride) * 0.78;
    this.legs[0].foot.rotation.x = -this.legs[0].knee.rotation.x * 0.45;
    this.legs[1].foot.rotation.x = -this.legs[1].knee.rotation.x * 0.45;
    const aiming = this.aimTimer > 0;
    this.arms[0].shoulder.rotation.x = THREE.MathUtils.lerp(this.arms[0].shoulder.rotation.x, aiming ? -1.06 : -stride * 0.4, Math.min(1, dt * 12));
    this.arms[1].shoulder.rotation.x = THREE.MathUtils.lerp(this.arms[1].shoulder.rotation.x, aiming ? -1.25 + this.fireRecoil * 0.8 : stride * 0.4, Math.min(1, dt * 12));
    this.arms[0].elbow.rotation.x = aiming ? -0.45 : 0.12;
    this.arms[1].elbow.rotation.x = aiming ? -0.24 : 0.12;
    if (this.meleeTime > 0) this.arms[1].shoulder.rotation.x = -1.1 + Math.sin((1 - this.meleeTime / 0.42) * Math.PI * 2) * 1.1;
    if (this.reloadTime > 0 || this.useTime > 0) {
      this.arms[0].shoulder.rotation.x = -0.85;
      this.arms[1].shoulder.rotation.x = -0.75;
      this.arms[0].elbow.rotation.x = -0.85;
      this.arms[1].elbow.rotation.x = -0.8;
    }
    this.torso.rotation.x = THREE.MathUtils.lerp(this.torso.rotation.x, wantsSprint ? 0.16 : aiming ? -0.08 : 0, dt * 7);
    this.weaponMount.rotation.x = THREE.MathUtils.lerp(this.weaponMount.rotation.x,
      (aiming ? -this.aimPitch : 0.18) - this.torso.rotation.x, Math.min(1, dt * 14));
    this.weaponMount.position.z = 0.52 - this.fireRecoil * 0.22;
    this.head.rotation.y = THREE.MathUtils.lerp(this.head.rotation.y, aiming ? Math.sin(this.time * 2) * 0.06 : 0, dt * 5);
    this.vaultTime = Math.max(0, this.vaultTime - dt);
    const vault = this.vaultTime > 0 ? Math.sin((1 - this.vaultTime / 0.34) * Math.PI) * 0.72 : 0;
    const airborne = !this.contactPhysics.grounded;
    this.bodyRig.rotation.x = 0;
    this.bodyRig.position.y = vault + (airborne ? 0 : Math.abs(stride) * .04);
    if (airborne) {
      const rising = this.contactPhysics.verticalSpeed > 0;
      for (const leg of this.legs) {
        leg.hip.rotation.x = rising ? -0.38 : 0.17;
        leg.knee.rotation.x = rising ? 0.88 : 0.35;
        leg.foot.rotation.x = rising ? -0.32 : -0.1;
      }
      this.arms[0].shoulder.rotation.x = aiming ? this.arms[0].shoulder.rotation.x : -0.42;
      this.arms[1].shoulder.rotation.x = aiming ? this.arms[1].shoulder.rotation.x : -0.42;
    } else if (this.floorLevel === 0 && !stair) this.footAdapt(colliders);
  }

  private footAdapt(colliders: THREE.Object3D[]): void {
    this.group.updateMatrixWorld(true);
    for (const [index, leg] of this.legs.entries()) {
      if (!colliders.length) { leg.foot.position.y = THREE.MathUtils.lerp(leg.foot.position.y, -0.44, 0.15); continue; }
      const side = index === 0 ? -0.26 : 0.26;
      const origin = new THREE.Vector3(side, 2.8, 0.18).applyMatrix4(this.group.matrixWorld);
      this.raycaster.set(origin, new THREE.Vector3(0, -1, 0));
      this.raycaster.far = 3.2;
      const hits = this.raycaster.intersectObjects(colliders, false);
      const target = hits.length ? THREE.MathUtils.clamp(hits[0].point.y-this.group.position.y,-.4,.6) : 0;
      this.feetHeight[index] = THREE.MathUtils.lerp(this.feetHeight[index], target, 0.17);
      leg.foot.position.y = -0.44 + this.feetHeight[index] * 0.35;
      leg.knee.rotation.x += this.feetHeight[index] * 0.15;
    }
  }
}
