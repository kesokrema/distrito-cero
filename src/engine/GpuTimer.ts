type TimerExtension={TIME_ELAPSED_EXT:number;GPU_DISJOINT_EXT:number};
/** Debug-only GPU timestamps. Poll availability; never synchronously read back. */
export class GpuTimer {
  private readonly extension:TimerExtension|null;
  private readonly pending:WebGLQuery[]=[];
  private active:WebGLQuery|null=null;
  private frames=0;
  constructor(private gl:WebGL2RenderingContext,enabled:boolean,private record:(ms:number)=>void) {
    this.extension=enabled?gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExtension|null:null;
  }
  get available():boolean{return this.extension!==null;}
  begin():void {
    const ext=this.extension;if(!ext)return;
    const disjoint=this.gl.getParameter(ext.GPU_DISJOINT_EXT);
    while(this.pending.length) {
      const query=this.pending[0];
      if(!disjoint&&!this.gl.getQueryParameter(query,this.gl.QUERY_RESULT_AVAILABLE))break;
      this.pending.shift();
      if(!disjoint)this.record(this.gl.getQueryParameter(query,this.gl.QUERY_RESULT)/1e6);
      this.gl.deleteQuery(query);
    }
    if(++this.frames%30||this.pending.length>=3||this.active)return;
    this.active=this.gl.createQuery();if(this.active)this.gl.beginQuery(ext.TIME_ELAPSED_EXT,this.active);
  }
  end():void {if(!this.active||!this.extension)return;this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);this.pending.push(this.active);this.active=null;}
  dispose():void{this.end();this.pending.forEach(query=>this.gl.deleteQuery(query));this.pending.length=0;}
}
