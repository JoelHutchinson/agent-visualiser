// Mega office: a real building generated from the agent hierarchy, drawn with
// the LimeZu Modern Office pack (if installed) and CC0 MetroCity people.
//
// Plan (16px tiles):  executive wing (lobby, boss, war room, break room)
//                     main corridor
//                     department wings: corridor + stacked team rooms
// Rooms only ever append (new wings to the right, new rooms at the bottom of a
// wing), so nobody's desk moves when the organisation grows.
//
// Three tiers, grown from the agent tree (never shrunk within a session):
//   studio: one room  ·  office: compact building  ·  mega: full building
import { DIR } from './sprites';
import { createKit, lookFor, YOU_LOOK, ZONE_COLORS, call, wait, emote, textWidth, label, step, ease, insertAfterCurrent, dirOf } from './kit';
import { TIERS, type Act, type Agent, type OfficeModel, type Tier } from './model';
import type { Pack, PackSprite } from './packs/limezu';
import type { CountType, Dir, Host, Imgs, MegaRoom, OfficeView, Person, Point, Prop, Seat, Spot, Step } from './types';

const T = 16;                    // tile size
const CW = 21;                   // wing width in tiles (3 corridor + 18 room)
const RH = 13;                   // team room pitch in tiles (walls shared)
const EXEC_H = 14;               // executive wing: rows 0..14 (14 = south wall)
const WING_Y = 18;               // first wing room top wall
const WALL = '#f8f8f8', EDGE = '#3a3a50';
const NC = 8;                    // nav cell size
const INK = ['#2f5fd0', '#d23c3c', '#2f9a4a', '#222230'];
const TIER_LABEL: Record<Tier, string> = { studio: 'Studio', office: 'Office', mega: 'Mega office' };

interface Pod { room: MegaRoom; desk: Prop; x: number; y: number; seats: Seat[] }
interface Pet { kind: 'cat' | 'corgi'; x: number; y: number; t: number; tx?: number; ty?: number; rest?: number; flip?: boolean; path?: Point[] }
interface Exec {
  spots: Record<'plan' | 'meet' | 'wait' | 'lib' | 'srv', Spot[]>;
  racks: Prop[];
  bossRoom: MegaRoom; warRoom: MegaRoom;
  bossSeat: Seat; warSeats: Seat[]; youSeat: Seat;
  coffee: { x: number; y: number; room: MegaRoom };
}

export interface MegaEnv { stage: HTMLElement; imgs: Imgs; pack: Pack; model: OfficeModel; host: Host }

export function createMegaView({ stage, imgs, pack, model, host }: MegaEnv): OfficeView {
  const cv = document.createElement('canvas');
  cv.className = 'office-canvas';
  stage.appendChild(cv);
  const g = cv.getContext('2d')!;
  const S = pack.sprites;
  const kit = createKit(imgs, g);

  // ------------------------------------------------------------------- plan
  const people = new Map<string, Person>();
  const rooms: MegaRoom[] = [];             // every walled room, exec ones first
  const wings: { dept: Agent; x0: number; nextY: number; color: string; floor: PackSprite }[] = [];
  const props: Prop[] = [];                 // static furniture
  const podDesks = new Set<Prop>();
  const pods: Pod[] = [];                   // desk pods with two seats each
  const pets: Pet[] = [];                   // the studio cat and corgi
  const waitActs = new Set<Act>();          // wait-for-user activities in progress anywhere
  let GW = 32, GH = 18;
  let dirty = true, navDirty = true;
  let you: Person;
  let destroyed = false;

  const rect = (x0: number, y0: number, x1: number, y1: number) => ({ x0, y0, x1, y1 });
  function addProp(sprite: PackSprite, x: number, y: number, { sort, solid = false, pad = 0 }: { sort?: number; solid?: boolean; pad?: number } = {}): Prop {
    const s = S[sprite];
    const p: Prop = { s, draw: null, x: Math.round(x), y: Math.round(y), sort: sort ?? y + s.height, solid: solid ? { x: x + pad, y: y + s.height * 0.35, w: s.width - pad * 2, h: s.height * 0.65 } : null };
    props.push(p); navDirty = true;
    return p;
  }
  function addCustom(x: number, y: number, w: number, h: number, sort: number, draw: (p: Prop) => void, solid = false): Prop {
    const p: Prop = { s: null, x, y, w, h, sort, draw, solid: solid ? { x, y: y + h * 0.4, w, h: h * 0.6 } : null };
    props.push(p); navDirty = true;
    return p;
  }
  /** Two seats at a desk facing up (sitters have their backs to us). */
  function addPod(room: MegaRoom, px: number, py: number): Pod {
    const desk = addProp('deskWhiteBig', px, py, { solid: true });
    podDesks.add(desk);
    const pod: Pod = { room, desk, x: px, y: py, seats: [] };
    for (const dx of [6, 25]) {
      const chairX = px + dx;
      pod.seats.push({
        pod, facing: 'up', chairX, chairY: py + 34, dx: 0, dy: 0, occupant: null, reserved: false, monX: chairX, monY: py + 4,
        seatX: chairX + 8, seatY: py + 47, approach: { x: chairX + 8, y: py + 64 },
      });
    }
    pods.push(pod);
    return pod;
  }
  /** A desk the sitter faces down from (managers, the boss, reception). */
  function addDeskSeat(room: MegaRoom, sprite: PackSprite, x: number, y: number): Seat {
    const desk = addProp(sprite, x, y, { solid: true });
    const cx = x + Math.round(desk.s!.width / 2);
    const seat: Seat = {
      room, facing: 'down', desk, chairX: cx - 8, chairY: y - 22, dx: 0, dy: 0, occupant: null, reserved: false, seatX: cx, seatY: y - 3,
      approach: { x: x + desk.s!.width + 10, y: y + 8 },
    };
    addProp('monitorBack', cx + 6, y - 2, { sort: y + desk.s!.height + 1 });
    return seat;
  }

  function makeRoom(kind: string, x0: number, y0: number, x1: number, y1: number, opts: { floor?: string; face?: string; name?: string; color?: string; mgr?: Agent | null; annex?: boolean } = {}): MegaRoom {
    const r: MegaRoom = {
      kind, ...rect(x0, y0, x1, y1), doors: [], floor: opts.floor ?? 'carpetGrey', face: opts.face ?? 'facePlain', name: opts.name ?? '', color: opts.color ?? '#e8b94a',
      counts: { research: 0, code: 0, bug: 0 }, flash: 0, flashColor: '#fff', seats: [], mgr: opts.mgr ?? null, annex: !!opts.annex,
      ix: (x0 + 1) * T, iy: (y0 + 3) * T,                     // usable interior origin (below the wall face)
      iw: (x1 - x0 - 1) * T, ih: (y1 - y0 - 3) * T,
    };
    rooms.push(r); dirty = true; navDirty = true;
    return r;
  }

  // ------------------------------------------------------------ furnishing
  // Reusable fit-outs; each registers its activity spots in EXEC.spots.
  function furnishPlanning(room: MegaRoom, xs: number[], iy: number): void {
    xs.forEach((bx, i) => {
      const board = addProp(i === 2 ? 'chartBoard' : 'whiteboard', bx, iy - 28, { sort: iy - 1 });
      board.ink = [];
      board.draw = (p) => { for (const k of p.ink!) kit.px(p.x + k.x, p.y + k.y, k.w, 1, k.c); };
      EXEC.spots.plan.push({ x: bx + 15, y: iy + 20, dir: 'up', board, room });
    });
  }
  function furnishMeeting(room: MegaRoom, ox: number, oy: number): void {
    addProp('deskWoodBig', ox + 70, oy + 56, { solid: true }); addProp('deskWoodBig', ox + 116, oy + 56, { solid: true });
    const seats: [number, number, Dir][] = [[82, 44, 'down'], [104, 44, 'down'], [128, 44, 'down'], [150, 44, 'down'], [82, 110, 'up'], [104, 110, 'up'], [128, 110, 'up'], [150, 110, 'up'], [58, 78, 'right'], [176, 78, 'left']];
    for (const [x, y, dir] of seats) EXEC.spots.meet.push({ x: ox + x, y: oy + y, dir, room });
  }
  function furnishWaiting(room: MegaRoom, x0: number, y0: number, cols: number, rows: number, signX: number, signY: number): void {
    const pp: PackSprite[] = ['podBlue', 'podGrey', 'podLilac', 'podGold'];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x = x0 + c * 24, y = y0 + r * 44;
      addProp(pp[(r * cols + c) % 4], x, y, { sort: y + 4 });
      EXEC.spots.wait.push({ x: x + 8, y: y + 12, dir: 'down', room, sit: true });
    }
    addCustom(signX, signY, 60, 14, signY + 30, (p) => {
      const n = EXEC.spots.wait.filter((q) => q.user).length;
      kit.px(p.x - 1, p.y - 1, p.w! + 2, p.h! + 2, EDGE); kit.px(p.x, p.y, p.w!, p.h!, '#15111f');
      kit.text(`WAITING ${n}`, p.x + 6, p.y + 5, n ? '#ff8f70' : '#6d6680');
    });
  }
  function furnishLibrary(room: MegaRoom, xs: number[], iy: number, freeRow: { xs: number[]; y: number } | null = null): void {
    xs.forEach((x, i) => { addProp(i % 3 === 2 ? 'shelfWhite' : 'bookshelf', x, iy - 20, { sort: iy + 10 }); EXEC.spots.lib.push({ x: x + 15, y: iy + 26, dir: 'up', room }); });
    if (freeRow) freeRow.xs.forEach((x, i) => { addProp(i % 2 ? 'shelfWhite' : 'bookshelf', x, freeRow.y, { solid: true }); EXEC.spots.lib.push({ x: x + 15, y: freeRow.y + 54, dir: 'up', room }); });
  }
  function furnishServer(room: MegaRoom, xs: number[], y: number): void {
    xs.forEach((x, i) => {
      const rack = addCustom(x, y, 22, 44, y + 44, (p) => {
        kit.px(p.x - 1, p.y - 1, p.w! + 2, p.h! + 2, EDGE); kit.px(p.x, p.y, p.w!, p.h!, '#2d2f45'); kit.px(p.x + 2, p.y + 2, p.w! - 4, 2, '#454864');
        const t = performance.now() / 1000;
        for (let r = 0; r < 6; r++) for (let c = 0; c < 3; c++) {
          const on = ((Math.sin(t * (3 + r + c) + i * 7 + r * 13) + 1) / 2) > (p.busy ? 0.3 : 0.75);
          kit.px(p.x + 4 + c * 6, p.y + 8 + r * 6, 2, 2, !on ? '#1c1d2b' : (p.fail ?? 0) > 0 ? '#ff5a5a' : '#6dff8c');
          kit.px(p.x + 9 + c * 6, p.y + 8 + r * 6, 3, 1, '#3c3f59');
        }
      }, true);
      rack.fail = 0; EXEC.racks.push(rack);
      EXEC.spots.srv.push({ x: x + 11, y: y + 62, dir: 'up', room, rack });
    });
  }
  function furnishCoffee(room: MegaRoom, x: number, y: number): void {
    addProp('vending', x, y, { solid: true }); addProp('fridge', x + 28, y, { solid: true }); addProp('waterCooler', x + 56, y + 8, { solid: true });
    EXEC.coffee = { x: x + 30, y: y + 46, room };
  }

  // ---------------------------------------------------------------- tiers
  let TIER: Tier = 'studio', EXEC: Exec, ENTRANCE: Point, CORRIDOR = false, minGW = 32;
  function newExec(): Exec {
    return { spots: { plan: [], meet: [], wait: [], lib: [], srv: [] }, racks: [] } as unknown as Exec;
  }
  function resetLayout(): void {
    rooms.length = 0; wings.length = 0; props.length = 0; pods.length = 0; pets.length = 0; podDesks.clear();
    EXEC = newExec();
    dirty = true; navDirty = true;
  }

  function buildStudio(): void {
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

  function buildBuilding(tier: Tier): void {
    CORRIDOR = true;
    const full = tier === 'mega';
    // Executive strip: rooms left to right, [kind, name, width in tiles].
    const plan: [string, string, number][] = full
      ? [['lobby', 'Lobby', 13], ['boss', 'Orchestrator', 17], ['war', 'War room', 14], ['break', 'Break room', 14], ['plan', 'Planning', 14], ['meet', 'Meeting room', 16], ['wait', 'Waiting room', 12], ['library', 'Library', 14], ['server', 'Server room', 13]]
      : [['lobby', 'Lobby', 13], ['boss', 'Orchestrator', 17], ['war', 'War room', 14], ['planmeet', 'Planning & meetings', 18], ['library', 'Library', 11], ['break', 'Break room', 12], ['server', 'Server room', 10]];
    minGW = plan.reduce((s, q) => s + q[2], 0) + 1;
    GW = Math.max(minGW, 1 + wings.length * CW + 1); GH = WING_Y + 4;
    ENTRANCE = { x: 6, y: (EXEC_H + 2) * T };
    const STYLE: Record<string, [string, string]> = {
      lobby: ['floorWhiteWood', 'faceMarble'], boss: ['carpetBrown', 'faceMarble'], war: ['carpetMauve', 'facePlain'], break: ['floorGreyTile', 'faceStone'],
      plan: ['carpetTan', 'facePlain'], meet: ['carpetDark', 'faceMarble'], wait: ['floorWhiteWood', 'faceMarble'], library: ['carpetBrown', 'faceBrick'],
      server: ['floorGreyTile', 'faceStone'], planmeet: ['carpetTan', 'facePlain'], commons: ['floorGreyTile', 'faceStone'],
    };
    let x = 0;
    const R: Record<string, MegaRoom> = {};
    plan.forEach(([kind, name, w], i) => {
      const x1 = i === plan.length - 1 ? Math.max(x + w, GW - 1) : x + w;
      const r = makeRoom(kind, x, 0, x1, EXEC_H, { floor: STYLE[kind][0], face: STYLE[kind][1], name });
      const mid = Math.floor((x + x1) / 2);
      r.doors.push([mid, EXEC_H], [mid + 1, EXEC_H]);
      R[kind] = r; x = x1;
    });
    let ix: number, iy: number;
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

  function wingFor(dept: Agent) {
    let w = wings.find((x) => x.dept === dept);
    if (w) return w;
    const i = wings.length;
    const floors: PackSprite[] = ['carpetGrey', 'carpetDark', 'carpetTan', 'carpetMauve', 'carpetPink', 'carpetBrown'];
    w = { dept, x0: 1 + i * CW, nextY: WING_Y, color: ZONE_COLORS[i % ZONE_COLORS.length], floor: floors[i % 6] };
    wings.push(w);
    GW = Math.max(minGW, 1 + wings.length * CW + 1);
    return w;
  }
  function makeTeamRoom(mgr: Agent, annex: boolean): MegaRoom {
    const w = wingFor(model.deptOf(mgr) ?? mgr);
    const x0 = w.x0 + 3, x1 = w.x0 + CW - 1, y0 = w.nextY, y1 = y0 + RH;
    w.nextY = y1;
    GH = Math.max(GH, y1 + 3);
    const name = annex ? `${label(mgr.name, 14)} annex` : `Team ${label(mgr.name, 16)}`;
    const r = makeRoom('team', x0, y0, x1, y1, { floor: w.floor, face: annex ? 'facePlain' : ['facePlain', 'faceMarble', 'faceStone'][mgr.depth % 3], name, color: w.color, mgr, annex });
    r.doors.push([x0, y1 - 2], [x0, y1 - 1]);
    const { ix, iy } = r;
    const podsA = [addPod(r, ix + 6, iy + 4), addPod(r, ix + 60, iy + 4), addPod(r, ix + 114, iy + 4)];
    const podsB = [addPod(r, ix + 6, iy + 84), addPod(r, ix + 60, iy + 84), addPod(r, ix + 114, iy + 84), addPod(r, ix + 168, iy + 84)];
    r.seats = [...podsA, ...podsB].flatMap((p) => p.seats);
    if (!annex) r.desk = addDeskSeat(r, 'deskTanBig', ix + 194, iy + 18);
    else { addProp('sofa', ix + 196, iy + 14, { solid: true }); addProp('plantBig', ix + 234, iy + 8); }
    addProp((['whiteboard', 'chartBoard', 'pieBoard'] as const)[mgr.seq % 3], ix + 60, iy - 28, { sort: iy - 1 });
    addProp('plantBig', ix + 236, iy + 130); addProp('plantSmall', ix + 2, iy - 8);
    if (mgr.depth > 1 && !annex) addProp('certificate', ix + 108, iy - 26, { sort: iy - 1 });
    return r;
  }
  const roomsOf = (mgr: Agent) => rooms.filter((r) => r.mgr === mgr);
  function freeSeat(mgr: Agent): [MegaRoom, Seat] {
    if (mgr.role === 'orchestrator') { const s = EXEC.warSeats.find((q) => !q.occupant && !q.reserved); return [EXEC.warRoom, s ?? EXEC.warSeats[0]]; }
    for (const r of roomsOf(mgr)) { const s = r.seats.find((q) => !q.occupant && !q.reserved); if (s) return [r, s]; }
    const r = makeTeamRoom(mgr, true);
    return [r, r.seats[0]];
  }

  // -------------------------------------------------------------- cell grid
  // 0 void, 1 floor, 2 wall top, 3 wall face (north walls, shown inside rooms)
  let cells: Uint8Array, floorOf: string[];
  function rasterise(): void {
    cells = new Uint8Array(GW * GH);
    floorOf = new Array(GW * GH).fill('floorGreyTile');
    const at = (x: number, y: number) => y * GW + x;
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
  function paintBackground(): void {
    rasterise();
    bg.width = GW * T; bg.height = GH * T;
    const b = bg.getContext('2d')!;
    b.imageSmoothingEnabled = false;
    b.fillStyle = '#1d1828'; b.fillRect(0, 0, bg.width, bg.height);
    const at = (x: number, y: number) => (x < 0 || y < 0 || x >= GW || y >= GH ? 0 : cells[y * GW + x]);
    // Floors (32px blocks tile seamlessly).
    for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
      if (cells[y * GW + x] !== 1) continue;
      const f = S[floorOf[y * GW + x] as PackSprite];
      b.drawImage(f, (x % 2) * 16, (y % 2) * 16, 16, 16, x * T, y * T, 16, 16);
    }
    // Wall faces: each 2-row face gets the face texture sliced across its width.
    for (const r of rooms) {
      const face = S[r.face as PackSprite];
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
  let NW = 0, NH = 0, blocked: Uint8Array;
  function buildNav(): void {
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
  const free = (x: number, y: number) => x >= 0 && y >= 0 && x < NW && y < NH && !blocked[y * NW + x];
  const cellOf = (p: Point): [number, number] => [Math.max(0, Math.min(NW - 1, Math.floor(p.x / NC))), Math.max(0, Math.min(NH - 1, Math.floor(p.y / NC)))];
  function nearestFree([x, y]: [number, number]): [number, number] {
    if (free(x, y)) return [x, y];
    for (let r = 1; r < 12; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (Math.max(Math.abs(dx), Math.abs(dy)) === r && free(x + dx, y + dy)) return [x + dx, y + dy];
    return [x, y];
  }
  function findPath(from: Point, to: Point): Point[] {
    if (navDirty) buildNav();
    const [sx, sy] = nearestFree(cellOf(from)), [tx, ty] = nearestFree(cellOf(to));
    const N = NW * NH, cost = new Float32Array(N).fill(Infinity), came = new Int32Array(N).fill(-1);
    const heap: [number, number][] = [];
    const push = (f: number, i: number) => { heap.push([f, i]); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
    const pop = () => { const top = heap[0], last = heap.pop()!; if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
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
    const pts: Point[] = [];
    for (let i = goal; i !== -1 && i !== start; i = came[i]) pts.unshift({ x: (i % NW) * NC + 4, y: ((i / NW) | 0) * NC + 4 });
    const out: Point[] = [];
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k - 1] ?? from, b = pts[k], c = pts[k + 1];
      if (!c || Math.sign(b.x - a.x) !== Math.sign(c.x - b.x) || Math.sign(b.y - a.y) !== Math.sign(c.y - b.y)) out.push(b);
    }
    out.push({ x: to.x, y: to.y });
    return out;
  }
  function walkTo(p: Person, target: Point | (() => Point)): Step {
    let path: Point[] | null = null;
    return step((dt) => {
      if (!path) { path = findPath(p, typeof target === 'function' ? target() : target); p.pose = 'stand'; }
      if (!path.length) { p.moving = false; return true; }
      const n = path[0], dx = n.x - p.x, dy = n.y - p.y, d = Math.hypot(dx, dy);
      if (d < 0.8) { p.x = n.x; p.y = n.y; path.shift(); return false; }
      p.moving = true;
      p.dir = dirOf(dx, dy);
      const v = Math.min(70 * dt, d); p.x += dx / d * v; p.y += dy / d * v;
      return false;
    });
  }

  // ------------------------------------------------------- sitting choreography
  // Up-facing seats: the chair rolls back, the sitter hops in, the chair tucks
  // under the desk. Down-facing seats: hop in from the side behind the desk.
  function climbIn(p: Person, seat: Seat): Step {
    let t = 0, from: Point | undefined;
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
  /** `keep` holds the reservation so nobody else takes the desk while its owner is out. */
  function climbOut(p: Person, seat: Seat, keep = false): Step {
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
        if (k >= 1) { seat.occupant = null; seat.reserved = keep; p.seat = null; return true; }
      }
      return false;
    });
  }
  function seatNow(p: Person, seat: Seat): void { seat.occupant = p; p.seat = seat; p.homeSeat = seat; p.pose = 'sit'; p.x = seat.seatX; p.y = seat.seatY; p.dir = seat.facing; }

  // ---------------------------------------------------------------- drawing
  function drawSeated(p: Person, seat: Seat): void {
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
  /** What's on a working agent's monitor (10x6 px at x,y): the current activity, else code. */
  function drawScreen(o: Person, x: number, y: number): void {
    const kind = o.activity?.kind, t = o.activity?.t ?? 0, k = Math.floor(o.t * 6);
    if (kind === 'run') { // terminal: prompt lines and a progress bar, red when it failed
      kit.px(x, y, 10, 6, '#10131c');
      kit.px(x, y, 1, 1, '#6dff8c'); kit.px(x + 2, y, 3 + (k % 5), 1, '#9aa3b8');
      kit.px(x, y + 2, 1, 1, '#6dff8c'); kit.px(x + 2, y + 2, 2 + ((k + 3) % 6), 1, '#9aa3b8');
      kit.px(x, y + 5, 10, 1, '#2a2f40'); kit.px(x, y + 5, Math.max(1, Math.floor(10 * (1 - 1 / (1 + t / 4)))), 1, o.shake > 0 ? '#ff5a5a' : '#6dff8c');
    } else if (kind === 'web') { // browser: address bar, heading, text scrolling past
      kit.px(x, y, 10, 6, '#eef2f7'); kit.px(x, y, 10, 1, '#4a9eff');
      kit.px(x + 1, y + 2, 5, 1, '#2d3446');
      for (let i = 0; i < 2; i++) kit.px(x + 1, y + 3 + i * 2, 5 + ((k + i * 2) % 4), 1, '#9aa3b8');
    } else if (kind === 'plan') { // checklist ticking off
      kit.px(x, y, 10, 6, '#fdf6e3');
      const done = Math.floor(t / 1.5) % 4;
      for (let i = 0; i < 3; i++) {
        kit.px(x + 1, y + i * 2, 1, 1, i < done ? '#3ecf6e' : '#b8ad92');
        kit.px(x + 3, y + i * 2, 4 + ((i * 3) % 3), 1, '#6b6150');
      }
    } else { // code: scrolling lines, red on a bug
      const c = o.shake > 0 ? '#ff6b6b' : '#8fe3ff';
      for (let i = 0; i < 3; i++) kit.px(x, y + i * 2, 4 + ((k + i * 3) % 6), 1, c);
    }
  }
  /** Desks seen from behind (boss, managers): a small badge for the current activity. */
  function drawBadge(p: Person): void {
    const kind = p.activity?.kind;
    if (!kind || !p.visible || p.pose !== 'sit') return;
    const x = Math.round(p.x + 9), y = Math.round(p.y - p.ch.front.hip - 4);
    kit.px(x - 1, y - 1, 12, 8, '#0f0c16');
    drawScreen(p, x, y);
  }
  function drawPod(pod: Pod): void {
    const d = pod.desk;
    g.drawImage(d.s!, d.x, d.y);
    for (const s of pod.seats) {
      const o = s.occupant, on = !!o && o.working && o.pose === 'sit';
      g.drawImage(S.monitorFront, s.monX!, s.monY!);
      if (o && on) drawScreen(o, s.monX! + 3, s.monY! + 3);
      if (o && o.visible && (o.pose === 'sit' || o.hop)) (o.pose === 'sit' ? drawSeated(o, s) : kit.drawStanding(o));
      g.drawImage(S.chairBack, s.chairX!, s.chairY! + s.dy);
      if (o && on && Math.floor(o.t * 9) % 3 === 0) kit.px(s.seatX - 3 + (Math.floor(o.t * 9) % 2) * 4, pod.y + 30, 2, 1, '#bfefff');
    }
  }
  function drawDeskSeat(seat: Seat): void {
    g.drawImage(S.chairFront, seat.chairX!, seat.chairY! + seat.dy);
    const o = seat.occupant;
    if (o && o.visible && o.pose === 'sit') drawSeated(o, seat);
    else if (o && o.visible && o.hop) kit.drawStanding(o);
  }
  function visible(x: number, y: number, w: number, h: number): boolean {
    const a = toScreen(x, y), b2 = toScreen(x + w, y + h);
    return b2.x > 0 && b2.y > 0 && a.x < cv.width && a.y < cv.height;
  }
  function drawTag(text: string, x: number, y: number, bgc = '#e8b94a', fg = '#2b1d05'): void {
    const w = textWidth(text) + 4;
    kit.px(x - w / 2 - 1, y - 1, w + 2, 9, '#0f0c16'); kit.px(x - w / 2, y, w, 7, bgc); kit.text(text, x - w / 2 + 2, y + 1, fg);
  }
  const showsDots = (p: Person) => p.blocked > 0 || p.activity?.kind === 'wait' || (p.agent?.state === 'waiting' && p.pose === 'sit');
  function drawWorld(): void {
    g.drawImage(bg, 0, 0);
    const list: { y: number; d: () => void }[] = [];
    const deskSeats = [...new Set([...rooms.map((r) => r.desk), EXEC.youSeat, EXEC.bossSeat].filter((s): s is Seat => !!s))];
    for (const p of props) if (!podDesks.has(p) && visible(p.x, p.y, p.s?.width ?? p.w!, p.s?.height ?? p.h!)) list.push({ y: p.sort, d: () => { if (p.s) g.drawImage(p.s, p.x, p.y); p.draw?.(p); } });
    for (const pod of pods) if (visible(pod.x, pod.y - 10, 60, 70)) list.push({ y: pod.y + 56, d: () => drawPod(pod) });
    for (const pet of pets) list.push({ y: pet.y, d: () => drawPet(pet) });
    for (const s of deskSeats) list.push({ y: s.desk!.y - 1, d: () => drawDeskSeat(s) });
    for (const p of [...people.values(), you]) if (!(p.seat && (p.pose === 'sit' || p.hop)) && visible(p.x - 16, p.y - 32, 32, 34)) list.push({ y: p.y, d: () => kit.drawStanding(p) });
    list.sort((a, b) => a.y - b.y).forEach((x) => x.d());
    for (const r of rooms) if (r.flash > 0) {
      g.globalAlpha = Math.min(1, r.flash * 1.6); g.fillStyle = r.flashColor;
      const x = r.x0 * T, y = r.y0 * T, w = (r.x1 - r.x0 + 1) * T, h = (r.y1 - r.y0 + 1) * T, t = Math.max(2, Math.round(3 / cam.z));
      g.fillRect(x, y, w, t); g.fillRect(x, y + h - t, w, t); g.fillRect(x, y, t, h); g.fillRect(x + w - t, y, t, h);
      g.globalAlpha = 1;
    }
    for (const p of people.values()) {
      kit.drawOverlay(p, 0, 0, { dots: showsDots(p) });
      if (p.seat && !p.seat.pod) drawBadge(p);
      if (p.agent?.role === 'orchestrator' && p.visible) drawTag('BOSS', p.x, p.y - (p.pose === 'sit' ? p.ch.front.hip + 10 : 40));
    }
    const youWaiting = model.root?.state === 'waiting' || waitActs.size > 0;
    kit.drawOverlay(you, 0, 0, { dots: youWaiting });
    drawTag('YOU', you.x, you.y - you.ch.front.hip - 10, '#8a7cff', '#fff');
  }
  function drawLabels(): void {
    if (cam.z >= 1.6) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    for (const r of rooms) {
      const s = toScreen((r.x0 + 1) * T, (r.y0 + (r.y1 - r.y0) / 2) * T);
      if (s.x < -300 || s.y < -40 || s.x > cv.width || s.y > cv.height) continue;
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
  const toScreen = (x: number, y: number) => ({ x: (x - cam.x) * cam.z, y: (y - cam.y) * cam.z });
  const toWorld = (sx: number, sy: number) => ({ x: sx / cam.z + cam.x, y: sy / cam.z + cam.y });
  /** Canvas-local point to viewport point (for the DOM effects layer). */
  const toClient = (x: number, y: number) => { const s = toScreen(x, y), r = cv.getBoundingClientRect(); return { x: s.x + r.left, y: s.y + r.top }; };
  const clampZoom = (z: number) => Math.max(0.25, Math.min(8, z));
  function frameRect(x: number, y: number, w: number, h: number, pad = 40): void {
    const { top, bottom } = host.insets();
    const vw = cv.width, vh = Math.max(50, cv.height - top - bottom);
    cam.tz = clampZoom(Math.min((vw - pad) / w, (vh - pad) / h));
    cam.tx = x + w / 2 - vw / 2 / cam.tz; cam.ty = y + h / 2 - (top + vh / 2) / cam.tz;
  }
  /** While true the camera keeps the whole building framed (until the user pans or zooms). */
  let autoFit = true;
  const fitAll = () => { autoFit = true; frameRect(0, 0, GW * T, GH * T); };
  const snapCamera = () => { cam.x = cam.tx; cam.y = cam.ty; cam.z = cam.tz; };
  function resize(): void {
    const w = Math.max(1, stage.clientWidth), h = Math.max(1, stage.clientHeight);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    g.imageSmoothingEnabled = false;
  }
  const ro = new ResizeObserver(() => { resize(); if (autoFit) fitAll(); });
  ro.observe(stage);

  // Pointer input: drag to pan, wheel or pinch to zoom, double-click/tap a room to frame it.
  const pointers = new Map<number, Point>();
  let drag: { x: number; y: number; cx: number; cy: number } | null = null;
  let pinch: { d: number; z: number } | null = null;
  let lastTap = { t: 0, x: 0, y: 0 };
  const localOf = (e: { clientX: number; clientY: number }) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const dist = () => { const [a, b] = [...pointers.values()]; return Math.hypot(a.x - b.x, a.y - b.y) || 1; };
  function frameRoomAt(sx: number, sy: number): void {
    const w = toWorld(sx, sy);
    const r = rooms.find((q) => w.x >= q.x0 * T && w.x <= (q.x1 + 1) * T && w.y >= q.y0 * T && w.y <= (q.y1 + 1) * T);
    if (r) { frameRect(r.x0 * T, r.y0 * T, (r.x1 - r.x0 + 1) * T, (r.y1 - r.y0 + 1) * T, 20); autoFit = false; }
  }
  const onDown = (e: PointerEvent) => {
    pointers.set(e.pointerId, localOf(e));
    cv.setPointerCapture(e.pointerId);
    cv.classList.add('drag');
    if (pointers.size === 2) { drag = null; pinch = { d: dist(), z: cam.z }; }
    else drag = { x: e.clientX, y: e.clientY, cx: cam.tx, cy: cam.ty };
  };
  const onMove = (e: PointerEvent) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, localOf(e));
    if (pinch && pointers.size === 2) {
      autoFit = false;
      const [a, b] = [...pointers.values()], mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const before = toWorld(mid.x, mid.y);
      cam.z = cam.tz = clampZoom(pinch.z * dist() / pinch.d);
      cam.x = cam.tx = before.x - mid.x / cam.z; cam.y = cam.ty = before.y - mid.y / cam.z;
    } else if (drag) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 3) autoFit = false;
      cam.tx = cam.x = drag.cx - (e.clientX - drag.x) / cam.z; cam.ty = cam.y = drag.cy - (e.clientY - drag.y) / cam.z;
    }
  };
  const onUp = (e: PointerEvent) => {
    const moved = drag ? Math.hypot(e.clientX - drag.x, e.clientY - drag.y) : 99;
    pointers.delete(e.pointerId);
    pinch = null;
    if (pointers.size === 0) { drag = null; cv.classList.remove('drag'); }
    else if (pointers.size === 1) { const pt = [...pointers.values()][0], r = cv.getBoundingClientRect(); drag = { x: pt.x + r.left, y: pt.y + r.top, cx: cam.tx, cy: cam.ty }; }
    if (e.pointerType === 'touch' && moved < 8) {   // double-tap frames a room (touch has no dblclick)
      const now = performance.now();
      if (now - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 24) { const l = localOf(e); frameRoomAt(l.x, l.y); lastTap.t = 0; }
      else lastTap = { t: now, x: e.clientX, y: e.clientY };
    }
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    autoFit = false;
    const l = localOf(e), before = toWorld(l.x, l.y);
    cam.z = cam.tz = clampZoom(cam.z * Math.pow(1.0015, -e.deltaY));
    cam.x = cam.tx = before.x - l.x / cam.z; cam.y = cam.ty = before.y - l.y / cam.z;
  };
  const onDbl = (e: MouseEvent) => { const l = localOf(e); frameRoomAt(l.x, l.y); };
  cv.addEventListener('pointerdown', onDown);
  cv.addEventListener('pointermove', onMove);
  cv.addEventListener('pointerup', onUp);
  cv.addEventListener('pointercancel', onUp);
  cv.addEventListener('wheel', onWheel, { passive: false });
  cv.addEventListener('dblclick', onDbl);

  // --------------------------------------------------------------- effects
  const screenOf = (p: Person) => () => toClient(p.x, p.y - 36);
  /** Bubble into the HUD counter when zoomed in and on screen, otherwise just count. */
  function fly(p: Person, type: CountType): void {
    const s = toClient(p.x, p.y - 26), r = cv.getBoundingClientRect(), { top, bottom } = host.insets();
    if (cam.z >= 1.6 && s.x > r.left && s.y > r.top + top && s.x < r.right && s.y < r.bottom - bottom) host.fly(s, type); else host.count(type);
  }

  // -------------------------------------------------------------- growing
  let curtain = 0, curtainText = '';
  /** Grow (never shrink mid-session) when the organisation outgrows the building. Returns true if it did. */
  function ensureTier(): boolean {
    const need = model.tierNeeded();
    if (TIERS.indexOf(need) <= TIERS.indexOf(TIER)) return false;
    relayout(need);
    if (!model.building) { curtain = 1.6; curtainText = need === 'office' ? 'Moving to a bigger office' : 'Expanding to the whole building'; }
    return true;
  }
  /** Rebuild the building for a tier and re-seat everyone in it. */
  function relayout(tier: Tier): void {
    TIER = tier;
    resetLayout();
    if (tier === 'studio') buildStudio(); else buildBuilding(tier);
    if (tier !== 'studio') for (const a of model.list) if (a.role === 'manager') makeTeamRoom(a, false);
    for (const a of model.list) {
      const p = people.get(a.id);
      if (!p) continue;
      p.script.length = 0; p.activity = null; p.hop = 0; p.moving = false; p.seat = null; p.kickoffUntil = 0;
      if (a.state === 'done' && a.role !== 'orchestrator') { people.delete(a.id); model.remove(a); continue; }
      let room: MegaRoom, seat: Seat;
      if (a.role === 'orchestrator') { room = EXEC.bossRoom; seat = EXEC.bossSeat; }
      else if (a.role === 'manager') { room = roomsOf(a)[0]; seat = room.desk!; }
      else [room, seat] = freeSeat(a.parent!);
      p.room = room; seatNow(p, seat); p.working = a.state === 'working';
    }
    seatNow(you, EXEC.youSeat);
    paintBackground(); buildNav();
    fitAll(); if (model.building) snapCamera();
  }
  function drawCurtain(dt: number): void {
    if (curtain <= 0) return;
    curtain = Math.max(0, curtain - dt);
    const a = Math.min(1, curtain / 0.8);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = a;
    g.fillStyle = '#f4c542'; g.fillRect(0, 0, cv.width, cv.height);
    g.fillStyle = '#2b2438';
    const off = (performance.now() / 20) % 80;
    for (let x = -cv.height - 80 + off; x < cv.width; x += 80) { g.beginPath(); g.moveTo(x, cv.height); g.lineTo(x + cv.height, 0); g.lineTo(x + cv.height + 36, 0); g.lineTo(x + 36, cv.height); g.fill(); }
    // Text scales down on narrow screens so the plate always fits.
    const text = curtainText.toUpperCase();
    const k = Math.max(1, Math.min(4, Math.floor((cv.width - 60) / (textWidth(text) + 10))));
    const w = textWidth(text, k) + 40;
    const x0 = Math.round(cv.width / 2 - w / 2), y0 = Math.round(cv.height / 2 - 30);
    g.fillStyle = '#0f0c16'; g.fillRect(x0 - 4, y0 - 4, w + 8, 68); g.fillStyle = '#2b2438'; g.fillRect(x0, y0, w, 60);
    kit.text(curtainText, x0 + 20, y0 + 30 - Math.round(2.5 * k), '#e8b94a', k);
    g.globalAlpha = 1;
  }

  // ------------------------------------------------------------------- pets
  function updatePets(dt: number): void {
    for (const p of pets) {
      p.t += dt;
      if (p.kind !== 'cat') continue;
      if ((p.rest ?? 0) > 0) {
        p.rest = p.rest! - dt;
        if (p.rest <= 0) {
          const r = rooms[0];
          p.path = findPath(p, { x: r.ix + 20 + Math.random() * (r.iw - 40), y: r.iy + 60 + Math.random() * (r.ih - 70) });
        }
        continue;
      }
      const n = p.path?.[0];
      if (!n) { p.rest = 3 + Math.random() * 5; continue; }
      const dx = n.x - p.x, dy = n.y - p.y, d = Math.hypot(dx, dy);
      if (d < 1) { p.path!.shift(); continue; }
      const v = Math.min(30 * dt, d); p.x += dx / d * v; p.y += dy / d * v; p.flip = dx > 0;
    }
  }
  function drawPet(p: Pet): void {
    if (p.kind === 'corgi') {
      kit.px(p.x - 11, p.y - 1, 22, 2, 'rgba(0,0,0,0.2)'); kit.spr('corgi', p.x - 12, p.y - 11);
      const k = (p.t * 0.6) % 1; g.globalAlpha = 1 - k;
      kit.px(p.x + 8 + k * 6, p.y - 14 - k * 10, 3, 1, '#fff'); kit.px(p.x + 10 + k * 6, p.y - 13 - k * 10, 1, 1, '#fff'); kit.px(p.x + 8 + k * 6, p.y - 12 - k * 10, 3, 1, '#fff');
      g.globalAlpha = 1;
    } else {
      const hop = (p.rest ?? 0) > 0 ? 0 : Math.round(Math.abs(Math.sin(p.t * 12)));
      kit.px(p.x - 6, p.y - 1, 12, 2, 'rgba(0,0,0,0.2)'); kit.spr('cat', p.x - 8, p.y - 13 - hop, { flip: p.flip });
    }
  }

  // ---------------------------------------------------- model happenings
  const leadPerson = (a: Agent): Person | undefined => {
    for (let n = a.parent; n; n = n.parent) { const p = people.get(n.id); if (p) return p; }
    return undefined;
  };

  /** A new team meets in the meeting room before going to their desks. */
  function kickoffSteps(p: Person): Step[] {
    const spot = EXEC.spots.meet.find((q) => !q.user);
    if (!spot) return [];
    spot.user = p;
    return [walkTo(p, spot), call(() => { p.dir = spot.dir; }), wait(0.1)];
  }

  function onSpawn(a: Agent, initial: boolean): void {
    ensureTier();
    const p = kit.person(lookFor(a), a.role, a);
    let room: MegaRoom, seat: Seat;
    if (a.role === 'orchestrator') { room = EXEC.bossRoom; seat = EXEC.bossSeat; }
    else if (a.role === 'manager') { room = roomsOf(a)[0] ?? makeTeamRoom(a, false); seat = room.desk!; }
    else { [room, seat] = freeSeat(a.parent!); }
    people.set(a.id, p);
    seat.reserved = true;
    p.room = room; p.homeSeat = seat;
    if (initial) { seatNow(p, seat); p.working = a.state === 'working'; return; }
    p.x = ENTRANCE.x; p.y = ENTRANCE.y;
    const lead = a.role === 'worker' && a.parent ? people.get(a.parent.id) : undefined;
    const kickoff = a.role === 'manager' || (lead && (lead.kickoffUntil ?? 0) > performance.now());
    if (kickoff) {
      const steps = kickoffSteps(p);
      if (a.role === 'manager') { p.kickoffUntil = performance.now() + 9000; steps.push(call(() => host.say('Kick-off!', screenOf(p), 2))); }
      const until = () => (a.role === 'manager' ? p : lead)?.kickoffUntil ?? 0;
      steps.push(step(() => performance.now() >= until()), call(() => { for (const q of EXEC.spots.meet) if (q.user === p) q.user = null; }));
      p.script.push(...steps);
    }
    p.script.push(walkTo(p, () => seat.approach), climbIn(p, seat), call(() => { p.working = a.state === 'working'; }));
  }

  function onPromote(a: Agent): void {
    if (ensureTier()) return;                      // a bigger building re-seats everybody, the new manager included
    const p = people.get(a.id);
    if (!p || TIER === 'studio') return;
    const room = roomsOf(a)[0] ?? makeTeamRoom(a, false);
    const desk = room.desk!;
    desk.reserved = true;
    // Move to the new team room's desk once whatever they are doing is done.
    p.script.push(call(() => {
      const old = p.seat;
      insertAfterCurrent(p,
        ...(old ? [climbOut(p, old)] : []),
        walkTo(p, () => desk.approach), climbIn(p, desk),
        call(() => { p.homeSeat = desk; p.room = room; p.working = a.state === 'working'; }));
    }));
  }

  function onFinish(a: Agent): void {
    const p = people.get(a.id);
    if (!p) { model.remove(a); return; }
    // Steps are built lazily: the agent may be away on an errand when this arrives.
    p.script.push(call(() => {
      const lead = leadPerson(a), seat = p.seat, steps: Step[] = [];
      if (seat) steps.push(climbOut(p, seat));
      const leadSeat = lead?.seat;
      if (lead && leadSeat) steps.push(walkTo(p, () => leadSeat.approach), call(() => { p.dir = 'left'; emote(p, 'yes', 1.2); emote(lead, 'yes', 1.2); }), wait(1.2));
      // A coffee on the way out.
      steps.push(walkTo(p, () => EXEC.coffee), call(() => { p.dir = 'up'; }), wait(1.4), walkTo(p, () => ENTRANCE), call(() => { people.delete(a.id); model.remove(a); }));
      insertAfterCurrent(p, ...steps);
    }));
  }

  function onState(a: Agent): void {
    const p = people.get(a.id);
    if (p && p.seat && p.pose === 'sit') p.working = a.state === 'working';
  }

  function onEvent(a: Agent | null, type: CountType): void {
    const p = a ? people.get(a.id) : undefined, room = p?.room;
    if (!p || !room) return host.count(type);
    room.counts[type]++; room.flash = 0.7; room.flashColor = type === 'bug' ? '#ff5a5a' : type === 'code' ? '#3ecf6e' : '#4a9eff';
    if (type === 'bug') { p.shake = 0.5; const lead = a!.parent ? people.get(a!.parent.id) : undefined; if (lead && Math.random() < 0.3) emote(lead, 'no', 1.2); }
    fly(p, type);
  }

  function onActivity(a: Agent, act: Act): void {
    const p = people.get(a.id);
    if (!p) return;
    if (act.kind === 'wait') waitActs.add(act);
    const dotsOnly = () => { if (act.kind === 'wait') { act.dots = true; p.blocked++; } };
    // Agents never leave their desk to work: they keep typing and the activity shows on their
    // monitor. Rooms react remotely (a server rack lights up for a command, a whiteboard fills
    // while planning); waiting shows the "..." bubble.
    if (act.kind === 'wait') return dotsOnly();
    const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
    const rack = act.kind === 'run' ? pick(EXEC.racks.filter((r) => !r.busy)) ?? pick(EXEC.racks) : undefined;
    const board = act.kind === 'plan' ? pick(EXEC.spots.plan.map((s) => s.board).filter((b): b is Prop => !!b)) : undefined;
    if (rack) rack.busy = true;
    p.activity = { kind: act.kind, act, rack, board, t: 0, next: 0 };
  }
  function onActivityEnd(a: Agent, act: Act): void {
    waitActs.delete(act);
    const p = people.get(a.id);
    if (!p) return;
    if (act.dots) p.blocked = Math.max(0, p.blocked - 1);
    const cur = p.activity;
    if (!cur || cur.act !== act) return;
    if (cur.rack) {
      cur.rack.busy = [...people.values()].some((q) => q !== p && q.activity?.rack === cur.rack);
      if (act.ok === false) { cur.rack.fail = 2.5; p.shake = 0.6; }
    }
    const board = cur.board;
    if (board) setTimeout(() => { if (![...people.values()].some((q) => q.activity?.board === board)) board.ink!.length = 0; }, 6000);
    p.activity = null;
  }
  function tickActivity(p: Person, dt: number): void {
    const act = p.activity;
    if (!act) return;
    act.t += dt; act.next -= dt;
    if (act.next > 0) return;
    if (act.board) {
      act.next = 0.22;
      const board = act.board;
      if (board.ink!.length < 46) board.ink!.push({ x: 3 + Math.floor(Math.random() * 20), y: 3 + Math.floor(Math.random() * 12), w: 2 + Math.floor(Math.random() * 7), c: INK[Math.floor(Math.random() * INK.length)] });
    } else act.next = 10;
  }

  // -------------------------------------------------------------------- loop
  let last = performance.now(), raf = 0;
  function frame(now: number): void {
    if (destroyed) return;
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (!drag && !pinch) { const k = Math.min(1, dt * 7); cam.x += (cam.tx - cam.x) * k; cam.y += (cam.ty - cam.y) * k; cam.z += (cam.tz - cam.z) * k; }
    for (const p of people.values()) { kit.update(p, dt); if (p.seat && p.pose === 'sit' && !p.script.length) { p.x = p.seat.seatX; p.y = p.seat.seatY + p.seat.dy; } }
    kit.update(you, dt);
    for (const r of rooms) r.flash = Math.max(0, r.flash - dt);
    for (const p of people.values()) tickActivity(p, dt);
    for (const r of EXEC.racks) r.fail = Math.max(0, (r.fail ?? 0) - dt);
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
    raf = requestAnimationFrame(frame);
  }

  // -------------------------------------------------------------------- go
  function reset(): void {
    TIER = 'studio';
    people.clear(); waitActs.clear();
    resetLayout(); buildStudio();
    seatNow(you, EXEC.youSeat);
    you.script.length = 0;
    paintBackground(); buildNav();
    fitAll(); snapCamera();
  }
  resize();
  you = kit.person(YOU_LOOK, 'you');
  you.working = true;
  reset();
  raf = requestAnimationFrame(frame);
  if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__dbg = { cam, get GW() { return GW; }, get GH() { return GH; }, rooms, people };

  return {
    kind: 'mega',
    onReset: reset,
    onSynced() { paintBackground(); buildNav(); fitAll(); snapCamera(); },
    onSpawn, onPromote, onFinish, onState, onEvent, onActivity, onActivityEnd,
    fit: fitAll,
    fitLabel: () => 'Fit',
    info: () => ({ label: TIER_LABEL[TIER], teams: rooms.filter((r) => r.kind === 'team' && !r.annex).length }),
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      cv.remove();
    },
  };
}
