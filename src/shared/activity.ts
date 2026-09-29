// Tool call → activity (protocol.ts ActivityKind), and the timing rules that
// decide when an activity is visible. Shared by the live hub (which applies
// the rules with timers) and by replay/recording (which applies them to
// recorded timestamps), so both show the same thing.

import type { ActivityKind } from './protocol.js';

/** A command that has not returned after this long counts as "running". */
export const RUN_AFTER_MS = 1500;
/** Safety net: end a plan activity whose result never shows up. */
export const PLAN_TIMEOUT_MS = 3000;
/** Safety net for everything else (a crashed harness never sends results). */
export const MAX_ACTIVITY_MS = 10 * 60_000;

const PLAN = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'update_plan', 'EnterPlanMode', 'ExitPlanMode', 'write_todos']);
const WEB = new Set(['WebSearch', 'WebFetch', 'web_search', 'web_fetch', 'google_web_search']);
const RUN = new Set(['Bash', 'PowerShell', 'exec_command', 'shell', 'local_shell', 'unified_exec', 'run_shell_command']);
// Claude Code asks the user a question and blocks until they answer: the one
// reliable "waiting for the human" signal in a transcript.
const WAIT = new Set(['AskUserQuestion']);

/** Which away-from-desk activity a tool call is, if any. */
export function activityOf(tool: string | undefined): ActivityKind | null {
  if (!tool) return null;
  // MCP tools keep their bare name for matching (mcp__server__web_search).
  const bare = tool.replace(/^mcp__.+?__/, '');
  if (PLAN.has(bare)) return 'plan';
  if (WEB.has(bare)) return 'web';
  if (RUN.has(bare)) return 'run';
  if (WAIT.has(bare)) return 'wait';
  return null;
}

export interface ActivityWindow {
  activity: ActivityKind;
  start: number;
  end: number;
  ok?: boolean;
}

/**
 * The visible window of one finished (or unfinished) tool call, in epoch ms,
 * or null if it is never shown. Same rules as the hub's live timers: 'run'
 * only appears once the call has been out for RUN_AFTER_MS.
 */
export function activityWindow(tool: string | undefined, start: number, end: number | undefined, ok = true): ActivityWindow | null {
  const activity = activityOf(tool);
  if (!activity || !Number.isFinite(start)) return null;
  if (activity === 'run') {
    if (end === undefined || end - start < RUN_AFTER_MS) return null;
    return { activity, start: start + RUN_AFTER_MS, end, ok };
  }
  return { activity, start, end: end ?? start + PLAN_TIMEOUT_MS };
}
