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

  private async viewTranscript(agent: Agent): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(agent.transcriptPath));
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (err) {
      vscode.window.showErrorMessage(`Could not open transcript: ${(err as Error).message}`);
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
    <span class="auto-refresh-indicator" title="Auto-refreshing every 5s"><span class="pulse"></span></span>
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

    function renderSubGroup(label, stateKey, agents, now, cwd) {
      if (agents.length === 0) return '';
      const key = 'sub:' + stateKey + ':' + cwd;
      const open = openSections[key] !== undefined ? openSections[key] : (stateKey === 'active');
      const dotCls = stateKey === 'active' ? 'running' : stateKey === 'idle' ? 'idle' : 'done';
      const cards = agents.sort((a, b) => b.mtimeMs - a.mtimeMs).map(a => renderCard(a, now, 0)).join('');
      return '<div class="row-group sub-group' + (open ? ' open' : '') + '" data-key="' + esc(key) + '">' +
        '<div class="row-header">' +
          CARET +
          '<span class="status-dot ' + dotCls + '"></span>' +
          '<span class="row-label sub">' + label + '</span>' +
          '<span class="row-count">' + agents.length + '</span>' +
        '</div>' +
        '<div class="row-body">' + cards + '</div>' +
      '</div>';
    }

    function renderProjectSection(cwd, agents, now) {
      const key = 'proj:' + cwd;
      const open = openSections[key] !== undefined ? openSections[key] : false;
      const topState = agents.some(a => a.state === 'running') ? 'running'
                     : agents.some(a => a.state === 'idle') ? 'idle' : 'done';
      const active = agents.filter(a => a.state === 'running');
      const idle   = agents.filter(a => a.state === 'idle');
      const done   = agents.filter(a => a.state === 'done');
      return '<div class="row-group proj-group' + (open ? ' open' : '') + '" data-key="' + esc(key) + '">' +
        '<div class="row-header">' +
          CARET +
          '<span class="status-dot ' + topState + '"></span>' +
          '<span class="row-label proj">' + esc(cwd) + '</span>' +
          '<span class="row-count">' + agents.length + '</span>' +
        '</div>' +
        '<div class="row-body">' +
          renderSubGroup('Active', 'active', active, now, cwd) +
          renderSubGroup('Idle', 'idle', idle, now, cwd) +
          renderSubGroup('Done', 'done', done, now, cwd) +
        '</div>' +
      '</div>';
    }

    function renderTopSection(label, stateKey, projects, now) {
      if (projects.length === 0) return '';
      const key = 'top:' + stateKey;
      const open = openSections[key] !== undefined ? openSections[key] : (stateKey === 'active');
      const sorted = [...projects].sort((a, b) =>
        Math.max(...b[1].map(x => x.mtimeMs)) - Math.max(...a[1].map(x => x.mtimeMs))
      );
      const dotCls = stateKey === 'active' ? 'running' : stateKey === 'idle' ? 'idle' : 'done';
      const total = projects.reduce((s, [, a]) => s + a.length, 0);
      return '<div class="row-group top-group' + (open ? ' open' : '') + '" data-key="' + esc(key) + '">' +
        '<div class="row-header">' +
          CARET +
          '<span class="status-dot ' + dotCls + '"></span>' +
          '<span class="row-label">' + label + '</span>' +
          '<span class="row-count">' + total + '</span>' +
        '</div>' +
        '<div class="row-body">' +
          sorted.map(([cwd, proj]) => renderProjectSection(cwd, proj, now)).join('') +
        '</div>' +
      '</div>';
    }

    function render(agents, now, ready) {
      // Drop expanded-state entries for agents that no longer exist (walk tree).
      const live = new Set();
      const collectIds = a => { live.add(a.sessionId); (a.subagents || []).forEach(collectIds); };
      agents.forEach(collectIds);
      for (const sid of [...expanded]) if (!live.has(sid)) expanded.delete(sid);
      for (const key of [...subExpanded]) if (!live.has(key.split(':')[0])) subExpanded.delete(key);

      if (agents.length === 0) {
        root.className = 'empty-global';
        root.innerHTML = ready
          ? 'No agents yet \u2014 run <code>claude</code> in any project'
          : 'Scanning\u2026';
        return;
      }
      root.className = '';
      const topLevel = agents.filter(a => !a.parentSessionId);

      const projectMap = new Map();
      topLevel.forEach(a => {
        if (!projectMap.has(a.cwd)) projectMap.set(a.cwd, []);
        projectMap.get(a.cwd).push(a);
      });

      const activeProjects = [], idleProjects = [], doneProjects = [];
      for (const entry of projectMap) {
        if (entry[1].some(a => a.state === 'running')) activeProjects.push(entry);
        else if (entry[1].some(a => a.state === 'idle')) idleProjects.push(entry);
        else doneProjects.push(entry);
      }

      root.innerHTML =
        renderTopSection('Active', 'active', activeProjects, now) +
        renderTopSection('Idle', 'idle', idleProjects, now) +
        renderTopSection('Done', 'done', doneProjects, now);
    }

    root.addEventListener('click', (e) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;

      // Row-group toggle (custom collapsibles).
      const rowHeader = target.closest('.row-header');
      if (rowHeader && !target.closest('[data-act]') && !target.closest('[data-toggle-subs]')) {
        const group = rowHeader.closest('.row-group');
        if (group) {
          const key = group.dataset.key;
          const isOpen = group.classList.toggle('open');
          if (key) openSections[key] = isOpen;
          return;
        }
      }

      // Sub-toggle: each toggle is immediately followed by its own subagents-list.
      const subToggle = target.closest('[data-toggle-subs]');
      if (subToggle) {
        const key = subToggle.getAttribute('data-toggle-subs');
        if (!key) return;
        if (subExpanded.has(key)) subExpanded.delete(key);
        else subExpanded.add(key);
        const open = subExpanded.has(key);
        const caret = subToggle.querySelector('.sub-caret');
        const list = subToggle.nextElementSibling;
        if (list && list.classList.contains('subagents-list')) list.style.display = open ? '' : 'none';
        if (caret) caret.style.transform = open ? 'rotate(90deg)' : '';
        return;
      }

      const btn = target.closest('[data-act]');
      if (btn) {
        const card = btn.closest('[data-sid]');
        if (!card) return;
        vscode.postMessage({ command: btn.getAttribute('data-act'), sessionId: card.getAttribute('data-sid') });
        return;
      }
      const card = target.closest('.card[data-sid]');
      if (!card) return;
      // Clicks inside the details pane or subagent area shouldn't toggle card expand.
      if (target.closest('.card-details') || target.closest('.subagents-list')) return;
      const sid = card.getAttribute('data-sid');
      if (!sid) return;
      if (expanded.has(sid)) {
        expanded.delete(sid);
        card.classList.remove('expanded');
      } else {
        expanded.add(sid);
        card.classList.add('expanded');
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
