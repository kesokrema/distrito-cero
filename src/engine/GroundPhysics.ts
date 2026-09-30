import * as THREE from 'three';
/** Small fixed-step contact solver for controller feet and four-wheel chassis.
 * Contacts sample the same surfaces used to construct the rendered terrain. */
export class GroundPhysics {
  private velocityY=0;
  grounded=false;
  reset():void {this.velocityY=0;this.grounded=false;}
  jump(speed:number):boolean {
    if(!this.grounded)return false;
    this.velocityY=speed;
    this.grounded=false;
    return true;
  }
  get verticalSpeed():number {return this.velocityY;}
  step(y:number,floor:number,dt:number):number {
    const steps=Math.max(1,Math.ceil(Math.min(dt,.1)*120)),h=Math.min(dt,.1)/steps;
    for(let i=0;i<steps;i++) {
      this.velocityY-=19*h;
      y+=this.velocityY*h;
      if(y<=floor){y=floor;this.velocityY=Math.max(0,this.velocityY);this.grounded=true;}
      else this.grounded=false;
    }
    return y;
  }
}
interface SuspensionState {vy:number;pitchVelocity:number;rollVelocity:number;initialized:boolean}
const suspension=new WeakMap<THREE.Object3D,SuspensionState>();
/** Four contact points drive damped spring forces and chassis pitch/roll.
 * Springs have no force when a wheel loses contact; gravity continues. */
export function stepVehicleSuspension(car:THREE.Group,dt:number,height:(x:number,z:number)=>number):void {
  let state=suspension.get(car);if(!state){state={vy:0,pitchVelocity:0,rollVelocity:0,initialized:false};suspension.set(car,state);}
  const specs=car.userData.vehicle as {width:number;length:number;wheelbase?:number};if(!specs)return;
  const halfTrack=specs.width*.36,halfWheelbase=(specs.wheelbase??specs.length*.65)/2;
  const sin=Math.sin(car.rotation.y),cos=Math.cos(car.rotation.y);
  const contacts=[[-1,-1],[1,-1],[-1,1],[1,1]].map(([side,end])=>({
    side,end,floor:height(car.position.x+side*halfTrack*cos+end*halfWheelbase*sin,car.position.z-side*halfTrack*sin+end*halfWheelbase*cos)}));
  if(!state.initialized){car.position.y=contacts.reduce((a,b)=>a+b.floor,0)/4;state.initialized=true;}
  const steps=Math.max(1,Math.ceil(Math.min(dt,.1)*120)),h=Math.min(dt,.1)/steps;
  for(let i=0;i<steps;i++) {
    let acceleration=-9.81,pitchTorque=0,rollTorque=0;
    for(const contact of contacts) {
      const localY=contact.side*halfTrack*Math.sin(car.rotation.z)-contact.end*halfWheelbase*Math.sin(car.rotation.x);
      const compression=contact.floor-car.position.y-localY+.09;
      if(compression<-.25)continue;
      const speed=state.vy+contact.side*halfTrack*state.rollVelocity-contact.end*halfWheelbase*state.pitchVelocity;
      const force=Math.max(0,compression*110-speed*12);
      acceleration+=force/4;pitchTorque-=contact.end*force/(8*halfWheelbase);rollTorque+=contact.side*force/(8*halfTrack);
    }
    state.vy+=acceleration*h;car.position.y+=state.vy*h;
    state.pitchVelocity+=(pitchTorque-state.pitchVelocity*5)*h;
    state.rollVelocity+=(rollTorque-state.rollVelocity*5)*h;
    car.rotation.x=THREE.MathUtils.clamp(car.rotation.x+state.pitchVelocity*h,-.4,.4);
    car.rotation.z=THREE.MathUtils.clamp(car.rotation.z+state.rollVelocity*h,-.32,.32);
    const ground=Math.min(...contacts.map(c=>c.floor))-.12;
    if(car.position.y<ground){car.position.y=ground;state.vy=Math.max(0,state.vy);}
  }
}
