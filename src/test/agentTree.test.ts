import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { Agent } from '../types';

import { buildTreeForTesting } from '../agentTree';

function makeAgent(transcriptPath: string): Agent {
  return {
    sessionId: path.basename(transcriptPath, '.jsonl'),
    transcriptPath,
    cwd: '/tmp',
    projectName: 'test',
    state: 'done',
    activity: '',
    mtimeMs: 0,
    details: { recentToolCalls: [], recentFiles: [], latestUserPrompt: null, subagentCount: 0 },
    subagents: [],
  };
}

describe('buildTreeForTesting', () => {
  it('leaves top-level agents unchanged', () => {
    const agents = new Map<string, Agent>();
    const a = makeAgent('/home/user/.claude/projects/myapp/abc123.jsonl');
    agents.set('abc123', a);
    buildTreeForTesting(agents);
    expect(a.parentSessionId).toBeUndefined();
    expect(a.subagents).toHaveLength(0);
  });

  it('detects subagent by path and wires up parent', () => {
    const agents = new Map<string, Agent>();
    const parent = makeAgent('/home/user/.claude/projects/myapp/abc123.jsonl');
    const child = makeAgent('/home/user/.claude/projects/myapp/abc123/subagents/def456.jsonl');
    agents.set('abc123', parent);
    agents.set('def456', child);
    buildTreeForTesting(agents);
    expect(child.parentSessionId).toBe('abc123');
    expect(parent.subagents).toContain(child);
  });

  it('orphan subagent (no matching parent) stays at top level with no parentSessionId', () => {
    const agents = new Map<string, Agent>();
    const child = makeAgent('/home/user/.claude/projects/myapp/abc123/subagents/def456.jsonl');
    agents.set('def456', child);
    buildTreeForTesting(agents);
    expect(child.parentSessionId).toBeUndefined();
  });

  it('resets subagents arrays on each call', () => {
    const agents = new Map<string, Agent>();
    const parent = makeAgent('/home/user/.claude/projects/myapp/abc123.jsonl');
    const child = makeAgent('/home/user/.claude/projects/myapp/abc123/subagents/def456.jsonl');
    agents.set('abc123', parent);
    agents.set('def456', child);
    buildTreeForTesting(agents);
    buildTreeForTesting(agents); // second call should not double-add
    expect(parent.subagents).toHaveLength(1);
  });
});
