// Office grid view: one huge floor plan. The orchestrator's executive suite
// runs along the top; each department (a direct report of the orchestrator)
// is a carpeted zone below it holding glass-walled sub-offices, one per
// manager and sub-manager. New rooms only ever append, so nothing reshuffles.
// Pan and zoom freely; zoomed out, labels and activity flashes take over.
import { loadAll } from './sprites.js';
import {
  createKit, blockSeats, deskSeat, LOOKS, MANAGER_LOOKS, BOSS_LOOK, YOU_LOOK, TONES, ZONE_COLORS,
  call, wait, walkPath, climbIn, climbOut, seatNow, emote, flyBubble, bump, textWidth,
} from './kit.js';
import { Org } from './org.js';

const RW = 262, RH = 140, GAP = 36, EXH = 150, HALL = EXH + 18, COLS_Y = EXH + 40, MIN_W = 760;
const cv = document.getElementById('screen');
const g = cv.getContext('2d');
const imgs = await loadAll();
const kit = await createKit(imgs, g);
const presetName = new URLSearchParams(location.search).get('preset') || 'swarm';
document.getElementById('preset').value = presetName;

// ----------------------------------------------------------------- layout
const org = new Org();
const people = new Map();
const columns = [];          // one per department, left to right
const rooms = [];            // every sub-office
let WW = MIN_W, WH = 600;
const exec = {
  exec: true, x: 0, y: 0, w: MIN_W, h: EXH, flash: 0, flashColor: '#fff', counts: { research: 0, code: 0, bug: 0 },
  desk: deskSeat(330, 52, 'boss'), reception: deskSeat(40, 60, 'reception'),
};
exec.blocks = [{ x: 440, y: 70 }, { x: 530, y: 70 }, { x: 620, y: 70 }];
exec.seats = exec.blocks.flatMap((b, i) => blockSeats(b, i * 2));
exec.aisleY = EXH - 12;
exec.exit = (pt) => [{ x: pt.x, y: exec.aisleY }, { x: pt.x, y: HALL }];
const street = { exit: () => [{ x: 8, y: HALL }] };
const ENTRANCE = { x: 8, y: HALL };

function columnFor(dept) {
  let col = columns.find((c) => c.dept === dept);
  if (!col) {
    col = { dept, x: GAP + columns.length * (RW + GAP), nextY: COLS_Y, color: ZONE_COLORS[columns.length % ZONE_COLORS.length], tone: 1 + (columns.length % (TONES.length - 1)) };
    col.corr = col.x - GAP / 2;
    columns.push(col);
    WW = Math.max(MIN_W, GAP + columns.length * (RW + GAP));
  }
  return col;
}
function makeRoom(mgr, annex) {
  const col = columnFor(mgr.dept ?? mgr);
  const r = { mgr, annex, col, x: col.x, y: col.nextY, w: RW, h: RH, flash: 0, flashColor: '#fff', counts: { research: 0, code: 0, bug: 0 } };
  col.nextY += RH + 16;
  r.blocks = [{ x: r.x + 8, y: r.y + 34 }, { x: r.x + 100, y: r.y + 34 }, { x: r.x + 8, y: r.y + 84 }, { x: r.x + 100, y: r.y + 84 }];
  r.seats = r.blocks.flatMap((b, i) => blockSeats(b, i * 2 + mgr.id));
  if (!annex) r.desk = deskSeat(r.x + 198, r.y + 38, 'manager');
  // Exit: along the seat's aisle to the door on the corridor side, then up the corridor.
  r.exit = (pt) => [{ x: r.x + 4, y: pt.y }, { x: col.corr, y: pt.y }, { x: col.corr, y: HALL }];
  rooms.push(r);
  WH = Math.max(WH, col.nextY + 24);
  exec.w = WW;
  dirty = true;
  return r;
}
const roomsOf = (mgr) => rooms.filter((r) => r.mgr === mgr);
function freeSeat(mgr) {
  if (mgr.role === 'orchestrator') { const s = exec.seats.find((q) => !q.occupant && !q.reserved); return [exec, s ?? exec.seats[0]]; }
  for (const r of roomsOf(mgr)) { const s = r.seats.find((q) => !q.occupant && !q.reserved); if (s) return [r, s]; }
  const r = makeRoom(mgr, true);
  return [r, r.seats[0]];
}
/** Route between two places via doors, corridors and the main hallway. */
function route(fromRoom, from, toRoom, to) {
  if (fromRoom === toRoom) return [{ x: to.x, y: from.y }, to];
  const out = fromRoom.exit(from);
  const back = toRoom.exit(to).reverse();
  return [...out, ...back, ...(toRoom === street ? [] : [{ x: to.x, y: back.length ? back[back.length - 1].y : to.y }, to])];
}

// ------------------------------------------------------------- background
const bg = document.createElement('canvas');
let dirty = true;
function paintBackground() {
  bg.width = WW; bg.height = WH;
  const b = bg.getContext('2d');
  kit.planks(b, 0, 0, WW, WH, TONES[0], 5);
  // Main hallway.
  b.fillStyle = 'rgba(40,30,60,0.18)'; b.fillRect(0, EXH + 8, WW, 20);
  // Executive suite: wall, gold-trimmed rug.
  kit.wall(b, 0, 0, WW, 30);
  b.fillStyle = '#5a1f2c'; b.fillRect(250, 34, 170, 104);
  b.fillStyle = '#d9a940'; b.fillRect(252, 36, 166, 1); b.fillRect(252, 136, 166, 1); b.fillRect(252, 36, 1, 101); b.fillRect(417, 36, 1, 101);
  b.fillStyle = 'rgba(0,0,0,0.25)'; b.fillRect(0, EXH, WW, 2);
  label(b, 'EXECUTIVE SUITE', 8, 9, '#e8b94a');
  kit.spr('window', 150, 4, { ctx: b }); kit.spr('window', 470, 4, { ctx: b }); kit.spr('clock', 290, 10, { ctx: b });
  // Department zones and their sub-offices.
  for (const col of columns) {
    const top = COLS_Y - 10, h = col.nextY - top - 6;
    b.fillStyle = col.color + '22'; b.fillRect(col.x - 8, top, RW + 16, h);
    b.fillStyle = col.color; b.fillRect(col.x - 8, top, RW + 16, 2); b.fillRect(col.x - 8, top, 2, h); b.fillRect(col.x + RW + 6, top, 2, h);
  }
  for (const r of rooms) {
    const tones = TONES[r.col.tone];
    kit.planks(b, r.x, r.y + 30, r.w, r.h - 30, tones, r.mgr.id * 3 + (r.annex ? 1 : 0));
    kit.wall(b, r.x, r.y, r.w, 30);
    // Glass walls with door gaps on the corridor side at each aisle.
    b.fillStyle = 'rgba(170,215,255,0.85)';
    for (let yy = r.y + 30; yy < r.y + r.h; yy += 2) {
      const door = [r.y + 34 + 34, r.y + 84 + 34].some((d) => Math.abs(yy - d) < 8);
      if (!door) b.fillRect(r.x, yy, 2, 1);
      b.fillRect(r.x + r.w - 2, yy, 2, 1);
    }
    for (let xx = r.x; xx < r.x + r.w; xx += 2) b.fillRect(xx, r.y + r.h - 1, 1, 1);
    // Plaque: name, depth ticks, reporting line.
    const name = r.annex ? `${r.mgr.name} annex` : `Team ${r.mgr.name}`;
    label(b, name, r.x + 6, r.y + 8, r.col.color);
    for (let d = 1; d < r.mgr.depth; d++) { b.fillStyle = r.col.color; b.fillRect(r.x + 6 + textWidth(name) + 12 + d * 5, r.y + 12, 3, 3); }
    if (r.mgr.depth > 1 && !r.annex) kit.text(`reports to ${r.mgr.parent.name}`, r.x + 8, r.y + 22, '#8a7fa0', 1, b);
    kit.spr('window', r.x + 200, r.y + 4, { ctx: b });
  }
  // Street door on the far left of the hallway.
  b.fillStyle = '#3b3452'; b.fillRect(0, EXH + 4, 6, 28);
  dirty = false;
}
function label(b, text, x, y, color) {
  const w = textWidth(text);
  b.fillStyle = '#0f0c16'; b.fillRect(x - 1, y - 1, w + 12, 11);
  b.fillStyle = '#2b2438'; b.fillRect(x, y, w + 10, 9);
  b.fillStyle = color; b.fillRect(x, y, 2, 9);
  kit.text(text, x + 5, y + 2, '#f4eefc', 1, b);
}

// ------------------------------------------------------------ org events
org.on('spawn', async (a, { initial }) => {
  if (a.role === 'manager') makeRoom(a, false);
  const look = a.role === 'orchestrator' ? BOSS_LOOK : a.role === 'manager' ? MANAGER_LOOKS[a.id % MANAGER_LOOKS.length] : LOOKS[a.id % LOOKS.length];
  const p = await kit.person(look, a.role, a);
  people.set(a.id, p);
  let room, seat;
  if (a.role === 'worker') { [room, seat] = freeSeat(a.parent); seat.reserved = true; }
  else if (a.role === 'orchestrator') { room = exec; seat = exec.desk; }
  else { room = roomsOf(a)[0]; seat = room.desk; }
  p.room = room;
  if (initial) { seatNow(p, seat); p.working = a.state === 'working'; return; }
  p.x = ENTRANCE.x; p.y = ENTRANCE.y; p.room = street;
  p.script.push(
    walkPath(p, () => route(street, p, room, seat.approach)),
    call(() => { p.room = room; }),
    climbIn(p, seat),
    call(() => { a.ready = true; p.working = true; }),
  );
});
org.on('finish', (a) => {
  const p = people.get(a.id), lead = people.get(a.parent.id);
  if (!p) return;
  const leadRoom = lead?.room, leadSeat = lead?.seat;
  p.script.push(
    climbOut(p, p.seat),
    ...(leadRoom && leadSeat ? [walkPath(p, () => route(p.room, p, leadRoom, leadSeat.approach)), call(() => { p.room = leadRoom; })] : []),
    call(() => { p.dir = 'left'; emote(p, 'yes', 1.2); if (lead) emote(lead, 'yes', 1.2); }),
    wait(1.2),
    walkPath(p, () => route(p.room, p, street, ENTRANCE)),
    call(() => { people.delete(a.id); org.remove(a); }),
  );
});
org.on('event', (a, type) => {
  const p = people.get(a.id);
  const room = p?.room;
  if (!p || !room || room === street) return bump(type);
  room.counts[type]++; room.flash = 0.7; room.flashColor = type === 'bug' ? '#ff5a5a' : type === 'code' ? '#3ecf6e' : '#4a9eff';
  if (type === 'bug') p.shake = 0.5;
  const s = toScreen(p.x, p.y - 26);
  if (cam.z >= 2 && s.x > 0 && s.y > 60 && s.x < innerWidth && s.y < innerHeight - 60) flyBubble(s, type); else bump(type);
});
org.on('state', (a) => { const p = people.get(a.id); if (p) p.working = a.state === 'working'; });

// ----------------------------------------------------------------- camera
const cam = { x: 0, y: 0, z: 1, tx: 0, ty: 0, tz: 1 };
const toScreen = (x, y) => ({ x: (x - cam.x) * cam.z, y: (y - cam.y) * cam.z });
const toWorld = (sx, sy) => ({ x: sx / cam.z + cam.x, y: sy / cam.z + cam.y });
function frameRect(x, y, w, h, pad = 40) {
  const vw = innerWidth, vh = innerHeight - 130;
  cam.tz = Math.max(0.3, Math.min(8, Math.min((vw - pad) / w, (vh - pad) / h)));
  cam.tx = x + w / 2 - vw / 2 / cam.tz;
  cam.ty = y + h / 2 - (vh / 2 + 70) / cam.tz;
}
const fitAll = () => frameRect(0, 0, WW, WH);
function resize() { cv.width = innerWidth; cv.height = innerHeight; g.imageSmoothingEnabled = false; }
addEventListener('resize', resize);
let drag = null;
cv.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, cx: cam.tx, cy: cam.ty }; cv.classList.add('drag'); cv.setPointerCapture(e.pointerId); });
cv.addEventListener('pointermove', (e) => { if (!drag) return; cam.tx = drag.cx - (e.clientX - drag.x) / cam.z; cam.ty = drag.cy - (e.clientY - drag.y) / cam.z; cam.x = cam.tx; cam.y = cam.ty; });
cv.addEventListener('pointerup', () => { drag = null; cv.classList.remove('drag'); });
cv.addEventListener('wheel', (e) => {
  e.preventDefault();
  const before = toWorld(e.clientX, e.clientY);
  cam.z = cam.tz = Math.max(0.3, Math.min(8, cam.z * Math.pow(1.0015, -e.deltaY)));
  cam.x = cam.tx = before.x - e.clientX / cam.z; cam.y = cam.ty = before.y - e.clientY / cam.z;
}, { passive: false });
cv.addEventListener('dblclick', (e) => {
  const w = toWorld(e.clientX, e.clientY);
  const r = [...rooms, exec].find((q) => w.x >= q.x && w.x <= q.x + (q.w ?? WW) && w.y >= q.y && w.y <= q.y + q.h);
  if (r) frameRect(r.x, r.y, r.w ?? WW, r.h, 20);
});

// ---------------------------------------------------------------- drawing
function drawTag(text, x, y, bgc = '#e8b94a', fg = '#2b1d05') {
  const w = textWidth(text) + 4;
  kit.px(x - w / 2 - 1, y - 1, w + 2, 9, '#0f0c16'); kit.px(x - w / 2, y, w, 7, bgc);
  kit.text(text, x - w / 2 + 2, y + 1, fg);
}
function visible(x, y, w, h) {
  const a = toScreen(x, y), b = toScreen(x + w, y + h);
  return b.x > 0 && b.y > 0 && a.x < innerWidth && a.y < innerHeight;
}
function drawWorld(time) {
  g.drawImage(bg, 0, 0);
  const list = [];
  for (const r of [exec, ...rooms]) {
    if (!visible(r.x, r.y, r.w ?? WW, r.h)) continue;
    r.blocks.forEach((b, i) => list.push({ y: b.y + 30, d: () => kit.drawBlock(b, r.seats.slice(i * 2, i * 2 + 2)) }));
    if (r.desk) list.push({ y: r.desk.deskY + 16, d: () => kit.drawDeskSeat(r.desk) });
  }
  list.push({ y: exec.reception.deskY + 16, d: () => kit.drawDeskSeat(exec.reception) });
  list.push({ y: 100, d: () => { kit.spr('plant', 230, 84); kit.spr('plant', 426, 84); kit.spr('vending', 700, 36); } });
  for (const p of people.values()) if (!(p.seat && (p.pose === 'sit' || p.hop)) && visible(p.x - 16, p.y - 32, 32, 34)) list.push({ y: p.y, d: () => kit.drawStanding(p) });
  if (you && !(you.seat && you.pose === 'sit')) list.push({ y: you.y, d: () => kit.drawStanding(you) });
  list.sort((a, b) => a.y - b.y).forEach((x) => x.d());
  kit.drawFlashes();
  // Activity flashes outline the room, readable at any zoom.
  for (const r of [exec, ...rooms]) if (r.flash > 0) {
    g.globalAlpha = Math.min(1, r.flash * 1.6); g.fillStyle = r.flashColor;
    const w = r.w ?? WW, t = Math.max(1, Math.round(2 / cam.z));
    g.fillRect(r.x, r.y, w, t); g.fillRect(r.x, r.y + r.h - t, w, t); g.fillRect(r.x, r.y, t, r.h); g.fillRect(r.x + w - t, r.y, t, r.h);
    g.globalAlpha = 1;
  }
  for (const p of people.values()) {
    kit.drawOverlay(p);
    if (p.agent?.role === 'orchestrator' && p.visible) drawTag('BOSS', p.x, p.y - (p.pose === 'sit' ? p.ch.front.hip + 10 : 40));
  }
  if (you) { kit.drawOverlay(you, 0, 0, { dots: org.root?.state === 'waiting' }); drawTag('YOU', you.x, you.y - you.ch.front.hip - 10, '#8a7cff', '#fff'); }
}
/** Zoomed out: crisp screen-space labels with each room's live counts. */
function drawLabels() {
  if (cam.z >= 2.2) return;
  g.setTransform(1, 0, 0, 1, 0, 0);
  const k = 2;
  for (const r of rooms) {
    const s = toScreen(r.x, r.y + r.h / 2);
    if (s.x < -300 || s.y < -40 || s.x > innerWidth || s.y > innerHeight) continue;
    const name = r.annex ? `${r.mgr.name} annex` : r.mgr.name;
    const busy = r.seats.filter((q) => q.occupant?.working).length;
    const line2 = `${busy} busy  R${r.counts.research} C${r.counts.code} B${r.counts.bug}`;
    const w = Math.max(textWidth(name, k), textWidth(line2, 1) * 2) + 12;
    const x = Math.round(s.x + 6), y = Math.round(s.y - 14);
    kit.px(x - 2, y - 2, w + 4, 32, '#0f0c16'); kit.px(x, y, w, 28, '#2b2438'); kit.px(x, y, 3, 28, r.col.color);
    kit.text(name, x + 7, y + 3, '#f4eefc', k);
    kit.text(line2, x + 7, y + 17, '#a79fbd', 2);
  }
}

// -------------------------------------------------------------------- loop
let you, last = performance.now(), time = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now; time += dt;
  if (!drag) { const k = Math.min(1, dt * 7); cam.x += (cam.tx - cam.x) * k; cam.y += (cam.ty - cam.y) * k; cam.z += (cam.tz - cam.z) * k; }
  for (const p of people.values()) kit.update(p, dt);
  if (you) kit.update(you, dt);
  for (const r of [exec, ...rooms]) r.flash = Math.max(0, r.flash - dt);
  kit.tick(dt);
  if (dirty) paintBackground();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = '#1d1828'; g.fillRect(0, 0, cv.width, cv.height);
  g.setTransform(cam.z, 0, 0, cam.z, -cam.x * cam.z, -cam.y * cam.z);
  g.imageSmoothingEnabled = false;
  drawWorld(time);
  drawLabels();
  g.setTransform(1, 0, 0, 1, 0, 0);
  requestAnimationFrame(frame);
}

// --------------------------------------------------------------- controls
function setStatus() {
  document.getElementById('status').textContent = `Office grid · ${columns.length} departments · ${rooms.length} sub-offices · ${org.list.length} agents · ${org.root?.state === 'waiting' ? 'orchestrator waiting for you' : 'working'}`;
}
document.getElementById('preset').onchange = (e) => { location.search = '?preset=' + e.target.value; };
document.getElementById('b-wait').onclick = (e) => { const on = org.root.state !== 'waiting'; org.setWaiting(on); e.target.classList.toggle('on', on); };
document.getElementById('b-spawn').onclick = () => {
  const leads = org.managers.filter((m) => m.children.filter((c) => c.role === 'worker').length < 8);
  if (leads.length) org.add(leads[Math.floor(Math.random() * leads.length)], 'worker');
};
document.getElementById('b-team').onclick = () => {
  const leads = org.managers.filter((m) => m.depth < 3);
  const m = org.add(leads[Math.floor(Math.random() * leads.length)], 'manager');
  setTimeout(() => { for (let i = 0; i < 3; i++) org.add(m, 'worker'); }, 1500);
};
document.getElementById('b-fit').onclick = fitAll;
setInterval(setStatus, 1000);

// -------------------------------------------------------------------- go
resize();
org.build(presetName);
await new Promise((r) => setTimeout(r, 50)); // let async spawns settle
you = await kit.person(YOU_LOOK, 'you');
seatNow(you, exec.reception); you.working = true;
fitAll(); cam.x = cam.tx; cam.y = cam.ty; cam.z = cam.tz;
setStatus();
document.getElementById('loading').remove();
org.simulate({ max: 70 });
requestAnimationFrame(frame);
window.dbg = { org, rooms, columns, people, cam, exec, frameRect };
