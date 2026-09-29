<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { emptyCounts, type Counts, type ServerMessage } from '../../src/shared/events.js';
import { connectDaemon, playDemo, type Feed, type LinkStatus } from './connection';
import { Scene } from './scene';

type CounterKey = keyof Counts;

const params = new URLSearchParams(location.search);
const demoUrl = import.meta.env.MODE === 'demo' ? './demo-session.jsonl' : params.get('replay');
const isDemo = demoUrl !== null;
const speeds = [1, 4, 16];
const HARNESS_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'gemini-cli': 'Gemini CLI',
  opencode: 'opencode',
  copilot: 'Copilot',
};

const stage = ref<HTMLElement>();
const counterEls: Partial<Record<CounterKey, HTMLElement>> = {};
const counts = reactive<Counts>(emptyCounts());
const bumped = reactive<Record<CounterKey, number>>({ research: 0, code: 0, bug: 0 });
const link = ref<LinkStatus>('connecting');
const session = ref<Extract<ServerMessage, { kind: 'session' }>>();
const waiting = ref(false);
const ended = ref(false);
const idle = ref(true);
const speed = ref(Number(params.get('speed')) || (isDemo ? 4 : 1));
const now = ref(Date.now());

// The session clock advances from the last event's timestamp at the feed's rate,
// so it reads correctly for both live sessions and sped-up replays.
const clock = { baseTs: 0, baseLocal: 0, rate: 1 };

let scene: Scene | undefined;
let feed: Feed | undefined;
let tickTimer: ReturnType<typeof setInterval> | undefined;

const counters: { key: CounterKey; label: string }[] = [
  { key: 'research', label: 'Research' },
  { key: 'code', label: 'Code' },
  { key: 'bug', label: 'Bugs' },
];

const statusText = computed(() => {
  if (link.value === 'offline') return isDemo ? 'Could not load the demo recording' : 'Daemon offline, reconnecting…';
  if (link.value === 'connecting') return isDemo ? 'Loading demo…' : 'Connecting…';
  if (waiting.value) return 'Waiting for a Claude Code session…';
  if (ended.value) return 'Replay finished';
  if (!session.value) return '';
  const who = session.value.source === 'replay' ? 'Replay' : 'Live';
  const harness = HARNESS_LABELS[session.value.harness ?? ''] ?? session.value.harness;
  return [who, harness, idle.value ? 'waiting for input' : 'working'].filter(Boolean).join(' · ');
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

function handle(msg: ServerMessage): void {
  switch (msg.kind) {
    case 'waiting':
      waiting.value = true;
      session.value = undefined;
      scene?.clear();
      Object.assign(counts, emptyCounts());
      idle.value = true;
      scene?.setIdle(true);
      break;
    case 'session': {
      waiting.value = false;
      ended.value = false;
      session.value = msg;
      scene?.clear();
      Object.assign(counts, msg.counts);
      idle.value = msg.idle;
      scene?.setIdle(msg.idle);
      // Live: the clock is wall time. Replay: start from the session's start.
      clock.baseTs = msg.source === 'live' ? Date.now() : Math.max(clock.baseTs, Date.parse(msg.startedAt));
      if (msg.source === 'replay' && msg.counts.research + msg.counts.code + msg.counts.bug === 0) {
        clock.baseTs = Date.parse(msg.startedAt);
      }
      clock.baseLocal = Date.now();
      clock.rate = msg.rate;
      break;
    }
    case 'event': {
      const ev = msg.event;
      if (session.value?.source === 'replay') {
        clock.baseTs = Date.parse(ev.ts);
        clock.baseLocal = Date.now();
      }
      idle.value = ev.type === 'idle';
      scene?.setIdle(idle.value);
      if (ev.type !== 'idle') scene?.spawn(ev.type, ev.tool);
      break;
    }
    case 'ended':
      ended.value = true;
      idle.value = true;
      scene?.setIdle(true);
      break;
  }
}

function land(key: CounterKey): void {
  counts[key]++;
  bumped[key]++;
}

function setSpeed(s: number): void {
  speed.value = s;
  feed?.setSpeed?.(s);
}

onMounted(async () => {
  scene = new Scene({
    targetFor: (type) => {
      const el = counterEls[type];
      const host = stage.value!.getBoundingClientRect();
      if (!el) return { x: host.width / 2, y: 0 };
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2 - host.left, y: r.top + r.height / 2 - host.top };
    },
    onLand: land,
  });
  await scene.mount(stage.value!);
  feed = isDemo ? playDemo(demoUrl!, speed.value, handle, (s) => (link.value = s)) : connectDaemon(handle, (s) => (link.value = s));
  tickTimer = setInterval(() => (now.value = Date.now()), 250);
});

onBeforeUnmount(() => {
  feed?.close();
  scene?.destroy();
  clearInterval(tickTimer);
});
</script>

<template>
  <main class="studio">
    <div ref="stage" class="stage" aria-hidden="true"></div>

    <header class="hud">
      <div class="brand">
        <span class="title">Agent Visualiser</span>
        <span class="status" :class="{ offline: link === 'offline', busy: !idle && link === 'open' }">
          <i></i>{{ statusText }}
        </span>
      </div>
      <div class="timer" title="Session length">{{ elapsed }}</div>
    </header>

    <section class="counters" aria-label="Counters">
      <div
        v-for="c in counters"
        :key="c.key"
        :ref="(el) => (counterEls[c.key] = el as HTMLElement)"
        class="counter"
        :class="c.key"
      >
        <span class="dot"></span>
        <span class="label">{{ c.label }}</span>
        <span :key="bumped[c.key]" class="value bump">{{ counts[c.key] }}</span>
      </div>
    </section>

    <footer v-if="isDemo" class="speed" aria-label="Replay speed">
      <span>Demo replay</span>
      <button v-for="s in speeds" :key="s" :class="{ active: speed === s }" @click="setSpeed(s)">{{ s }}×</button>
    </footer>
  </main>
</template>

<style scoped>
.studio {
  position: fixed;
  inset: 0;
  overflow: hidden;
  background: radial-gradient(ellipse at 50% 30%, var(--bg-glow), var(--bg) 70%);
}
.stage {
  position: absolute;
  inset: 0;
  overflow: hidden;
}
.hud {
  position: absolute;
  top: 16px;
  left: 16px;
  right: 16px;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  pointer-events: none;
}
.brand {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.title {
  font-weight: 800;
  letter-spacing: 0.02em;
  font-size: 18px;
}
.status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--muted);
}
.status i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--muted);
  flex: none;
}
.status.busy i {
  background: var(--code);
  box-shadow: 0 0 8px var(--code);
}
.status.offline i {
  background: var(--bug);
}
.timer {
  font: 700 20px/1 ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--panel);
  border: 1px solid var(--border);
}
.counters {
  position: absolute;
  top: 76px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 12px;
  pointer-events: none;
  width: max-content;
  max-width: calc(100% - 32px);
}
.counter {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-radius: 999px;
  background: var(--panel);
  border: 1px solid var(--border);
  min-width: 0;
}
.dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  flex: none;
}
.research .dot { background: var(--research); }
.code .dot { background: var(--code); }
.bug .dot { background: var(--bug); }
.label {
  font-size: 13px;
  color: var(--muted);
}
.value {
  font: 800 18px/1 ui-monospace, Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
  min-width: 2ch;
  text-align: right;
}
.bump {
  display: inline-block;
  animation: bump 260ms ease-out;
}
@keyframes bump {
  40% { transform: scale(1.35); }
}
.speed {
  position: absolute;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px 6px 14px;
  border-radius: 999px;
  background: var(--panel);
  border: 1px solid var(--border);
  font-size: 13px;
  color: var(--muted);
  white-space: nowrap;
}
.speed button {
  font: inherit;
  color: var(--text);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 999px;
  padding: 4px 10px;
  cursor: pointer;
}
.speed button.active {
  background: var(--border);
}
@media (max-width: 520px) {
  .counters { gap: 6px; top: 84px; }
  .counter { padding: 6px 10px; gap: 6px; }
  .label { font-size: 11px; }
  .value { font-size: 15px; }
  .title { font-size: 15px; }
  .timer { font-size: 16px; }
}
@media (prefers-reduced-motion: reduce) {
  .bump { animation: none; }
}
</style>
