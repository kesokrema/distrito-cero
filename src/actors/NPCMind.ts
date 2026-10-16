/** Small, deterministic character state. No renderer, path requests or per-frame searches. */
export type LifeActivity = 'travel' | 'work' | 'rest' | 'browse' | 'observe' | 'talk' | 'greet' | 'help';
export type IncidentKind = 'gunshot' | 'explosion' | 'threat' | 'injury' | 'bump' | 'help';
export type Personality = {
  sociability: number; empathy: number; courage: number; patience: number;
  curiosity: number; pace: number; handedness: -1 | 1; mass: number;
};
export type Episode = {
  kind: IncidentKind; at: number; x: number; z: number; severity: number; playerKnown: boolean;
};
export type NPCMind = {
  owner: number; name: string; personality: Personality;
  fatigue: number; socialNeed: number; stress: number; pain: number; irritation: number;
  trust: number; suspicion: number; episodes: Episode[]; acquaintances: Map<number, number>;
  activity: LifeActivity; goal: 'home' | 'work' | 'rest' | 'browse';
  lastThink: number; nextThink: number; activityUntil: number; lastGreeting: number;
  lastThreat: number; lastContact: number; lastAid: number; bandageAvailable: boolean;
  partner?: number; conversationAt: number; socialCooldown: number;
  patient?: number; helpStarted?: number; aidReceived: boolean;
  attention?: { kind: 'player' | 'person' | 'point'; id?: number; x: number; y: number; z: number; until: number };
};

const FIRST = ['Ana', 'Diego', 'Lucía', 'Mateo', 'Elena', 'Gabriel', 'Valeria', 'Tomás', 'Camila', 'Samuel', 'Inés', 'Daniel', 'Rosa', 'Nicolás', 'Marina', 'Andrés'];
const LAST = ['Rojas', 'Vega', 'Méndez', 'Silva', 'Torres', 'Mora', 'Cruz', 'Reyes', 'Soto', 'León', 'Vargas', 'Paz'];
const clamp = (n: number, min = 0, max = 1): number => Math.max(min, Math.min(max, n));

export function createNPCMind(seed: number, id: number, now = 0): NPCMind {
  let state = (Math.imul(seed, 1664525) ^ Math.imul(id + 1, 1013904223)) >>> 0;
  const random = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ state >>> 15, 1 | state);
    t ^= t + Math.imul(t ^ t >>> 7, 61 | t);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  const name = `${FIRST[Math.floor(random() * FIRST.length)]} ${LAST[Math.floor(random() * LAST.length)]}`;
  const personality: Personality = { sociability: random(), empathy: random(), courage: random(), patience: random(),
    curiosity: random(), pace: 0.88 + random() * 0.24, handedness: random() < 0.15 ? -1 : 1, mass: 55 + random() * 40 };
  return { owner: id, name, personality, fatigue: random() * 0.3, socialNeed: 0.3 + random() * 0.5,
    stress: 0, pain: 0, irritation: 0, trust: 0, suspicion: 0, episodes: [], acquaintances: new Map(),
    activity: 'travel', goal: 'work', lastThink: now, nextThink: now + random() * 0.7,
    activityUntil: 0, lastGreeting: -Infinity, lastThreat: -Infinity, lastContact: -Infinity, lastAid: -Infinity,
    bandageAvailable: personality.empathy > 0.45, conversationAt: 0, socialCooldown: 0, aidReceived: false };
}

export function advanceMind(mind: NPCMind, now: number, moving: boolean, panic: number): void {
  const elapsed = clamp(now - mind.lastThink, 0, 10);
  mind.lastThink = now;
  mind.fatigue = clamp(mind.fatigue + elapsed * (mind.activity === 'rest' ? -0.018 : moving ? 0.0018 : -0.0006));
  mind.socialNeed = clamp(mind.socialNeed + elapsed * (mind.activity === 'talk' ? -0.045 : 0.0015 + mind.personality.sociability * 0.002));
  mind.stress = clamp(Math.max(panic * 0.6, mind.stress - elapsed * (now - mind.lastThreat > 8 ? 0.025 : 0.003)));
  mind.pain = clamp(mind.pain - elapsed * 0.006);
  mind.irritation = clamp(mind.irritation - elapsed * 0.012);
  // Fear can settle much earlier than a person's memory of who hurt them.
  mind.suspicion = clamp(mind.suspicion - elapsed * 0.0004);
  mind.episodes = mind.episodes.filter(episode => now - episode.at < 600);
  if (mind.attention && mind.attention.until <= now) mind.attention = undefined;
}

export function rememberIncident(mind: NPCMind, episode: Episode): void {
  const previous = mind.episodes.at(-1);
  // A burst is one experience: no unbounded history and no repeated startle reset.
  if (previous?.kind === episode.kind && episode.at - previous.at < 4 && previous.playerKnown === episode.playerKnown) {
    previous.at = episode.at; previous.severity = Math.max(previous.severity, episode.severity);
    previous.x = episode.x; previous.z = episode.z;
  } else {
    mind.episodes.push({ ...episode });
    if (mind.episodes.length > 8) mind.episodes.shift();
  }
  if (episode.kind === 'help') {
    mind.trust = clamp(mind.trust + 0.35, -1, 1);
    mind.stress *= 0.8;
    return;
  }
  if (episode.kind === 'bump') {
    mind.irritation = clamp(mind.irritation + episode.severity * (1.2 - mind.personality.patience * 0.6));
    return;
  }
  mind.lastThreat = episode.at;
  mind.stress = Math.max(mind.stress, episode.severity);
  if (episode.kind === 'injury') { mind.pain = Math.max(mind.pain, episode.severity); mind.aidReceived = false; }
  if (episode.playerKnown) {
    mind.suspicion = Math.max(mind.suspicion, episode.severity);
    mind.trust = clamp(mind.trust - episode.severity * 0.5, -1, 1);
  }
}

export function recogniseNeighbour(mind: NPCMind, other: number): void {
  const familiarity = mind.acquaintances.get(other) ?? 0;
  mind.acquaintances.delete(other);
  mind.acquaintances.set(other, clamp(familiarity + 0.12));
  if (mind.acquaintances.size > 8) mind.acquaintances.delete(mind.acquaintances.keys().next().value!);
}

export function routineGoal(mind: NPCMind, hour: number, hasRest: boolean, hasShops: boolean): NPCMind['goal'] {
  if (mind.fatigue > 0.62 && hasRest) return 'rest';
  if (hour >= 21 || hour < 7) return 'home';
  if (hasShops && (hour >= 12 && hour < 14 || hour >= 17 && hour < 20) && mind.personality.curiosity > 0.38) return 'browse';
  return 'work';
}

export function greetPerson(mind: NPCMind, now: number, threatened: boolean): { text: string; accepts: boolean } {
  if (threatened) return { text: 'Baja el arma. No quiero problemas.', accepts: false };
  if (mind.suspicion > 0.5) return { text: 'Te recuerdo. Aléjate de mí.', accepts: false };
  if (mind.irritation > 0.55) return { text: 'Déjame espacio, por favor.', accepts: false };
  if (now - mind.lastGreeting < 12) return { text: 'Ahora necesito seguir con lo mío.', accepts: false };
  const familiar = Number.isFinite(mind.lastGreeting);
  mind.lastGreeting = now;
  mind.trust = clamp(mind.trust + 0.06, -1, 1);
  if (mind.stress > 0.25) return { text: 'Oí lo que pasó. Necesito un momento para calmarme.', accepts: true };
  if (mind.pain > 0.2) return { text: 'Me duele todavía. Voy a ir despacio.', accepts: true };
  return { text: familiar ? 'Hola otra vez. Me acuerdo de ti.' : mind.personality.sociability > 0.45 ? 'Hola. ¿Cómo va tu día?' : 'Buenas. Que tengas buen día.', accepts: true };
}
