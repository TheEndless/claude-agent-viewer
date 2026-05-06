/**
 * transcriptPanel.ts
 *
 * Manages VS Code webview panels that render Claude Code JSONL transcripts as
 * a chat-style conversation view. Each open panel corresponds to one agent
 * session. Panels stream content in tail-first chunks so long sessions feel
 * responsive, and update incrementally as the underlying transcript file grows.
 */

import * as vscode from 'vscode';
import * as fsp from 'fs/promises';
import MarkdownIt from 'markdown-it';
import { Agent, Turn, TurnEntry, TurnAttachment } from './types';
import { parseTranscript } from './transcriptParser';
import { logError } from './logger';

const md     = new MarkdownIt({ html: false, linkify: true, typographer: true });
const mdUser = new MarkdownIt({ html: false, linkify: true, typographer: true, breaks: true });

/** Derives the webview panel tab title from the session's best available name. */
function transcriptTabTitle(agent: Agent): string {
  const d = agent.details;
  const name = d.customTitle || d.aiTitle || d.latestUserPrompt || d.lastPrompt || agent.sessionId.slice(0, 8);
  return name.length > 40 ? name.slice(0, 39) + '…' : name;
}

/** Valid modes for webview update messages. */
type IpcMode = 'replace' | 'append' | 'prepend' | 'diag';

/** Posts an update message to the webview with a compile-time-checked mode. */
function postUpdate(webview: vscode.Webview, html: string, mode: IpcMode): void {
  webview.postMessage({ command: 'update', html, mode });
}

const parseCache = new Map<string, { turns: Turn[]; mtimeMs: number }>();
const openPanels = new Map<string, vscode.WebviewPanel>();
// Number of turns we have already rendered into each panel's webview.
// Used to append only newly-added turns on subsequent updates instead of
// wiping and re-chunking the whole transcript every time a message arrives.
const renderedCount = new Map<string, number>();

/**
 * Opens (or reveals) the transcript preview panel for the given agent.
 * Forces a fresh parse of the transcript file on each explicit open to avoid
 * serving stale cached turns after the file has been replaced.
 */
export function openTranscriptPreview(agent: Agent): void {
  // Force fresh read on explicit user action — bypass any stale cache entry.
  parseCache.delete(agent.sessionId);
  const existing = openPanels.get(agent.sessionId);
  if (existing) {
    void sendTurnsUpdate(existing.webview, agent);
    existing.reveal(vscode.ViewColumn.One);
    return;
  }
  const panel = vscode.window.createWebviewPanel(
    'agentTranscript',
    transcriptTabTitle(agent),
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  openPanels.set(agent.sessionId, panel);
  panel.onDidDispose(() => {
    openPanels.delete(agent.sessionId);
    renderedCount.delete(agent.sessionId);
    parseCache.delete(agent.sessionId);
  });
  // When the panel becomes visible after being hidden, catch up on any
  // updates that were skipped while it was in the background.
  panel.onDidChangeViewState(({ webviewPanel }) => {
    if (webviewPanel.visible) void sendTurnsUpdate(webviewPanel.webview, agent);
  });
  // Show shell immediately — content loads once webview signals ready.
  panel.webview.html = buildWebviewHtml(agent.projectName);
  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.command === 'exportMarkdown') {
      await handleExportMarkdown(agent, panel);
    }
  });
  renderedCount.delete(agent.sessionId);
  // Declare sub as let so the fallbackTimer closure can reference it after assignment.
  // If the webview crashes or never fires 'ready', send turns anyway after 10s
  // so the subscription doesn't leak and the panel doesn't stay blank forever.
  let sub: vscode.Disposable;
  const fallbackTimer = setTimeout(() => {
    sub.dispose();
    void sendTurnsUpdate(panel.webview, agent);
  }, 10_000);
  sub = panel.webview.onDidReceiveMessage((msg) => {
    if (msg.command !== 'ready') return;
    clearTimeout(fallbackTimer);
    sub.dispose();
    void sendTurnsUpdate(panel.webview, agent);
  });
}

/**
 * Called by the sidebar provider whenever the agent list changes.
 * Refreshes any open transcript panels whose underlying file has a new mtime.
 */
export function updateTranscriptPanels(agents: Agent[]): void {
  for (const agent of agents) {
    const panel = openPanels.get(agent.sessionId);
    if (!panel || !panel.visible) continue;
    const cached = parseCache.get(agent.sessionId);
    if (cached && cached.mtimeMs === agent.mtimeMs) continue;
    void sendTurnsUpdate(panel.webview, agent);
  }
}

/**
 * Reads and parses the agent's transcript, then sends the rendered HTML to the
 * webview. On the first render (or when the file is replaced) it does a full
 * tail-first flush; on subsequent updates it appends only the new turns.
 */
async function sendTurnsUpdate(webview: vscode.Webview, agent: Agent): Promise<void> {
  const { turns, bytes } = await getTurns(agent);
  if (turns.length === 0) {
    postUpdate(webview, '<div class="empty-state">No turns found in this transcript.</div>', 'replace');
    renderedCount.set(agent.sessionId, 0);
    return;
  }
  const first = turns[0]?.timestamp;
  const last  = turns[turns.length - 1]?.timestamp;
  const kb = (bytes / 1024).toFixed(1);
  const diagHtml = `<div class="diag">${turns.length} turns · ${kb} KB · <span data-iso="${esc(first ?? '')}"></span> → <span data-iso="${esc(last ?? '')}"></span></div>`;

  const prev = renderedCount.get(agent.sessionId) ?? 0;
  // If turn count went down (file replaced) or we have no prior render, do full replace.
  const needsFullRender = prev === 0 || turns.length < prev;

  if (needsFullRender) {
    // Initial or full re-render: pass diagHtml into flushInChunks so it can be
    // combined with the first chunk — keeps "Loading…" visible until real content arrives.
    await flushInChunks(webview, turns, 0, diagHtml);
  } else if (turns.length > prev) {
    // Incremental: append only the new turns, update diag in place.
    await flushInChunks(webview, turns, prev);
    postUpdate(webview, diagHtml, 'diag');
  } else {
    // Same count — file mtime changed but no new turns. Just refresh the diag.
    postUpdate(webview, diagHtml, 'diag');
  }
  renderedCount.set(agent.sessionId, turns.length);
}

const CHUNK_BYTE_LIMIT = 4_000_000; // 4 MB per chunk — fewer IPC round-trips.
const INITIAL_TAIL = 30;            // render last N turns first for fast initial display.

/**
 * Streams rendered turn HTML to the webview in byte-limited chunks, yielding
 * between each chunk to keep the extension host responsive. For large initial
 * renders, the most recent INITIAL_TAIL turns are sent first as a single atomic
 * replace so the user sees real content immediately; older history is then
 * prepended in reverse-order chunks while the viewport stays stable.
 */
async function flushInChunks(webview: vscode.Webview, turns: Turn[], startIdx: number, replaceDiag = ''): Promise<void> {
  const yld = () => new Promise<void>(resolve => setImmediate(resolve));
  const total = turns.length;

  if (startIdx > 0 || total <= INITIAL_TAIL) {
    // Incremental append or small session: simple forward pass.
    if (replaceDiag) postUpdate(webview, replaceDiag, 'replace');
    let buf = '';
    for (let i = startIdx; i < total; i++) {
      buf += renderTurn(turns[i]) + '\n';
      if (buf.length >= CHUNK_BYTE_LIMIT) {
        postUpdate(webview, buf, 'append');
        buf = '';
        await yld();
      }
    }
    if (buf) postUpdate(webview, buf, 'append');
    return;
  }

  // Full render of a large session.
  // Phase 1: render the last INITIAL_TAIL turns as one batch and replace Loading…
  // atomically — user sees the most recent content in a single paint, no mid-load flicker.
  const tailStart = total - INITIAL_TAIL;
  let tailBuf = replaceDiag || '';
  for (let i = tailStart; i < total; i++) {
    tailBuf += renderTurn(turns[i]) + '\n';
  }
  postUpdate(webview, tailBuf, replaceDiag ? 'replace' : 'append');
  await yld();

  // Phase 2: render earlier turns in forward-order chunks, then prepend them in
  // reverse order so the oldest chunk ends up at the top. Yield between chunks
  // to keep the extension host event loop responsive while history loads.
  const chunks: string[] = [];
  let buf = '';
  for (let i = 0; i < tailStart; i++) {
    buf += renderTurn(turns[i]) + '\n';
    if (buf.length >= CHUNK_BYTE_LIMIT) {
      chunks.push(buf);
      buf = '';
      await yld();
    }
  }
  if (buf) chunks.push(buf);

  for (let i = chunks.length - 1; i >= 0; i--) {
    postUpdate(webview, chunks[i], 'prepend');
    await yld();
  }
}

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

/** Disposes the open panel and clears all cached state for the given session. */
export function evict(sessionId: string): void {
  parseCache.delete(sessionId);
  renderedCount.delete(sessionId);
  const panel = openPanels.get(sessionId);
  if (panel) { panel.dispose(); openPanels.delete(sessionId); }
}

/**
 * Returns parsed turns for the agent, using a mtime-keyed cache to avoid
 * re-parsing unchanged files. Stats the file directly to get the current mtime
 * since agent.mtimeMs may lag slightly behind chokidar events.
 */
async function getTurns(agent: Agent): Promise<{ turns: Turn[]; bytes: number }> {
  // Stat the file directly to get the current mtime, since agent.mtimeMs may be
  // stale between file writes and chokidar events.
  let realMtime = agent.mtimeMs;
  let bytes = 0;
  try {
    const stat = await fsp.stat(agent.transcriptPath);
    realMtime = stat.mtimeMs;
    bytes = stat.size;
  } catch (err) { logError(`getTurns stat(${agent.transcriptPath})`, err); }
  const cached = parseCache.get(agent.sessionId);
  if (cached && cached.mtimeMs === realMtime) return { turns: cached.turns, bytes };
  let text: string;
  try { text = await fsp.readFile(agent.transcriptPath, 'utf-8'); }
  catch (err) { logError(`getTurns readFile(${agent.transcriptPath})`, err); return { turns: [], bytes: 0 }; }
  const turns = parseTranscript(text);
  parseCache.set(agent.sessionId, { turns, mtimeMs: realMtime });
  return { turns, bytes };
}

/** Escapes a string for safe embedding in HTML attribute values and text content. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderTurn(turn: Turn): string {
  return turn.role === 'user' ? renderUserTurn(turn) : renderAssistantTurn(turn);
}

/**
 * Renders a collapsible "Raw JSON" `<details>` element. The body is intentionally
 * left empty — the webview syntax-highlights and pretty-prints lazily on first open
 * using the `data-raw` attribute, avoiding expensive work for collapsed entries.
 */
function rawJsonDetails(source: string | undefined, extraClass = ''): string {
  if (!source) return '';
  const cls = extraClass ? ` ${extraClass}` : '';
  // Body is empty — the webview renders and syntax-highlights lazily on first open.
  return `<details class="bubble-raw${cls}" data-raw="${esc(source)}"><summary>Raw JSON</summary><div class="bubble-raw-body json"></div></details>`;
}

/** Renders the Raw JSON details element for a turn's source JSONL line. */
function renderRawDetails(turn: Turn): string {
  return rawJsonDetails(turn.rawJson);
}

/** Renders a user turn as a right-aligned chat bubble with optional attachments. */
function renderUserTurn(turn: Turn): string {
  const attachHtml = turn.attachments.map(renderAttachment).join('');
  const textHtml = turn.text ? mdUser.render(turn.text) : '';
  const bubbleInner = (attachHtml ? `<div class="bubble-attachments">${attachHtml}</div>` : '') + textHtml;
  return `<div class="turn user">
    <div class="turn-head">
      <div class="avatar user"><svg><use href="#icon-user"/></svg></div>
      <span class="turn-label">User</span>
      <span class="turn-ts" data-iso="${esc(turn.timestamp)}"></span>
    </div>
    <div class="turn-content"><div class="turn-inner">
      <div class="bubble"><div class="bubble-content">${bubbleInner}</div>${renderRawDetails(turn)}</div>
    </div></div>
  </div>`;
}

/** Wraps a set of turn entries in a `.entries` container, or returns empty string if none. */
function renderEntriesGroup(entries: TurnEntry[]): string {
  if (entries.length === 0) return '';
  return `<div class="entries">${entries.map(renderEntry).join('')}</div>`;
}

function renderAssistantTurn(turn: Turn): string {
  // System entries (hooks, session-end) appear after the text bubble.
  const toolHtml = renderEntriesGroup(turn.entries.filter(e => e.kind !== 'system'));
  const sysHtml  = renderEntriesGroup(turn.entries.filter(e => e.kind === 'system'));
  const bubbleHtml = turn.text
    ? `<div class="bubble"><div class="bubble-content">${md.render(turn.text)}</div>${renderRawDetails(turn)}</div>`
    : '';
  if (!toolHtml && !bubbleHtml && !sysHtml) return '';
  const metaParts: string[] = [];
  if (turn.index !== undefined) metaParts.push(`#${turn.index}`);
  if (turn.model) metaParts.push(turn.model.replace(/^claude-/, ''));
  const metaPrefix = metaParts.length ? `${esc(metaParts.join(' · '))} · ` : '';
  return `<div class="turn assistant">
    <div class="turn-head">
      <div class="avatar agent"><svg><use href="#icon-agent"/></svg></div>
      <span class="turn-label">Agent</span>
      <span class="turn-ts">${metaPrefix}<span data-iso="${esc(turn.timestamp)}"></span></span>
      ${turn.text ? `<button class="copy-btn" data-copy="${esc(turn.text)}" title="Copy response">📋</button>` : ''}
    </div>
    <div class="turn-content"><div class="turn-inner">
      ${toolHtml}${bubbleHtml}${sysHtml}
    </div></div>
  </div>`;
}

/**
 * Renders the body content of a turn entry, returning the HTML string and a CSS
 * class name that controls layout (json, md, raw, plain, todos). Thinking entries
 * return an empty body — content is stored in `data-lazy-body` and assigned via
 * `textContent` in the webview on first open to avoid md.render overhead.
 */
function renderEntryBody(body: string, kind: TurnEntry['kind']): { html: string; cls: string } {
  if (kind === 'tool_result') {
    return { html: `<pre><code>${esc(body)}</code></pre>`, cls: 'raw' };
  }
  if (kind === 'thinking') {
    return { html: '', cls: 'plain' }; // body stored in data-lazy-body, rendered on open
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { html: md.render(body), cls: 'md' };
  }
  if (kind === 'tool_use' && parsed && typeof parsed === 'object') {
    const todos = (parsed as { todos?: unknown }).todos;
    if (Array.isArray(todos)) {
      return { html: renderTodoList(todos), cls: 'todos' };
    }
  }
  return { html: jsonHlTs(JSON.stringify(parsed, null, 2)), cls: 'json' };
}

function todoMarker(status: unknown): { check: string; cls: string } {
  switch (status) {
    case 'completed':   return { check: '✓', cls: ' done' };
    case 'in_progress': return { check: '◐', cls: ' active' };
    default:            return { check: '○', cls: '' };
  }
}

function renderTodoList(todos: unknown[]): string {
  const items = todos.map(t => {
    const item = t as { content?: unknown; status?: unknown };
    const { check, cls } = todoMarker(item.status);
    return `<li class="todo-item"><span class="todo-chk">${check}</span><span class="todo-txt${cls}">${esc(String(item.content ?? ''))}</span></li>`;
  }).join('');
  return `<ul class="todo-list">${items}</ul>`;
}

/**
 * Applies basic JSON syntax highlighting via regex, returning an HTML string.
 * Identical logic runs in the webview for lazy Raw JSON rendering — keep both in sync.
 */
function jsonHlTs(str: string): string {
  return str
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/(&quot;(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\&])*&quot;)\s*:/g, '<span class="jk">$1</span>:')
    .replace(/:\s*(&quot;(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\&])*&quot;)/g, ': <span class="js">$1</span>')
    .replace(/:\s*(-?\d+\.?\d*(?:[eE][+-]?\d+)?)/g, ': <span class="jn">$1</span>')
    .replace(/:\s*(true|false|null)/g, ': <span class="jb">$1</span>');
}

function entryId(entry: TurnEntry): string {
  return esc(`${entry.timestamp}:${entry.kind}:${entry.label}`);
}

/** Renders a collapsible entry row (tool call, tool result, thinking, or system event). */
function renderEntry(entry: TurnEntry): string {
  const kindClass = entry.kind.replace('_', '-');
  const icon = entry.isError ? '<svg><use href="#icon-warning"/></svg>' : entryIcon(entry.kind);
  const { html: bodyHtml, cls: bodyCls } = renderEntryBody(entry.body, entry.kind);
  const preview = entry.kind === 'system' ? hookOutputPreview(entry.body) : resultPreview(entry.body);
  const resultSection = entry.result ? renderResultSection(entry.result) : '';
  const previewHtml = preview ? `<span class="p-preview">${esc(preview)}</span>` : '';
  const autoOpen = bodyCls === 'todos' ? ' open' : '';
  const errorCls = entry.isError ? ' is-error' : '';
  const rawDetails = rawJsonDetails(entry.rawJson, 'entry-raw');
  const lazyAttr = entry.kind === 'thinking' ? ` data-lazy-body="${esc(entry.body)}"` : '';
  return `<div class="entry ${kindClass}${autoOpen}${errorCls}" data-eid="${entryId(entry)}">
    <div class="entry-header">
      <span class="entry-icon">${icon}</span>
      <span class="entry-lbl">${esc(entry.label)}</span>
      ${previewHtml}
      <span class="entry-caret"><svg><use href="#icon-chevron"/></svg></span>
    </div>
    <div class="entry-body"${lazyAttr}><div class="entry-body-content ${bodyCls}">${bodyHtml}</div>${resultSection}${rawDetails}</div>
  </div>`;
}

/** Renders the paired tool_result section that appears inside a tool_use entry. */
function renderResultSection(result: TurnEntry): string {
  const { html: bodyHtml, cls: bodyCls } = renderEntryBody(result.body, result.kind);
  const preview = resultPreview(result.body);
  const errorCls = result.isError ? ' is-error' : '';
  const markerIcon = result.isError
    ? '<svg class="result-marker-icon"><use href="#icon-warning"/></svg>'
    : '<svg class="result-marker-icon"><use href="#icon-return"/></svg>';
  const caretIcon = '<svg class="result-caret"><use href="#icon-chevron"/></svg>';
  return `<div class="result-section${errorCls}">
    <div class="result-label">${markerIcon}<span>${esc(result.label)}</span>${preview ? `<span class="p-preview">${esc(preview)}</span>` : ''}${caretIcon}</div>
    <div class="result-body ${bodyCls}">${bodyHtml}</div>
  </div>`;
}

function resultPreview(body: string): string {
  // First non-empty line, stripped of markdown/JSON noise.
  const first = body.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? '';
  const cleaned = first.replace(/^[#>\-*`{[]+\s*/, '').replace(/["`]/g, '').trim();
  if (!cleaned) return '';
  return cleaned.length > 160 ? cleaned.slice(0, 159) + '…' : cleaned;
}

function hookOutputPreview(body: string): string {
  // Extract text between the **Output:** code fence, fall back to duration line.
  const m = body.match(/\*\*Output:\*\*\n```\n([\s\S]*?)\n```/);
  if (m) {
    const first = m[1].trim().split('\n')[0].trim();
    return first.length > 150 ? first.slice(0, 149) + '…' : first;
  }
  // No output — show duration if present.
  const d = body.match(/\*\*Duration:\*\*\s*([^\n·]+)/);
  return d ? d[1].trim() : '';
}

function entryIcon(kind: TurnEntry['kind']): string {
  let id: string;
  switch (kind) {
    case 'tool_use':    id = 'icon-terminal'; break;
    case 'tool_result': id = 'icon-return';   break;
    case 'thinking':    id = 'icon-thinking'; break;
    default:            id = 'icon-info';     break;
  }
  return `<svg><use href="#${id}"/></svg>`;
}

/** Renders an image or document attachment for display within a user turn bubble. */
function renderAttachment(att: TurnAttachment): string {
  if (att.type === 'image' && att.data && att.mediaType) {
    const src = `data:${esc(att.mediaType)};base64,${att.data}`;
    const name = esc(att.name ?? 'image');
    return `<div class="attach-image">
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

/** Returns the full HTML shell for the transcript webview panel, including all CSS and JS. */
function buildWebviewHtml(title: string): string {
  const turnsHtml = '<div class="empty-state loading">Loading\u2026</div>';
  const toolbarHtml = `<div class="toolbar">
  <button class="tb-btn" id="tb-search-btn" title="Search (Ctrl+F)">\ud83d\udd0d Search</button>
  <input class="tb-search-input" id="tb-search-input" placeholder="Search\u2026" />
  <button class="tb-btn tb-jump" id="tb-jump-btn" title="Jump to latest">\u2193 Latest</button>
  <button class="tb-btn" id="tb-export-btn" title="Export as markdown">\ud83d\udcbe Export</button>
</div>`;

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
.empty-state.loading { opacity: 0.5; }
.diag { padding: 6px 14px; font-size: 10px; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-input-border); font-family: "Cascadia Code",Consolas,monospace; opacity: 0.6; }

.turn { padding: 10px 14px; }
.turn-head { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
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
.turn-inner { width: 65%; display: flex; flex-direction: column; gap: 8px; }

.bubble { line-height: 1.57; font-size: 13px; word-wrap: break-word; }
.turn.assistant .bubble { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-input-border); border-radius: 10px 10px 10px 2px; }
.turn.user      .bubble { background: var(--vscode-chat-requestBackground, #2b3b4e); border: 1px solid var(--vscode-chat-requestBorder, #3b5070); border-radius: 10px 10px 2px 10px; }
.bubble-content { padding: 8px 11px; }

/* Match VSCode's markdown preview CSS (markdown-language-features/media/markdown.css),
   scaled slightly for 13px bubble context. */
.bubble-content > *:first-child { margin-top: 0; }
.bubble-content > *:last-child  { margin-bottom: 0; }
.bubble p,
.bubble blockquote,
.bubble ul,
.bubble ol,
.bubble dl,
.bubble table,
.bubble pre { margin-top: 0; margin-bottom: 14px; }

.bubble ul, .bubble ol { padding-left: 2em; }
.bubble ul ul, .bubble ul ol, .bubble ol ol, .bubble ol ul { margin-top: 0; margin-bottom: 0; }
.bubble li + li { margin-top: 0.25em; }
.bubble li > p { margin-top: 14px; }

.bubble strong { font-weight: 600; }
.bubble em { font-style: italic; }

.bubble h1, .bubble h2, .bubble h3, .bubble h4, .bubble h5, .bubble h6 {
  font-weight: 600; margin-top: 20px; margin-bottom: 14px; line-height: 1.25;
}
.bubble h1 { font-size: 1.7em; padding-bottom: 0.3em; border-bottom: 1px solid var(--vscode-panel-border); }
.bubble h2 { font-size: 1.35em; padding-bottom: 0.3em; border-bottom: 1px solid var(--vscode-panel-border); }
.bubble h3 { font-size: 1.15em; }
.bubble h4 { font-size: 1em; }
.bubble h5 { font-size: 0.9em; }
.bubble h6 { font-size: 0.85em; color: var(--vscode-descriptionForeground); }

.bubble a { color: var(--vscode-textLink-foreground); text-decoration: none; }
.bubble a:hover { color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground)); text-decoration: underline; }

/* Inline code — VSCode uses textPreformat-*, not textCodeBlock-*. */
.bubble :not(pre) > code {
  font-family: var(--vscode-editor-font-family, "Cascadia Code","Fira Code",Consolas,"Courier New",monospace);
  font-size: 1em; line-height: 1.357em;
  color: var(--vscode-textPreformat-foreground);
  background-color: var(--vscode-textPreformat-background);
  padding: 1px 4px; border-radius: 4px;
}
.bubble pre {
  background: var(--vscode-textCodeBlock-background);
  padding: 16px; border-radius: 3px; overflow: auto;
  white-space: pre;
}
.bubble pre code {
  color: var(--vscode-editor-foreground);
  font-family: var(--vscode-editor-font-family, "Cascadia Code","Fira Code",Consolas,"Courier New",monospace);
  font-size: 1em; line-height: 1.357em;
  tab-size: 4; background: none; padding: 0; border-radius: 0;
}

.bubble blockquote {
  margin: 0 0 14px 0;
  padding: 0 16px 0 10px;
  border-left: 5px solid var(--vscode-textBlockQuote-border);
  background: var(--vscode-textBlockQuote-background);
  color: var(--vscode-foreground);
}

.bubble hr { border: 0; height: 1px; border-bottom: 1px solid var(--vscode-textSeparator-foreground, var(--vscode-panel-border)); margin: 14px 0; }

.bubble table { border-collapse: collapse; }
.bubble th, .bubble td { padding: 5px 10px; }
.bubble thead th { text-align: left; border-bottom: 1px solid var(--vscode-panel-border); font-weight: 600; }
.bubble tbody tr + tr td { border-top: 1px solid var(--vscode-panel-border); }

.bubble-attachments { display: flex; flex-direction: column; gap: 5px; margin-bottom: 7px; }
.attach-image { position: relative; display: inline-block; max-width: 100%; cursor: zoom-in; }
.attach-image img { display: block; max-width: 100%; max-height: 160px; object-fit: contain; border-radius: 5px; border: 1px solid var(--vscode-chat-requestBorder, #3b5070); }
.attach-image .img-badge { position: absolute; top: 5px; left: 5px; background: rgba(0,0,0,0.55); color: #fff; font-size: 10px; padding: 1px 6px; border-radius: 3px; pointer-events: none; }
.attach-file { display: inline-flex; align-items: center; gap: 5px; padding: 4px 9px; border-radius: 4px; background: color-mix(in srgb, var(--vscode-chat-requestBorder,#3b5070) 30%, var(--vscode-chat-requestBackground,#2b3b4e)); border: 1px solid var(--vscode-chat-requestBorder,#3b5070); font-size: 11px; cursor: pointer; max-width: 100%; }
.attach-file .af-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 500; }
.attach-file .af-meta { color: var(--vscode-descriptionForeground); flex-shrink: 0; font-size: 10px; }

.entries { display: flex; flex-direction: column; gap: 6px; }
.entry { border-radius: 8px; border: 1px solid transparent; overflow: hidden; }
.entry-header { display: flex; align-items: center; gap: 8px; padding: 8px 11px; cursor: pointer; user-select: none; min-width: 0; }
.entry-header:hover { background: rgba(128,128,128,0.06); }
.entry-icon { flex-shrink: 0; display: flex; align-items: center; opacity: 0.85; }
.entry-icon svg { width: 13px; height: 13px; }
.entry-lbl { flex-shrink: 0; min-width: 0; max-width: 60%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 13px; font-weight: 500; }
.p-preview { flex: 1; min-width: 0; font-size: 11px; opacity: 0.55; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 400; }
.entry-caret { flex-shrink: 0; display: flex; align-items: center; color: currentColor; opacity: 0.5; transition: transform 0.15s; }
.entry-caret svg { width: 11px; height: 11px; }
.entry.open > .entry-header .entry-caret { transform: rotate(90deg); }

.entry.tool-use    { color: var(--vscode-symbolIcon-functionForeground); background: color-mix(in srgb, var(--vscode-symbolIcon-functionForeground) 8%, transparent); border-color: color-mix(in srgb, var(--vscode-symbolIcon-functionForeground) 25%, transparent); }
.entry.tool-result { color: var(--vscode-symbolIcon-variableForeground); background: color-mix(in srgb, var(--vscode-symbolIcon-variableForeground) 8%, transparent); border-color: color-mix(in srgb, var(--vscode-symbolIcon-variableForeground) 25%, transparent); }
.entry.thinking    { color: var(--vscode-symbolIcon-eventForeground);    background: color-mix(in srgb, var(--vscode-symbolIcon-eventForeground)    8%, transparent); border-color: color-mix(in srgb, var(--vscode-symbolIcon-eventForeground)    25%, transparent); }
.entry.system      { color: var(--vscode-symbolIcon-keywordForeground);  background: color-mix(in srgb, var(--vscode-symbolIcon-keywordForeground)  6%, transparent); border-color: color-mix(in srgb, var(--vscode-symbolIcon-keywordForeground)  20%, transparent); }
.entry.is-error    { color: #f85149; background: color-mix(in srgb, #f85149 10%, transparent); border-color: color-mix(in srgb, #f85149 40%, transparent); }
.result-section.is-error .result-label { color: #f85149; }
.result-section.is-error { border-top-color: color-mix(in srgb, #f85149 40%, transparent); }

.entry-body { display: none; border-top: 1px solid color-mix(in srgb, currentColor 15%, transparent); }
.entry.open > .entry-body { display: block; }
.entry-body-content { max-height: 180px; overflow-y: auto; padding: 5px 10px 4px; font-size: 11px; color: var(--vscode-editor-foreground); line-height: 1.4; }
.entry-raw { border-radius: 0 0 7px 7px; border-top: 1px solid color-mix(in srgb, currentColor 20%, transparent); }

.entry-body-content.json { font-family: "Cascadia Code","Fira Code",Consolas,monospace; white-space: pre; word-break: normal; }
.jk { color: var(--json-key); }
.js { color: var(--json-str); }
.jn { color: var(--json-num); }
.jb { color: var(--json-bool); }
.entry-body-content.md p { margin: 0 0 0.35em; }
.entry-body-content.md p:last-child { margin: 0; }
.entry-body-content.md code { font-family: "Cascadia Code",Consolas,monospace; font-size: 10.5px; background: var(--vscode-textCodeBlock-background); color: var(--vscode-textPreformat-foreground); padding: 1px 4px; border-radius: 2px; }
.entry-body-content.md pre { background: var(--vscode-textCodeBlock-background); padding: 5px 8px; border-radius: 3px; overflow-x: auto; margin: 0.3em 0; }
.entry-body-content.md pre code { background: none; padding: 0; }
.entry-body-content.md strong { font-weight: 600; color: var(--vscode-editor-foreground); }
.entry-body-content.md ul, .entry-body-content.md ol { padding-left: 1.2em; margin: 0.2em 0; }
.entry-body-content.md hr { border: none; border-top: 1px solid var(--vscode-input-border); margin: 0.4em 0; }
.entry-body-content.md table { border-collapse: collapse; width: 100%; margin: 0.3em 0; font-size: 10.5px; }
.entry-body-content.md th, .entry-body-content.md td { border: 1px solid var(--vscode-input-border); padding: 3px 6px; text-align: left; }
.entry-body-content.md thead th { background: var(--vscode-editorWidget-background); font-weight: 600; }
.entry-body-content.plain { white-space: pre-wrap; word-wrap: break-word; line-height: 1.6; }
.entry-body-content.raw { font-family: "Cascadia Code","Fira Code",Consolas,monospace; white-space: pre-wrap; word-break: break-all; }
.entry-body-content.raw pre { margin: 0; background: none; border: none; padding: 0; }
.entry-body-content.raw code { font-family: inherit; background: none; border: none; padding: 0; color: var(--vscode-editor-foreground); }
.result-section { margin-top: 0; border-top: 1px solid color-mix(in srgb, currentColor 10%, transparent); padding: 3px 10px 4px; }
.result-label { display: flex; align-items: center; gap: 5px; font-size: 10px; color: var(--vscode-symbolIcon-variableForeground); font-weight: 500; cursor: pointer; user-select: none; padding: 1px 0; }
.result-label:hover { color: var(--vscode-foreground); }
.result-caret { width: 10px; height: 10px; flex-shrink: 0; margin-left: auto; opacity: 0.5; transition: transform 0.15s; }
.result-section.open .result-caret { transform: rotate(90deg); }
.result-marker-icon { width: 11px; height: 11px; flex-shrink: 0; }
.result-body { display: none; font-size: 10.5px; color: var(--vscode-editor-foreground); line-height: 1.35; max-height: 200px; overflow-y: auto; margin-top: 3px; }
.result-section.open .result-body { display: block; }
.result-body.raw { font-family: "Cascadia Code","Fira Code",Consolas,monospace; white-space: pre-wrap; word-break: break-all; }
.result-body pre { white-space: pre-wrap; word-break: break-all; }
.result-body.raw pre, .result-body.raw code { margin: 0; padding: 0; background: none; border: none; font-family: inherit; color: inherit; }
.result-body.json { font-family: "Cascadia Code","Fira Code",Consolas,monospace; white-space: pre-wrap; word-break: break-all; }
.result-body.md p { margin: 0 0 0.3em; }
.result-body.md p:last-child { margin: 0; }
.todo-list { list-style: none; padding: 0; margin: 0; }
.todo-item { display: flex; align-items: baseline; gap: 5px; padding: 1px 0; }
.todo-chk { flex-shrink: 0; font-size: 10px; color: var(--vscode-disabledForeground); }
.todo-txt { flex: 1; }
.todo-txt.done { text-decoration: line-through; opacity: 0.5; }
.todo-txt.active { color: var(--vscode-focusBorder); }

.lightbox { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.82); z-index: 100; align-items: center; justify-content: center; cursor: zoom-out; }
.lightbox.open { display: flex; }
.lightbox img { max-width: 90vw; max-height: 90vh; object-fit: contain; border-radius: 6px; cursor: default; }
.lb-nav { position: absolute; top: 50%; transform: translateY(-50%); background: rgba(255,255,255,0.12); border: none; color: #fff; font-size: 36px; line-height: 1; width: 44px; height: 64px; border-radius: 6px; cursor: pointer; display: flex; align-items: center; justify-content: center; opacity: 0.7; transition: opacity 0.15s, background 0.15s; z-index: 101; }
.lb-nav:hover { opacity: 1; background: rgba(255,255,255,0.22); }
.lb-nav:disabled { opacity: 0.15; cursor: default; }
.lb-prev { left: 14px; }
.lb-next { right: 14px; }
.lb-counter { position: absolute; bottom: 14px; left: 50%; transform: translateX(-50%); background: rgba(0,0,0,0.55); color: #fff; font-size: 11px; padding: 2px 10px; border-radius: 10px; pointer-events: none; }

.bubble-raw { border-top: 1px solid color-mix(in srgb, var(--vscode-input-border) 60%, transparent); overflow: hidden; }
.entry-raw.bubble-raw { border-top-color: color-mix(in srgb, currentColor 20%, transparent); }
.bubble-raw summary { padding: 5px 10px; font-size: 10px; font-weight: 500; color: var(--vscode-descriptionForeground); cursor: pointer; display: flex; align-items: center; gap: 5px; list-style: none; }
.bubble-raw summary::-webkit-details-marker { display: none; }
.bubble-raw summary::before { content: '▶'; font-size: 8px; transition: transform 0.15s; display: inline-block; opacity: 0.6; }
.bubble-raw[open] summary::before { transform: rotate(90deg); }
.bubble-raw summary:hover { background: rgba(128,128,128,0.06); }
.bubble-raw-body { padding: 6px 10px 8px; font-size: 11px; font-family: "Cascadia Code","Fira Code",Consolas,monospace; white-space: pre; word-break: normal; overflow-x: auto; }
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
.tb-jump { display: none; margin-left: auto; }
.tb-jump.visible { display: inline-block; }
.search-highlight { background: rgba(255,215,0,0.3); border-radius: 2px; }
.copy-btn {
  display: none; background: none; border: none; cursor: pointer;
  color: var(--vscode-descriptionForeground); padding: 1px 4px;
  font-size: 11px; border-radius: 3px; margin-left: 4px;
}
.turn-head:hover .copy-btn { display: inline-flex; align-items: center; }
.copy-btn:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
body { display: flex; flex-direction: column; }
.toolbar { flex-shrink: 0; }
.scroll { flex: 1; height: unset !important; }
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
  <symbol id="icon-terminal" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="2,5.5 6.5,8 2,10.5" stroke-width="1.7"/>
    <line x1="8.5" y1="11" x2="14" y2="11" stroke-width="1.7"/>
  </symbol>
  <symbol id="icon-thinking" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round">
    <path d="M8 2C5.24 2 3 4.24 3 7s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5z" stroke-width="1.4"/>
    <circle cx="5.5" cy="13.5" r="1" fill="currentColor" stroke="none"/>
    <circle cx="3.5" cy="12" r="0.7" fill="currentColor" stroke="none"/>
  </symbol>
  <symbol id="icon-info" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round">
    <circle cx="8" cy="8" r="6.5" stroke-width="1.4"/>
    <line x1="8" y1="7.5" x2="8" y2="11.5" stroke-width="1.8"/>
    <circle cx="8" cy="5.5" r="0.9" fill="currentColor" stroke="none"/>
  </symbol>
  <symbol id="icon-return" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="11,3.5 11,10 3,10" stroke-width="1.7"/>
    <polyline points="6,7 3,10 6,13" stroke-width="1.7"/>
  </symbol>
  <symbol id="icon-warning" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <path d="M8 2L14 13.5H2L8 2Z" stroke-width="1.5"/>
    <line x1="8" y1="7" x2="8" y2="10" stroke-width="1.8"/>
    <circle cx="8" cy="12" r="0.9" fill="currentColor" stroke="none"/>
  </symbol>
  <symbol id="icon-code" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="5,4 1,8 5,12" stroke-width="1.7"/>
    <polyline points="11,4 15,8 11,12" stroke-width="1.7"/>
  </symbol>
</svg>

<div class="lightbox" id="lightbox">
  <button class="lb-nav lb-prev" id="lb-prev" title="Previous image">&#8249;</button>
  <img id="lightbox-img" src="" alt="">
  <button class="lb-nav lb-next" id="lb-next" title="Next image">&#8250;</button>
  <div class="lb-counter" id="lb-counter"></div>
</div>

${toolbarHtml}
<div class="scroll" id="scroll">
${turnsHtml}
</div>

<script>
  const scroll = document.getElementById('scroll');
  let userScrolled = false;
  let _progScrolls = 0;

  function fmtFull(iso) {
    return new Date(iso).toLocaleString(undefined, { month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit', second:'2-digit', hour12:true });
  }
  function fmtTime(iso) {
    return new Date(iso).toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit', second:'2-digit', hour12:true });
  }

  function stampTimestamps() {
    document.querySelectorAll('[data-iso]').forEach(el => {
      const iso = el.dataset.iso;
      el.textContent = el.classList.contains('p-ts') ? fmtTime(iso) : fmtFull(iso);
    });
  }

  function jsonHlTs(str) {
    return str
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
      .replace(/(&quot;(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\&])*&quot;)\s*:/g,'<span class="jk">$1</span>:')
      .replace(/:\s*(&quot;(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\&])*&quot;)/g,': <span class="js">$1</span>')
      .replace(/:\s*(-?\d+\.?\d*(?:[eE][+-]?\d+)?)/g,': <span class="jn">$1</span>')
      .replace(/:\s*(true|false|null)/g,': <span class="jb">$1</span>');
  }

  function renderRawBody(details) {
    const body = details.querySelector('.bubble-raw-body');
    if (!body || body.dataset.rendered) return;
    body.dataset.rendered = '1';
    let pretty;
    try { pretty = JSON.stringify(JSON.parse(details.dataset.raw || ''), null, 2); }
    catch { pretty = details.dataset.raw || ''; }
    body.innerHTML = jsonHlTs(pretty);
  }

  // Delegated click handling — attached once, works for any future content.
  scroll.addEventListener('click', (ev) => {
    const t = ev.target;
    const copyBtn = t.closest?.('.copy-btn');
    if (copyBtn) {
      navigator.clipboard.writeText(copyBtn.dataset.copy || '').catch(() => {});
      const orig = copyBtn.textContent;
      copyBtn.textContent = '✓';
      setTimeout(() => { copyBtn.textContent = orig; }, 1200);
      return;
    }
    const summary = t.closest?.('summary');
    if (summary) {
      const details = summary.closest('details.bubble-raw');
      if (details && !details.open) renderRawBody(details); // open is old state at click time
    }
    const resultLabel = t.closest?.('.result-label');
    if (resultLabel) {
      resultLabel.closest('.result-section')?.classList.toggle('open');
      return;
    }
    const header = t.closest?.('.entry-header');
    if (header) {
      const entry = header.closest('.entry');
      if (entry) {
        // Lazy-render thinking body on first open.
        const entryBody = entry.querySelector('.entry-body');
        if (entryBody && entryBody.dataset.lazyBody !== undefined && !entryBody.dataset.rendered) {
          entryBody.dataset.rendered = '1';
          const content = entryBody.querySelector('.entry-body-content');
          if (content) content.textContent = entryBody.dataset.lazyBody;
        }
        entry.classList.toggle('open');
      }
      return;
    }
    const imgWrap = t.closest?.('.attach-image');
    if (imgWrap) {
      const allImgs = Array.from(scroll.querySelectorAll('.attach-image img'));
      const clicked = imgWrap.querySelector('img');
      lbOpen(allImgs.map(el => ({ src: el.src, alt: el.alt })), allImgs.indexOf(clicked));
    }
  });
  function scrollToBottom() {
    _progScrolls++;
    requestAnimationFrame(() => {
      scroll.scrollTop = scroll.scrollHeight;
      requestAnimationFrame(() => { _progScrolls = Math.max(0, _progScrolls - 1); });
    });
  }

  scroll.addEventListener('scroll', () => {
    if (_progScrolls > 0) return;
    const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 60;
    userScrolled = !atBottom;
  });

  const jumpBtn = document.getElementById('tb-jump-btn');

  function updateJumpVisibility() {
    const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 60;
    if (jumpBtn) jumpBtn.classList.toggle('visible', !atBottom);
  }

  jumpBtn && jumpBtn.addEventListener('click', () => scrollToBottom());

  // Gallery lightbox state
  let lbImages = [];
  let lbIndex = 0;
  const lightbox = document.getElementById('lightbox');
  const lbImg = document.getElementById('lightbox-img');
  const lbCounter = document.getElementById('lb-counter');
  const lbPrev = document.getElementById('lb-prev');
  const lbNext = document.getElementById('lb-next');

  function lbShow(idx) {
    lbIndex = Math.max(0, Math.min(idx, lbImages.length - 1));
    const entry = lbImages[lbIndex];
    lbImg.src = entry.src;
    lbImg.alt = entry.alt;
    const hasMultiple = lbImages.length > 1;
    lbCounter.textContent = hasMultiple ? (lbIndex + 1) + ' / ' + lbImages.length : '';
    lbPrev.disabled = lbIndex === 0;
    lbNext.disabled = lbIndex === lbImages.length - 1;
  }

  function lbOpen(imgs, idx) {
    lbImages = imgs;
    const hasMultiple = imgs.length > 1;
    lbPrev.style.display = hasMultiple ? '' : 'none';
    lbNext.style.display = hasMultiple ? '' : 'none';
    lightbox.classList.add('open');
    lbShow(idx);
  }

  function lbClose() { lightbox.classList.remove('open'); lbImg.src = ''; }

  lightbox.addEventListener('click', (ev) => {
    if (ev.target === lightbox || ev.target === lbImg) lbClose();
  });
  lbPrev.addEventListener('click', (ev) => { ev.stopPropagation(); lbShow(lbIndex - 1); });
  lbNext.addEventListener('click', (ev) => { ev.stopPropagation(); lbShow(lbIndex + 1); });


  let openEidsAtReplace = new Set();
  window.addEventListener('message', e => {
    if (e.data?.command !== 'update') return;
    if (!['replace', 'append', 'prepend', 'diag'].includes(e.data.mode)) return;
    const wasAtBottom = !userScrolled;
    if (e.data.mode === 'diag') {
      // Replace just the diagnostic banner, leave content intact.
      const existing = scroll.querySelector('.diag');
      if (existing) {
        const tmp = document.createElement('div');
        tmp.innerHTML = e.data.html;
        const fresh = tmp.firstElementChild;
        if (fresh) existing.replaceWith(fresh);
      }
      stampTimestamps();
      return;
    }
    if (e.data.mode === 'replace') {
      openEidsAtReplace = new Set([...scroll.querySelectorAll('.entry.open[data-eid]')].map(el => el.getAttribute('data-eid')));
      scroll.innerHTML = e.data.html;
    } else if (e.data.mode === 'prepend') {
      // Insert older content above existing turns. Chromium's native scroll anchoring
      // (overflow-anchor: auto, the default) keeps the viewport stable automatically —
      // no manual scrollTop compensation needed (it would double-adjust and cause dancing).
      const tmp = document.createElement('div');
      tmp.innerHTML = e.data.html;
      const diag = scroll.querySelector('.diag');
      const ref = diag ? diag.nextSibling : scroll.firstChild;
      while (tmp.firstChild) scroll.insertBefore(tmp.firstChild, ref);
      if (openEidsAtReplace.size > 0) {
        scroll.querySelectorAll('.entry[data-eid]').forEach(el => {
          if (openEidsAtReplace.has(el.getAttribute('data-eid'))) el.classList.add('open');
        });
      }
      stampTimestamps();
      return;
    } else {
      // Parse in a detached element so parser state from prior chunks can't leak
      // into the main document context (e.g. unclosed SVG leaving Chromium in
      // "foreign content" mode for subsequent insertAdjacentHTML calls).
      const tmp = document.createElement('div');
      tmp.innerHTML = e.data.html;
      while (tmp.firstChild) scroll.appendChild(tmp.firstChild);
    }
    if (openEidsAtReplace.size > 0) {
      scroll.querySelectorAll('.entry[data-eid]').forEach(el => {
        if (openEidsAtReplace.has(el.getAttribute('data-eid'))) el.classList.add('open');
      });
    }
    stampTimestamps();
    if (wasAtBottom) scrollToBottom();
    updateJumpVisibility();
  });

  stampTimestamps();
  scrollToBottom();

  const searchBtn   = document.getElementById('tb-search-btn');
  const searchInput = document.getElementById('tb-search-input');

  function clearHighlights() {
    const marks = scroll.querySelectorAll('.search-highlight');
    if (!marks.length) return;
    marks.forEach(el => el.replaceWith(document.createTextNode(el.textContent)));
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
    const first = scroll.querySelector('.search-highlight');
    if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  let _hlTimer;
  function highlightDebounced(query) {
    clearTimeout(_hlTimer);
    _hlTimer = setTimeout(() => highlightText(query), 200);
  }

  searchBtn && searchBtn.addEventListener('click', () => {
    searchInput.classList.toggle('visible');
    if (searchInput.classList.contains('visible')) searchInput.focus();
    else { clearHighlights(); searchInput.value = ''; }
  });

  searchInput && searchInput.addEventListener('input', () => highlightDebounced(searchInput.value));
  searchInput && searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      clearHighlights(); searchInput.value = '';
      searchInput.classList.remove('visible');
      searchInput.blur();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (lightbox.classList.contains('open')) {
      if (e.key === 'ArrowLeft')  { lbShow(lbIndex - 1); e.preventDefault(); }
      if (e.key === 'ArrowRight') { lbShow(lbIndex + 1); e.preventDefault(); }
      if (e.key === 'Escape')     { lbClose(); }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      if (searchInput) { searchInput.classList.add('visible'); searchInput.focus(); }
    }
  });

  const vscode = acquireVsCodeApi();
  document.getElementById('tb-export-btn')?.addEventListener('click', () => {
    vscode.postMessage({ command: 'exportMarkdown' });
  });
  vscode.postMessage({ command: 'ready' });
</script>
</body>
</html>`;
}
