<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import type { ServerMessage } from '../../src/shared/protocol';
import { connectDaemon, playReplay, type Feed, type LinkStatus } from './office/feeds';
import { createFx } from './office/fx';
import { createOffice, type Office } from './office';
import { OfficeModel } from './office/model';
import { PRESETS, Simulator, type DemoControls, type Preset } from './office/sim';
import type { CountType, Host } from './office/types';

// ?demo[=preset] runs the built-in simulator (also the hosted demo build);
// ?replay=<url> plays a recording; otherwise it follows the local daemon.
// ?pack=none forces the CC0 tower view even if the LimeZu pack is installed.
const params = new URLSearchParams(location.search);
const replayUrl = params.get('replay');
const demoParam = params.get('demo');
const isDemo = !replayUrl && (import.meta.env.MODE === 'demo' || demoParam !== null);
const preset: Preset = PRESETS.some((p) => p.id === demoParam) ? (demoParam as Preset) : 'story';
const speeds = [1, 4, 16];
const HARNESS_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'gemini-cli': 'Gemini CLI',
  opencode: 'opencode',
  copilot: 'Copilot',
};

const stage = ref<HTMLElement>();
const layer = ref<HTMLElement>();
const hudEl = ref<HTMLElement>();
const bottomEl = ref<HTMLElement>();
const counterEls: Partial<Record<CountType, HTMLElement>> = {};
const counts = reactive<Record<CountType, number>>({ research: 0, code: 0, bug: 0 });
const bumped = reactive<Record<CountType, number>>({ research: 0, code: 0, bug: 0 });
const link = ref<LinkStatus>('connecting');
const session = ref<Extract<ServerMessage, { kind: 'session' }>>();
const waiting = ref(false);
const ended = ref(false);
const loading = ref(true);
const failed = ref(false);
const credits = ref<string[]>([]);
const renderer = ref<'mega' | 'tower'>('mega');
const fitLabel = ref('Fit');
const waitOn = ref(false);
const stats = reactive({ label: '', teams: 0, agents: 0, rootWaiting: false, idle: true });
const speed = ref(Number(params.get('speed')) || (replayUrl ? 4 : 1));
const now = ref(Date.now());

// The session clock advances from the last message's timestamp at the feed's rate,
// so it reads correctly for live sessions, the simulator and sped-up replays.
const clock = { baseTs: 0, baseLocal: 0, rate: 1 };

let office: Office | undefined;
let feed: Feed | undefined;
let demo: DemoControls | undefined;
let fx: ReturnType<typeof createFx> | undefined;
let tickTimer: ReturnType<typeof setInterval> | undefined;

const counters: { key: CountType; label: string }[] = [
  { key: 'research', label: 'Research' },
  { key: 'code', label: 'Code' },
  { key: 'bug', label: 'Bugs' },
];

const host: Host = {
  setCounts: (c) => Object.assign(counts, c),
  count: (t) => { counts[t]++; bumped[t]++; },
  fly: (from, t) => (fx ? fx.fly(from, t) : host.count(t)),
  say: (text, at, secs) => fx?.say(text, at, secs),
  insets() {
    const top = hudEl.value ? hudEl.value.getBoundingClientRect().bottom + 6 : 70;
    const bottom = bottomEl.value ? Math.max(0, innerHeight - bottomEl.value.getBoundingClientRect().top) : 60;
    return { top, bottom };
  },
};
const model = new OfficeModel(host);

const offline = computed(() => link.value === 'offline' && !isDemo);
const notice = computed(() => {
  if (loading.value || failed.value) return null;
  if (offline.value) return { title: 'Reconnecting…', text: 'The daemon is not answering. Is `agent-visualiser` still running?' };
  if (link.value === 'offline') return { title: 'Could not load the recording', text: 'Check the ?replay= address.' };
  if (waiting.value && link.value === 'open') return { title: 'Waiting for a session…', text: 'Start Claude Code (or any OpenTelemetry agent) in a project and the office will fill up.' };
  return null;
});

const statusText = computed(() => {
  if (failed.value) return 'Could not load the office art';
  if (loading.value) return 'Building the office…';
  if (link.value === 'offline') return isDemo || replayUrl ? 'Could not load the recording' : 'Daemon offline, reconnecting…';
  if (link.value === 'connecting') return 'Connecting…';
  if (waiting.value) return 'Waiting for a session…';
  if (ended.value) return 'Replay finished';
  const s = session.value;
  if (!s) return '';
  const who = s.source === 'replay' ? 'Replay' : s.source === 'demo' ? 'Demo' : 'Live';
  const harness = HARNESS_LABELS[s.harness ?? ''] ?? s.harness;
  const n = stats.agents;
  const building = `${stats.label} · ${n} agent${n === 1 ? '' : 's'}${stats.teams ? ` · ${stats.teams} team${stats.teams === 1 ? '' : 's'}` : ''}`;
  return [who, harness, building, stats.rootWaiting ? 'waiting for you' : stats.idle ? 'idle' : 'working'].filter(Boolean).join(' · ');
});

const elapsed = computed(() => {
  const s = session.value;
  if (!s || waiting.value) return '0:00:00';
  const started = Date.parse(s.startedAt);
  const current = ended.value ? clock.baseTs : clock.baseTs + (now.value - clock.baseLocal) * clock.rate;
  const secs = Math.max(0, Math.floor((current - started) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
});

function sync(): void {
  const info = office?.view.info();
  if (info) { stats.label = info.label; stats.teams = info.teams; }
  stats.agents = model.agents.size;
  stats.rootWaiting = model.root?.state === 'waiting';
  stats.idle = model.idle;
  fitLabel.value = office?.view.fitLabel() ?? 'Fit';
}

function handle(msg: ServerMessage): void {
  switch (msg.kind) {
    case 'waiting':
      waiting.value = true;
      ended.value = false;
      session.value = undefined;
      break;
    case 'session':
      waiting.value = false;
      ended.value = false;
      session.value = msg;
      // Live and demo: the clock is wall time. Replay: start from the session's start.
      clock.baseTs = msg.source === 'replay' ? Math.max(clock.baseTs, Date.parse(msg.startedAt)) : Date.now();
      if (msg.source === 'replay' && msg.counts.research + msg.counts.code + msg.counts.bug === 0) clock.baseTs = Date.parse(msg.startedAt);
      clock.baseLocal = Date.now();
      clock.rate = msg.rate;
      break;
    case 'ended':
      ended.value = true;
      break;
    default: {
      const ts = msg.kind === 'event' ? msg.event.ts : msg.ts;
      if (session.value?.source === 'replay' && ts) { clock.baseTs = Date.parse(ts); clock.baseLocal = Date.now(); }
    }
  }
  model.handle(msg);
  sync();
}

function setSpeed(s: number): void {
  speed.value = s;
  feed?.setSpeed?.(s);
}
function fit(): void {
  office?.view.fit();
  sync();
}
function toggleWait(): void { waitOn.value = demo?.toggleWait() ?? false; }
function pickPreset(e: Event): void {
  const url = new URL(location.href);
  url.searchParams.set('demo', (e.target as HTMLSelectElement).value);
  location.href = url.toString();
}

onMounted(async () => {
  // The pixel font comes from Google Fonts, so only the demo pages ask for it;
  // the local app makes no outbound requests and falls back to the system font.
  if (isDemo || replayUrl) {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Pixelify+Sans:wght@400;600&display=swap';
    document.head.appendChild(l);
  }
  fx = createFx({ layer: layer.value!, counterEl: (t) => counterEls[t], onLand: host.count });
  tickTimer = setInterval(() => { now.value = Date.now(); sync(); }, 250);
  try {
    office = await createOffice({ stage: stage.value!, model, host, forceTower: params.get('pack') === 'none' });
  } catch {
    failed.value = true;
    loading.value = false;
    return;
  }
  renderer.value = office.view.kind;
  credits.value = office.credits;
  loading.value = false;
  if (replayUrl) feed = playReplay(replayUrl, speed.value, handle, (s) => (link.value = s));
  else if (isDemo) {
    const sim = new Simulator(preset, handle);
    feed = sim; demo = sim;
    link.value = 'open';
    sim.start();
  } else feed = connectDaemon(handle, (s) => (link.value = s));
  sync();
});

onBeforeUnmount(() => {
  feed?.close();
  model.detach();
  office?.view.destroy();
  fx?.destroy();
  clearInterval(tickTimer);
});
</script>

<template>
  <main class="app">
    <div ref="stage" class="stage"></div>
    <div ref="layer" class="fx" aria-hidden="true"></div>

    <header ref="hudEl" class="hud">
      <div
        v-for="c in counters"
        :key="c.key"
        :ref="(el) => (counterEls[c.key] = el as HTMLElement)"
        class="counter"
      >
        <i :class="c.key"></i>{{ c.label }} <b :key="bumped[c.key]" class="bump">{{ counts[c.key] }}</b>
      </div>
      <div class="timer" title="Session length">{{ elapsed }}</div>
      <button class="btn fit" type="button" title="Frame the whole building" @click="fit">{{ fitLabel }}</button>
      <div class="status" :class="{ offline: offline || failed }" role="status">{{ statusText }}</div>
    </header>

    <div v-if="loading" class="note"><div>Building the office…</div></div>
    <div v-else-if="failed" class="note"><div>Could not load the office art.<br />Try reloading the page.</div></div>
    <div v-else-if="notice" class="note">
      <div><strong>{{ notice.title }}</strong><br />{{ notice.text }}</div>
    </div>

    <div ref="bottomEl" class="bottom">
      <div v-if="demo || isDemo" class="controls" aria-label="Demo controls">
        <select :value="preset" aria-label="Scenario" @change="pickPreset">
          <option v-for="p in PRESETS" :key="p.id" :value="p.id">{{ p.label }}</option>
        </select>
        <button type="button" :class="{ on: waitOn }" @click="toggleWait">Waiting for input</button>
        <button type="button" @click="demo?.addWorker()">+ Subagent</button>
        <button type="button" @click="demo?.addTeam()">+ Sub-team</button>
      </div>
      <div v-else-if="replayUrl" class="controls" aria-label="Replay speed">
        <span>Replay</span>
        <button v-for="s in speeds" :key="s" type="button" :class="{ on: speed === s }" @click="setSpeed(s)">{{ s }}×</button>
      </div>
      <footer class="credit">
        <span v-if="credits.length">Art: {{ credits.join(' · ') }}</span>
        <span class="hint">{{ renderer === 'mega' ? 'Drag to pan · scroll or pinch to zoom · double-click a room' : 'Scroll to explore' }}</span>
      </footer>
    </div>
  </main>
</template>

<style>
/* Effects created outside Vue (renderers and bubbles), so not scoped. */
.office-canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; image-rendering: pixelated; cursor: grab; touch-action: none; }
.office-canvas.drag { cursor: grabbing; }
.tower-scroller { position: absolute; inset: 0; overflow: auto; box-sizing: border-box; }
.tower-canvas { display: block; margin: 0 auto; image-rendering: pixelated; box-shadow: 0 0 0 4px var(--edge); }
.fx { position: fixed; inset: 0; pointer-events: none; z-index: 20; overflow: hidden; }
.bubble { position: fixed; left: 0; top: 0; width: 20px; height: 20px; margin: -10px 0 0 -10px; border: 3px solid var(--edge);
  display: grid; place-items: center; font: 600 11px/1 var(--font); color: #fff; }
.say { position: fixed; left: 0; top: 0; white-space: nowrap; border: 3px solid var(--edge); padding: 3px 8px; font-size: 13px; color: #1d1a24; background: #fff; }
</style>

<style scoped>
.app { position: fixed; inset: 0; overflow: hidden; background: var(--bg); }
.stage { position: absolute; inset: 0; overflow: hidden; }
.hud { position: absolute; top: 10px; left: 10px; right: 10px; display: flex; gap: 6px; flex-wrap: wrap; align-items: center; pointer-events: none; z-index: 10; }
.hud > * { pointer-events: auto; }
.counter { display: flex; align-items: center; gap: 7px; padding: 4px 9px; background: var(--panel); border: 3px solid var(--edge); box-shadow: inset 0 -3px 0 #0004; }
.counter i { width: 10px; height: 10px; }
.counter i.research { background: var(--research); }
.counter i.code { background: var(--code); }
.counter i.bug { background: var(--bug); }
.counter b { font-weight: 600; font-size: 17px; min-width: 2ch; text-align: right; font-variant-numeric: tabular-nums; }
.timer { padding: 4px 9px; background: var(--panel); border: 3px solid var(--edge); box-shadow: inset 0 -3px 0 #0004; font-weight: 600; font-size: 17px; font-variant-numeric: tabular-nums; }
.btn { font: inherit; font-size: 14px; color: var(--text); background: #3a3150; border: 3px solid var(--edge); box-shadow: inset 0 -3px 0 #0005; padding: 4px 10px; cursor: pointer; }
.btn:active { transform: translateY(1px); }
.fit { margin-left: auto; }
.status { width: 100%; color: #cfc8e0; font-size: 13px; pointer-events: none; text-shadow: 0 1px 0 var(--edge), 1px 0 0 var(--edge), -1px 0 0 var(--edge), 0 -1px 0 var(--edge); }
.status.offline { color: var(--bug); }
.bump { animation: bump 0.25s steps(3); }
@keyframes bump { 50% { transform: translateY(-3px); } }
.note { position: absolute; inset: 0; display: grid; place-items: start center; padding: 22vh 24px 24px; text-align: center; color: var(--muted); pointer-events: none; z-index: 5; }
.note > div { max-width: 340px; padding: 12px 16px; background: var(--panel); border: 3px solid var(--edge); box-shadow: inset 0 -3px 0 #0004; line-height: 1.5; }
.note strong { color: var(--text); font-weight: 600; font-size: 18px; }
.bottom { position: absolute; left: 10px; right: 10px; bottom: 8px; display: flex; flex-direction: column; align-items: center; gap: 6px; pointer-events: none; z-index: 10; }
.controls { display: flex; gap: 4px; flex-wrap: wrap; justify-content: center; align-items: center; padding: 5px; background: var(--panel); border: 3px solid var(--edge); max-width: 100%; box-sizing: border-box; pointer-events: auto; color: var(--muted); font-size: 14px; }
.controls button, .controls select { font: inherit; font-size: 14px; color: var(--text); background: #3a3150; border: 0; box-shadow: inset 0 -3px 0 #0005; padding: 5px 9px; cursor: pointer; }
.controls button:active { transform: translateY(1px); }
.controls button.on { background: var(--accent); }
.credit { display: flex; justify-content: space-between; gap: 12px; width: 100%; color: var(--muted); font-size: 11px; line-height: 1.3; }
.hint { text-align: right; flex: none; }
@media (max-width: 640px) {
  .hint { display: none; }
  .credit { justify-content: center; text-align: center; }
  .counter { padding: 3px 7px; gap: 5px; }
  .counter b, .timer { font-size: 15px; }
}
@media (prefers-reduced-motion: reduce) {
  .bump { animation: none; }
}
</style>
