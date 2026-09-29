// DOM effects layered over the canvas: count bubbles that fly into the HUD
// counters, and speech bubbles that follow a person.
import type { CountType, Point } from './types';

const GLYPH: Record<CountType, string> = { research: '?', code: '<>', bug: '!' };
const COLOR: Record<CountType, string> = { research: 'var(--research)', code: 'var(--code)', bug: 'var(--bug)' };

export interface FxOptions {
  /** Fixed-position layer the bubbles live in. */
  layer: HTMLElement;
  counterEl(type: CountType): HTMLElement | undefined;
  /** A bubble landed: bump its counter. */
  onLand(type: CountType): void;
}

export function createFx({ layer, counterEl, onLand }: FxOptions) {
  const live = new Set<HTMLElement>();
  let dead = false;

  /** Run `tick` every frame until it returns false; the element is removed at the end. */
  function animate(el: HTMLElement, tick: (now: number) => boolean, done?: () => void): void {
    layer.appendChild(el); live.add(el);
    const frame = (now: number) => {
      if (dead || !live.has(el)) return;
      if (tick(now)) requestAnimationFrame(frame);
      else { el.remove(); live.delete(el); done?.(); }
    };
    requestAnimationFrame(frame);
  }

  return {
    /** Bubble from a viewport point into its counter; counts when it lands. */
    fly(from: Point, type: CountType): void {
      const target = counterEl(type);
      if (!target) return onLand(type);
      const el = document.createElement('div');
      el.className = 'bubble'; el.style.background = COLOR[type]; el.textContent = GLYPH[type];
      const tr = target.getBoundingClientRect(), to = { x: tr.right - 18, y: tr.top + tr.height / 2 };
      const start = performance.now();
      animate(el, (now) => {
        const t = Math.min(1, (now - start) / 1100), pop = Math.min(1, t / 0.2), fly = Math.max(0, (t - 0.2) / 0.8);
        const e = Math.floor((fly < 0.5 ? 4 * fly ** 3 : 1 - (-2 * fly + 2) ** 3 / 2) * 24) / 24;
        const cx = (from.x + to.x) / 2, cy = Math.min(from.y, to.y) - 80;
        const x = (1 - e) ** 2 * from.x + 2 * (1 - e) * e * cx + e ** 2 * to.x, y = (1 - e) ** 2 * (from.y - 24 * pop) + 2 * (1 - e) * e * cy + e ** 2 * to.y;
        el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) scale(${pop < 1 ? 0.6 : 1})`;
        return t < 1;
      }, () => onLand(type));
    },
    /** Speech bubble that follows a moving viewport point. */
    say(text: string, at: () => Point, secs = 1.8): void {
      const el = document.createElement('div');
      el.className = 'say'; el.textContent = text;
      const start = performance.now();
      animate(el, (now) => {
        const s = at();
        el.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px) translate(-50%, -100%)`;
        return now - start < secs * 1000;
      });
    },
    destroy(): void {
      dead = true;
      for (const el of live) el.remove();
      live.clear();
    },
  };
}
