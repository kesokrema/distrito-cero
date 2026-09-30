/** Streets and building entrances share a level urban datum. Height changes
 * belong to explicit connected surfaces (plazas, ramps, stairs and bridges),
 * so neighboring parcels cannot accidentally bank an entire road sideways. */
export class UrbanTerrain {
  readonly canalColumn:number;
  constructor(readonly roadX:number[],readonly roadZ:number[],private center:number,private size:number) {
    this.canalColumn=Math.min(roadX.length-3,this.index(center,roadX)+2);
  }
  private index(value:number,axis:number[]):number {
    let lo=0,hi=axis.length-2;
    while(lo<=hi){const m=(lo+hi)>>1;if(value<axis[m])hi=m-1;else if(value>=axis[m+1])lo=m+1;else return m;}
    return Math.max(0,Math.min(axis.length-2,lo));
  }
  plateau(_bx:number,_bz:number):number {return 0;}
  height(_x:number,_z:number):number {return 0;}
  canalBounds():{x0:number;x1:number} {
    const middle=(this.roadX[this.canalColumn]+this.roadX[this.canalColumn+1]+3)/2;
    return {x0:(middle-1.5-this.center)*this.size,x1:(middle+1.5-this.center)*this.size};
  }
  channelAt(x:number,_z:number):boolean {
    const bounds=this.canalBounds();
    return x>=bounds.x0&&x<=bounds.x1;
  }
  cutoutAt(x:number,z:number):boolean {
    const bounds=this.canalBounds();if(x<bounds.x0-2.2||x>bounds.x1+2.2)return false;
    const gz=z/this.size+this.center,bz=this.index(gz+.5,this.roadZ);
    return gz-this.roadZ[bz]>2.5;
  }
  waterAt(x:number,z:number):boolean {
    if(!this.channelAt(x,z))return false;
    const gz=z/this.size+this.center,bz=this.index(gz+.5,this.roadZ);
    return gz-this.roadZ[bz]>2.5; // roads cross above the continuous canal
  }
}
