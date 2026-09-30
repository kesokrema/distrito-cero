/// <reference lib="webworker" />
import { SparsePathfinder, type PathAvoidance } from '../core/Pathfinding';
let navigation = new SparsePathfinder(1025);
type NavigationCells = { indexes: Uint32Array; blocked: Uint8Array; costs?: Uint8Array; heights?:Float32Array };
type PathRequest = ({ type: 'init'; size: number } & NavigationCells) | ({ type: 'update' } & NavigationCells) | { type: 'path'; id: number; start: number; goal: number; avoid?: PathAvoidance };
self.onmessage = (event: MessageEvent<PathRequest>) => {
  const message = event.data;
  if (message.type === 'init') navigation = new SparsePathfinder(message.size);
  if (message.type !== 'path') { navigation.update(message.indexes, message.blocked, message.costs,message.heights); return; }
  self.postMessage({ id: message.id, path: navigation.find(message.start, message.goal, message.avoid) });
};
export {};
