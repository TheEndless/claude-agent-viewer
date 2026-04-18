import * as vscode from 'vscode';
import * as fsp from 'fs/promises';
import { AgentService } from './agentService';
import { Agent } from './types';
import { findAgentPids, killAgent } from './processService';
import { openTranscriptPreview, evict, updateTranscriptPanels } from './transcriptPanel';

const AUTO_REFRESH_INTERVAL = 5000;

export class AgentWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'agentViewer.panel';
  private _view?: vscode.WebviewView;
  private _refreshTimer?: ReturnType<typeof setInterval>;
  private _subscription?: vscode.Disposable;

  constructor(private readonly agentService: AgentService) {}

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

    this._subscription = this.agentService.onDidChange((agents) => {
      this.postAgents();
      updateTranscriptPanels(agents);
    });

    webviewView.webview.html = this.getHtml();
    this.postAgents();
    this.startAutoRefresh();
  }

  refresh(): void {
    this.postAgents();
  }

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
      vscode.window.showErrorMessage(`Failed to stop pid ${pid}: ${(err as Error).message}`);
    }
  }

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

    .status-dot {
      flex-shrink: 0;
      width: 7px;
      height: 7px;
      border-radius: 50%;
    }
    .status-dot.running { background: #3fb950; box-shadow: 0 0 4px rgba(63,185,80,0.5); }
    .status-dot.idle    { background: #d29922; }
    .status-dot.done    { background: #6e7681; }

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
  </style>
</head>
<body>
  <div class="header">
    <h2>Agents</h2>
    <button class="header-refresh" id="refresh-btn" title="Refresh">&#x21bb;</button>
  </div>
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

    const CARET = '<span class="row-caret"><svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';

    function renderSubagentRow(sub, now) {
      const task = sub.taskDescription || (sub.details && sub.details.latestUserPrompt) || sub.sessionId.slice(0, 8);
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
          '<span class="status-dot ' + esc(effState) + '"></span>' +
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

    root.addEventListener('click', (e) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;

      // Action buttons — handled first so they don't fall through to row clicks.
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

      // Parent header: caret toggles expand; everything else opens preview.
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
        const sid = parentRow.getAttribute('data-sid');
        if (sid) vscode.postMessage({ command: 'previewTranscript', sessionId: sid });
        return;
      }

      // Subagent row click opens preview.
      const subRow = target.closest('.subagent-row');
      if (subRow) {
        const sid = subRow.getAttribute('data-sid');
        if (sid) vscode.postMessage({ command: 'previewTranscript', sessionId: sid });
        return;
      }
    });

    document.getElementById('refresh-btn')?.addEventListener('click', () => {
      vscode.postMessage({ command: 'refresh' });
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
