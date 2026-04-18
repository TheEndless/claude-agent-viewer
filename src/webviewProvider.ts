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
      padding: 12px 0 8px;
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

    .auto-refresh-indicator {
      font-size: 10px;
      color: var(--vscode-disabledForeground);
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .pulse {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: #3fb950;
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 0.3; }
      50% { opacity: 1; }
    }

    .row-header {
      display: flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
      user-select: none;
      border-radius: 2px;
      overflow: hidden;
    }
    .row-header:hover { background: var(--vscode-list-hoverBackground); }

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
    .row-group.open > .row-header > .row-caret { transform: rotate(90deg); }

    .row-label {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-sideBarSectionHeader-foreground);
    }
    .row-label.proj {
      font-weight: 400;
      text-transform: none;
      letter-spacing: 0;
      color: var(--vscode-foreground);
      direction: rtl;
      unicode-bidi: plaintext;
    }
    .row-label.sub {
      font-weight: 500;
      text-transform: none;
      letter-spacing: 0;
      color: var(--vscode-foreground);
    }

    .row-count {
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

    .row-body { display: none; }
    .row-group.open > .row-body { display: block; }

    .top-group > .row-header  { padding: 6px 8px; }
    .proj-group > .row-header { padding: 3px 8px 3px 16px; }
    .sub-group  > .row-header { padding: 3px 8px 3px 24px; }
    .sub-group  > .row-body > .card { margin: 2px 8px 2px 32px; }

    .empty {
      padding: 4px 14px;
      color: var(--vscode-disabledForeground);
      font-size: 11px;
    }

    .card {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-widget-border, transparent);
      border-radius: 4px;
      padding: 5px 8px;
      margin: 2px 0;
      cursor: pointer;
    }
    .card:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .card:hover .card-actions { opacity: 1; }

    .card-details {
      display: none;
      margin-top: 10px;
      padding-top: 8px;
      border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      cursor: default;
    }
    .card.expanded .card-details { display: block; }

    .detail-row {
      margin-bottom: 6px;
      line-height: 1.5;
    }
    .detail-label {
      text-transform: uppercase;
      letter-spacing: 0.5px;
      font-size: 9px;
      color: var(--vscode-sideBarSectionHeader-foreground);
      margin-bottom: 2px;
    }
    .detail-value {
      color: var(--vscode-foreground);
      word-break: break-all;
    }
    .detail-value.muted {
      color: var(--vscode-descriptionForeground);
    }

    .trail {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    .trail li {
      display: flex;
      gap: 6px;
      align-items: baseline;
      padding: 2px 0;
    }
    .trail .trail-summary {
      color: var(--vscode-foreground);
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .trail .trail-time {
      color: var(--vscode-disabledForeground);
      font-size: 10px;
      flex-shrink: 0;
    }

    .files {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    .files li {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 10px;
      color: var(--vscode-textLink-foreground);
      padding: 1px 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .chev {
      color: var(--vscode-icon-foreground);
      opacity: 0.5;
      font-size: 9px;
      margin-left: 6px;
      transition: transform 0.1s ease;
      display: inline-block;
    }
    .card.expanded .chev { transform: rotate(90deg); }

    .sub-toggle {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 5px 2px 2px;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      user-select: none;
      border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.15));
      margin-top: 6px;
    }
    .sub-toggle:hover { color: var(--vscode-foreground); }
    .sub-caret {
      display: inline-block;
      font-size: 8px;
      transition: transform 0.1s ease;
    }
.card-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .card-info { flex: 1; min-width: 0; }

    .card-name {
      font-size: 13px;
      font-weight: 500;
      color: var(--vscode-foreground);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      display: flex;
      align-items: center;
    }
    .card-meta {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-top: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .status-dot {
      display: inline-block;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      margin-right: 6px;
      flex-shrink: 0;
    }
    .status-dot.running {
      background: #3fb950;
      box-shadow: 0 0 6px rgba(63, 185, 80, 0.4);
    }
    .status-dot.idle { background: #d29922; }
    .status-dot.done { background: #6e7681; }

    .card-actions {
      display: flex;
      align-items: center;
      gap: 2px;
      opacity: 0;
      transition: opacity 0.15s;
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

    .empty-global {
      text-align: center;
      padding: 24px 12px;
      color: var(--vscode-disabledForeground);
      font-size: 12px;
    }
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

    // Preserve <details> open state across re-renders, keyed by project name.
    const openSections = {};
    // Preserve per-card expanded state across re-renders.
    const expanded = new Set();
    // Tracks which parent cards have their subagent list expanded (collapsed by default).
    const subExpanded = new Set();

    function esc(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function relTime(ms, now) {
      const d = now - ms;
      if (d < 10000) return 'now';
      if (d < 60000) return Math.floor(d / 1000) + 's ago';
      if (d < 3600000) return Math.floor(d / 60000) + 'm ago';
      if (d < 86400000) return Math.floor(d / 3600000) + 'h ago';
      return Math.floor(d / 86400000) + 'd ago';
    }

    function detailRow(label, body) {
      return \`<div class="detail-row"><div class="detail-label">\${label}</div>\${body}</div>\`;
    }

    function muted(text) {
      return \`<div class="detail-value muted">\${text}</div>\`;
    }

    function renderTrail(calls, now) {
      if (!calls || calls.length === 0) return muted('No recent tool calls');
      const items = calls.map(c => \`<li>
        <span class="trail-summary">\${esc(c.summary)}</span>
        \${c.at ? \`<span class="trail-time">\${esc(relTime(c.at, now))}</span>\` : ''}
      </li>\`).join('');
      return \`<ul class="trail">\${items}</ul>\`;
    }

    function renderFiles(files) {
      if (!files || files.length === 0) return muted('No files touched');
      const items = files.map(f => \`<li>\${esc(f)}</li>\`).join('');
      return \`<ul class="files">\${items}</ul>\`;
    }

    function renderDetails(a, now) {
      const d = a.details || {};
      const prompt = d.latestUserPrompt
        ? \`<div class="detail-value">\${esc(d.latestUserPrompt)}</div>\`
        : muted('No user prompt captured');
      const subagents = d.subagentCount > 0
        ? detailRow('Subagents', \`<div class="detail-value">\${d.subagentCount} spawned</div>\`)
        : '';
      return \`<div class="card-details">
        \${detailRow('Working directory', \`<div class="detail-value">\${esc(a.cwd)}</div>\`)}
        \${detailRow('Last activity', \`<div class="detail-value">\${esc(relTime(a.mtimeMs, now))}</div>\`)}
        \${detailRow('Latest user prompt', prompt)}
        \${detailRow('Recent tool calls', renderTrail(d.recentToolCalls, now))}
        \${detailRow('Recent files', renderFiles(d.recentFiles))}
        \${subagents}
      </div>\`;
    }

    function renderCard(a, now, indent) {
      indent = indent || 0;
      const stopBtn = a.state === 'running'
        ? '<button class="action-btn danger" data-act="stop" title="Stop agent">\u25a0</button>'
        : '';
      const isOpen = expanded.has(a.sessionId);
      const subs = a.subagents || [];
      const activeSubs = subs.filter(s => s.state === 'running');
      const inactiveSubs = subs.filter(s => s.state !== 'running');
      function subSection(key, label, list) {
        if (list.length === 0) return '';
        const open = subExpanded.has(key);
        return '<div class="sub-toggle" data-toggle-subs="' + esc(key) + '">' +
            '<span class="sub-caret" style="' + (open ? 'transform:rotate(90deg)' : '') + '">\u25b8</span>' +
            list.length + ' ' + label + (list.length > 1 ? 's' : '') +
          '</div>' +
          '<div class="subagents-list"' + (open ? '' : ' style="display:none"') + '>' +
            list.map(s => renderCard(s, now, indent + 1)).join('') +
          '</div>';
      }
      const subHtml = subSection(a.sessionId + ':active', 'active subagent', activeSubs) +
                      subSection(a.sessionId + ':inactive', 'inactive subagent', inactiveSubs);
      return '<div class="card' + (isOpen ? ' expanded' : '') + (indent > 0 ? ' subagent-card' : '') + '" data-sid="' + esc(a.sessionId) + '" style="' + (indent > 0 ? 'margin-left:16px;border-left:2px solid var(--vscode-panel-border);' : '') + '">' +
        '<div class="card-top">' +
          '<div class="card-info">' +
            '<div class="card-name">' +
              '<span class="status-dot ' + esc(a.state) + '"></span>' +
              esc(a.activity) +
              '<span class="chev">\u25b8</span>' +
            '</div>' +
            '<div class="card-meta">' + esc(relTime(a.mtimeMs, now)) + '</div>' +
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
