// Claude Code transcript lines → Signals, including the agent hierarchy.
//
// Format facts this relies on (checked against real transcripts, Claude Code
// 2.1.x; the format is not a public contract, so every access is defensive):
//
//  * The main session is `<project>/<session>.jsonl`. Subagent lines are NOT
//    in it: each subagent has `<project>/<session>/subagents/agent-<id>.jsonl`
//    plus `agent-<id>.meta.json` = { toolUseId, description, agentType, ... }.
//  * Every subagent line has `isSidechain: true`, `agentId: "<id>"` (the id in
//    the file name) and the PARENT's `sessionId`. Main-file lines have neither
//    agentId nor sidechain.
//  * The spawn is an `Agent` (older: `Task`) tool_use in the spawner's file,
//    input { description, subagent_type, prompt, ... }. meta.json's toolUseId
//    equals that tool_use id, which is how the two are linked. The spawn's
//    tool_result carries `toolUseResult.agentId`; for background agents its
//    `status` is "async_launched" and the real completion arrives later as a
//    `<task-notification>` (queue-operation line) naming the tool-use id.
//  * A subagent's own final assistant line has stop_reason "end_turn".
//
// Attribution: an agent's id here is the spawning tool_use id (stable, known
// before the subagent writes a line). Lines from a subagent file are mapped
// back to it via agentId. Lines that cannot be linked go to the root agent.
//
// Privacy: only tool names, ids, the spawn's short description and subagent
// type are read. The spawn prompt, tool inputs and outputs never leave here.

import { classifyTool, parseJson, type Signal, type VisEvent } from './events.js';
import { rootAgentId, type AgentInfo } from './protocol.js';

/** What a subagent's meta.json tells us; used when its lines show up before
 *  (or without) the parent's spawn line. */
export interface SubagentHint {
  agentId: string;
  toolUseId?: string;
  description?: string;
  agentType?: string;
}

const SPAWN_TOOLS = new Set(['Agent', 'Task']);
const MAX_NAME = 60;
const TERMINAL = new Set(['completed', 'failed', 'killed', 'stopped', 'cancelled', 'error']);

interface Block {
  type?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  is_error?: boolean;
  tool_use_id?: string;
  text?: string;
}

type Open = { kind: 'spawn'; agentId: string } | { kind: 'tool'; agentId: string; tool: string; stops?: string };

const shorten = (s: unknown, fallback: string) => {
  const t = typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '';
  return (t || fallback).slice(0, MAX_NAME);
};
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

export class TranscriptParser {
  /** Session id of the most recent line; transcripts carry it on every line. */
  sessionId: string;
  private agents = new Map<string, AgentInfo>();
  private byTranscriptId = new Map<string, string>();
  private hints = new Map<string, SubagentHint>();
  private open = new Map<string, Open>();

  constructor(sessionId = 'unknown') {
    this.sessionId = sessionId;
  }

  /** Remember a subagent's meta.json so its lines can be attributed even if
   *  the parent's spawn line was missed. */
  hint(h: SubagentHint): void {
    this.hints.set(h.agentId, h);
  }

  /** True once the subagent with this transcript agentId has finished. */
  isDone(transcriptAgentId: string): boolean {
    const id = this.byTranscriptId.get(transcriptAgentId);
    return !!id && this.agents.get(id)?.state === 'done';
  }

  /**
   * Parse one line. `fileAgentId` is the agentId from the subagent file name
   * (undefined for the main session file).
   */
  feed(line: string | Record<string, unknown>, fileAgentId?: string): Signal[] {
    const obj = typeof line === 'string' ? parseJson(line) : line;
    if (!obj) return [];
    const out: Signal[] = [];
    const ts = str(obj.timestamp) ?? new Date().toISOString();
    if (str(obj.sessionId)) this.sessionId = obj.sessionId as string;
    const sessionId = this.sessionId;
    const root = rootAgentId(sessionId);

    if (obj.type === 'queue-operation') {
      if (obj.operation === 'enqueue' && typeof obj.content === 'string') this.notifications(obj.content, sessionId, ts, out);
      return out;
    }

    const owner = this.ownerOf(obj, fileAgentId, root, sessionId, ts, out);
    const msg = obj.message as { role?: string; stop_reason?: string | null; content?: unknown } | undefined;
    if (!msg) return out;

    const event = (type: VisEvent['type'], extra: Partial<VisEvent> = {}) =>
      out.push({ kind: 'event', event: { type, sessionId, agentId: owner, ts, harness: 'claude-code', ...extra } });

    if (obj.type === 'assistant' && Array.isArray(msg.content)) {
      for (const b of msg.content as Block[]) {
        if (b?.type !== 'tool_use' || typeof b.name !== 'string') continue;
        const input = b.input ?? {};
        if (SPAWN_TOOLS.has(b.name) && b.id) {
          this.upsert({ id: b.id, parentId: owner, name: shorten(input.description, 'Subagent'), kind: str(input.subagent_type), state: 'working', startedAt: ts }, sessionId, ts, out);
          this.track(b.id, { kind: 'spawn', agentId: b.id });
          continue;
        }
        const type = classifyTool(b.name);
        if (type) event(type, { tool: b.name, callId: b.id });
        if (b.id) {
          // TaskStop kills a background task (maybe a background subagent).
          const stops = b.name === 'TaskStop' ? str(input.task_id) : undefined;
          this.track(b.id, { kind: 'tool', agentId: owner, tool: b.name, stops });
          out.push({ kind: 'tool', sessionId, agentId: owner, tool: b.name, callId: b.id, op: 'start', ts });
        }
      }
      if (msg.stop_reason === 'end_turn') {
        // The root's turn ending hands the move to the user; a subagent's
        // ending means it is finished.
        if (owner === root) event('idle');
        else this.finish(owner, sessionId, ts, out);
      }
      return out;
    }

    if (obj.type === 'user') {
      if (typeof msg.content === 'string') {
        if (msg.content.includes('<task-notification>')) this.notifications(msg.content, sessionId, ts, out);
        else if (owner === root && obj.isMeta !== true) this.wake(sessionId, ts, out);
        return out;
      }
      if (!Array.isArray(msg.content)) return out;
      const result = obj.toolUseResult as Record<string, unknown> | undefined;
      let prompted = false;
      for (const b of msg.content as Block[]) {
        if (b?.type === 'text') prompted = true;
        if (b?.type !== 'tool_result') continue;
        const failed = b.is_error === true;
        const open = b.tool_use_id ? this.open.get(b.tool_use_id) : undefined;
        if (b.tool_use_id) this.open.delete(b.tool_use_id);
        if (open?.kind === 'spawn') {
          const tid = str(result?.agentId);
          if (tid) this.byTranscriptId.set(tid, open.agentId);
          // A background launch returns at once; the agent is still running.
          if (result?.status !== 'async_launched') this.finish(open.agentId, sessionId, ts, out);
        } else if (open?.kind === 'tool') {
          if (open.stops && !failed) {
            const id = this.byTranscriptId.get(open.stops) ?? (this.agents.has(open.stops) ? open.stops : undefined);
            if (id) this.finish(id, sessionId, ts, out);
          }
          out.push({ kind: 'tool', sessionId, agentId: open.agentId, tool: open.tool, callId: b.tool_use_id, op: 'end', ok: !failed, ts });
        }
        if (failed) event('bug', { callId: b.tool_use_id, tool: open?.kind === 'tool' ? open.tool : undefined });
      }
      // A user turn with text and no tool results is the human typing.
      if (prompted && owner === root && obj.isMeta !== true) this.wake(sessionId, ts, out);
    }
    return out;
  }

  private track(id: string, o: Open): void {
    this.open.set(id, o);
    // Calls whose result never arrives must not pile up forever.
    if (this.open.size > 5000) this.open.delete(this.open.keys().next().value!);
  }

  /** The agent a line belongs to: its subagent (linked via agentId), else the root. */
  private ownerOf(obj: Record<string, unknown>, fileAgentId: string | undefined, root: string, sessionId: string, ts: string, out: Signal[]): string {
    const tid = str(obj.agentId) ?? fileAgentId;
    if (!tid) return root;
    const known = this.byTranscriptId.get(tid);
    if (known) return known;
    const hint = this.hints.get(tid);
    if (hint?.toolUseId) {
      this.byTranscriptId.set(tid, hint.toolUseId);
      // The spawn line normally arrived first; if not, register from meta.json
      // (parent unknown → the orchestrator).
      if (!this.agents.has(hint.toolUseId)) {
        this.upsert({ id: hint.toolUseId, parentId: root, name: shorten(hint.description, 'Subagent'), kind: hint.agentType, state: 'working', startedAt: ts }, sessionId, ts, out);
      }
      return hint.toolUseId;
    }
    // Unlinkable: keep the work, credit the orchestrator.
    return root;
  }

  /** `<task-notification>` (background task finished): `<tool-use-id>` or `<task-id>` names the agent. */
  private notifications(text: string, sessionId: string, ts: string, out: Signal[]): void {
    for (const m of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
      const body = m[1];
      const status = /<status>\s*([a-z_]+)\s*<\/status>/i.exec(body)?.[1]?.toLowerCase();
      if (status && !TERMINAL.has(status)) continue;
      for (const tag of ['tool-use-id', 'task-id']) {
        const ref = new RegExp(`<${tag}>\\s*([^<\\s]+)\\s*</${tag}>`).exec(body)?.[1];
        const id = ref && (this.agents.has(ref) ? ref : this.byTranscriptId.get(ref));
        if (id) this.finish(id, sessionId, ts, out);
      }
    }
  }

  private finish(id: string, sessionId: string, ts: string, out: Signal[]): void {
    const a = this.agents.get(id);
    if (a && a.state !== 'done') this.upsert({ ...a, state: 'done' }, sessionId, ts, out);
  }

  /** The user spoke: the orchestrator is working again. */
  private wake(sessionId: string, ts: string, out: Signal[]): void {
    const id = rootAgentId(sessionId);
    out.push({ kind: 'agent', sessionId, agent: { id, parentId: null, name: 'Orchestrator', state: 'working', startedAt: ts }, ts });
  }

  /** Track an agent and emit it only when it is new or changed. */
  private upsert(a: AgentInfo, sessionId: string, ts: string, out: Signal[]): void {
    const prev = this.agents.get(a.id);
    if (prev && prev.parentId === a.parentId && prev.name === a.name && prev.kind === a.kind && prev.state === a.state) return;
    const next = { ...a, startedAt: prev?.startedAt ?? a.startedAt };
    this.agents.set(a.id, next);
    out.push({ kind: 'agent', sessionId, agent: next, ts });
  }
}
