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
    const cached = parseCache.get(agent.sessionId);
    if (!cached || cached.mtimeMs !== agent.mtimeMs) {
      existing.webview.html = buildWebviewHtml(getTurns(agent), agent.projectName);
    }
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

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

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
  const kindClass = entry.kind.replace('_', '-');
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

.bubble-attachments { display: flex; flex-direction: column; gap: 5px; margin-bottom: 7px; }
.attach-image { position: relative; display: inline-block; max-width: 100%; cursor: zoom-in; }
.attach-image img { display: block; max-width: 100%; max-height: 160px; object-fit: contain; border-radius: 5px; border: 1px solid var(--vscode-chat-requestBorder, #3b5070); }
.attach-image .img-badge { position: absolute; top: 5px; left: 5px; background: rgba(0,0,0,0.55); color: #fff; font-size: 10px; padding: 1px 6px; border-radius: 3px; pointer-events: none; }
.attach-file { display: inline-flex; align-items: center; gap: 5px; padding: 4px 9px; border-radius: 4px; background: color-mix(in srgb, var(--vscode-chat-requestBorder,#3b5070) 30%, var(--vscode-chat-requestBackground,#2b3b4e)); border: 1px solid var(--vscode-chat-requestBorder,#3b5070); font-size: 11px; cursor: pointer; max-width: 100%; }
.attach-file .af-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 500; }
.attach-file .af-meta { color: var(--vscode-descriptionForeground); flex-shrink: 0; font-size: 10px; }

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
  function renderMd(raw) {
    const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const lines = raw.split('\n');
    const result = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line.startsWith('\`\`\`')) {
        const code = [];
        i++;
        while (i < lines.length && !lines[i].startsWith('\`\`\`')) { code.push(lines[i]); i++; }
        i++;
        result.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>');
        continue;
      }
      const hm = line.match(/^(#{1,3})\s+(.+)/);
      if (hm) { result.push('<h' + hm[1].length + '>' + inlineMd(hm[2]) + '</h' + hm[1].length + '>'); i++; continue; }
      if (line.startsWith('> ')) {
        const bq = [];
        while (i < lines.length && lines[i].startsWith('> ')) { bq.push(lines[i].slice(2)); i++; }
        result.push('<blockquote>' + inlineMd(bq.join(' ')) + '</blockquote>');
        continue;
      }
      if (/^[-*+]\s/.test(line)) {
        const items = [];
        while (i < lines.length && /^[-*+]\s/.test(lines[i])) { items.push('<li>' + inlineMd(lines[i].replace(/^[-*+]\s/,'')) + '</li>'); i++; }
        result.push('<ul>' + items.join('') + '</ul>');
        continue;
      }
      if (/^\d+\.\s/.test(line)) {
        const items = [];
        while (i < lines.length && /^\d+\.\s/.test(lines[i])) { items.push('<li>' + inlineMd(lines[i].replace(/^\d+\.\s/,'')) + '</li>'); i++; }
        result.push('<ol>' + items.join('') + '</ol>');
        continue;
      }
      if (line.trim() === '') { i++; continue; }
      const para = [];
      while (i < lines.length && lines[i].trim() !== '' && !/^[#>\`*+\-\d]/.test(lines[i])) { para.push(lines[i]); i++; }
      if (para.length) result.push('<p>' + inlineMd(para.join(' ')) + '</p>');
      else i++;
    }
    return result.join('');
  }

  function inlineMd(s) {
    const esc = t => t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return s
      .replace(/\`([^\`]+)\`/g, (_, c) => '<code>' + esc(c) + '</code>')
      .replace(/\*\*([^*]+)\*\*/g, (_, t) => '<strong>' + esc(t) + '</strong>')
      .replace(/__([^_]+)__/g, (_, t) => '<strong>' + esc(t) + '</strong>')
      .replace(/\*([^*]+)\*/g, (_, t) => '<em>' + esc(t) + '</em>')
      .replace(/_([^_]+)_/g, (_, t) => '<em>' + esc(t) + '</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => '<a href="' + esc(url) + '">' + esc(text) + '</a>');
  }

  function jsonHL(str) {
    return str
      .replace(/("(?:\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*")\s*:/g, '<span class="jk">$1</span>:')
      .replace(/:\s*("(?:\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*")/g, ': <span class="js">$1</span>')
      .replace(/:\s*(-?\d+\.?\d*(?:[eE][+-]?\d+)?)/g, ': <span class="jn">$1</span>')
      .replace(/:\s*(true|false|null)/g, ': <span class="jb">$1</span>');
  }

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

  document.querySelectorAll('.bubble[data-md]').forEach(el => {
    el.innerHTML = renderMd(el.textContent.trim());
  });
  document.querySelectorAll('.bubble [data-md]').forEach(el => {
    el.innerHTML = renderMd(el.textContent.trim());
  });

  function fmtFull(iso) {
    return new Date(iso).toLocaleString(undefined, { month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit', second:'2-digit', hour12:true });
  }
  function fmtTime(iso) {
    return new Date(iso).toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit', second:'2-digit', hour12:true });
  }
  document.querySelectorAll('.turn-ts[data-iso]').forEach(el => el.textContent = fmtFull(el.dataset.iso));
  document.querySelectorAll('.p-ts[data-iso]').forEach(el => el.textContent = fmtTime(el.dataset.iso));

  function toggle(e, el) {
    if (e.target.closest('.entry-body')) return;
    el.classList.toggle('open');
  }

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
