# Agent Viewer Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add subagent nesting, a chat-style transcript preview panel (💬), and retain the existing raw JSONL view (📄) in the agent-viewer VS Code extension.

**Architecture:** Parse JSONL transcripts into a `Turn[]` model on first open, cache by `mtimeMs`, serve via `vscode.window.createWebviewPanel()`. Subagents are detected by filesystem path pattern and wired into a parent-child tree after the flat agent map is fully populated.

**Tech Stack:** TypeScript, VS Code Extension API, Node.js `fs`, Vitest for unit tests, no new runtime dependencies.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/types.ts` | Modify | Add `parentSessionId?`, `subagents[]` to `Agent`; add `Turn`, `TurnEntry`, `TurnAttachment` |
| `src/transcriptParser.ts` | Create | Pure `parseTranscript(jsonlText): Turn[]` — no VS Code imports |
| `src/transcriptPanel.ts` | Create | Panel lifecycle, parse-on-open cache, HTML generation |
| `src/agentService.ts` | Modify | Initialize `subagents: []` in `buildAgent`; add `buildTree()` pass in `scheduleEmit` |
| `src/webviewProvider.ts` | Modify | Add 💬 button; handle `previewTranscript`; call `evict` on delete; render nested subagents |
| `src/test/transcriptParser.test.ts` | Create | Unit tests for the parser (runs without VS Code) |

---

## Task 1: Add Vitest

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install vitest**

```bash
cd d:/Development/ai/agent-viewer
npm install --save-dev vitest
```

Expected: `vitest` appears in `devDependencies` in `package.json`.

- [ ] **Step 2: Add test script to package.json**

In `package.json`, add `"test": "vitest run src/test"` to the `scripts` block:

```json
"scripts": {
  "vscode:prepublish": "npm run build",
  "build": "node esbuild.js --production",
  "watch": "node esbuild.js --watch",
  "lint": "tsc --noEmit",
  "test": "vitest run src/test"
}
```

- [ ] **Step 3: Create test directory**

```bash
mkdir -p "d:/Development/ai/agent-viewer/src/test"
```

- [ ] **Step 4: Commit**

```bash
cd d:/Development/ai/agent-viewer
git add package.json package-lock.json
git commit -m "chore: add vitest for unit testing"
```

---

## Task 2: Extend Types

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add new types to `src/types.ts`**

Append to the end of the existing file (do not remove anything):

```typescript
// ── Transcript preview model ──────────────────────────────────────

export interface TurnAttachment {
  type: 'image' | 'document';
  name?: string;
  mediaType?: string;   // image only — e.g. "image/png"
  data?: string;        // base64 for images; raw text for documents
}

export interface TurnEntry {
  kind: 'tool_use' | 'tool_result' | 'thinking' | 'system';
  label: string;        // e.g. "Bash · ls -la", "Result · Bash", "Thinking"
  timestamp: string;    // ISO 8601
  body: string;         // raw content — caller decides JSON vs markdown
}

export interface Turn {
  role: 'user' | 'assistant';
  timestamp: string;    // ISO 8601 — from first event in the turn
  text?: string;        // markdown bubble text
  attachments: TurnAttachment[];
  entries: TurnEntry[]; // tool/thinking/system entries; empty on user turns
}
```

Also add `parentSessionId` and `subagents` to the existing `Agent` interface:

```typescript
export interface Agent {
  sessionId: string;
  transcriptPath: string;
  cwd: string;
  projectName: string;
  state: AgentState;
  activity: string;
  mtimeMs: number;
  pid?: number;
  details: AgentDetails;
  parentSessionId?: string;  // set if this agent is a subagent
  subagents: Agent[];        // populated by tree-building pass; always initialized to []
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd d:/Development/ai/agent-viewer && npm run lint
```

Expected: no errors. (The `Agent` change may produce errors in `agentService.ts` because `buildAgent` doesn't return `subagents` yet — fix in the next step.)

- [ ] **Step 3: Fix the `buildAgent` return in `src/agentService.ts`**

Find the `buildAgent` function (around line 123). Change the return statement to include `subagents: []`:

```typescript
return { sessionId, transcriptPath: filePath, cwd, projectName, state, activity, mtimeMs, details, subagents: [] };
```

- [ ] **Step 4: Verify compile passes**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/agentService.ts
git commit -m "feat: add Turn model types and subagents field to Agent"
```

---

## Task 3: Transcript Parser (TDD)

**Files:**
- Create: `src/transcriptParser.ts`
- Create: `src/test/transcriptParser.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/test/transcriptParser.test.ts`:

```typescript
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

  it('appends tool_result to preceding assistant turn (not a new user turn)', () => {
    const jsonl = [
      line({ type: 'assistant', timestamp: TS, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } }] } }),
      line({ type: 'user', timestamp: TS, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file.txt\n' }] } }),
    ].join('\n');
    const turns = parseTranscript(jsonl);
    expect(turns).toHaveLength(1);                     // only the assistant turn
    expect(turns[0].entries).toHaveLength(2);          // tool_use + tool_result
    expect(turns[0].entries[1].kind).toBe('tool_result');
    expect(turns[0].entries[1].label).toBe('Result · Bash');
    expect(turns[0].entries[1].body).toBe('file.txt\n');
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
      ['Bash',   { command: 'npm test' },           'Bash · npm test'],
      ['Read',   { file_path: '/src/foo.ts' },       'Read · foo.ts'],
      ['Edit',   { file_path: '/src/bar.ts' },       'Edit · bar.ts'],
      ['Write',  { file_path: '/src/baz.ts' },       'Write · baz.ts'],
      ['Grep',   { pattern: 'TODO' },                'Grep · TODO'],
      ['Glob',   { pattern: '**/*.ts' },             'Glob · **/*.ts'],
      ['Agent',  { description: 'explore codebase' },'Subagent · explore codebase'],
      ['Unknown',{},                                  'Unknown'],
    ];
    for (const [name, input, expectedLabel] of cases) {
      const jsonl = line({ type: 'assistant', timestamp: TS, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name, input }] } });
      const turns = parseTranscript(jsonl);
      expect(turns[0].entries[0].label).toBe(expectedLabel);
    }
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd d:/Development/ai/agent-viewer && npm test
```

Expected: all tests fail with "Cannot find module '../transcriptParser'".

- [ ] **Step 3: Create `src/transcriptParser.ts`**

```typescript
import * as path from 'path';
import { Turn, TurnAttachment, TurnEntry } from './types';

interface ContentBlock {
  type: string;
  [key: string]: unknown;
}

interface ParsedEvent {
  type?: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
  [key: string]: unknown;
}

export function parseTranscript(jsonlText: string): Turn[] {
  const events: ParsedEvent[] = [];
  for (const line of jsonlText.split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }

  const turns: Turn[] = [];
  let currentAssistant: Turn | null = null;
  // tool_use_id → { entry, toolName } for wiring up tool_result labels
  const pendingToolUse = new Map<string, { entry: TurnEntry; toolName: string }>();

  for (const event of events) {
    const ts = typeof event.timestamp === 'string' ? event.timestamp : new Date().toISOString();
    const role = event.message?.role;

    // Session end event
    if (event.type === 'result' || event.type === 'summary') {
      const entry: TurnEntry = { kind: 'system', label: 'Session ended', timestamp: ts, body: JSON.stringify(event) };
      if (currentAssistant) {
        currentAssistant.entries.push(entry);
      } else {
        turns.push({ role: 'assistant', timestamp: ts, attachments: [], entries: [entry] });
      }
      continue;
    }

    if (role === 'assistant') {
      if (currentAssistant) turns.push(currentAssistant);
      currentAssistant = { role: 'assistant', timestamp: ts, attachments: [], entries: [] };
      pendingToolUse.clear();

      for (const block of normalizeContent(event.message?.content)) {
        if (block.type === 'text') {
          currentAssistant.text = ((currentAssistant.text ?? '') + (block.text as string)).trim();
        } else if (block.type === 'thinking') {
          currentAssistant.entries.push({ kind: 'thinking', label: 'Thinking', timestamp: ts, body: block.thinking as string });
        } else if (block.type === 'tool_use') {
          const name = typeof block.name === 'string' ? block.name : 'Tool';
          const input = (block.input ?? {}) as Record<string, unknown>;
          const id = typeof block.id === 'string' ? block.id : '';
          const entry: TurnEntry = { kind: 'tool_use', label: labelForToolUse(name, input), timestamp: ts, body: JSON.stringify(input) };
          currentAssistant.entries.push(entry);
          if (id) pendingToolUse.set(id, { entry, toolName: name });
        }
      }
      continue;
    }

    if (role === 'user') {
      const blocks = normalizeContent(event.message?.content);
      const allToolResults = blocks.length > 0 && blocks.every(b => b.type === 'tool_result');

      if (allToolResults) {
        // Attach results to preceding assistant turn
        for (const block of blocks) {
          const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
          const pending = pendingToolUse.get(toolUseId);
          const label = pending ? `Result · ${pending.toolName}` : 'Result';
          const body = extractResultBody(block);
          if (currentAssistant) {
            currentAssistant.entries.push({ kind: 'tool_result', label, timestamp: ts, body });
          }
        }
      } else {
        // Real user turn — flush pending assistant first
        if (currentAssistant) { turns.push(currentAssistant); currentAssistant = null; }
        pendingToolUse.clear();

        const turn: Turn = { role: 'user', timestamp: ts, attachments: [], entries: [] };
        for (const block of blocks) {
          if (block.type === 'text') {
            turn.text = ((turn.text ?? '') + (block.text as string)).trim();
          } else if (block.type === 'image') {
            const src = block.source as { type?: string; media_type?: string; data?: string } | undefined;
            if (src?.type === 'base64') {
              turn.attachments.push({ type: 'image', mediaType: src.media_type, data: src.data });
            }
          } else if (block.type === 'document') {
            const src = block.source as { type?: string; data?: string } | undefined;
            turn.attachments.push({ type: 'document', name: block.title as string | undefined, data: src?.data });
          }
        }
        turns.push(turn);
      }
    }
  }

  if (currentAssistant) turns.push(currentAssistant);
  return turns;
}

function normalizeContent(content: unknown): ContentBlock[] {
  if (Array.isArray(content)) return content as ContentBlock[];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}

function labelForToolUse(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Bash':   return `Bash · ${trunc(String(input.command ?? ''), 60)}`;
    case 'Read':   return `Read · ${path.basename(String(input.file_path ?? ''))}`;
    case 'Edit':   return `Edit · ${path.basename(String(input.file_path ?? ''))}`;
    case 'Write':  return `Write · ${path.basename(String(input.file_path ?? ''))}`;
    case 'Grep':   return `Grep · ${trunc(String(input.pattern ?? ''), 60)}`;
    case 'Glob':   return `Glob · ${trunc(String(input.pattern ?? ''), 60)}`;
    case 'Agent':  return `Subagent · ${trunc(String(input.description ?? ''), 60)}`;
    default:       return name;
  }
}

function extractResultBody(block: ContentBlock): string {
  const { content } = block;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as ContentBlock[]).map(b => (b.type === 'text' ? String(b.text ?? '') : JSON.stringify(b))).join('\n');
  }
  return JSON.stringify(block);
}

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
```

- [ ] **Step 4: Run tests and verify they pass**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/transcriptParser.ts src/test/transcriptParser.test.ts
git commit -m "feat: add transcript parser with full test coverage"
```

---

## Task 4: Subagent Detection in AgentService

**Files:**
- Modify: `src/agentService.ts`
- Modify: `src/test/transcriptParser.test.ts` (add subagent path tests — actually add a new test file)
- Create: `src/test/agentTree.test.ts`

- [ ] **Step 1: Write failing tests for the tree-building logic**

Create `src/test/agentTree.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { Agent } from '../types';

// We'll import the function once it's exported — currently it won't exist
import { buildTreeForTesting } from '../agentService';

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
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm test
```

Expected: FAIL — "buildTreeForTesting is not exported from agentService".

- [ ] **Step 3: Add `buildTree` to `src/agentService.ts`**

Add this function (and its export for testing) near the bottom of `agentService.ts`, before the last closing brace of the file:

```typescript
// Exported only for unit testing — use buildTree() internally
export function buildTreeForTesting(agents: Map<string, Agent>): void {
  buildTree(agents);
}

function buildTree(agents: Map<string, Agent>): void {
  // Reset all subagent arrays so repeated calls don't accumulate
  for (const agent of agents.values()) {
    agent.subagents = [];
    agent.parentSessionId = undefined;
  }

  for (const agent of agents.values()) {
    // Subagent paths contain "/subagents/" — extract parent session ID from directory name
    const normalised = agent.transcriptPath.replace(/\\/g, '/');
    const subagentsIdx = normalised.lastIndexOf('/subagents/');
    if (subagentsIdx === -1) continue;

    const beforeSubagents = normalised.slice(0, subagentsIdx);
    const parentSessionId = beforeSubagents.slice(beforeSubagents.lastIndexOf('/') + 1);
    const parent = agents.get(parentSessionId);

    if (parent) {
      agent.parentSessionId = parentSessionId;
      parent.subagents.push(agent);
    }
    // Orphan: no parentSessionId set, agent stays at top level
  }
}
```

- [ ] **Step 4: Call `buildTree` in `scheduleEmit`**

Find the `scheduleEmit` method in `AgentService`:

```typescript
private scheduleEmit(): void {
  clearTimeout(this.debounceTimer);
  this.debounceTimer = setTimeout(() => this._onDidChange.fire(this.getAgents()), DEBOUNCE_MS);
}
```

Change it to:

```typescript
private scheduleEmit(): void {
  clearTimeout(this.debounceTimer);
  this.debounceTimer = setTimeout(() => {
    buildTree(this.agents);
    this._onDidChange.fire(this.getAgents());
  }, DEBOUNCE_MS);
}
```

Also call `buildTree` in `reclassifyAll` before firing, so state ticks stay consistent. Find:

```typescript
if (changed) this._onDidChange.fire(this.getAgents());
```

Change to:

```typescript
if (changed) {
  buildTree(this.agents);
  this._onDidChange.fire(this.getAgents());
}
```

- [ ] **Step 5: Run tests and verify they pass**

```bash
npm test
```

Expected: all tests pass including new agentTree tests.

- [ ] **Step 6: Verify compile**

```bash
npm run lint
```

- [ ] **Step 7: Commit**

```bash
git add src/agentService.ts src/test/agentTree.test.ts
git commit -m "feat: detect subagents by path and build parent-child tree"
```

---

## Task 5: Transcript Panel — Shell and Cache

**Files:**
- Create: `src/transcriptPanel.ts`

- [ ] **Step 1: Create `src/transcriptPanel.ts`**

```typescript
import * as vscode from 'vscode';
import * as fs from 'fs';
import { Agent, Turn } from './types';
import { parseTranscript } from './transcriptParser';

const parseCache = new Map<string, { turns: Turn[]; mtimeMs: number }>();
const openPanels = new Map<string, vscode.WebviewPanel>();

export function openTranscriptPreview(agent: Agent): void {
  const existing = openPanels.get(agent.sessionId);
  if (existing) {
    existing.reveal(vscode.ViewColumn.One);
    return;
  }

  const turns = getTurns(agent);
  const panel = vscode.window.createWebviewPanel(
    'agentTranscript',
    `💬 ${agent.projectName}`,
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  openPanels.set(agent.sessionId, panel);
  panel.onDidDispose(() => openPanels.delete(agent.sessionId));
  panel.webview.html = buildWebviewHtml(turns, agent.projectName);
}

export function evict(sessionId: string): void {
  parseCache.delete(sessionId);
  const panel = openPanels.get(sessionId);
  if (panel) { panel.dispose(); openPanels.delete(sessionId); }
}

function getTurns(agent: Agent): Turn[] {
  const cached = parseCache.get(agent.sessionId);
  if (cached && cached.mtimeMs === agent.mtimeMs) return cached.turns;
  let text: string;
  try { text = fs.readFileSync(agent.transcriptPath, 'utf-8'); }
  catch { return []; }
  const turns = parseTranscript(text);
  parseCache.set(agent.sessionId, { turns, mtimeMs: agent.mtimeMs });
  return turns;
}

// ── HTML generation ────────────────────────────────────────────────
// (buildWebviewHtml and helpers added in Task 6)
export function buildWebviewHtml(turns: Turn[], title: string): string {
  return `<!DOCTYPE html><html><body>Loading…</body></html>`;
}
```

- [ ] **Step 2: Verify compile**

```bash
npm run lint
```

- [ ] **Step 3: Commit**

```bash
git add src/transcriptPanel.ts
git commit -m "feat: add transcript panel shell with cache"
```

---

## Task 6: Transcript Panel — Webview HTML

**Files:**
- Modify: `src/transcriptPanel.ts`

This task replaces the stub `buildWebviewHtml` from Task 5 with the full implementation.

- [ ] **Step 1: Replace `buildWebviewHtml` and add all helpers in `src/transcriptPanel.ts`**

Replace the entire file content with the following (keep the imports, `parseCache`, `openPanels`, `openTranscriptPreview`, `evict`, and `getTurns` exactly as written in Task 5, and replace only `buildWebviewHtml` and add the helpers below it):

```typescript
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Agent, Turn, TurnEntry, TurnAttachment } from './types';
import { parseTranscript } from './transcriptParser';

const parseCache = new Map<string, { turns: Turn[]; mtimeMs: number }>();
const openPanels = new Map<string, vscode.WebviewPanel>();

export function openTranscriptPreview(agent: Agent): void {
  const existing = openPanels.get(agent.sessionId);
  if (existing) {
    existing.reveal(vscode.ViewColumn.One);
    return;
  }
  const turns = getTurns(agent);
  const panel = vscode.window.createWebviewPanel(
    'agentTranscript',
    `💬 ${agent.projectName}`,
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  openPanels.set(agent.sessionId, panel);
  panel.onDidDispose(() => openPanels.delete(agent.sessionId));
  panel.webview.html = buildWebviewHtml(turns, agent.projectName);
}

export function evict(sessionId: string): void {
  parseCache.delete(sessionId);
  const panel = openPanels.get(sessionId);
  if (panel) { panel.dispose(); openPanels.delete(sessionId); }
}

function getTurns(agent: Agent): Turn[] {
  const cached = parseCache.get(agent.sessionId);
  if (cached && cached.mtimeMs === agent.mtimeMs) return cached.turns;
  let text: string;
  try { text = fs.readFileSync(agent.transcriptPath, 'utf-8'); }
  catch { return []; }
  const turns = parseTranscript(text);
  parseCache.set(agent.sessionId, { turns, mtimeMs: agent.mtimeMs });
  return turns;
}

// ── HTML escaping ──────────────────────────────────────────────────
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Turn HTML renderers ────────────────────────────────────────────
function renderTurn(turn: Turn): string {
  return turn.role === 'user' ? renderUserTurn(turn) : renderAssistantTurn(turn);
}

function renderUserTurn(turn: Turn): string {
  const attachHtml = turn.attachments.map(renderAttachment).join('');
  const textHtml = turn.text ? `<div data-md>${esc(turn.text)}</div>` : '';
  const bubbleInner = (attachHtml ? `<div class="bubble-attachments">${attachHtml}</div>` : '') + textHtml;
  return `<div class="turn user">
    <div class="turn-head">
      <div class="avatar user"><svg><use href="#icon-user"/></svg></div>
      <span class="turn-label">User</span>
      <span class="turn-ts" data-iso="${esc(turn.timestamp)}"></span>
    </div>
    <div class="turn-content"><div class="turn-inner">
      <div class="bubble">${bubbleInner}</div>
    </div></div>
  </div>`;
}

function renderAssistantTurn(turn: Turn): string {
  const entriesHtml = turn.entries.length > 0
    ? `<div class="entries">${turn.entries.map(renderEntry).join('')}</div>`
    : '';
  const bubbleHtml = turn.text
    ? `<div class="bubble" data-md>${esc(turn.text)}</div>`
    : '';
  if (!entriesHtml && !bubbleHtml) return '';
  return `<div class="turn assistant">
    <div class="turn-head">
      <div class="avatar agent"><svg><use href="#icon-agent"/></svg></div>
      <span class="turn-label">Agent</span>
      <span class="turn-ts" data-iso="${esc(turn.timestamp)}"></span>
    </div>
    <div class="turn-content"><div class="turn-inner">
      ${entriesHtml}${bubbleHtml}
    </div></div>
  </div>`;
}

function renderEntry(entry: TurnEntry): string {
  const kindClass = entry.kind.replace('_', '-'); // tool_use → tool-use
  const icon = entryIcon(entry.kind);
  return `<div class="entry ${kindClass}" onclick="toggle(event,this)">
    <div class="entry-row">
      <span class="entry-caret"><svg><use href="#icon-chevron"/></svg></span>
      <div class="pill"><span>${icon}</span><span class="p-text">${esc(entry.label)}</span><span class="p-ts" data-iso="${esc(entry.timestamp)}"></span></div>
    </div>
    <div class="entry-body">${esc(entry.body)}</div>
  </div>`;
}

function entryIcon(kind: TurnEntry['kind']): string {
  switch (kind) {
    case 'tool_use':    return '⚙';
    case 'tool_result': return '↩';
    case 'thinking':    return '💭';
    case 'system':      return '◾';
  }
}

function renderAttachment(att: TurnAttachment): string {
  if (att.type === 'image' && att.data && att.mediaType) {
    const src = `data:${esc(att.mediaType)};base64,${att.data}`;
    const name = esc(att.name ?? 'image');
    return `<div class="attach-image" onclick="openLightbox(this)">
      <img src="${src}" alt="${name}">
      <span class="img-badge">${name}</span>
    </div>`;
  }
  if (att.type === 'document') {
    const name = esc(att.name ?? 'document');
    const size = att.data ? `${(att.data.length / 1024).toFixed(1)} KB` : '';
    return `<div class="attach-file">
      <span class="af-icon"><svg width="14" height="14"><use href="#icon-file"/></svg></span>
      <span class="af-name">${name}</span>
      ${size ? `<span class="af-meta">${size}</span>` : ''}
    </div>`;
  }
  return '';
}

// ── Full HTML document ─────────────────────────────────────────────
export function buildWebviewHtml(turns: Turn[], title: string): string {
  const turnsHtml = turns.length > 0
    ? turns.map(renderTurn).join('\n')
    : '<div class="empty-state">No turns found in this transcript.</div>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { height: 100vh; overflow: hidden; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 13px; }

:root {
  --json-key:  var(--vscode-symbolIcon-variableForeground, #9cdcfe);
  --json-str:  var(--vscode-textPreformat-foreground, #ce9178);
  --json-num:  var(--vscode-debugTokenExpression-number, var(--vscode-symbolIcon-functionForeground, #b5cea8));
  --json-bool: var(--vscode-debugTokenExpression-boolean, var(--vscode-symbolIcon-keywordForeground, #569cd6));
}

.scroll { height: 100vh; overflow-y: auto; padding: 8px 0 40px; }
.scroll::-webkit-scrollbar { width: 8px; }
.scroll::-webkit-scrollbar-track { background: transparent; }
.scroll::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); }

.empty-state { padding: 32px 14px; color: var(--vscode-descriptionForeground); font-size: 12px; }

/* ── Turns ── */
.turn { padding: 5px 14px; }
.turn-head { display: flex; align-items: center; gap: 6px; margin-bottom: 5px; }
.turn.user .turn-head { flex-direction: row-reverse; }
.avatar { width: 20px; height: 20px; border-radius: 4px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.avatar.user  { background: var(--vscode-chat-requestBackground, #2b3b4e); color: var(--vscode-editor-foreground); border: 1px solid var(--vscode-chat-requestBorder, #3b5070); }
.avatar.agent { background: var(--vscode-editorWidget-background); color: var(--vscode-editor-foreground); border: 1px solid var(--vscode-input-border); }
.avatar svg { width: 12px; height: 12px; }
.turn-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
.turn.user      .turn-label { color: var(--vscode-focusBorder); }
.turn.assistant .turn-label { color: var(--vscode-descriptionForeground); }
.turn-ts { font-size: 10px; color: var(--vscode-disabledForeground); white-space: nowrap; }

.turn-content { display: flex; }
.turn.assistant .turn-content { justify-content: flex-start; }
.turn.user      .turn-content { justify-content: flex-end; }
.turn-inner { width: 65%; display: flex; flex-direction: column; gap: 4px; }

/* ── Bubbles ── */
.bubble { padding: 8px 11px; line-height: 1.65; font-size: 13px; word-break: break-word; }
.turn.assistant .bubble { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-input-border); border-radius: 10px 10px 10px 2px; }
.turn.user      .bubble { background: var(--vscode-chat-requestBackground, #2b3b4e); border: 1px solid var(--vscode-chat-requestBorder, #3b5070); border-radius: 10px 10px 2px 10px; }

/* Markdown in bubbles */
.bubble p { margin: 0 0 0.45em; }
.bubble p:last-child { margin-bottom: 0; }
.bubble ul, .bubble ol { padding-left: 1.4em; margin: 0.2em 0; }
.bubble li { margin: 0.1em 0; }
.bubble strong { font-weight: 600; }
.bubble em { font-style: italic; opacity: 0.85; }
.bubble h1, .bubble h2, .bubble h3 { font-weight: 600; font-size: 1em; margin: 0.4em 0 0.2em; }
.bubble a { color: var(--vscode-focusBorder); }
.bubble code { font-family: "Cascadia Code","Fira Code",Consolas,monospace; font-size: 11.5px; background: var(--vscode-textCodeBlock-background); color: var(--vscode-textPreformat-foreground); padding: 1px 5px; border-radius: 3px; border: 1px solid var(--vscode-panel-border); }
.bubble pre { background: var(--vscode-textCodeBlock-background); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 7px 10px; overflow-x: auto; margin: 0.4em 0; }
.bubble pre code { background: none; border: none; padding: 0; }
.bubble blockquote { border-left: 3px solid var(--vscode-input-border); padding-left: 8px; margin: 0.3em 0; opacity: 0.8; }

/* ── Attachments ── */
.bubble-attachments { display: flex; flex-direction: column; gap: 5px; margin-bottom: 7px; }
.attach-image { position: relative; display: inline-block; max-width: 100%; cursor: zoom-in; }
.attach-image img { display: block; max-width: 100%; max-height: 160px; object-fit: contain; border-radius: 5px; border: 1px solid var(--vscode-chat-requestBorder, #3b5070); }
.attach-image .img-badge { position: absolute; top: 5px; left: 5px; background: rgba(0,0,0,0.55); color: #fff; font-size: 10px; padding: 1px 6px; border-radius: 3px; pointer-events: none; }
.attach-file { display: inline-flex; align-items: center; gap: 5px; padding: 4px 9px; border-radius: 4px; background: color-mix(in srgb, var(--vscode-chat-requestBorder,#3b5070) 30%, var(--vscode-chat-requestBackground,#2b3b4e)); border: 1px solid var(--vscode-chat-requestBorder,#3b5070); font-size: 11px; cursor: pointer; max-width: 100%; }
.attach-file .af-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 500; }
.attach-file .af-meta { color: var(--vscode-descriptionForeground); flex-shrink: 0; font-size: 10px; }

/* ── Entries ── */
.entries { display: flex; flex-direction: column; gap: 2px; }
.entry { display: flex; flex-direction: column; }
.entry-row { display: inline-flex; align-items: center; gap: 2px; cursor: pointer; user-select: none; border-radius: 3px; padding: 2px 4px 2px 2px; transition: background 0.1s; max-width: 100%; }
.entry-row:hover { background: var(--vscode-list-hoverBackground); }
.entry-caret { width: 16px; height: 16px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; color: var(--vscode-disabledForeground); transition: transform 0.15s; }
.entry-caret svg { width: 10px; height: 10px; }
.entry.open > .entry-row .entry-caret { transform: rotate(90deg); }
.pill { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px 2px 5px; border-radius: 3px; font-size: 11px; border: 1px solid transparent; min-width: 0; }
.pill .p-text { max-width: 280px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pill .p-ts   { font-size: 10px; opacity: 0.45; margin-left: 2px; flex-shrink: 0; }
.entry.tool-use    .pill { color: var(--vscode-symbolIcon-functionForeground); background: color-mix(in srgb, var(--vscode-symbolIcon-functionForeground) 8%, transparent); border-color: color-mix(in srgb, var(--vscode-symbolIcon-functionForeground) 25%, transparent); }
.entry.tool-result .pill { color: var(--vscode-symbolIcon-variableForeground); background: color-mix(in srgb, var(--vscode-symbolIcon-variableForeground) 8%, transparent); border-color: color-mix(in srgb, var(--vscode-symbolIcon-variableForeground) 25%, transparent); }
.entry.thinking    .pill { color: var(--vscode-symbolIcon-eventForeground);    background: color-mix(in srgb, var(--vscode-symbolIcon-eventForeground)    8%, transparent); border-color: color-mix(in srgb, var(--vscode-symbolIcon-eventForeground)    25%, transparent); }
.entry.system      .pill { color: var(--vscode-symbolIcon-keywordForeground);  background: color-mix(in srgb, var(--vscode-symbolIcon-keywordForeground)  6%, transparent); border-color: color-mix(in srgb, var(--vscode-symbolIcon-keywordForeground)  20%, transparent); }

.entry-body { display: none; margin: 3px 0 4px 18px; padding: 7px 10px; background: var(--vscode-editorWidget-background); border-left: 2px solid var(--vscode-input-border); border-radius: 0 3px 3px 0; font-size: 11px; color: var(--vscode-descriptionForeground); line-height: 1.5; max-height: 240px; overflow-y: auto; }
.entry.open .entry-body { display: block; }
.entry-body.json { font-family: "Cascadia Code","Fira Code",Consolas,monospace; white-space: pre; word-break: normal; }
.jk { color: var(--json-key); }
.js { color: var(--json-str); }
.jn { color: var(--json-num); }
.jb { color: var(--json-bool); }
.entry-body.md p { margin: 0 0 0.35em; }
.entry-body.md p:last-child { margin: 0; }
.entry-body.md code { font-family: "Cascadia Code",Consolas,monospace; font-size: 10.5px; background: var(--vscode-textCodeBlock-background); color: var(--vscode-textPreformat-foreground); padding: 1px 4px; border-radius: 2px; }
.entry-body.md pre { background: var(--vscode-textCodeBlock-background); padding: 5px 8px; border-radius: 3px; overflow-x: auto; margin: 0.3em 0; }
.entry-body.md pre code { background: none; padding: 0; }
.entry-body.md strong { font-weight: 600; color: var(--vscode-editor-foreground); }
.entry-body.md ul, .entry-body.md ol { padding-left: 1.2em; margin: 0.2em 0; }

/* ── Lightbox ── */
.lightbox { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.75); z-index: 100; align-items: center; justify-content: center; cursor: zoom-out; }
.lightbox.open { display: flex; }
.lightbox img { max-width: 90vw; max-height: 90vh; object-fit: contain; border-radius: 6px; }
</style>
</head>
<body>

<svg style="display:none" xmlns="http://www.w3.org/2000/svg">
  <symbol id="icon-user" viewBox="0 0 16 16" fill="currentColor">
    <circle cx="8" cy="5.2" r="2.8"/>
    <path d="M1.5 15.5c0-3.59 2.91-6.5 6.5-6.5s6.5 2.91 6.5 6.5H1.5z"/>
  </symbol>
  <symbol id="icon-agent" viewBox="0 0 16 16" fill="currentColor">
    <rect x="0.5" y="6" width="2" height="3.5" rx="1"/>
    <rect x="13.5" y="6" width="2" height="3.5" rx="1"/>
    <line x1="8" y1="0.8" x2="8" y2="2.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
    <circle cx="8" cy="0.8" r="1.1"/>
    <path fill-rule="evenodd" d="M5.5,2.5 H10.5 Q13,2.5 13,5 V12 Q13,14 10.5,14 H5.5 Q3,14 3,12 V5 Q3,2.5 5.5,2.5 Z M5.5,6.5 H7.5 V8.5 H5.5 Z M8.5,6.5 H10.5 V8.5 H8.5 Z M5.5,10.5 H10.5 V12 H5.5 Z"/>
  </symbol>
  <symbol id="icon-chevron" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="3,2 7,5 3,8"/>
  </symbol>
  <symbol id="icon-file" viewBox="0 0 16 16" fill="currentColor">
    <path fill-rule="evenodd" d="M4 2h5.5L13 5.5V14H4V2zm1 1v10h7V6.5H9V3H5zm5 .7L11.3 5.5H10V3.7z"/>
  </symbol>
</svg>

<div class="lightbox" id="lightbox" onclick="closeLightbox()">
  <img id="lightbox-img" src="" alt="">
</div>

<div class="scroll" id="scroll">
${turnsHtml}
</div>

<script>
  // ── Inline markdown renderer ────────────────────────────────────
  function renderMd(raw) {
    const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const lines = raw.split('\\n');
    const result = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line.startsWith('\`\`\`')) {
        const code = [];
        i++;
        while (i < lines.length && !lines[i].startsWith('\`\`\`')) { code.push(lines[i]); i++; }
        i++;
        result.push('<pre><code>' + esc(code.join('\\n')) + '</code></pre>');
        continue;
      }
      const hm = line.match(/^(#{1,3})\\s+(.+)/);
      if (hm) { result.push('<h' + hm[1].length + '>' + inlineMd(hm[2]) + '</h' + hm[1].length + '>'); i++; continue; }
      if (line.startsWith('> ')) {
        const bq = [];
        while (i < lines.length && lines[i].startsWith('> ')) { bq.push(lines[i].slice(2)); i++; }
        result.push('<blockquote>' + inlineMd(bq.join(' ')) + '</blockquote>');
        continue;
      }
      if (/^[-*+]\\s/.test(line)) {
        const items = [];
        while (i < lines.length && /^[-*+]\\s/.test(lines[i])) { items.push('<li>' + inlineMd(lines[i].replace(/^[-*+]\\s/,'')) + '</li>'); i++; }
        result.push('<ul>' + items.join('') + '</ul>');
        continue;
      }
      if (/^\\d+\\.\\s/.test(line)) {
        const items = [];
        while (i < lines.length && /^\\d+\\.\\s/.test(lines[i])) { items.push('<li>' + inlineMd(lines[i].replace(/^\\d+\\.\\s/,'')) + '</li>'); i++; }
        result.push('<ol>' + items.join('') + '</ol>');
        continue;
      }
      if (line.trim() === '') { i++; continue; }
      const para = [];
      while (i < lines.length && lines[i].trim() !== '' && !/^[#>\`*+\\-\\d]/.test(lines[i])) { para.push(lines[i]); i++; }
      if (para.length) result.push('<p>' + inlineMd(para.join(' ')) + '</p>');
      else i++;
    }
    return result.join('');
  }

  function inlineMd(s) {
    const esc = t => t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return s
      .replace(/\`([^\`]+)\`/g, (_, c) => '<code>' + esc(c) + '</code>')
      .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/\\*([^*]+)\\*/g, '<em>$1</em>')
      .replace(/_([^_]+)_/g, '<em>$1</em>')
      .replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2">$1</a>');
  }

  // ── JSON syntax highlight ───────────────────────────────────────
  function jsonHL(str) {
    return str
      .replace(/("(?:\\\\u[a-zA-Z0-9]{4}|\\\\[^u]|[^\\\\"])*")\\s*:/g, '<span class="jk">$1</span>:')
      .replace(/:\\s*("(?:\\\\u[a-zA-Z0-9]{4}|\\\\[^u]|[^\\\\"])*")/g, ': <span class="js">$1</span>')
      .replace(/:\\s*(-?\\d+\\.?\\d*(?:[eE][+-]?\\d+)?)/g, ': <span class="jn">$1</span>')
      .replace(/:\\s*(true|false|null)/g, ': <span class="jb">$1</span>');
  }

  // ── Render entry bodies ─────────────────────────────────────────
  document.querySelectorAll('.entry-body').forEach(el => {
    const raw = el.textContent.trim();
    try {
      const parsed = JSON.parse(raw);
      el.innerHTML = jsonHL(JSON.stringify(parsed, null, 2));
      el.classList.add('json');
    } catch {
      el.innerHTML = renderMd(raw);
      el.classList.add('md');
    }
  });

  // ── Render markdown in bubbles ──────────────────────────────────
  document.querySelectorAll('.bubble[data-md]').forEach(el => {
    el.innerHTML = renderMd(el.textContent.trim());
  });
  document.querySelectorAll('.bubble [data-md]').forEach(el => {
    el.innerHTML = renderMd(el.textContent.trim());
  });

  // ── Timestamps ─────────────────────────────────────────────────
  function fmtFull(iso) {
    return new Date(iso).toLocaleString(undefined, { month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit', second:'2-digit', hour12:true });
  }
  function fmtTime(iso) {
    return new Date(iso).toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit', second:'2-digit', hour12:true });
  }
  document.querySelectorAll('.turn-ts[data-iso]').forEach(el => el.textContent = fmtFull(el.dataset.iso));
  document.querySelectorAll('.p-ts[data-iso]').forEach(el => el.textContent = fmtTime(el.dataset.iso));

  // ── Toggle entries ──────────────────────────────────────────────
  function toggle(e, el) {
    if (e.target.closest('.entry-body')) return;
    el.classList.toggle('open');
  }

  // ── Lightbox ────────────────────────────────────────────────────
  function openLightbox(el) {
    document.getElementById('lightbox-img').src = el.querySelector('img').src;
    document.getElementById('lightbox').classList.add('open');
  }
  function closeLightbox() {
    document.getElementById('lightbox').classList.remove('open');
  }
</script>
</body>
</html>`;
}
```

- [ ] **Step 2: Verify compile**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/transcriptPanel.ts
git commit -m "feat: implement transcript preview webview HTML"
```

---

## Task 7: Wire Up webviewProvider

**Files:**
- Modify: `src/webviewProvider.ts`

- [ ] **Step 1: Add import for transcriptPanel at the top of `webviewProvider.ts`**

Find the existing imports (around line 1–6) and add:

```typescript
import { openTranscriptPreview, evict } from './transcriptPanel';
```

- [ ] **Step 2: Add `previewTranscript` case to `handleMessage`**

Find the `switch (command)` block in `handleMessage`. Add a new case before the closing brace:

```typescript
case 'previewTranscript':
  openTranscriptPreview(agent);
  return;
```

- [ ] **Step 3: Call `evict` in `deleteAgent`**

Find the `deleteAgent` method. After `await fsp.unlink(agent.transcriptPath);` succeeds, add:

```typescript
evict(agent.sessionId);
```

The full success block should look like:

```typescript
try {
  await fsp.unlink(agent.transcriptPath);
  evict(agent.sessionId);
} catch (err) {
  vscode.window.showErrorMessage(
    `Failed to delete transcript: ${(err as Error).message}`,
  );
}
```

- [ ] **Step 4: Add the 💬 button in `renderCard`**

Find this line in the webview JS (inside the `renderCard` function string, around line 521):

```javascript
'<button class="action-btn" data-act="viewTranscript" title="View transcript">\u{1f4c4}</button>' +
```

Change it to add the 💬 button before it:

```javascript
'<button class="action-btn" data-act="previewTranscript" title="Preview transcript">\u{1f4ac}</button>' +
'<button class="action-btn" data-act="viewTranscript" title="View raw JSONL">\u{1f4c4}</button>' +
```

(`\u{1f4ac}` is 💬)

- [ ] **Step 5: Render nested subagents in `renderCard`**

Find the `renderCard` function in the webview JS. After the `renderDetails(a, now)` call and before the closing `'</div>'`, add subagent rendering:

```javascript
function renderCard(a, now, indent) {
  indent = indent || 0;
  const stopBtn = a.state === 'running'
    ? '<button class="action-btn danger" data-act="stop" title="Stop agent">\u25a0</button>'
    : '';
  const isOpen = expanded.has(a.sessionId);
  const subHtml = (a.subagents || []).map(s => renderCard(s, now, indent + 1)).join('');
  return '<div class="card' + (isOpen ? ' expanded' : '') + (indent > 0 ? ' subagent-card' : '') + '" data-sid="' + esc(a.sessionId) + '" style="' + (indent > 0 ? 'margin-left:16px;border-left:2px solid var(--vscode-panel-border);' : '') + '">' +
    '<div class="card-top">' +
      '<div class="card-info">' +
        '<div class="card-name">' +
          '<span class="status-dot ' + esc(a.state) + '"></span>' +
          esc(a.projectName) +
          (indent > 0 ? '<span style="font-size:10px;opacity:0.6;margin-left:4px;">subagent</span>' : '') +
          '<span class="chev">\u25b8</span>' +
        '</div>' +
        '<div class="card-meta">' + esc(a.activity) + ' \u00b7 ' + esc(relTime(a.mtimeMs, now)) + '</div>' +
      '</div>' +
      '<div class="card-actions">' +
        '<button class="action-btn" data-act="previewTranscript" title="Preview transcript">\u{1f4ac}</button>' +
        '<button class="action-btn" data-act="viewTranscript" title="View raw JSONL">\u{1f4c4}</button>' +
        '<button class="action-btn" data-act="openFolder" title="Open project folder">\u{1f4c1}</button>' +
        stopBtn +
        '<button class="action-btn danger" data-act="delete" title="Delete transcript">\u2715</button>' +
      '</div>' +
    '</div>' +
    renderDetails(a, now) +
    subHtml +
  '</div>';
}
```

- [ ] **Step 6: Filter subagents from top-level render**

Find the `render(agents, now)` function in the webview JS. Find where agents are split by state (running/idle/done). Add a filter to exclude subagents from the top-level list:

```javascript
function render(agents, now) {
  // Drop expanded-state entries for agents that no longer exist
  const live = new Set(agents.map(a => a.sessionId));
  for (const sid of expanded) if (!live.has(sid)) expanded.delete(sid);

  // Only top-level agents in the group lists
  const topLevel = agents.filter(a => !a.parentSessionId);
  const running = topLevel.filter(a => a.state === 'running');
  const idle    = topLevel.filter(a => a.state === 'idle');
  const done    = topLevel.filter(a => a.state === 'done');
  // ... rest unchanged
```

> Note: find the existing lines that split agents into running/idle/done arrays and prepend the `topLevel` filter. The exact lines in the current file create `running`, `idle`, `done` directly from `agents` — replace those assignments with the two-step version above.

- [ ] **Step 7: Verify compile**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 8: Run all tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/webviewProvider.ts
git commit -m "feat: add transcript preview button and subagent nesting in tree view"
```

---

## Task 8: Manual Verification

- [ ] **Step 1: Build the extension**

```bash
npm run build
```

Expected: no errors, `dist/extension.js` updated.

- [ ] **Step 2: Launch extension in VS Code**

Press `F5` in VS Code (or run "Run Extension" from the Run panel). A new Extension Development Host window opens.

- [ ] **Step 3: Verify 💬 button opens transcript preview**

In the Extension Development Host, open the Agents panel in the activity bar. Click 💬 on any session. Expected: a webview panel opens titled "💬 <projectName>" showing chat-style turns.

- [ ] **Step 4: Verify 📄 button still opens raw JSONL**

Click 📄 on the same session. Expected: the raw `.jsonl` file opens as a text document in the editor.

- [ ] **Step 5: Verify subagent nesting**

If any subagent sessions exist under `~/.claude/projects/`, verify they appear indented under their parent card with a "subagent" label and their own 💬/📄 buttons.

- [ ] **Step 6: Verify delete evicts the panel**

Open the 💬 preview for a session, then delete the session via the ✕ button. Expected: the preview panel closes.

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "chore: verify agent-viewer enhancements complete"
```
