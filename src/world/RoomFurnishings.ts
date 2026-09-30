import type { RoomPrefab, StructureUse, VoxelComponentPrefab } from './StructurePrefabCatalog';
import { ROOM_PREFABS } from './StructurePrefabCatalog';

const part = (role: string, size: readonly [number,number,number], offset: readonly [number,number,number], paint: string): VoxelComponentPrefab => ({role,size,offset,paint});
/** Compact room modules, authored on the fine lattice. Each fits one furnished
 * cell; circulation and room doors are reserved by the architectural plan. */
const lounge = [
  part('sofa-plinth',[7,1,3],[0,1.5,-2],'#956c54'), part('sofa-seat',[7,2,3],[0,3,-2],'#cf8064'),
  part('sofa-back',[7,4,1],[0,4,-4],'#ad604f'),
  part('table-leg',[1,2,1],[0,2,2],'#705849'), part('coffee-table',[5,1,3],[0,3.5,2],'#d1a873'),
  part('book',[2,1,2],[1,4.5,2],'#4d949c'),
];
const kitchen = [
  part('kitchen-base',[8,4,3],[0,3,-3],'#9bb6ab'), part('worktop',[8,1,4],[0,5.5,-2.5],'#e5d7bb'),
  part('hob',[2,1,2],[-2,6.5,-2],'#3a4b4d'), part('sink',[2,1,2],[2,6.5,-2],'#829ca2'),
  part('fridge',[2,8,3],[-3,5,1],'#dfdece'),
  part('stool',[2,3,2],[2,2.5,2],'#bd8654'),
];
const dining = [
  part('table-base',[2,3,2],[0,2.5,0],'#7f634e'), part('dining-top',[5,1,5],[0,4.5,0],'#dfb77d'),
  part('plate',[2,1,2],[0,5.5,0],'#edf0d8'),
  ...[-4,4].flatMap(x=>[part('chair-legs',[2,2,2],[x,2,0],'#947252'),part('chair-seat',[2,1,3],[x,3.5,0],'#cf9c64'),part('chair-back',[1,3,3],[x+(x<0?-.5:.5),5.5,0],'#cf9c64')]),
];
const shelving = [
  part('shelf-left',[1,8,3],[-3,5,0],'#657979'), part('shelf-right',[1,8,3],[3,5,0],'#657979'),
  ...[1,4,7].flatMap(y=>[part('shelf',[5,1,3],[0,y+.5,0],'#d8bb8c'),
    part('goods',[2,2,2],[-1.5,y+2,0],y===4?'#d8956c':'#83ad94'),part('goods',[2,2,2],[1.5,y+2,0],'#d8c474')]),
];
const office = [
  part('desk-pedestal',[2,4,4],[-2.5,3,-1],'#b6a48b'), part('desktop',[8,1,5],[0,5.5,-1],'#dabd8c'),
  part('desk-leg',[1,4,1],[3,3,-2],'#657b7f'), part('monitor-stand',[1,1,1],[0,6.5,-2],'#445e63'),
  part('monitor',[3,2,1],[0,8,-2],'#426e7b'), part('keyboard',[3,1,1],[0,6.5,0],'#8ba6a3'),
  part('chair-base',[2,3,2],[0,2.5,3],'#5a7274'), part('chair-seat',[3,1,3],[0,4.5,3],'#4e8586'),
  part('chair-back',[3,3,1],[0,6.5,4],'#4e8586'),
];
const machine = [
  part('machine-base',[7,2,5],[0,2,0],'#627b79'),part('machine-bed',[7,2,3],[0,4,0],'#91aba4'),
  part('machine-head',[2,6,3],[-2.5,6,0],'#dba75b'),part('workpiece',[3,2,1],[0,6,0],'#afc9c2'),
  part('control-console',[2,3,2],[2.5,5.5,1.5],'#427980'),
];

export function roomParts(station: RoomPrefab['station'], variant: number, use?: StructureUse, level = 0): readonly VoxelComponentPrefab[] {
  const choice = Math.abs(variant) % 3;
  if (station === 'ceilingLight' || station === 'partition') return ROOM_PREFABS[station].parts;
  if (station === 'rest') {
    if (use === 'hotel' && level > 0) return ROOM_PREFABS.rest.parts;
    return [lounge, level === 0 ? dining : ROOM_PREFABS.rest.parts, kitchen][choice];
  }
  if (station === 'cabinet') return choice === 0 ? ROOM_PREFABS.cabinet.parts : shelving;
  if (station === 'shop') return choice === 0 ? ROOM_PREFABS.shop.parts : shelving;
  if (station === 'reception') return level > 0 || choice === 2 ? office : ROOM_PREFABS.reception.parts;
  if (station === 'workshop') return choice === 1 ? machine : ROOM_PREFABS.workshop.parts;
  if (station === 'supply') return use === 'house' || use === 'apartment' ? kitchen : shelving;
  return [];
}
