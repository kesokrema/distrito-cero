import * as THREE from 'three';

export type JointMotion = { source: string; duration: number; fps: number; frames: number[][] };
const NAMES = ['Hips', 'Spine', 'Spine2', 'Head', 'LeftArm', 'LeftForeArm', 'LeftHand',
  'RightArm', 'RightForeArm', 'RightHand', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot'];
const PARENTS = [-1, 0, 1, 2, 2, 4, 5, 2, 7, 8, 0, 10, 11, 0, 13, 14];
const LENGTHS = [0, .16, .16, .45, .398, .46, .46, .398, .46, .46, .17, .66, .66, .17, .66, .66];

/** Bake the downloaded skeleton to this body's lengths once, rather than
 * parsing an FBX or running a separate animation mixer for every wounded NPC. */
export function bakeCrawlMotion(rig: THREE.Group, clip: THREE.AnimationClip, fps = 30): JointMotion {
  const bones = NAMES.map(name => rig.getObjectByName(`mixamorig${name}`) || rig.getObjectByName(`mixamorig:${name}`));
  if (bones.some(bone => !bone)) throw new Error('Crawling.fbx is missing a required Mixamo joint');
  const mixer = new THREE.AnimationMixer(rig);
  mixer.clipAction(clip).setLoop(THREE.LoopRepeat, Infinity).play();
  const frames: number[][] = [];
  const count = Math.max(2, Math.ceil(clip.duration * fps));
  for (let frame = 0; frame < count; frame++) {
    mixer.setTime(frame * clip.duration / count);
    rig.updateMatrixWorld(true);
    const source = bones.map(bone => bone!.getWorldPosition(new THREE.Vector3()));
    const targets = [new THREE.Vector3()];
    for (let joint = 1; joint < bones.length; joint++) {
      const direction = source[joint].clone().sub(source[PARENTS[joint]]).normalize();
      targets.push(targets[PARENTS[joint]].clone().addScaledVector(direction, LENGTHS[joint]));
    }
    // Our humanoids face +Z and use -X for the left shoulder.
    const flipForward = targets[3].z < 0 ? -1 : 1;
    const flipSide = targets[4].x > targets[7].x ? -1 : 1;
    const bottom = Math.min(...targets.map(point => point.y));
    frames.push(targets.flatMap(point => [point.x * flipSide, point.y - bottom + .13, point.z * flipForward]));
  }
  mixer.stopAllAction();
  return { source: 'Mixamo/Crawling.fbx', duration: clip.duration, fps: count / clip.duration, frames };
}

export function sampleJointMotion(motion: JointMotion, time: number, joint: number, out: THREE.Vector3): THREE.Vector3 {
  const phase = ((time % motion.duration + motion.duration) % motion.duration) * motion.fps;
  const frame = Math.floor(phase) % motion.frames.length, next = (frame + 1) % motion.frames.length;
  const a = motion.frames[frame], b = motion.frames[next], index = joint * 3, t = phase - Math.floor(phase);
  return out.set(a[index] + (b[index] - a[index]) * t, a[index + 1] + (b[index + 1] - a[index + 1]) * t,
    a[index + 2] + (b[index + 2] - a[index + 2]) * t);
}
