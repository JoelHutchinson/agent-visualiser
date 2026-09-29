import { Application, Container, Graphics, Text } from 'pixi.js';
import type { EventType } from '../../src/shared/events.js';

type BubbleType = Exclude<EventType, 'idle'>;

export const BUBBLE_COLORS: Record<BubbleType, number> = {
  research: 0x4a9eff,
  code: 0x3ecf6e,
  bug: 0xff5a5a,
};

const GLYPH: Record<BubbleType, string> = { research: '?', code: '</>', bug: '!' };

// Scene is drawn in a fixed virtual space and scaled to fit the canvas.
const W = 640;
const H = 360;

interface Bubble {
  type: BubbleType;
  node: Container;
  label: Text | undefined;
  age: number;
  from: { x: number; y: number };
  to: { x: number; y: number };
}

export interface SceneOptions {
  /** Where the counter for a bubble type sits, in canvas pixels. */
  targetFor: (type: BubbleType) => { x: number; y: number };
  onLand: (type: BubbleType) => void;
}

const POP_MS = 350;
const FLY_MS = 900;
const SPAWN_GAP_MS = 140;
const MAX_QUEUE = 12;

/**
 * Placeholder-art studio: a dev at a desk who types while the agent works and
 * leans back when it waits. Bubbles pop above the dev and fly to the counters.
 */
export class Scene {
  private app = new Application();
  private world = new Container();
  private bubbleLayer = new Container();
  private torso = new Container();
  private leftArm = new Graphics();
  private rightArm = new Graphics();
  private screenGlow = new Graphics();
  private codeLines = new Graphics();
  private head = new Container();

  private bubbles: Bubble[] = [];
  private queue: { type: BubbleType; tool?: string }[] = [];
  private sinceSpawn = SPAWN_GAP_MS;
  private idle = true;
  private lean = 1; // 0 = typing upright, 1 = leaning back
  private time = 0;
  private shake = 0;
  private destroyed = false;
  private observer: ResizeObserver | undefined;

  constructor(private readonly opts: SceneOptions) {}

  async mount(host: HTMLElement): Promise<void> {
    await this.app.init({
      resizeTo: host,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
    });
    if (this.destroyed) {
      this.app.destroy(true);
      return;
    }
    host.appendChild(this.app.canvas);
    this.app.canvas.style.display = 'block';
    this.build();
    this.app.stage.addChild(this.world, this.bubbleLayer);
    this.app.renderer.on('resize', () => this.layout());
    // resizeTo only listens for window resizes; also follow the host element.
    this.observer = new ResizeObserver(() => this.app.resize());
    this.observer.observe(host);
    this.layout();
    this.app.ticker.add((t) => this.tick(t.deltaMS));
  }

  destroy(): void {
    this.destroyed = true;
    this.observer?.disconnect();
    if (this.app.renderer) this.app.destroy(true, { children: true });
  }

  setIdle(idle: boolean): void {
    this.idle = idle;
  }

  spawn(type: BubbleType, tool?: string): void {
    this.queue.push({ type, tool });
    // Never let a burst (fast replay, reconnect) build an ever-growing backlog:
    // land the overflow straight away.
    while (this.queue.length > MAX_QUEUE) this.opts.onLand(this.queue.shift()!.type);
  }

  /** Drop everything in flight (a new session snapshot replaces the counts). */
  clear(): void {
    this.queue = [];
    for (const b of this.bubbles) b.node.destroy({ children: true });
    this.bubbles = [];
  }

  // ---------------------------------------------------------------- drawing

  private build(): void {
    const w = this.world;

    // Back wall, window and floor.
    w.addChild(new Graphics().rect(0, 0, W, 250).fill(0x2a2f45));
    w.addChild(new Graphics().rect(0, 250, W, 110).fill(0x3b3350));
    w.addChild(new Graphics().rect(0, 246, W, 6).fill(0x22263a));
    const win = new Graphics().roundRect(70, 50, 150, 110, 6).fill(0x1b2a4a).stroke({ width: 6, color: 0x4a5070 });
    win.rect(143, 50, 4, 110).fill(0x4a5070);
    for (const [x, y] of [[95, 80], [180, 70], [120, 130], [200, 120]]) win.circle(x, y, 1.6).fill(0xfff4c2);
    w.addChild(win);
    // Poster and plant for a bit of life.
    w.addChild(new Graphics().roundRect(470, 60, 70, 90, 4).fill(0x6a4c93).stroke({ width: 3, color: 0x8a6cb3 }));
    w.addChild(new Graphics().roundRect(563, 205, 26, 40, 4).fill(0xa0522d).ellipse(576, 196, 24, 20).fill(0x2e8b57));

    // Desk.
    const desk = new Graphics();
    desk.roundRect(300, 222, 250, 14, 3).fill(0x9c6b3f);
    desk.rect(312, 236, 12, 90).fill(0x7a5230);
    desk.rect(526, 236, 12, 90).fill(0x7a5230);
    w.addChild(desk);

    // Monitor (facing the dev, who sits to the left).
    const monitor = new Container();
    monitor.addChild(new Graphics().rect(452, 200, 30, 22).fill(0x555a70));
    monitor.addChild(new Graphics().roundRect(420, 130, 96, 74, 6).fill(0x1c1f2b).stroke({ width: 4, color: 0x555a70 }));
    this.screenGlow.roundRect(426, 136, 84, 62, 3).fill(0x16324a);
    monitor.addChild(this.screenGlow, this.codeLines);
    w.addChild(monitor);
    w.addChild(new Graphics().roundRect(370, 214, 50, 8, 2).fill(0xd0d4e0)); // keyboard
    w.addChild(new Graphics().roundRect(320, 206, 18, 16, 3).fill(0xe8e8e8).rect(338, 210, 5, 7).fill(0xe8e8e8)); // mug

    // Chair.
    const chair = new Graphics();
    chair.roundRect(232, 236, 90, 12, 4).fill(0x33374d);
    chair.rect(272, 248, 8, 50).fill(0x22263a);
    chair.rect(246, 296, 60, 6).fill(0x22263a);
    w.addChild(chair);

    // Legs (static) and torso (pivots at the hip to lean back).
    w.addChild(new Graphics().roundRect(268, 226, 70, 18, 8).fill(0x2f4d7a).roundRect(322, 226, 18, 80, 8).fill(0x2f4d7a));
    w.addChild(new Graphics().roundRect(318, 300, 30, 10, 4).fill(0x222222));

    this.torso.position.set(282, 232);
    const body = new Graphics().roundRect(-24, -78, 48, 82, 16).fill(0xe07a3f);
    this.torso.addChild(body);
    this.head.position.set(4, -100);
    const face = new Graphics();
    face.circle(0, 0, 24).fill(0xf1c27d);
    face.arc(0, -4, 25, Math.PI * 1.05, Math.PI * 1.95).fill(0x3a2a1e); // hair
    face.circle(12, 2, 2.6).fill(0x222222); // eye (profile, facing right)
    face.roundRect(20, 6, 6, 4, 2).fill(0xe0a96d); // nose
    this.head.addChild(face);
    this.torso.addChild(this.head, this.leftArm, this.rightArm);
    w.addChild(this.torso);
  }

  private drawArms(): void {
    // Arms reach to the keyboard when typing and rest in the lap when idle.
    const typingReach = 1 - this.lean;
    const tap = (phase: number) => (this.idle ? 0 : Math.max(0, Math.sin(this.time / 70 + phase)) * 5);
    const armTo = (g: Graphics, shoulderY: number, phase: number, color: number) => {
      const hx = 20 + typingReach * 80;
      const hy = -20 + typingReach * -4 - tap(phase);
      g.clear()
        .moveTo(6, shoulderY)
        .lineTo(hx, hy)
        .stroke({ width: 13, color, cap: 'round' })
        .circle(hx + 4, hy, 7)
        .fill(0xf1c27d);
    };
    armTo(this.leftArm, -58, 0, 0xc9662f);
    armTo(this.rightArm, -54, Math.PI, 0xe07a3f);
  }

  private drawScreen(): void {
    this.codeLines.clear();
    const busy = !this.idle;
    this.screenGlow.tint = this.shake > 0 ? 0xff9090 : busy ? 0xffffff : 0x8090a0;
    const lines = busy ? 6 : 3;
    const scroll = busy ? Math.floor(this.time / 250) : 0;
    for (let i = 0; i < lines; i++) {
      const seed = (i + scroll) * 9301 + 49297;
      const len = 16 + (seed % 233280) / 233280 * 50;
      const indent = ((seed >> 3) % 3) * 6;
      this.codeLines.roundRect(432 + indent, 142 + i * 9, len, 4, 2).fill(busy ? 0x7fd1ff : 0x4a6a80);
    }
  }

  private layout(): void {
    const { width, height } = this.app.screen;
    const scale = Math.min(width / W, height / H);
    this.world.scale.set(scale);
    this.world.position.set((width - W * scale) / 2, (height - H * scale) / 2);
  }

  // -------------------------------------------------------------- animation

  private tick(dt: number): void {
    this.time += dt;

    const target = this.idle ? 1 : 0;
    this.lean += (target - this.lean) * Math.min(1, dt / 180);
    this.torso.rotation = -0.32 * this.lean;
    this.head.rotation = -0.1 * this.lean + (this.idle ? Math.sin(this.time / 900) * 0.04 : Math.sin(this.time / 140) * 0.03);
    this.shake = Math.max(0, this.shake - dt);
    this.torso.x = 282 + (this.shake > 0 ? Math.sin(this.time / 18) * 2 : 0);
    this.drawArms();
    this.drawScreen();

    this.sinceSpawn += dt;
    if (this.queue.length && this.sinceSpawn >= SPAWN_GAP_MS) {
      const next = this.queue.shift()!;
      this.launch(next.type, next.tool);
      this.sinceSpawn = 0;
    }

    for (const b of [...this.bubbles]) this.stepBubble(b, dt);
  }

  private launch(type: BubbleType, tool?: string): void {
    if (type === 'bug') this.shake = 400;
    const node = new Container();
    const color = BUBBLE_COLORS[type];
    node.addChild(new Graphics().circle(0, 0, 16).fill(color).stroke({ width: 3, color: 0xffffff, alpha: 0.85 }));
    node.addChild(new Graphics().circle(-5, -6, 4).fill({ color: 0xffffff, alpha: 0.5 }));
    const glyph = new Text({
      text: GLYPH[type],
      style: { fill: 0xffffff, fontSize: GLYPH[type].length > 1 ? 11 : 16, fontWeight: '800', fontFamily: 'system-ui, sans-serif' },
    });
    glyph.anchor.set(0.5);
    node.addChild(glyph);

    let label: Text | undefined;
    if (tool) {
      label = new Text({
        text: tool,
        style: { fill: 0xffffff, fontSize: 11, fontFamily: 'ui-monospace, monospace', fontWeight: '600' },
      });
      label.anchor.set(0.5, 0);
      label.position.set(0, 20);
      node.addChild(label);
    }

    // Start just above the keyboard, a little scattered.
    const origin = this.world.toGlobal({ x: 380 + (Math.random() - 0.5) * 60, y: 170 });
    node.position.copyFrom(origin);
    node.scale.set(0);
    this.bubbleLayer.addChild(node);
    this.bubbles.push({ type, node, label, age: 0, from: { x: origin.x, y: origin.y - 50 }, to: this.opts.targetFor(type) });
  }

  private stepBubble(b: Bubble, dt: number): void {
    b.age += dt;
    const { node } = b;
    if (b.age < POP_MS) {
      // Pop up with a little overshoot.
      const t = b.age / POP_MS;
      const s = 1 + 0.25 * Math.sin(t * Math.PI);
      node.scale.set(t * s);
      node.y = b.from.y + 50 * (1 - easeOut(t));
      return;
    }
    const t = Math.min(1, (b.age - POP_MS) / FLY_MS);
    const e = easeInOut(t);
    // Quadratic arc that swings up and over to the counter.
    const cx = (b.from.x + b.to.x) / 2;
    const cy = Math.min(b.from.y, b.to.y) - 80;
    node.x = (1 - e) ** 2 * b.from.x + 2 * (1 - e) * e * cx + e ** 2 * b.to.x;
    node.y = (1 - e) ** 2 * b.from.y + 2 * (1 - e) * e * cy + e ** 2 * b.to.y;
    node.scale.set(1 - 0.5 * e);
    if (b.label) b.label.alpha = 1 - Math.min(1, t * 3);
    if (t >= 1) {
      this.bubbles.splice(this.bubbles.indexOf(b), 1);
      node.destroy({ children: true });
      this.opts.onLand(b.type);
    }
  }
}

const easeOut = (t: number) => 1 - (1 - t) ** 3;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
