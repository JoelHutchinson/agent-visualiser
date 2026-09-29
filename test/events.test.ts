import { describe, expect, it } from 'vitest';
import { classifyTool, lineToEvent } from '../src/shared/events.js';

describe('classifyTool', () => {
  it.each([
    // Spec table (Claude Code)
    ['Read', 'research'], ['Grep', 'research'], ['Glob', 'research'], ['WebSearch', 'research'], ['WebFetch', 'research'],
    ['Edit', 'code'], ['Write', 'code'], ['MultiEdit', 'code'], ['Bash', 'code'], ['PowerShell', 'code'],
    // Codex
    ['exec_command', 'code'], ['shell', 'code'], ['apply_patch', 'code'], ['read_file', 'research'], ['web_search', 'research'],
    // Gemini CLI
    ['run_shell_command', 'code'], ['write_file', 'code'], ['replace', 'code'], ['search_file_content', 'research'],
    ['google_web_search', 'research'], ['list_directory', 'research'],
    // MCP and generic verbs
    ['mcp__github__search_code', 'research'], ['mcp__github__create_issue', 'code'], ['github/get_issue', 'research'],
  ] as const)('%s → %s', (name, type) => expect(classifyTool(name)).toBe(type));

  it.each(['TodoWrite', 'ToolSearch', 'Task', 'Agent', 'update_plan', 'mcp__browser__navigate', 'toString', '', undefined])(
    'ignores %s',
    (name) => expect(classifyTool(name as string)).toBeNull(),
  );
});

const line = (o: object) => JSON.stringify(o);
const base = { sessionId: 's1', timestamp: '2026-09-29T10:00:00.000Z' };

describe('Claude Code transcript lines', () => {
  it('maps tool_use to research/code with the call id', () => {
    const ev = lineToEvent(
      line({ ...base, type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Edit', input: { secret: 'x' } }] } }),
    );
    expect(ev).toEqual({ type: 'code', tool: 'Edit', sessionId: 's1', ts: base.timestamp, harness: 'claude-code', callId: 'toolu_1' });
    expect(JSON.stringify(ev)).not.toContain('secret');
  });

  it('maps an error tool_result to bug', () => {
    const ev = lineToEvent(line({ ...base, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: 'boom' }] } }));
    expect(ev).toMatchObject({ type: 'bug', callId: 'toolu_1' });
  });

  it('maps end_turn to idle', () => {
    expect(lineToEvent(line({ ...base, type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } }))).toMatchObject({ type: 'idle' });
  });

  it('ignores successes, sidechains, unknown tools and junk', () => {
    expect(lineToEvent(line({ ...base, type: 'user', message: { content: [{ type: 'tool_result', is_error: false }] } }))).toBeNull();
    expect(lineToEvent(line({ ...base, isSidechain: true, type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } }))).toBeNull();
    expect(lineToEvent(line({ ...base, type: 'assistant', message: { content: [{ type: 'tool_use', name: 'TodoWrite' }] } }))).toBeNull();
    expect(lineToEvent('{"truncated": ')).toBeNull();
    expect(lineToEvent('')).toBeNull();
    expect(lineToEvent('[1,2]')).toBeNull();
  });
});
