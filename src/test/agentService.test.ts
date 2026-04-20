import { describe, it, expect } from 'vitest';
import { assignTaskDescriptionsForTesting } from '../agentService';
import { Agent } from '../types';

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
