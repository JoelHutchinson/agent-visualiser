#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { ServerMessage } from '../shared/events.js';
import { parseRecording, ReplayPlayer, toOtlpRecording } from '../shared/replay.js';
import { Hub } from './hub.js';
import { startOtlpGrpc, startOtlpHttp } from './otlp.js';
import { startServer } from './server.js';
import { findNewestSession, TranscriptSource } from './transcripts.js';

const HELP = `agent-visualiser: watch a coding agent's session as a tiny dev studio

Usage:
  agent-visualiser [options]                 visualise live sessions
  agent-visualiser --replay <file> [options] play a recording
  agent-visualiser record [file] [-o out]    save a Claude Code transcript as a
                                             sanitised OTLP/JSON recording

Live sources (default: both):
  Claude Code transcripts   ~/.claude/projects, zero config
  OpenTelemetry (OTLP)      any harness: Claude Code, Codex, Gemini CLI, ...
                            gRPC  127.0.0.1:4317   HTTP  127.0.0.1:4318

Options:
  -p, --port <n>        UI port on 127.0.0.1 (default 4580)
      --source <s>      auto | otel | transcripts (default auto)
      --otlp-grpc <n>   OTLP/gRPC port (default 4317, 0 to disable)
      --otlp-http <n>   OTLP/HTTP port (default 4318, 0 to disable)
  -r, --replay <f>      replay a transcript, event log or OTLP/JSON file
  -s, --speed <n>       replay speed multiplier (default 1)
      --loop            loop the replay
      --no-open         don't open the browser
      --projects <d>    Claude Code projects dir (default ~/.claude/projects)
  -h, --help
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string', short: 'p', default: '4580' },
    source: { type: 'string', default: 'auto' },
    'otlp-grpc': { type: 'string', default: '4317' },
    'otlp-http': { type: 'string', default: '4318' },
    replay: { type: 'string', short: 'r' },
    speed: { type: 'string', short: 's', default: '1' },
    loop: { type: 'boolean', default: false },
    'no-open': { type: 'boolean', default: false },
    projects: { type: 'string', default: path.join(os.homedir(), '.claude', 'projects') },
    out: { type: 'string', short: 'o' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

if (positionals[0] === 'record') {
  const src = positionals[1] ?? findNewestSession(values.projects!)?.file;
  if (!src) fail('No session file found to record.');
  const rec = parseRecording(fs.readFileSync(src, 'utf8'));
  const out = toOtlpRecording(rec);
  if (values.out) {
    fs.writeFileSync(values.out, out);
    console.error(`Recorded ${rec.events.length} events from ${src} to ${values.out}`);
  } else process.stdout.write(out);
  process.exit(0);
}

const webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
if (!fs.existsSync(path.join(webDir, 'index.html'))) fail(`Front end not built (looked in ${webDir}). Run "npm run build".`);

const port = parsePort(values.port!, 'port');
const speed = Number(values.speed);
if (!(speed > 0)) fail(`Invalid speed: ${values.speed}`);
const sourceMode = values.source!;
if (!['auto', 'otel', 'transcripts'].includes(sourceMode)) fail(`Invalid --source: ${sourceMode}`);

let broadcast: (msg: ServerMessage) => void = () => {};
const emit = (msg: ServerMessage) => broadcast(msg);
const stops: (() => unknown)[] = [];
let snapshot: () => ServerMessage;
let afterListen = () => {};

if (values.replay) {
  const rec = parseRecording(fs.readFileSync(values.replay, 'utf8'));
  if (!rec.events.length) fail(`No events found in ${values.replay}`);
  const player = new ReplayPlayer(rec, emit, { speed, loop: values.loop });
  snapshot = () => player.snapshot();
  stops.push(() => player.stop());
  afterListen = () => player.start();
  console.log(`Replaying ${rec.events.length} events from ${values.replay} at ${speed}x`);
} else {
  const hub = new Hub(emit);
  snapshot = () => hub.snapshot();
  stops.push(() => hub.stop());

  if (sourceMode !== 'otel') {
    const transcripts = new TranscriptSource({ projectsDir: values.projects! }, hub);
    transcripts.start();
    stops.push(() => transcripts.stop());
    console.log(`Watching Claude Code transcripts in ${values.projects}`);
  }
  if (sourceMode !== 'transcripts') {
    const onEvents = (evs: Parameters<Hub['ingest']>[0]) => evs.length && hub.ingest(evs);
    for (const [label, flag, start] of [
      ['gRPC', 'otlp-grpc', startOtlpGrpc],
      ['HTTP', 'otlp-http', startOtlpHttp],
    ] as const) {
      const p = parsePort(values[flag]!, flag);
      if (!p) continue;
      try {
        const srv = await start(p, onEvents);
        stops.push(() => srv.close());
        console.log(`OTLP/${label} receiver on 127.0.0.1:${p}`);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        console.warn(`OTLP/${label} not started on port ${p}${code === 'EADDRINUSE' ? ' (in use, maybe a collector?)' : ''}; use --${flag} <n>.`);
      }
    }
  }
}

const server = await startServer({ port, webDir, snapshot }).catch((err) =>
  fail(err?.code === 'EADDRINUSE' ? `Port ${port} is in use; try --port <n>.` : String(err)),
);
broadcast = server.broadcast;
afterListen();

const url = `http://127.0.0.1:${server.port}/`;
console.log(`Agent Visualiser running at ${url}  (Ctrl+C to stop)`);
if (!values['no-open']) openBrowser(url);

const shutdown = async () => {
  await Promise.allSettled(stops.map((s) => s()));
  await server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function parsePort(raw: string, name: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) fail(`Invalid --${name}: ${raw}`);
  return n;
}

function openBrowser(target: string): void {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', target]]
      : process.platform === 'darwin'
        ? ['open', [target]]
        : ['xdg-open', [target]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    // No browser available; the URL is printed above.
  }
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
