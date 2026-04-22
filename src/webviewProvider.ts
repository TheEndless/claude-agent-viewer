/**
 * webviewProvider.ts
 *
 * Implements the VS Code sidebar panel ("Agent Viewer") that lists all active
 * and archived Claude Code agent sessions. Renders agent cards as HTML inside a
 * WebviewView, handles user actions (preview transcript, open folder, stop, delete),
 * and keeps the view in sync with AgentService via its onDidChange event.
 */

import * as vscode from 'vscode';
import * as fsp from 'fs/promises';
import { AgentService } from './agentService';
import { Agent } from './types';
import { findAgentPids, killAgent } from './processService';
import { openTranscriptPreview, evict, updateTranscriptPanels } from './transcriptPanel';
import { logError } from './logger';

const AUTO_REFRESH_INTERVAL = 5000;

/**
 * VS Code WebviewViewProvider for the Agent Viewer sidebar panel.
 * Registered against the `agentViewer.panel` view type in package.json.
 */
export class AgentWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'agentViewer.panel';
  private _view?: vscode.WebviewView;
  private _refreshTimer?: ReturnType<typeof setInterval>;
  private _subscription?: vscode.Disposable;

  constructor(private readonly agentService: AgentService) {}

  /** Called by VS Code when the sidebar panel first becomes visible. Sets up the webview HTML, message handlers, and auto-refresh timer. */
  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };

    webviewView.webview.onDidReceiveMessage((message) => this.handleMessage(message));

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.startAutoRefresh();
        this.postAgents();
      } else {
        this.stopAutoRefresh();
      }
    });

    webviewView.onDidDispose(() => {
      this.stopAutoRefresh();
      this._subscription?.dispose();
    });

    const d1 = this.agentService.onDidChange((agents) => {
      this.postAgents();
      updateTranscriptPanels(agents);
    });
    const d2 = this.agentService.onDidDrop((sessionId) => evict(sessionId));
    this._subscription = { dispose: () => { d1.dispose(); d2.dispose(); } };

    webviewView.webview.html = this.getHtml();
    this.postAgents();
    this.startAutoRefresh();
  }

  /** Manually pushes the current agent list to the webview. Used by command palette refresh. */
  refresh(): void {
    this.postAgents();
  }

  /** Serializes the agent tree and posts a `render` message to the webview. */
  private postAgents(): void {
    if (!this._view) return;
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
    const agents = this.agentService.getAgents().map(serialize);
    const ready = this.agentService.isReady();
    this._view.webview.postMessage({ command: 'render', agents, ready, now: Date.now() });
  }

  /** Dispatches messages from the webview to the appropriate action handler. */
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

  private async openFolder(agent: Agent): Promise<void> {
    const uri = vscode.Uri.file(agent.cwd);
    await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
  }

  /** Finds the Claude process(es) for the agent's cwd and prompts the user before sending SIGTERM. */
  private async stopAgent(agent: Agent): Promise<void> {
    const matches = await findAgentPids(agent.cwd);
    if (matches.length === 0) {
      vscode.window.showWarningMessage(
        `No running Claude process found for ${agent.projectName}.`,
      );
      return;
    }
    let pid: number;
    if (matches.length === 1) {
      pid = matches[0].pid;
    } else {
      const pick = await vscode.window.showQuickPick(
        matches.map((m) => ({ label: `pid ${m.pid}`, description: m.command, pid: m.pid })),
        { placeHolder: `Multiple Claude processes match ${agent.cwd} — pick one to stop` },
      );
      if (!pick) return;
      pid = pick.pid;
    }
    const answer = await vscode.window.showWarningMessage(
      `Stop Claude process for "${agent.projectName}" (pid ${pid})?`,
      { modal: true },
      'Stop',
    );
    if (answer !== 'Stop') return;
    try {
      killAgent(pid);
    } catch (err) {
      logError(`stopAgent(${pid})`, err);
      vscode.window.showErrorMessage(`Failed to stop pid ${pid}: ${(err as Error).message}`);
    }
  }

  /** Prompts for confirmation then deletes the transcript file and evicts the agent from all caches. */
  private async deleteAgent(agent: Agent): Promise<void> {
    const answer = await vscode.window.showWarningMessage(
      `Delete transcript for "${agent.projectName}"?`,
      { modal: true },
      'Delete',
    );
    if (answer !== 'Delete') return;
    try {
      await fsp.unlink(agent.transcriptPath);
      evict(agent.sessionId);
    } catch (err) {
      logError(`deleteAgent(${agent.sessionId})`, err);
      vscode.window.showErrorMessage(
        `Failed to delete transcript: ${(err as Error).message}`,
      );
    }
  }

  private startAutoRefresh(): void {
    this.stopAutoRefresh();
    this._refreshTimer = setInterval(() => this.postAgents(), AUTO_REFRESH_INTERVAL);
  }

  private stopAutoRefresh(): void {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = undefined;
    }
  }

  /** Returns the full HTML for the sidebar webview, including all CSS and JS for the agent card UI. */
  private getHtml(): string {
    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      padding: 0 0 16px;
    }


    .empty-global {
      text-align: center;
      padding: 24px 12px;
      color: var(--vscode-disabledForeground);
      font-size: 12px;
    }

    .status-dot {
      flex-shrink: 0;
      width: 7px;
      height: 7px;
      border-radius: 50%;
    }
    .status-dot.running { background: #3fb950; box-shadow: 0 0 4px rgba(63,185,80,0.5); }
    .status-dot.idle    { background: #d29922; }
    .status-dot.done    { background: #6e7681; }

    .card {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-widget-border, var(--vscode-input-border));
      border-radius: 5px;
      margin: 3px 8px;
      overflow: hidden;
    }
    .card:hover { border-color: color-mix(in srgb, var(--vscode-focusBorder) 60%, transparent); }

    .card-top {
      position: relative;
      display: flex;
      align-items: center;
      gap: 5px;
      height: 30px;
      overflow: hidden;
      padding: 0 8px;
      cursor: pointer;
      user-select: none;
    }
    .card-top:hover { background: rgba(128,128,128,0.05); }
    .card-top:hover .card-time    { display: none; }
    .card-top:hover .card-actions { display: flex; }

    .card-name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
      font-size: 13px;
      color: var(--vscode-foreground);
    }
    .card-name.no-prompt { color: var(--vscode-disabledForeground); }

    .card-slot {
      flex-shrink: 0;
      display: flex;
      align-items: center;
    }

    .card-time {
      font-size: 10px;
      color: var(--vscode-disabledForeground);
    }

    .card-actions {
      display: none;
      align-items: center;
      gap: 2px;
    }

    .card-path {
      padding: 0 8px 6px 20px;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      overflow: hidden;
    }
    .proj-path {
      display: block;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      direction: rtl;
      text-align: left;
    }
    .session-id {
      display: block;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      opacity: 0.5;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 9px;
      margin-top: 1px;
    }

    .sub-toggle {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 4px 8px;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      user-select: none;
      border-top: 1px solid var(--vscode-widget-border, var(--vscode-input-border));
    }
    .sub-toggle:hover { color: var(--vscode-foreground); background: rgba(128,128,128,0.04); }
    .sub-caret {
      display: inline-block;
      font-size: 9px;
      transition: transform 0.1s;
      opacity: 0.5;
    }
    .card.subs-open .sub-caret { transform: rotate(90deg); }
    .sub-list { display: none; }
    .card.subs-open .sub-list { display: block; }

    .sub-row {
      position: relative;
      display: flex;
      align-items: center;
      gap: 5px;
      height: 22px;
      padding: 0 8px 0 20px;
      cursor: pointer;
      user-select: none;
      border-top: 1px solid color-mix(in srgb, var(--vscode-widget-border, var(--vscode-input-border)) 50%, transparent);
    }
    .sub-row:hover { background: var(--vscode-list-hoverBackground); }
    .sub-row:hover .sub-time    { display: none; }
    .sub-row:hover .sub-actions { display: flex; }
    .sub-row.done-sub { opacity: 0.6; }

    .sub-name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
      font-size: 12px;
      color: var(--vscode-foreground);
    }
    .sub-time {
      font-size: 10px;
      color: var(--vscode-disabledForeground);
    }
    .sub-actions {
      display: none;
      align-items: center;
      gap: 2px;
    }

    .action-btn {
      background: none;
      border: none;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      padding: 0 3px;
      height: 20px;
      border-radius: 4px;
      font-size: 12px;
      display: flex;
      align-items: center;
    }
    .action-btn:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
    .action-btn.danger:hover { color: #f85149; }

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
    .archive-section.open > .archive-row > .arch-caret { transform: rotate(90deg); }
    .arch-caret { display: inline-block; font-size: 9px; transition: transform 0.1s; opacity: 0.5; }
    .archive-label { flex: 1; }
    .archive-count { color: var(--vscode-disabledForeground); flex-shrink: 0; }

    .archive-body { display: none; opacity: 0.8; }
    .archive-section.open > .archive-body { display: block; }
    /* done-sub dimming is for live parents' finished subs; inside archive, the archive-body opacity already handles it. */
    .archive-body .sub-row.done-sub { opacity: 1; }
  </style>
</head>
<body>
  <div id="root" class="empty-global">Loading agents…</div>

  <script>
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

    function renderActionBtns(stopBtn) {
      return '<button class="action-btn" data-act="previewTranscript" title="Preview">\ud83d\udcac</button>' +
        '<button class="action-btn" data-act="openFolder" title="Open folder">\ud83d\udcc1</button>' +
        stopBtn +
        '<button class="action-btn danger" data-act="delete" title="Delete">\u2715</button>';
    }

    function renderSubRow(sub, now) {
      const task = sub.taskDescription || (sub.details && sub.details.latestUserPrompt) || sub.sessionId.slice(0, 8);
      const doneCls = sub.state === 'done' ? ' done-sub' : '';
      const stopBtn = sub.state === 'running'
        ? '<button class="action-btn danger" data-act="stop" title="Stop">\u25a0</button>'
        : '';
      return '<div class="sub-row' + doneCls + '" data-sid="' + esc(sub.sessionId) + '">' +
        '<span class="status-dot ' + esc(sub.state) + '"></span>' +
        '<span class="sub-name">' + esc(task) + '</span>' +
        '<div class="card-slot">' +
          '<span class="sub-time">' + relTimeShort(sub.mtimeMs, now) + '</span>' +
          '<div class="sub-actions">' + renderActionBtns(stopBtn) + '</div>' +
        '</div>' +
      '</div>';
    }

    function renderCard(parent, now) {
      const key = 'parent:' + parent.sessionId;
      const allSubs = parent.subagents || [];
      const effState = parentEffectiveState(parent);
      const shownSubs = allSubs;
      const subsOpen = openSections[key + ':subs'] !== undefined
        ? openSections[key + ':subs']
        : false;

      const d = parent.details || {};
      const prompt = d.customTitle || d.aiTitle || d.latestUserPrompt || d.lastPrompt || null;
      const nameCls = prompt ? '' : ' no-prompt';

      const stopBtn = effState === 'running'
        ? '<button class="action-btn danger" data-act="stop" title="Stop">\u25a0</button>'
        : '';

      const subSection = shownSubs.length > 0
        ? '<div class="sub-toggle" data-sub-key="' + esc(key) + '">' +
            '<span class="sub-caret">\u25b6</span>' +
            '<span>' + shownSubs.length + ' subagent' + (shownSubs.length !== 1 ? 's' : '') + '</span>' +
          '</div>' +
          '<div class="sub-list">' +
            shownSubs.slice().sort((a, b) => b.mtimeMs - a.mtimeMs).map(s => renderSubRow(s, now)).join('') +
          '</div>'
        : '';

      return '<div class="card' + (subsOpen ? ' subs-open' : '') + '" data-key="' + esc(key) + '" data-sid="' + esc(parent.sessionId) + '">' +
        '<div class="card-top">' +
          '<span class="status-dot ' + esc(effState) + '"></span>' +
          '<span class="card-name' + nameCls + '">' + esc(prompt || '(no prompt yet)') + '</span>' +
          '<div class="card-slot">' +
            '<span class="card-time">' + relTimeShort(parentMaxMtime(parent), now) + '</span>' +
            '<div class="card-actions">' + renderActionBtns(stopBtn) + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="card-path"><span class="proj-path">\u200E' + esc(parent.cwd) + '</span><span class="session-id">' + esc(parent.sessionId) + '</span></div>' +
        subSection +
      '</div>';
    }

    function renderArchive(doneParents, now) {
      const open = openSections['archive'] || false;
      const count = doneParents.length;
      return '<hr class="archive-divider">' +
        '<div class="archive-section' + (open ? ' open' : '') + '" data-key="archive">' +
          '<div class="archive-row">' +
            '<span class="arch-caret">\u25b6</span>' +
            '<span class="archive-label">' + (open ? 'Hide archive' : 'Show archive') + '</span>' +
            '<span class="archive-count">' + count + ' session' + (count !== 1 ? 's' : '') + '</span>' +
          '</div>' +
          '<div class="archive-body">' +
            doneParents.map(p => renderCard(p, now)).join('') +
          '</div>' +
        '</div>';
    }

    function render(agents, now, ready) {
      if (!ready) {
        root.className = 'empty-global';
        root.innerHTML = 'Scanning\u2026';
        return;
      }
      if (!agents || agents.length === 0) {
        root.className = 'empty-global';
        root.innerHTML = 'No agents yet \u2014 run <code>claude</code> in any project';
        return;
      }
      root.className = '';

      const parents = agents.filter(a => !a.parentSessionId);

      const primary = [], archive = [];
      for (const p of parents) {
        const done = parentEffectiveState(p) === 'done' && !(p.subagents || []).some(s => s.state === 'running');
        (done ? archive : primary).push(p);
      }

      primary.sort((a, b) => parentMaxMtime(b) - parentMaxMtime(a));
      archive.sort((a, b) => b.mtimeMs - a.mtimeMs);

      root.innerHTML = primary.map(p => renderCard(p, now)).join('') + renderArchive(archive, now);
    }

    root.addEventListener('click', (e) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;

      // Action buttons — handled first so they don't fall through.
      const btn = target.closest('[data-act]');
      if (btn) {
        const sidEl = btn.closest('[data-sid]');
        const sid = sidEl ? sidEl.getAttribute('data-sid') : null;
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

      // Sub-toggle: collapse/expand subagent list within a card.
      const subToggle = target.closest('.sub-toggle');
      if (subToggle) {
        const card = subToggle.closest('.card');
        if (!card) return;
        const isOpen = card.classList.toggle('subs-open');
        const key = card.dataset.key;
        if (key) openSections[key + ':subs'] = isOpen;
        return;
      }

      // Sub-row click opens preview.
      const subRow = target.closest('.sub-row');
      if (subRow) {
        const sid = subRow.getAttribute('data-sid');
        if (sid) vscode.postMessage({ command: 'previewTranscript', sessionId: sid });
        return;
      }

      // Card-top click opens preview.
      const cardTop = target.closest('.card-top');
      if (cardTop) {
        const card = cardTop.closest('.card');
        const sid = card ? card.getAttribute('data-sid') : null;
        if (sid) vscode.postMessage({ command: 'previewTranscript', sessionId: sid });
        return;
      }
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg && msg.command === 'render') render(msg.agents, msg.now, msg.ready);
    });
  </script>
</body>
</html>`;
  }
}
