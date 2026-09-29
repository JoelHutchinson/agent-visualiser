// Shared shapes for the pixel-office renderers.
import type { Agent, ModelListener } from './model';

export type Dir = 'down' | 'right' | 'up' | 'left';
export type Pose = 'stand' | 'sit';
export type CountType = 'research' | 'code' | 'bug';
export interface Point { x: number; y: number }

/** One unit of choreography: `run` returns true when the step is finished. */
export interface Step { run(dt: number): boolean }

// ------------------------------------------------------------- characters
export interface CharSpec { skin: number; outfit?: number; suit?: number; hair?: number; tint?: [number, number, number] }
export type SitSprite = HTMLCanvasElement & { hip: number; skin: string; sleeve: string; shoulder: number; front: number };
export type FrontSprite = HTMLCanvasElement & { hip: number };
export interface Character { spec: CharSpec; frames: HTMLCanvasElement[]; sit: SitSprite; front: FrontSprite }

export interface Imgs {
  office: HTMLImageElement; body: HTMLImageElement; shadow: HTMLImageElement; hairs: HTMLImageElement; suit: HTMLImageElement;
  outfits: (HTMLImageElement | null)[];
}

// ---------------------------------------------------------------- seating
/** A place to sit. Tower seats slide the chair sideways (dx), office seats roll it (dy). */
export interface Seat {
  facing: Dir;
  /** Front-facing desk seat (manager, boss, reception). */
  front?: boolean;
  kind?: string;
  seatX: number; seatY: number;
  dx: number; dy: number;
  approach: Point;
  occupant: Person | null;
  reserved: boolean;
  // Tower cubicle seats.
  deskX?: number; deskY?: number; chairX?: number; chairY?: number; monX?: number; monY?: number;
  kbX?: number; kbY?: number; towerX?: number; towerY?: number; chairColor?: string; tower?: string;
  // Office seats.
  room?: MegaRoom; pod?: { room: MegaRoom; x: number; y: number }; desk?: Prop;
}

export interface Person {
  ch: Character;
  role: string;
  agent: Agent | null;
  x: number; y: number; dir: Dir; moving: boolean; t: number; pose: Pose;
  seat: Seat | null;
  /** The desk this person belongs to (where they return after an errand). */
  homeSeat?: Seat | null;
  working: boolean;
  script: Step[];
  hop: number; shake: number; glance: number; pressure: number;
  emote: 'yes' | 'no' | null; emoteT: number; nod: number; shakeHead: number;
  visible: boolean;
  lastBeat?: number;
  /** Number of wait-for-user blocks showing the "..." bubble at the desk. */
  blocked: number;
  // View-specific state.
  room?: MegaRoom | null;
  /** Activity shown at the desk (on the monitor), with the remote prop it lights up. */
  activity?: { kind: string; act: unknown; rack?: Prop; board?: Prop; t: number; next: number } | null;
  kickoffUntil?: number;
  floor?: TowerFloor | null;
  home?: TowerFloor;
  rideQueued?: boolean;
}

// --------------------------------------------------------- mega office data
export interface Spot { x: number; y: number; dir: Dir; room: MegaRoom; sit?: boolean; user?: Person | null; board?: Prop; rack?: Prop }

export interface Prop {
  s: HTMLCanvasElement | null;
  draw: ((p: Prop) => void) | null;
  x: number; y: number; w?: number; h?: number; sort: number;
  solid: { x: number; y: number; w: number; h: number } | null;
  ink?: { x: number; y: number; w: number; c: string }[];
  busy?: boolean; fail?: number;
}

export interface MegaRoom {
  kind: string; x0: number; y0: number; x1: number; y1: number;
  doors: [number, number][];
  floor: string; face: string; name: string; color: string;
  counts: Record<CountType, number>; flash: number; flashColor: string;
  seats: Seat[]; mgr: Agent | null; annex: boolean;
  ix: number; iy: number; iw: number; ih: number;
  desk?: Seat;
}

// ------------------------------------------------------------- tower data
export interface TowerFloor {
  mgr?: Agent; annex?: boolean; lobby?: boolean;
  y: number; ty: number; built?: number;
  counts?: Record<CountType, number>; flash?: number; flashColor?: string;
  blocks?: { x: number; y: number }[];
  seats?: Seat[]; desk?: Seat; tone?: number; color?: string;
  people?: Person[];
}

// ------------------------------------------------------------------- host
/** What the renderers need from the page around them (HUD, counters, layout). */
export interface Host {
  /** Replace the HUD counters (session resync). */
  setCounts(c: Record<CountType, number>): void;
  /** One counted event has arrived visually: bump its counter. */
  count(type: CountType): void;
  /** Fly a bubble from a viewport point into its counter; counts when it lands. */
  fly(from: Point, type: CountType): void;
  /** Speech bubble that follows a moving viewport point. */
  say(text: string, at: () => Point, secs?: number): void;
  /** Space covered by HUD chrome at the top and bottom of the stage, in CSS px. */
  insets(): { top: number; bottom: number };
}

// ------------------------------------------------------------------- view
/** A renderer: acts out the model's happenings on a canvas. */
export interface OfficeView extends ModelListener {
  readonly kind: 'mega' | 'tower';
  /** Frame everything (tower: toggle overview). */
  fit(): void;
  fitLabel(): string;
  /** Short status text pieces for the HUD. */
  info(): { label: string; teams: number };
  destroy(): void;
}
