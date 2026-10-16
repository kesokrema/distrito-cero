export type QualityMode = 'auto' | 'low' | 'medium' | 'high';
export type QualityLevel = Exclude<QualityMode, 'auto'>;
export const QUALITY = {
  low: { pixelRatio: .8, shadows: false, shadowSize: 512, viewDistance: 105 },
  medium: { pixelRatio: 1, shadows: true, shadowSize: 1024, viewDistance: 135 },
  high: { pixelRatio: 1.25, shadows: true, shadowSize: 1024, viewDistance: 155 }
} as const;

/** Hysteresis prevents resolution flicker. Streaming stalls cannot trigger it. */
export class RenderQuality {
  mode: QualityMode;
  level: QualityLevel;
  private time = 0;
  private samples = 0;
  private sum = 0;
  private badWindows = 0;
  private goodWindows = 0;
  constructor(mobile: boolean, mode: QualityMode = 'auto') {
    this.mode=mode;this.level=mode==='auto'?(mobile?'low':'high'):mode;
  }
  set(mode: QualityMode): boolean {
    this.mode=mode;this.reset();
    if(mode==='auto')return false;
    const changed=this.level!==mode;this.level=mode;return changed;
  }
  private reset():void{this.time=0;this.samples=0;this.sum=0;this.badWindows=0;this.goodWindows=0;}
  sample(frameMs: number, elapsed: number, busy: boolean): boolean {
    if(this.mode!=='auto')return false;
    if(busy){this.reset();return false;}
    this.time+=elapsed;this.sum+=frameMs;this.samples++;
    if(this.time<2)return false;
    const average=this.sum/Math.max(1,this.samples);
    this.badWindows=average>22?this.badWindows+1:0;
    this.goodWindows=average<18?this.goodWindows+1:0;
    this.time=0;this.sum=0;this.samples=0;
    const levels:QualityLevel[]=['low','medium','high'],index=levels.indexOf(this.level);
    if(this.badWindows>=2&&index>0){this.level=levels[index-1];this.reset();return true;}
    if(this.goodWindows>=6&&index<2){this.level=levels[index+1];this.reset();return true;}
    return false;
  }
}
