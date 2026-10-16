import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { advanceMind, createNPCMind, greetPerson, rememberIncident, routineGoal } from '../src/actors/NPCMind';
import { NPCLifeSystem } from '../src/actors/NPCLifeSystem';
import { NPCController, type NPC } from '../src/actors/NPCController';
import { RagdollSystem } from '../src/actors/RagdollSystem';
import type { GridSystem, Cell } from '../src/world/GridSystem';
import type { PrefabManager } from '../src/world/PrefabManager';

function neighbourhood(count = 2, visible = true) {
  const cell = { x: 2, z: 2, active: true, blocked: false, rubble: false, tile: 'sidewalk' } as Cell;
  const player = new THREE.Group(); player.position.set(-2, 0, 0);
  const people = Array.from({ length: count }, (_, id): NPC => {
    const group = new THREE.Group(); group.position.set(id % 8 * 1.8, 0, Math.floor(id / 8) * 1.8);
    return { id, group, kind: 'civilian', role: 'resident', alive: true, state: 'commute', offDuty: false,
      home: cell, work: cell, target: cell, pauseTime: 20, panic: 0, stamina: 4.5, reroute: 0,
      path: [], pathIndex: 0, velocity: new THREE.Vector3() } as NPC;
  });
  const grid = { seed: 1234, grid: () => [2, 2], cell: () => cell } as unknown as GridSystem;
  const prefabs = { publicAnchors: [] } as unknown as PrefabManager;
  const routes: number[] = [];
  const life = new NPCLifeSystem(people, grid, prefabs, player, {
    position: npc => npc.group.position, visible: () => visible, route: npc => { routes.push(npc.id); }
  });
  for (const npc of people) { const mind = life.mind(npc); mind.socialNeed = 0.9; mind.nextThink = 0; }
  return { life, people, player, routes };
}

test('people keep a deterministic identity across world reloads without sharing a personality', () => {
  const a = createNPCMind(1234, 8), again = createNPCMind(1234, 8), other = createNPCMind(1234, 9);
  assert.deepEqual(a, again);
  assert.notDeepEqual(a.personality, other.personality);
  assert.notEqual(a.name, other.name);
  assert.ok(a.personality.mass >= 55 && a.personality.mass <= 95);
});

test('hearing violence does not identify the player; a recognised aggressor cannot spam greetings to erase memory', () => {
  const witness = createNPCMind(11, 1), listener = createNPCMind(11, 2);
  rememberIncident(listener, { kind: 'gunshot', at: 0, x: 1, z: 1, severity: 0.85, playerKnown: false });
  assert.equal(listener.suspicion, 0);
  for (let i = 0; i < 200; i++) rememberIncident(witness,
    { kind: 'gunshot', at: i * 0.01, x: 1, z: 1, severity: 0.85, playerKnown: true });
  assert.equal(witness.episodes.length, 1, 'one burst stays a bounded episode');
  advanceMind(witness, 20, false, 0);
  const trust = witness.trust;
  for (let i = 0; i < 30; i++) assert.equal(greetPerson(witness, 20 + i * 0.1, false).accepts, false);
  assert.equal(witness.trust, trust, 'refusal is not a hidden reputation reward');
  assert.ok(witness.suspicion > 0.5);
  for (let i = 0; i < 20; i++) rememberIncident(witness,
    { kind: i % 2 ? 'injury' : 'threat', at: 30 + i * 5, x: 1, z: 1, severity: 0.8, playerKnown: true });
  assert.equal(witness.episodes.length, 8);
});

test('rest reduces fatigue and the routine follows time of day and accessible destinations', () => {
  const mind = createNPCMind(5, 3);
  mind.fatigue = 0.9;
  assert.equal(routineGoal(mind, 12, true, false), 'rest');
  mind.activity = 'rest'; advanceMind(mind, 10, false, 0);
  assert.ok(mind.fatigue < 0.8);
  mind.fatigue = 0;
  assert.equal(routineGoal(mind, 23, true, true), 'home');
  assert.equal(routineGoal(mind, 9, true, true), 'work');
  assert.equal(routineGoal(mind, 12, false, false), 'work');
});

test('a conversation has two consenting participants and a threat interrupts both', () => {
  const { life, people } = neighbourhood();
  life.update(1);
  const [a, b] = people;
  assert.equal(a.mind?.partner, b.id); assert.equal(b.mind?.partner, a.id);
  assert.equal(a.mind?.activityUntil, b.mind?.activityUntil);
  assert.ok(a.mind?.acquaintances.has(b.id) && b.mind?.acquaintances.has(a.id));
  life.incident(a, 'threat', new THREE.Vector3(), 0.9, true);
  assert.equal(a.mind?.partner, undefined); assert.equal(b.mind?.partner, undefined);
  assert.equal(b.pauseTime, 0, 'the listener resumes instead of talking to an absent partner');
});

test('walls and separate floors prevent conversations, attention and player interaction', () => {
  const { life, people, player } = neighbourhood(2, false);
  life.update(1);
  assert.ok(people.every(npc => npc.mind?.partner === undefined));
  assert.equal(life.interact(player.position, { threatening: false, medkits: 1 }), null);
  assert.equal(people[0].mind?.attention, undefined);
  const upstairs = neighbourhood();
  upstairs.people[1].group.position.y = 4;
  upstairs.life.update(1);
  assert.ok(upstairs.people.every(npc => npc.mind?.partner === undefined));
  upstairs.player.position.set(upstairs.people[1].group.position.x, 0, 0);
  assert.notEqual(upstairs.life.nearest(upstairs.player.position)?.id, upstairs.people[1].id);
});

test('a pedestrian walks toward a willing neighbour before starting a conversation', () => {
  const { life, people, routes } = neighbourhood();
  people[0].pauseTime = 0; people[1].group.position.x = 6;
  life.update(1);
  assert.equal(people[0].mind?.partner, people[1].id);
  assert.equal(people[0].mind?.activity, 'travel');
  assert.equal(people[1].mind?.activity, 'observe');
  assert.ok(routes.includes(people[0].id));
  people[0].group.position.x = 4;
  life.update(2);
  assert.equal(people[0].mind?.activity, 'talk');
  assert.equal(people[1].mind?.activity, 'talk');
});

test('first aid consumes one dressing, stops bleeding and never revives a fatal injury', () => {
  const { life, people, player } = neighbourhood(1);
  const patient = people[0]; patient.bleedOutTime = 10;
  const result = life.interact(player.position, { threatening: false, medkits: 1 });
  assert.equal(result?.usedMedkit, true); assert.equal(patient.bleedOutTime, undefined);
  assert.equal(patient.mind?.aidReceived, true);
  assert.equal(life.interact(player.position, { threatening: false, medkits: 1 })?.usedMedkit, false);
  patient.bleedOutTime = 5; patient.pendingDeath = true;
  assert.equal(life.interact(player.position, { threatening: false, medkits: 1 }), null);
});

test('an empathetic neighbour approaches and dresses a wounded person after a sustained safe interval', () => {
  const { life, people, routes } = neighbourhood();
  const [helper, patient] = people;
  helper.mind!.personality.empathy = 1; helper.mind!.bandageAvailable = true;
  patient.bleedOutTime = 10;
  life.update(1);
  assert.equal(helper.mind?.patient, patient.id);
  assert.ok(routes.includes(helper.id));
  assert.notEqual(patient.bleedOutTime, undefined, 'aid is not instantaneous');
  helper.group.position.x = 0.6;
  life.update(1.8);
  life.update(6);
  assert.equal(patient.bleedOutTime, undefined);
  assert.equal(helper.mind?.bandageAvailable, false);
  assert.ok(patient.mind?.acquaintances.has(helper.id));
});

test('a person with no usable hands cannot dress another wound', () => {
  const { life, people } = neighbourhood();
  const [helper, patient] = people;
  helper.mind!.personality.empathy = 1; helper.mind!.bandageAvailable = true;
  helper.missing = new Set(['leftForearm', 'rightForearm']);
  patient.bleedOutTime = 10;
  life.update(1);
  assert.equal(helper.mind?.patient, undefined);
  assert.notEqual(patient.bleedOutTime, undefined);
});

test('a busy street respects the thinking budget without starving slower people', () => {
  const { life, people } = neighbourhood(125);
  for (const npc of people) npc.pauseTime = 0;
  for (let frame = 0; frame < 90; frame++) {
    life.update(frame / 30);
    assert.ok(life.stats.decisions <= 10);
  }
  assert.ok(people.every(npc => npc.mind!.lastThink > 0.5));
});

test('impact momentum is swept against a thin obstacle instead of teleporting the fallen person through it', () => {
  const npc = { group: new THREE.Group(), knockback: new THREE.Vector3(8, 0, 0) } as NPC;
  const context = { spatial: { update() {} }, prefabs: { supportHeight: () => 0 },
    canOccupy: (_npc: NPC, x: number) => x < 0.4 || x > 0.55 };
  const advance = (NPCController.prototype as unknown as { advanceImpact: (npc: NPC, dt: number) => void }).advanceImpact;
  advance.call(context, npc, 0.5);
  assert.ok(npc.group.position.x > 0.1 && npc.group.position.x < 0.4);
  assert.equal(npc.knockback.x, 0);
});

test('ragdoll impulse keeps its units at 30/60 Hz and recovery waits for a grounded body', () => {
  const grid = { walkable: () => true, water: { currentAt: () => false, at: () => false } } as unknown as GridSystem;
  const prefabs = { vehicles: [], supportHeight: () => 0, interiorObstacleAt: () => false } as unknown as PrefabManager;
  const make = () => {
    const system = new RagdollSystem(new THREE.Scene(), grid, prefabs);
    const body = system.spawn(new THREE.Vector3(0, 8, 0), 0, new THREE.Vector3(4, 0, 0),
      { shirt: '#abcdef', pants: '#123456', skin: '#fedcba', shoes: '#123456' });
    return { system, body };
  };
  const slow = make(), fast = make();
  assert.equal(slow.system.canRecover(slow.body), false, 'a timer cannot stand a person up in midair');
  slow.system.update(1 / 30);
  fast.system.update(1 / 60); fast.system.update(1 / 60);
  assert.ok(Math.abs(slow.system.pelvis(slow.body).x - fast.system.pelvis(fast.body).x) < 0.015);
  for (let i = 0; i < 240; i++) fast.system.update(1 / 60);
  assert.equal(fast.system.canRecover(fast.body), true);
});
