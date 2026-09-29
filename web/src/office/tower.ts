// Tower view (CC0 art only): one floor per manager, stacked in hierarchy order
// (depth-first), the orchestrator in the penthouse and you in the lobby.
// Subagents ride the elevator to their team's floor; finished work is carried
// back up to the lead. This is the fallback when the LimeZu pack is missing.
import {
  createKit, blockSeats, deskSeat, lookFor, YOU_LOOK, TONES, ZONE_COLORS, label,
  step, call, wait, walkPath, climbIn, climbOut, seatNow, emote, textWidth, insertAfterCurrent,
} from './kit';
import type { Act, Agent, OfficeModel } from './model';
import type { CountType, Host, Imgs, OfficeView, Person, Seat, Step, TowerFloor } from './types';

const W = 400, FH = 84, ROOF = 70, LOBBY = 96, WALK = FH - 7, SHAFT = { x: 4, w: 22 };
const BLOCK_X = [36, 124, 212], BLOCK_Y = 36;

export interface TowerEnv { stage: HTMLElement; imgs: Imgs; model: OfficeModel; host: Host }

interface Rider { p: Person; from: TowerFloor; to: TowerFloor; onArrive: () => void }
interface CarJob { phase: 'fetch' | 'board' | 'depart' | 'next' | 'go' | 'alight'; from: TowerFloor; riders: Rider[]; stop?: TowerFloor }

export function createTowerView({ stage, imgs, model, host }: TowerEnv): OfficeView {
  const scroller = document.createElement('div');
  scroller.className = 'tower-scroller';
  const cv = document.createElement('canvas');
  cv.className = 'tower-canvas';
  scroller.appendChild(cv);
  stage.appendChild(scroller);
  const g = cv.getContext('2d')!;
  const kit = createKit(imgs, g);

  // Pre-rendered plank strips, one per tone.
  const strips = TONES.map((t, i) => {
    const c = document.createElement('canvas'); c.width = W; c.height = FH - 32;
    kit.planks(c.getContext('2d')!, 0, 0, W, FH - 32, t, 11 + i);
    return c;
  });

  // ------------------------------------------------------------------ model
  const floors: TowerFloor[] = [];            // ordered top to bottom
  const people = new Map<string, Person>();   // agent id -> person
  const waitActs = new Set<Act>();
  const lobby: TowerFloor = { lobby: true, y: 0, ty: 0, people: [] };
  const lobbyDesk = deskSeat(180, 40, 'reception');
  let you: Person;
  let destroyed = false;
  let pruneTimer: ReturnType<typeof setTimeout> | undefined;

  const floorsOf = (mgr: Agent) => floors.filter((f) => f.mgr === mgr);
  function makeFloor(mgr: Agent, annex: boolean): TowerFloor {
    const f: TowerFloor = { mgr, annex, y: 0, ty: 0, built: model.building ? 1 : 0, counts: { research: 0, code: 0, bug: 0 }, flash: 0, flashColor: '#fff', people: [] };
    f.blocks = BLOCK_X.map((x) => ({ x, y: BLOCK_Y }));
    f.seats = f.blocks.flatMap((b, i) => blockSeats(b, i * 2 + mgr.seq));
    if (!annex) f.desk = deskSeat(322, 44, mgr.role === 'orchestrator' ? 'boss' : 'manager');
    const dept = model.deptOf(mgr) ?? mgr;
    f.tone = mgr.role === 'orchestrator' ? 0 : 1 + ((dept.seq * 7) % (TONES.length - 1));
    f.color = mgr.role === 'orchestrator' ? '#e8b94a' : ZONE_COLORS[(dept.seq * 5) % ZONE_COLORS.length];
    return f;
  }
  /** Floors in depth-first hierarchy order; annexes right after their team. */
  function reorder(): void {
    const order: TowerFloor[] = [];
    const visit = (a: Agent) => { if (a.role === 'worker') return; order.push(...floorsOf(a)); for (const c of a.children) visit(c); };
    if (model.root) visit(model.root);
    for (const f of floors) if (!order.includes(f)) order.push(f);
    floors.splice(0, floors.length, ...order);
    floors.forEach((f, i) => { f.ty = ROOF + i * FH; if (model.building) f.y = f.ty; });
    lobby.ty = ROOF + floors.length * FH;
    if (model.building) lobby.y = lobby.ty;
    resize();
  }
  function freeSeat(mgr: Agent): [TowerFloor, Seat] {
    for (const f of floorsOf(mgr)) { const s = f.seats!.find((q) => !q.occupant && !q.reserved); if (s) return [f, s]; }
    const f = makeFloor(mgr, true);
    floors.push(f); reorder();
    return [f, f.seats![0]];
  }

  // --------------------------------------------------------------- elevator
  const car: { y: number; door: number; queue: Rider[]; job: CarJob | null } = { y: 0, door: 0, queue: [], job: null };
  const stopY = (fl: TowerFloor) => fl.y + 50;
  function ride(p: Person, from: TowerFloor | null, to: TowerFloor): Step {
    let done = false;
    return step(() => {
      // `from` defaults to wherever the person is when the ride starts.
      if (!p.rideQueued) { p.rideQueued = true; car.queue.push({ p, from: from ?? p.floor!, to, onArrive: () => { done = true; } }); }
      if (done) { p.rideQueued = false; return true; }
      return false;
    });
  }
  /**
   * One car, shared: it collects everyone waiting on a floor (up to six) and
   * drops them off stop by stop, nearest first.
   */
  function updateCar(dt: number): void {
    const move = (fl: TowerFloor) => { const t = stopY(fl), d = t - car.y; car.y += Math.sign(d) * Math.min(Math.abs(d), 260 * dt); return Math.abs(d) < 0.5; };
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
    } else if (j.phase === 'go') { if (move(j.stop!)) j.phase = 'alight'; }
    else if (j.phase === 'alight') {
      if (!open()) return;
      j.riders.filter((r) => r.to === j.stop).forEach((r, i) => {
        setFloor(r.p, r.to); r.p.x = 15 + i * 3; r.p.y = WALK; r.p.dir = 'right'; r.p.visible = true; r.onArrive();
      });
      j.riders = j.riders.filter((r) => r.to !== j.stop);
      j.phase = 'depart';
    }
  }
  function setFloor(p: Person, fl: TowerFloor): void {
    if (p.floor) p.floor.people = p.floor.people?.filter((q) => q !== p);
    p.floor = fl; (fl.people ??= []).push(p);
  }
  /** Walk to the elevator, ride to another floor (if needed), step out. */
  function travel(p: Person, to: TowerFloor): Step[] {
    if (p.floor === to) return [];
    return [walkPath(p, () => [{ x: p.x, y: WALK }, { x: 15, y: WALK }]), ride(p, null, to)];
  }

  // ------------------------------------------------------------ model happenings
  const leadPerson = (a: Agent): Person | undefined => {
    for (let n = a.parent; n; n = n.parent) { const p = people.get(n.id); if (p) return p; }
    return undefined;
  };
  function enterBuilding(p: Person, f: TowerFloor, seat: Seat, then: () => void): void {
    setFloor(p, lobby); p.x = W - 12; p.y = WALK; p.dir = 'left';
    p.script.push(
      walkPath(p, [{ x: 15, y: WALK }]),
      ride(p, lobby, f),
      walkPath(p, () => [{ x: seat.approach.x, y: WALK }, seat.approach]),
      climbIn(p, seat),
      call(then),
    );
  }
  function onSpawn(a: Agent, initial: boolean): void {
    if (a.role !== 'worker') { floors.push(makeFloor(a, false)); reorder(); }
    const p = kit.person(lookFor(a), a.role, a);
    people.set(a.id, p);
    let f: TowerFloor, seat: Seat;
    if (a.role === 'worker') { [f, seat] = freeSeat(a.parent!); seat.reserved = true; }
    else { f = floorsOf(a)[0]; seat = f.desk!; }
    p.home = f; p.homeSeat = seat;
    if (initial) { setFloor(p, f); seatNow(p, seat); p.working = a.state === 'working'; return; }
    enterBuilding(p, f, seat, () => { p.working = a.state === 'working'; });
  }
  function onPromote(a: Agent): void {
    const p = people.get(a.id);
    const f = makeFloor(a, false);
    floors.push(f); reorder();
    if (!p) return;
    const desk = f.desk!;
    desk.reserved = true;
    p.script.push(call(() => {
      const old = p.seat;
      insertAfterCurrent(p,
        ...(old ? [climbOut(p, old)] : []),
        ...travel(p, f),
        walkPath(p, () => [{ x: p.x, y: WALK }, { x: desk.approach.x, y: WALK }, desk.approach]),
        climbIn(p, desk),
        call(() => { p.home = f; p.homeSeat = desk; p.working = a.state === 'working'; }));
    }));
  }
  function onFinish(a: Agent): void {
    const p = people.get(a.id);
    if (!p) { model.remove(a); return; }
    p.script.push(call(() => {
      const boss = leadPerson(a), lead = boss?.home, steps: Step[] = [];
      if (p.seat) steps.push(climbOut(p, p.seat));
      if (lead && lead.desk) {
        const at = lead.desk.approach;
        steps.push(...travel(p, lead), walkPath(p, () => [{ x: p.x, y: WALK }, { x: at.x, y: WALK }, at]));
      }
      steps.push(
        call(() => { p.dir = 'left'; emote(p, 'yes', 1.2); if (boss) emote(boss, 'yes', 1.2); }),
        wait(1.2),
        walkPath(p, () => [{ x: p.x, y: WALK }, { x: 15, y: WALK }]),
        ride(p, null, lobby),
        walkPath(p, [{ x: W + 20, y: WALK }]),
        call(() => { setFloor(p, { y: 0, ty: 0, people: [] }); people.delete(a.id); model.remove(a); }),
      );
      insertAfterCurrent(p, ...steps);
    }));
    // Prune empty annex floors later.
    clearTimeout(pruneTimer);
    pruneTimer = setTimeout(pruneAnnexes, 9000);
  }
  function pruneAnnexes(): void {
    if (destroyed) return;
    for (const f of [...floors]) {
      if (f.annex && f.seats!.every((s) => !s.occupant && !s.reserved) && !(f.people ?? []).length) floors.splice(floors.indexOf(f), 1);
    }
    reorder();
  }
  function onEvent(a: Agent | null, type: CountType): void {
    const p = a ? people.get(a.id) : undefined;
    if (!p || !p.floor || p.floor.lobby) return host.count(type);
    const f = p.floor, c = f.counts!;
    c[type]++; f.flash = 0.6; f.flashColor = type === 'bug' ? '#ff5a5a' : type === 'code' ? '#3ecf6e' : '#4a9eff';
    if (type === 'bug') { p.shake = 0.5; const boss = a!.parent ? people.get(a!.parent.id) : undefined; if (boss && Math.random() < 0.3) emote(boss, 'no', 1.2); }
    const s = toScreen(p.x, f.y + p.y - 26), { top, bottom } = host.insets();
    if (s.y > top && s.y < innerHeight - bottom) host.fly(s, type); else host.count(type);
  }
  function onState(a: Agent): void {
    const p = people.get(a.id);
    if (p && p.seat && p.pose === 'sit') p.working = a.state === 'working';
  }
  // The tower has no away-from-desk rooms: waiting shows the "..." bubble, a failed run shakes the head.
  function onActivity(a: Agent, act: Act): void {
    const p = people.get(a.id);
    if (!p || act.kind !== 'wait') return;
    waitActs.add(act); act.dots = true; p.blocked++;
  }
  function onActivityEnd(a: Agent, act: Act): void {
    waitActs.delete(act);
    const p = people.get(a.id);
    if (!p) return;
    if (act.dots) p.blocked = Math.max(0, p.blocked - 1);
    if (act.kind === 'run' && act.ok === false) p.shake = 0.6;
  }

  // ---------------------------------------------------------------- drawing
  let scale = 2, overview = false;
  function resize(): void {
    const { top, bottom } = host.insets();
    scroller.style.paddingTop = `${top + 6}px`;
    scroller.style.paddingBottom = `${bottom + 6}px`;
    const H = ROOF + floors.length * FH + LOBBY + 20;
    if (cv.height !== H) { cv.width = W; cv.height = H; g.imageSmoothingEnabled = false; }
    const fitW = (scroller.clientWidth - 24) / W, fitH = (scroller.clientHeight - top - bottom - 12) / H;
    scale = Math.max(0.1, overview ? Math.min(fitW, fitH) : (fitW >= 2 ? Math.floor(Math.min(fitW, 4)) : fitW));
    cv.style.width = W * scale + 'px'; cv.style.height = H * scale + 'px';
  }
  const ro = new ResizeObserver(resize);
  ro.observe(stage);
  const toScreen = (x: number, y: number) => { const r = cv.getBoundingClientRect(); return { x: r.left + x * scale, y: r.top + y * scale }; };

  function drawSky(t: number): void {
    kit.px(0, 0, W, ROOF, '#62b6f0');
    const off = Math.floor(t * 4) % 256;
    for (let x = -off; x < W; x += 256) g.drawImage(imgs.office, 0, 0, 256, 30, x, 2, 256, 30);
    // Roof: parapet, sign, antenna.
    kit.px(0, ROOF - 12, W, 12, '#3b3452'); kit.px(0, ROOF - 12, W, 2, '#5d5478');
    const text = 'AGENT HQ', k = 2, tw = textWidth(text, k);
    kit.px(W / 2 - tw / 2 - 6, ROOF - 32, tw + 12, 18, '#2b2438'); kit.px(W / 2 - tw / 2 - 5, ROOF - 31, tw + 10, 16, '#3a3150');
    kit.text(text, W / 2 - tw / 2, ROOF - 27, '#e8b94a', k);
    kit.px(W / 2 - 16, ROOF - 14, 2, 2, '#2b2438'); kit.px(W / 2 + 14, ROOF - 14, 2, 2, '#2b2438');
    kit.px(360, ROOF - 44, 2, 32, '#5d5478'); kit.px(354, ROOF - 30, 14, 2, '#5d5478');
    kit.px(359, ROOF - 47, 4, 4, Math.floor(t * 2) % 2 ? '#ff5a5a' : '#6b2230');
  }
  function drawShaft(y0: number, y1: number): void {
    kit.px(SHAFT.x, y0, SHAFT.w, y1 - y0, '#241e33');
    kit.px(SHAFT.x + 3, y0, 1, y1 - y0, '#3b3452'); kit.px(SHAFT.x + SHAFT.w - 4, y0, 1, y1 - y0, '#3b3452');
  }
  function drawDoor(oy: number): void {
    // Sliding doors open while the car is stopped here.
    const here = Math.abs(car.y - (oy + 50)) < 1 ? car.door : 0;
    const w = Math.round(9 * (1 - here));
    kit.px(SHAFT.x - 1, oy + 49, SHAFT.w + 2, 2, '#5d5478'); kit.px(SHAFT.x - 1, oy + 49, 2, 29, '#5d5478'); kit.px(SHAFT.x + SHAFT.w - 1, oy + 49, 2, 29, '#5d5478');
    if (!here) kit.px(SHAFT.x + 1, oy + 51, 20, 26, '#1a1526');
    kit.px(SHAFT.x + 1, oy + 51, w, 26, '#9aa3b5'); kit.px(SHAFT.x + 21 - w, oy + 51, w, 26, '#9aa3b5');
    if (w > 1) { kit.px(SHAFT.x + 1 + w - 1, oy + 51, 1, 26, '#6d7688'); kit.px(SHAFT.x + 21 - w, oy + 51, 1, 26, '#c3cad6'); }
  }
  function drawTag(text: string, x: number, y: number, bg = '#e8b94a', fg = '#2b1d05'): void {
    const w = textWidth(text) + 4;
    kit.px(x - w / 2 - 1, y - 1, w + 2, 9, '#0f0c16'); kit.px(x - w / 2, y, w, 7, bg);
    kit.text(text, x - w / 2 + 2, y + 1, fg);
  }
  function drawFloor(f: TowerFloor, idx: number): void {
    const oy = Math.round(f.y), mgr = f.mgr!;
    kit.px(0, oy, W, 4, '#3b3452');
    kit.wall(g, 26, oy + 4, W - 26, 28);
    g.drawImage(strips[f.tone ?? 0], 0, 0, W - 26, FH - 32, 26, oy + 32, W - 26, FH - 32);
    // Wall: team plaque, level number, windows, per-floor counters.
    const name = f.annex ? `${label(mgr.name, 14)} annex` : mgr.role === 'orchestrator' ? 'Orchestrator' : `Team ${label(mgr.name, 16)}`;
    const tw = textWidth(name);
    kit.px(31, oy + 9, tw + 10, 13, '#0f0c16'); kit.px(32, oy + 10, tw + 8, 11, '#2b2438');
    kit.px(32, oy + 10, 2, 11, f.color!);
    kit.text(name, 37, oy + 13, '#f4eefc');
    kit.text(`${floors.length - idx}F`, 9, oy + 42, '#9aa3b5');
    kit.spr(idx % 2 ? 'window' : 'windowNote', 190, oy + 7);
    kit.spr('window', 236, oy + 7);
    const c = f.counts!, cols: [CountType, string][] = [['research', '#4a9eff'], ['code', '#3ecf6e'], ['bug', '#ff5a5a']];
    let cx = 304;
    for (const [k, col] of cols) { kit.px(cx, oy + 13, 5, 5, col); kit.text(String(c[k]), cx + 7, oy + 13, '#4a3d5c'); cx += 30; }
    if ((f.flash ?? 0) > 0) { g.globalAlpha = Math.min(1, f.flash! * 2); kit.px(26, oy + 4, W - 26, 2, f.flashColor!); g.globalAlpha = 1; }
    // Manager's glass office (or a small lounge on annex floors).
    kit.px(300, oy + 32, 100, FH - 36, 'rgba(255,255,255,0.08)');
    for (let yy = oy + 32; yy < oy + FH - 4; yy += 2) kit.px(300, yy, 2, 1, 'rgba(170,215,255,0.9)');
    kit.px(299, oy + 32, 4, 2, '#5d5478');
    drawDoor(oy);
    const drawn: { y: number; d: () => void }[] = [];
    for (let i = 0; i < f.blocks!.length; i++) drawn.push({ y: BLOCK_Y + 30, d: () => kit.drawBlock(f.blocks![i], f.seats!.slice(i * 2, i * 2 + 2), 0, oy) });
    if (f.desk) drawn.push({ y: f.desk.deskY! + 16, d: () => kit.drawDeskSeat(f.desk!, 0, oy) });
    else drawn.push({ y: 70, d: () => { kit.spr('sofaGreen', 326, oy + 52); kit.spr('plant', 372, oy + 50); } });
    for (const p of f.people ?? []) if (!(p.seat && (p.pose === 'sit' || p.hop))) drawn.push({ y: p.y, d: () => kit.drawStanding(p, 0, oy) });
    drawn.sort((a, b) => a.y - b.y).forEach((x) => x.d());
    if ((f.built ?? 1) < 1) {
      g.globalAlpha = 1 - f.built!;
      kit.px(26, oy + 4, W - 26, FH - 4, '#f4c542');
      for (let x = 26; x < W; x += 12) kit.px(x, oy + 4, 6, FH - 4, '#2b2438');
      g.globalAlpha = 1;
    }
  }
  function drawLobby(): void {
    const oy = Math.round(lobby.y);
    kit.px(0, oy, W, 4, '#3b3452');
    kit.wall(g, 26, oy + 4, W - 26, 28);
    g.drawImage(strips[4], 0, 0, W - 26, FH - 32, 26, oy + 32, W - 26, FH - 32);
    kit.spr('door', 356, oy + 1); kit.spr('door', 372, oy + 1);
    kit.px(354, oy - 1, 36, 2, '#3b3452');
    kit.text('LOBBY', 37, oy + 13, '#4a3d5c');
    kit.spr('clock', 150, oy + 8);
    drawDoor(oy);
    const drawn: { y: number; d: () => void }[] = [
      { y: 60, d: () => kit.drawDeskSeat(lobbyDesk, 0, oy) },
      { y: 66, d: () => { kit.spr('sofaBlue', 60, oy + 50); kit.spr('plant', 100, oy + 48); kit.spr('plant', 330, oy + 48); } },
    ];
    for (const p of lobby.people ?? []) if (p !== you) drawn.push({ y: p.y, d: () => kit.drawStanding(p, 0, oy) });
    drawn.sort((a, b) => a.y - b.y).forEach((x) => x.d());
    // Street.
    kit.px(0, oy + FH, W, LOBBY - FH + 20, '#2a2438');
    for (let x = 6; x < W; x += 28) kit.px(x, oy + FH + 7, 14, 2, '#5d5478');
  }
  function drawCar(): void {
    const y = Math.round(car.y);
    kit.px(SHAFT.x + 1, y, 20, 26, '#c9a045'); kit.px(SHAFT.x + 2, y + 1, 18, 24, '#8a6414');
    kit.px(SHAFT.x + 3, y + 3, 16, 10, '#f4d27a');
    (car.job?.riders ?? []).slice(0, 3).forEach((r, i) => kit.px(SHAFT.x + 4 + i * 5, y + 6, 4, 6, r.p.ch.sit.skin));
    kit.px(SHAFT.x + 10, ROOF, 1, Math.max(0, y - ROOF), '#15111f');
  }
  const showsDots = (p: Person) => p.blocked > 0 || (p.agent?.state === 'waiting' && p.pose === 'sit');

  // -------------------------------------------------------------------- loop
  let last = performance.now(), time = 0, raf = 0;
  function frame(now: number): void {
    if (destroyed) return;
    const dt = Math.min(0.05, (now - last) / 1000); last = now; time += dt;
    for (const f of floors) { f.y += (f.ty - f.y) * Math.min(1, dt * 6); if (Math.abs(f.ty - f.y) < 0.3) f.y = f.ty; f.built = Math.min(1, (f.built ?? 1) + dt * 0.8); f.flash = Math.max(0, (f.flash ?? 0) - dt); }
    lobby.y += (lobby.ty - lobby.y) * Math.min(1, dt * 6);
    for (const p of people.values()) kit.update(p, dt);
    kit.update(you, dt);
    updateCar(dt);
    kit.tick(dt);

    g.fillStyle = '#1d1828'; g.fillRect(0, 0, cv.width, cv.height);
    drawSky(time);
    drawShaft(ROOF, lobby.y + FH);
    drawCar();
    floors.forEach(drawFloor);
    drawLobby();
    kit.px(0, ROOF, 4, lobby.y + FH - ROOF, '#3b3452'); kit.px(W - 4, ROOF, 4, lobby.y + FH - ROOF, '#3b3452');
    kit.drawFlashes();
    // Overlays: emotes, tags, waiting dots.
    for (const p of people.values()) {
      const oy = p.floor?.y ?? 0;
      kit.drawOverlay(p, 0, oy, { dots: showsDots(p) });
      if (p.agent?.role === 'orchestrator' && p.visible) drawTag('BOSS', p.x, oy + p.y - (p.pose === 'sit' ? p.ch.front.hip + 10 : 40));
    }
    kit.drawOverlay(you, 0, lobby.y, { dots: model.root?.state === 'waiting' || waitActs.size > 0 });
    drawTag('YOU', you.x, lobby.y + you.y - you.ch.front.hip - 10, '#8a7cff', '#fff');
    raf = requestAnimationFrame(frame);
  }

  // -------------------------------------------------------------------- go
  function reset(): void {
    floors.length = 0; people.clear(); waitActs.clear();
    lobby.people = []; car.queue.length = 0; car.job = null;
    lobbyDesk.occupant = null; you.script.length = 0;
    setFloor(you, lobby); seatNow(you, lobbyDesk);
    car.y = stopY(lobby);
    reorder();
  }
  you = kit.person(YOU_LOOK, 'you');
  you.working = true;
  lobby.y = lobby.ty = ROOF;
  reset();
  resize();
  raf = requestAnimationFrame(frame);

  return {
    kind: 'tower',
    onReset: reset,
    onSynced() { reorder(); },
    onSpawn, onPromote, onFinish, onState, onEvent, onActivity, onActivityEnd,
    fit() { overview = !overview; resize(); scroller.scrollTo({ top: 0 }); },
    fitLabel: () => (overview ? 'Detail' : 'Overview'),
    info: () => ({ label: 'Tower', teams: floors.filter((f) => !f.annex && f.mgr?.role === 'manager').length }),
    destroy() {
      destroyed = true;
      clearTimeout(pruneTimer);
      cancelAnimationFrame(raf);
      ro.disconnect();
      scroller.remove();
    },
  };
}
