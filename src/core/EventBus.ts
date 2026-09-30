export type GameEvents = {
  blast: { x: number; z: number; radius: number; source: 'player' | 'enemy' };
  terrainChanged: { cells: number[] };
  alert: { text: string; tone: 'info' | 'danger' | 'success' };
  npcLost: { kind: 'civilian' | 'enemy'; leader: boolean };
  environment: { x: number; z: number; kind: 'water' | 'electric' };
  gunshot: { x: number; z: number; radius: number };
  enemyShot: { fromX: number; fromY: number; fromZ: number; toX: number; toY: number; toZ: number; hit: boolean; heavy: boolean };
  playerRunOver: { dx: number; dz: number; force: number };
  blood: { x: number; y: number; z: number; dx: number; dy: number; dz: number; count: number; floor: number };
};

type Listener<K extends keyof GameEvents> = (payload: GameEvents[K]) => void;

export class EventBus {
  private listeners = new Map<keyof GameEvents, Set<(payload: never) => void>>();

  on<K extends keyof GameEvents>(event: K, listener: Listener<K>): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener as (payload: never) => void);
    return () => this.listeners.get(event)?.delete(listener as (payload: never) => void);
  }

  emit<K extends keyof GameEvents>(event: K, payload: GameEvents[K]): void {
    this.listeners.get(event)?.forEach((listener) => listener(payload as never));
  }
}
