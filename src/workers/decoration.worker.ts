/// <reference lib="webworker" />
import { meshDecorationPieces, type DecorationRequest } from '../world/DecorationMesher';
self.onmessage=(event:MessageEvent<DecorationRequest>)=>{
  const {id,revision,gridSize,pieces,latticeOffset}=event.data;
  const surface=meshDecorationPieces(pieces,gridSize,latticeOffset);
  self.postMessage({id,revision,...surface},[surface.positions.buffer,surface.normals.buffer,surface.colors.buffer,
    surface.indexes.buffer,surface.voxelForFace.buffer]);
};
export {};
