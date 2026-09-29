// The only vocabulary the front end understands. Events carry a tool name and
// a type, never file contents or prompts. Every harness adapter (Claude Code
// transcripts, OTLP from any agent) maps into this shape.

export type EventType = 'research' | 'code' | 'bug' | 'idle';

export interface VisEvent {
  type: EventType;
  tool?: string;
  sessionId: string;
  ts: string;
  /** Which agent produced it, e.g. "claude-code", "codex", "gemini-cli". */
  harness?: string;
  /** Tool-call id, used only to de-duplicate the same call seen through two
   *  channels (transcript + OTel, or OTel logs + spans). Never broadcast. */
  callId?: string;
}

export interface Counts {
  research: number;
  code: number;
  bug: number;
}

/** Messages sent from the daemon (or the in-browser replay) to the scene. */
export type ServerMessage =
  | { kind: 'waiting' }
  | {
      kind: 'session';
      sessionId: string;
      startedAt: string;
      counts: Counts;
      idle: boolean;
      /** Replay speed multiplier; 1 for live sessions. */
      rate: number;
      source: 'live' | 'replay';
      harness?: string;
    }
  | { kind: 'event'; event: VisEvent }
  | { kind: 'ended' };

export const IDLE_AFTER_MS = 10_000;

export function emptyCounts(): Counts {
  return { research: 0, code: 0, bug: 0 };
}

export function tally(counts: Counts, ev: VisEvent): void {
  if (ev.type !== 'idle') counts[ev.type]++;
}

// ------------------------------------------------------------ tool mapping

// Exact names first: the spec's Claude Code table plus well-known tools from
// Codex and Gemini CLI.
const EXACT: Record<string, 'research' | 'code' | null> = {
  Read: 'research', Grep: 'research', Glob: 'research', WebSearch: 'research', WebFetch: 'research',
  LS: 'research', NotebookRead: 'research',
  Edit: 'code', Write: 'code', MultiEdit: 'code', NotebookEdit: 'code', Bash: 'code', PowerShell: 'code',
  // Claude Code bookkeeping tools that only look like verbs.
  TodoWrite: null, ToolSearch: null, BashOutput: null, KillShell: null,
  // Codex
  shell: 'code', local_shell: 'code', exec_command: 'code', write_stdin: 'code', apply_patch: 'code',
  unified_exec: 'code', read_file: 'research', list_dir: 'research', grep_files: 'research',
  view_image: 'research', web_search: 'research', update_plan: null,
  // Gemini CLI
  run_shell_command: 'code', write_file: 'code', replace: 'code', edit: 'code',
  glob: 'research', search_file_content: 'research', list_directory: 'research',
  read_many_files: 'research', google_web_search: 'research', web_fetch: 'research',
  save_memory: null, write_todos: null,
};

const CODE_VERBS = new Set([
  'edit', 'write', 'apply', 'patch', 'replace', 'exec', 'execute', 'run', 'shell', 'bash', 'powershell',
  'create', 'delete', 'remove', 'move', 'rename', 'insert', 'str', 'multi', 'notebook', 'commit', 'update', 'set',
]);
const RESEARCH_VERBS = new Set([
  'read', 'grep', 'glob', 'search', 'find', 'list', 'ls', 'view', 'fetch', 'web', 'google', 'get', 'open',
  'cat', 'lookup', 'query', 'browse', 'inspect',
]);

/**
 * Classify any harness's tool name. Exact matches win; otherwise the leading
 * verb decides (`read_page` → research, `create_issue` → code). Anything
 * unrecognised returns null and is ignored, per the spec.
 */
export function classifyTool(name: string | undefined): 'research' | 'code' | null {
  if (!name) return null;
  if (Object.hasOwn(EXACT, name)) return EXACT[name];
  // MCP tools: mcp__server__tool (Claude Code) or server/tool, server.tool.
  const bare = name.replace(/^mcp__.+?__/, '').split(/[/.]/).pop() ?? name;
  if (Object.hasOwn(EXACT, bare)) return EXACT[bare];
  const verb = bare
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .find(Boolean);
  if (!verb) return null;
  if (RESEARCH_VERBS.has(verb)) return 'research';
  if (CODE_VERBS.has(verb)) return 'code';
  return null;
}

// ------------------------------------------------ Claude Code transcripts

/** Fields we read from a Claude Code transcript line. The format is not a
 *  public contract, so every access is defensive. */
export interface TranscriptLine {
  type?: string;
  sessionId?: string;
  timestamp?: string;
  isSidechain?: boolean;
  message?: {
    role?: string;
    stop_reason?: string | null;
    content?: unknown;
  };
}

interface ContentBlock {
  type?: string;
  id?: string;
  name?: string;
  is_error?: boolean;
  tool_use_id?: string;
}

/** Parse the JSON of one line; returns null for malformed input. */
export function parseJson(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

/**
 * Map one line to at most one event. Accepts Claude Code transcript lines and
 * lines that are already events.
 */
export function lineToEvent(line: string): VisEvent | null {
  const obj = parseJson(line);
  return obj ? objectToEvent(obj) : null;
}

export function objectToEvent(obj: unknown): VisEvent | null {
  if (isVisEvent(obj)) {
    const { type, tool, sessionId, ts, harness, callId } = obj;
    return { type, tool, sessionId, ts, harness, callId };
  }

  const line = obj as TranscriptLine;
  // Subagent traffic is out of scope for the MVP.
  if (line.isSidechain) return null;
  const msg = line.message;
  if (!msg || !Array.isArray(msg.content)) return null;

  const base = {
    sessionId: typeof line.sessionId === 'string' ? line.sessionId : 'unknown',
    ts: typeof line.timestamp === 'string' ? line.timestamp : new Date().toISOString(),
    harness: 'claude-code',
  };
  const blocks = msg.content as ContentBlock[];

  if (line.type === 'assistant') {
    for (const b of blocks) {
      if (b?.type !== 'tool_use' || typeof b.name !== 'string') continue;
      const type = classifyTool(b.name);
      if (type) return { ...base, type, tool: b.name, callId: b.id };
    }
    if (msg.stop_reason === 'end_turn') return { ...base, type: 'idle' };
    return null;
  }

  if (line.type === 'user') {
    for (const b of blocks) {
      if (b?.type === 'tool_result' && b.is_error === true) return { ...base, type: 'bug', callId: b.tool_use_id };
    }
  }
  return null;
}

function isVisEvent(obj: unknown): obj is VisEvent {
  const o = obj as Partial<VisEvent>;
  return (
    typeof o?.ts === 'string' &&
    typeof o?.sessionId === 'string' &&
    (o.type === 'research' || o.type === 'code' || o.type === 'bug' || o.type === 'idle')
  );
}

/** Drop fields the front end has no business seeing. */
export function publicEvent(ev: VisEvent): VisEvent {
  const { callId: _callId, ...rest } = ev;
  return rest;
}
