// Tower view: one floor per manager, stacked in hierarchy order (depth-first),
// the orchestrator in the penthouse and you in the lobby. Subagents ride the
// elevator to their team's floor; finished work is carried back up to the lead.
import { loadAll } from './sprites.js';
import {
  createKit, blockSeats, deskSeat, LOOKS, MANAGER_LOOKS, BOSS_LOOK, YOU_LOOK, TONES, ZONE_COLORS,
  step, call, wait, walkPath, climbIn, climbOut, seatNow, emote, flyBubble, bump, sayAt, textWidth,
} from './kit.js';
import { Org } from './org.js';

const W = 400, FH = 84, ROOF = 70, LOBBY = 96, WALK = FH - 7, SHAFT = { x: 4, w: 22 };
const BLOCK_X = [36, 124, 212], BLOCK_Y = 36;
const cv = document.getElementById('screen');
const g = cv.getContext('2d');
const scroller = document.getElementById('scroller');
const imgs = await loadAll();
const kit = await createKit(imgs, g);
const params = new URLSearchParams(location.search);
const presetName = params.get('preset') || 'departments';
document.getElementById('preset').value = presetName;

// Pre-rendered plank strips, one per tone.
const strips = TONES.map((t, i) => {
  const c = document.createElement('canvas'); c.width = W; c.height = FH - 32;
  kit.planks(c.getContext('2d'), 0, 0, W, FH - 32, t, 11 + i);
  return c;
});

// ------------------------------------------------------------------ model
const org = new Org();
const floors = [];            // ordered top to bottom
const people = new Map();     // agent id -> person
const lobby = { lobby: true, y: 0, ty: 0, people: [] };
lobby.desk = deskSeat(180, 40, 'reception');
let you;

function floorsOf(mgr) { return floors.filter((f) => f.mgr === mgr); }
function makeFloor(mgr, annex) {
  const f = { mgr, annex, y: 0, ty: 0, built: org.building ? 1 : 0, counts: { research: 0, code: 0, bug: 0 }, flash: 0, flashColor: '#fff' };
  f.blocks = BLOCK_X.map((x) => ({ x, y: BLOCK_Y }));
  f.seats = f.blocks.flatMap((b, i) => blockSeats(b, i * 2 + mgr.id));
  if (!annex) f.desk = deskSeat(322, 44, mgr.role === 'orchestrator' ? 'boss' : 'manager');
  const dept = mgr.dept ?? mgr;
  f.tone = mgr.role === 'orchestrator' ? 0 : 1 + ((dept.id * 7) % (TONES.length - 1));
  f.color = mgr.role === 'orchestrator' ? '#e8b94a' : ZONE_COLORS[(dept.id * 5) % ZONE_COLORS.length];
  return f;
}
/** Floors in depth-first hierarchy order; annexes right after their team. */
function reorder() {
  const order = [];
  const visit = (a) => { if (a.role === 'worker') return; order.push(...floorsOf(a)); for (const c of a.children) visit(c); };
  if (org.root) visit(org.root);
  for (const f of floors) if (!order.includes(f)) order.push(f);
  floors.splice(0, floors.length, ...order);
  floors.forEach((f, i) => { f.ty = ROOF + i * FH; if (org.building) f.y = f.ty; });
  lobby.ty = ROOF + floors.length * FH;
  if (org.building) lobby.y = lobby.ty;
  resize();
}
function freeSeat(mgr) {
  for (const f of floorsOf(mgr)) { const s = f.seats.find((q) => !q.occupant && !q.reserved); if (s) return [f, s]; }
  const f = makeFloor(mgr, true);
  floors.push(f); reorder();
  return [f, f.seats[0]];
}

// --------------------------------------------------------------- elevator
const car = { y: 0, door: 0, queue: [], job: null };
const stopY = (fl) => fl.y + 50;
function ride(p, from, to) {
  let done = false;
  return step(() => {
    // `from` defaults to wherever the person is when the ride starts.
    if (!p.rideQueued) { p.rideQueued = true; car.queue.push({ p, from: from ?? p.floor, to, onArrive: () => { done = true; } }); }
    if (done) { p.rideQueued = false; return true; }
    return false;
  });
}
/**
 * One car, shared: it collects everyone waiting on a floor (up to six) and
 * drops them off stop by stop, nearest first.
 */
function updateCar(dt) {
  const move = (fl) => { const t = stopY(fl), d = t - car.y; car.y += Math.sign(d) * Math.min(Math.abs(d), 260 * dt); return Math.abs(d) < 0.5; };
  const open = () => (car.door = Math.min(1, car.door + dt * 4)) === 1;
  const shut = () => (car.door = Math.max(0, car.door - dt * 4)) === 0;
  if (!car.job) {
    if (!shut() || !car.queue.length) return;
    car.job = { phase: 'fetch', from: car.queue[0].from, riders: [] };
  }
  const j = car.job;
  if (j.phase === 'fetch') { if (move(j.from)) j.phase = 'board'; }
  else if (j.phase === 'board') {
    if (!open()) return;
    for (const r of car.queue.filter((q) => q.from === j.from).slice(0, 6)) { car.queue.splice(car.queue.indexOf(r), 1); r.p.visible = false; j.riders.push(r); }
    j.phase = 'depart';
  } else if (j.phase === 'depart') { if (shut()) j.phase = 'next'; }
  else if (j.phase === 'next') {
    if (!j.riders.length) { car.job = null; return; }
    j.stop = j.riders.map((r) => r.to).sort((x, y) => Math.abs(stopY(x) - car.y) - Math.abs(stopY(y) - car.y))[0];
    j.phase = 'go';
  } else if (j.phase === 'go') { if (move(j.stop)) j.phase = 'alight'; }
  else if (j.phase === 'alight') {
    if (!open()) return;
    j.riders.filter((r) => r.to === j.stop).forEach((r, i) => {
      setFloor(r.p, r.to); r.p.x = 15 + i * 3; r.p.y = WALK; r.p.dir = 'right'; r.p.visible = true; r.onArrive();
    });
    j.riders = j.riders.filter((r) => r.to !== j.stop);
    j.phase = 'depart';
  }
}
function setFloor(p, fl) {
  if (p.floor) p.floor.people = p.floor.people?.filter((q) => q !== p);
  p.floor = fl; (fl.people ??= []).push(p);
}
/** Walk to the elevator, ride to another floor (if needed), step out. */
function travel(p, to) {
  if (p.floor === to) return [];
  return [walkPath(p, () => [{ x: p.x, y: WALK }, { x: 15, y: WALK }]), ride(p, null, to)];
}

// ------------------------------------------------------------ org events
org.on('spawn', async (a, { initial }) => {
  if (a.role !== 'worker') {
    const f = makeFloor(a, false);
    floors.push(f); reorder();
  }
  const look = a.role === 'orchestrator' ? BOSS_LOOK : a.role === 'manager' ? MANAGER_LOOKS[a.id % MANAGER_LOOKS.length] : LOOKS[a.id % LOOKS.length];
  const p = await kit.person(look, a.role, a);
  people.set(a.id, p);
  if (a.role === 'worker') {
    const [f, seat] = freeSeat(a.parent);
    seat.reserved = true;
    p.home = f;
    if (initial) { setFloor(p, f); seatNow(p, seat); p.working = true; return; }
    enterBuilding(p, f, seat, () => { a.ready = true; p.working = true; });
  } else {
    const f = floorsOf(a)[0];
    p.home = f;
    if (initial) { setFloor(p, f); seatNow(p, f.desk); p.working = a.role !== 'orchestrator' || a.state === 'working'; return; }
    enterBuilding(p, f, f.desk, () => { a.ready = true; p.working = true; });
  }
});
function enterBuilding(p, f, seat, then) {
  setFloor(p, lobby); p.x = W - 12; p.y = WALK; p.dir = 'left';
  p.script.push(
    walkPath(p, [{ x: 15, y: WALK }]),
    ride(p, lobby, f),
    walkPath(p, () => [{ x: seat.approach.x, y: WALK }, seat.approach]),
    climbIn(p, seat),
    call(then),
  );
}
org.on('finish', (a) => {
  const p = people.get(a.id), boss = people.get(a.parent.id);
  if (!p) return;
  const lead = boss?.home;
  p.script.push(
    climbOut(p, p.seat),
    ...(lead ? [...travel(p, lead), walkPath(p, () => [{ x: p.x, y: WALK }, { x: lead.desk.approach.x, y: WALK }, lead.desk.approach])] : []),
    call(() => { p.dir = 'left'; emote(p, 'yes', 1.2); if (boss) emote(boss, 'yes', 1.2); }),
    wait(1.2),
    walkPath(p, () => [{ x: p.x, y: WALK }, { x: 15, y: WALK }]),
    ride(p, null, lobby),
    walkPath(p, [{ x: W + 20, y: WALK }]),
    call(() => { setFloor(p, { people: [] }); people.delete(a.id); org.remove(a); }),
  );
  // Prune empty annex floors later.
  setTimeout(pruneAnnexes, 9000);
});
function pruneAnnexes() {
  for (const f of [...floors]) {
    if (f.annex && f.seats.every((s) => !s.occupant && !s.reserved) && !(f.people ?? []).length) floors.splice(floors.indexOf(f), 1);
  }
  reorder();
}
org.on('event', (a, type) => {
  const p = people.get(a.id);
  if (!p || !p.floor || p.floor.lobby) return bump(type);
  const f = p.floor;
  f.counts[type]++; f.flash = 0.6; f.flashColor = type === 'bug' ? '#ff5a5a' : type === 'code' ? '#3ecf6e' : '#4a9eff';
  if (type === 'bug') { p.shake = 0.5; const boss = people.get(a.parent?.id); if (boss && Math.random() < 0.3) emote(boss, 'no', 1.2); }
  const s = toScreen(p.x, f.y + p.y - 26);
  if (s.y > 60 && s.y < innerHeight - 60) flyBubble(s, type); else bump(type);
});
org.on('state', (a) => {
  const p = people.get(a.id);
  if (p) p.working = a.state === 'working';
  setStatus();
});

// ---------------------------------------------------------------- drawing
let scale = 2, overview = false;
function resize() {
  const H = ROOF + floors.length * FH + LOBBY + 20;
  if (cv.height !== H) { cv.width = W; cv.height = H; g.imageSmoothingEnabled = false; }
  const fitW = (scroller.clientWidth - 24) / W, fitH = (innerHeight - 170) / H;
  scale = overview ? Math.min(fitW, fitH) : (fitW >= 2 ? Math.floor(Math.min(fitW, 4)) : fitW);
  cv.style.width = W * scale + 'px'; cv.style.height = H * scale + 'px';
}
addEventListener('resize', resize);
const toScreen = (x, y) => { const r = cv.getBoundingClientRect(); return { x: r.left + x * scale, y: r.top + y * scale }; };

function drawSky(t) {
  kit.px(0, 0, W, ROOF, '#62b6f0');
  const off = Math.floor(t * 4) % 256;
  for (let x = -off; x < W; x += 256) g.drawImage(imgs.office, 0, 0, 256, 30, x, 2, 256, 30);
  // Roof: parapet, sign, antenna.
  kit.px(0, ROOF - 12, W, 12, '#3b3452'); kit.px(0, ROOF - 12, W, 2, '#5d5478');
  const label = 'AGENT HQ', k = 2, tw = textWidth(label, k);
  kit.px(W / 2 - tw / 2 - 6, ROOF - 32, tw + 12, 18, '#2b2438'); kit.px(W / 2 - tw / 2 - 5, ROOF - 31, tw + 10, 16, '#3a3150');
  kit.text(label, W / 2 - tw / 2, ROOF - 27, '#e8b94a', k);
  kit.px(W / 2 - 16, ROOF - 14, 2, 2, '#2b2438'); kit.px(W / 2 + 14, ROOF - 14, 2, 2, '#2b2438');
  kit.px(360, ROOF - 44, 2, 32, '#5d5478'); kit.px(354, ROOF - 30, 14, 2, '#5d5478');
  kit.px(359, ROOF - 47, 4, 4, Math.floor(t * 2) % 2 ? '#ff5a5a' : '#6b2230');
}
function drawShaft(y0, y1) {
  kit.px(SHAFT.x, y0, SHAFT.w, y1 - y0, '#241e33');
  kit.px(SHAFT.x + 3, y0, 1, y1 - y0, '#3b3452'); kit.px(SHAFT.x + SHAFT.w - 4, y0, 1, y1 - y0, '#3b3452');
}
function drawDoor(oy) {
  // Sliding doors open while the car is stopped here.
  const here = Math.abs(car.y - (oy + 50)) < 1 ? car.door : 0;
  const w = Math.round(9 * (1 - here));
  kit.px(SHAFT.x - 1, oy + 49, SHAFT.w + 2, 2, '#5d5478'); kit.px(SHAFT.x - 1, oy + 49, 2, 29, '#5d5478'); kit.px(SHAFT.x + SHAFT.w - 1, oy + 49, 2, 29, '#5d5478');
  if (!here) kit.px(SHAFT.x + 1, oy + 51, 20, 26, '#1a1526');
  kit.px(SHAFT.x + 1, oy + 51, w, 26, '#9aa3b5'); kit.px(SHAFT.x + 21 - w, oy + 51, w, 26, '#9aa3b5');
  if (w > 1) { kit.px(SHAFT.x + 1 + w - 1, oy + 51, 1, 26, '#6d7688'); kit.px(SHAFT.x + 21 - w, oy + 51, 1, 26, '#c3cad6'); }
}
function drawTag(text, x, y, bg = '#e8b94a', fg = '#2b1d05') {
  const w = textWidth(text) + 4;
  kit.px(x - w / 2 - 1, y - 1, w + 2, 9, '#0f0c16'); kit.px(x - w / 2, y, w, 7, bg);
  kit.text(text, x - w / 2 + 2, y + 1, fg);
}
function drawFloor(f, idx) {
  const oy = Math.round(f.y);
  kit.px(0, oy, W, 4, '#3b3452');
  kit.wall(g, 26, oy + 4, W - 26, 28);
  g.drawImage(strips[f.tone], 0, 0, W - 26, FH - 32, 26, oy + 32, W - 26, FH - 32);
  // Wall: team plaque, level number, windows, per-floor counters.
  const name = f.annex ? `${f.mgr.name} annex` : f.mgr.role === 'orchestrator' ? 'Orchestrator' : `Team ${f.mgr.name}`;
  const tw = textWidth(name);
  kit.px(31, oy + 9, tw + 10, 13, '#0f0c16'); kit.px(32, oy + 10, tw + 8, 11, '#2b2438');
  kit.px(32, oy + 10, 2, 11, f.color);
  kit.text(name, 37, oy + 13, '#f4eefc');
  kit.text(`${floors.length - idx}F`, 9, oy + 42, '#9aa3b5');
  kit.spr(idx % 2 ? 'window' : 'windowNote', 190, oy + 7);
  kit.spr('window', 236, oy + 7);
  const c = f.counts, cols = [['research', '#4a9eff'], ['code', '#3ecf6e'], ['bug', '#ff5a5a']];
  let cx = 304;
  for (const [k, col] of cols) { kit.px(cx, oy + 13, 5, 5, col); kit.text(String(c[k]), cx + 7, oy + 13, '#4a3d5c'); cx += 30; }
  if (f.flash > 0) { g.globalAlpha = Math.min(1, f.flash * 2); kit.px(26, oy + 4, W - 26, 2, f.flashColor); g.globalAlpha = 1; }
  // Manager's glass office (or a small lounge on annex floors).
  kit.px(300, oy + 32, 100, FH - 36, 'rgba(255,255,255,0.08)');
  for (let yy = oy + 32; yy < oy + FH - 4; yy += 2) kit.px(300, yy, 2, 1, 'rgba(170,215,255,0.9)');
  kit.px(299, oy + 32, 4, 2, '#5d5478');
  drawDoor(oy);
  const drawn = [];
  for (let i = 0; i < f.blocks.length; i++) drawn.push({ y: BLOCK_Y + 30, d: () => kit.drawBlock(f.blocks[i], f.seats.slice(i * 2, i * 2 + 2), 0, oy) });
  if (f.desk) drawn.push({ y: f.desk.deskY + 16, d: () => kit.drawDeskSeat(f.desk, 0, oy) });
  else drawn.push({ y: 70, d: () => { kit.spr('sofaGreen', 326, oy + 52); kit.spr('plant', 372, oy + 50); } });
  for (const p of f.people ?? []) if (!(p.seat && (p.pose === 'sit' || p.hop))) drawn.push({ y: p.y, d: () => kit.drawStanding(p, 0, oy) });
  drawn.sort((a, b) => a.y - b.y).forEach((x) => x.d());
  if (f.built < 1) {
    g.globalAlpha = 1 - f.built;
    kit.px(26, oy + 4, W - 26, FH - 4, '#f4c542');
    for (let x = 26; x < W; x += 12) kit.px(x, oy + 4, 6, FH - 4, '#2b2438');
    g.globalAlpha = 1;
  }
}
function drawLobby(t) {
  const oy = Math.round(lobby.y);
  kit.px(0, oy, W, 4, '#3b3452');
  kit.wall(g, 26, oy + 4, W - 26, 28);
  g.drawImage(strips[4], 0, 0, W - 26, FH - 32, 26, oy + 32, W - 26, FH - 32);
  kit.spr('door', 356, oy + 1); kit.spr('door', 372, oy + 1);
  kit.px(354, oy - 1, 36, 2, '#3b3452');
  kit.text('LOBBY', 37, oy + 13, '#4a3d5c');
  kit.spr('clock', 150, oy + 8);
  drawDoor(oy);
  const drawn = [
    { y: 60, d: () => kit.drawDeskSeat(lobby.desk, 0, oy) },
    { y: 66, d: () => { kit.spr('sofaBlue', 60, oy + 50); kit.spr('plant', 100, oy + 48); kit.spr('plant', 330, oy + 48); } },
  ];
  for (const p of lobby.people ?? []) if (p !== you) drawn.push({ y: p.y, d: () => kit.drawStanding(p, 0, oy) });
  drawn.sort((a, b) => a.y - b.y).forEach((x) => x.d());
  // Street.
  kit.px(0, oy + FH, W, LOBBY - FH + 20, '#2a2438');
  for (let x = 6; x < W; x += 28) kit.px(x, oy + FH + 7, 14, 2, '#5d5478');
}
function drawCar() {
  const y = Math.round(car.y);
  kit.px(SHAFT.x + 1, y, 20, 26, '#c9a045'); kit.px(SHAFT.x + 2, y + 1, 18, 24, '#8a6414');
  kit.px(SHAFT.x + 3, y + 3, 16, 10, '#f4d27a');
  (car.job?.riders ?? []).slice(0, 3).forEach((r, i) => kit.px(SHAFT.x + 4 + i * 5, y + 6, 4, 6, r.p.ch.sit.skin));
  kit.px(SHAFT.x + 10, ROOF, 1, Math.max(0, y - ROOF), '#15111f');
}

// -------------------------------------------------------------------- loop
let last = performance.now(), time = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now; time += dt;
  for (const f of floors) { f.y += (f.ty - f.y) * Math.min(1, dt * 6); if (Math.abs(f.ty - f.y) < 0.3) f.y = f.ty; f.built = Math.min(1, f.built + dt * 0.8); f.flash = Math.max(0, f.flash - dt); }
  lobby.y += (lobby.ty - lobby.y) * Math.min(1, dt * 6);
  for (const p of people.values()) kit.update(p, dt);
  if (you) kit.update(you, dt);
  updateCar(dt);
  kit.tick(dt);

  g.fillStyle = '#1d1828'; g.fillRect(0, 0, cv.width, cv.height);
  drawSky(time);
  drawShaft(ROOF, lobby.y + FH);
  drawCar();
  floors.forEach(drawFloor);
  drawLobby(time);
  kit.px(0, ROOF, 4, lobby.y + FH - ROOF, '#3b3452'); kit.px(W - 4, ROOF, 4, lobby.y + FH - ROOF, '#3b3452');
  kit.drawFlashes();
  // Overlays: emotes, tags, waiting dots.
  for (const p of people.values()) {
    const oy = p.floor?.y ?? 0;
    kit.drawOverlay(p, 0, oy);
    if (p.agent?.role === 'orchestrator' && p.visible) drawTag('BOSS', p.x, oy + p.y - (p.pose === 'sit' ? p.ch.front.hip + 10 : 40));
  }
  if (you) {
    kit.drawOverlay(you, 0, lobby.y, { dots: org.root?.state === 'waiting' });
    drawTag('YOU', you.x, lobby.y + you.y - you.ch.front.hip - 10, '#8a7cff', '#fff');
  }
  requestAnimationFrame(frame);
}

// --------------------------------------------------------------- controls
function setStatus() {
  const n = org.list.length, m = org.managers.length;
  document.getElementById('status').textContent = `Tower · ${m} teams · ${n} agents · ${org.root?.state === 'waiting' ? 'orchestrator waiting for you' : 'working'} · scroll to explore`;
}
document.getElementById('preset').onchange = (e) => { location.search = '?preset=' + e.target.value; };
document.getElementById('b-wait').onclick = (e) => { const on = org.root.state !== 'waiting'; org.setWaiting(on); e.target.classList.toggle('on', on); };
document.getElementById('b-spawn').onclick = () => {
  const leads = org.managers.filter((m) => m.children.filter((c) => c.role === 'worker').length < 8);
  if (leads.length) org.add(leads[Math.floor(Math.random() * leads.length)], 'worker');
};
document.getElementById('b-team').onclick = () => {
  const leads = org.managers.filter((m) => m.depth < 3);
  const lead = leads[Math.floor(Math.random() * leads.length)];
  const m = org.add(lead, 'manager');
  setTimeout(() => { for (let i = 0; i < 3; i++) org.add(m, 'worker'); }, 2000);
};
document.getElementById('b-zoom').onclick = (e) => { overview = !overview; e.target.textContent = overview ? 'Detail' : 'Overview'; e.target.classList.toggle('on', overview); resize(); };
setInterval(setStatus, 1000);

// -------------------------------------------------------------------- go
org.build(presetName);
reorder();
you = await kit.person(YOU_LOOK, 'you');
setFloor(you, lobby); seatNow(you, lobby.desk); you.working = true;
car.y = stopY(lobby);
resize();
setStatus();
document.getElementById('loading').remove();
org.simulate();
requestAnimationFrame(frame);
window.dbg = { org, floors, people, car, lobby };
