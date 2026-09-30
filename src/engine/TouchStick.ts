import { Vector2 } from 'three';

/** A captured thumb can leave the pad without losing its analog movement. */
export class TouchStick {
  readonly value = new Vector2();
  private pointer: number | null = null;
  private readonly nub: HTMLElement;
  constructor(private pad: HTMLElement, private activate: () => void) {
    this.nub = pad.querySelector<HTMLElement>('.touch-nub')!;
    pad.addEventListener('pointerdown', event => {
      if (this.pointer !== null) return;
      event.preventDefault(); this.activate(); this.pointer = event.pointerId;
      pad.setPointerCapture(event.pointerId); this.move(event);
      pad.dataset.active = 'true';
    });
    pad.addEventListener('pointermove', event => {
      if (event.pointerId === this.pointer) { event.preventDefault(); this.move(event); }
    });
    const end = (event: PointerEvent) => { if (event.pointerId === this.pointer) this.reset(); };
    pad.addEventListener('pointerup', end); pad.addEventListener('pointercancel', end);
    pad.addEventListener('lostpointercapture', end);
    window.addEventListener('blur', () => this.reset());
  }
  private move(event: PointerEvent): void {
    const rect = this.pad.getBoundingClientRect(), radius = rect.width * .34;
    const dx = event.clientX - rect.left - rect.width / 2;
    const dy = event.clientY - rect.top - rect.height / 2;
    const length = Math.hypot(dx,dy), strength = Math.min(1,length/radius);
    const analog = strength < .1 ? 0 : (strength-.1)/.9;
    this.value.set(length ? dx/length*analog : 0, length ? dy/length*analog : 0);
    this.nub.style.transform = `translate(${this.value.x*radius}px, ${this.value.y*radius}px)`;
  }
  reset(): void { this.pointer=null; this.value.set(0,0); this.nub.style.transform='translate(0,0)'; this.pad.dataset.active='false'; }
}
