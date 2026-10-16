/// <reference lib="webworker" />
import {meshGround,type GroundRequest} from '../world/GroundMesher';
self.onmessage=(event:MessageEvent<GroundRequest>)=>{
 const result=meshGround(event.data);
 self.postMessage(result,[result.positions.buffer,result.uvs.buffer,result.indexes.buffer,result.bankPositions.buffer,result.bankIndexes.buffer]);
};
export {};
