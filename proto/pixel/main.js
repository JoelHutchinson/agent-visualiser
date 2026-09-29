// Pixel office prototype: a 400x240 canvas drawn at native resolution and
// scaled up crisp. Same behaviour as the 3D demo: devs type, lean back when
// waiting, subagents walk in and hop into chairs, the boss checks in.
import { loadAll, makeCharacter, OFFICE, DIR } from './sprites.js';

const W = 400, H = 240, WALL = 64;
const cv = document.getElementById('screen');
const g = cv.getContext('2d');
cv.width = W; cv.height = H;
g.imageSmoothingEnabled = false;
let scale = 1;
function fit() {
  // Integer scale when there is room (crisp pixels); fractional on small screens.
  const fitS = Math.min((innerWidth - 24) / W, (innerHeight - 150) / H);
  scale = fitS >= 2 ? Math.floor(fitS) : Math.max(1, fitS);
  cv.style.width = W * scale + 'px';
  cv.style.height = H * scale + 'px';
}
addEventListener('resize', fit);

const imgs = await loadAll();
const rand = mulberry(42);
function mulberry(a) { return () => { a |= 0; a = a + 0x6d2b79f5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// ----------------------------------------------------------------- sprites
function spr(name, x, y, { flip = false, img = imgs.office, ctx = g } = {}) {
  const [sx, sy, w, h] = OFFICE[name];
  x = Math.round(x); y = Math.round(y);
  if (!flip) { ctx.drawImage(img, sx, sy, w, h, x, y, w, h); return; }
  ctx.save(); ctx.translate(x + w, y); ctx.scale(-1, 1); ctx.drawImage(img, sx, sy, w, h, 0, 0, w, h); ctx.restore();
}
/** A recoloured copy of one office sprite (e.g. dark wood for the boss). */
function variant(name, filter) {
  const [sx, sy, w, h] = OFFICE[name];
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d'); x.filter = filter; x.drawImage(imgs.office, sx, sy, w, h, 0, 0, w, h);
  return c;
}
const px = (ctx, x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), w, h); };

// -------------------------------------------------------------- background
const bg = document.createElement('canvas'); bg.width = W; bg.height = H;
function paintBackground() {
  const b = bg.getContext('2d');
  // Wall: pale stripes, dark cornice, skirting.
  px(b, 0, 0, W, WALL, '#ebe7f2');
  for (let y = 6; y < WALL - 6; y += 6) px(b, 0, y, W, 1, '#d6d1e2');
  px(b, 0, 0, W, 4, '#3b3452'); px(b, 0, 4, W, 1, '#5d5478');
  // Wooden plank floor, staggered joints, subtle grain.
  const tones = ['#c98f58', '#c28651', '#d19962', '#bd814c', '#cc935c'];
  for (let y = WALL, row = 0; y < H; y += 7, row++) {
    let x = -Math.floor(rand() * 40);
    while (x < W) {
      const len = 26 + Math.floor(rand() * 34);
      px(b, x, y, len, 7, tones[Math.floor(rand() * tones.length)]);
      px(b, x, y, 1, 7, '#8a5630');                   // butt joint
      for (let k = 0; k < 3; k++) px(b, x + 3 + Math.floor(rand() * (len - 6)), y + 2 + Math.floor(rand() * 4), 2 + Math.floor(rand() * 4), 1, 'rgba(120,70,35,0.35)');
      x += len;
    }
    px(b, 0, y, W, 1, '#94603a');                     // row seam
  }
  px(b, 0, WALL - 3, W, 3, '#6d5a82'); px(b, 0, WALL, W, 1, '#4a3d5c');
  // Wall decor.
  spr('door', 14, WALL - 31, { ctx: b }); spr('door', 30, WALL - 31, { ctx: b });
  px(b, 12, WALL - 33, 36, 2, '#3b3452');
  spr('window', 150, 14, { ctx: b }); spr('windowNote', 206, 14, { ctx: b });
  spr('clock', 181, 6, { ctx: b });
  spr('whiteboard', 262, 22, { ctx: b });
  spr('calendar', 96, 20, { ctx: b });
  spr('flagUK', 320, 20, { ctx: b }); spr('flagUS', 336, 20, { ctx: b });
  spr('picture', 356, 20, { ctx: b });
  // Boss rug: burgundy with gold trim.
  const r = BOSS_RUG;
  px(b, r.x, r.y, r.w, r.h, '#5a1f2c');
  for (let yy = r.y + 4; yy < r.y + r.h - 4; yy += 4) for (let xx = r.x + 4 + ((yy / 4) % 2) * 2; xx < r.x + r.w - 4; xx += 4) px(b, xx, yy, 1, 1, '#6e2a3a');
  px(b, r.x + 2, r.y + 2, r.w - 4, 1, '#d9a940'); px(b, r.x + 2, r.y + r.h - 3, r.w - 4, 1, '#d9a940');
  px(b, r.x + 2, r.y + 2, 1, r.h - 4, '#d9a940'); px(b, r.x + r.w - 3, r.y + 2, 1, r.h - 4, '#d9a940');
  px(b, r.x, r.y + r.h, r.w, 1, 'rgba(0,0,0,0.25)');
  // Lounge rug.
  px(b, 262, 190, 92, 40, '#4b6a8c'); px(b, 264, 192, 88, 36, '#5a7ea4'); px(b, 262, 230, 92, 1, 'rgba(0,0,0,0.25)');
}

// ---------------------------------------------------------------- layout
const BOSS_RUG = { x: 264, y: 84, w: 124, h: 72 };
const BLOCKS = [{ x: 60, y: 86 }, { x: 150, y: 86 }, { x: 60, y: 146 }, { x: 150, y: 146 }];
const seats = [];
for (const b of BLOCKS) for (let s = 0; s < 2; s++) {
  const ox = b.x + 2 + s * 40;
  seats.push({
    block: b, chairX: ox + 1, chairY: b.y + 8, deskX: ox + 21, deskY: b.y + 10,
    monX: ox + 23, monY: b.y + 2, kbX: ox + 17, kbY: b.y + 12, towerX: ox + 24, towerY: b.y + 21,
    chairColor: ['chairWhite', 'chairBlue', 'chairGrey', 'chairGreen'][(seats.length) % 4],
    dx: 0, occupant: null, reserved: false, facing: 'right',
  });
}
for (const s of seats) {
  s.seatX = s.chairX + 6; s.seatY = s.chairY + 13;       // hips on the cushion
  s.approach = { x: s.chairX + 2, y: s.chairY + 26 };      // stand just in front of the chair
}
const BOSS_SEAT = {
  boss: true, facing: 'down', dx: 0, occupant: null,
  seatX: 326, seatY: 112, deskX: 306, deskY: 110,
  approach: { x: 352, y: 126 },
};
const DOOR = { x: 30, y: WALL + 4 };

// Floor obstacles (feet can't enter) for path finding.
const OBST = [
  ...BLOCKS.map((b) => ({ x: b.x - 2, y: b.y - 4, w: 84, h: 32 })),
  { x: 300, y: 96, w: 52, h: 24 },            // boss desk + chair
  { x: 56, y: WALL - 4, w: 58, h: 8 },         // vending, fridge
  { x: 274, y: WALL - 4, w: 52, h: 8 },        // coffee table, plant
  { x: 276, y: 196, w: 40, h: 16 },            // sofa
  { x: 370, y: 96, w: 16, h: 10 },             // boss plant
];

// ----------------------------------------------------------- path finding
const CELL = 4, GW = W / CELL, GH = H / CELL;
const blocked = new Uint8Array(GW * GH);
for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
  const x = gx * CELL + 2, y = gy * CELL + 2;
  let b = y < WALL + 2 || x < 6 || x > W - 6 || y > H - 4;
  for (const o of OBST) if (x >= o.x && x < o.x + o.w && y >= o.y && y < o.y + o.h) b = true;
  blocked[gy * GW + gx] = b ? 1 : 0;
}
const freeCell = (x, y) => x >= 0 && y >= 0 && x < GW && y < GH && !blocked[y * GW + x];
const cellOf = (p) => [Math.max(0, Math.min(GW - 1, Math.floor(p.x / CELL))), Math.max(0, Math.min(GH - 1, Math.floor(p.y / CELL)))];
function nearestFree([x, y]) {
  if (freeCell(x, y)) return [x, y];
  for (let r = 1; r < 30; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++)
    if (Math.max(Math.abs(dx), Math.abs(dy)) === r && freeCell(x + dx, y + dy)) return [x + dx, y + dy];
  return [x, y];
}
function findPath(from, to) {
  const [sx, sy] = nearestFree(cellOf(from)), [tx, ty] = nearestFree(cellOf(to));
  const N = GW * GH, cost = new Float32Array(N).fill(Infinity), came = new Int32Array(N).fill(-1), done = new Uint8Array(N);
  const open = [[0, sy * GW + sx]]; cost[sy * GW + sx] = 0;
  while (open.length) {
    open.sort((a, b) => a[0] - b[0]);
    const [, i] = open.shift();
    if (done[i]) continue; done[i] = 1;
    if (i === ty * GW + tx) break;
    const x = i % GW, y = i / GW | 0;
    // 4-way moves: pixel characters walk in straight lines.
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (!freeCell(nx, ny)) continue;
      const j = ny * GW + nx, c = cost[i] + 1 + (came[i] >= 0 && (came[i] % GW - x !== -dx || (came[i] / GW | 0) - y !== -dy) ? 0.3 : 0);
      if (c < cost[j]) { cost[j] = c; came[j] = i; open.push([c + Math.abs(nx - tx) + Math.abs(ny - ty), j]); }
    }
  }
  const cells = [];
  for (let i = ty * GW + tx; i !== -1; i = came[i]) cells.unshift(i);
  // Keep only corners.
  const pts = cells.map((i) => ({ x: (i % GW) * CELL + 2, y: (i / GW | 0) * CELL + 2 }));
  const out = [];
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1], b = pts[k], c = pts[k + 1];
    if (!c || (b.x - a.x) !== (c.x - b.x) || (b.y - a.y) !== (c.y - b.y)) out.push(b);
  }
  out.push({ x: to.x, y: to.y });
  return out;
}

// ------------------------------------------------------------- characters
const LOOKS = [
  { skin: 1, outfit: 5, hair: 0 }, { skin: 3, outfit: 6, hair: 6 },
  { skin: 2, outfit: 4, hair: 3 }, { skin: 5, outfit: 2, hair: 7 },
  { skin: 0, outfit: 3, hair: 2 }, { skin: 4, outfit: 1, hair: 5 },
];
const people = [];
async function makePerson(look, role = 'dev') {
  const ch = await makeCharacter(imgs, look);
  const p = { ch, role, x: DOOR.x, y: DOOR.y, dir: 'down', moving: false, t: rand() * 10, pose: 'stand',
              seat: null, working: false, script: [], hop: 0, shake: 0, glance: 0, pressure: 0, emote: null, emoteT: 0, lean: 0 };
  people.push(p);
  return p;
}

// ----------------------------------------------------------- choreography
const step = (run) => ({ run });
const call = (fn) => step(() => (fn(), true));
const wait = (s) => { let t = 0; return step((dt) => (t += dt) >= s); };
const ease = (k) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);
function walkTo(p, target) {
  let path = null;
  return step((dt) => {
    if (!path) { path = findPath(p, target); p.pose = 'stand'; }
    if (!path.length) { p.moving = false; return true; }
    const n = path[0], dx = n.x - p.x, dy = n.y - p.y, d = Math.hypot(dx, dy);
    if (d < 0.8) { p.x = n.x; p.y = n.y; path.shift(); return false; }
    p.moving = true;
    p.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    const v = Math.min(38 * dt, d);
    p.x += dx / d * v; p.y += dy / d * v;
    return false;
  });
}
/**
 * Pull the chair out, hop up onto it, tuck back in (the dev rides the chair).
 * For the boss (front-facing), the chair rolls back from behind the desk.
 */
function climbIn(p, seat) {
  let t = 0, from;
  return step((dt) => {
    if (!from) { from = { x: p.x, y: p.y }; seat.occupant = p; p.seat = seat; p.pose = 'stand'; p.moving = false; p.dir = seat.facing === 'down' ? 'up' : 'right'; }
    t += dt;
    const pull = seat.boss ? 0 : -4;
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
function climbOut(p, seat) {
  let t = 0, to;
  return step((dt) => {
    if (!to) { to = seat.approach; p.working = false; }
    t += dt;
    const pull = seat.boss ? 0 : -4;
    if (t < 0.25) { seat.dx = pull * ease(t / 0.25); p.x = seat.seatX + seat.dx; }
    else if (t < 0.6) {
      const k = (t - 0.25) / 0.35;
      p.pose = k > 0.4 ? 'stand' : 'sit';
      p.dir = 'down';
      p.x = seat.seatX + seat.dx + (to.x - seat.seatX - seat.dx) * ease(k);
      p.y = seat.seatY + (to.y - seat.seatY) * ease(k);
      p.hop = Math.sin(Math.PI * k) * 7;
    } else {
      p.hop = 0;
      const k = Math.min(1, (t - 0.6) / 0.25);
      seat.dx = pull * (1 - ease(k));
      if (k >= 1) { seat.occupant = null; p.seat = null; return true; }
    }
    return false;
  });
}
function seatNow(p, seat) {
  seat.occupant = p; p.seat = seat; p.pose = 'sit'; p.x = seat.seatX; p.y = seat.seatY;
}

// ---------------------------------------------------------------- drawing
const bossDesk = variant('tableLong', 'brightness(0.55) saturate(0.7) hue-rotate(-12deg)');
const keyFlashes = [];
function drawPersonStanding(p) {
  const f = p.ch.frames[DIR[p.dir] + (p.moving ? Math.floor(p.t * 10) % 6 : 0)];
  const x = Math.round(p.x - 16), y = Math.round(p.y - 30 - p.hop);
  if (!p.hop) g.drawImage(imgs.shadow, x, Math.round(p.y - 30));
  let dx = 0;
  if (p.shake > 0) dx = Math.sin(p.shake * 40) > 0 ? 1 : -1;
  g.drawImage(f, x + dx, y - (p.nod > 0 ? Math.round(Math.abs(Math.sin(p.nod * 12)) * 2) : 0));
}
function drawSitting(p, seat) {
  const typing = p.working && p.glance <= 0;
  if (seat.facing === 'down') {                // boss: front-facing behind the desk
    const s = p.ch.front;
    g.drawImage(s, Math.round(p.x - 16), Math.round(p.y - s.hip - p.hop + (p.lean > 0.5 ? 1 : 0)));
    return;
  }
  const waiting = !p.working && p.role === 'dev';
  const s = waiting || p.glance > 0 ? p.ch.front : p.ch.sit;
  const bob = typing && Math.floor(p.t * 4) % 5 === 0 ? 1 : 0;
  const x = Math.round(p.x - 16), y = Math.round(p.y - s.hip - p.hop) + bob;
  g.drawImage(s, x, y);
  if (typing && s === p.ch.sit) {
    // Arm reaching to the keyboard, hands alternating on the keys.
    const ax = x + s.front, ay = y + s.shoulder + 2;
    const kx = seat.kbX, ky = seat.kbY;
    const beat = Math.floor(p.t * (p.pressure > 0 ? 14 : 9));
    const hy = ky + 3 + (beat % 2 ? 0 : 4), press = (beat % 3) === 0 ? 1 : 0;
    g.fillStyle = s.sleeve; g.fillRect(ax, ay, Math.max(1, kx - ax), 2);
    g.fillStyle = s.skin; g.fillRect(kx, hy + press, 3, 2);
    if (press && (beat !== p.lastBeat)) { p.lastBeat = beat; keyFlashes.push({ x: kx + 1 + (beat % 2), y: hy + 3, t: 0.15 }); }
  }
}
function drawBlock(b) {
  spr('cubicle', b.x, b.y);
  for (const s of seats.filter((q) => q.block === b)) {
    spr('deskYellowL', s.deskX, s.deskY);
    spr(['towerRed', 'towerBlue', 'towerGreen'][seats.indexOf(s) % 3], s.towerX, s.towerY);
    spr('monitor', s.monX, s.monY);
    // Monitor glow while its dev works.
    if (s.occupant?.working && s.occupant.pose === 'sit') {
      const on = Math.floor(s.occupant.t * 6) % 2;
      px(g, s.monX + 3, s.monY + 3, 2, 9, on ? '#7fd8ff' : '#5fb8ec');
      if (s.occupant.shake > 0) px(g, s.monX + 3, s.monY + 3, 2, 9, '#ff6b6b');
    }
    spr(s.chairColor, s.chairX + s.dx, s.chairY);
    if (s.occupant && (s.occupant.pose === 'sit' || s.occupant.hop)) {
      s.occupant.pose === 'sit' ? drawSitting(s.occupant, s) : drawPersonStanding(s.occupant);
    }
    spr('keyboard', s.kbX, s.kbY);
    if (s.block === BLOCKS[0] && s === seats[0]) spr('mug', s.deskX + 9, s.deskY + 1);
  }
}
function drawBossOffice() {
  const s = BOSS_SEAT;
  // Executive chair back.
  const cx = s.seatX - 9 + s.dx, cy = s.seatY - 27;
  px(g, cx, cy + 2, 18, 20, '#1f1b28'); px(g, cx + 1, cy, 16, 2, '#1f1b28');
  px(g, cx + 2, cy + 2, 14, 17, '#2e2838'); px(g, cx + 3, cy + 3, 2, 12, '#443b55');
  if (s.occupant && s.occupant.pose === 'sit') drawSitting(s.occupant, s);
  // Desk in front (hides the legs), laptop, nameplate, lamp-ish.
  g.drawImage(bossDesk, s.deskX, s.deskY);
  px(g, s.deskX + 27, s.deskY - 1, 12, 2, '#9aa3b5'); px(g, s.deskX + 28, s.deskY - 7, 10, 6, '#2d3142'); px(g, s.deskX + 29, s.deskY - 6, 8, 4, s.occupant?.working ? '#7fd8ff' : '#3b4a66');
  px(g, s.deskX + 4, s.deskY + 7, 11, 3, '#d9a940'); px(g, s.deskX + 5, s.deskY + 8, 9, 1, '#8a6414');
  spr('printer', s.deskX + 3, s.deskY - 6);
  spr('plant', 370, 84);
}

// Things drawn in depth order by their base line.
function drawables() {
  const list = [];
  for (const b of BLOCKS) list.push({ y: b.y + 30, draw: () => drawBlock(b) });
  list.push({ y: BOSS_SEAT.deskY + 16, draw: drawBossOffice });
  list.push({ y: WALL + 2, draw: () => {
    spr('vending', 58, WALL - 30); spr('fridge', 84, WALL - 27); spr('cooler', 112, WALL - 13);
    spr('binGreen', 124, WALL - 10); spr('binBlue', 134, WALL - 10);
    spr('tableSmall', 276, WALL - 12); spr('coffeeMaker', 282, WALL - 21); spr('mug', 292, WALL - 17);
    spr('plant', 306, WALL - 15);
  } });
  list.push({ y: 212, draw: () => { spr('sofaOrange', 278, 196); spr('plant', 332, 194); } });
  list.push({ y: corgi.y, draw: drawCorgi });
  list.push({ y: cat.y, draw: drawCat });
  for (const p of people) if (!p.seat || (p.pose !== 'sit' && !p.hop)) list.push({ y: p.y, draw: () => drawPersonStanding(p) });
  return list.sort((a, b) => a.y - b.y);
}

// ------------------------------------------------------------------- pets
const cat = { x: 230, y: 180, tx: 230, ty: 180, t: 0, flip: false, rest: 2 };
const corgi = { x: 214, y: 220, t: 0 };
function updatePets(dt) {
  cat.t += dt; corgi.t += dt;
  if (cat.rest > 0) { cat.rest -= dt; if (cat.rest <= 0) { const [cx, cy] = nearestFree([Math.floor(rand() * GW), Math.floor((WALL + 10 + rand() * (H - WALL - 20)) / CELL)]); cat.tx = cx * CELL + 2; cat.ty = cy * CELL + 2; } return; }
  const dx = cat.tx - cat.x, dy = cat.ty - cat.y, d = Math.hypot(dx, dy);
  if (d < 1) { cat.rest = 3 + rand() * 5; return; }
  const nx = cat.x + dx / d * 22 * dt, ny = cat.y + dy / d * 22 * dt;
  const [gx, gy] = cellOf({ x: nx, y: ny });
  if (!freeCell(gx, gy)) { cat.rest = 1; return; }
  cat.x = nx; cat.y = ny; cat.flip = dx > 0;
}
function drawCat() {
  const hopY = cat.rest > 0 ? 0 : Math.round(Math.abs(Math.sin(cat.t * 12)));
  px(g, cat.x - 6, cat.y - 1, 12, 2, 'rgba(0,0,0,0.2)');
  spr('cat', cat.x - 8, cat.y - 13 - hopY, { flip: cat.flip });
}
function drawCorgi() {
  px(g, corgi.x - 11, corgi.y - 1, 22, 2, 'rgba(0,0,0,0.2)');
  spr('corgi', corgi.x - 12, corgi.y - 11);
  const k = (corgi.t * 0.6) % 1;
  g.globalAlpha = 1 - k; px(g, corgi.x + 8 + k * 6, corgi.y - 14 - k * 10, 3, 1, '#fff'); px(g, corgi.x + 10 + k * 6, corgi.y - 13 - k * 10, 1, 1, '#fff'); px(g, corgi.x + 8 + k * 6, corgi.y - 12 - k * 10, 3, 1, '#fff'); g.globalAlpha = 1;
}

// ---------------------------------------------------------------- overlays
function drawOverlays() {
  for (const p of people) {
    const head = { x: Math.round(p.x), y: Math.round(p.y - (p.pose === 'sit' ? p.ch.sit.hip - 4 : 30) - p.hop) };
    // "Waiting for you" dots over an idle dev.
    if (p.role === 'dev' && p.pose === 'sit' && !p.working && p === mainDev) {
      const bx = head.x - 2, by = head.y - 12;
      px(g, bx, by, 13, 8, '#fff'); px(g, bx - 1, by + 1, 15, 6, '#fff'); px(g, bx + 2, by + 8, 2, 2, '#fff');
      const n = Math.floor(p.t * 3) % 4;
      for (let i = 0; i < 3; i++) px(g, bx + 2 + i * 4, by + 3, 2, 2, i < n ? '#1d1a24' : '#c9c3d6');
    }
    if (p.emote && p.emoteT > 0) {
      const ex = head.x - 4, ey = head.y - 14 - (p.emoteT > 1.2 ? Math.round((p.emoteT - 1.2) * 20) : 0);
      px(g, ex - 1, ey - 1, 11, 11, '#0f0c16'); px(g, ex, ey, 9, 9, p.emote === 'no' ? '#ff5a5a' : '#3ecf6e');
      g.fillStyle = '#fff';
      if (p.emote === 'no') { for (let i = 0; i < 5; i++) { g.fillRect(ex + 2 + i, ey + 2 + i, 1, 1); g.fillRect(ex + 6 - i, ey + 2 + i, 1, 1); } }
      else { g.fillRect(ex + 2, ey + 4, 1, 2); g.fillRect(ex + 3, ey + 5, 1, 2); g.fillRect(ex + 4, ey + 4, 1, 2); g.fillRect(ex + 5, ey + 3, 1, 2); g.fillRect(ex + 6, ey + 2, 1, 2); }
    }
  }
  for (const k of keyFlashes) px(g, k.x, k.y, 1, 1, '#bfefff');
}

// -------------------------------------------------------------- HUD / DOM
const counts = { research: 0, code: 0, bug: 0 };
const COLORS = { research: 'var(--research)', code: 'var(--code)', bug: 'var(--bug)' };
const GLYPH = { research: '?', code: '&lt;&gt;', bug: '!' };
const toScreen = (x, y) => { const r = cv.getBoundingClientRect(); return { x: r.left + x * scale, y: r.top + y * scale }; };
function bubble(p, type) {
  if (type === 'bug') p.shake = 0.5;
  const from = toScreen(p.x, p.y - 28);
  const el = document.createElement('div'); el.className = 'bubble'; el.style.background = COLORS[type]; el.innerHTML = GLYPH[type];
  document.body.appendChild(el);
  const counter = document.getElementById('c-' + type), tr = counter.getBoundingClientRect();
  const to = { x: tr.right - 18, y: tr.top + tr.height / 2 };
  const start = performance.now();
  (function stepB(now) {
    const t = Math.min(1, (now - start) / 1200), pop = Math.min(1, t / 0.2), fly = Math.max(0, (t - 0.2) / 0.8);
    const e = Math.floor((fly < 0.5 ? 4 * fly ** 3 : 1 - (-2 * fly + 2) ** 3 / 2) * 24) / 24;   // stepped motion
    const cx = (from.x + to.x) / 2, cy = Math.min(from.y, to.y) - 80;
    const x = (1 - e) ** 2 * from.x + 2 * (1 - e) * e * cx + e ** 2 * to.x;
    const y = (1 - e) ** 2 * (from.y - 24 * pop) + 2 * (1 - e) * e * cy + e ** 2 * to.y;
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) scale(${pop < 1 ? 0.6 : 1})`;
    if (t < 1) requestAnimationFrame(stepB);
    else { el.remove(); counts[type]++; const b = counter.querySelector('b'); b.textContent = counts[type]; b.classList.remove('bump'); void b.offsetWidth; b.classList.add('bump'); }
  })(start);
}
const says = [];
function say(p, text, secs = 1.8) { const el = document.createElement('div'); el.className = 'say'; el.textContent = text; document.body.appendChild(el); says.push({ p, el, ttl: secs }); }
function updateDom(dt) {
  const tag = document.getElementById('boss-tag');
  if (boss) {
    const top = boss.pose === 'sit' ? boss.y - boss.ch.front.hip + 2 : boss.y - 31 - boss.hop;
    const s = toScreen(boss.x, top);
    tag.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px) translate(-50%, -100%)`;
  }
  for (const l of [...says]) {
    l.ttl -= dt;
    const s = toScreen(l.p.x, l.p.y - 44);
    l.el.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px) translate(-50%, -100%)`;
    if (l.ttl <= 0) { l.el.remove(); says.splice(says.indexOf(l), 1); }
  }
}

// --------------------------------------------------------------- the boss
let boss, mainDev;
const seatedDevs = () => people.filter((p) => p.role === 'dev' && p.pose === 'sit' && p.seat && !p.script.length);
function checkIn(target, verdict) {
  if (!boss || boss.script.length || boss.pose !== 'sit' || !target?.seat) return;
  const seat = target.seat;
  boss.script.push(
    climbOut(boss, BOSS_SEAT),
    walkTo(boss, { x: seat.chairX - 7, y: seat.chairY + 22 }),
    call(() => { boss.dir = 'right'; target.glance = 1.1; target.pressure = 6; }),
    wait(0.4),
    call(() => {
      boss.emote = verdict === 'bug' ? 'no' : 'yes'; boss.emoteT = 1.8;
      if (verdict === 'bug') boss.shakeHead = 1.2; else boss.nod = 1.2;
      say(boss, verdict === 'bug' ? 'Fix that bug.' : 'Good work.');
    }),
    wait(1.6),
    walkTo(boss, BOSS_SEAT.approach),
    climbIn(boss, BOSS_SEAT),
  );
}
setInterval(() => { const s = seatedDevs(); if (s.length) checkIn(s[Math.floor(rand() * s.length)], 'ok'); }, 20000);
setInterval(() => { if (boss?.pose === 'sit') boss.working = !boss.working; }, 4000);

// Simulated agent events.
setInterval(() => {
  const busy = people.filter((p) => p.role === 'dev' && p.working && p.pose === 'sit');
  if (!busy.length) return;
  const p = busy[Math.floor(rand() * busy.length)];
  const r = rand();
  const type = r < 0.4 ? 'research' : r < 0.92 ? 'code' : 'bug';
  bubble(p, type);
  if (type === 'bug' && rand() < 0.6) checkIn(p, 'bug');
}, 800);

// ---------------------------------------------------------------- controls
function setWorking(on) {
  mainDev.working = on;
  document.getElementById('b-work').classList.toggle('on', on);
  document.getElementById('b-idle').classList.toggle('on', !on);
  document.getElementById('status').textContent = `Pixel prototype · simulated events · ${on ? 'working' : 'waiting for input'}`;
}
document.getElementById('b-work').onclick = () => setWorking(true);
document.getElementById('b-idle').onclick = () => setWorking(false);
document.getElementById('b-spawn').onclick = async () => {
  const seat = seats.find((s) => !s.occupant && !s.reserved);
  if (!seat) return;
  seat.reserved = true;
  const n = people.filter((p) => p.role === 'dev').length;
  const p = await makePerson(LOOKS[n % LOOKS.length]);
  p.script.push(walkTo(p, seat.approach), climbIn(p, seat), call(() => { p.working = true; seat.reserved = false; }));
};
document.getElementById('b-done').onclick = () => {
  const p = [...people].reverse().find((q) => q.role === 'dev' && q !== mainDev && q.pose === 'sit' && !q.script.length);
  if (!p) return;
  const seat = p.seat;
  p.script.push(wait(0.3), climbOut(p, seat), call(() => { p.emote = 'yes'; p.emoteT = 1.2; say(p, 'Done!'); p.dir = 'down'; }), wait(1),
    walkTo(p, DOOR), call(() => people.splice(people.indexOf(p), 1)));
};
document.getElementById('b-boss').onclick = () => { const s = seatedDevs(); if (s.length) checkIn(s[Math.floor(rand() * s.length)], rand() < 0.5 ? 'ok' : 'bug'); };

// -------------------------------------------------------------------- loop
paintBackground();
mainDev = await makePerson(LOOKS[0]);
seatNow(mainDev, seats[0]);
boss = await makePerson({ skin: 0, suit: 2, hair: 1 }, 'boss');
seatNow(boss, BOSS_SEAT);
setWorking(true);
fit();
document.getElementById('loading').remove();

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  for (const p of [...people]) {
    p.t += dt;
    if (p.script.length && p.script[0].run(dt)) p.script.shift();
    p.shake = Math.max(0, p.shake - dt); p.glance = Math.max(0, p.glance - dt); p.pressure = Math.max(0, p.pressure - dt);
    p.emoteT = Math.max(0, p.emoteT - dt); p.nod = Math.max(0, (p.nod || 0) - dt);
    if (p.shakeHead > 0) { p.shakeHead -= dt; p.dir = Math.floor(p.shakeHead * 8) % 2 ? 'left' : 'right'; if (p.shakeHead <= 0) p.dir = 'right'; }
    if (p.seat && p.pose === 'sit' && !p.script.length) { p.x = p.seat.seatX + p.seat.dx; p.y = p.seat.seatY; }
  }
  for (const k of [...keyFlashes]) { k.t -= dt; if (k.t <= 0) keyFlashes.splice(keyFlashes.indexOf(k), 1); }
  updatePets(dt);
  g.drawImage(bg, 0, 0);
  for (const d of drawables()) d.draw();
  drawOverlays();
  updateDom(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
window.dbg = { people, seats, BOSS_SEAT, checkIn, get boss() { return boss; } };
