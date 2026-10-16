import * as THREE from 'three';
import { SpatialHash } from '../core/SpatialHash';
import type { Cell, GridSystem } from '../world/GridSystem';
import type { PrefabManager } from '../world/PrefabManager';
import type { NPC } from './NPCController';
import { advanceMind, createNPCMind, greetPerson, recogniseNeighbour, rememberIncident, routineGoal,
  type IncidentKind, type NPCMind } from './NPCMind';

type LifeContext = {
  position: (npc: NPC) => THREE.Vector3;
  visible: (from: THREE.Vector3, to: THREE.Vector3) => boolean;
  route: (npc: NPC, cell: Cell) => void;
};
export type PersonInteraction = { text: string; tone: 'info' | 'success' | 'danger'; usedMedkit: boolean };

/** Nearby people think in staggered, bounded batches; locomotion remains at its usual rate. */
export class NPCLifeSystem {
  private now = 0;
  private cursor = 0;
  private readonly peopleById = new Map<number, NPC>();
  private readonly neighbours: SpatialHash<NPC>;
  readonly stats = { decisions: 0, active: 0, cpuMs: 0 };

  constructor(private people: readonly NPC[], private grid: GridSystem, private prefabs: PrefabManager,
    private player: THREE.Object3D, private context: LifeContext) {
    this.neighbours = new SpatialHash(6, npc => context.position(npc));
  }

  mind(npc: NPC): NPCMind {
    if (!npc.mind || npc.mind.owner !== npc.id) npc.mind = createNPCMind(this.grid.seed, npc.id, this.now);
    return npc.mind;
  }

  person(id?: number): NPC | undefined { return id === undefined ? undefined : this.peopleById.get(id); }

  interrupt(npc: NPC): void {
    const mind = this.mind(npc), partner = this.person(mind.partner);
    if (partner?.mind?.partner === npc.id) {
      partner.mind.partner = undefined; partner.mind.activity = 'travel'; partner.mind.socialCooldown = this.now + 12;
      partner.pauseTime = 0;
    }
    if (mind.partner !== undefined || mind.activity === 'greet' || mind.activity === 'help') npc.pauseTime = 0;
    mind.partner = undefined; mind.patient = undefined; mind.helpStarted = undefined;
    mind.activity = 'travel'; mind.activityUntil = 0; mind.attention = undefined;
    mind.socialCooldown = this.now + 12;
  }

  incident(npc: NPC, kind: IncidentKind, source: THREE.Vector3, severity: number, playerKnown: boolean): void {
    const mind = this.mind(npc);
    rememberIncident(mind, { kind, at: this.now, x: source.x, z: source.z, severity, playerKnown });
    if (kind !== 'help' && kind !== 'bump') this.interrupt(npc);
    mind.attention = { kind: playerKnown ? 'player' : 'point', x: source.x, y: source.y + 1.5, z: source.z, until: this.now + 3 };
  }

  update(now: number): void {
    const start = performance.now(); this.now = now;
    this.peopleById.clear();
    const active: NPC[] = [];
    for (const npc of this.people) {
      this.peopleById.set(npc.id, npc);
      if (npc.alive && !npc.offDuty && this.context.position(npc).distanceToSquared(this.player.position) < 48 * 48) active.push(npc);
    }
    this.neighbours.rebuild(active);
    this.stats.active = active.length; this.stats.decisions = 0;
    // The cursor advances even over sleeping minds: a busy street cannot starve one person.
    for (let scanned = 0; scanned < this.people.length && this.stats.decisions < 10; scanned++) {
      this.cursor %= Math.max(1, this.people.length);
      const npc = this.people[this.cursor++];
      if (!npc.alive || npc.offDuty || this.context.position(npc).distanceToSquared(this.player.position) > 48 * 48) continue;
      const mind = this.mind(npc);
      if (mind.nextThink > now) continue;
      advanceMind(mind, now, (npc.velocity?.lengthSq() ?? 0) > 0.05, npc.panic);
      mind.nextThink = now + 0.55 + mind.personality.patience * 0.2;
      this.stats.decisions++;
      // An unusually brave, caring person may return to help once danger has passed.
      // A recognised aggressor still nearby prevents that decision.
      if (npc.kind === 'civilian' && npc.state === 'flee' && !npc.ragdoll && !npc.hitReaction &&
        mind.personality.courage > 0.7 && mind.personality.empathy > 0.6 && now - mind.lastThreat > 8 &&
        npc.panic < 0.6 && (mind.suspicion < 0.45 || npc.group.position.distanceToSquared(this.player.position) > 20 ** 2)) {
        npc.state = 'commute'; npc.panic = 0.18; mind.stress = Math.min(mind.stress, 0.3);
      }
      if (npc.ragdoll || npc.hitReaction || npc.state !== 'commute' || npc.kind !== 'civilian') {
        if (mind.partner !== undefined || mind.patient !== undefined) this.interrupt(npc);
        continue;
      }
      this.think(npc, mind);
    }
    this.stats.cpuMs = performance.now() - start;
  }

  private think(npc: NPC, mind: NPCMind): void {
    const position = this.context.position(npc);
    if (mind.partner !== undefined) {
      const other = this.person(mind.partner);
      if (!other?.alive || other.ragdoll || other.hitReaction || other.state !== 'commute' ||
        other.offDuty || this.now >= mind.activityUntil || position.distanceToSquared(other.group.position) > 11 ** 2 ||
        !this.context.visible(position, other.group.position)) { this.interrupt(npc); return; }
      const distance = position.distanceToSquared(other.group.position);
      if (mind.activity !== 'talk' && distance <= 3.3 ** 2) this.startConversation(npc, other);
      if (mind.activity === 'talk' || mind.activity === 'observe') npc.pauseTime = Math.max(0.1, mind.activityUntil - this.now);
      else if (npc.reroute <= 0) this.approach(npc, other);
      mind.attention = { kind: 'person', id: other.id, x: other.group.position.x, y: other.group.position.y + 1.8,
        z: other.group.position.z, until: mind.activityUntil };
      return;
    }
    if (mind.patient !== undefined) { this.helpNeighbour(npc, mind); return; }
    if (mind.activity === 'greet' && this.now < mind.activityUntil) return;
    if (mind.activity === 'greet') { mind.activity = 'travel'; npc.pauseTime = 0; }
    if (npc.panic > 0.2 || mind.stress > 0.5) return;
    const toPlayerX = this.player.position.x - position.x, toPlayerZ = this.player.position.z - position.z;
    const playerDistance = Math.hypot(toPlayerX, toPlayerZ);
    if (playerDistance < 7 && (this.now + npc.id * 0.73) % 6 < 2 &&
      (Math.sin(npc.group.rotation.y) * toPlayerX + Math.cos(npc.group.rotation.y) * toPlayerZ) > playerDistance * 0.25 &&
      this.context.visible(position, this.player.position))
      mind.attention = { kind: 'player', x: this.player.position.x, y: this.player.position.y + 1.8,
        z: this.player.position.z, until: this.now + 1.1 };
    const neighbours = this.neighbours.nearby(position.x, position.z, 10).slice(0, 12);
    const usableHand = !npc.missing?.has('leftUpperArm') && !npc.missing?.has('leftForearm') ||
      !npc.missing?.has('rightUpperArm') && !npc.missing?.has('rightForearm');
    if (usableHand && mind.bandageAvailable && mind.personality.empathy > 0.55 && this.now - mind.lastThreat > 8) {
      const patient = neighbours.find(other => other !== npc && other.alive && !other.pendingDeath &&
        !this.mind(other).aidReceived && (other.bleedOutTime !== undefined || other.ragdoll && other.stamina < 3) &&
        Math.abs(this.context.position(other).y - position.y) < 1.4 && this.context.visible(position, this.context.position(other)));
      if (patient && !neighbours.some(other => other !== npc && other.mind?.patient === patient.id)) {
        mind.patient = patient.id; mind.activity = 'help'; mind.activityUntil = this.now + 18;
        this.helpNeighbour(npc, mind); return;
      }
    }
    if (npc.indoorAnchor || this.now < mind.socialCooldown || mind.socialNeed < 0.45) return;
    const other = neighbours.find(other => other !== npc && other.kind === 'civilian' && other.alive &&
      !other.indoorAnchor && !other.ragdoll && !other.hitReaction && other.state === 'commute' && other.panic < 0.2 &&
      other.pauseTime > 1 && other.group.position.distanceToSquared(position) < 10 ** 2 &&
      Math.abs(other.group.position.y - position.y) < 0.7 && this.mind(other).partner === undefined &&
      this.mind(other).patient === undefined && this.mind(other).activity !== 'greet' && this.mind(other).stress < 0.5 &&
      this.mind(other).socialCooldown <= this.now && this.mind(other).socialNeed > 0.35 - (mind.acquaintances.get(other.id) ?? 0) * 0.15 &&
      this.context.visible(position, other.group.position));
    if (!other) return;
    if (other.group.position.distanceToSquared(position) > 3.3 ** 2) {
      const partner = this.mind(other);
      mind.partner = other.id; mind.activity = 'travel'; mind.activityUntil = this.now + 14;
      partner.partner = npc.id; partner.activity = 'observe'; partner.activityUntil = mind.activityUntil;
      other.pauseTime = 14; npc.pauseTime = 0;
      this.approach(npc, other);
      return;
    }
    this.startConversation(npc, other);
  }

  private approach(npc: NPC, other: NPC): void {
    const point = this.context.position(other), [gx, gz] = this.grid.grid(point.x, point.z);
    const cell = [[0, 1], [1, 0], [0, -1], [-1, 0]].map(([dx, dz]) => this.grid.cell(gx + dx, gz + dz))
      .find(cell => cell?.active && !cell.blocked && !cell.rubble);
    if (cell) this.context.route(npc, cell);
  }

  private startConversation(npc: NPC, other: NPC): void {
    const mind = this.mind(npc);
    const partner = this.mind(other);
    const duration = 6 + 7 * (mind.personality.sociability + partner.personality.sociability) / 2 +
      (mind.acquaintances.get(other.id) ?? 0) * 4;
    for (const [person, brain, friend] of [[npc, mind, other], [other, partner, npc]] as const) {
      brain.partner = friend.id; brain.activity = 'talk'; brain.activityUntil = this.now + duration;
      brain.conversationAt = this.now; brain.socialCooldown = this.now + duration + 18;
      brain.attention = { kind: 'person', id: friend.id, x: friend.group.position.x, y: friend.group.position.y + 1.8,
        z: friend.group.position.z, until: brain.activityUntil };
      recogniseNeighbour(brain, friend.id);
      person.pauseTime = duration; person.velocity?.set(0, 0, 0);
    }
  }

  private helpNeighbour(helper: NPC, mind: NPCMind): void {
    const patient = this.person(mind.patient);
    if (!patient?.alive || patient.pendingDeath || this.mind(patient).aidReceived || this.now > mind.activityUntil ||
      helper.panic > 0.2 || this.now - mind.lastThreat < 8) { this.interrupt(helper); return; }
    const from = this.context.position(helper), to = this.context.position(patient);
    if (!this.context.visible(from, to)) { this.interrupt(helper); return; }
    mind.attention = { kind: 'person', id: patient.id, x: to.x, y: to.y + 0.6, z: to.z, until: this.now + 2 };
    if (from.distanceToSquared(to) > 1.7 ** 2) {
      mind.helpStarted = undefined;
      if (helper.reroute <= 0) {
        const [gx, gz] = this.grid.grid(to.x, to.z);
        const cell = [[0, 0], [0, 1], [1, 0], [0, -1], [-1, 0]].map(([dx, dz]) => this.grid.cell(gx + dx, gz + dz))
          .find(cell => cell?.active && !cell.blocked && !cell.rubble);
        if (cell) this.context.route(helper, cell);
      }
      return;
    }
    mind.helpStarted ??= this.now;
    helper.pauseTime = 1; helper.velocity?.set(0, 0, 0);
    if (this.now - mind.helpStarted >= 4) {
      this.bandage(patient, false); mind.bandageAvailable = false;
      recogniseNeighbour(mind, patient.id); recogniseNeighbour(this.mind(patient), helper.id);
      this.interrupt(helper);
    }
  }

  private bandage(npc: NPC, byPlayer: boolean): void {
    npc.bleedOutTime = undefined; npc.bleedFxClock = 0;
    const mind = this.mind(npc); mind.aidReceived = true; mind.lastAid = this.now;
    mind.pain *= 0.6;
    // A dressing stops bleeding; it neither restores missing limbs nor revives a fatal injury.
    if (byPlayer) this.incident(npc, 'help', this.player.position, 0.35, true);
  }

  destination(npc: NPC, hour: number): Cell {
    const mind = this.mind(npc), anchors = this.prefabs.publicAnchors ?? [];
    const rest = anchors.filter(anchor => anchor.activity === 'rest' && anchor.cell.active && !anchor.cell.blocked);
    const shops = anchors.filter(anchor => anchor.activity === 'browse' && anchor.cell.active && !anchor.cell.blocked);
    mind.goal = routineGoal(mind, hour, rest.length > 0, shops.length > 0);
    mind.activity = 'travel';
    const candidates = mind.goal === 'rest' ? rest : mind.goal === 'browse' ? shops : [];
    let best: Cell | undefined, score = Infinity;
    for (const anchor of candidates) {
      const distance = Math.abs(anchor.cell.x - npc.target.x) + Math.abs(anchor.cell.z - npc.target.z);
      if (distance < score) { best = anchor.cell; score = distance; }
    }
    return best ?? (mind.goal === 'home' ? npc.home : npc.work);
  }

  arrived(npc: NPC): void {
    const mind = this.mind(npc);
    mind.activity = mind.goal === 'home' || mind.goal === 'rest' ? 'rest' : mind.goal;
    npc.pauseTime = (mind.activity === 'rest' ? 18 : mind.activity === 'work' ? 14 : 9) + mind.personality.patience * 9;
  }

  nearest(position: THREE.Vector3): NPC | undefined {
    let nearest: NPC | undefined, distance = 3 ** 2;
    for (const npc of this.people) {
      if (npc.kind !== 'civilian' || !npc.alive || npc.pendingDeath || npc.offDuty) continue;
      const point = this.context.position(npc), d = point.distanceToSquared(position);
      if (d >= distance || Math.abs(point.y - position.y) > 1.4 || !this.context.visible(position, point)) continue;
      nearest = npc; distance = d;
    }
    return nearest;
  }

  prompt(position: THREE.Vector3): string | null {
    const npc = this.nearest(position);
    if (!npc) return null;
    const mind = this.mind(npc);
    return `E · ${npc.bleedOutTime !== undefined && !mind.aidReceived ? 'VENDAR A' : 'HABLAR CON'} ${mind.name.toUpperCase()}`;
  }

  interact(position: THREE.Vector3, options: { threatening: boolean; medkits: number }): PersonInteraction | null {
    const npc = this.nearest(position);
    if (!npc) return null;
    const mind = this.mind(npc);
    if (options.threatening) return { text: `${mind.name}: Baja el arma.`, tone: 'danger', usedMedkit: false };
    if (npc.bleedOutTime !== undefined && !mind.aidReceived) {
      if (options.medkits < 1) return { text: `${mind.name}: Necesito un vendaje. · NO TIENES BOTIQUÍN`, tone: 'info', usedMedkit: false };
      this.bandage(npc, true);
      return { text: `${mind.name}: Gracias… la hemorragia ha parado.`, tone: 'success', usedMedkit: true };
    }
    const greeting = greetPerson(mind, this.now, false);
    if (greeting.accepts && !npc.ragdoll && !npc.hitReaction) {
      this.interrupt(npc); mind.activity = 'greet'; mind.activityUntil = this.now + 2.8;
      mind.attention = { kind: 'player', x: position.x, y: position.y + 1.8, z: position.z, until: mind.activityUntil };
      npc.pauseTime = 2.8;
      npc.panic = Math.max(0, npc.panic - 0.08 * Math.max(0, 1 - mind.suspicion));
    }
    return { text: `${mind.name}: ${greeting.text}`, tone: greeting.accepts ? 'info' : 'danger', usedMedkit: false };
  }
}
