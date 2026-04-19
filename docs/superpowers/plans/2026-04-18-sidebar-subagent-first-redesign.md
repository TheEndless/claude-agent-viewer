# Sidebar Subagent-First Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the agent-viewer sidebar from a state-bucketed card layout to a flat, parent-first explorer tree where subagents are visible by default under their parent session.

**Architecture:** Top-level sessions are collapsible rows sorted by most-recent activity; subagents appear as indented rows beneath their parent with no further nesting. Done sessions are hidden behind an "Show archive" toggle at the bottom. A new `taskDescription` field on `Agent` is populated from the parent's `Agent` tool_use `input.description` during the tree-build pass.

**Tech Stack:** TypeScript, VSCode Extension API, inline webview HTML/CSS/JS (no external deps), Vitest for unit tests.

**Spec:** `docs/superpowers/specs/2026-04-18-sidebar-subagent-first-redesign.md`

---

## File Map

| File | Change |
|------|--------|
| `src/types.ts` | Add `taskDescription?: string` and `agentCallDescs?: string[]` to `Agent` |
| `src/agentService.ts` | Update `extractDetails` return type; add `assignTaskDescriptions`; wire into `scheduleEmit` + `reclassifyAll` |
| `src/test/agentService.test.ts` | New — unit tests for `assignTaskDescriptions` |
| `src/webviewProvider.ts` | Update `postAgents` serialize; replace all CSS + render functions + click handler |

---

### Task 1: Add `taskDescription` and `agentCallDescs` to the `Agent` type

**Files:**
- Modify: `src/types.ts:15-27`

- [ ] **Step 1: Edit `src/types.ts`** — add two optional fields to the `Agent` interface (after `subagents`):

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
  parentSessionId?: string;
  subagents: Agent[];
  taskDescription?: string;   // set during tree-build; shown in sidebar as subagent label
  agentCallDescs?: string[];  // descriptions from this agent's own Agent tool_use calls; NOT serialized to webview
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd d:/Development/ai/agent-viewer && npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): add taskDescription and agentCallDescs to Agent"
```

---

### Task 2: Collect Agent call descriptions in `extractDetails`

**Files:**
- Modify: `src/agentService.ts:248-282` (the `extractDetails` function and its call site in `buildAgent`)

- [ ] **Step 1: Write a test for the new extraction logic**

Create `src/test/agentService.test.ts`:

```typescript
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
    // no error thrown, no taskDescription set on parent itself
    expect(parent.taskDescription).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd d:/Development/ai/agent-viewer && npx vitest run src/test/agentService.test.ts
```

Expected: FAIL — `assignTaskDescriptionsForTesting` is not exported.

- [ ] **Step 3: Update `extractDetails` in `src/agentService.ts`**

Change the function signature and body to return both `AgentDetails` and `agentCallDescs`. Find the current `extractDetails` function (around line 248) and replace it entirely:

```typescript
function extractDetails(events: RawEvent[]): { details: AgentDetails; agentCallDescs: string[] } {
  const trail: ToolCallSummary[] = [];
  const files: string[] = [];
  let latestUserPrompt: string | null = null;
  let subagentCount = 0;
  const agentCallDescs: string[] = [];

  for (const evt of events) {
    const type = typeof evt.type === 'string' ? evt.type : '';
    const content = evt.message?.content;

    if (type === 'assistant' && Array.isArray(content)) {
      const ts = typeof evt.timestamp === 'string' ? Date.parse(evt.timestamp) || 0 : 0;
      for (const part of content) {
        if (!isToolUse(part)) continue;
        const name = typeof part.name === 'string' ? part.name : 'Tool';
        trail.push({ summary: labelForToolUse(name, part.input), at: ts });
        const filePath = part.input?.file_path;
        if (typeof filePath === 'string') files.push(filePath);
        if (name === 'Agent') {
          subagentCount += 1;
          if (typeof part.input?.description === 'string' && part.input.description) {
            agentCallDescs.push(part.input.description);
          }
        }
      }
    }

    if (type === 'user') {
      const text = extractUserText(content);
      if (text) latestUserPrompt = truncate(text, 200);
    }
  }

  return {
    details: {
      recentToolCalls: trail.slice(-MAX_TRAIL).reverse(),
      recentFiles: dedupeLastN(files, MAX_FILES),
      latestUserPrompt,
      subagentCount,
    },
    agentCallDescs,
  };
}
```

- [ ] **Step 4: Update `buildAgent` to use the new return shape and store `agentCallDescs`**

Replace `buildAgent` (around line 136):

```typescript
function buildAgent(filePath: string, mtimeMs: number, events: RawEvent[]): Agent {
  const sessionId = sessionIdFromPath(filePath);
  const cwd = resolveCwd(filePath, events);
  const projectName = path.basename(cwd);
  const terminated = events.some(isTerminator);
  const state = classifyState(mtimeMs, Date.now(), terminated);
  const activity = deriveActivity(events, state);
  const { details, agentCallDescs } = extractDetails(events);
  return { sessionId, transcriptPath: filePath, cwd, projectName, state, activity, mtimeMs, details, subagents: [], agentCallDescs };
}
```

- [ ] **Step 5: Add `assignTaskDescriptions` function and export alias for tests**

Add after the `buildAgent` function:

```typescript
function assignTaskDescriptions(agents: Map<string, Agent>): void {
  for (const parent of agents.values()) {
    if (!parent.subagents.length) continue;
    const descs = parent.agentCallDescs ?? [];
    const sorted = [...parent.subagents].sort((a, b) => a.mtimeMs - b.mtimeMs);
    sorted.forEach((sub, i) => {
      sub.taskDescription = descs[i]
        ?? sub.details.latestUserPrompt
        ?? sub.sessionId.slice(0, 8);
    });
  }
}

/** Exported only for unit testing. */
export const assignTaskDescriptionsForTesting = assignTaskDescriptions;
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd d:/Development/ai/agent-viewer && npx vitest run src/test/agentService.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 7: Verify full test suite still passes**

```bash
cd d:/Development/ai/agent-viewer && npx vitest run
```

Expected: all tests pass (agentTree tests + new agentService tests + transcriptParser tests).

- [ ] **Step 8: Verify TypeScript**

```bash
cd d:/Development/ai/agent-viewer && npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 9: Commit**

```bash
git add src/agentService.ts src/test/agentService.test.ts
git commit -m "feat(agentService): collect Agent call descriptions and assign taskDescription to subagents"
```

---

### Task 3: Wire `assignTaskDescriptions` into `scheduleEmit` and `reclassifyAll`

**Files:**
- Modify: `src/agentService.ts` — `scheduleEmit` and `reclassifyAll` methods

- [ ] **Step 1: Update `scheduleEmit`**

Find `scheduleEmit` (around line 103) and add the `assignTaskDescriptions` call after `buildTree`:

```typescript
private scheduleEmit(): void {
  if (this.debounceTimer) clearTimeout(this.debounceTimer);
  this.debounceTimer = setTimeout(() => {
    buildTree(this.agents);
    assignTaskDescriptions(this.agents);
    this._onDidChange.fire(this.getAgents());
  }, DEBOUNCE_MS);
}
```

- [ ] **Step 2: Update `reclassifyAll`**

Find `reclassifyAll` (around line 111) and add the `assignTaskDescriptions` call after `buildTree`:

```typescript
private reclassifyAll(): void {
  const now = Date.now();
  let changed = false;
  for (const [id, agent] of this.agents) {
    const hasActiveSubagent = agent.subagents.some(s => s.state === 'running');
    const nextState = classifyState(agent.mtimeMs, now, agent.state === 'done', hasActiveSubagent);
    if (nextState !== agent.state) {
      this.agents.set(id, { ...agent, state: nextState });
      changed = true;
    }
  }
  if (changed) {
    buildTree(this.agents);
    assignTaskDescriptions(this.agents);
    this._onDidChange.fire(this.getAgents());
  }
}
```

- [ ] **Step 3: Verify TypeScript**

```bash
cd d:/Development/ai/agent-viewer && npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add src/agentService.ts
git commit -m "feat(agentService): wire assignTaskDescriptions into scheduleEmit and reclassifyAll"
```

---

### Task 4: Update `postAgents` serialization in `webviewProvider.ts`

**Files:**
- Modify: `src/webviewProvider.ts:54-65` (the `serialize` function inside `postAgents`)

- [ ] **Step 1: Add `taskDescription` to the serialized payload**

Replace the `serialize` arrow function in `postAgents`:

```typescript
const serialize = (a: Agent): object => ({
  sessionId: a.sessionId,
  projectName: a.projectName,
  cwd: a.cwd,
  state: a.state,
  activity: a.activity,
  mtimeMs: a.mtimeMs,
  details: a.details,
  parentSessionId: a.parentSessionId,
  taskDescription: a.taskDescription,
  subagents: a.subagents.map(serialize),
});
```

Note: `agentCallDescs` is intentionally NOT included — it's a build-time intermediate field only.

- [ ] **Step 2: Verify TypeScript**

```bash
cd d:/Development/ai/agent-viewer && npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/webviewProvider.ts
git commit -m "feat(webview): serialize taskDescription in postAgents payload"
```

---

### Task 5: Replace CSS in `webviewProvider.ts` with Explorer-tree styles

**Files:**
- Modify: `src/webviewProvider.ts` — the `<style>` block inside `getHtml()` (lines ~177-487)

- [ ] **Step 1: Replace the entire `<style>` block**

Find the opening `<style>` tag (line ~176) through the closing `</style>` tag (line ~487) and replace with:

```css
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      padding: 0 0 16px;
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 8px 6px;
      position: sticky;
      top: 0;
      background: var(--vscode-sideBar-background);
      z-index: 10;
    }
    .header h2 {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-sideBarSectionHeader-foreground);
    }
    .header-refresh {
      background: none;
      border: none;
      color: var(--vscode-icon-foreground);
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 3px;
      opacity: 0;
      font-size: 13px;
      transition: opacity 0.1s;
    }
    .header:hover .header-refresh { opacity: 0.7; }
    .header-refresh:hover { opacity: 1 !important; background: var(--vscode-toolbar-hoverBackground); }

    .empty-global {
      text-align: center;
      padding: 24px 12px;
      color: var(--vscode-disabledForeground);
      font-size: 12px;
    }

    /* ── status dot ─────────────────────────────────────── */
    .status-dot {
      flex-shrink: 0;
      width: 7px;
      height: 7px;
      border-radius: 50%;
    }
    .status-dot.running { background: #3fb950; box-shadow: 0 0 4px rgba(63,185,80,0.5); }
    .status-dot.idle    { background: #d29922; }
    .status-dot.done    { background: #6e7681; }

    /* ── caret ──────────────────────────────────────────── */
    .row-caret {
      flex-shrink: 0;
      width: 16px;
      height: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.12s ease;
      color: var(--vscode-icon-foreground);
      opacity: 0.6;
    }
    .parent-row.open > .parent-header > .row-caret,
    .archive-section.open > .archive-row > .row-caret { transform: rotate(90deg); }

    /* ── parent row ─────────────────────────────────────── */
    .parent-header {
      display: flex;
      align-items: center;
      height: 22px;
      padding: 0 8px;
      gap: 4px;
      cursor: pointer;
      user-select: none;
      border-radius: 2px;
    }
    .parent-header:hover { background: var(--vscode-list-hoverBackground); }
    .parent-header:hover .count-chip  { display: none; }
    .parent-header:hover .row-time    { display: none; }
    .parent-header:hover .row-actions { opacity: 1; }

    .parent-prompt {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
      font-size: 13px;
      font-weight: 500;
      color: var(--vscode-foreground);
    }
    .parent-prompt.no-prompt { color: var(--vscode-disabledForeground); }

    .count-chip {
      font-size: 10px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      padding: 0 5px;
      border-radius: 8px;
      line-height: 15px;
      min-width: 16px;
      text-align: center;
      flex-shrink: 0;
    }

    .row-time {
      font-size: 10px;
      color: var(--vscode-disabledForeground);
      flex-shrink: 0;
    }

    /* ── parent body (secondary line + subagent rows) ───── */
    .parent-body { display: none; }
    .parent-row.open > .parent-body { display: block; }

    .parent-secondary {
      display: flex;
      align-items: center;
      height: 18px;
      padding: 0 8px 0 20px;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      overflow: hidden;
      white-space: nowrap;
    }
    .parent-secondary .proj-path {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      direction: rtl;
      unicode-bidi: plaintext;
    }
    .parent-secondary .sep {
      flex-shrink: 0;
      padding: 0 4px;
      color: var(--vscode-disabledForeground);
    }
    .parent-secondary .p-mtime {
      flex-shrink: 0;
      color: var(--vscode-disabledForeground);
    }

    /* ── subagent rows ──────────────────────────────────── */
    .subagent-row {
      display: flex;
      align-items: center;
      height: 22px;
      padding: 0 8px 0 20px;
      gap: 4px;
      cursor: pointer;
      user-select: none;
      border-radius: 2px;
    }
    .subagent-row:hover { background: var(--vscode-list-hoverBackground); }
    .subagent-row:hover .row-time    { display: none; }
    .subagent-row:hover .row-actions { opacity: 1; }
    .subagent-row.done-sub { opacity: 0.6; }

    .sub-task {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
      font-size: 12px;
      color: var(--vscode-foreground);
    }

    /* ── hover action buttons ───────────────────────────── */
    .row-actions {
      display: flex;
      align-items: center;
      gap: 2px;
      opacity: 0;
      flex-shrink: 0;
    }
    .action-btn {
      background: none;
      border: none;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      padding: 2px 3px;
      border-radius: 4px;
      font-size: 12px;
      display: flex;
      align-items: center;
    }
    .action-btn:hover {
      background: var(--vscode-toolbar-hoverBackground);
      color: var(--vscode-foreground);
    }
    .action-btn.danger:hover { color: #f85149; }

    /* ── archive section ────────────────────────────────── */
    .archive-divider {
      border: none;
      border-top: 1px solid var(--vscode-input-border, rgba(128,128,128,0.2));
      margin: 6px 0 2px;
    }
    .archive-row {
      display: flex;
      align-items: center;
      height: 22px;
      padding: 0 8px;
      gap: 4px;
      cursor: pointer;
      user-select: none;
      border-radius: 2px;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }
    .archive-row:hover { background: var(--vscode-list-hoverBackground); }
    .archive-label { flex: 1; }
    .archive-count { color: var(--vscode-disabledForeground); flex-shrink: 0; }

    .archive-body { display: none; opacity: 0.6; }
    .archive-section.open > .archive-body { display: block; }
```

- [ ] **Step 2: Verify TypeScript compiles** (CSS changes don't affect TS, but verify the file parses):

```bash
cd d:/Development/ai/agent-viewer && npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/webviewProvider.ts
git commit -m "feat(webview): replace card CSS with Explorer-tree CSS for subagent-first sidebar"
```

---

### Task 6: Replace JavaScript state variables and helper functions in the webview

**Files:**
- Modify: `src/webviewProvider.ts` — the `<script>` block inside `getHtml()`

This task replaces the top portion of the script block: state variables (`openSections`, `expanded`, `subExpanded`), `esc`, `relTime`, `detailRow`, `muted`, `renderTrail`, `renderFiles`, `renderDetails`, `renderCard`, and the `CARET` constant.

- [ ] **Step 1: Replace the state declarations and utility functions**

Find the opening `<script>` tag and replace everything from `const vscode = acquireVsCodeApi();` through the end of the `CARET` constant definition (before `renderSubGroup`):

```javascript
    const vscode = acquireVsCodeApi();
    const root = document.getElementById('root');

    // Preserved expand state: keys are 'parent:<sessionId>' and 'archive'.
    const openSections = {};

    function esc(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function relTimeShort(ms, now) {
      const d = now - ms;
      if (d < 10000) return 'now';
      if (d < 60000) return Math.floor(d / 1000) + 's';
      if (d < 3600000) return Math.floor(d / 60000) + 'm';
      if (d < 86400000) return Math.floor(d / 3600000) + 'h';
      return Math.floor(d / 86400000) + 'd';
    }

    function parentEffectiveState(p) {
      const subs = p.subagents || [];
      if (p.state === 'running' || subs.some(s => s.state === 'running')) return 'running';
      if (p.state === 'idle'    || subs.some(s => s.state === 'idle'))    return 'idle';
      return 'done';
    }

    function parentMaxMtime(p) {
      const subs = p.subagents || [];
      return subs.reduce((m, s) => Math.max(m, s.mtimeMs), p.mtimeMs);
    }

    const CARET = '<span class="row-caret"><svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd d:/Development/ai/agent-viewer && npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/webviewProvider.ts
git commit -m "feat(webview): replace state vars and helpers with subagent-first equivalents"
```

---

### Task 7: Replace render functions in the webview script

**Files:**
- Modify: `src/webviewProvider.ts` — the render functions section of the `<script>` block

This task replaces `renderSubGroup`, `renderProjectSection`, `renderTopSection`, and `render` with `renderSubagentRow`, `renderParent`, `renderArchive`, and a new `render`.

- [ ] **Step 1: Replace all render functions**

Remove the old render functions (`renderSubGroup`, `renderProjectSection`, `renderTopSection`, `render`) and replace with:

```javascript
    function renderSubagentRow(sub, now) {
      const task = sub.taskDescription || sub.details?.latestUserPrompt || sub.sessionId.slice(0, 8);
      const doneCls = sub.state === 'done' ? ' done-sub' : '';
      const stopBtn = sub.state === 'running'
        ? '<button class="action-btn danger" data-act="stop" title="Stop">\u25a0</button>'
        : '';
      return '<div class="subagent-row' + doneCls + '" data-sid="' + esc(sub.sessionId) + '">' +
        '<span class="status-dot ' + esc(sub.state) + '"></span>' +
        '<span class="sub-task">' + esc(task) + '</span>' +
        '<span class="row-time">\u00b7 ' + relTimeShort(sub.mtimeMs, now) + '</span>' +
        '<div class="row-actions">' +
          '<button class="action-btn" data-act="previewTranscript" title="Preview">\ud83d\udcac</button>' +
          '<button class="action-btn" data-act="openFolder" title="Open folder">\ud83d\udcc1</button>' +
          stopBtn +
          '<button class="action-btn danger" data-act="delete" title="Delete">\u2715</button>' +
        '</div>' +
      '</div>';
    }

    function renderParent(parent, now) {
      const key = 'parent:' + parent.sessionId;
      const subs = parent.subagents || [];
      const effState = parentEffectiveState(parent);
      const defaultOpen = effState === 'running' && subs.length > 0;
      const open = openSections[key] !== undefined ? openSections[key] : defaultOpen;

      const prompt = parent.details && parent.details.latestUserPrompt;
      const promptHtml = prompt
        ? '<span class="parent-prompt">' + esc(prompt) + '</span>'
        : '<span class="parent-prompt no-prompt">(no prompt yet)</span>';

      const countHtml = subs.length > 0
        ? '<span class="count-chip">' + subs.length + '</span>'
        : '';

      const stopBtn = effState === 'running'
        ? '<button class="action-btn danger" data-act="stop" title="Stop">\u25a0</button>'
        : '';

      const subRows = subs.slice().sort((a, b) => b.mtimeMs - a.mtimeMs)
        .map(s => renderSubagentRow(s, now)).join('');

      return '<div class="parent-row' + (open ? ' open' : '') + '" data-key="' + esc(key) + '" data-sid="' + esc(parent.sessionId) + '">' +
        '<div class="parent-header">' +
          CARET +
          '<span class="status-dot ' + effState + '"></span>' +
          promptHtml +
          countHtml +
          '<span class="row-time">\u00b7 ' + relTimeShort(parentMaxMtime(parent), now) + '</span>' +
          '<div class="row-actions">' +
            '<button class="action-btn" data-act="previewTranscript" title="Preview">\ud83d\udcac</button>' +
            '<button class="action-btn" data-act="openFolder" title="Open folder">\ud83d\udcc1</button>' +
            stopBtn +
            '<button class="action-btn danger" data-act="delete" title="Delete">\u2715</button>' +
          '</div>' +
        '</div>' +
        '<div class="parent-body">' +
          '<div class="parent-secondary">' +
            '<span class="proj-path">' + esc(parent.cwd) + '</span>' +
            '<span class="sep">\u00b7</span>' +
            '<span class="p-mtime">' + relTimeShort(parent.mtimeMs, now) + '</span>' +
          '</div>' +
          subRows +
        '</div>' +
      '</div>';
    }

    function renderArchive(doneParents, now) {
      const open = openSections['archive'] || false;
      const count = doneParents.length;
      return '<hr class="archive-divider">' +
        '<div class="archive-section' + (open ? ' open' : '') + '" data-key="archive">' +
          '<div class="archive-row">' +
            CARET +
            '<span class="archive-label">' + (open ? 'Hide archive' : 'Show archive') + '</span>' +
            '<span class="archive-count">' + count + ' session' + (count !== 1 ? 's' : '') + '</span>' +
          '</div>' +
          '<div class="archive-body">' +
            doneParents.map(p => renderParent(p, now)).join('') +
          '</div>' +
        '</div>';
    }

    function render(agents, now, ready) {
      if (!agents || agents.length === 0) {
        root.className = 'empty-global';
        root.innerHTML = ready
          ? 'No agents yet \u2014 run <code>claude</code> in any project'
          : 'Scanning\u2026';
        return;
      }
      root.className = '';

      const parents = agents.filter(a => !a.parentSessionId);

      // A done parent with a running subagent stays in the primary list.
      const primary = parents.filter(p =>
        parentEffectiveState(p) !== 'done' || (p.subagents || []).some(s => s.state === 'running')
      );
      const archive = parents.filter(p =>
        parentEffectiveState(p) === 'done' && !(p.subagents || []).some(s => s.state === 'running')
      );

      primary.sort((a, b) => parentMaxMtime(b) - parentMaxMtime(a));
      archive.sort((a, b) => b.mtimeMs - a.mtimeMs);

      root.innerHTML = primary.map(p => renderParent(p, now)).join('') + renderArchive(archive, now);
    }
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd d:/Development/ai/agent-viewer && npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/webviewProvider.ts
git commit -m "feat(webview): replace render functions with subagent-first renderParent/renderSubagentRow/renderArchive"
```

---

### Task 8: Replace the click handler in the webview script

**Files:**
- Modify: `src/webviewProvider.ts` — the `root.addEventListener('click', ...)` block

- [ ] **Step 1: Replace the click handler**

Find the `root.addEventListener('click', ...)` block and replace it entirely:

```javascript
    root.addEventListener('click', (e) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;

      // Action buttons — handle first so they don't fall through to row clicks.
      const btn = target.closest('[data-act]');
      if (btn) {
        const sid = btn.closest('[data-sid]') && btn.closest('[data-sid]').getAttribute('data-sid');
        if (sid) vscode.postMessage({ command: btn.getAttribute('data-act'), sessionId: sid });
        return;
      }

      // Archive toggle row.
      const archiveRow = target.closest('.archive-row');
      if (archiveRow) {
        const section = archiveRow.closest('.archive-section');
        if (!section) return;
        const isOpen = section.classList.toggle('open');
        openSections['archive'] = isOpen;
        const lbl = archiveRow.querySelector('.archive-label');
        if (lbl) lbl.textContent = isOpen ? 'Hide archive' : 'Show archive';
        return;
      }

      // Parent header: caret area toggles expand; rest opens preview.
      const parentHeader = target.closest('.parent-header');
      if (parentHeader) {
        const parentRow = parentHeader.closest('.parent-row');
        if (!parentRow) return;
        if (target.closest('.row-caret')) {
          const key = parentRow.dataset.key;
          const isOpen = parentRow.classList.toggle('open');
          if (key) openSections[key] = isOpen;
          return;
        }
        // Non-caret area: open preview.
        const sid = parentRow.getAttribute('data-sid');
        if (sid) vscode.postMessage({ command: 'previewTranscript', sessionId: sid });
        return;
      }

      // Subagent row: click opens preview.
      const subRow = target.closest('.subagent-row');
      if (subRow) {
        const sid = subRow.getAttribute('data-sid');
        if (sid) vscode.postMessage({ command: 'previewTranscript', sessionId: sid });
        return;
      }
    });
```

- [ ] **Step 2: Also update the header HTML** to use a button for refresh (find and replace the header `<div>` inside `getHtml()`):

Find:
```html
  <div class="header">
    <h2>Agents</h2>
    <span class="auto-refresh-indicator" title="Auto-refreshing every 5s"><span class="pulse"></span></span>
  </div>
```

Replace with:
```html
  <div class="header">
    <h2>Agents</h2>
    <button class="header-refresh" id="refresh-btn" title="Refresh">&#x21bb;</button>
  </div>
```

- [ ] **Step 3: Add the refresh button click handler** — add after the `root.addEventListener('click', ...)` block and before the `window.addEventListener('message', ...)` block:

```javascript
    document.getElementById('refresh-btn').addEventListener('click', () => {
      vscode.postMessage({ command: 'refresh' });
    });
```

- [ ] **Step 4: Handle the `refresh` command** in `webviewProvider.ts` `handleMessage`:

In the `switch (command)` block inside `handleMessage`, the refresh command doesn't need a sessionId check. Update `handleMessage` to handle it before the `if (!sessionId) return` guard:

```typescript
private async handleMessage(message: { command: string; sessionId?: string }): Promise<void> {
  const { command, sessionId } = message;

  if (command === 'refresh') {
    this.postAgents();
    return;
  }

  if (!sessionId) return;
  const agent = this.agentService.getAgents().find((a) => a.sessionId === sessionId);
  if (!agent) return;

  switch (command) {
    case 'previewTranscript':
      openTranscriptPreview(agent);
      return;
    case 'viewTranscript':
      await this.viewTranscript(agent);
      return;
    case 'openFolder':
      await this.openFolder(agent);
      return;
    case 'stop':
      await this.stopAgent(agent);
      return;
    case 'delete':
      await this.deleteAgent(agent);
      return;
  }
}
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd d:/Development/ai/agent-viewer && npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 6: Run full test suite**

```bash
cd d:/Development/ai/agent-viewer && npx vitest run
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/webviewProvider.ts
git commit -m "feat(webview): replace click handler with subagent-first logic; add refresh button"
```

---

### Task 9: Manual verification

**Files:** none — verification only.

Open the extension in VSCode Extension Development Host (`F5`) and verify:

- [ ] **Check 1: Primary list renders**
  - Running parents (with subagents) appear expanded by default, sorted by most-recent activity at top
  - Idle parents appear collapsed below running ones
  - Parent header shows: caret + colored dot + truncated latest user prompt + subagent count chip + relative time

- [ ] **Check 2: Subagent rows**
  - Subagents appear indented under their parent when parent is expanded
  - Subagent row shows: dot + task description (from `Agent` tool_use `description`) + time
  - Done subagents render at 60% opacity

- [ ] **Check 3: Archive**
  - "Show archive" row appears at bottom after a hairline divider
  - Count shows correct number of done sessions
  - Expanding archive shows done parents at 60% opacity
  - Label toggles to "Hide archive" when open

- [ ] **Check 4: Click behavior**
  - Clicking caret (leftmost 16px) toggles parent expand/collapse
  - Clicking anywhere else on parent header opens transcript preview
  - Clicking subagent row opens subagent's transcript preview
  - Hover reveals action buttons (preview, folder, delete) and hides count chip / time

- [ ] **Check 5: State persistence**
  - Expand/collapse state is preserved across auto-refresh re-renders (5s cycle)
  - Opening then collapsing a parent: stays collapsed on next render

- [ ] **Check 6: Empty project path RTL ellipsis**
  - Long project paths ellipsize from the start (RTL), not the end
  - No monospace font on path

- [ ] **Step 7: Final commit (if any fixes were needed)**

```bash
git add -A
git commit -m "fix(webview): manual verification fixes"
```
