import { stepVehicleSuspension } from '../engine/GroundPhysics';
import * as THREE from 'three';
import { EventBus } from '../core/EventBus';
import { GridSystem } from '../world/GridSystem';
import { PrefabManager } from '../world/PrefabManager';
import { LocomotionIK } from './LocomotionIK';
import { NPCController } from './NPCController';
import { SpatialHash } from '../core/SpatialHash';
import { DestructionSystem } from '../world/DestructionSystem';

export type DriveInput = { forward: boolean; reverse: boolean; left: boolean; right: boolean; handbrake: boolean };
type TrafficTurn = { axis: 'x' | 'z'; direction: number; progress: number; radius: number; start: THREE.Vector2; control: THREE.Vector2; end: THREE.Vector2 };
type TrafficState = { axis: 'x' | 'z'; direction: number; speed: number; cruiseSpeed: number; seed: number;
  turn: TrafficTurn | null; panicTime: number; danger: THREE.Vector2 | null; blockedTime: number;
  bypassLane?: number; passingVehicle?: THREE.Group; };
type ImpactMotion = { velocity: THREE.Vector2; parkWhenSettled: boolean };

function overlapsVehicle(a: { x: number; z: number; y:number; yaw: number; length: number; width: number }, b: THREE.Group): boolean {
  const other = b.userData.vehicle as { length: number; width: number } | undefined;
  if (!other || b.userData.destroyed || Math.abs(a.y-b.position.y)>1.8) return false;
  const ax = Math.sin(a.yaw), az = Math.cos(a.yaw), asx = Math.cos(a.yaw), asz = -Math.sin(a.yaw);
  const bx = Math.sin(b.rotation.y), bz = Math.cos(b.rotation.y), bsx = Math.cos(b.rotation.y), bsz = -Math.sin(b.rotation.y);
  const dx = b.position.x - a.x, dz = b.position.z - a.z;
  for (const [x, z] of [[ax, az], [asx, asz], [bx, bz], [bsx, bsz]]) {
    const center = Math.abs(dx * x + dz * z);
    const radiusA = a.length / 2 * Math.abs(ax * x + az * z) + a.width / 2 * Math.abs(asx * x + asz * z);
    const radiusB = other.length / 2 * Math.abs(bx * x + bz * z) + other.width / 2 * Math.abs(bsx * x + bsz * z);
    if (center >= radiusA + radiusB - 0.08) return false;
  }
  return true;
}

export class VehicleSystem {
  private active: THREE.Group | null = null;
  private speed = 0;
  private steering = 0;
  private crashCooldown = 0;
  private elapsed = 0;
  private lastHit = new Map<number, number>();
  private traffic = new Map<THREE.Group, TrafficState>();
  private impactMotion = new Map<THREE.Group, ImpactMotion>();
  private knownVehicleCount = 0;
  private trafficAlertCooldown = 0;
  private playerImpactCooldown = 0;
  private readonly vehicleSpatial = new SpatialHash<THREE.Group>(7, (vehicle) => vehicle.position);
  private streetActivity = 1;

  setStreetActivity(activity: number): void { this.streetActivity = THREE.MathUtils.clamp(activity, 0.2, 1); }

  constructor(private prefabs: PrefabManager, private grid: GridSystem, private events: EventBus, private npcs: NPCController,
    private destruction: DestructionSystem) {
    events.on('gunshot', ({ x, z, radius }) => this.alarmTraffic(x, z, radius));
    events.on('enemyShot', ({ fromX, fromZ }) => this.alarmTraffic(fromX, fromZ, 22));
    events.on('blast', ({ x, z, radius }) => this.alarmTraffic(x, z, radius * 2));
  }

  private alarmTraffic(x: number, z: number, radius: number): void {
    this.registerTraffic();
    for (const [car, state] of this.traffic) {
      if (car.userData.destroyed || Math.hypot(car.position.x - x, car.position.z - z) > radius) continue;
      state.panicTime = Math.max(state.panicTime, 8 + this.grid.hash(Math.round(x), Math.round(z), state.seed) * 5);
      state.danger ||= new THREE.Vector2();
      state.danger.set(x, z);
    }
  }

  get isDriving(): boolean { return this.active !== null; }
  get heading(): number | null { return this.active?.rotation.y ?? null; }
  get cameraVehicle(): THREE.Group | null { return this.active; }
  get steeringAngle(): number { return this.steering; }
  get speedKmh(): number { return Math.round(Math.abs(this.speed) * 6); }

  updateTraffic(dt: number, player: LocomotionIK): void {
    this.trafficAlertCooldown = Math.max(0, this.trafficAlertCooldown - dt);
    this.playerImpactCooldown = Math.max(0, this.playerImpactCooldown - dt);
    this.registerTraffic();
    for (const [car, state] of this.traffic) {
      const far = car.position.distanceToSquared(player.group.position) > 24 * 24;
      const [gx, gz] = this.grid.grid(car.position.x, car.position.z);
      const presence = this.grid.hash(gx, gz, state.seed + 902);
      car.userData.offDutyTraffic = presence > this.streetActivity && far && state.panicTime <= 0 && car !== this.active;
    }
    this.vehicleSpatial.rebuild(this.prefabs.vehicles.filter((vehicle) => !vehicle.userData.destroyed && !vehicle.userData.offDutyTraffic &&
      (vehicle === this.active || this.prefabs.isWorldActive(vehicle.position.x, vehicle.position.z))));
    this.advanceImpacts(dt, player.group.position);
    for (const vehicle of this.prefabs.vehicles) if (!vehicle.userData.destroyed) this.prefabs.setVehicleRendered(vehicle,
      vehicle === this.active || !vehicle.userData.offDutyTraffic && this.prefabs.isWorldActive(vehicle.position.x, vehicle.position.z));
    for (const [car, state] of this.traffic) {
      if (car.userData.destroyed) { this.traffic.delete(car); continue; }
      if (car === this.active || car.userData.offDutyTraffic || this.impactMotion.has(car) || !this.prefabs.isWorldActive(car.position.x, car.position.z)) continue;
      stepVehicleSuspension(car,dt,(x,z)=>this.grid.groundHeight(x,z));
      state.panicTime = Math.max(0, state.panicTime - dt);
      const specs = car.userData.vehicle as { maxSpeed: number };
      const fleeingSpeed = Math.min(specs.maxSpeed * 0.85, state.cruiseSpeed * 1.85);
      state.speed = THREE.MathUtils.lerp(state.speed, state.blockedTime > 0 && state.bypassLane===undefined ? 0 : state.panicTime > 0 ? fleeingSpeed : state.cruiseSpeed,
        Math.min(1, dt * (state.blockedTime > 0 && state.bypassLane===undefined ? 6 : state.panicTime > 0 ? 3 : 1.2)));
      if (!state.turn) state.turn = this.planTurn(car, state, dt);
      if (state.turn) {
        const turn = state.turn;
        const progress = Math.min(1, turn.progress + state.speed * dt / (turn.radius * 1.62));
        const inverse = 1 - progress;
        const x = inverse * inverse * turn.start.x + 2 * inverse * progress * turn.control.x + progress * progress * turn.end.x;
        const z = inverse * inverse * turn.start.y + 2 * inverse * progress * turn.control.y + progress * progress * turn.end.y;
        const cell = this.grid.cellAtWorld(x, z);
        const specs = car.userData.vehicle as { width: number; length: number };
        const dx = 2 * inverse * (turn.control.x - turn.start.x) + 2 * progress * (turn.end.x - turn.control.x);
        const dz = 2 * inverse * (turn.control.y - turn.start.y) + 2 * progress * (turn.end.y - turn.control.y);
        const yaw = Math.atan2(dx, dz);
        const blocked = !cell?.active || cell.tile !== 'road' || cell.rubble || !this.vehicleFits(car, x, z, yaw) || this.vehicleSpatial.nearby(x, z, 6).some((other) =>
          other !== car && overlapsVehicle({ x, z, y:car.position.y, yaw, length: specs.length, width: specs.width }, other));
        if (blocked) {
          state.blockedTime += dt;
          // Yield on the same arc. Reversing the lane direction here caused
          // an impossible U-turn followed by cars driving against traffic.
          continue;
        }
        state.blockedTime = 0;
        car.position.set(x, car.position.y, z);
        turn.progress = progress;
        car.rotation.y = Math.atan2(dx, dz);
        this.vehicleSpatial.update(car);
        this.hitPedestrians(car, player.group.position);
        if (progress === 1) { state.axis = turn.axis; state.direction = turn.direction; state.turn = null; }
        continue;
      }
      const step = state.speed * state.direction * dt;
      const nextX = car.position.x + (state.axis === 'x' ? step : 0);
      const nextZ = car.position.z + (state.axis === 'z' ? step : 0);
      const nextCell = this.grid.cellAtWorld(nextX, nextZ);
      const carSpecs = car.userData.vehicle as { length: number; width: number };
      const target = state.axis === 'x' ? state.direction * Math.PI / 2 : state.direction > 0 ? 0 : Math.PI;
      const roadIndex=this.grid.grid(car.position.x,car.position.z)[state.axis==='x'?1:0];
      const originalLane=this.grid.roadLane(state.axis,roadIndex,state.direction);
      const cross=state.axis==='x'?car.position.z:car.position.x;
      if(state.bypassLane!==undefined&&state.passingVehicle){
        const forward=state.axis==='x'?state.direction*(state.passingVehicle.position.x-car.position.x):state.direction*(state.passingVehicle.position.z-car.position.z);
        const otherSpecs=state.passingVehicle.userData.vehicle as {length:number};
        const ownSpecs=car.userData.vehicle as {length:number};
        if(state.passingVehicle.userData.destroyed||forward<-(ownSpecs.length+otherSpecs.length)/2-2){state.bypassLane=originalLane;state.passingVehicle=undefined;}
      } else if(state.bypassLane!==undefined){
        if(Math.abs(cross-originalLane)<.12)state.bypassLane=undefined;
      }
      const targetLane=state.bypassLane??originalLane;
      if(state.bypassLane===undefined&&!state.turn){
        const blocker=this.vehicleSpatial.nearby(car.position.x,car.position.z,25).find(other=>{
          if(other===car||other.userData.destroyed||Math.abs(other.position.y-car.position.y)>1.4)return false;
          const otherSpecs=other.userData.vehicle as {length:number;width:number}|undefined;if(!otherSpecs)return false;
          const fx=state.axis==='x'?state.direction:0,fz=state.axis==='z'?state.direction:0;
          const ahead=(other.position.x-car.position.x)*fx+(other.position.z-car.position.z)*fz;
          const across=state.axis==='x'?Math.abs(other.position.z-originalLane):Math.abs(other.position.x-originalLane);
          const gap=ahead-(carSpecs.length+otherSpecs.length)/2;
          if(gap<0||gap>18||across>(carSpecs.width+otherSpecs.width)/2+.45)return false;
          const lead=other.userData.autonomous===true?this.traffic.get(other):undefined;
          return other.userData.autonomous!==true||Boolean(lead&&lead.speed<.8&&lead.blockedTime>.6);
        });
        if(blocker){
          const adjacent=this.grid.roadLane(state.axis,roadIndex,-state.direction),offset=adjacent-originalLane;
          const clear=Array.from({length:5},(_,i)=>(i+1)/5).every(t=>{
            const x=state.axis==='x'?car.position.x:car.position.x+offset*t;
            const z=state.axis==='x'?car.position.z+offset*t:car.position.z;
            for(const lead of [0,6,12,18]){
              const px=x+(state.axis==='x'?state.direction*lead:0),pz=z+(state.axis==='z'?state.direction*lead:0);
              const cell=this.grid.cellAtWorld(px,pz);
              if(!cell?.active||cell.tile!=='road'||cell.rubble||!this.vehicleFits(car,px,pz,target))return false;
              if(this.vehicleSpatial.nearby(px,pz,12).some(other=>other!==car&&
                overlapsVehicle({x:px,z:pz,y:car.position.y,yaw:target,length:carSpecs.length,width:carSpecs.width},other)))return false;
            }
            return true;
          });
          if(clear){state.bypassLane=adjacent;state.passingVehicle=blocker;state.blockedTime=0;}
        }
      }
      const crossStep=THREE.MathUtils.clamp(targetLane-cross,-Math.max(.1,dt*4),Math.max(.1,dt*4));
      const laneX=state.axis==='z'?car.position.x+crossStep:nextX;
      const laneZ=state.axis==='x'?car.position.z+crossStep:nextZ;
      const obstacle = this.vehicleSpatial.nearby(car.position.x, car.position.z, 8).some((other) =>
        other !== car && overlapsVehicle({ x: laneX, z: laneZ, y:car.position.y, yaw: target, length: carSpecs.length, width: carSpecs.width }, other));
      const nextLaneCell=this.grid.cellAtWorld(laneX,laneZ);
      const moved = !!(nextLaneCell?.active && nextLaneCell.tile === 'road' && !nextLaneCell.rubble && this.vehicleFits(car, laneX, laneZ, target) && !obstacle);
      if (moved) {
        car.position.set(laneX, car.position.y, laneZ);
        state.blockedTime = 0;
      } else {
        state.blockedTime += dt;
      }
      const delta = Math.atan2(Math.sin(target - car.rotation.y), Math.cos(target - car.rotation.y));
      car.rotation.y += delta * Math.min(1, dt * 4.5);
      if (moved) this.vehicleSpatial.update(car);
      if (moved) this.hitPedestrians(car, player.group.position);
    }
  }

  private registerTraffic(): void {
    for (let index = this.knownVehicleCount; index < this.prefabs.vehicles.length; index++) {
      const car = this.prefabs.vehicles[index];
      if (car.userData.autonomous !== true) continue;
      const [gx, gz] = this.grid.grid(car.position.x, car.position.z);
      const cruiseSpeed = 3.5 + this.grid.hash(gx, gz, 392) * 2.4;
      this.traffic.set(car, {
        axis: car.userData.trafficAxis as 'x' | 'z', direction: car.userData.trafficDirection as number,
        speed: cruiseSpeed, cruiseSpeed, seed: index + 393, turn: null, panicTime: 0, danger: null, blockedTime: 0
      });
    }
    this.knownVehicleCount = this.prefabs.vehicles.length;
  }

  private hitPedestrians(car: THREE.Group, playerPosition: THREE.Vector3): void {
    const specs = car.userData.vehicle as { length: number; width: number; impact: number };
    const forwardX = Math.sin(car.rotation.y), forwardZ = Math.cos(car.rotation.y);
    const playerReach = Math.hypot(specs.length / 2, specs.width / 2) + 0.5;
    if (this.playerImpactCooldown === 0 && Math.abs(playerPosition.y-car.position.y) < 0.8 && car.position.distanceToSquared(playerPosition) < playerReach ** 2) {
      const dx = playerPosition.x - car.position.x, dz = playerPosition.z - car.position.z;
      const along = dx * forwardX + dz * forwardZ;
      const across = dx * forwardZ - dz * forwardX;
      if (Math.abs(along) < specs.length / 2 + 0.36 && Math.abs(across) < specs.width / 2 + 0.36) {
        this.events.emit('playerRunOver', { dx: forwardX, dz: forwardZ, force: specs.impact });
        this.playerImpactCooldown = 2.5;
      }
    }
    for (const npc of this.npcs.nearby(car.position.x, car.position.z, 5)) {
      if (!npc.alive || npc.knockdownTime > 0 || Math.abs(npc.group.position.y - car.position.y) > 1) continue;
      const dx = npc.group.position.x - car.position.x, dz = npc.group.position.z - car.position.z;
      if (Math.abs(dx) > 4.4 || Math.abs(dz) > 4.4) continue;
      const along = dx * forwardX + dz * forwardZ;
      const across = dx * forwardZ - dz * forwardX;
      if (Math.abs(along) > specs.length / 2 + 0.26 || Math.abs(across) > specs.width / 2 + 0.36) continue;
      this.npcs.hitByVehicle(npc, 0.48 * specs.impact, new THREE.Vector3(forwardX, 0, forwardZ));
      if (car.position.distanceToSquared(playerPosition) < 30 * 30 && this.trafficAlertCooldown === 0) {
        this.events.emit('alert', { text: npc.kind === 'civilian' ? 'ACCIDENTE DE TRÁFICO · PEATONES EN PÁNICO' : 'ENEMIGO ATROPELLADO', tone: 'danger' });
        this.trafficAlertCooldown = 7;
      }
    }
  }

  private pushVehicle(vehicle: THREE.Group, direction: THREE.Vector3, speed: number): void {
    if (vehicle.userData.destroyed || speed < 2.4) return;
    const normal = direction.clone().setY(0).normalize();
    const previous = this.impactMotion.get(vehicle);
    if (!previous) {
      const parkedCells = this.prefabs.setVehicleParked(vehicle, false);
      if (parkedCells.length) this.events.emit('terrainChanged', { cells: parkedCells });
    }
    const impulse = THREE.MathUtils.clamp(speed * 0.48, 1.5, 8);
    const velocity = previous?.velocity || new THREE.Vector2();
    velocity.add(new THREE.Vector2(normal.x, normal.z).multiplyScalar(impulse)).clampLength(0, 9);
    this.impactMotion.set(vehicle, { velocity, parkWhenSettled: previous?.parkWhenSettled ?? vehicle.userData.autonomous !== true });
  }

  private advanceImpacts(dt: number, playerPosition: THREE.Vector3): void {
    for (const [car, motion] of this.impactMotion) {
      if (car.userData.destroyed) { this.impactMotion.delete(car); continue; }
      const x = car.position.x + motion.velocity.x * dt;
      const z = car.position.z + motion.velocity.y * dt;
      const specs = car.userData.vehicle as { length: number; width: number };
      const occupied = this.vehicleSpatial.nearby(x, z, 8).some((other) => other !== car &&
        overlapsVehicle({ x, z, y:car.position.y, yaw: car.rotation.y, length: specs.length, width: specs.width }, other));
      if (!occupied && this.grid.cellAtWorld(x, z)?.tile === 'road' && this.vehicleFits(car, x, z, car.rotation.y)) {
        car.position.set(x, car.position.y, z);
        stepVehicleSuspension(car,dt,(x,z)=>this.grid.groundHeight(x,z));
        this.vehicleSpatial.update(car);
        this.hitPedestrians(car, playerPosition);
      } else motion.velocity.multiplyScalar(0.35);
      motion.velocity.multiplyScalar(Math.exp(-5 * dt));
      if (motion.velocity.length() >= 0.15) continue;
      this.impactMotion.delete(car);
      if (motion.parkWhenSettled) {
        const parkedCells = this.prefabs.setVehicleParked(car, true);
        if (parkedCells.length) this.events.emit('terrainChanged', { cells: parkedCells });
      }
    }
  }

  private planTurn(car: THREE.Group, state: TrafficState, dt: number): TrafficTurn | null {
    const radius = this.grid.cellSize * 0.8;
    const along = state.axis === 'x' ? car.position.x : car.position.z;
    const crossings = state.axis === 'x' ? this.grid.roadX : this.grid.roadZ;
    for (const road of crossings) {
      const center = (road + 1 - this.grid.center) * this.grid.cellSize;
      const approach = (center - along) * state.direction;
      if (approach < radius - 0.06 || approach > radius + state.speed * dt + 0.08) continue;
      const cx = state.axis === 'x' ? center : car.position.x;
      const cz = state.axis === 'z' ? center : car.position.z;
      const [gx, gz] = this.grid.grid(cx, cz);
      const straightX = cx + (state.axis === 'x' ? state.direction * radius * 2.2 : 0);
      const straightZ = cz + (state.axis === 'z' ? state.direction * radius * 2.2 : 0);
      const straight = this.grid.cellAtWorld(straightX, straightZ);
      const blockedAhead = !straight?.active || straight.tile !== 'road' || straight.rubble;
      const direction = this.grid.roadDirection(state.axis === 'x' ? 'z' : 'x', road);
      const end = state.axis === 'x' ?
        new THREE.Vector2(this.grid.roadLane('z', road, direction), cz + direction * radius) :
        new THREE.Vector2(cx + direction * radius, this.grid.roadLane('x', road, direction));
      const panicTurn = state.panicTime > 0 && state.danger &&
        end.distanceTo(state.danger) > Math.hypot(straightX - state.danger.x, straightZ - state.danger.y) + 0.8;
      if (!blockedAhead && state.panicTime > 0 && !panicTurn) continue;
      if (!blockedAhead && state.panicTime === 0 && this.grid.hash(gx, gz, state.seed) > 0.32) continue;
      const endCell = this.grid.cellAtWorld(end.x, end.y);
      if (!endCell?.active || endCell.tile !== 'road' || endCell.rubble) continue;
      return {
        axis: state.axis === 'x' ? 'z' : 'x', direction, progress: 0, radius,
        start: new THREE.Vector2(car.position.x, car.position.z), control: new THREE.Vector2(cx, cz), end
      };
    }
    return null;
  }

  prompt(position: THREE.Vector3): string | null {
    if (this.active) return 'E · SALIR DEL VEHÍCULO';
    return this.nearest(position) ? 'E · ENTRAR EN VEHÍCULO' : null;
  }

  interact(player: LocomotionIK): string | null {
    if (this.active) {
      if (Math.abs(this.speed) > 1.3) return 'DETÉN EL VEHÍCULO PARA SALIR';
      const car = this.active;
      const side = new THREE.Vector3(2.3, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), car.rotation.y);
      const options = [car.position.clone().add(side), car.position.clone().sub(side)];
      const exit = options.find((point) => this.grid.walkable(point.x, point.z));
      if (!exit) return 'NO HAY ESPACIO PARA SALIR';
      player.group.position.copy(exit);
      player.group.visible = true;
      const parkedCells = this.prefabs.setVehicleParked(car, true);
      if (parkedCells.length) this.events.emit('terrainChanged', { cells: parkedCells });
      this.active = null;
      this.speed = 0;
      this.steering = 0;
      return 'SALISTE DEL VEHÍCULO';
    }
    const car = this.nearest(player.group.position);
    if (!car) return null;
    const parkedCells = this.prefabs.setVehicleParked(car, false);
    if (parkedCells.length) this.events.emit('terrainChanged', { cells: parkedCells });
    this.prefabs.releaseVehicle(car);
    this.active = car;
    this.speed = 0;
    this.steering = 0;
    player.group.visible = false;
    stepVehicleSuspension(car,1/60,(x,z)=>this.grid.groundHeight(x,z));
    player.group.position.copy(car.position);
    return 'VEHÍCULO EN MARCHA · WASD CONDUCIR · SPACE FRENAR';
  }

  update(dt: number, input: DriveInput, player: LocomotionIK, screenRight: THREE.Vector2): void {
    const car = this.active;
    if (!car) return;
    if (car.userData.destroyed) {
      stepVehicleSuspension(car,dt,(x,z)=>this.grid.groundHeight(x,z));
    player.group.position.copy(car.position);
      player.group.visible = true;
      this.active = null;
      this.speed = 0;
      this.steering = 0;
      return;
    }
    this.elapsed += dt;
    this.crashCooldown = Math.max(0, this.crashCooldown - dt);
    const specs = car.userData.vehicle as { wheelbase: number; maxSpeed: number; impact: number } | undefined;
    const acceleration = input.forward ? 19 : input.reverse ? -13 : 0;
    this.speed += acceleration * dt;
    this.speed = THREE.MathUtils.clamp(this.speed, -8, specs?.maxSpeed || 17);
    this.speed *= Math.max(0, 1 - dt * (input.handbrake ? 5.2 : input.forward || input.reverse ? 0.4 : 1.45));
    // In a fixed camera, A/D follows the screen direction even when the car
    // points toward the camera. In a chase camera this equals normal steering.
    const carRightX = Math.cos(car.rotation.y), carRightZ = -Math.sin(car.rotation.y);
    const visualSide = carRightX * screenRight.x + carRightZ * screenRight.y;
    const steering = (Number(input.right) - Number(input.left)) * (visualSide < -0.08 ? -1 : 1);
    this.steering = THREE.MathUtils.lerp(this.steering, steering * 0.66, Math.min(1, dt * (steering ? 8 : 5)));
    if (Math.abs(this.speed) > 0.14) {
      const turn = Math.tan(this.steering) * (Math.abs(this.speed) + 2.2) / (specs?.wheelbase || 1.9) * 0.58;
      car.rotation.y += turn * dt * Math.sign(this.speed);
    }
    const nextX = car.position.x + Math.sin(car.rotation.y) * this.speed * dt;
    const nextZ = car.position.z + Math.cos(car.rotation.y) * this.speed * dt;
    const ownSize = car.userData.vehicle as { width: number; length: number };
    const startX = car.position.x, startZ = car.position.z, driveSpeed = this.speed, impactSpeed = Math.abs(driveSpeed);
    const vehicleAhead = this.vehicleSpatial.nearby(nextX, nextZ, 8).find((other) => other !== car &&
      overlapsVehicle({ x: nextX, z: nextZ, y:car.position.y, yaw: car.rotation.y, length: ownSize.length, width: ownSize.width }, other));
    if (this.vehicleFits(car, nextX, nextZ, car.rotation.y) && !vehicleAhead) {
      car.position.set(nextX, car.position.y, nextZ);
      this.vehicleSpatial.update(car);
    }
    else {
      if (vehicleAhead && this.crashCooldown === 0) {
        const towardOther = vehicleAhead.position.clone().sub(car.position).setY(0);
        this.destruction.damageVehicleImpact(car, towardOther, impactSpeed);
        this.destruction.damageVehicleImpact(vehicleAhead, towardOther.clone().negate(), impactSpeed);
        this.pushVehicle(vehicleAhead, towardOther, impactSpeed);
        this.events.emit('alert', { text: 'COLISIÓN ENTRE VEHÍCULOS', tone: 'danger' });
        this.crashCooldown = 1.2;
      }
      if (!vehicleAhead && Math.abs(this.speed) > 2.4 && this.crashCooldown === 0) {
        const impactDirection = new THREE.Vector3(Math.sin(car.rotation.y), 0, Math.cos(car.rotation.y)).multiplyScalar(Math.sign(driveSpeed));
        this.destruction.damageVehicleImpact(car, impactDirection, impactSpeed);
        this.events.emit('alert', { text: 'CHOQUE · CARROCERÍA DAÑADA', tone: 'danger' });
        this.crashCooldown = 1.2;
      }
      this.speed *= -0.08;
    }
    this.hitDrivenPedestrians(car, startX, startZ, driveSpeed, specs?.impact || 1);
    stepVehicleSuspension(car,dt,(x,z)=>this.grid.groundHeight(x,z));
    player.group.position.copy(car.position);
  }

  private hitDrivenPedestrians(car: THREE.Group, startX: number, startZ: number, speed: number, impact: number): void {
    if (Math.abs(speed) <= 2.4) return;
    const { length, width } = car.userData.vehicle as { length: number; width: number };
    const forward = new THREE.Vector3(Math.sin(car.rotation.y), 0, Math.cos(car.rotation.y));
    const direction = forward.clone().multiplyScalar(Math.sign(speed));
    const travel = (car.position.x - startX) * forward.x + (car.position.z - startZ) * forward.z;
    const minAlong = Math.min(0, travel) - length / 2 - 0.28;
    const maxAlong = Math.max(0, travel) + length / 2 + 0.28;
    for (const npc of this.npcs.nearby(startX, startZ, length / 2 + Math.abs(travel) + 1.5)) {
      if (!npc.alive || npc.knockdownTime > 0 || Math.abs(npc.group.position.y - car.position.y) > 1 ||
          this.elapsed < (this.lastHit.get(npc.id) || 0)) continue;
      const dx = npc.group.position.x - startX, dz = npc.group.position.z - startZ;
      const along = dx * forward.x + dz * forward.z;
      const across = Math.abs(dx * forward.z - dz * forward.x);
      if (along < minAlong || along > maxAlong || across > width / 2 + 0.34) continue;
      this.lastHit.set(npc.id, this.elapsed + 1.4);
      this.npcs.hitByVehicle(npc, Math.abs(speed) * 0.19 * impact, direction);
      this.events.emit('alert', { text: npc.kind === 'civilian' ? 'PEATÓN ATROPELLADO · LA ZONA ENTRA EN PÁNICO' : 'ENEMIGO ATROPELLADO', tone: 'danger' });
      this.speed *= 0.75;
    }
  }

  private vehicleFits(car: THREE.Group, x: number, z: number, yaw: number): boolean {
    const specs = car.userData.vehicle as { width: number; length: number };
    const forwardX = Math.sin(yaw), forwardZ = Math.cos(yaw);
    const sideX = Math.cos(yaw), sideZ = -Math.sin(yaw);
    const halfLength = Math.max(0.3, specs.length / 2 - 0.18);
    const halfWidth = Math.max(0.25, specs.width / 2 - 0.14);
    const samples: Array<[number, number]> = [[0, 0]];
    for (const along of [-halfLength, halfLength]) for (const across of [-halfWidth, halfWidth]) samples.push([along, across]);
    for (const along of [-halfLength, halfLength]) samples.push([along, 0]);
    for (const across of [-halfWidth, halfWidth]) samples.push([0, across]);
    const centerHeight=this.grid.groundHeight(x,z);
    const clearCells = samples.every(([along, across]) => {
      const wx=x + forwardX * along + sideX * across,wz=z + forwardZ * along + sideZ * across;
      if(Math.abs(this.grid.groundHeight(wx,wz)-centerHeight)>.7+Math.abs(along)*.35)return false;
      const cell = this.grid.cellAtWorld(wx,wz);
      // Parked cars have precise oriented collision boxes. Their coarse grid
      // reservation must not block the adjacent open driving lane.
      return !!cell?.active && !cell.rubble && (!cell.blocked || cell.tile === 'road');
    });
    if (!clearCells) return false;
    const prefabSpace = this.prefabs.vehicleSpaceClear;
    return typeof prefabSpace !== 'function' || prefabSpace.call(this.prefabs, x, z, yaw, specs.length, specs.width, centerHeight);
  }

  private nearest(position: THREE.Vector3): THREE.Group | null {
    if (position.y > this.grid.groundHeight(position.x,position.z)+0.8) return null;
    let best: THREE.Group | null = null;
    let distance = Infinity;
    for (const vehicle of this.vehicleSpatial.nearby(position.x, position.z, 7)) {
      if (vehicle.userData.autonomous === true) continue;
      const specs = vehicle.userData.vehicle as { length: number; width: number };
      const dx = position.x - vehicle.position.x, dz = position.z - vehicle.position.z;
      const along = Math.abs(dx * Math.sin(vehicle.rotation.y) + dz * Math.cos(vehicle.rotation.y));
      const across = Math.abs(dx * Math.cos(vehicle.rotation.y) - dz * Math.sin(vehicle.rotation.y));
      const edgeDistance = Math.hypot(Math.max(0, along - specs.length / 2), Math.max(0, across - specs.width / 2));
      if (edgeDistance < 1.35 && edgeDistance < distance) { distance = edgeDistance; best = vehicle; }
    }
    return best;
  }
}
