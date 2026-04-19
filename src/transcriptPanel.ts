import * as vscode from 'vscode';
import * as fsp from 'fs/promises';
import MarkdownIt from 'markdown-it';
import { Agent, Turn, TurnEntry, TurnAttachment } from './types';
import { parseTranscript } from './transcriptParser';

const md = new MarkdownIt({ html: false, linkify: true, typographer: true });

const parseCache = new Map<string, { turns: Turn[]; mtimeMs: number }>();
const openPanels = new Map<string, vscode.WebviewPanel>();
// Number of turns we have already rendered into each panel's webview.
// Used to append only newly-added turns on subsequent updates instead of
// wiping and re-chunking the whole transcript every time a message arrives.
const renderedCount = new Map<string, number>();

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
    `💬 ${agent.projectName} · ${agent.sessionId.slice(0, 8)}`,
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  openPanels.set(agent.sessionId, panel);
  panel.onDidDispose(() => {
    openPanels.delete(agent.sessionId);
    renderedCount.delete(agent.sessionId);
  });
  // Show shell immediately — content loads once webview signals ready.
  panel.webview.html = buildWebviewHtml(agent.projectName);
  renderedCount.delete(agent.sessionId);
  const sub = panel.webview.onDidReceiveMessage((msg) => {
    if (msg.command !== 'ready') return;
    sub.dispose();
    void sendTurnsUpdate(panel.webview, agent);
  });
}

export function updateTranscriptPanels(agents: Agent[]): void {
  for (const agent of agents) {
    const panel = openPanels.get(agent.sessionId);
    if (!panel) continue;
    const cached = parseCache.get(agent.sessionId);
    if (cached && cached.mtimeMs === agent.mtimeMs) continue;
    void sendTurnsUpdate(panel.webview, agent);
  }
}

async function sendTurnsUpdate(webview: vscode.Webview, agent: Agent): Promise<void> {
  const { turns, bytes } = await getTurns(agent);
  if (turns.length === 0) {
    webview.postMessage({ command: 'update', html: '<div class="empty-state">No turns found in this transcript.</div>', mode: 'replace' });
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
    // Initial or full re-render: replace scroll with diag, then append turns in
    // size-bounded chunks. Individual tool results / hook outputs can be very large,
    // so count-based chunks aren't safe — size-based keeps us under postMessage limits.
    webview.postMessage({ command: 'update', html: diagHtml, mode: 'replace' });
    flushInChunks(webview, turns, 0);
  } else if (turns.length > prev) {
    // Incremental: append only the new turns, update diag in place.
    flushInChunks(webview, turns, prev);
    webview.postMessage({ command: 'update', html: diagHtml, mode: 'diag' });
  } else {
    // Same count — file mtime changed but no new turns. Just refresh the diag.
    webview.postMessage({ command: 'update', html: diagHtml, mode: 'diag' });
  }
  renderedCount.set(agent.sessionId, turns.length);
}

const CHUNK_BYTE_LIMIT = 1_000_000; // ~1 MB per postMessage to stay well under IPC limits.

function flushInChunks(webview: vscode.Webview, turns: Turn[], startIdx: number): void {
  let buf = '';
  for (let i = startIdx; i < turns.length; i++) {
    const rendered = renderTurn(turns[i]);
    if (buf && buf.length + rendered.length > CHUNK_BYTE_LIMIT) {
      webview.postMessage({ command: 'update', html: buf, mode: 'append' });
      buf = '';
    }
    buf += rendered + '\n';
  }
  if (buf) webview.postMessage({ command: 'update', html: buf, mode: 'append' });
}

export function evict(sessionId: string): void {
  parseCache.delete(sessionId);
  renderedCount.delete(sessionId);
  const panel = openPanels.get(sessionId);
  if (panel) { panel.dispose(); openPanels.delete(sessionId); }
}

async function getTurns(agent: Agent): Promise<{ turns: Turn[]; bytes: number }> {
  // Stat the file directly to get the current mtime, since agent.mtimeMs may be
  // stale between file writes and chokidar events.
  let realMtime = agent.mtimeMs;
  let bytes = 0;
  try {
    const stat = await fsp.stat(agent.transcriptPath);
    realMtime = stat.mtimeMs;
    bytes = stat.size;
  } catch { /* fall through; file may have been deleted */ }
  const cached = parseCache.get(agent.sessionId);
  if (cached && cached.mtimeMs === realMtime) return { turns: cached.turns, bytes };
  let text: string;
  try { text = await fsp.readFile(agent.transcriptPath, 'utf-8'); }
  catch { return { turns: [], bytes: 0 }; }
  const turns = parseTranscript(text);
  parseCache.set(agent.sessionId, { turns, mtimeMs: realMtime });
  return { turns, bytes: Buffer.byteLength(text, 'utf-8') };
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}


function renderTurn(turn: Turn): string {
  return turn.role === 'user' ? renderUserTurn(turn) : renderAssistantTurn(turn);
}

function renderUserTurn(turn: Turn): string {
  const attachHtml = turn.attachments.map(renderAttachment).join('');
  const textHtml = turn.text ? `<div class="bubble-text">${md.render(turn.text)}</div>` : '';
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
  // System entries (hooks, session-end) appear after the text bubble.
  const toolEntries = turn.entries.filter(e => e.kind !== 'system');
  const sysEntries  = turn.entries.filter(e => e.kind === 'system');
  const toolHtml = toolEntries.length > 0
    ? `<div class="entries">${toolEntries.map(renderEntry).join('')}</div>`
    : '';
  const sysHtml = sysEntries.length > 0
    ? `<div class="entries">${sysEntries.map(renderEntry).join('')}</div>`
    : '';
  const bubbleHtml = turn.text
    ? `<div class="bubble">${md.render(turn.text)}</div>`
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
    </div>
    <div class="turn-content"><div class="turn-inner">
      ${toolHtml}${bubbleHtml}${sysHtml}
    </div></div>
  </div>`;
}

function renderEntryBody(body: string, kind: TurnEntry['kind']): { html: string; cls: string } {
  if (kind === 'tool_result') {
    return { html: `<pre><code>${esc(body)}</code></pre>`, cls: 'raw' };
  }
  if (kind === 'thinking') {
    return { html: md.render(body), cls: 'md' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { html: md.render(body), cls: 'md' };
  }
  if (kind === 'tool_use' && parsed && typeof parsed === 'object' && Array.isArray((parsed as { todos?: unknown }).todos)) {
    return { html: renderTodoList((parsed as { todos: unknown[] }).todos), cls: 'todos' };
  }
  return { html: jsonHlTs(JSON.stringify(parsed, null, 2)), cls: 'json' };
}

function renderTodoList(todos: unknown[]): string {
  const items = todos.map(t => {
    const item = t as { content?: unknown; status?: unknown };
    let check = '○';
    let cls = '';
    if (item.status === 'completed') {
      check = '✓';
      cls = ' done';
    } else if (item.status === 'in_progress') {
      check = '◐';
      cls = ' active';
    }
    return `<li class="todo-item"><span class="todo-chk">${check}</span><span class="todo-txt${cls}">${esc(String(item.content ?? ''))}</span></li>`;
  }).join('');
  return `<ul class="todo-list">${items}</ul>`;
}

function jsonHlTs(str: string): string {
  return esc(str)
    .replace(/(&quot;(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\&])*&quot;)\s*:/g, '<span class="jk">$1</span>:')
    .replace(/:\s*(&quot;(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\&])*&quot;)/g, ': <span class="js">$1</span>')
    .replace(/:\s*(-?\d+\.?\d*(?:[eE][+-]?\d+)?)/g, ': <span class="jn">$1</span>')
    .replace(/:\s*(true|false|null)/g, ': <span class="jb">$1</span>');
}

function renderEntry(entry: TurnEntry): string {
  return renderEntryBubble(entry);
}

function entryId(entry: TurnEntry): string {
  return esc(`${entry.timestamp}:${entry.kind}:${entry.label}`);
}

function renderEntryBubble(entry: TurnEntry): string {
  const kindClass = entry.kind.replace('_', '-');
  const icon = entryIcon(entry.kind);
  const { html: bodyHtml, cls: bodyCls } = renderEntryBody(entry.body, entry.kind);
  const preview = entry.kind === 'system' ? hookOutputPreview(entry.body) : resultPreview(entry.body);
  const resultSection = entry.result ? renderResultSection(entry.result) : '';
  const previewHtml = preview ? `<span class="p-preview">${preview}</span>` : '';
  return `<div class="entry ${kindClass}" data-eid="${entryId(entry)}">
    <div class="entry-header">
      <span class="entry-icon">${icon}</span>
      <span class="entry-lbl">${esc(entry.label)}</span>
      ${previewHtml}
      <span class="p-ts" data-iso="${esc(entry.timestamp)}"></span>
      <span class="entry-caret"><svg><use href="#icon-chevron"/></svg></span>
    </div>
    <div class="entry-body ${bodyCls}">${bodyHtml}${resultSection}</div>
  </div>`;
}

function renderResultSection(result: TurnEntry): string {
  const { html: bodyHtml, cls: bodyCls } = renderEntryBody(result.body, result.kind);
  const preview = resultPreview(result.body);
  return `<div class="result-section">
    <div class="result-label"><span>↩</span> <span>${esc(result.label)}</span>${preview ? `<span class="p-preview">${preview}</span>` : ''}</div>
    <div class="result-body ${bodyCls}">${bodyHtml}</div>
  </div>`;
}

function resultPreview(body: string): string {
  // First non-empty line, stripped of markdown/JSON noise.
  const first = body.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? '';
  const cleaned = first.replace(/^[#>\-*`{[]+\s*/, '').replace(/["`]/g, '').trim();
  if (!cleaned) return '';
  return cleaned.length > 80 ? cleaned.slice(0, 79) + '…' : cleaned;
}

function hookOutputPreview(body: string): string {
  // Extract text between the **Output:** code fence, fall back to duration line.
  const m = body.match(/\*\*Output:\*\*\n```\n([\s\S]*?)\n```/);
  if (m) {
    const first = m[1].trim().split('\n')[0].trim();
    return first.length > 72 ? first.slice(0, 71) + '…' : first;
  }
  // No output — show duration if present.
  const d = body.match(/\*\*Duration:\*\*\s*([^\n·]+)/);
  return d ? d[1].trim() : '';
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

function buildWebviewHtml(title: string): string {
  const turnsHtml = '<div class="empty-state loading">Loading\u2026</div>';

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

.bubble { padding: 8px 11px; line-height: 1.65; font-size: 13px; word-break: break-word; }
.turn.assistant .bubble { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-input-border); border-radius: 10px 10px 10px 2px; }
.turn.user      .bubble { background: var(--vscode-chat-requestBackground, #2b3b4e); border: 1px solid var(--vscode-chat-requestBorder, #3b5070); border-radius: 10px 10px 2px 10px; }

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
.bubble hr { border: none; border-top: 1px solid var(--vscode-input-border); margin: 0.6em 0; }
.bubble table { border-collapse: collapse; width: 100%; margin: 0.4em 0; font-size: 12px; }
.bubble th, .bubble td { border: 1px solid var(--vscode-input-border); padding: 4px 8px; text-align: left; }
.bubble thead th { background: var(--vscode-editorWidget-background); font-weight: 600; }

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
.entry-icon { flex-shrink: 0; font-size: 13px; line-height: 1; opacity: 0.85; }
.entry-lbl { flex-shrink: 0; min-width: 0; max-width: 45%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 13px; font-weight: 500; }
.p-preview { flex: 1; min-width: 0; font-size: 11px; opacity: 0.55; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 400; }
.p-ts { flex-shrink: 0; font-size: 10px; opacity: 0.45; }
.entry-caret { flex-shrink: 0; display: flex; align-items: center; color: currentColor; opacity: 0.5; transition: transform 0.15s; }
.entry-caret svg { width: 11px; height: 11px; }
.entry.open > .entry-header .entry-caret { transform: rotate(90deg); }

.entry.tool-use    { color: var(--vscode-symbolIcon-functionForeground); background: color-mix(in srgb, var(--vscode-symbolIcon-functionForeground) 8%, transparent); border-color: color-mix(in srgb, var(--vscode-symbolIcon-functionForeground) 25%, transparent); }
.entry.tool-result { color: var(--vscode-symbolIcon-variableForeground); background: color-mix(in srgb, var(--vscode-symbolIcon-variableForeground) 8%, transparent); border-color: color-mix(in srgb, var(--vscode-symbolIcon-variableForeground) 25%, transparent); }
.entry.thinking    { color: var(--vscode-symbolIcon-eventForeground);    background: color-mix(in srgb, var(--vscode-symbolIcon-eventForeground)    8%, transparent); border-color: color-mix(in srgb, var(--vscode-symbolIcon-eventForeground)    25%, transparent); }
.entry.system      { color: var(--vscode-symbolIcon-keywordForeground);  background: color-mix(in srgb, var(--vscode-symbolIcon-keywordForeground)  6%, transparent); border-color: color-mix(in srgb, var(--vscode-symbolIcon-keywordForeground)  20%, transparent); }

.entry-body { display: none; padding: 6px 10px 8px; border-top: 1px solid color-mix(in srgb, currentColor 20%, transparent); font-size: 11px; color: var(--vscode-editor-foreground); line-height: 1.5; max-height: 240px; overflow-y: auto; }
.entry.open > .entry-body { display: block; }
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
.entry-body.md hr { border: none; border-top: 1px solid var(--vscode-input-border); margin: 0.4em 0; }
.entry-body.md table { border-collapse: collapse; width: 100%; margin: 0.3em 0; font-size: 10.5px; }
.entry-body.md th, .entry-body.md td { border: 1px solid var(--vscode-input-border); padding: 3px 6px; text-align: left; }
.entry-body.md thead th { background: var(--vscode-editorWidget-background); font-weight: 600; }
.entry-body.raw { font-family: "Cascadia Code","Fira Code",Consolas,monospace; white-space: pre-wrap; word-break: break-all; }
.entry-body.raw pre { margin: 0; background: none; border: none; padding: 0; }
.entry-body.raw code { font-family: inherit; background: none; border: none; padding: 0; color: var(--vscode-editor-foreground); }
.result-section { margin-top: 8px; border-top: 1px solid var(--vscode-input-border); padding-top: 6px; }
.result-label { display: flex; align-items: center; gap: 5px; font-size: 10px; color: var(--vscode-symbolIcon-variableForeground); font-weight: 500; margin-bottom: 5px; }
.result-body { font-size: 11px; color: var(--vscode-descriptionForeground); line-height: 1.5; max-height: 160px; overflow-y: auto; }
.result-body.raw { font-family: "Cascadia Code","Fira Code",Consolas,monospace; white-space: pre-wrap; word-break: break-all; }
.result-body.json { font-family: "Cascadia Code","Fira Code",Consolas,monospace; white-space: pre; }
.result-body.md p { margin: 0 0 0.3em; }
.result-body.md p:last-child { margin: 0; }
.todo-list { list-style: none; padding: 0; margin: 0; }
.todo-item { display: flex; align-items: baseline; gap: 5px; padding: 1px 0; }
.todo-chk { flex-shrink: 0; font-size: 10px; color: var(--vscode-disabledForeground); }
.todo-txt { flex: 1; }
.todo-txt.done { text-decoration: line-through; opacity: 0.5; }
.todo-txt.active { color: var(--vscode-focusBorder); }

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

<div class="lightbox" id="lightbox">
  <img id="lightbox-img" src="" alt="">
</div>

<div class="scroll" id="scroll">
${turnsHtml}
</div>

<script>
  const scroll = document.getElementById('scroll');
  let userScrolled = false;

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

  // Delegated click handling — attached once, works for any future content.
  scroll.addEventListener('click', (ev) => {
    const header = ev.target.closest && ev.target.closest('.entry-header');
    if (header) {
      const entry = header.closest('.entry');
      if (entry) entry.classList.toggle('open');
      return;
    }
    const img = ev.target.closest && ev.target.closest('.attach-image');
    if (img) {
      document.getElementById('lightbox-img').src = img.querySelector('img').src;
      document.getElementById('lightbox').classList.add('open');
    }
  });
  function attachListeners() { /* no-op: using event delegation now */ }

  function scrollToBottom() {
    scroll.scrollTop = scroll.scrollHeight;
  }

  scroll.addEventListener('scroll', () => {
    const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 60;
    userScrolled = !atBottom;
  });

  document.getElementById('lightbox').addEventListener('click', () => {
    document.getElementById('lightbox').classList.remove('open');
  });

  let openEidsAtReplace = new Set();
  window.addEventListener('message', e => {
    if (e.data?.command !== 'update') return;
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
    } else {
      scroll.insertAdjacentHTML('beforeend', e.data.html);
    }
    if (openEidsAtReplace.size > 0) {
      scroll.querySelectorAll('.entry[data-eid]').forEach(el => {
        if (openEidsAtReplace.has(el.getAttribute('data-eid'))) el.classList.add('open');
      });
    }
    stampTimestamps();
    attachListeners();
    if (wasAtBottom) scrollToBottom();
  });

  // Initial setup + signal extension we're ready to receive content
  stampTimestamps();
  attachListeners();
  scrollToBottom();
  const vscode = acquireVsCodeApi();
  vscode.postMessage({ command: 'ready' });
</script>
</body>
</html>`;
}
