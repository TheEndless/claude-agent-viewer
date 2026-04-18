# Agent Viewer Enhancements — Design Spec

**Date:** 2026-04-18
**Status:** Approved

## Overview

Three enhancements to the `agent-viewer` VS Code extension:

1. **Subagent nesting** — subagents detected by filesystem path and displayed nested under their parent session, independently expandable.
2. **Transcript preview panel** — a 💬 button opens a `vscode.window.createWebviewPanel()` showing the session as chat-style turns with markdown rendering, image thumbnails, and collapsible tool entries.
3. **Retain raw JSONL view** — the existing 📄 button continues to open the transcript as plain text in the editor.

---

## Files Changed

| File | Change |
|---|---|
| `src/types.ts` | Add `parentSessionId?`, `subagents[]` to `Agent`; add `Turn`, `TurnEntry`, `TurnAttachment` |
| `src/agentService.ts` | Tree-building pass after flat agent discovery |
| `src/webviewProvider.ts` | Nested card rendering; add 💬 button alongside existing 📄 |
| `src/transcriptParser.ts` | **New** — pure `parseTranscript(jsonlText): Turn[]` |
| `src/transcriptPanel.ts` | **New** — `createWebviewPanel` manager with parse-on-open cache |

No new npm dependencies.

---

## Data Model

### Agent (modified)

```typescript
export interface Agent {
  // ...existing fields unchanged...
  parentSessionId?: string;  // set if this agent is a subagent
  subagents: Agent[];        // populated during tree-build pass; empty array by default
}
```

### New types

```typescript
export interface TurnAttachment {
  type: 'image' | 'document';
  name?: string;
  mediaType?: string;  // image only — e.g. "image/png"
  data?: string;       // base64 for images; raw text for documents
}

export interface TurnEntry {
  kind: 'tool_use' | 'tool_result' | 'thinking' | 'system';
  label: string;       // e.g. "Bash · ls -la", "Result · Bash", "Thinking", "Session ended"
  timestamp: string;   // ISO 8601
  body: string;        // raw content — rendered as JSON or markdown depending on parseability
}

export interface Turn {
  role: 'user' | 'assistant';
  timestamp: string;         // ISO 8601 — from first event in the turn
  text?: string;             // markdown bubble text (may be absent for tool-only turns)
  attachments: TurnAttachment[];
  entries: TurnEntry[];      // tool_use/tool_result/thinking/system blocks; user turns have none
}
```

---

## Feature 1: Subagent Nesting

### Detection

Subagent transcripts live at:
```
~/.claude/projects/<project>/<parentSessionId>/subagents/<subagentId>.jsonl
```

The parent session ID is in the directory path — no JSONL content parsing required.

### Tree-building pass (agentService.ts)

After the existing flat `Map<string, Agent>` is fully populated, one additional pass:

```
for each agent in the map:
  if agent.transcriptPath matches pattern /<sessionId>/subagents/<subagentId>.jsonl:
    set agent.parentSessionId = sessionId
    find parent = map.get(sessionId)
    if parent exists: parent.subagents.push(agent)
    else: leave agent at top level (orphan — logged to output channel)
```

All agents remain in the flat map for direct lookup. `subagents[]` is a rendering concern only.

### Rendering (webviewProvider.ts)

- Top-level list filters out agents where `parentSessionId` is set.
- Each parent card renders its `subagents[]` below its own content, indented, using the same card component.
- Subagent expand/collapse state is tracked independently in the existing `expanded` Set using `subagentId`.

---

## Feature 2: Transcript Preview Panel

### Parser (transcriptParser.ts)

```typescript
export function parseTranscript(jsonlText: string): Turn[]
```

Pure function, no VS Code dependencies. Algorithm:

1. Split on newlines, `JSON.parse` each line inside try/catch — malformed lines are silently skipped.
2. Group events into turns by role: a new turn begins when `event.message.role` changes from the previous non-null role.
3. For each **user** turn:
   - Walk `message.content[]` blocks.
   - `{ type: 'text' }` → concatenate to `turn.text`.
   - `{ type: 'image', source: { type: 'base64' } }` → push `TurnAttachment { type: 'image', mediaType, data }`.
   - `{ type: 'document', source: { type: 'text' } }` → push `TurnAttachment { type: 'document', data: source.data }`.
4. For each **assistant** turn:
   - `{ type: 'text' }` content blocks → `turn.text`.
   - `{ type: 'thinking' }` → `TurnEntry { kind: 'thinking', label: 'Thinking', body: content.thinking }`.
   - `{ type: 'tool_use' }` → `TurnEntry { kind: 'tool_use', label: labelForToolUse(name, input), body: JSON.stringify(input) }`.
   - In the Claude JSONL format, tool results arrive in the *following user event* as `content[].type === 'tool_result'` blocks (not in the assistant event). When a user event contains only `tool_result` blocks (no `text` or `image` content), it is not rendered as a user turn — instead, each `tool_result` block is appended as a `TurnEntry { kind: 'tool_result' }` to the preceding assistant turn, matched by `tool_use_id`.
5. `type: 'summary'` events → `TurnEntry { kind: 'system', label: 'Session ended', body: JSON.stringify(event) }` appended to the last assistant turn (or a synthetic one if none exists).

### Cache (transcriptPanel.ts)

```typescript
const cache = new Map<string, {
  turns: Turn[];
  mtimeMs: number;
}>();
```

- On open: if `cache.get(sessionId)?.mtimeMs === agent.mtimeMs`, use cached turns. Otherwise read + parse + store.
- Cache entries are evicted via `transcriptPanel.evict(sessionId)`, called from `webviewProvider.ts` in the existing delete handler (which already coordinates the unlink).
- No TTL — sessions don't change after `state === 'done'`; running sessions invalidate naturally via `mtimeMs`.

### Panel management (transcriptPanel.ts)

- One `WebviewPanel` per session, tracked in `Map<string, vscode.WebviewPanel>`.
- Re-opening a session whose panel is still open calls `panel.reveal()` instead of creating a new one.
- Panel `onDidDispose` removes it from the map.

### Webview HTML

- All `--vscode-*` CSS custom properties come from the real webview context — none hardcoded.
- Inline `renderMd(raw: string): string` covers: fenced code blocks, headings (h1–h3), blockquotes, unordered/ordered lists, bold, italic, inline code, links, paragraphs. No CDN dependency.
- Inline `jsonHL(str: string): string` for JSON syntax coloring using `--json-key/str/num/bool` custom vars.
- Image attachments rendered as `<img src="data:<mediaType>;base64,<data>">` with click-to-lightbox.
- Document attachments rendered as file chips (name + size).
- Timestamps use `data-iso` attributes resolved to `toLocaleString()` in client JS.

### Message protocol additions

**Webview → Extension (new):**
```
{ command: 'previewTranscript', sessionId: string }
```

**No new Extension → Webview messages** — the panel is self-contained from initial HTML.

---

## Feature 3: Retain Raw JSONL View

No logic changes. The existing `viewTranscript` command and `📄` button are unchanged. The `💬` button is added alongside it in `webviewProvider.ts`, sending `previewTranscript` instead of `viewTranscript`.

---

## Error Handling

| Scenario | Handling |
|---|---|
| Malformed JSONL line | Skipped silently; parser continues |
| Unreadable transcript file | Panel shows error state: "Could not read transcript" |
| Subagent with no matching parent | Agent rendered at top level; warning logged to extension output channel |
| Panel disposed before parse completes | No action needed — parse is synchronous; panel is checked for disposal before `postMessage` |
| Image data URI too large to render | Browser handles gracefully; no extension-side size limit imposed |

---

## Testing

- **`transcriptParser.ts`** is a pure function and can be unit tested without VS Code:
  - Happy path: user text, assistant text + tools, image attachment, document attachment, summary event
  - Malformed lines interspersed with valid lines
  - Unclosed tool_use (no matching tool_result)
  - Empty file
- **Subagent detection**: unit test the tree-building pass with mock path strings
- **Cache invalidation**: unit test that stale `mtimeMs` triggers re-parse
- **UI**: manual verification using real session transcripts from `~/.claude/projects/`
