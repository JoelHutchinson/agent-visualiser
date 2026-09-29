// Agent hierarchy model + simulator. Views listen for:
//   spawn(agent, {initial})  finish(agent)  event(agent, type)  state(agent)
// and call org.remove(agent) once the agent has walked out.

const GREEK = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta', 'Iota', 'Kappa', 'Lambda', 'Mu', 'Nu', 'Xi', 'Omicron', 'Pi', 'Rho', 'Sigma', 'Tau', 'Upsilon'];
const KINDS = ['explore', 'code', 'review', 'plan', 'test'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

export class Org {
  constructor() {
    this.agents = new Map();
    this.nextId = 1;
    this.teamNo = 0;
    this.listeners = { spawn: [], finish: [], event: [], state: [], activity: [] };
    this.timers = [];
    this.building = false;
  }
  on(kind, fn) { this.listeners[kind].push(fn); }
  emit(kind, ...args) { for (const fn of this.listeners[kind]) fn(...args); }
  get root() { return [...this.agents.values()].find((a) => !a.parent); }
  get list() { return [...this.agents.values()]; }
  get managers() { return this.list.filter((a) => a.role !== 'worker'); }

  add(parent, role) {
    const id = this.nextId++;
    const a = {
      id, parent, role, children: [], state: 'working', ready: this.building, born: performance.now(),
      depth: parent ? parent.depth + 1 : 0,
      kind: role === 'worker' ? pick(KINDS) : null,
    };
    if (role === 'orchestrator') a.name = 'Orchestrator';
    else if (role === 'manager') { a.team = GREEK[this.teamNo++ % GREEK.length]; a.name = parent?.role === 'manager' ? `${parent.name} / ${a.team}` : a.team; }
    else a.name = `${a.kind}-${id}`;
    a.dept = !parent ? null : parent.role === 'orchestrator' ? (role === 'manager' ? a : null) : parent.dept;
    if (parent) parent.children.push(a);
    this.agents.set(id, a);
    this.emit('spawn', a, { initial: this.building });
    return a;
  }
  finish(a) { if (a.state === 'done') return; a.state = 'done'; a.ready = false; this.emit('finish', a); }
  remove(a) {
    if (a.parent) a.parent.children.splice(a.parent.children.indexOf(a), 1);
    this.agents.delete(a.id);
  }
  setWaiting(on) { const r = this.root; r.state = on ? 'waiting' : 'working'; this.emit('state', r); }

  build(preset) {
    this.building = true;
    const r = this.add(null, 'orchestrator');
    PRESETS[preset].build(this, r);
    this.building = false;
  }

  /** Random but plausible activity: events, new subagents, finished work. */
  simulate({ spawnEvery = 3.2, finishEvery = 4.2, max = 60 } = {}) {
    this.stop();
    this.timers.push(setInterval(() => {
      const busy = this.list.filter((a) => a.state === 'working' && a.ready && (a.role === 'worker' || Math.random() < 0.15));
      if (!busy.length) return;
      const r = Math.random();
      this.emit('event', pick(busy), r < 0.4 ? 'research' : r < 0.92 ? 'code' : 'bug');
    }, 260));
    this.timers.push(setInterval(() => {
      if (this.agents.size >= max) return;
      const leads = this.managers.filter((m) => m.state !== 'done' && m.children.filter((c) => c.role === 'worker').length < (m.role === 'orchestrator' ? 4 : 8));
      if (!leads.length) return;
      const lead = pick(leads);
      if (Math.random() < 0.18 && lead.depth < 3) {
        const m = this.add(lead, 'manager');
        setTimeout(() => { if (this.agents.has(m.id)) for (let i = 0; i < 2; i++) this.add(m, 'worker'); }, 2500);
      } else this.add(lead, 'worker');
    }, spawnEvery * 1000));
    this.timers.push(setInterval(() => {
      const done = this.list.filter((a) => a.role === 'worker' && a.ready && a.state === 'working' && performance.now() - a.born > 12000);
      if (done.length) this.finish(pick(done));
    }, finishEvery * 1000));
  }
  /** Away-from-desk work: plan (whiteboard), web (library), run (servers), wait (blocked on the user). */
  simulateActivities(every = 2.2) {
    this.timers.push(setInterval(() => {
      const ready = this.list.filter((a) => a.role === 'worker' && a.ready && a.state === 'working');
      if (!ready.length) return;
      const r = Math.random();
      const kind = r < 0.25 ? 'plan' : r < 0.55 ? 'web' : r < 0.85 ? 'run' : 'wait';
      this.emit('activity', pick(ready), kind, 4 + Math.random() * 5);
    }, every * 1000));
  }
  stop() { for (const t of this.timers) clearInterval(t); this.timers = []; }
}

export const PRESETS = {
  team: {
    label: 'Team', build(o, r) { for (let i = 0; i < 4; i++) o.add(r, 'worker'); },
  },
  departments: {
    label: 'Departments',
    build(o, r) {
      o.add(r, 'worker'); o.add(r, 'worker');
      for (let i = 0; i < 3; i++) {
        const m = o.add(r, 'manager');
        for (let k = 0; k < 3 + i; k++) o.add(m, 'worker');
        if (i === 1) { const s = o.add(m, 'manager'); for (let k = 0; k < 3; k++) o.add(s, 'worker'); }
      }
    },
  },
  swarm: {
    label: 'Swarm',
    build(o, r) {
      o.add(r, 'worker'); o.add(r, 'worker');
      for (let i = 0; i < 5; i++) {
        const m = o.add(r, 'manager');
        for (let k = 0; k < 4 + (i % 3); k++) o.add(m, 'worker');
        if (i % 2 === 0) {
          const s = o.add(m, 'manager');
          for (let k = 0; k < 4; k++) o.add(s, 'worker');
          if (i === 0) { const t = o.add(s, 'manager'); for (let k = 0; k < 3; k++) o.add(t, 'worker'); }
        }
      }
    },
  },
};
