import { describe, it, expect } from 'vitest';
import { parseTranscript } from '../transcriptParser';

// Helper: build a minimal JSONL line
function line(obj: object): string {
  return JSON.stringify(obj);
}

const TS = '2026-04-18T10:00:00.000Z';

describe('parseTranscript', () => {
  it('returns empty array for empty input', () => {
    expect(parseTranscript('')).toEqual([]);
  });

  it('skips malformed lines silently', () => {
    const jsonl = 'not json\n' + line({ type: 'user', timestamp: TS, message: { role: 'user', content: 'hello' } });
    const turns = parseTranscript(jsonl);
    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe('hello');
  });

  it('parses a plain user text message', () => {
    const jsonl = line({ type: 'user', timestamp: TS, message: { role: 'user', content: 'hello world' } });
    const turns = parseTranscript(jsonl);
    expect(turns).toHaveLength(1);
    expect(turns[0].role).toBe('user');
    expect(turns[0].text).toBe('hello world');
    expect(turns[0].attachments).toEqual([]);
    expect(turns[0].entries).toEqual([]);
    expect(turns[0].timestamp).toBe(TS);
  });

  it('parses user message with array content (text block)', () => {
    const jsonl = line({
      type: 'user', timestamp: TS,
      message: { role: 'user', content: [{ type: 'text', text: 'array text' }] }
    });
    const turns = parseTranscript(jsonl);
    expect(turns[0].text).toBe('array text');
  });

  it('parses image attachment in user message', () => {
    const jsonl = line({
      type: 'user', timestamp: TS,
      message: {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } }
        ]
      }
    });
    const turns = parseTranscript(jsonl);
    expect(turns[0].attachments).toHaveLength(1);
    expect(turns[0].attachments[0]).toEqual({ type: 'image', mediaType: 'image/png', data: 'abc123' });
    expect(turns[0].text).toBeUndefined();
  });

  it('parses document attachment in user message', () => {
    const jsonl = line({
      type: 'user', timestamp: TS,
      message: {
        role: 'user',
        content: [
          { type: 'document', title: 'notes.md', source: { type: 'text', data: '# Hello' } }
        ]
      }
    });
    const turns = parseTranscript(jsonl);
    expect(turns[0].attachments[0]).toEqual({ type: 'document', name: 'notes.md', data: '# Hello' });
  });

  it('parses assistant text message', () => {
    const jsonl = line({ type: 'assistant', timestamp: TS, message: { role: 'assistant', content: [{ type: 'text', text: 'I can help.' }] } });
    const turns = parseTranscript(jsonl);
    expect(turns[0].role).toBe('assistant');
    expect(turns[0].text).toBe('I can help.');
  });

  it('parses thinking block as TurnEntry', () => {
    const jsonl = line({
      type: 'assistant', timestamp: TS,
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm...' }] }
    });
    const turns = parseTranscript(jsonl);
    expect(turns[0].entries).toHaveLength(1);
    expect(turns[0].entries[0]).toMatchObject({ kind: 'thinking', label: 'Thinking', body: 'hmm...' });
  });

  it('parses tool_use block as TurnEntry', () => {
    const jsonl = line({
      type: 'assistant', timestamp: TS,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls -la' } }] }
    });
    const turns = parseTranscript(jsonl);
    expect(turns[0].entries[0]).toMatchObject({ kind: 'tool_use', label: 'Bash · ls -la' });
    expect(JSON.parse(turns[0].entries[0].body)).toEqual({ command: 'ls -la' });
  });

  it('pairs tool_result onto its tool_use entry (not a new user turn)', () => {
    const jsonl = [
      line({ type: 'assistant', timestamp: TS, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } }] } }),
      line({ type: 'user', timestamp: TS, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file.txt\n' }] } }),
    ].join('\n');
    const turns = parseTranscript(jsonl);
    expect(turns).toHaveLength(1);                     // only the assistant turn
    expect(turns[0].entries).toHaveLength(1);          // tool_use only (result stored on entry.result)
    const toolEntry = turns[0].entries[0];
    expect(toolEntry.kind).toBe('tool_use');
    expect(toolEntry.result).toBeDefined();
    expect(toolEntry.result!.kind).toBe('tool_result');
    expect(toolEntry.result!.label).toBe('Result · Bash');
    expect(toolEntry.result!.body).toBe('file.txt\n');
  });

  it('mixed user message with text and tool_result becomes a user turn', () => {
    const jsonl = line({
      type: 'user', timestamp: TS,
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'here you go' },
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }
        ]
      }
    });
    const turns = parseTranscript(jsonl);
    expect(turns).toHaveLength(1);
    expect(turns[0].role).toBe('user');
    expect(turns[0].text).toBe('here you go');
  });

  it('parses summary event as system entry on preceding assistant turn', () => {
    const summaryEvt = { type: 'result', timestamp: TS, subtype: 'success', costUSD: 0.1, durationMs: 1000 };
    const jsonl = [
      line({ type: 'assistant', timestamp: TS, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }),
      line(summaryEvt),
    ].join('\n');
    const turns = parseTranscript(jsonl);
    expect(turns).toHaveLength(1);
    expect(turns[0].entries[0]).toMatchObject({ kind: 'system', label: 'Session ended' });
    expect(JSON.parse(turns[0].entries[0].body)).toMatchObject({ type: 'result' });
  });

  it('creates synthetic assistant turn for summary with no preceding turn', () => {
    const jsonl = line({ type: 'result', timestamp: TS, subtype: 'success' });
    const turns = parseTranscript(jsonl);
    expect(turns).toHaveLength(1);
    expect(turns[0].role).toBe('assistant');
    expect(turns[0].entries[0].kind).toBe('system');
  });

  it('labels tool_use entries for common tools', () => {
    const cases: Array<[string, object, string]> = [
      ['Bash',           { command: 'npm test' },                          'Bash · npm test'],
      ['Read',           { file_path: '/src/foo.ts' },                     'Read · foo.ts'],
      ['Edit',           { file_path: '/src/bar.ts' },                     'Edit · bar.ts'],
      ['MultiEdit',      { file_path: '/src/multi.ts' },                   'MultiEdit · multi.ts'],
      ['Write',          { file_path: '/src/baz.ts' },                     'Write · baz.ts'],
      ['NotebookEdit',   { notebook_path: '/nb/run.ipynb' },               'NotebookEdit · run.ipynb'],
      ['Grep',           { pattern: 'TODO' },                              'Grep · TODO'],
      ['Glob',           { pattern: '**/*.ts' },                           'Glob · **/*.ts'],
      ['Agent',          { description: 'explore codebase' },              'Subagent · explore codebase'],
      ['Task',           { description: 'do the thing' },                  'Subagent · do the thing'],
      ['Skill',          { skill: 'writing-plans' },                       'Skill · writing-plans'],
      ['ToolSearch',     { query: 'select:Read' },                         'ToolSearch · select:Read'],
      ['WebFetch',       { url: 'https://example.com' },                   'WebFetch · https://example.com'],
      ['WebSearch',      { query: 'rust traits' },                         'WebSearch · rust traits'],
      ['AskUserQuestion',{ question: 'Which base branch?' },               'AskUserQuestion · Which base branch?'],
      ['ExitPlanMode',   {},                                               'ExitPlanMode'],
      ['mcp__slack__send_message',    { channel: 'x' },                    'MCP · slack · send_message'],
      ['mcp__github',                 {},                                  'MCP · github'],
      ['Unknown',        {},                                               'Unknown'],
    ];
    for (const [name, input, expectedLabel] of cases) {
      const jsonl = line({ type: 'assistant', timestamp: TS, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name, input }] } });
      const turns = parseTranscript(jsonl);
      expect(turns[0].entries[0].label).toBe(expectedLabel);
    }
  });

  it('flags is_error on tool_result', () => {
    const jsonl = [
      line({ type: 'assistant', timestamp: TS, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_e', name: 'Bash', input: { command: 'false' } }] } }),
      line({ type: 'user', timestamp: TS, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_e', content: 'boom', is_error: true }] } }),
    ].join('\n');
    const turns = parseTranscript(jsonl);
    expect(turns[0].entries[0].result?.isError).toBe(true);
  });

  it('parses compact_boundary system event as "Context compacted"', () => {
    const jsonl = [
      line({ type: 'assistant', timestamp: TS, message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }),
      line({ type: 'system', subtype: 'compact_boundary', timestamp: TS, compactMetadata: { trigger: 'auto' } }),
    ].join('\n');
    const turns = parseTranscript(jsonl);
    expect(turns[0].entries[0].kind).toBe('system');
    expect(turns[0].entries[0].label).toBe('Context compacted');
  });

  it('parses api_error system event with isError=true', () => {
    const jsonl = [
      line({ type: 'assistant', timestamp: TS, message: { role: 'assistant', content: [{ type: 'text', text: 'before' }] } }),
      line({ type: 'system', subtype: 'api_error', timestamp: TS, error: 'overloaded' }),
    ].join('\n');
    const turns = parseTranscript(jsonl);
    expect(turns[0].entries[0]).toMatchObject({ kind: 'system', label: 'API error', isError: true });
    expect(turns[0].entries[0].body).toBe('overloaded');
  });

  it('parses hook_non_blocking_error attachment as error entry', () => {
    const jsonl = [
      line({ type: 'assistant', timestamp: TS, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }),
      line({ type: 'attachment', timestamp: TS, attachment: { type: 'hook_non_blocking_error', hookEvent: 'PostToolUse', error: 'hook crashed' } }),
    ].join('\n');
    const turns = parseTranscript(jsonl);
    expect(turns[0].entries[0]).toMatchObject({ kind: 'system', label: 'Hook error · PostToolUse', isError: true });
    expect(turns[0].entries[0].body).toBe('hook crashed');
  });

  it('marks isCompactSummary user turn with system entry', () => {
    const jsonl = line({
      type: 'user', timestamp: TS, isCompactSummary: true,
      message: { role: 'user', content: 'Summary text here' }
    });
    const turns = parseTranscript(jsonl);
    expect(turns[0].role).toBe('user');
    expect(turns[0].entries[0]).toMatchObject({ kind: 'system', label: 'Compacted summary' });
    expect(turns[0].text).toBe('Summary text here');
  });

  it('extracts text from array tool_result content with image blocks', () => {
    const jsonl = [
      line({ type: 'assistant', timestamp: TS, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_m', name: 'Bash', input: { command: 'x' } }] } }),
      line({ type: 'user', timestamp: TS, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_m', content: [
        { type: 'text', text: 'screenshot:' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '...' } },
      ] }] } }),
    ].join('\n');
    const turns = parseTranscript(jsonl);
    const body = turns[0].entries[0].result!.body;
    expect(body).toContain('screenshot:');
    expect(body).toContain('[image · image/png]');
  });
});
