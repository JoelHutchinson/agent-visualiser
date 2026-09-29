# Agent Visualiser

Watch a coding agent work as a tiny pixel studio. A dev types at a desk, and every action the agent takes floats up as a coloured bubble: **blue** for research, **green** for code, **red** for bugs. When the agent waits for you, the dev leans back.

<!-- TODO: GIF -->

Works with **Claude Code** out of the box. It also works with **any agent that speaks OpenTelemetry**: Codex, Gemini CLI, or your own agent instrumented with the GenAI semantic conventions.

## Setup

1. `npx agent-visualiser` (Node 20+). A browser tab opens on an empty desk.
2. Start your agent as normal in any project.
3. Watch the bubbles.

For Claude Code, that's all. For other harnesses, point their OTLP exporter at the daemon (see below).

## How it works

```
 Claude Code ──► ~/.claude/projects/*.jsonl ──tail──┐
                                                    ├─► Hub ──ws──► Browser (Vue + canvas)
 Any agent ──OTLP gRPC :4317 / HTTP :4318──────────┘     ▲
                                                         │
                          recorded session (OTLP/JSON) ──┘  replay mode
```

- **Adapters** turn each source into small signals: counted events (`research | code | bug`, each attributed to the agent that did it), the agent tree (who spawned whom), and tool-call start/end. File contents, prompts and commands never leave the adapter.
- **Hub** merges the sources, counts each tool call once (a call seen in both the transcript and OTel has the same id), follows the newest session, keeps its agent tree and in-progress activities, and marks the orchestrator as waiting after 10 s of silence.
- **Front end** speaks wire protocol v2 ([src/shared/protocol.ts](src/shared/protocol.ts)): a `session` snapshot (agents, activities, counts) on connect, then `agent`, `activity` and `event` messages. Live, OTel and replay look identical to it.

### Agents

A session is a tree. The root agent (id = session id, "Orchestrator") is the one you talk to.

| | Claude Code transcript | OpenTelemetry |
| --- | --- | --- |
| Subagent starts | `Agent` (older: `Task`) tool_use. Name = its `description`, kind = `subagent_type`, id = the tool_use id. The prompt is never read. | `invoke_agent` span nested under another agent's span. Name = `gen_ai.agent.name`, id = `gen_ai.agent.id` |
| Subagent finishes | the tool_result (foreground), the `<task-notification>` (background), or its own `end_turn` | span end |
| Whose event is it | Claude Code keeps subagent lines in `<session>/subagents/agent-<id>.jsonl` (`isSidechain`, `agentId`) with an `agent-<id>.meta.json` whose `toolUseId` names the spawning tool_use; those files are tailed while the subagent runs. Lines that cannot be linked count for the orchestrator. | `execute_tool` spans go to the nearest enclosing `invoke_agent` (through the parent-span chain, remembered across exports); vendor logs (`claude_code.tool_result`, `codex.tool_result`, `gemini_cli.tool_call`) go to the orchestrator |

Spans are only exported when they end, so an OTel subagent appears and finishes in one batch (with its real start and end times). Turn ends (`stop_reason: "end_turn"`, or a finished top-level `invoke_agent` span) put the orchestrator in `waiting`; any new work puts it back to `working`.

### Activities

Away-from-desk work, per agent (`plan`, `web`, `run`, `wait`):

| Activity | Tools | Rule |
| --- | --- | --- |
| `plan` | `TodoWrite`, `TaskCreate`/`TaskUpdate`, `update_plan`, `write_todos`, `EnterPlanMode`/`ExitPlanMode` | start on the call, end on its result (or after 3 s without one) |
| `web` | `WebSearch`, `WebFetch`, `web_search`, `web_fetch`, `google_web_search` | start on the call, end on its result |
| `run` | `Bash`, `PowerShell`, `exec_command`, `shell`, `run_shell_command` | only starts if no result after 1.5 s (fast commands never show); `end` carries `ok` |
| `wait` | `AskUserQuestion` | start on the call, end on the answer |

OTel reports tools when they finish, so there the result is already in: `plan`/`wait` blink start+end, `run`/`web` only show for calls of 1.5 s or more (the duration comes from the span or `duration_ms`).

### Event mapping

| Event | Claude Code transcript | OpenTelemetry |
| --- | --- | --- |
| `research` / `code` | `tool_use` block (from any agent); tool name decides | `execute_tool` span (`gen_ai.tool.name`), or a `*.tool_result` / `*.tool_call` log |
| `bug` | `tool_result` with `is_error: true` | span status `ERROR`, `error.type`, or `success: false` |
| root `waiting` | `stop_reason: "end_turn"`, or 10 s of silence | root `invoke_agent` span ends, or 10 s of silence |

Tool names are classified per harness (`Read`, `read_file`, `search_file_content` → research; `Edit`, `apply_patch`, `run_shell_command` → code), then by leading verb for anything else, including MCP tools (`mcp__github__create_issue` → code). Unknown tools are ignored.

## Connecting other harnesses (OpenTelemetry)

The daemon runs an OTLP receiver on `127.0.0.1` only. It accepts gRPC on port 4317 and HTTP on 4318 (protobuf or JSON, gzip OK), with no collector needed. It follows the [OpenTelemetry GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai) (semconv v1.44), plus the vendor events each harness emits today.

**Codex** (`~/.codex/config.toml`)

```toml
[otel]
exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/logs", protocol = "binary" } }
```

**Gemini CLI** (`.gemini/settings.json`)

```json
{ "telemetry": { "enabled": true, "target": "local", "otlpEndpoint": "http://127.0.0.1:4317" } }
```

**Claude Code over OTel** (optional; transcripts already work without config)

```bash
CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_LOGS_EXPORTER=otlp OTEL_EXPORTER_OTLP_PROTOCOL=grpc OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4317 OTEL_LOGS_EXPORT_INTERVAL=1000 claude
```

**Your own agent**: emit `execute_tool {tool}` spans with `gen_ai.operation.name`, `gen_ai.tool.name`, `gen_ai.tool.call.id` and `gen_ai.conversation.id`, and wrap each turn in an `invoke_agent` span. For a hierarchy, nest further `invoke_agent` spans (with `gen_ai.agent.name`, `gen_ai.agent.id`, and optionally `agent_visualiser.agent.kind`) under the span of the agent that delegated, and parent each tool span under its agent.

> Exporters batch by default (often every 5 s). For bubbles within a second, lower the export interval, for example `OTEL_LOGS_EXPORT_INTERVAL=1000`, `OTEL_BSP_SCHEDULE_DELAY=500`.

## CLI

```
agent-visualiser [options]                  live: transcripts + OTLP
agent-visualiser --replay <file> [--speed 4] [--loop]
agent-visualiser record [transcript] -o session.jsonl

  -p, --port <n>       UI port (default 4580)
      --source <s>     auto | otel | transcripts
      --otlp-grpc <n>  default 4317, 0 disables
      --otlp-http <n>  default 4318, 0 disables
      --no-open
      --packs <dir>    art packs, served at /packs/ (default $AGENT_VISUALISER_PACKS,
                       ~/.agent-visualiser/packs, or ./packs in a repo checkout)
```

`record` writes a sanitised session as a standard OTLP/JSON trace (`invoke_agent` spans nested per subagent and `execute_tool` spans under their agent, with tool names, agent descriptions and timestamps only), so it can be replayed here or sent to any OTel backend. Given a Claude Code transcript it also picks up that session's `subagents/` folder (the 100 most recent). `--replay` also accepts raw Claude Code transcripts (same subagent handling) and OpenTelemetry Collector `file` exporter output; recordings made before agent hierarchies existed still replay.

Art packs are never bundled into `dist`: the daemon serves whatever directory it finds (see `--packs`) under `/packs/`, and refuses paths that escape it.

### The office

The scene is a pixel-art office that grows with the session. Roles come from the agent tree: the root agent is the orchestrator (boss desk), an agent that has spawned subagents is a manager (own team room or floor), a leaf is a worker.

- **Building tiers** (derived from the tree, and only ever growing within a session): a single *studio* for a solo session, a compact *office* once a team forms, and the full *mega* building (wings, planning, meeting, library, waiting and server rooms) for large swarms. A construction curtain covers each move.
- **Agents** walk in, sit and type; go to the whiteboards to plan, the library for web research, the server room for long commands (a failed run flashes the rack red and shakes the agent), and the waiting room when blocked on you. A finished agent reports to its lead, grabs a coffee and leaves. When the root waits for you, your own desk shows the waiting bubble.
- **Events** fly out of the agent as a coloured bubble into the HUD counters and flash the room.
- Drag to pan, scroll or pinch to zoom, double-click (or double-tap) a room to frame it, **Fit** to see everything.

**Art.** The default view uses the paid [LimeZu "Modern Office"](https://limezu.itch.io/modernoffice) pack, which cannot be redistributed: install it into `packs/` (see [packs/README.md](packs/README.md)) and it is loaded at runtime from `/packs` (served by the daemon; the Vite dev server does the same). It is never bundled into `dist/`. Without it the app silently falls back to a CC0-only *tower* view (one floor per team, an elevator between floors). The CC0 art (2dPig Pixel Office, JIK-A-4 MetroCity) is bundled from `web/public/art/`. Credits are in the page footer and in [proto/CREDITS.md](proto/CREDITS.md).

**URL options**

| Query | Effect |
| --- | --- |
| `?demo` or `?demo=story`, `solo`, `team`, `departments`, `swarm` | built-in simulator, no daemon needed; also shows the debug buttons (+ Subagent, + Sub-team, waiting) |
| `?replay=<url>&speed=4` | play a recording in the browser |
| `?pack=none` | use the CC0 tower view even if the LimeZu pack is installed |

The local app makes no outbound requests and uses the system font; only `?demo` and `?replay` pages fetch the Pixelify Sans font from Google Fonts.

## Hosted demo

```bash
npm run build:demo   # static site in dist/demo, runs fully in the browser
```

The hosted demo runs the built-in simulator (a session that starts solo and grows from studio to a full building) with no daemon. It has no LimeZu art, so it shows the CC0 tower. To play a real recording instead, host it next to the site and open `?replay=./my-session.jsonl` (create one with `agent-visualiser record`).

## Privacy

- Read-only: it never writes to `~/.claude` or changes any agent settings.
- Everything binds to `127.0.0.1`. It makes no outbound network calls and sends no telemetry.
- Events carry tool names and types only; agents carry an id, a short name (a subagent's `description`) and its type. OTLP payloads are mapped in memory and discarded.

## Development

```bash
npm install
npm run build        # front end → dist/web, daemon → dist/daemon
npm test             # includes end-to-end OTLP tests using the official OTel JS exporters
npm run dev:web      # Vite dev server; proxies /ws to a running daemon, serves ./packs at /packs
                     # open /?demo to try it with no daemon (built-in simulator)
```

## Visual prototypes (design archive)

The real front end lives in `web/src/office/` (typed ports of the office and tower prototypes: `mega.ts`, `tower.ts`, `kit.ts`, `sprites.ts`, a live `model.ts` fed by protocol messages, and the `sim.ts` simulator). The prototypes in `proto/` are kept as the design archive and are not imported by the app. They are driven by simulated events:

- `proto/pixel/`: pixel-art office (2dPig Pixel Office + JIK-A-4 MetroCity, CC0), plus two ways to scale it to any agent hierarchy:
  - `tower.html`: one floor per manager in hierarchy order, an elevator between floors, you in the lobby
  - `grid.html`: one huge pannable office; departments are zones holding glass-walled sub-offices per manager
- `proto/3d/`: isometric 3D office (Kenney Furniture Kit + Mini Characters, CC0)

```bash
npm run proto
```

Art credits are in [proto/CREDITS.md](proto/CREDITS.md).
