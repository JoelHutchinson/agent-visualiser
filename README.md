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
                                                    ├─► Hub ──ws──► Browser (Vue + PixiJS)
 Any agent ──OTLP gRPC :4317 / HTTP :4318──────────┘     ▲
                                                         │
                          recorded session (OTLP/JSON) ──┘  replay mode
```

- **Adapters** turn each source into one tiny event: `{ type, tool, sessionId, ts, harness }`, where `type` is `research | code | bug | idle`. File contents, prompts and commands never leave the adapter.
- **Hub** merges the sources, counts each tool call once (a call seen in both the transcript and OTel has the same id), follows the newest session, and marks it idle after 10 s of silence.
- **Front end** only knows those four event types, so live, OTel and replay look identical to it.

### Event mapping

| Event | Claude Code transcript | OpenTelemetry |
| --- | --- | --- |
| `research` / `code` | `tool_use` block; tool name decides | `execute_tool` span (`gen_ai.tool.name`), or a `*.tool_result` / `*.tool_call` log |
| `bug` | `tool_result` with `is_error: true` | span status `ERROR`, `error.type`, or `success: false` |
| `idle` | `stop_reason: "end_turn"`, or 10 s of silence | root `invoke_agent` span ends, or 10 s of silence |

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

**Your own agent**: emit `execute_tool {tool}` spans with `gen_ai.operation.name`, `gen_ai.tool.name`, `gen_ai.tool.call.id` and `gen_ai.conversation.id`, and wrap each turn in an `invoke_agent` span.

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
```

`record` writes a sanitised session as a standard OTLP/JSON trace (`execute_tool` and `invoke_agent` spans with tool names and timestamps only), so it can be replayed here or sent to any OTel backend. `--replay` also accepts raw Claude Code transcripts and OpenTelemetry Collector `file` exporter output.

## Hosted demo

```bash
npx agent-visualiser record path/to/session.jsonl -o web/public/demo-session.jsonl
npm run build:demo   # static site in dist/demo, runs fully in the browser
```

## Privacy

- Read-only: it never writes to `~/.claude` or changes any agent settings.
- Everything binds to `127.0.0.1`. It makes no outbound network calls and sends no telemetry.
- Events carry tool names and types only. OTLP payloads are mapped in memory and discarded.

## Development

```bash
npm install
npm run build        # front end → dist/web, daemon → dist/daemon
npm test             # includes end-to-end OTLP tests using the official OTel JS exporters
npm run dev:web      # Vite dev server; proxies /ws to a running daemon
```

## Visual prototypes

Two art directions for the scene live in `proto/`, both driven by simulated events for now:

- `proto/pixel/`: pixel-art office (2dPig Pixel Office + JIK-A-4 MetroCity, CC0), plus two ways to scale it to any agent hierarchy:
  - `tower.html`: one floor per manager in hierarchy order, an elevator between floors, you in the lobby
  - `grid.html`: one huge pannable office; departments are zones holding glass-walled sub-offices per manager
- `proto/3d/`: isometric 3D office (Kenney Furniture Kit + Mini Characters, CC0)

```bash
npm run proto
```

Art credits are in [proto/CREDITS.md](proto/CREDITS.md).
