import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

export type MixamoState = 'idle' | 'walk' | 'run' | 'fear' | 'aim' | 'fire' | 'crouch' | 'surrender';
type ClipEntry = { id: string; file: string; states: MixamoState[] };
type Manifest = { clips: ClipEntry[] };
type LoadedClip = { clip: THREE.AnimationClip };
type ActorPlayback = { mixer: THREE.AnimationMixer; action?: THREE.AnimationAction; clipId?: string };
export type MixamoReferencePose = ReadonlyMap<string, THREE.Quaternion>;

// Keep Node-based rig tests safe while Vite injects the deployment subpath in builds.
const ASSET_BASE_URL = typeof import.meta.env === 'undefined' ? '/' : import.meta.env.BASE_URL;

function boneNameFromTrack(trackName: string): string | undefined {
  const match = trackName.match(/(?:^|[/.])([^/.]+)\.quaternion$/i);
  if (!match) return undefined;
  return match[1].split(':').at(-1)!.replace(/^mixamorig/i, '').toLowerCase();
}

const TARGET_BONES: Record<string, string> = {
  hips: 'mixamorigHips',
  spine: 'mixamorigSpine2', spine1: 'mixamorigSpine2', spine2: 'mixamorigSpine2',
  neck: 'mixamorigNeck', head: 'mixamorigHead',
  leftarm: 'mixamorigLeftArm', leftforearm: 'mixamorigLeftForeArm', lefthand: 'mixamorigLeftHand',
  rightarm: 'mixamorigRightArm', rightforearm: 'mixamorigRightForeArm', righthand: 'mixamorigRightHand',
  leftupleg: 'mixamorigLeftUpLeg', leftleg: 'mixamorigLeftLeg', leftfoot: 'mixamorigLeftFoot',
  rightupleg: 'mixamorigRightUpLeg', rightleg: 'mixamorigRightLeg', rightfoot: 'mixamorigRightFoot'
};

const RETARGET_JOINTS: Array<{ target: string; source: string; parent?: string }> = [
  { target: 'mixamorigHips', source: 'mixamorigHips' },
  { target: 'mixamorigSpine2', source: 'spine' , parent: 'mixamorigHips' },
  { target: 'mixamorigNeck', source: 'mixamorigNeck', parent: 'mixamorigSpine2' },
  { target: 'mixamorigHead', source: 'mixamorigHead', parent: 'mixamorigNeck' },
  { target: 'mixamorigLeftArm', source: 'mixamorigLeftArm', parent: 'mixamorigSpine2' },
  { target: 'mixamorigRightArm', source: 'mixamorigRightArm', parent: 'mixamorigSpine2' },
  { target: 'mixamorigLeftForeArm', source: 'mixamorigLeftForeArm', parent: 'mixamorigLeftArm' },
  { target: 'mixamorigRightForeArm', source: 'mixamorigRightForeArm', parent: 'mixamorigRightArm' },
  { target: 'mixamorigLeftHand', source: 'mixamorigLeftHand', parent: 'mixamorigLeftForeArm' },
  { target: 'mixamorigRightHand', source: 'mixamorigRightHand', parent: 'mixamorigRightForeArm' },
  { target: 'mixamorigLeftUpLeg', source: 'mixamorigLeftUpLeg', parent: 'mixamorigHips' },
  { target: 'mixamorigRightUpLeg', source: 'mixamorigRightUpLeg', parent: 'mixamorigHips' },
  { target: 'mixamorigLeftLeg', source: 'mixamorigLeftLeg', parent: 'mixamorigLeftUpLeg' },
  { target: 'mixamorigRightLeg', source: 'mixamorigRightLeg', parent: 'mixamorigRightUpLeg' },
  { target: 'mixamorigLeftFoot', source: 'mixamorigLeftFoot', parent: 'mixamorigLeftLeg' },
  { target: 'mixamorigRightFoot', source: 'mixamorigRightFoot', parent: 'mixamorigRightLeg' }
];

const VOXEL_MOTION_WEIGHT: Record<string, number> = {
  hips: 0.64, spine: 0.66, spine1: 0.66, spine2: 0.66,
  neck: 0.36, head: 0.24,
  leftarm: 0.72, leftforearm: 0.67, rightarm: 0.72, rightforearm: 0.67,
  leftupleg: 0.70, leftleg: 0.67, leftfoot: 0.62,
  rightupleg: 0.70, rightleg: 0.67, rightfoot: 0.62
};

function normalizedBoneName(trackName: string): string | undefined {
  const match = trackName.match(/(?:^|[/.])([^/.]+)\.quaternion$/i);
  if (!match) return undefined;
  const name = match[1].split(':').at(-1)!.replace(/^mixamorig/i, '').toLowerCase();
  return TARGET_BONES[name] ? name : undefined;
}

/** Maps standard Mixamo local bone rotations onto the voxel rig's named joint groups. */
export function mixamoReferencePose(source: THREE.AnimationClip): Map<string, THREE.Quaternion> {
  const pose = new Map<string, THREE.Quaternion>();
  for (const track of source.tracks) {
    // Keep the intermediate shoulder/hand/foot bones too. Their rest
    // orientation defines the coordinate frame used by child joints.
    const bone = boneNameFromTrack(track.name);
    if (!bone || pose.has(bone) || track.values.length < 4) continue;
    pose.set(bone, new THREE.Quaternion().fromArray(track.values, 0).normalize());
  }
  return pose;
}

export function retargetMixamoClip(source: THREE.AnimationClip, sourceRig?: THREE.Object3D,
  referencePose?: MixamoReferencePose): THREE.AnimationClip {
  if (sourceRig) return retargetMixamoWorldClip(source, sourceRig, referencePose);
  return retargetMixamoLocalClip(source, referencePose);
}

function retargetMixamoWorldClip(source: THREE.AnimationClip, sourceRig: THREE.Object3D,
  referencePose?: MixamoReferencePose): THREE.AnimationClip {
  if (sourceRig && referencePose) {
    sourceRig.traverse((object) => {
      const name = object.name.replace(/^mixamorig:?/i, '').toLowerCase();
      const reference = referencePose.get(name);
      if (reference && (object as THREE.Bone).isBone) object.quaternion.copy(reference);
    });
    sourceRig.updateMatrixWorld(true);
  }
  const selectedSpine = ['spine2', 'spine1', 'spine'].find((name) =>
    source.tracks.some((track) => normalizedBoneName(track.name) === name));
  const joints = RETARGET_JOINTS.map((joint) => ({
    ...joint,
    source: joint.target === 'mixamorigSpine2' ? `mixamorig${selectedSpine ? selectedSpine[0].toUpperCase() + selectedSpine.slice(1) : 'Spine2'}` : joint.source
  })).filter((joint) => sourceRig.getObjectByName(joint.source));
  const referenceWorld = new Map<string, THREE.Quaternion>();
  sourceRig.updateMatrixWorld(true);
  for (const joint of joints) {
    const bone = sourceRig.getObjectByName(joint.source)!;
    referenceWorld.set(joint.target, bone.getWorldQuaternion(new THREE.Quaternion()));
  }
  const axisFrame = sourceRig.getWorldQuaternion(new THREE.Quaternion()).invert();
  const keyTimes = [...new Set(source.tracks.filter((track) => track instanceof THREE.QuaternionKeyframeTrack)
    .flatMap((track) => Array.from(track.times)))].sort((a, b) => a - b);
  if (keyTimes.length < 2) keyTimes.push(source.duration);
  const sourceMixer = new THREE.AnimationMixer(sourceRig);
  sourceMixer.clipAction(source).setLoop(THREE.LoopOnce, 1).play();
  const sampledValues = new Map(joints.map((joint) => [joint.target, [] as number[]]));
  const currentWorld = new THREE.Quaternion();
  const inverseReference = new THREE.Quaternion();
  const targetWorld = new Map<string, THREE.Quaternion>();
  const frameDelta = new THREE.Quaternion();
  const parentInverse = new THREE.Quaternion();
  for (const time of keyTimes) {
    sourceMixer.setTime(time);
    sourceRig.updateMatrixWorld(true);
    targetWorld.clear();
    for (const joint of joints) {
      const sourceBone = sourceRig.getObjectByName(joint.source)!;
      sourceBone.getWorldQuaternion(currentWorld);
      inverseReference.copy(referenceWorld.get(joint.target)!).invert();
      frameDelta.copy(currentWorld).multiply(inverseReference);
      // FBXLoader may place a fixed axis conversion on the scene root. Remove
      // it so the delta is expressed in the same Y-up frame as the voxel rig.
      frameDelta.premultiply(axisFrame).multiply(axisFrame.clone().invert()).normalize();
      const worldPose = frameDelta.clone();
      const weight = VOXEL_MOTION_WEIGHT[normalizedBoneName(`${joint.target}.quaternion`) || ''] ?? 0.72;
      // Attenuate the desired world pose before deriving this joint's local
      // rotation. Attenuating only the local delta makes child joints fight
      // their already-damped parents and twists elbows/knees off their hinges.
      worldPose.slerp(new THREE.Quaternion(), 1 - weight).normalize();
      targetWorld.set(joint.target, worldPose);
      let localPose = worldPose;
      if (joint.parent && targetWorld.has(joint.parent)) {
        parentInverse.copy(targetWorld.get(joint.parent)!).invert();
        localPose = parentInverse.multiply(worldPose);
      }
      localPose.normalize();
      sampledValues.get(joint.target)!.push(...localPose.toArray());
    }
  }
  sourceMixer.stopAllAction();
  const times = new Float32Array(keyTimes);
  const tracks: THREE.KeyframeTrack[] = joints.map((joint) => new THREE.QuaternionKeyframeTrack(
    `${joint.target}.quaternion`, times, new Float32Array(sampledValues.get(joint.target)!)
  ));
  const clip = new THREE.AnimationClip(source.name, source.duration, tracks);
  clip.optimize();
  return clip;
}

function retargetMixamoLocalClip(source: THREE.AnimationClip, referencePose?: MixamoReferencePose): THREE.AnimationClip {
  const tracks: THREE.KeyframeTrack[] = [];
  const usedTargets = new Set<string>();
  for (const track of source.tracks) {
    const bone = normalizedBoneName(track.name);
    if (!bone || (bone.startsWith('spine') && bone !== 'spine2')) continue;
    const target = TARGET_BONES[bone];
    if (!target || usedTargets.has(target)) continue;
    usedTargets.add(target);
    const referenceInverse = (referencePose?.get(bone) || new THREE.Quaternion()).clone().invert();
    const corrected = new Float32Array(track.values.length);
    for (let i = 0; i < track.values.length; i += 4) {
      const value = new THREE.Quaternion().fromArray(track.values, i).multiply(referenceInverse).normalize();
      value.slerp(new THREE.Quaternion(), 1 - (VOXEL_MOTION_WEIGHT[bone] ?? 0.72));
      corrected.set(value.toArray(), i);
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(`${target}.quaternion`, track.times, corrected));
  }
  const clip = new THREE.AnimationClip(source.name, source.duration, tracks);
  clip.optimize();
  return clip;
}

/** Loads optional Mixamo FBXs and crossfades them on the existing articulated voxel characters. */
export class MixamoAnimationSystem {
  private readonly clips = new Map<string, LoadedClip>();
  private readonly stateClips = new Map<MixamoState, string>();
  private readonly actors = new Map<THREE.Group, ActorPlayback>();
  private readonly loader = new FBXLoader();
  private referencePose = new Map<string, THREE.Quaternion>();

  async load(manifestUrl = `${ASSET_BASE_URL}animations/mixamo/manifest.json`): Promise<void> {
    if (typeof window === 'undefined') return;
    try {
      const response = await fetch(manifestUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const manifest = await response.json() as Manifest;
      if (!Array.isArray(manifest.clips)) throw new Error('manifest.clips debe ser una lista');
      const entries = [...manifest.clips].sort((a, b) =>
        Number(b.id === 'idle' || b.states?.includes('idle')) - Number(a.id === 'idle' || a.states?.includes('idle')));
      for (const entry of entries) {
        if (!entry.id || !entry.file || !Array.isArray(entry.states)) continue;
        try {
          const source = await this.loader.loadAsync(`${ASSET_BASE_URL}animations/mixamo/${entry.file}`);
          const sourceClip = source.animations[0];
          if (!sourceClip) continue;
          if (entry.id === 'idle' || entry.states.includes('idle')) this.referencePose = mixamoReferencePose(sourceClip);
          const clip = retargetMixamoClip(sourceClip, source, this.referencePose);
          if (!clip.tracks.length) {
            console.warn(`[Mixamo] ${entry.file}: no se encontraron huesos Mixamo compatibles`);
            continue;
          }
          this.clips.set(entry.id, { clip });
          entry.states.forEach((state) => { if (!this.stateClips.has(state)) this.stateClips.set(state, entry.id); });
        } catch (error) {
          console.warn(`[Mixamo] No se pudo cargar ${entry.file}`, error);
        }
        // Let the render loop breathe between FBX parses during city startup.
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }
    } catch (error) {
      // Animations are optional during authoring; the existing spring-driven rig remains active.
      console.info('[Mixamo] Sin manifest de animaciones; se mantiene el movimiento procedural.', error);
    }
  }

  /** Returns true when a loaded clip is driving this actor, otherwise leaves the procedural pose in control. */
  update(root: THREE.Group, dt: number, requested: MixamoState): boolean {
    const clipId = this.resolve(requested);
    const loaded = clipId ? this.clips.get(clipId) : undefined;
    if (!loaded) {
      this.stop(root);
      return false;
    }
    let actor = this.actors.get(root);
    if (!actor) {
      actor = { mixer: new THREE.AnimationMixer(root) };
      this.actors.set(root, actor);
    }
    if (actor.clipId !== clipId) {
      actor.action?.fadeOut(0.18);
      actor.action = actor.mixer.clipAction(loaded.clip).reset().fadeIn(0.18).play();
      actor.action.setLoop(THREE.LoopRepeat, Infinity);
      actor.clipId = clipId;
    }
    actor.mixer.update(Math.min(dt, 0.05));
    return true;
  }

  stop(root: THREE.Group): void {
    const actor = this.actors.get(root);
    if (!actor?.action) return;
    actor.action.stop(); actor.mixer.stopAllAction(); actor.action = undefined; actor.clipId = undefined;
  }

  private resolve(state: MixamoState): string | undefined {
    const fallback: Partial<Record<MixamoState, MixamoState[]>> = {
      fear: ['run', 'walk', 'idle'], fire: ['aim', 'idle'], aim: ['idle'],
      crouch: ['idle'], surrender: ['idle'], run: ['walk', 'idle'], walk: ['idle']
    };
    for (const candidate of [state, ...(fallback[state] || [])]) {
      const id = this.stateClips.get(candidate);
      if (id) return id;
    }
    return undefined;
  }

  dispose(): void {
    for (const actor of this.actors.values()) actor.mixer.stopAllAction();
    this.actors.clear(); this.clips.clear(); this.stateClips.clear(); this.referencePose.clear();
  }
}
