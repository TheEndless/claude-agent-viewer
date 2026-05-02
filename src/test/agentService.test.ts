import { describe, it, expect } from 'vitest';
import { assignTaskDescriptionsForTesting, buildActivityHistoryForTesting, extractSessionMetaForTesting } from '../agentService';
import { Agent, RawEvent } from '../types';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeParent(sessionId: string, descs: string[]): Agent {
  return {
    sessionId,
    transcriptPath: `/home/.claude/projects/app/${sessionId}.jsonl`,
    cwd: '/app',
    projectName: 'app',
    state: 'running',
    activity: '',
    mtimeMs: 1000,
    details: { recentToolCalls: [], recentFiles: [], latestUserPrompt: 'do the thing', subagentCount: descs.length },
    subagents: [],
    agentCallDescs: descs,
  };
}

function makeSub(sessionId: string, mtimeMs = 500, prompt: string | null = null): Agent {
  return {
    sessionId,
    transcriptPath: `/home/.claude/projects/app/parent1/subagents/${sessionId}.jsonl`,
    cwd: '/app',
    projectName: 'app',
    state: 'running',
    activity: '',
    mtimeMs,
    details: { recentToolCalls: [], recentFiles: [], latestUserPrompt: prompt, subagentCount: 0 },
    subagents: [],
  };
}

describe('assignTaskDescriptionsForTesting', () => {
  it('assigns descriptions from agentCallDescs in chronological (mtimeMs asc) order', () => {
    const parent = makeParent('parent1', ['Task A', 'Task B']);
    const sub1 = makeSub('sub1', 100);
    const sub2 = makeSub('sub2', 200);
    parent.subagents = [sub2, sub1]; // intentionally out of order to test sort
    const agents = new Map([['parent1', parent], ['sub1', sub1], ['sub2', sub2]]);
    assignTaskDescriptionsForTesting(agents);
    expect(sub1.taskDescription).toBe('Task A'); // earlier mtime → first description
    expect(sub2.taskDescription).toBe('Task B');
  });

  it('falls back to latestUserPrompt when agentCallDescs is empty', () => {
    const parent = makeParent('parent1', []);
    const sub = makeSub('sub1', 100, 'user prompt fallback');
    parent.subagents = [sub];
    const agents = new Map([['parent1', parent], ['sub1', sub]]);
    assignTaskDescriptionsForTesting(agents);
    expect(sub.taskDescription).toBe('user prompt fallback');
  });

  it('falls back to 8-char sessionId slice when no description or prompt', () => {
    const parent = makeParent('parent1', []);
    const sub = makeSub('abcdef12345', 100, null);
    parent.subagents = [sub];
    const agents = new Map([['parent1', parent], ['abcdef12345', sub]]);
    assignTaskDescriptionsForTesting(agents);
    expect(sub.taskDescription).toBe('abcdef12');
  });

  it('does nothing for parents with no subagents', () => {
    const parent = makeParent('parent1', ['desc']);
    parent.subagents = [];
    const agents = new Map([['parent1', parent]]);
    assignTaskDescriptionsForTesting(agents);
    expect(parent.taskDescription).toBeUndefined();
  });
});

// ── buildActivityHistory ──────────────────────────────────────────────────────

describe('buildActivityHistoryForTesting', () => {
  it('returns last 3 meaningful events newest-first', () => {
    const events: RawEvent[] = [
      bashEvent('echo 1', '2024-01-01T00:00:00.000Z'),
      bashEvent('echo 2', '2024-01-01T00:01:00.000Z'),
      bashEvent('echo 3', '2024-01-01T00:02:00.000Z'),
      bashEvent('echo 4', '2024-01-01T00:03:00.000Z'),
    ];
    const result = buildActivityHistoryForTesting(events, 'running');
    expect(result).toHaveLength(3);
    expect(result[0].summary).toBe('Bash: echo 4');
    expect(result[1].summary).toBe('Bash: echo 3');
    expect(result[2].summary).toBe('Bash: echo 2');
  });

  it('includes non-tool events like Thinking', () => {
    const events: RawEvent[] = [
      bashEvent('npm test', '2024-01-01T00:00:00.000Z'),
      thinkingEvent('2024-01-01T00:01:00.000Z'),
    ];
    const result = buildActivityHistoryForTesting(events, 'running');
    expect(result[0].summary).toBe('Thinking');
    expect(result[1].summary).toBe('Bash: npm test');
  });

  it('returns ["Session ended"] for done state regardless of events', () => {
    const result = buildActivityHistoryForTesting([bashEvent('echo hi')], 'done');
    expect(result).toEqual([{ summary: 'Session ended', at: 0 }]);
  });

  it('returns fallback when no meaningful events', () => {
    const result = buildActivityHistoryForTesting([], 'running');
    expect(result).toHaveLength(1);
    expect(result[0].summary).toBe('Working…');
  });

  it('returns ["Idle"] fallback for idle state with no events', () => {
    const result = buildActivityHistoryForTesting([], 'idle');
    expect(result[0].summary).toBe('Idle');
  });

  it('preserves timestamps from event', () => {
    const events: RawEvent[] = [bashEvent('ls', '2024-06-15T12:30:00.000Z')];
    const result = buildActivityHistoryForTesting(events, 'running');
    expect(result[0].at).toBe(Date.parse('2024-06-15T12:30:00.000Z'));
  });
});

// ── extractSessionMeta ────────────────────────────────────────────────────────

function assistantEvent(model: string, inputTokens: number, timestamp = '2024-01-01T00:00:00.000Z'): RawEvent {
  return {
    type: 'assistant',
    timestamp,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'response' }],
      model: `claude-${model}`,
      usage: { input_tokens: inputTokens, output_tokens: 100 },
    },
  };
}

describe('extractSessionMetaForTesting', () => {
  it('strips claude- prefix from model name', () => {
    const { model } = extractSessionMetaForTesting([assistantEvent('sonnet-4-6', 10000)]);
    expect(model).toBe('sonnet-4-6');
  });

  it('counts assistant turns', () => {
    const events: RawEvent[] = [
      assistantEvent('sonnet-4-6', 5000),
      assistantEvent('sonnet-4-6', 10000),
      assistantEvent('sonnet-4-6', 15000),
    ];
    const { turnCount } = extractSessionMetaForTesting(events);
    expect(turnCount).toBe(3);
  });

  it('computes contextPct from last assistant input_tokens', () => {
    const events: RawEvent[] = [
      assistantEvent('sonnet-4-6', 50000),
      assistantEvent('sonnet-4-6', 100000),
    ];
    const { contextPct } = extractSessionMetaForTesting(events);
    expect(contextPct).toBe(50); // 100000 / 200000 * 100
  });

  it('returns zeros when no assistant events', () => {
    const { model, turnCount, contextPct } = extractSessionMetaForTesting([]);
    expect(model).toBe('');
    expect(turnCount).toBe(0);
    expect(contextPct).toBe(0);
  });

  it('uses the last model seen (latest turn wins)', () => {
    const events: RawEvent[] = [
      assistantEvent('haiku-4-5', 5000),
      assistantEvent('sonnet-4-6', 10000),
    ];
    const { model } = extractSessionMetaForTesting(events);
    expect(model).toBe('sonnet-4-6');
  });
});
