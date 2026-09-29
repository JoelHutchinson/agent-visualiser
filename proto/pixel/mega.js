// Mega office: a real building generated from the agent hierarchy, drawn with
// the LimeZu Modern Office pack (if installed) and CC0 MetroCity people.
//
// Plan (16px tiles):  executive wing (lobby, boss, war room, break room)
//                     main corridor
//                     department wings: corridor + stacked team rooms
// Rooms only ever append (new wings to the right, new rooms at the bottom of a
// wing), so nobody's desk moves when the organisation grows.
import { loadAll, DIR } from './sprites.js';
import { createKit, LOOKS, MANAGER_LOOKS, BOSS_LOOK, YOU_LOOK, ZONE_COLORS, call, wait, emote, flyBubble, bump, sayAt, textWidth, step, ease } from './kit.js';
import { Org } from './org.js';
import { loadPack } from './packs/limezu.js';

const T = 16;                    // tile size
const CW = 21;                   // wing width in tiles (3 corridor + 18 room)
const RH = 13;                   // team room pitch in tiles (walls shared)
const EXEC_H = 14;               // executive wing: rows 0..14 (14 = south wall)
const WING_Y = 18;               // first wing room top wall
const WALL = '#f8f8f8', EDGE = '#3a3a50';

const cv = document.getElementById('screen');
const g = cv.getContext('2d');
const [imgs, pack] = await Promise.all([loadAll(), loadPack()]);
if (!pack) { document.getElementById('loading').remove(); document.getElementById('missing').style.display = 'grid'; throw new Error('pack missing'); }
document.getElementById('credit').textContent = `Office art: ${pack.credit} · people: MetroCity (CC0)`;
const S = pack.sprites;
const kit = await createKit(imgs, g);
const presetName = new URLSearchParams(location.search).get('preset') || 'solo';
document.getElementById('preset').value = presetName;

// ------------------------------------------------------------------- plan
const org = new Org();
const people = new Map();
const rooms = [];             // every walled room, exec ones first
const wings = [];             // department wings, left to right
const props = [];             // static furniture: { sprite, x, y, sort, solid? }
const pods = [];              // desk pods with two seats each
const pets = [];              // the studio cat and corgi
let GW = 32, GH = 18;
let dirty = true, navDirty = true;

const rect = (x0, y0, x1, y1) => ({ x0, y0, x1, y1 });
function addProp(sprite, x, y, { sort, solid = false, pad = 0 } = {}) {
  const s = S[sprite];
  const p = { s, draw: null, x: Math.round(x), y: Math.round(y), sort: sort ?? y + s.height, solid: solid ? { x: x + pad, y: y + s.height * 0.35, w: s.width - pad * 2, h: s.height * 0.65 } : null };
  props.push(p); navDirty = true;
  return p;
}
function addCustom(x, y, w, h, sort, draw, solid = false) {
  const p = { s: null, x, y, w, h, sort, draw, solid: solid ? { x, y: y + h * 0.4, w, h: h * 0.6 } : null };
  props.push(p); navDirty = true;
  return p;
}
/** Two seats at a desk facing up (sitters have their backs to us). */
function addPod(room, px, py) {
  const desk = addProp('deskWhiteBig', px, py, { solid: true });
  const pod = { room, desk, x: px, y: py, seats: [] };
  for (const dx of [6, 25]) {
    const seat = { pod, facing: 'up', chairX: px + dx, chairY: py + 34, dx: 0, dy: 0, occupant: null, reserved: false,
                   monX: px + dx, monY: py + 4 };
    seat.seatX = seat.chairX + 8; seat.seatY = py + 47;
    seat.approach = { x: seat.seatX, y: py + 64 };
    pod.seats.push(seat);
  }
  pods.push(pod);
  return pod;
}
/** A desk the sitter faces down from (managers, the boss, reception). */
function addDeskSeat(room, sprite, x, y) {
  const desk = addProp(sprite, x, y, { solid: true });
  const cx = x + Math.round(desk.s.width / 2);
  const seat = { room, facing: 'down', desk, chairX: cx - 8, chairY: y - 22, dx: 0, dy: 0, occupant: null, seatX: cx, seatY: y - 3,
                 approach: { x: x + desk.s.width + 10, y: y + 8 } };
  addProp('monitorBack', cx + 6, y - 2, { sort: y + desk.s.height + 1 });
  return seat;
}

function makeRoom(kind, x0, y0, x1, y1, opts = {}) {
  const r = { kind, ...rect(x0, y0, x1, y1), doors: [], floor: opts.floor ?? 'carpetGrey', face: opts.face ?? 'facePlain', name: opts.name ?? '', color: opts.color ?? '#e8b94a',
              counts: { research: 0, code: 0, bug: 0 }, flash: 0, flashColor: '#fff', seats: [], mgr: opts.mgr ?? null, annex: !!opts.annex };
  r.ix = (x0 + 1) * T; r.iy = (y0 + 3) * T;               // usable interior origin (below the wall face)
  r.iw = (x1 - x0 - 1) * T; r.ih = (y1 - y0 - 3) * T;
  rooms.push(r); dirty = true; navDirty = true;
  return r;
}

// ------------------------------------------------------------ furnishing
// Reusable fit-outs; each registers its activity spots in EXEC.spots.
function furnishPlanning(room, xs, iy) {
  xs.forEach((bx, i) => {
    const board = addProp(i === 2 ? 'chartBoard' : 'whiteboard', bx, iy - 28, { sort: iy - 1 });
    board.ink = [];
    board.draw = (p) => { for (const k of p.ink) kit.px(p.x + k.x, p.y + k.y, k.w, 1, k.c); };
    EXEC.spots.plan.push({ x: bx + 15, y: iy + 20, dir: 'up', board, room });
  });
}
function furnishMeeting(room, ox, oy) {
  addProp('deskWoodBig', ox + 70, oy + 56, { solid: true }); addProp('deskWoodBig', ox + 116, oy + 56, { solid: true });
  for (const [x, y, dir] of [[82, 44, 'down'], [104, 44, 'down'], [128, 44, 'down'], [150, 44, 'down'], [82, 110, 'up'], [104, 110, 'up'], [128, 110, 'up'], [150, 110, 'up'], [58, 78, 'right'], [176, 78, 'left']])
    EXEC.spots.meet.push({ x: ox + x, y: oy + y, dir, room });
}
function furnishWaiting(room, x0, y0, cols, rows, signX, signY) {
  const pods = ['podBlue', 'podGrey', 'podLilac', 'podGold'];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = x0 + c * 24, y = y0 + r * 44;
    addProp(pods[(r * cols + c) % 4], x, y, { sort: y + 4 });
    EXEC.spots.wait.push({ x: x + 8, y: y + 12, dir: 'down', room, sit: true });
  }
  addCustom(signX, signY, 60, 14, signY + 30, (p) => {
    const n = EXEC.spots.wait.filter((q) => q.user).length;
    kit.px(p.x - 1, p.y - 1, p.w + 2, p.h + 2, EDGE); kit.px(p.x, p.y, p.w, p.h, '#15111f');
    kit.text(`WAITING ${n}`, p.x + 6, p.y + 5, n ? '#ff8f70' : '#6d6680');
  });
}
function furnishLibrary(room, xs, iy, freeRow = null) {
  xs.forEach((x, i) => { addProp(i % 3 === 2 ? 'shelfWhite' : 'bookshelf', x, iy - 20, { sort: iy + 10 }); EXEC.spots.lib.push({ x: x + 15, y: iy + 26, dir: 'up', room }); });
  if (freeRow) freeRow.xs.forEach((x, i) => { addProp(i % 2 ? 'shelfWhite' : 'bookshelf', x, freeRow.y, { solid: true }); EXEC.spots.lib.push({ x: x + 15, y: freeRow.y + 54, dir: 'up', room }); });
}
function furnishServer(room, xs, y) {
  xs.forEach((x, i) => {
    const rack = addCustom(x, y, 22, 44, y + 44, (p) => {
      kit.px(p.x - 1, p.y - 1, p.w + 2, p.h + 2, EDGE); kit.px(p.x, p.y, p.w, p.h, '#2d2f45'); kit.px(p.x + 2, p.y + 2, p.w - 4, 2, '#454864');
      const t = performance.now() / 1000;
      for (let r = 0; r < 6; r++) for (let c = 0; c < 3; c++) {
        const on = ((Math.sin(t * (3 + r + c) + i * 7 + r * 13) + 1) / 2) > (p.busy ? 0.3 : 0.75);
        kit.px(p.x + 4 + c * 6, p.y + 8 + r * 6, 2, 2, !on ? '#1c1d2b' : p.fail > 0 ? '#ff5a5a' : '#6dff8c');
        kit.px(p.x + 9 + c * 6, p.y + 8 + r * 6, 3, 1, '#3c3f59');
      }
    }, true);
    rack.fail = 0; EXEC.racks.push(rack);
    EXEC.spots.srv.push({ x: x + 11, y: y + 62, dir: 'up', room, rack });
  });
}
function furnishCoffee(room, x, y) {
  addProp('vending', x, y, { solid: true }); addProp('fridge', x + 28, y, { solid: true }); addProp('waterCooler', x + 56, y + 8, { solid: true });
  EXEC.coffee = { x: x + 30, y: y + 46, room };
}

// ---------------------------------------------------------------- tiers
// studio: one room (the usual case) · office: compact building · mega: full.
const TIERS = ['studio', 'office', 'mega'];
let TIER = 'studio', EXEC, ENTRANCE, CORRIDOR = false, minGW = 32;
function resetLayout() {
  rooms.length = 0; wings.length = 0; props.length = 0; pods.length = 0; pets.length = 0;
  EXEC = { spots: { plan: [], meet: [], wait: [], lib: [], srv: [] }, racks: [] };
  dirty = true; navDirty = true;
}

function buildStudio() {
  // One open studio (x 0..26) with a walled server room and break room on the right.
  CORRIDOR = false; minGW = 36; GW = 36; GH = 18;
  const r = makeRoom('studio', 0, 0, 35, 17, { floor: 'carpetGrey', face: 'faceMarble', name: 'Studio', color: '#e8b94a' });
  r.doors.push([4, 17], [5, 17]);
  const srv = makeRoom('server', 26, 0, 35, 8, { floor: 'floorGreyTile', face: 'faceStone', name: 'Servers', color: '#8be07b' });
  srv.doors.push([26, 6], [26, 7]);
  const brk = makeRoom('break', 26, 8, 35, 17, { floor: 'floorWhiteWood', face: 'faceStone', name: 'Break room', color: '#ffb36b' });
  brk.doors.push([26, 14], [26, 15]);
  ENTRANCE = { x: 80, y: 17 * T + 8 };
  let { ix, iy } = r;
  EXEC.bossRoom = EXEC.warRoom = r;
  EXEC.bossSeat = r.desk = addDeskSeat(r, 'deskWoodBig', ix + 170, iy + 22);
  addProp('plantTall', ix + 222, iy - 8); addProp('certificate', ix + 178, iy - 26, { sort: iy - 1 }); addProp('lamp', ix + 154, iy + 28, { sort: iy + 50 });
  const podsS = [addPod(r, ix + 110, iy + 100), addPod(r, ix + 164, iy + 100), addPod(r, ix + 218, iy + 100)];
  EXEC.warSeats = r.seats = podsS.flatMap((p) => p.seats);
  furnishPlanning(r, [ix + 20, ix + 64], iy);
  furnishLibrary(r, [ix + 300, ix + 334], iy);
  furnishWaiting(r, ix + 6, iy + 150, 3, 1, ix + 6, iy + 124);
  EXEC.youSeat = addDeskSeat(r, 'deskTanBig', ix + 90, iy + 168);
  addProp('artFaces', ix + 112, iy - 26, { sort: iy - 1 }); addProp('plantBig', ix + 2, iy - 6); addProp('plantBig', ix + 380, iy + 110);
  addProp('sofa', ix + 296, iy + 176, { solid: true });
  pets.push({ kind: 'corgi', x: ix + 350, y: iy + 214, t: 0 }, { kind: 'cat', x: ix + 200, y: iy + 180, tx: 0, ty: 0, t: 0, rest: 2, flip: false });
  // Server room: racks against the back wall.
  ({ ix, iy } = srv);
  furnishServer(srv, [ix + 8, ix + 38, ix + 68, ix + 98], iy + 2);
  // Break room: vending, fridge and cooler on the wall, a table and chairs.
  ({ ix, iy } = brk);
  furnishCoffee(brk, ix + 6, iy - 18); addProp('snacks', ix + 90, iy - 8, { solid: true });
  addProp('tableRect', ix + 58, iy + 50, { solid: true }); addProp('chairSideR', ix + 44, iy + 44); addProp('chairSideL', ix + 92, iy + 44);
  addProp('plantSmall', ix + 112, iy + 60);
}

function buildBuilding(tier) {
  CORRIDOR = true;
  const full = tier === 'mega';
  // Executive strip: rooms left to right, [kind, name, width in tiles].
  const plan = full
    ? [['lobby', 'Lobby', 13], ['boss', 'Orchestrator', 17], ['war', 'War room', 14], ['break', 'Break room', 14], ['plan', 'Planning', 14], ['meet', 'Meeting room', 16], ['wait', 'Waiting room', 12], ['library', 'Library', 14], ['server', 'Server room', 13]]
    : [['lobby', 'Lobby', 13], ['boss', 'Orchestrator', 17], ['war', 'War room', 14], ['planmeet', 'Planning & meetings', 18], ['library', 'Library', 11], ['break', 'Break room', 12], ['server', 'Server room', 10]];
  minGW = plan.reduce((s, q) => s + q[2], 0) + 1;
  GW = Math.max(minGW, 1 + wings.length * CW + 1); GH = WING_Y + 4;
  ENTRANCE = { x: 6, y: (EXEC_H + 2) * T };
  const STYLE = {
    lobby: ['floorWhiteWood', 'faceMarble'], boss: ['carpetBrown', 'faceMarble'], war: ['carpetMauve', 'facePlain'], break: ['floorGreyTile', 'faceStone'],
    plan: ['carpetTan', 'facePlain'], meet: ['carpetDark', 'faceMarble'], wait: ['floorWhiteWood', 'faceMarble'], library: ['carpetBrown', 'faceBrick'],
    server: ['floorGreyTile', 'faceStone'], planmeet: ['carpetTan', 'facePlain'], commons: ['floorGreyTile', 'faceStone'],
  };
  let x = 0;
  const R = {};
  plan.forEach(([kind, name, w], i) => {
    const x1 = i === plan.length - 1 ? Math.max(x + w, GW - 1) : x + w;
    const r = makeRoom(kind, x, 0, x1, EXEC_H, { floor: STYLE[kind][0], face: STYLE[kind][1], name });
    const mid = Math.floor((x + x1) / 2);
    r.doors.push([mid, EXEC_H], [mid + 1, EXEC_H]);
    R[kind] = r; x = x1;
  });
  let ix, iy;
  // Lobby: reception (you), sofa, art; in the compact office it doubles as the waiting area.
  ({ ix, iy } = R.lobby);
  EXEC.youSeat = R.lobby.desk = addDeskSeat(R.lobby, 'deskWoodBig', ix + 64, iy + 40);
  addProp('sofa', ix + 8, iy + 124, { solid: true }); addProp('plantTall', ix + 2, iy - 10); addProp('plantTall', ix + 174, iy - 10);
  addProp('artFaces', ix + 84, iy - 26, { sort: iy - 1 });
  if (!full) furnishWaiting(R.lobby, ix + 110, iy + 120, 3, 1, ix + 110, iy + 96);
  // Boss office.
  ({ ix, iy } = R.boss);
  EXEC.bossRoom = R.boss; EXEC.bossSeat = R.boss.desk = addDeskSeat(R.boss, 'deskWoodBig', ix + 106, iy + 42);
  addProp('bookshelf', ix + 12, iy - 20); addProp('bookshelf', ix + 44, iy - 20); addProp('shelfWhite', ix + 208, iy - 14);
  addProp('certificate', ix + 150, iy - 26, { sort: iy - 1 }); addProp('certificate', ix + 168, iy - 26, { sort: iy - 1 });
  addProp('sofaL', ix + 8, iy + 104, { solid: true }); addProp('plantTall', ix + 238, iy - 8); addProp('lamp', ix + 146, iy + 40, { sort: iy + 60 });
  // War room: the orchestrator's own subagents.
  ({ ix, iy } = R.war);
  EXEC.warRoom = R.war;
  const wp = [addPod(R.war, ix + 8, iy + 34), addPod(R.war, ix + 62, iy + 34), addPod(R.war, ix + 116, iy + 34)];
  EXEC.warSeats = R.war.seats = wp.flatMap((p) => p.seats);
  addProp('chartBoard', ix + 46, iy - 28, { sort: iy - 1 }); addProp('pieBoard', ix + 118, iy - 28, { sort: iy - 1 }); addProp('plantBig', ix + 190, iy + 120);
  if (full) {
    ({ ix, iy } = R.break);
    furnishCoffee(R.break, ix + 8, iy - 18); addProp('snacks', ix + 92, iy - 8, { solid: true });
    addProp('tableRect', ix + 30, iy + 80, { solid: true }); addProp('chairSideR', ix + 16, iy + 74); addProp('chairSideL', ix + 64, iy + 74);
    addProp('sofa', ix + 110, iy + 130, { solid: true }); addProp('plantBig', ix + 190, iy + 124);
    ({ ix, iy } = R.plan); furnishPlanning(R.plan, [ix + 12, ix + 82, ix + 152], iy); addProp('plantBig', ix + 196, iy + 120);
    ({ ix, iy } = R.meet); furnishMeeting(R.meet, ix, iy); addProp('whiteboard', ix + 100, iy - 28, { sort: iy - 1 }); addProp('plantTall', ix + 4, iy - 8);
    ({ ix, iy } = R.wait); furnishWaiting(R.wait, ix + 16, iy + 34, 6, 2, ix + 58, iy - 26); addProp('plantBig', ix + 2, iy + 128);
    ({ ix, iy } = R.library); furnishLibrary(R.library, [ix + 6, ix + 42, ix + 78, ix + 114, ix + 150, ix + 186], iy, { xs: [ix + 20, ix + 68, ix + 116, ix + 164], y: iy + 72 });
    ({ ix, iy } = R.server); furnishServer(R.server, [ix + 10, ix + 46, ix + 82, ix + 118, ix + 154], iy + 20); addProp('server', ix + 20, iy + 120, { solid: true });
  } else {
    ({ ix, iy } = R.planmeet);
    furnishPlanning(R.planmeet, [ix + 190, ix + 236], iy);
    furnishMeeting(R.planmeet, ix - 30, iy + 6); addProp('plantBig', ix + 2, iy - 6);
    ({ ix, iy } = R.library); furnishLibrary(R.library, [ix + 6, ix + 42, ix + 78, ix + 114], iy, { xs: [ix + 20, ix + 80], y: iy + 72 });
    ({ ix, iy } = R.break);
    furnishCoffee(R.break, ix + 8, iy - 18); addProp('snacks', ix + 92, iy - 8, { solid: true });
    addProp('tableRect', ix + 40, iy + 80, { solid: true }); addProp('chairSideR', ix + 26, iy + 74); addProp('chairSideL', ix + 74, iy + 74);
    addProp('sofa', ix + 100, iy + 130, { solid: true });
    ({ ix, iy } = R.server); furnishServer(R.server, [ix + 8, ix + 38, ix + 68, ix + 98], iy + 20); addProp('server', ix + 14, iy + 120, { solid: true });
  }
}

function wingFor(dept) {
  let w = wings.find((x) => x.dept === dept);
  if (w) return w;
  const i = wings.length;
  w = { dept, x0: 1 + i * CW, nextY: WING_Y, color: ZONE_COLORS[i % ZONE_COLORS.length], floor: ['carpetGrey', 'carpetDark', 'carpetTan', 'carpetMauve', 'carpetPink', 'carpetBrown'][i % 6] };
  wings.push(w);
  GW = Math.max(minGW, 1 + wings.length * CW + 1);
  return w;
}
function makeTeamRoom(mgr, annex) {
  const w = wingFor(mgr.dept ?? mgr);
  const x0 = w.x0 + 3, x1 = w.x0 + CW - 1, y0 = w.nextY, y1 = y0 + RH;
  w.nextY = y1;
  GH = Math.max(GH, y1 + 3);
  const name = annex ? `${mgr.name} annex` : `Team ${mgr.name}`;
  const r = makeRoom('team', x0, y0, x1, y1, { floor: w.floor, face: annex ? 'facePlain' : ['facePlain', 'faceMarble', 'faceStone'][mgr.depth % 3], name, color: w.color, mgr, annex });
  r.doors.push([x0, y1 - 2], [x0, y1 - 1]);
  const { ix, iy } = r;
  const podsA = [addPod(r, ix + 6, iy + 4), addPod(r, ix + 60, iy + 4), addPod(r, ix + 114, iy + 4)];
  const podsB = [addPod(r, ix + 6, iy + 84), addPod(r, ix + 60, iy + 84), addPod(r, ix + 114, iy + 84), addPod(r, ix + 168, iy + 84)];
  r.seats = [...podsA, ...podsB].flatMap((p) => p.seats);
  if (!annex) r.desk = addDeskSeat(r, 'deskTanBig', ix + 194, iy + 18);
  else { addProp('sofa', ix + 196, iy + 14, { solid: true }); addProp('plantBig', ix + 234, iy + 8); }
  addProp(['whiteboard', 'chartBoard', 'pieBoard'][mgr.id % 3], ix + 60, iy - 28, { sort: iy - 1 });
  addProp('plantBig', ix + 236, iy + 130); addProp('plantSmall', ix + 2, iy - 8);
  if (mgr.depth > 1 && !annex) addProp('certificate', ix + 108, iy - 26, { sort: iy - 1 });
  return r;
}
const roomsOf = (mgr) => rooms.filter((r) => r.mgr === mgr);
function freeSeat(mgr) {
  if (mgr.role === 'orchestrator') { const s = EXEC.warSeats.find((q) => !q.occupant && !q.reserved); return [EXEC.warRoom, s ?? EXEC.warSeats[0]]; }
  for (const r of roomsOf(mgr)) { const s = r.seats.find((q) => !q.occupant && !q.reserved); if (s) return [r, s]; }
  const r = makeTeamRoom(mgr, true);
  return [r, r.seats[0]];
}

// -------------------------------------------------------------- cell grid
// 0 void, 1 floor, 2 wall top, 3 wall face (north walls, shown inside rooms)
let cells, floorOf;
function rasterise() {
  cells = new Uint8Array(GW * GH);
  floorOf = new Array(GW * GH).fill('floorGreyTile');
  const at = (x, y) => y * GW + x;
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) cells[at(x, y)] = x === 0 || y === 0 || x === GW - 1 || y === GH - 1 ? 2 : 1;
  // Corridor carpet runners for the wings.
  for (const w of wings) for (let y = WING_Y; y < GH - 1; y++) for (let x = w.x0; x < w.x0 + 3; x++) floorOf[at(x, y)] = 'carpetDark';
  for (const r of rooms) {
    for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) {
      const edge = x === r.x0 || x === r.x1 || y === r.y0 || y === r.y1;
      if (edge) cells[at(x, y)] = 2;
      else { cells[at(x, y)] = y <= r.y0 + 2 ? 3 : 1; floorOf[at(x, y)] = r.floor; }
    }
  }
  // North exterior wall face across the corridor strip is covered by rooms; open the doors.
  for (const r of rooms) for (const [x, y] of r.doors) { cells[at(x, y)] = 1; floorOf[at(x, y)] = 'floorGreyTile'; }
  // Street entrance on the west wall of the main corridor.
  if (CORRIDOR) for (const y of [EXEC_H + 1, EXEC_H + 2]) { cells[at(0, y)] = 1; }
}

// --------------------------------------------------------------- background
const bg = document.createElement('canvas');
function paintBackground() {
  rasterise();
  bg.width = GW * T; bg.height = GH * T;
  const b = bg.getContext('2d');
  b.imageSmoothingEnabled = false;
  b.fillStyle = '#1d1828'; b.fillRect(0, 0, bg.width, bg.height);
  const at = (x, y) => (x < 0 || y < 0 || x >= GW || y >= GH ? 0 : cells[y * GW + x]);
  // Floors (32px blocks tile seamlessly).
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
    if (cells[y * GW + x] !== 1) continue;
    const f = S[floorOf[y * GW + x]];
    b.drawImage(f, (x % 2) * 16, (y % 2) * 16, 16, 16, x * T, y * T, 16, 16);
  }
  // Wall faces: each 2-row face gets the face texture sliced across its width.
  for (const r of rooms) {
    const face = S[r.face];
    for (let x = r.x0 + 1; x < r.x1; x++) b.drawImage(face, 0, 0, 16, 32, x * T, (r.y0 + 1) * T, 16, 32);
    // Name plaque by the door side.
    const w = textWidth(r.name) + 10;
    const px = (r.x0 + 1) * T + 6, py = (r.y0 + 1) * T + 8;
    b.fillStyle = EDGE; b.fillRect(px - 1, py - 1, w + 2, 11);
    b.fillStyle = '#2b2438'; b.fillRect(px, py, w, 9);
    b.fillStyle = r.color; b.fillRect(px, py, 2, 9);
    kit.text(r.name, px + 5, py + 2, '#f4eefc', 1, b);
  }
  // Wall tops: white with dark outline where they meet non-wall.
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
    if (at(x, y) !== 2) continue;
    const X = x * T, Y = y * T;
    b.fillStyle = WALL; b.fillRect(X, Y, T, T);
    b.fillStyle = EDGE;
    if (at(x, y - 1) !== 2) b.fillRect(X, Y, T, 2);
    if (at(x, y + 1) !== 2) b.fillRect(X, Y + T - 2, T, 2);
    if (at(x - 1, y) !== 2) b.fillRect(X, Y, 2, T);
    if (at(x + 1, y) !== 2) b.fillRect(X + T - 2, Y, 2, T);
  }
  // Windows on the exterior north wall faces.
  for (const r of rooms.filter((q) => q.y0 === 0)) {
    for (let x = r.x0 + 3; x < r.x1 - 2; x += 5) {
      const X = x * T + 2, Y = T + 5;
      b.fillStyle = EDGE; b.fillRect(X - 1, Y - 1, 28, 20);
      b.fillStyle = '#9fd3f5'; b.fillRect(X, Y, 26, 18);
      b.fillStyle = '#c9ecff'; b.fillRect(X + 2, Y + 2, 6, 14); b.fillRect(X + 14, Y + 2, 3, 14);
      b.fillStyle = '#f8f8f8'; b.fillRect(X + 12, Y, 2, 18);
    }
  }
  // Street door marker.
  if (CORRIDOR) { b.fillStyle = '#6b5a82'; b.fillRect(0, (EXEC_H + 1) * T, 3, 2 * T); }
  dirty = false;
}

// ------------------------------------------------------------ navigation
const NC = 8;                   // nav cell size
let NW, NH, blocked;
function buildNav() {
  if (dirty) paintBackground();
  NW = GW * 2; NH = GH * 2;
  blocked = new Uint8Array(NW * NH);
  for (let y = 0; y < NH; y++) for (let x = 0; x < NW; x++) if (cells[(y >> 1) * GW + (x >> 1)] !== 1) blocked[y * NW + x] = 1;
  for (const p of props) if (p.solid) {
    for (let y = Math.floor(p.solid.y / NC); y <= Math.floor((p.solid.y + p.solid.h - 1) / NC); y++)
      for (let x = Math.floor(p.solid.x / NC); x <= Math.floor((p.solid.x + p.solid.w - 1) / NC); x++)
        if (x >= 0 && y >= 0 && x < NW && y < NH) blocked[y * NW + x] = 1;
  }
  navDirty = false;
}
const free = (x, y) => x >= 0 && y >= 0 && x < NW && y < NH && !blocked[y * NW + x];
const cellOf = (p) => [Math.max(0, Math.min(NW - 1, Math.floor(p.x / NC))), Math.max(0, Math.min(NH - 1, Math.floor(p.y / NC)))];
function nearestFree([x, y]) {
  if (free(x, y)) return [x, y];
  for (let r = 1; r < 12; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (Math.max(Math.abs(dx), Math.abs(dy)) === r && free(x + dx, y + dy)) return [x + dx, y + dy];
  return [x, y];
}
function findPath(from, to) {
  if (navDirty) buildNav();
  const [sx, sy] = nearestFree(cellOf(from)), [tx, ty] = nearestFree(cellOf(to));
  const N = NW * NH, cost = new Float32Array(N).fill(Infinity), came = new Int32Array(N).fill(-1);
  const heap = [], push = (f, i) => { heap.push([f, i]); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
  const start = sy * NW + sx, goal = ty * NW + tx;
  cost[start] = 0; push(0, start);
  while (heap.length) {
    const [, i] = pop();
    if (i === goal) break;
    const x = i % NW, y = (i / NW) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (!free(nx, ny)) continue;
      const j = ny * NW + nx, c = cost[i] + 1;
      if (c < cost[j]) { cost[j] = c; came[j] = i; push(c + Math.abs(nx - tx) + Math.abs(ny - ty), j); }
    }
  }
  const pts = [];
  for (let i = goal; i !== -1 && i !== start; i = came[i]) pts.unshift({ x: (i % NW) * NC + 4, y: ((i / NW) | 0) * NC + 4 });
  const out = [];
  for (let k = 0; k < pts.length; k++) {
    const a = pts[k - 1] ?? from, b = pts[k], c = pts[k + 1];
    if (!c || Math.sign(b.x - a.x) !== Math.sign(c.x - b.x) || Math.sign(b.y - a.y) !== Math.sign(c.y - b.y)) out.push(b);
  }
  out.push({ x: to.x, y: to.y });
  return out;
}
function walkTo(p, target) {
  let path = null;
  return step((dt) => {
    if (!path) { path = findPath(p, typeof target === 'function' ? target() : target); p.pose = 'stand'; }
    if (!path.length) { p.moving = false; return true; }
    const n = path[0], dx = n.x - p.x, dy = n.y - p.y, d = Math.hypot(dx, dy);
    if (d < 0.8) { p.x = n.x; p.y = n.y; path.shift(); return false; }
    p.moving = true;
    p.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    const v = Math.min(70 * dt, d); p.x += dx / d * v; p.y += dy / d * v;
    return false;
  });
}

// ------------------------------------------------------- sitting choreography
// Up-facing seats: the chair rolls back, the sitter hops in, the chair tucks
// under the desk. Down-facing seats: hop in from the side behind the desk.
function climbIn(p, seat) {
  let t = 0, from;
  const pull = seat.facing === 'up' ? 5 : -4;
  return step((dt) => {
    if (!from) { from = { x: p.x, y: p.y }; seat.occupant = p; p.seat = seat; p.moving = false; p.dir = seat.facing; }
    t += dt;
    if (t < 0.25) seat.dy = pull * ease(t / 0.25);
    else if (t < 0.6) {
      const k = (t - 0.25) / 0.35;
      p.pose = k > 0.5 ? 'sit' : 'stand';
      p.x = from.x + (seat.seatX - from.x) * ease(k); p.y = from.y + (seat.seatY + seat.dy - from.y) * ease(k);
      p.hop = Math.sin(Math.PI * k) * 6;
    } else {
      p.hop = 0;
      const k = Math.min(1, (t - 0.6) / 0.3);
      seat.dy = pull * (1 - ease(k));
      p.x = seat.seatX; p.y = seat.seatY + seat.dy; p.pose = 'sit';
      if (k >= 1) return true;
    }
    return false;
  });
}
function climbOut(p, seat) {
  let t = 0;
  const pull = seat.facing === 'up' ? 5 : -4;
  return step((dt) => {
    t += dt; p.working = false;
    if (t < 0.25) { seat.dy = pull * ease(t / 0.25); p.y = seat.seatY + seat.dy; }
    else if (t < 0.6) {
      const k = (t - 0.25) / 0.35, to = seat.approach;
      p.pose = k > 0.4 ? 'stand' : 'sit'; p.dir = 'down';
      p.x = seat.seatX + (to.x - seat.seatX) * ease(k); p.y = seat.seatY + seat.dy + (to.y - seat.seatY - seat.dy) * ease(k);
      p.hop = Math.sin(Math.PI * k) * 6;
    } else {
      p.hop = 0;
      const k = Math.min(1, (t - 0.6) / 0.25);
      seat.dy = pull * (1 - ease(k));
      if (k >= 1) { seat.occupant = null; seat.reserved = false; p.seat = null; return true; }
    }
    return false;
  });
}
function seatNow(p, seat) { seat.occupant = p; p.seat = seat; p.pose = 'sit'; p.x = seat.seatX; p.y = seat.seatY; p.dir = seat.facing; }

// ---------------------------------------------------------------- drawing
function drawSeated(p, seat) {
  const typing = p.working && p.glance <= 0;
  if (seat.facing === 'up') {
    // Back to us: head and shoulders above the chair back. Turn round when waiting.
    const turned = !p.working || p.glance > 0;
    const f = turned ? p.ch.front : p.ch.frames[DIR.up];
    const bob = typing && Math.floor(p.t * 5) % 4 === 0 ? 1 : 0;
    const x = Math.round(p.x - 16), y = Math.round(p.y - (turned ? p.ch.front.hip : 30) - p.hop) + bob;
    g.drawImage(f, x, y);
  } else {
    const s = p.ch.front;
    g.drawImage(s, Math.round(p.x - 16), Math.round(p.y - s.hip - p.hop - (p.nod > 0 ? Math.round(Math.abs(Math.sin(p.nod * 12))) : 0)));
  }
}
function drawPod(pod) {
  const d = pod.desk;
  g.drawImage(d.s, d.x, d.y);
  for (const s of pod.seats) {
    const o = s.occupant, on = o?.working && o.pose === 'sit';
    g.drawImage(S.monitorFront, s.monX, s.monY);
    if (on) { // live screen: scrolling code lines, red on a bug
      const c = o.shake > 0 ? '#ff6b6b' : '#8fe3ff', k = Math.floor(o.t * 6);
      for (let i = 0; i < 3; i++) kit.px(s.monX + 3, s.monY + 3 + i * 2, 4 + ((k + i * 3) % 6), 1, c);
    }
    if (o && o.visible && (o.pose === 'sit' || o.hop)) (o.pose === 'sit' ? drawSeated(o, s) : kit.drawStanding(o));
    g.drawImage(S.chairBack, s.chairX, s.chairY + s.dy);
    if (on && Math.floor(o.t * 9) % 3 === 0) kit.px(s.seatX - 3 + (Math.floor(o.t * 9) % 2) * 4, pod.y + 30, 2, 1, '#bfefff');
  }
}
function drawDeskSeat(seat) {
  g.drawImage(S.chairFront, seat.chairX, seat.chairY + seat.dy);
  const o = seat.occupant;
  if (o && o.visible && o.pose === 'sit') drawSeated(o, seat);
  else if (o && o.visible && o.hop) kit.drawStanding(o);
}
function visible(x, y, w, h) {
  const a = toScreen(x, y), b2 = toScreen(x + w, y + h);
  return b2.x > 0 && b2.y > 0 && a.x < innerWidth && a.y < innerHeight;
}
function drawTag(text, x, y, bgc = '#e8b94a', fg = '#2b1d05') {
  const w = textWidth(text) + 4;
  kit.px(x - w / 2 - 1, y - 1, w + 2, 9, '#0f0c16'); kit.px(x - w / 2, y, w, 7, bgc); kit.text(text, x - w / 2 + 2, y + 1, fg);
}
function drawWorld() {
  g.drawImage(bg, 0, 0);
  const list = [];
  const deskSeats = [...new Set([...rooms.map((r) => r.desk), EXEC.youSeat, EXEC.bossSeat].filter(Boolean))];
  for (const p of props) if (!pods.some((q) => q.desk === p) && visible(p.x, p.y, p.s?.width ?? p.w, p.s?.height ?? p.h)) list.push({ y: p.sort, d: () => { if (p.s) g.drawImage(p.s, p.x, p.y); p.draw?.(p); } });
  for (const pod of pods) if (visible(pod.x, pod.y - 10, 60, 70)) list.push({ y: pod.y + 56, d: () => drawPod(pod) });
  for (const pet of pets) list.push({ y: pet.y, d: () => drawPet(pet) });
  for (const s of deskSeats) list.push({ y: s.desk.y - 1, d: () => drawDeskSeat(s) });
  for (const p of [...people.values(), you]) if (p && !(p.seat && (p.pose === 'sit' || p.hop)) && visible(p.x - 16, p.y - 32, 32, 34)) list.push({ y: p.y, d: () => kit.drawStanding(p) });
  list.sort((a, b) => a.y - b.y).forEach((x) => x.d());
  for (const r of rooms) if (r.flash > 0) {
    g.globalAlpha = Math.min(1, r.flash * 1.6); g.fillStyle = r.flashColor;
    const x = r.x0 * T, y = r.y0 * T, w = (r.x1 - r.x0 + 1) * T, h = (r.y1 - r.y0 + 1) * T, t = Math.max(2, Math.round(3 / cam.z));
    g.fillRect(x, y, w, t); g.fillRect(x, y + h - t, w, t); g.fillRect(x, y, t, h); g.fillRect(x + w - t, y, t, h);
    g.globalAlpha = 1;
  }
  for (const p of people.values()) {
    kit.drawOverlay(p, 0, 0, { dots: (p === mainDev && !p.working && p.pose === 'sit') || p.activity?.kind === 'wait' });
    if (p.agent?.role === 'orchestrator' && p.visible) drawTag('BOSS', p.x, p.y - (p.pose === 'sit' ? p.ch.front.hip + 10 : 40));
  }
  if (you) { kit.drawOverlay(you, 0, 0, { dots: org.root?.state === 'waiting' }); drawTag('YOU', you.x, you.y - you.ch.front.hip - 10, '#8a7cff', '#fff'); }
}
function drawLabels() {
  if (cam.z >= 1.6) return;
  g.setTransform(1, 0, 0, 1, 0, 0);
  for (const r of rooms) {
    const s = toScreen((r.x0 + 1) * T, (r.y0 + (r.y1 - r.y0) / 2) * T);
    if (s.x < -300 || s.y < -40 || s.x > innerWidth || s.y > innerHeight) continue;
    const busy = r.seats.filter((q) => q.occupant?.working).length;
    const line2 = r.kind === 'team' || r.kind === 'war' ? `${busy} busy  R${r.counts.research} C${r.counts.code} B${r.counts.bug}` : '';
    const w = Math.max(textWidth(r.name, 2), textWidth(line2, 2)) + 14;
    const x = Math.round(s.x + 4), y = Math.round(s.y - 14);
    kit.px(x - 2, y - 2, w + 4, line2 ? 32 : 18, '#0f0c16'); kit.px(x, y, w, line2 ? 28 : 14, '#2b2438'); kit.px(x, y, 3, line2 ? 28 : 14, r.color);
    kit.text(r.name, x + 8, y + 3, '#f4eefc', 2);
    if (line2) kit.text(line2, x + 8, y + 17, '#a79fbd', 2);
  }
}

// ----------------------------------------------------------------- camera
const cam = { x: 0, y: 0, z: 1, tx: 0, ty: 0, tz: 1 };
const toScreen = (x, y) => ({ x: (x - cam.x) * cam.z, y: (y - cam.y) * cam.z });
const toWorld = (sx, sy) => ({ x: sx / cam.z + cam.x, y: sy / cam.z + cam.y });
function frameRect(x, y, w, h, pad = 40) {
  const vw = innerWidth, vh = innerHeight - 130;
  cam.tz = Math.max(0.25, Math.min(8, Math.min((vw - pad) / w, (vh - pad) / h)));
  cam.tx = x + w / 2 - vw / 2 / cam.tz; cam.ty = y + h / 2 - (vh / 2 + 70) / cam.tz;
}
const fitAll = () => frameRect(0, 0, GW * T, GH * T);
function resize() { cv.width = innerWidth; cv.height = innerHeight; g.imageSmoothingEnabled = false; }
addEventListener('resize', resize);
let drag = null;
cv.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, cx: cam.tx, cy: cam.ty }; cv.classList.add('drag'); cv.setPointerCapture(e.pointerId); });
cv.addEventListener('pointermove', (e) => { if (!drag) return; cam.tx = cam.x = drag.cx - (e.clientX - drag.x) / cam.z; cam.ty = cam.y = drag.cy - (e.clientY - drag.y) / cam.z; });
cv.addEventListener('pointerup', () => { drag = null; cv.classList.remove('drag'); });
cv.addEventListener('wheel', (e) => {
  e.preventDefault();
  const before = toWorld(e.clientX, e.clientY);
  cam.z = cam.tz = Math.max(0.25, Math.min(8, cam.z * Math.pow(1.0015, -e.deltaY)));
  cam.x = cam.tx = before.x - e.clientX / cam.z; cam.y = cam.ty = before.y - e.clientY / cam.z;
}, { passive: false });
cv.addEventListener('dblclick', (e) => {
  const w = toWorld(e.clientX, e.clientY);
  const r = rooms.find((q) => w.x >= q.x0 * T && w.x <= (q.x1 + 1) * T && w.y >= q.y0 * T && w.y <= (q.y1 + 1) * T);
  if (r) frameRect(r.x0 * T, r.y0 * T, (r.x1 - r.x0 + 1) * T, (r.y1 - r.y0 + 1) * T, 20);
});

// ------------------------------------------------------------ org events
org.on('spawn', async (a, { initial }) => {
  ensureTier();
  let room, seat;
  const look = a.role === 'orchestrator' ? BOSS_LOOK : a.role === 'manager' ? MANAGER_LOOKS[a.id % MANAGER_LOOKS.length] : LOOKS[a.id % LOOKS.length];
  const p = await kit.person(look, a.role, a);
  if (!org.agents.has(a.id)) return;
  if (a.role === 'orchestrator') { room = EXEC.bossRoom; seat = EXEC.bossSeat; }
  else if (a.role === 'manager') { room = roomsOf(a)[0] ?? makeTeamRoom(a, false); seat = room.desk; }
  people.set(a.id, p);
  if (a.role === 'worker') { [room, seat] = freeSeat(a.parent); seat.reserved = true; }
  p.room = room;
  if (initial) { seatNow(p, seat); p.working = a.state === 'working'; return; }
  p.x = ENTRANCE.x; p.y = ENTRANCE.y;
  const lead = a.role === 'worker' ? people.get(a.parent.id) : null;
  const kickoff = a.role === 'manager' || (lead && lead.kickoffUntil > performance.now());
  if (kickoff) {
    const steps = kickoffSteps(p);
    if (a.role === 'manager') { p.kickoffUntil = performance.now() + 9000; steps.push(call(() => sayAt('Kick-off!', screenOf(p), 2))); }
    const until = () => (a.role === 'manager' ? p : lead).kickoffUntil;
    steps.push(step(() => performance.now() >= until()), call(() => { for (const q of EXEC.spots.meet) if (q.user === p) q.user = null; }));
    p.script.push(...steps);
  }
  p.script.push(walkTo(p, () => seat.approach), climbIn(p, seat), call(() => { a.ready = true; p.working = true; }));
});
org.on('finish', (a) => {
  const p = people.get(a.id), lead = people.get(a.parent.id);
  if (!p?.seat) return;
  p.script.push(
    climbOut(p, p.seat),
    ...(lead?.seat ? [walkTo(p, () => lead.seat.approach), call(() => { p.dir = 'left'; emote(p, 'yes', 1.2); emote(lead, 'yes', 1.2); }), wait(1.2)] : []),
    // A coffee on the way out.
    walkTo(p, () => EXEC.coffee), call(() => { p.dir = 'up'; }), wait(1.4),
    walkTo(p, ENTRANCE),
    call(() => { people.delete(a.id); org.remove(a); }),
  );
});
org.on('event', (a, type) => {
  const p = people.get(a.id), room = p?.room;
  if (!p || !room) return bump(type);
  room.counts[type]++; room.flash = 0.7; room.flashColor = type === 'bug' ? '#ff5a5a' : type === 'code' ? '#3ecf6e' : '#4a9eff';
  if (type === 'bug') { p.shake = 0.5; const lead = people.get(a.parent?.id); if (lead && Math.random() < 0.3) emote(lead, 'no', 1.2); }
  const s = toScreen(p.x, p.y - 26);
  if (cam.z >= 1.6 && s.x > 0 && s.y > 60 && s.x < innerWidth && s.y < innerHeight - 60) flyBubble(s, type); else bump(type);
});
org.on('state', (a) => { const p = people.get(a.id); if (p) p.working = a.state === 'working'; });


// ------------------------------------------------------------ activities
// Where each kind of away-from-desk work happens.
const FACILITY = { plan: 'plan', web: 'lib', run: 'srv', wait: 'wait' };
const INK = ['#2f5fd0', '#d23c3c', '#2f9a4a', '#222230'];
const screenOf = (p) => () => toScreen(p.x, p.y - 36);
org.on('activity', (a, kind, secs) => {
  const p = people.get(a.id), seat = p?.seat;
  if (!p || !seat || p.script.length || p.pose !== 'sit') return;
  const free = EXEC.spots[FACILITY[kind]].filter((q) => !q.user);
  const spot = free[Math.floor(Math.random() * free.length)];
  if (!spot) return;
  const room = spot.room;
  spot.user = p; a.ready = false;
  p.script.push(
    climbOut(p, seat), call(() => { seat.reserved = true; p.room = room; }),
    walkTo(p, spot),
    call(() => { p.dir = spot.dir; p.activity = { kind, spot, t: 0, next: 0 }; if (kind === 'run') spot.rack.busy = true; }),
    wait(secs),
    call(() => {
      if (kind === 'run') {
        spot.rack.busy = false;
        if (Math.random() < 0.25) { spot.rack.fail = 2.5; p.shake = 0.6; org.emit('event', a, 'bug'); } else org.emit('event', a, 'code');
      }
      if (kind === 'plan') setTimeout(() => { spot.board.ink.length = 0; }, 6000);
      p.activity = null; spot.user = null; p.room = seat.room ?? seat.pod?.room;
    }),
    walkTo(p, () => seat.approach), climbIn(p, seat), call(() => { a.ready = true; p.working = true; }),
  );
});
function tickActivity(p, dt) {
  const act = p.activity;
  if (!act) return;
  act.t += dt; act.next -= dt;
  if (act.next > 0) return;
  if (act.kind === 'plan') { act.next = 0.22; if (act.spot.board.ink.length < 46) act.spot.board.ink.push({ x: 3 + Math.floor(Math.random() * 20), y: 3 + Math.floor(Math.random() * 12), w: 2 + Math.floor(Math.random() * 7), c: INK[Math.floor(Math.random() * INK.length)] }); }
  else if (act.kind === 'web') { act.next = 1.4; const s = toScreen(p.x, p.y - 26); if (cam.z >= 1.6) flyBubble(s, 'research'); else bump('research'); }
  else act.next = 10;
}
/** A new team meets in the meeting room before going to their desks. */
function kickoffSteps(p) {
  const spot = EXEC.spots.meet.find((q) => !q.user);
  if (!spot) return [];
  spot.user = p;
  return [walkTo(p, spot), call(() => { p.dir = spot.dir; }), wait(0.1)];
}


// ------------------------------------------------------------ growing
/** Which building the current organisation needs. */
function tierFor() {
  const mgrs = org.list.filter((a) => a.role === 'manager').length;
  const rootWorkers = org.root ? org.root.children.filter((c) => c.role === 'worker').length : 0;
  if (mgrs === 0 && rootWorkers <= 6) return 'studio';
  if (mgrs <= 4 && org.list.length <= 30) return 'office';
  return 'mega';
}
let curtain = 0, curtainText = '';
/** Grow (never shrink mid-session) when the organisation outgrows the building. */
function ensureTier() {
  const need = tierFor();
  if (TIERS.indexOf(need) <= TIERS.indexOf(TIER)) return;
  relayout(need);
  if (!org.building) { curtain = 1.6; curtainText = need === 'office' ? 'Moving to a bigger office' : 'Expanding to the whole building'; }
}
/** Rebuild the building for a tier and re-seat everyone in it. */
function relayout(tier) {
  TIER = tier;
  resetLayout();
  if (tier === 'studio') buildStudio(); else buildBuilding(tier);
  if (tier !== 'studio') for (const a of org.list) if (a.role === 'manager') makeTeamRoom(a, false);
  for (const a of [...org.list]) {
    const p = people.get(a.id);
    if (!p) continue;
    p.script.length = 0; p.activity = null; p.hop = 0; p.moving = false; p.seat = null; p.kickoffUntil = 0;
    if (a.state === 'done') { people.delete(a.id); org.remove(a); continue; }
    let room, seat;
    if (a.role === 'orchestrator') { room = EXEC.bossRoom; seat = EXEC.bossSeat; }
    else if (a.role === 'manager') { room = roomsOf(a)[0]; seat = room.desk; }
    else [room, seat] = freeSeat(a.parent);
    p.room = room; seatNow(p, seat); a.ready = true; p.working = a.state === 'working';
  }
  if (you) seatNow(you, EXEC.youSeat);
  paintBackground(); buildNav();
  fitAll(); if (org.building || !started) { cam.x = cam.tx; cam.y = cam.ty; cam.z = cam.tz; }
}
function drawCurtain(dt) {
  if (curtain <= 0) return;
  curtain = Math.max(0, curtain - dt);
  const a = Math.min(1, curtain / 0.8);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = a;
  g.fillStyle = '#f4c542'; g.fillRect(0, 0, cv.width, cv.height);
  g.fillStyle = '#2b2438';
  const off = (performance.now() / 20) % 80;
  for (let x = -cv.height - 80 + off; x < cv.width; x += 80) { g.beginPath(); g.moveTo(x, cv.height); g.lineTo(x + cv.height, 0); g.lineTo(x + cv.height + 36, 0); g.lineTo(x + 36, cv.height); g.fill(); }
  const k = 4, w = textWidth(curtainText.toUpperCase(), k) + 40;
  const x0 = Math.round(cv.width / 2 - w / 2), y0 = Math.round(cv.height / 2 - 30);
  g.fillStyle = '#0f0c16'; g.fillRect(x0 - 4, y0 - 4, w + 8, 68); g.fillStyle = '#2b2438'; g.fillRect(x0, y0, w, 60);
  kit.text(curtainText, x0 + 20, y0 + 20, '#e8b94a', k);
  g.globalAlpha = 1;
}

// ------------------------------------------------------------------- pets
const PET_SPR = { cat: 'cat', corgi: 'corgi' };
function updatePets(dt) {
  for (const p of pets) {
    p.t += dt;
    if (p.kind !== 'cat') continue;
    if (p.rest > 0) {
      p.rest -= dt;
      if (p.rest <= 0) {
        const r = rooms[0];
        p.path = findPath(p, { x: r.ix + 20 + Math.random() * (r.iw - 40), y: r.iy + 60 + Math.random() * (r.ih - 70) });
      }
      continue;
    }
    const n = p.path?.[0];
    if (!n) { p.rest = 3 + Math.random() * 5; continue; }
    const dx = n.x - p.x, dy = n.y - p.y, d = Math.hypot(dx, dy);
    if (d < 1) { p.path.shift(); continue; }
    const v = Math.min(30 * dt, d); p.x += dx / d * v; p.y += dy / d * v; p.flip = dx > 0;
  }
}
function drawPet(p) {
  if (p.kind === 'corgi') {
    kit.px(p.x - 11, p.y - 1, 22, 2, 'rgba(0,0,0,0.2)'); kit.spr('corgi', p.x - 12, p.y - 11);
    const k = (p.t * 0.6) % 1; g.globalAlpha = 1 - k;
    kit.px(p.x + 8 + k * 6, p.y - 14 - k * 10, 3, 1, '#fff'); kit.px(p.x + 10 + k * 6, p.y - 13 - k * 10, 1, 1, '#fff'); kit.px(p.x + 8 + k * 6, p.y - 12 - k * 10, 3, 1, '#fff');
    g.globalAlpha = 1;
  } else {
    const hop = p.rest > 0 ? 0 : Math.round(Math.abs(Math.sin(p.t * 12)));
    kit.px(p.x - 6, p.y - 1, 12, 2, 'rgba(0,0,0,0.2)'); kit.spr('cat', p.x - 8, p.y - 13 - hop, { flip: p.flip });
  }
}

// -------------------------------------------------------------------- loop
let you, mainDev, started = false, last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (!drag) { const k = Math.min(1, dt * 7); cam.x += (cam.tx - cam.x) * k; cam.y += (cam.ty - cam.y) * k; cam.z += (cam.tz - cam.z) * k; }
  for (const p of people.values()) { kit.update(p, dt); if (p.seat && p.pose === 'sit' && !p.script.length) { p.x = p.seat.seatX; p.y = p.seat.seatY + p.seat.dy; } }
  if (you) kit.update(you, dt);
  for (const r of rooms) r.flash = Math.max(0, r.flash - dt);
  for (const p of people.values()) tickActivity(p, dt);
  for (const r of EXEC.racks) r.fail = Math.max(0, r.fail - dt);
  updatePets(dt);
  kit.tick(dt);
  if (dirty) paintBackground();
  if (navDirty) buildNav();
  g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = '#1d1828'; g.fillRect(0, 0, cv.width, cv.height);
  g.setTransform(cam.z, 0, 0, cam.z, -cam.x * cam.z, -cam.y * cam.z); g.imageSmoothingEnabled = false;
  drawWorld();
  drawLabels();
  drawCurtain(dt);
  g.setTransform(1, 0, 0, 1, 0, 0);
  requestAnimationFrame(frame);
}

// --------------------------------------------------------------- controls
function setStatus() {
  const teams = rooms.filter((r) => r.kind === 'team').length;
  const label = { studio: 'Studio', office: 'Office', mega: 'Mega office' }[TIER];
  document.getElementById('status').textContent = `${label} · ${org.list.length} agents${TIER !== 'studio' ? ` · ${teams} team rooms` : ''} · ${org.root?.state === 'waiting' ? 'orchestrator waiting for you' : 'working'} · the building grows as agents spawn`;
}
document.getElementById('preset').onchange = (e) => { location.search = '?preset=' + e.target.value; };
document.getElementById('b-wait').onclick = (e) => { const on = org.root.state !== 'waiting'; org.setWaiting(on); e.target.classList.toggle('on', on); };
document.getElementById('b-spawn').onclick = () => { const leads = org.managers.filter((m) => m.children.filter((c) => c.role === 'worker').length < 8); if (leads.length) org.add(leads[Math.floor(Math.random() * leads.length)], 'worker'); };
document.getElementById('b-team').onclick = () => { const leads = org.managers.filter((m) => m.depth < 3); const m = org.add(leads[Math.floor(Math.random() * leads.length)], 'manager'); setTimeout(() => { for (let i = 0; i < 3; i++) org.add(m, 'worker'); }, 1500); };
document.getElementById('b-fit').onclick = fitAll;
setInterval(setStatus, 1000);

// -------------------------------------------------------------------- go
resize();
resetLayout(); buildStudio(); paintBackground(); buildNav();
org.build(presetName);
await new Promise((r) => setTimeout(r, 60));
you = await kit.person(YOU_LOOK, 'you');
seatNow(you, EXEC.youSeat); you.working = true;
mainDev = [...people.values()].find((p) => p.agent?.role === 'worker' && p.agent.parent?.role === 'orchestrator');
paintBackground(); buildNav();
fitAll(); cam.x = cam.tx; cam.y = cam.ty; cam.z = cam.tz;
setStatus();
document.getElementById('loading').remove();
started = true;
org.simulate({ max: 70, teams: presetName !== 'solo', rootCap: presetName === 'solo' ? 3 : 4 });
org.simulateActivities(3.5);
requestAnimationFrame(frame);
window.dbg = { org, rooms, wings, people, cam, frameRect, get EXEC() { return EXEC; }, get TIER() { return TIER; }, pods, findPath, toScreen, pets };
