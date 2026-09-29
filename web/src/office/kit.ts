// Shared pixel-office kit: drawing, poses, movement and choreography used by
// the office and tower views. Everything draws into one 2D context in logical
// pixels; callers pass an (ox, oy) offset for their coordinate space.
import { OFFICE, DIR, makeCharacter, type OfficeSprite } from './sprites';
import type { Agent } from './model';
import type { CharSpec, Character, Dir, Imgs, Person, Seat, Step } from './types';

export const LOOKS: CharSpec[] = [
  { skin: 1, outfit: 5, hair: 0 }, { skin: 3, outfit: 6, hair: 6 }, { skin: 2, outfit: 4, hair: 3 },
  { skin: 5, outfit: 2, hair: 7 }, { skin: 0, outfit: 3, hair: 2 }, { skin: 4, outfit: 1, hair: 5 },
  { skin: 2, outfit: 6, hair: 4 }, { skin: 1, outfit: 4, hair: 7 }, { skin: 3, outfit: 5, hair: 1 },
];
export const MANAGER_LOOKS: CharSpec[] = [
  { skin: 3, suit: 2, hair: 6 }, { skin: 1, suit: 2, hair: 0 }, { skin: 5, suit: 2, hair: 7 },
  { skin: 2, suit: 2, hair: 3 }, { skin: 4, suit: 2, hair: 5 }, { skin: 0, suit: 2, hair: 4 },
];
export const BOSS_LOOK: CharSpec = { skin: 0, suit: 2, hair: 1 };
export const YOU_LOOK: CharSpec = { skin: 2, outfit: 1, hair: 2 };

/** Look for an agent: stable per agent (by arrival number), by role. */
export function lookFor(a: Agent): CharSpec {
  return a.role === 'orchestrator' ? BOSS_LOOK : a.role === 'manager' ? MANAGER_LOOKS[a.seq % MANAGER_LOOKS.length] : LOOKS[a.seq % LOOKS.length];
}

// Floor palettes per department.
export const TONES = [
  ['#c98f58', '#c28651', '#d19962', '#bd814c', '#cc935c'],   // oak
  ['#8f5b3a', '#865334', '#986342', '#7f4e30', '#915d3c'],   // walnut
  ['#d8c09a', '#d0b890', '#e0c8a2', '#ccb28a', '#d6bd96'],   // ash
  ['#a8584a', '#9f5144', '#b06050', '#994c40', '#a95a4b'],   // cherry
  ['#7b8fa6', '#72869d', '#8397ae', '#6d8198', '#7a8ea5'],   // slate carpet
];
export const ZONE_COLORS = ['#e8b94a', '#6ec3ff', '#8be07b', '#ff8fa3', '#c79bff', '#ffb36b'];

export function mulberry(a: number): () => number {
  return () => { a |= 0; a = a + 0x6d2b79f5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

// 3x5 bitmap font so labels stay crisp at any scale.
const FONT: Record<string, string> = {
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111', F: '111100110100100',
  G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010', K: '101101110101101', L: '100100100100111',
  M: '101111111101101', N: '110101101101101', O: '010101101101010', P: '110101110100100', Q: '010101101110011', R: '110101110101101',
  S: '011100010001110', T: '111010010010010', U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101',
  Y: '101101010010010', Z: '111001010100111', 0: '111101101101111', 1: '010110010010111', 2: '110001010100111', 3: '110001010001110',
  4: '101101111001001', 5: '111100110001110', 6: '011100111101111', 7: '111001010010010', 8: '111101111101111', 9: '111101111001110',
  ' ': '000000000000000', '-': '000000111000000', '.': '000000000000010', '>': '100010001010100', '!': '010010010000010',
  '?': '110001010000010', '/': '001001010100100', ':': '000010000010000', '+': '000010111010000', '#': '101111101111101', '&': '010101010101011',
};
export const textWidth = (s: string, k = 1) => s.length * 4 * k - k;
/** Make arbitrary text safe for the bitmap font: upper case, known glyphs only, trimmed to `max`. */
export function label(s: string, max = 18): string {
  const t = s.toUpperCase().replace(/[^A-Z0-9 \-.>!?/:+#&]/g, ' ').replace(/\s+/g, ' ').trim();
  return (t.length > max ? t.slice(0, max - 1).trimEnd() + '.' : t) || '?';
}

/** Two cubicle seats (tower). */
export function blockSeats(b: { x: number; y: number }, chairOffset = 0): Seat[] {
  return [0, 1].map((s) => {
    const ox = b.x + 2 + s * 40;
    const seat: Seat = {
      chairX: ox + 1, chairY: b.y + 8, deskX: ox + 21, deskY: b.y + 10, monX: ox + 23, monY: b.y + 2,
      kbX: ox + 17, kbY: b.y + 12, towerX: ox + 24, towerY: b.y + 21,
      chairColor: ['chairWhite', 'chairBlue', 'chairGrey', 'chairGreen', 'chairOrange', 'chairYellow'][(chairOffset + s) % 6],
      tower: ['towerRed', 'towerBlue', 'towerGreen'][(chairOffset + s) % 3],
      dx: 0, dy: 0, occupant: null, reserved: false, facing: 'right',
      seatX: ox + 1 + 6, seatY: b.y + 8 + 13, approach: { x: ox + 1 + 2, y: b.y + 8 + 26 },
    };
    return seat;
  });
}
/** A front-facing seat behind a desk (managers, the boss, reception). */
export function deskSeat(x: number, y: number, kind = 'manager'): Seat {
  return { front: true, kind, facing: 'down', deskX: x, deskY: y, seatX: x + 20, seatY: y + 2, dx: 0, dy: 0, occupant: null, reserved: false, approach: { x: x + 48, y: y + 16 } };
}

// ----------------------------------------------------------- choreography
export const step = (run: (dt: number) => boolean): Step => ({ run });
export const call = (fn: () => void): Step => step(() => (fn(), true));
export const wait = (s: number): Step => { let t = 0; return step((dt) => (t += dt) >= s); };
export const ease = (k: number) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);
/** Splice steps in right after the step that is running now (call from inside a step). */
export const insertAfterCurrent = (p: Person, ...steps: Step[]) => p.script.splice(1, 0, ...steps);

export const dirOf = (dx: number, dy: number): Dir => (Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));

/** Walk a polyline at a steady pace (4-way facing). */
export function walkPath(p: Person, pts: { x: number; y: number }[] | (() => { x: number; y: number }[]), speed = 42): Step {
  let path: { x: number; y: number }[] | null = null;
  return step((dt) => {
    if (!path) path = typeof pts === 'function' ? pts() : pts.slice();
    if (!path.length) { p.moving = false; return true; }
    const n = path[0], dx = n.x - p.x, dy = n.y - p.y, d = Math.hypot(dx, dy);
    if (d < 0.8) { p.x = n.x; p.y = n.y; path.shift(); return false; }
    p.moving = true; p.pose = 'stand';
    p.dir = dirOf(dx, dy);
    const v = Math.min(speed * dt, d);
    p.x += dx / d * v; p.y += dy / d * v;
    return false;
  });
}
/** Pull the chair out, hop on, tuck back in (tower cubicles and desks). */
export function climbIn(p: Person, seat: Seat): Step {
  let t = 0, from: { x: number; y: number } | undefined;
  const pull = seat.front ? 0 : -4;
  return step((dt) => {
    if (!from) { from = { x: p.x, y: p.y }; seat.occupant = p; p.seat = seat; p.moving = false; p.dir = seat.front ? 'up' : 'right'; }
    t += dt;
    if (t < 0.25) seat.dx = pull * ease(t / 0.25);
    else if (t < 0.6) {
      const k = (t - 0.25) / 0.35;
      p.pose = k > 0.45 ? 'sit' : 'stand';
      p.x = from.x + (seat.seatX + seat.dx - from.x) * ease(k);
      p.y = from.y + (seat.seatY - from.y) * ease(k);
      p.hop = Math.sin(Math.PI * k) * 7;
    } else {
      p.hop = 0;
      const k = Math.min(1, (t - 0.6) / 0.3);
      seat.dx = pull * (1 - ease(k));
      p.x = seat.seatX + seat.dx; p.y = seat.seatY; p.pose = 'sit';
      if (k >= 1) return true;
    }
    return false;
  });
}
export function climbOut(p: Person, seat: Seat): Step {
  let t = 0;
  const pull = seat.front ? 0 : -4;
  return step((dt) => {
    t += dt;
    p.working = false;
    if (t < 0.25) { seat.dx = pull * ease(t / 0.25); p.x = seat.seatX + seat.dx; }
    else if (t < 0.6) {
      const k = (t - 0.25) / 0.35, to = seat.approach;
      p.pose = k > 0.4 ? 'stand' : 'sit'; p.dir = 'down';
      p.x = seat.seatX + seat.dx + (to.x - seat.seatX - seat.dx) * ease(k);
      p.y = seat.seatY + (to.y - seat.seatY) * ease(k);
      p.hop = Math.sin(Math.PI * k) * 7;
    } else {
      p.hop = 0;
      const k = Math.min(1, (t - 0.6) / 0.25);
      seat.dx = pull * (1 - ease(k));
      if (k >= 1) { seat.occupant = null; seat.reserved = false; p.seat = null; return true; }
    }
    return false;
  });
}
export function seatNow(p: Person, seat: Seat): void { seat.occupant = p; p.seat = seat; p.pose = 'sit'; p.x = seat.seatX; p.y = seat.seatY; }
export function emote(p: Person, kind: 'yes' | 'no', secs = 1.6): void { p.emote = kind; p.emoteT = secs; if (kind === 'yes') p.nod = 1; else p.shakeHead = 1; }

// ------------------------------------------------------------------- kit
export type Kit = ReturnType<typeof createKit>;

export function createKit(imgs: Imgs, g: CanvasRenderingContext2D) {
  const flashes: { x: number; y: number; ox: number; oy: number; t: number }[] = [];
  const chars = new Map<string, Character>();
  const character = (look: CharSpec) => {
    const key = JSON.stringify(look);
    let c = chars.get(key);
    if (!c) chars.set(key, (c = makeCharacter(imgs, look)));
    return c;
  };
  function person(look: CharSpec, role = 'dev', agent: Agent | null = null): Person {
    return {
      ch: character(look), role, agent, x: 0, y: 0, dir: 'down', moving: false, t: Math.random() * 10, pose: 'stand', seat: null,
      working: false, script: [], hop: 0, shake: 0, glance: 0, pressure: 0, emote: null, emoteT: 0, nod: 0, shakeHead: 0, visible: true, blocked: 0,
    };
  }
  function update(p: Person, dt: number): void {
    p.t += dt;
    if (p.script.length && p.script[0].run(dt)) p.script.shift();
    p.shake = Math.max(0, p.shake - dt); p.glance = Math.max(0, p.glance - dt); p.pressure = Math.max(0, p.pressure - dt);
    p.emoteT = Math.max(0, p.emoteT - dt); p.nod = Math.max(0, p.nod - dt);
    if (p.shakeHead > 0) { p.shakeHead -= dt; p.dir = Math.floor(p.shakeHead * 8) % 2 ? 'left' : 'right'; }
    if (p.seat && p.pose === 'sit' && !p.script.length) { p.x = p.seat.seatX + p.seat.dx; p.y = p.seat.seatY; }
  }
  function tick(dt: number): void { for (const k of [...flashes]) { k.t -= dt; if (k.t <= 0) flashes.splice(flashes.indexOf(k), 1); } }

  const px = (x: number, y: number, w: number, h: number, c: string) => { g.fillStyle = c; g.fillRect(Math.round(x), Math.round(y), w, h); };
  function spr(name: OfficeSprite, x: number, y: number, { flip = false, ctx = g }: { flip?: boolean; ctx?: CanvasRenderingContext2D } = {}): void {
    const [sx, sy, w, h] = OFFICE[name];
    x = Math.round(x); y = Math.round(y);
    if (!flip) { ctx.drawImage(imgs.office, sx, sy, w, h, x, y, w, h); return; }
    ctx.save(); ctx.translate(x + w, y); ctx.scale(-1, 1); ctx.drawImage(imgs.office, sx, sy, w, h, 0, 0, w, h); ctx.restore();
  }
  function variant(name: OfficeSprite, filter: string): HTMLCanvasElement {
    const [sx, sy, w, h] = OFFICE[name];
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d')!; x.filter = filter; x.drawImage(imgs.office, sx, sy, w, h, 0, 0, w, h);
    return c;
  }
  const darkDesk = variant('tableLong', 'brightness(0.55) saturate(0.7) hue-rotate(-12deg)');
  function text(s: string, x: number, y: number, color = '#fff', k = 1, ctx = g): void {
    ctx.fillStyle = color;
    let cx = Math.round(x);
    for (const ch of String(s).toUpperCase()) {
      const bits = FONT[ch] ?? FONT['?'];
      for (let i = 0; i < 15; i++) if (bits[i] === '1') ctx.fillRect(cx + (i % 3) * k, Math.round(y) + Math.floor(i / 3) * k, k, k);
      cx += 4 * k;
    }
  }
  function planks(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, tones: string[], seed = 1): void {
    const r = mulberry(seed);
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    for (let yy = y; yy < y + h; yy += 7) {
      let xx = x - Math.floor(r() * 40);
      while (xx < x + w) {
        const len = 26 + Math.floor(r() * 34);
        ctx.fillStyle = tones[Math.floor(r() * tones.length)]; ctx.fillRect(xx, yy, len, 7);
        ctx.fillStyle = 'rgba(60,35,20,0.45)'; ctx.fillRect(xx, yy, 1, 7);
        ctx.fillStyle = 'rgba(90,55,30,0.22)';
        for (let k = 0; k < 2; k++) ctx.fillRect(xx + 3 + Math.floor(r() * Math.max(1, len - 6)), yy + 2 + Math.floor(r() * 4), 2 + Math.floor(r() * 4), 1);
        xx += len;
      }
      ctx.fillStyle = 'rgba(60,35,20,0.5)'; ctx.fillRect(x, yy, w, 1);
    }
    ctx.restore();
  }
  function wall(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
    ctx.fillStyle = '#ebe7f2'; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#d6d1e2'; for (let yy = y + 6; yy < y + h - 4; yy += 6) ctx.fillRect(x, yy, w, 1);
    ctx.fillStyle = '#6d5a82'; ctx.fillRect(x, y + h - 3, w, 3);
    ctx.fillStyle = '#4a3d5c'; ctx.fillRect(x, y + h, w, 1);
  }

  // People.
  function drawStanding(p: Person, ox = 0, oy = 0): void {
    if (!p.visible) return;
    const f = p.ch.frames[DIR[p.dir] + (p.moving ? Math.floor(p.t * 10) % 6 : 0)];
    const x = Math.round(p.x + ox - 16), y = Math.round(p.y + oy - 30 - p.hop);
    if (!p.hop) g.drawImage(imgs.shadow, x, Math.round(p.y + oy - 30));
    const dx = p.shake > 0 ? (Math.sin(p.shake * 40) > 0 ? 1 : -1) : 0;
    g.drawImage(f, x + dx, y - (p.nod > 0 ? Math.round(Math.abs(Math.sin(p.nod * 12)) * 2) : 0));
  }
  function drawSitting(p: Person, seat: Seat, ox = 0, oy = 0): void {
    if (seat.front) {
      const s = p.ch.front;
      g.drawImage(s, Math.round(p.x + ox - 16), Math.round(p.y + oy - s.hip - p.hop - (p.nod > 0 ? Math.round(Math.abs(Math.sin(p.nod * 12))) : 0)));
      return;
    }
    const typing = p.working && p.glance <= 0;
    const s = !p.working || p.glance > 0 ? p.ch.front : p.ch.sit;
    const bob = typing && Math.floor(p.t * 4) % 5 === 0 ? 1 : 0;
    const x = Math.round(p.x + ox - 16), y = Math.round(p.y + oy - s.hip - p.hop) + bob;
    g.drawImage(s, x, y);
    if (typing && s === p.ch.sit) {
      const sit = p.ch.sit;
      const ax = x + sit.front, ay = y + sit.shoulder + 2, kx = (seat.kbX ?? 0) + ox, ky = (seat.kbY ?? 0) + oy;
      const beat = Math.floor(p.t * (p.pressure > 0 ? 14 : 9));
      const hy = ky + 3 + (beat % 2 ? 0 : 4), press = beat % 3 === 0 ? 1 : 0;
      px(ax, ay, Math.max(1, kx - ax), 2, sit.sleeve);
      px(kx, hy + press, 3, 2, sit.skin);
      if (press && beat !== p.lastBeat) { p.lastBeat = beat; flashes.push({ x: (seat.kbX ?? 0) + 1 + (beat % 2), y: hy - oy + 3, ox, oy, t: 0.15 }); }
    }
  }
  function drawPerson(p: Person, ox = 0, oy = 0): void {
    if (p.seat && p.pose === 'sit') drawSitting(p, p.seat, ox, oy); else drawStanding(p, ox, oy);
  }
  /** Cubicle block with its two seats; seated/hopping occupants drawn in place. */
  function drawBlock(b: { x: number; y: number }, seats: Seat[], ox = 0, oy = 0): void {
    spr('cubicle', b.x + ox, b.y + oy);
    for (const s of seats) {
      spr('deskYellowL', s.deskX! + ox, s.deskY! + oy);
      spr(s.tower as OfficeSprite, s.towerX! + ox, s.towerY! + oy);
      spr('monitor', s.monX! + ox, s.monY! + oy);
      const o = s.occupant;
      if (o?.working && o.pose === 'sit') px(s.monX! + ox + 3, s.monY! + oy + 3, 2, 9, o.shake > 0 ? '#ff6b6b' : Math.floor(o.t * 6) % 2 ? '#7fd8ff' : '#5fb8ec');
      spr(s.chairColor as OfficeSprite, s.chairX! + s.dx + ox, s.chairY! + oy);
      if (o && o.visible && (o.pose === 'sit' || o.hop)) drawPerson(o, ox, oy);
      spr('keyboard', s.kbX! + ox, s.kbY! + oy);
    }
  }
  /** Front-facing desk for managers (orange) or the boss (dark, nameplate). */
  function drawDeskSeat(s: Seat, ox = 0, oy = 0): void {
    const boss = s.kind === 'boss';
    const dX = s.deskX!, dY = s.deskY!;
    const cx = s.seatX - 9 + ox, cy = s.seatY - 27 + oy;
    const back = boss ? ['#1f1b28', '#2e2838', '#443b55'] : ['#3a3150', '#4b4066', '#63568a'];
    px(cx, cy + 2, 18, 20, back[0]); px(cx + 1, cy, 16, 2, back[0]); px(cx + 2, cy + 2, 14, 17, back[1]); px(cx + 3, cy + 3, 2, 12, back[2]);
    const o = s.occupant;
    if (o && o.visible && o.pose === 'sit') drawSitting(o, s, ox, oy);
    if (boss) g.drawImage(darkDesk, dX + ox, dY + oy); else spr(s.kind === 'reception' ? 'tableSmall' : 'tableLong', dX + ox, dY + oy);
    if (s.kind !== 'reception') {
      px(dX + 27 + ox, dY - 1 + oy, 12, 2, '#9aa3b5'); px(dX + 28 + ox, dY - 7 + oy, 10, 6, '#2d3142');
      px(dX + 29 + ox, dY - 6 + oy, 8, 4, o?.working ? '#7fd8ff' : '#3b4a66');
      px(dX + 4 + ox, dY + 7 + oy, 11, 3, boss ? '#d9a940' : '#e8e4f0'); px(dX + 5 + ox, dY + 8 + oy, 9, 1, boss ? '#8a6414' : '#6d6680');
    }
  }
  function drawOverlay(p: Person, ox = 0, oy = 0, { dots = false } = {}): void {
    if (!p.visible) return;
    const top = p.pose === 'sit' && p.seat ? (p.seat.front ? p.ch.front.hip : p.ch.sit.hip) - 2 : 30;
    const hx = Math.round(p.x + ox), hy = Math.round(p.y + oy - top - p.hop);
    if (dots) {
      const bx = hx - 2, by = hy - 12;
      px(bx, by, 13, 8, '#fff'); px(bx - 1, by + 1, 15, 6, '#fff'); px(bx + 2, by + 8, 2, 2, '#fff');
      const n = Math.floor(p.t * 3) % 4;
      for (let i = 0; i < 3; i++) px(bx + 2 + i * 4, by + 3, 2, 2, i < n ? '#1d1a24' : '#c9c3d6');
    }
    if (p.emote && p.emoteT > 0) {
      const ex = hx - 4, ey = hy - 14;
      px(ex - 1, ey - 1, 11, 11, '#0f0c16'); px(ex, ey, 9, 9, p.emote === 'no' ? '#ff5a5a' : '#3ecf6e');
      g.fillStyle = '#fff';
      if (p.emote === 'no') for (let i = 0; i < 5; i++) { g.fillRect(ex + 2 + i, ey + 2 + i, 1, 1); g.fillRect(ex + 6 - i, ey + 2 + i, 1, 1); }
      else { g.fillRect(ex + 2, ey + 4, 1, 2); g.fillRect(ex + 3, ey + 5, 1, 2); g.fillRect(ex + 4, ey + 4, 1, 2); g.fillRect(ex + 5, ey + 3, 1, 2); g.fillRect(ex + 6, ey + 2, 1, 2); }
    }
  }
  function drawFlashes(): void { for (const k of flashes) px(k.x + k.ox, k.y + k.oy, 1, 1, '#bfefff'); }

  return { g, imgs, px, spr, text, planks, wall, variant, person, update, tick, drawStanding, drawSitting, drawPerson, drawBlock, drawDeskSeat, drawOverlay, drawFlashes };
}
