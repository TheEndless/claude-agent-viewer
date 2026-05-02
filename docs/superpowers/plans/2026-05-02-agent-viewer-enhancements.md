# Agent Viewer Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add activity timeline, context meta-bar, project grouping, DOM-diff render stability, subagent status accuracy, filter bar, and transcript panel tools (copy/search/jump/export) to the Agent Viewer VS Code extension.

**Architecture:** `agentService.ts` is extended to emit `activityHistory[]` and session meta (model, turnCount, contextPct) alongside existing agent data. `webviewProvider.ts`'s render loop is replaced with incremental DOM diffing keyed by sessionId, restructured around project groups. `transcriptPanel.ts` gains a toolbar and per-turn copy buttons.

**Tech Stack:** TypeScript, VS Code Webview API, chokidar, vitest (tests run with `npm test`)

---

## File Map

| File | Change |
|------|--------|
| `src/types.ts` | Replace `activity: string` with `activityHistory: ToolCallSummary[]` on `Agent`; extend `RawEvent.message` with `model` and `usage` |
| `src/agentService.ts` | Add `buildActivityHistory()`, `extractSessionMeta()`; wire into `buildAgent()`; export testing helpers |
| `src/webviewProvider.ts` | Replace flat render + archive with project-grouped DOM-diff render; add timeline, meta-bar, subagent dots, filter bar |
| `src/transcriptPanel.ts` | Add toolbar (search, jump, export); per-turn copy button; `exportMarkdown` message handler |
| `src/test/agentService.test.ts` | Update fixtures (remove `activity` field); add tests for new helpers |

---

## Task 1: Update types

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Replace `activity` with `activityHistory` and extend `RawEvent.message`**

Replace the entire file content:

```typescript
export type AgentState = 'running' | 'idle' | 'done';

export interface ToolCallSummary {
  summary: string;
  at: number; // Unix ms timestamp; 0 when unknown
}

export interface AgentDetails {
  recentToolCalls: ToolCallSummary[];
  recentFiles: string[];
  latestUserPrompt: string | null;
  lastPrompt: string | null;
  customTitle: string | null;
  aiTitle: string | null;
  subagentCount: number;
}

export interface Agent {
  sessionId: string;
  transcriptPath: string;
  cwd: string;
  projectName: string;
  state: AgentState;
  activityHistory: ToolCallSummary[]; // last ≤3 meaningful events, newest first
  model: string;        // short model name, e.g. "sonnet-4-6"; empty string if unknown
  turnCount: number;    // assistant turns seen in the tail (approximation for long sessions)
  contextPct: number;   // input_tokens / 200000 * 100; 0 if unknown
  mtimeMs: number;
  pid?: number;
  details: AgentDetails;
  parentSessionId?: string;
  subagents: Agent[];
  taskDescription?: string;
  agentCallDescs?: string[];
}

export interface RawEvent {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  message?: {
    role?: string;
    content?: unknown;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  [key: string]: unknown;
}

// ── Transcript preview model ──────────────────────────────────────

export interface TurnAttachment {
  type: 'image' | 'document';
  name?: string;
  mediaType?: string;
  data?: string;
}

export interface TurnEntry {
  kind: 'tool_use' | 'tool_result' | 'thinking' | 'system';
  label: string;
  timestamp: string;
  body: string;
  rawJson?: string;
  result?: TurnEntry;
  isError?: boolean;
}

export interface Turn {
  role: 'user' | 'assistant';
  timestamp: string;
  text?: string;
  attachments: TurnAttachment[];
  entries: TurnEntry[];
  model?: string;
  index?: number;
  rawJson?: string;
}
```

- [ ] **Step 2: Verify TypeScript compiles (will fail until agentService is updated — that's expected)**

```bash
npm run lint 2>&1 | head -30
```

Expected: errors about `activity` and missing fields in `buildAgent`. That's fine — proceed to Task 2.

---

## Task 2: agentService — buildActivityHistory

**Files:**
- Modify: `src/agentService.ts`
- Modify: `src/test/agentService.test.ts`

- [ ] **Step 1: Add `buildActivityHistory` function to agentService.ts**

Add this function after the existing `deriveActivity` function (around line 385):

```typescript
/**
 * Collects the last ≤3 meaningful events from tail events as an activity history,
 * newest first. Uses the same event-labelling logic as deriveActivity.
 */
function buildActivityHistory(events: RawEvent[], state: AgentState): ToolCallSummary[] {
  if (state === 'done') return [{ summary: 'Session ended', at: 0 }];
  const history: ToolCallSummary[] = [];
  for (let i = events.length - 1; i >= 0 && history.length < 3; i--) {
    const evt = events[i];
    if (isNoise(evt)) continue;
    const label = labelFromEvent(evt);
    if (!label) continue;
    const ts = typeof evt.timestamp === 'string' ? Date.parse(evt.timestamp) || 0 : 0;
    history.push({ summary: label, at: ts });
  }
  if (history.length === 0) {
    history.push({ summary: state === 'running' ? 'Working…' : 'Idle', at: 0 });
  }
  return history;
}

/** Exported only for unit testing. */
export const buildActivityHistoryForTesting = buildActivityHistory;
```

- [ ] **Step 2: Write failing tests**

Replace the contents of `src/test/agentService.test.ts` with:

```typescript
import { describe, it, expect } from 'vitest';
import { assignTaskDescriptionsForTesting, buildActivityHistoryForTesting } from '../agentService';
import { Agent, RawEvent } from '../types';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeParent(sessionId: string, descs: string[]): Agent {
  return {
    sessionId,
    transcriptPath: `/home/.claude/projects/app/${sessionId}.jsonl`,
    cwd: '/app',
    projectName: 'app',
    state: 'running',
    activityHistory: [],
    model: '',
    turnCount: 0,
    contextPct: 0,
    mtimeMs: 1000,
    details: { recentToolCalls: [], recentFiles: [], latestUserPrompt: 'do the thing', lastPrompt: null, customTitle: null, aiTitle: null, subagentCount: descs.length },
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
    activityHistory: [],
    model: '',
    turnCount: 0,
    contextPct: 0,
    mtimeMs,
    details: { recentToolCalls: [], recentFiles: [], latestUserPrompt: prompt, lastPrompt: null, customTitle: null, aiTitle: null, subagentCount: 0 },
    subagents: [],
  };
}

function bashEvent(command: string, timestamp = '2024-01-01T00:00:00.000Z'): RawEvent {
  return {
    type: 'assistant',
    timestamp,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', name: 'Bash', input: { command } }],
    },
  };
}

function thinkingEvent(timestamp = '2024-01-01T00:01:00.000Z'): RawEvent {
  return {
    type: 'assistant',
    timestamp,
    message: { role: 'assistant', content: [{ type: 'text', text: 'thinking...' }] },
  };
}

function summaryEvent(): RawEvent {
  return { type: 'summary' };
}

// ── assignTaskDescriptions ────────────────────────────────────────────────────

describe('assignTaskDescriptionsForTesting', () => {
  it('assigns descriptions from agentCallDescs in chronological (mtimeMs asc) order', () => {
    const parent = makeParent('parent1', ['Task A', 'Task B']);
    const sub1 = makeSub('sub1', 100);
    const sub2 = makeSub('sub2', 200);
    parent.subagents = [sub2, sub1];
    const agents = new Map([['parent1', parent], ['sub1', sub1], ['sub2', sub2]]);
    assignTaskDescriptionsForTesting(agents);
    expect(sub1.taskDescription).toBe('Task A');
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
```

- [ ] **Step 3: Run tests — expect failures (buildActivityHistoryForTesting not exported yet)**

```bash
npm test 2>&1 | tail -20
```

Expected: `buildActivityHistoryForTesting` import error.

- [ ] **Step 4: Run tests — verify they pass now that the export exists**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/agentService.ts src/test/agentService.test.ts
git commit -m "feat(agentService): add buildActivityHistory with 3-entry history"
```

---

## Task 3: agentService — extractSessionMeta

**Files:**
- Modify: `src/agentService.ts`
- Modify: `src/test/agentService.test.ts`

- [ ] **Step 1: Add `extractSessionMeta` to agentService.ts**

Add after `buildActivityHistory` (around line 410):

```typescript
/** Context window size for all current Claude models (200k tokens). */
const CONTEXT_WINDOW = 200_000;

interface SessionMeta {
  model: string;
  turnCount: number;
  contextPct: number;
}

/**
 * Extracts model name, turn count, and context window usage from tail events.
 * All three values are approximations for long sessions where the tail doesn't
 * include all turns.
 */
function extractSessionMeta(events: RawEvent[]): SessionMeta {
  let model = '';
  let turnCount = 0;
  let lastInputTokens = 0;

  for (const evt of events) {
    if (evt.type !== 'assistant') continue;
    turnCount++;
    const msg = evt.message;
    if (!msg) continue;
    if (typeof msg.model === 'string' && msg.model) {
      // Strip "claude-" prefix for compact display, e.g. "claude-sonnet-4-6" → "sonnet-4-6"
      model = msg.model.replace(/^claude-/, '');
    }
    if (typeof msg.usage?.input_tokens === 'number') {
      lastInputTokens = msg.usage.input_tokens;
    }
  }

  const contextPct = lastInputTokens > 0
    ? Math.round((lastInputTokens / CONTEXT_WINDOW) * 100)
    : 0;

  return { model, turnCount, contextPct };
}

/** Exported only for unit testing. */
export const extractSessionMetaForTesting = extractSessionMeta;
```

- [ ] **Step 2: Add tests for `extractSessionMeta` to `src/test/agentService.test.ts`**

First, add `extractSessionMetaForTesting` to the existing import at the top of the file (Task 2 already updated this import to include `buildActivityHistoryForTesting`):

```typescript
import { assignTaskDescriptionsForTesting, buildActivityHistoryForTesting, extractSessionMetaForTesting } from '../agentService';
```

Then append the following test suite to the bottom of the file:

```typescript
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
```

- [ ] **Step 3: Run tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/agentService.ts src/test/agentService.test.ts
git commit -m "feat(agentService): add extractSessionMeta for model/turnCount/contextPct"
```

---

## Task 4: Wire new fields into buildAgent and postAgents

**Files:**
- Modify: `src/agentService.ts`

- [ ] **Step 1: Update `buildAgent` to use new functions**

Find `buildAgent` (around line 269) and update it to replace `activity` with `activityHistory`, `model`, `turnCount`, and `contextPct`:

```typescript
function buildAgent(filePath: string, mtimeMs: number, events: RawEvent[], titles: TitleCache): Agent {
  const sessionId = sessionIdFromPath(filePath);
  const cwd = resolveCwd(filePath, events);
  const projectName = path.basename(cwd);
  const terminated = events.some(isTerminator);
  const state = classifyState(mtimeMs, Date.now(), terminated);
  const activityHistory = buildActivityHistory(events, state);
  const { model, turnCount, contextPct } = extractSessionMeta(events);
  const { details, agentCallDescs } = extractDetails(events);
  details.customTitle = titles.customTitle ?? details.customTitle;
  details.aiTitle = titles.aiTitle ?? details.aiTitle;
  details.lastPrompt = titles.lastPrompt ?? details.lastPrompt;
  details.latestUserPrompt = details.latestUserPrompt ?? titles.firstUserPrompt;
  const parentSessionId = parentSessionIdFromPath(filePath);
  return {
    sessionId, transcriptPath: filePath, parentSessionId, cwd, projectName,
    state, activityHistory, model, turnCount, contextPct,
    mtimeMs, details, subagents: [], agentCallDescs,
  };
}
```

- [ ] **Step 2: Update `postAgents` serialization in `webviewProvider.ts`**

Find `serialize` in `postAgents()` (around line 72) and add the new fields:

```typescript
const serialize = (a: Agent): object => ({
  sessionId: a.sessionId,
  projectName: a.projectName,
  cwd: a.cwd,
  state: a.state,
  activityHistory: a.activityHistory,
  model: a.model,
  turnCount: a.turnCount,
  contextPct: a.contextPct,
  mtimeMs: a.mtimeMs,
  details: a.details,
  parentSessionId: a.parentSessionId,
  taskDescription: a.taskDescription,
  subagents: a.subagents.map(serialize),
});
```

- [ ] **Step 3: Run tests and lint**

```bash
npm test && npm run lint
```

Expected: all tests pass, no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add src/agentService.ts src/webviewProvider.ts
git commit -m "feat: wire activityHistory and session meta into agent data pipeline"
```

---

## Task 5: Webview — project grouping + DOM-diff render loop

**Files:**
- Modify: `src/webviewProvider.ts`

This is the largest single task. It replaces the flat `innerHTML`-replace render with project-grouped incremental DOM diffing.

- [ ] **Step 1: Replace the CSS in `getHtml()` — add project group and meta-bar styles**

Find the `<style>` block inside `getHtml()` and append the following before the closing `</style>`:

```css
    /* ── project groups ── */
    .proj-group { margin-top: 4px; }
    .proj-header {
      display: flex; align-items: center; gap: 6px;
      height: 24px; padding: 0 8px;
      cursor: pointer; user-select: none;
      border-radius: 3px;
    }
    .proj-header:hover { background: rgba(128,128,128,0.05); }
    .proj-caret { font-size: 9px; opacity: 0.5; transition: transform 0.1s; flex-shrink: 0; }
    .proj-group.open .proj-caret { transform: rotate(90deg); }
    .proj-name { flex: 1; font-size: 11px; font-weight: 600; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .proj-badge {
      font-size: 9px; padding: 1px 5px; border-radius: 3px; flex-shrink: 0;
    }
    .proj-badge.running { background: rgba(63,185,80,.12); border: 1px solid rgba(63,185,80,.2); color: #3fb950; }
    .proj-badge.idle    { background: rgba(210,153,34,.1);  border: 1px solid rgba(210,153,34,.2); color: #d29922; }
    .proj-badge.done    { background: rgba(110,118,129,.1); border: 1px solid rgba(110,118,129,.2); color: #6e7681; }
    .proj-body { display: none; }
    .proj-group.open .proj-body { display: block; }
    .proj-group.inactive { opacity: 0.75; }

    /* ── filter bar ── */
    .filter-bar { padding: 5px 8px 4px; }
    .filter-input {
      width: 100%; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border);
      color: var(--vscode-input-foreground); border-radius: 4px; padding: 3px 8px;
      font-size: 11px; font-family: var(--vscode-font-family); outline: none;
    }
    .filter-input:focus { border-color: var(--vscode-focusBorder); }

    /* ── activity timeline ── */
    .activity-timeline { padding: 0 8px 6px 20px; display: flex; flex-direction: column; gap: 3px; }
    .act-row { display: flex; align-items: center; gap: 5px; font-size: 11px; }
    .act-pip { width: 3px; height: 3px; border-radius: 50%; flex-shrink: 0; }
    .act-row.act-current .act-pip   { background: var(--vscode-textLink-foreground, #4fc1ff); }
    .act-row.act-current .act-label { color: var(--vscode-textLink-foreground, #4fc1ff); }
    .act-row.act-prev1 { opacity: 0.55; }
    .act-row.act-prev2 { opacity: 0.32; }
    .act-row .act-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); }
    .act-row .act-time  { font-size: 10px; color: var(--vscode-disabledForeground); flex-shrink: 0; }
    .stuck-badge {
      margin: 0 8px 6px; padding: 2px 7px; border-radius: 3px; font-size: 10px;
    }
    .stuck-loop { background: rgba(120,53,15,.4); border: 1px solid rgba(120,53,15,.6); color: #fb923c; }
    .stuck-stall { background: rgba(55,48,163,.3); border: 1px solid rgba(55,48,163,.5); color: #a5b4fc; }

    /* ── meta-bar ── */
    .meta-bar { display: flex; align-items: center; gap: 6px; padding: 0 8px 5px 20px; font-size: 10px; color: var(--vscode-disabledForeground); }
    .model-chip {
      display: inline-flex; align-items: center;
      background: rgba(79,193,255,.08); border: 1px solid rgba(79,193,255,.15);
      border-radius: 3px; padding: 0 5px; height: 14px; font-size: 9px;
      color: var(--vscode-textLink-foreground, #4fc1ff); white-space: nowrap; flex-shrink: 0;
    }
    .meta-sep { color: var(--vscode-input-border); flex-shrink: 0; }
    .ctx-wrap { display: flex; align-items: center; gap: 4px; }
    .ctx-bar-bg { width: 40px; height: 3px; border-radius: 2px; background: rgba(128,128,128,.2); overflow: hidden; }
    .ctx-bar-fill { height: 100%; border-radius: 2px; background: var(--vscode-textLink-foreground, #4fc1ff); opacity: .65; transition: width 0.3s; }
    .ctx-pct { font-size: 9px; }

    /* ── subagent state dots ── */
    .sub-state-dots { display: flex; gap: 3px; margin-left: 3px; }
    .ssd { width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0; }
    .ssd.running { background: #3fb950; box-shadow: 0 0 3px rgba(63,185,80,.5); }
    .ssd.idle    { background: #d29922; }
    .ssd.done    { background: #6e7681; }
```

- [ ] **Step 2: Add the filter bar HTML just before `<div id="root">`**

Find `<div id="root"` in `getHtml()` and replace that line with:

```html
  <div class="filter-bar"><input class="filter-input" id="filter-input" placeholder="Filter agents…" /></div>
  <div id="root" class="empty-global">Loading agents…</div>
```

- [ ] **Step 3: Replace the entire `<script>` block in `getHtml()` with the new JS**

Find the opening `<script>` tag and replace everything from `<script>` to `</script>` with the following. (The existing JS is entirely replaced — do not merge.)

```html
  <script>
    const vscode = acquireVsCodeApi();
    const root = document.getElementById('root');
    const filterInput = document.getElementById('filter-input');

    // Preserved expand state. Keys: 'proj:<projectKey>', 'proj:<projectKey>:subs:<sessionId>'
    const openSections = {};

    // DOM element caches keyed by projectKey / sessionId
    const projGroupEls = new Map();
    const cardEls = new Map();

    function esc(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function relTimeShort(ms, now) {
      if (!ms) return '';
      const d = now - ms;
      if (d < 10000) return 'now';
      if (d < 60000) return Math.floor(d/1000)+'s';
      if (d < 3600000) return Math.floor(d/60000)+'m';
      if (d < 86400000) return Math.floor(d/3600000)+'h';
      return Math.floor(d/86400000)+'d';
    }

    function parentEffectiveState(p) {
      const subs = p.subagents||[];
      if (p.state==='running'||subs.some(s=>s.state==='running')) return 'running';
      if (p.state==='idle'   ||subs.some(s=>s.state==='idle'))    return 'idle';
      return 'done';
    }

    function parentMaxMtime(p) {
      return (p.subagents||[]).reduce((m,s)=>Math.max(m,s.mtimeMs),p.mtimeMs);
    }

    // ── project grouping ──────────────────────────────────────────

    function projectKey(cwd) {
      const parts = cwd.replace(/\\/g,'/').split('/').filter(Boolean);
      return parts.slice(-2).join('/') || cwd;
    }

    function projectLabel(cwd) {
      const parts = cwd.replace(/\\/g,'/').split('/').filter(Boolean);
      if (parts.length >= 2) return parts.slice(-2).join(' / ');
      return parts[parts.length-1] || cwd;
    }

    function groupByProject(parents) {
      const map = new Map();
      for (const p of parents) {
        const key = projectKey(p.cwd);
        if (!map.has(key)) map.set(key, { key, label: projectLabel(p.cwd), agents: [] });
        map.get(key).agents.push(p);
      }
      return map;
    }

    function groupBadge(agents) {
      const running = agents.filter(a => parentEffectiveState(a)==='running').length;
      const idle    = agents.filter(a => parentEffectiveState(a)==='idle').length;
      if (running) return { cls:'running', text: running+' running' };
      if (idle)    return { cls:'idle',    text: idle+' idle' };
      return { cls:'done', text: agents.length+' done' };
    }

    // ── subagent state dots ───────────────────────────────────────

    function rollupSubagentDots(subagents) {
      const counts = { running:0, idle:0, done:0 };
      for (const s of subagents) counts[s.state]=(counts[s.state]||0)+1;
      let html = '';
      if (counts.running) html += '<span class="ssd running" title="'+counts.running+' running"></span>';
      if (counts.idle)    html += '<span class="ssd idle"    title="'+counts.idle+' idle"></span>';
      if (counts.done)    html += '<span class="ssd done"    title="'+counts.done+' done"></span>';
      return html ? '<div class="sub-state-dots">'+html+'</div>' : '';
    }

    // ── activity timeline ─────────────────────────────────────────

    const RECENCY_WINDOW_MS = 2 * 60 * 1000; // 2 minutes
    const STALL_MS = 8 * 60 * 1000;          // 8 minutes

    function renderTimeline(activityHistory, now) {
      if (!activityHistory || activityHistory.length === 0) return '';
      const current = activityHistory[0];
      let html = '<div class="activity-timeline">';
      html += '<div class="act-row act-current"><span class="act-pip"></span>'
           + '<span class="act-label">'+esc(current.summary)+'</span>'
           + '<span class="act-time">'+relTimeShort(current.at, now)+'</span></div>';
      const classes = ['act-prev1','act-prev2'];
      for (let i = 1; i < activityHistory.length && i < 3; i++) {
        const entry = activityHistory[i];
        if (current.at && entry.at && (current.at - entry.at) > RECENCY_WINDOW_MS) break;
        html += '<div class="act-row '+classes[i-1]+'">'
             + '<span class="act-pip"></span>'
             + '<span class="act-label">'+esc(entry.summary)+'</span>'
             + '<span class="act-time">'+relTimeShort(entry.at, now)+'</span></div>';
      }
      html += '</div>';
      return html;
    }

    function renderStuckBadge(activityHistory, state, now) {
      if (state !== 'running' || !activityHistory || activityHistory.length === 0) return '';
      const current = activityHistory[0];
      // Looping: same summary 3 times in a row
      if (activityHistory.length >= 3 &&
          activityHistory[0].summary === activityHistory[1].summary &&
          activityHistory[1].summary === activityHistory[2].summary) {
        return '<div class="stuck-badge stuck-loop">⧓ Possibly looping — same command 3×</div>';
      }
      // Stalled: most recent entry is 8+ min old
      if (current.at && (now - current.at) > STALL_MS) {
        const mins = Math.floor((now - current.at) / 60000);
        return '<div class="stuck-badge stuck-stall">⏱ No new activity for '+mins+' min</div>';
      }
      return '';
    }

    // ── meta-bar ──────────────────────────────────────────────────

    function renderMetaBar(agent) {
      if (!agent.model && !agent.turnCount && !agent.contextPct) return '';
      let html = '<div class="meta-bar">';
      if (agent.model) html += '<span class="model-chip">⚡ '+esc(agent.model)+'</span>';
      if (agent.model && agent.turnCount) html += '<span class="meta-sep">·</span>';
      if (agent.turnCount) html += '<span>'+agent.turnCount+' turn'+(agent.turnCount!==1?'s':'')+'</span>';
      if (agent.contextPct) {
        if (agent.model || agent.turnCount) html += '<span class="meta-sep">·</span>';
        html += '<div class="ctx-wrap"><div class="ctx-bar-bg"><div class="ctx-bar-fill" style="width:'+agent.contextPct+'%"></div></div>'
             + '<span class="ctx-pct">'+agent.contextPct+'%</span></div>';
      }
      html += '</div>';
      return html;
    }

    // ── card rendering ────────────────────────────────────────────

    function renderActionBtns(stopBtn) {
      return '<button class="action-btn" data-act="previewTranscript" title="Preview transcript">💬</button>'
           + '<button class="action-btn" data-act="openJsonl" title="Open raw JSONL">📄</button>'
           + '<button class="action-btn" data-act="openFolder" title="Open folder">📁</button>'
           + stopBtn
           + '<button class="action-btn danger" data-act="delete" title="Delete">✕</button>';
    }

    function renderSubRow(sub, now) {
      const task = sub.taskDescription||(sub.details&&sub.details.latestUserPrompt)||sub.sessionId.slice(0,8);
      const doneCls = sub.state==='done' ? ' done-sub' : '';
      const stopBtn = sub.state==='running'
        ? '<button class="action-btn danger" data-act="stop" title="Stop">■</button>' : '';
      return '<div class="sub-row'+doneCls+'" data-sid="'+esc(sub.sessionId)+'">'
           + '<span class="status-dot '+esc(sub.state)+'"></span>'
           + '<span class="sub-name">'+esc(task)+'</span>'
           + '<div class="card-slot">'
           +   '<span class="sub-time">'+relTimeShort(sub.mtimeMs,now)+'</span>'
           +   '<div class="sub-actions">'+renderActionBtns(stopBtn)+'</div>'
           + '</div></div>';
    }

    function renderCard(parent, now) {
      const key = 'proj:'+projectKey(parent.cwd)+':subs:'+parent.sessionId;
      const allSubs = parent.subagents||[];
      const effState = parentEffectiveState(parent);
      const subsOpen = openSections[key]||false;

      const d = parent.details||{};
      const prompt = d.customTitle||d.aiTitle||d.latestUserPrompt||d.lastPrompt||null;
      const nameCls = prompt ? '' : ' no-prompt';

      const stopBtn = effState==='running'
        ? '<button class="action-btn danger" data-act="stop" title="Stop">■</button>' : '';

      const subSection = allSubs.length > 0
        ? '<div class="sub-toggle" data-sub-key="'+esc(key)+'">'
          + '<span class="sub-caret">▶</span>'
          + '<span>'+allSubs.length+' subagent'+(allSubs.length!==1?'s':'')+'</span>'
          + rollupSubagentDots(allSubs)
          + '</div>'
          + '<div class="sub-list">'
          + allSubs.slice().sort((a,b)=>b.mtimeMs-a.mtimeMs).map(s=>renderSubRow(s,now)).join('')
          + '</div>'
        : '';

      return '<div class="card'+(subsOpen?' subs-open':'')+'" data-key="'+esc(key)+'" data-sid="'+esc(parent.sessionId)+'">'
           + '<div class="card-top">'
           +   '<span class="status-dot '+esc(effState)+'" style="transition:background 0.3s"></span>'
           +   '<span class="card-name'+nameCls+'">'+esc(prompt||'(no prompt yet)')+'</span>'
           +   '<div class="card-slot">'
           +     '<span class="card-time">'+relTimeShort(parentMaxMtime(parent),now)+'</span>'
           +     '<div class="card-actions">'+renderActionBtns(stopBtn)+'</div>'
           +   '</div>'
           + '</div>'
           + '<div class="card-path"><span class="proj-path">‎'+esc(parent.cwd)+'</span><span class="session-id">'+esc(parent.sessionId)+'</span></div>'
           + renderMetaBar(parent)
           + renderTimeline(parent.activityHistory, now)
           + renderStuckBadge(parent.activityHistory, effState, now)
           + subSection
           + '</div>';
    }

    // ── patch existing card (avoids full replacement) ─────────────

    function patchCard(cardEl, agent, now) {
      const effState = parentEffectiveState(agent);
      const d = agent.details||{};
      const prompt = d.customTitle||d.aiTitle||d.latestUserPrompt||d.lastPrompt||'(no prompt yet)';

      const dot = cardEl.querySelector('.status-dot:first-child');
      if (dot) { dot.className = 'status-dot '+effState; }

      const nameEl = cardEl.querySelector('.card-name');
      if (nameEl) { nameEl.textContent = prompt; nameEl.className = 'card-name'+(prompt==='(no prompt yet)'?' no-prompt':''); }

      const timeEl = cardEl.querySelector('.card-time');
      if (timeEl) timeEl.textContent = relTimeShort(parentMaxMtime(agent), now);

      // Replace variable-content sections in-place
      const existingMeta = cardEl.querySelector('.meta-bar');
      const newMeta = renderMetaBar(agent);
      if (existingMeta) existingMeta.outerHTML = newMeta || '';
      else if (newMeta) {
        const pathEl = cardEl.querySelector('.card-path');
        if (pathEl) pathEl.insertAdjacentHTML('afterend', newMeta);
      }

      const existingTimeline = cardEl.querySelector('.activity-timeline');
      const newTimeline = renderTimeline(agent.activityHistory, now);
      if (existingTimeline) existingTimeline.outerHTML = newTimeline || '';
      else if (newTimeline) {
        const metaEl = cardEl.querySelector('.meta-bar');
        const anchor = metaEl || cardEl.querySelector('.card-path');
        if (anchor) anchor.insertAdjacentHTML('afterend', newTimeline);
      }

      const existingBadge = cardEl.querySelector('.stuck-badge');
      const newBadge = renderStuckBadge(agent.activityHistory, effState, now);
      if (existingBadge) existingBadge.outerHTML = newBadge || '';
      else if (newBadge) {
        const tl = cardEl.querySelector('.activity-timeline');
        if (tl) tl.insertAdjacentHTML('afterend', newBadge);
      }

      const toggleEl = cardEl.querySelector('.sub-toggle');
      const allSubs = agent.subagents||[];
      if (toggleEl && allSubs.length > 0) {
        const key = 'proj:'+projectKey(agent.cwd)+':subs:'+agent.sessionId;
        toggleEl.innerHTML = '<span class="sub-caret">▶</span>'
          + '<span>'+allSubs.length+' subagent'+(allSubs.length!==1?'s':'')+'</span>'
          + rollupSubagentDots(allSubs);
      }

      const stopBtn = cardEl.querySelector('.card-actions [data-act="stop"]');
      if (effState !== 'running' && stopBtn) stopBtn.remove();
    }

    // ── reconcile (DOM diff) ──────────────────────────────────────

    function reconcile(groups, now) {
      // Remove project groups no longer present
      for (const [key, el] of projGroupEls) {
        if (!groups.has(key)) { el.remove(); projGroupEls.delete(key); }
      }

      // Sort: active first (running/idle), then inactive (done)
      const sorted = [...groups.values()].sort((a, b) => {
        const aActive = a.agents.some(p=>parentEffectiveState(p)!=='done');
        const bActive = b.agents.some(p=>parentEffectiveState(p)!=='done');
        if (aActive !== bActive) return bActive ? 1 : -1;
        const aMtime = Math.max(...a.agents.map(parentMaxMtime));
        const bMtime = Math.max(...b.agents.map(parentMaxMtime));
        return bMtime - aMtime;
      });

      for (const group of sorted) {
        const isActive = group.agents.some(p=>parentEffectiveState(p)!=='done');
        let groupEl = projGroupEls.get(group.key);

        if (!groupEl) {
          // Create new project group
          groupEl = document.createElement('div');
          groupEl.className = 'proj-group'+(isActive?' open':'')+(isActive?'':' inactive');
          groupEl.dataset.projKey = group.key;
          const badge = groupBadge(group.agents);
          groupEl.innerHTML = '<div class="proj-header" data-proj-key="'+esc(group.key)+'">'
            + '<span class="proj-caret">▶</span>'
            + '<span class="proj-name">'+esc(group.label)+'</span>'
            + '<span class="proj-badge '+badge.cls+'">'+esc(badge.text)+'</span>'
            + '</div><div class="proj-body"></div>';
          if (openSections['proj:'+group.key] !== undefined) {
            groupEl.classList.toggle('open', openSections['proj:'+group.key]);
          }
          projGroupEls.set(group.key, groupEl);
        } else {
          // Patch header badge
          const badgeEl = groupEl.querySelector('.proj-badge');
          const badge = groupBadge(group.agents);
          if (badgeEl) { badgeEl.className = 'proj-badge '+badge.cls; badgeEl.textContent = badge.text; }
          groupEl.classList.toggle('inactive', !isActive);
        }

        root.appendChild(groupEl); // re-sorts into correct position

        // Reconcile cards within this group
        const body = groupEl.querySelector('.proj-body');
        const sorted = group.agents.slice().sort((a,b)=>parentMaxMtime(b)-parentMaxMtime(a));

        // Remove stale cards
        for (const [sid, el] of cardEls) {
          if (body.contains(el) && !group.agents.find(a=>a.sessionId===sid)) {
            el.remove(); cardEls.delete(sid);
          }
        }

        for (const agent of sorted) {
          let cardEl = cardEls.get(agent.sessionId);
          if (!cardEl) {
            const tmp = document.createElement('div');
            tmp.innerHTML = renderCard(agent, now);
            cardEl = tmp.firstElementChild;
            cardEls.set(agent.sessionId, cardEl);
          } else {
            patchCard(cardEl, agent, now);
          }
          body.appendChild(cardEl); // re-sorts within group
        }
      }
    }

    // ── filter ────────────────────────────────────────────────────

    function applyFilter(query) {
      const q = query.toLowerCase().trim();
      for (const [key, groupEl] of projGroupEls) {
        const group = lastGroups ? lastGroups.get(key) : null;
        if (!group) continue;
        let anyMatch = false;
        for (const [sid, cardEl] of cardEls) {
          if (!groupEl.querySelector('.proj-body').contains(cardEl)) continue;
          const agent = group.agents.find(a=>a.sessionId===sid);
          if (!agent) continue;
          const d = agent.details||{};
          const text = [
            d.customTitle||'', d.aiTitle||'', d.latestUserPrompt||'',
            agent.cwd, agent.projectName,
            ...(agent.activityHistory||[]).map(h=>h.summary),
          ].join(' ').toLowerCase();
          const match = !q || text.includes(q);
          cardEl.style.display = match ? '' : 'none';
          if (match) anyMatch = true;
        }
        groupEl.style.display = (!q || anyMatch) ? '' : 'none';
      }
    }

    let lastGroups = null;

    function render(agents, now, ready) {
      if (!ready) {
        root.className = 'empty-global';
        root.innerHTML = 'Scanning…';
        return;
      }
      if (!agents || agents.length === 0) {
        root.className = 'empty-global';
        root.innerHTML = 'No agents yet — run <code>claude</code> in any project';
        return;
      }
      root.className = '';
      const parents = agents.filter(a => !a.parentSessionId);
      lastGroups = groupByProject(parents);
      reconcile(lastGroups, now);
      applyFilter(filterInput ? filterInput.value : '');
    }

    // ── event delegation ──────────────────────────────────────────

    root.addEventListener('click', (e) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;

      const btn = target.closest('[data-act]');
      if (btn) {
        const sidEl = btn.closest('[data-sid]');
        const sid = sidEl ? sidEl.getAttribute('data-sid') : null;
        if (sid) vscode.postMessage({ command: btn.getAttribute('data-act'), sessionId: sid });
        return;
      }

      // Project header toggle
      const projHeader = target.closest('.proj-header');
      if (projHeader) {
        const groupEl = projHeader.closest('.proj-group');
        if (!groupEl) return;
        const isOpen = groupEl.classList.toggle('open');
        const key = groupEl.dataset.projKey;
        if (key) openSections['proj:'+key] = isOpen;
        return;
      }

      // Sub-toggle
      const subToggle = target.closest('.sub-toggle');
      if (subToggle) {
        const card = subToggle.closest('.card');
        if (!card) return;
        const isOpen = card.classList.toggle('subs-open');
        const key = card.dataset.key;
        if (key) openSections[key] = isOpen;
        return;
      }

      // Sub-row → preview
      const subRow = target.closest('.sub-row');
      if (subRow && !target.closest('[data-act]')) {
        const sid = subRow.getAttribute('data-sid');
        if (sid) vscode.postMessage({ command: 'previewTranscript', sessionId: sid });
        return;
      }

      // Card-top → preview
      const cardTop = target.closest('.card-top');
      if (cardTop) {
        const card = cardTop.closest('.card');
        const sid = card ? card.getAttribute('data-sid') : null;
        if (sid) vscode.postMessage({ command: 'previewTranscript', sessionId: sid });
      }
    });

    // Filter input
    if (filterInput) {
      filterInput.addEventListener('input', () => applyFilter(filterInput.value));
      filterInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { filterInput.value = ''; applyFilter(''); filterInput.blur(); }
      });
    }

    window.addEventListener('message', (event) => {
      const { command, agents, ready, now } = event.data;
      if (command === 'render') render(agents, now, ready);
    });

    vscode.postMessage({ command: 'refresh' });
  </script>
```

- [ ] **Step 4: Build and smoke-test**

```bash
npm run build
```

Expected: build succeeds with no errors. Press F5 in VS Code to launch Extension Development Host and verify:
- Agents appear grouped by project
- Active projects are expanded, inactive are collapsed
- Cards update without full flicker
- Expand/collapse state is preserved across auto-refresh ticks

- [ ] **Step 5: Commit**

```bash
git add src/webviewProvider.ts
git commit -m "feat(webview): project grouping + DOM-diff render loop + activity timeline + meta-bar + filter bar"
```

---

## Task 6: Transcript panel — toolbar shell

**Files:**
- Modify: `src/transcriptPanel.ts`

This task adds the toolbar HTML and CSS. The individual buttons are wired in Tasks 7–10.

- [ ] **Step 1: Add toolbar CSS to `buildWebviewHtml`**

Find the `<style>` block inside `buildWebviewHtml` and append before `</style>`:

```css
.toolbar {
  position: sticky; top: 0; z-index: 10;
  display: flex; align-items: center; gap: 4px;
  padding: 4px 8px;
  background: var(--vscode-editor-background);
  border-bottom: 1px solid var(--vscode-input-border);
}
.tb-btn {
  background: none; border: 1px solid transparent; border-radius: 4px;
  color: var(--vscode-descriptionForeground); cursor: pointer;
  padding: 2px 8px; font-size: 11px; font-family: inherit;
  white-space: nowrap;
}
.tb-btn:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); border-color: var(--vscode-input-border); }
.tb-search-input {
  flex: 1; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border);
  color: var(--vscode-input-foreground); border-radius: 4px;
  padding: 2px 8px; font-size: 11px; font-family: inherit; outline: none; display: none;
}
.tb-search-input.visible { display: block; }
.tb-search-input:focus { border-color: var(--vscode-focusBorder); }
.tb-spacer { flex: 1; }
.tb-jump { display: none; }
.tb-jump.visible { display: inline-block; }
.search-highlight { background: rgba(255,215,0,0.3); border-radius: 2px; }
.copy-btn {
  display: none; background: none; border: none; cursor: pointer;
  color: var(--vscode-descriptionForeground); padding: 1px 4px;
  font-size: 11px; border-radius: 3px; margin-left: 4px;
}
.turn-head:hover .copy-btn { display: inline-flex; align-items: center; }
.copy-btn:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
```

- [ ] **Step 2: Add toolbar HTML to `buildWebviewHtml`**

Find the line:

```typescript
const turnsHtml = '<div class="empty-state loading">Loading…</div>';
```

Replace with:

```typescript
const turnsHtml = '<div class="empty-state loading">Loading…</div>';
const toolbarHtml = `<div class="toolbar">
  <button class="tb-btn" id="tb-search-btn" title="Search (Ctrl+F)">\u{1F50D} Search</button>
  <input class="tb-search-input" id="tb-search-input" placeholder="Search…" />
  <span class="tb-spacer"></span>
  <button class="tb-btn tb-jump" id="tb-jump-btn" title="Jump to latest">↓ Latest</button>
  <button class="tb-btn" id="tb-export-btn" title="Export as markdown">\u{1F4BE} Export</button>
</div>`;
```

- [ ] **Step 3: Insert toolbar and fix scroll height in `buildWebviewHtml`**

First, add `body { display: flex; flex-direction: column; }` and override `.scroll` height to the CSS block you just added in Step 1. Append inside the same style block:

```css
body { display: flex; flex-direction: column; }
.toolbar { flex-shrink: 0; }
.scroll { flex: 1; height: unset !important; }
```

Then find this exact block in the template literal (around line 710):

```typescript
<div class="scroll" id="scroll">
${turnsHtml}
</div>
```

Replace with:

```typescript
${toolbarHtml}
<div class="scroll" id="scroll">
${turnsHtml}
</div>
```

- [ ] **Step 4: Build to confirm no syntax errors**

```bash
npm run build
```

Expected: builds cleanly. Toolbar appears in transcript panels (buttons do nothing yet).

- [ ] **Step 5: Commit**

```bash
git add src/transcriptPanel.ts
git commit -m "feat(transcriptPanel): add toolbar shell (search/jump/export buttons)"
```

---

## Task 7: Transcript panel — copy turn button

**Files:**
- Modify: `src/transcriptPanel.ts`

- [ ] **Step 1: Add copy button to `renderAssistantTurn`**

Find `renderAssistantTurn` and change the `turn-head` HTML. Find this line:

```typescript
      <span class="turn-ts">${metaPrefix}<span data-iso="${esc(turn.timestamp)}"></span></span>
```

Replace with:

```typescript
      <span class="turn-ts">${metaPrefix}<span data-iso="${esc(turn.timestamp)}"></span></span>
      ${turn.text ? `<button class="copy-btn" data-copy="${esc(turn.text)}" title="Copy response">\u{1F4CB}</button>` : ''}
```

- [ ] **Step 2: Add copy handling to the existing click listener in `buildWebviewHtml`**

Find `scroll.addEventListener('click', (ev) => {` (around line 753 in `buildWebviewHtml`'s script) and insert at the very top of the callback body, before any existing code:

```javascript
  // Copy turn button
  const copyBtn = ev.target.closest && ev.target.closest('.copy-btn');
  if (copyBtn) {
    navigator.clipboard.writeText(copyBtn.dataset.copy || '').catch(() => {});
    const orig = copyBtn.textContent;
    copyBtn.textContent = '✓';
    setTimeout(() => { copyBtn.textContent = orig; }, 1200);
    return;
  }
```

- [ ] **Step 3: Build and verify**

```bash
npm run build
```

Open a transcript panel, hover over an assistant turn — clipboard button should appear. Click it, then paste somewhere to confirm the text was copied.

- [ ] **Step 4: Commit**

```bash
git add src/transcriptPanel.ts
git commit -m "feat(transcriptPanel): add copy-turn button on assistant turns"
```

---

## Task 8: Transcript panel — search

**Files:**
- Modify: `src/transcriptPanel.ts`

- [ ] **Step 1: Add search JS to the panel webview script**

Inside the webview `<script>`, add:

```javascript
// `scroll` is already defined in the webview script as document.getElementById('scroll')
const searchBtn   = document.getElementById('tb-search-btn');
const searchInput = document.getElementById('tb-search-input');

function clearHighlights() {
  scroll.querySelectorAll('.search-highlight').forEach(el => {
    el.replaceWith(document.createTextNode(el.textContent));
  });
  scroll.normalize();
}

function highlightText(query) {
  clearHighlights();
  if (!query) return;
  const walker = document.createTreeWalker(scroll, NodeFilter.SHOW_TEXT, null);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const lq = query.toLowerCase();
  for (const node of nodes) {
    const idx = node.textContent.toLowerCase().indexOf(lq);
    if (idx === -1) continue;
    const mark = document.createElement('mark');
    mark.className = 'search-highlight';
    const after = node.splitText(idx);
    after.splitText(query.length);
    mark.appendChild(after.cloneNode(true));
    after.replaceWith(mark);
  }
  const first = turns.querySelector('.search-highlight');
  if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

searchBtn.addEventListener('click', () => {
  searchInput.classList.toggle('visible');
  if (searchInput.classList.contains('visible')) searchInput.focus();
  else { clearHighlights(); searchInput.value = ''; }
});

searchInput.addEventListener('input', () => highlightText(searchInput.value));
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    clearHighlights(); searchInput.value = '';
    searchInput.classList.remove('visible');
    searchInput.blur();
  }
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault();
    searchInput.classList.add('visible');
    searchInput.focus();
  }
});
```

- [ ] **Step 2: Build and verify**

```bash
npm run build
```

Open a transcript panel, press `Ctrl+F`. Type a word that appears in the transcript — matching text should be highlighted and scrolled into view. Press Escape to close.

- [ ] **Step 3: Commit**

```bash
git add src/transcriptPanel.ts
git commit -m "feat(transcriptPanel): add Ctrl+F in-panel search with text highlighting"
```

---

## Task 9: Transcript panel — jump to latest

**Files:**
- Modify: `src/transcriptPanel.ts`

- [ ] **Step 1: Add jump button wiring**

The webview script already defines `scroll`, `scrollToBottom()`, and `_progScrolls`. Add the following immediately after the existing `scroll.addEventListener('scroll', ...)` block (around line 788):

```javascript
const jumpBtn = document.getElementById('tb-jump-btn');

function updateJumpVisibility() {
  const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 60;
  if (jumpBtn) jumpBtn.classList.toggle('visible', !atBottom);
}

jumpBtn && jumpBtn.addEventListener('click', () => scrollToBottom());
```

- [ ] **Step 2: Call `updateJumpVisibility` after content updates**

Inside `window.addEventListener('message', e => { ... })` (around line 799), add `updateJumpVisibility();` on the line immediately before the closing `});` of that listener:

```javascript
    stampTimestamps();
    if (wasAtBottom) scrollToBottom();
    updateJumpVisibility(); // ← add this line
  });
```

Also add the same call at the end of the `diag` branch (before its `return;`) so the button state stays accurate when the diag banner updates.

- [ ] **Step 3: Build and verify**

```bash
npm run build
```

Open a long transcript. Scroll up into history — "↓ Latest" button should appear. Click it to jump back to the bottom.

- [ ] **Step 4: Commit**

```bash
git add src/transcriptPanel.ts
git commit -m "feat(transcriptPanel): add jump-to-latest button shown when scrolled up"
```

---

## Task 10: Transcript panel — export as markdown

**Files:**
- Modify: `src/transcriptPanel.ts`

- [ ] **Step 1: Add `exportMarkdown` message handler in `transcriptPanel.ts`**

In the `openTranscriptPreview` function, find where `panel.webview.onDidReceiveMessage` is set up. It currently only handles `ready`. Extend it to also handle `exportMarkdown`. Replace the `sub = panel.webview.onDidReceiveMessage(...)` listener with a persistent handler:

After the fallbackTimer/sub block, add a persistent message handler on the panel:

```typescript
panel.webview.onDidReceiveMessage(async (msg) => {
  if (msg.command === 'exportMarkdown') {
    await handleExportMarkdown(agent, panel);
  }
});
```

- [ ] **Step 2: Add `handleExportMarkdown` function to `transcriptPanel.ts`**

Add this function after `evict`:

```typescript
/** Formats the agent's transcript as markdown and prompts the user to save it. */
async function handleExportMarkdown(agent: Agent, panel: vscode.WebviewPanel): Promise<void> {
  try {
    const { turns } = await getTurns(agent);
    const d = agent.details;
    const title = d.customTitle || d.aiTitle || d.latestUserPrompt || agent.sessionId.slice(0, 8);
    const lines: string[] = [`# ${title}`, '', `**Session:** \`${agent.sessionId}\``, `**Project:** ${agent.cwd}`, ''];

    for (const turn of turns) {
      const ts = turn.timestamp ? ` *(${new Date(turn.timestamp).toLocaleString()})* ` : '';
      if (turn.role === 'user') {
        lines.push(`## User${ts}`, '');
        if (turn.text) lines.push(turn.text, '');
      } else {
        lines.push(`## Agent${ts}`, '');
        if (turn.text) lines.push(turn.text, '');
        for (const entry of turn.entries) {
          if (entry.kind === 'tool_use') {
            lines.push(`### ${entry.label}`, '', '```', entry.body, '```', '');
            if (entry.result) {
              lines.push(`**Result:**`, '', '```', entry.result.body.slice(0, 2000), '```', '');
            }
          }
        }
      }
    }

    const saveUri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`${agent.projectName}-transcript.md`),
      filters: { Markdown: ['md'] },
      title: 'Export transcript as Markdown',
    });
    if (!saveUri) return;
    await fsp.writeFile(saveUri.fsPath, lines.join('\n'), 'utf-8');
    vscode.window.showInformationMessage(`Transcript exported to ${saveUri.fsPath}`);
  } catch (err) {
    logError('exportMarkdown', err);
    vscode.window.showErrorMessage(`Export failed: ${(err as Error).message}`);
  }
}
```

- [ ] **Step 3: Add export button click handler to the webview script**

The webview script acquires `vscode` near the bottom (line 853: `const vscode = acquireVsCodeApi()`). Add the export handler immediately after that line, before `vscode.postMessage({ command: 'ready' })`:

```javascript
  const vscode = acquireVsCodeApi();
  document.getElementById('tb-export-btn')?.addEventListener('click', () => {
    vscode.postMessage({ command: 'exportMarkdown' });
  });
  vscode.postMessage({ command: 'ready' });
```

- [ ] **Step 4: Handle `exportMarkdown` in `transcriptPanel.ts` `openTranscriptPreview`**

The `openTranscriptPreview` function currently uses a one-shot `sub` listener for the `ready` message. We need a persistent listener for `exportMarkdown`. Add this right after `panel.webview.html = buildWebviewHtml(agent.projectName)`:

```typescript
panel.webview.onDidReceiveMessage(async (msg) => {
  if (msg.command === 'exportMarkdown') {
    await handleExportMarkdown(agent, panel);
  }
});
```

- [ ] **Step 5: Build and verify**

```bash
npm run build
```

Open a transcript panel, click "💾 Export". A save dialog should appear. Save to disk. Open the file and confirm it contains the formatted conversation.

- [ ] **Step 6: Run full test suite and lint**

```bash
npm test && npm run lint
```

Expected: all tests pass, no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add src/transcriptPanel.ts
git commit -m "feat(transcriptPanel): export transcript as markdown via save dialog"
```

---

## Final Verification

- [ ] Press F5, open Extension Development Host
- [ ] Confirm project groups appear with active projects expanded
- [ ] Confirm inactive projects are collapsed and dimmed
- [ ] Filter bar: type a project name and confirm only matching cards show
- [ ] Confirm agent cards show model chip, turn count, context bar
- [ ] Confirm activity timeline shows last actions with timestamps
- [ ] Leave a running agent idle for 8+ min; confirm stall badge appears
- [ ] Confirm subagent toggle shows accurate state dots (not always green)
- [ ] Open a transcript panel; confirm toolbar appears
- [ ] Hover assistant turn; confirm clipboard button appears; click; paste to confirm
- [ ] Press Ctrl+F; search for a word; confirm highlighting and scroll
- [ ] Scroll up in a long transcript; confirm "↓ Latest" appears; click to return
- [ ] Export transcript; confirm file is saved with readable markdown
- [ ] Run `npm test && npm run lint` — all pass

- [ ] **Final commit (if any cleanup needed)**

```bash
git add -u
git commit -m "chore: final cleanup for agent-viewer enhancements"
```
