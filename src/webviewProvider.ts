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
import { logError, logInfo } from './logger';


/**
 * VS Code WebviewViewProvider for the Agent Viewer sidebar panel.
 * Registered against the `agentViewer.panel` view type in package.json.
 */
export class AgentWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'agentViewer.panel';
  private _view?: vscode.WebviewView;
  private _subscription?: vscode.Disposable;
  // When true, done parent agents and their subagents are excluded from postAgents()
  // so we never serialize/transfer thousands of stale sessions on every tick.
  private _hideDone = true;
  // How many done parents to include when _hideDone is false. Incremented by
  // DONE_PAGE_SIZE each time the user clicks "Load more". Reset to 0 when hideDone
  // is re-enabled so the next reveal starts from the top again.
  private _doneLoaded = 0;
  private static readonly DONE_PAGE_SIZE = 100;

  constructor(private readonly agentService: AgentService) { }

  /** Called by VS Code when the sidebar panel first becomes visible. Sets up the webview HTML, message handlers, and auto-refresh timer. */
  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };

    webviewView.webview.onDidReceiveMessage((message) => this.handleMessage(message));

    webviewView.onDidChangeVisibility(() => {
      this.agentService.setVisible(webviewView.visible);
    });

    webviewView.onDidDispose(() => {
      this.agentService.setVisible(false);
      this._subscription?.dispose();
    });

    const d1 = this.agentService.onDidChange((agents) => {
      if (webviewView.visible) this.postAgents();
      updateTranscriptPanels(agents);
    });
    const d2 = this.agentService.onDidDrop((sessionId) => evict(sessionId));
    this._subscription = { dispose: () => { d1.dispose(); d2.dispose(); } };

    webviewView.webview.html = this.getHtml();
    this.postAgents();
  }

  /** Forces a re-scan of session files and re-renders the sidebar. */
  refresh(): void {
    this._view?.webview.postMessage({ command: 'reset' });
    void this.agentService.refresh();
  }

  /** Serializes the agent tree and posts a `render` message to the webview.
   *
   * When _hideDone is true, done parent sessions and all their subagents are
   * excluded before serialization. This is the critical perf guard: with 3000+
   * tracked sessions, serializing and postMessage-ing all of them on every tick
   * costs ~2MB of JSON transfer + parse even though the webview discards almost
   * all of it. Filtering here keeps the payload to the handful of live sessions.
   */
  private postAgents(): void {
    if (!this._view) return;
    const serialize = (a: Agent): object => ({
      sessionId: a.sessionId,
      projectName: a.projectName,
      cwd: a.cwd,
      state: a.state,
      activityHistory: a.activityHistory,
      model: a.model,
      turnCount: a.turnCount,
      contextPct: a.contextPct,
      mtimeMs: a.mtimeMs,
      details: a.details,
      parentSessionId: a.parentSessionId,
      taskDescription: a.taskDescription,
      subagents: a.subagents.map(serialize),
    });

    const allAgents = this.agentService.getAgents();
    let agentsToSend = allAgents;
    let doneParentCount = 0;

    // Sort done parents newest-first and either exclude them all (hideDone) or
    // include only the first _doneLoaded (paged reveal).
    const allDoneParents = allAgents
      .filter(a => !a.parentSessionId && a.state === 'done');
    doneParentCount = allDoneParents.length;

    const excludedDoneIds = new Set<string>();
    let remainingDone = 0;

    if (this._hideDone) {
      // Exclude all done parents.
      for (const a of allDoneParents) excludedDoneIds.add(a.sessionId);
    } else {
      // Include the paged slice; exclude the rest.
      const visible = allDoneParents.slice(0, this._doneLoaded);
      const hidden = allDoneParents.slice(this._doneLoaded);
      remainingDone = hidden.length;
      for (const a of hidden) excludedDoneIds.add(a.sessionId);
    }

    if (excludedDoneIds.size > 0) {
      agentsToSend = allAgents.filter(a =>
        !excludedDoneIds.has(a.sessionId) &&
        !(a.parentSessionId && excludedDoneIds.has(a.parentSessionId))
      );
    }

    const ready = this.agentService.isReady();
    const t0 = Date.now();
    const payload = agentsToSend.map(serialize);
    const serializeMs = Date.now() - t0;
    logInfo('postAgents', `sending=${payload.length}/${allAgents.length} doneHidden=${excludedDoneIds.size} serializeMs=${serializeMs}ms`);
    this._view.webview.postMessage({ command: 'render', agents: payload, ready, now: Date.now(), doneParentCount, remainingDone });
  }

  /** Dispatches messages from the webview to the appropriate action handler. */
  private async handleMessage(message: { command: string; sessionId?: string; hideDone?: boolean; value?: boolean }): Promise<void> {
    const { command, sessionId } = message;
    logInfo('handleMessage', sessionId ? `${command} sid=${sessionId.slice(0, 8)}` : command);

    if (command === 'refresh') {
      // Explicit user-initiated refresh (toolbar button). Does NOT come from the
      // webview script-load path — that sends 'syncPrefs' instead.
      this._view?.webview.postMessage({ command: 'reset' });
      this.refresh();
      return;
    }

    if (command === 'syncPrefs') {
      // Sent by the webview on script load to sync persisted preferences without
      // triggering a full agent re-scan. Previously this was 'refresh', which
      // caused agentService.refresh() (clear all + re-scan 3500 files) on every
      // sidebar open — the likely root cause of "buttons stop working" freezes.
      if (typeof message.hideDone === 'boolean') this._hideDone = message.hideDone;
      this.postAgents();
      return;
    }

    if (command === 'setHideDone') {
      this._hideDone = message.value !== false;
      // Reset pagination so toggling back on → off always starts from the top.
      this._doneLoaded = this._hideDone ? 0 : AgentWebviewProvider.DONE_PAGE_SIZE;
      this.postAgents();
      return;
    }

    if (command === 'loadMoreDone') {
      this._doneLoaded += AgentWebviewProvider.DONE_PAGE_SIZE;
      this.postAgents();
      return;
    }

    if (!sessionId) return;
    const agent = this.agentService.getAgent(sessionId);
    if (!agent) return;

    switch (command) {
      case 'previewTranscript':
        openTranscriptPreview(agent);
        return;
      case 'openJsonl':
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(agent.transcriptPath));
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

  private agentDisplayName(agent: Agent): string {
    const d = agent.details;
    return d?.customTitle || d?.aiTitle || d?.latestUserPrompt || agent.projectName;
  }

  /** Finds the Claude process(es) for the agent's cwd and prompts the user before sending SIGTERM. */
  private async stopAgent(agent: Agent): Promise<void> {
    const matches = await findAgentPids(agent.cwd);
    if (matches.length === 0) {
      vscode.window.showWarningMessage(
        `No running Claude process found for ${this.agentDisplayName(agent)}.`,
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
      `Stop Claude process for "${this.agentDisplayName(agent)}" (pid ${pid})?`,
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
      `Delete transcript for "${this.agentDisplayName(agent)}"?`,
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


  /** Returns the full HTML for the sidebar webview, including all CSS and JS for the agent card UI. */
  private getHtml(): string {
    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
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
    .sub-active-dot {
      display: inline-block; flex-shrink: 0;
      width: 4px; height: 4px; border-radius: 50%;
      background: #3fb950;
    }

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

    /* ── project groups ── */
    .proj-group { margin-top: 4px; }
    .proj-header {
      display: flex; align-items: center; gap: 6px;
      height: 24px; padding: 0 8px;
      cursor: pointer; user-select: none;
      border-radius: 3px;
    }
    .proj-header:hover { background: rgba(128,128,128,0.05); }
    .proj-caret { font-size: 9px; opacity: 0.5; transition: transform 0.1s; flex-shrink: 0; }
    .proj-group.open .proj-caret { transform: rotate(90deg); }
    .proj-name { flex: 1; font-size: 11px; font-weight: 600; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .proj-badge {
      font-size: 9px; padding: 1px 5px; border-radius: 3px; flex-shrink: 0;
    }
    .proj-badge.running { background: rgba(63,185,80,.12); border: 1px solid rgba(63,185,80,.2); color: #3fb950; }
    .proj-badge.idle    { background: rgba(210,153,34,.1);  border: 1px solid rgba(210,153,34,.2); color: #d29922; }
    .proj-badge.done    { background: rgba(110,118,129,.1); border: 1px solid rgba(110,118,129,.2); color: #6e7681; }
    .proj-body { display: none; }
    .proj-group.open .proj-body { display: block; }
    .proj-group.inactive { opacity: 0.75; }
    .archived-section { margin-top: 6px; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2)); }
    .archived-header { display: flex; align-items: center; gap: 4px; padding: 5px 8px; cursor: pointer; user-select: none; font-size: 11px; color: var(--vscode-descriptionForeground); }
    .archived-header:hover { color: var(--vscode-foreground); background: rgba(128,128,128,.05); }
    .archived-caret { font-size: 9px; opacity: 0.5; transition: transform 0.1s; flex-shrink: 0; }
    .archived-section.open .archived-caret { transform: rotate(90deg); }
    .archived-count { color: var(--vscode-disabledForeground); margin-left: 2px; }
    .archived-body { display: none; }
    .archived-section.open .archived-body { display: block; }

    /* ── filter bar ── */
    .filter-bar { display: flex; align-items: center; gap: 4px; padding: 5px 8px 4px; }
    .filter-input {
      flex: 1; min-width: 0;
      background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border);
      color: var(--vscode-input-foreground); border-radius: 4px; padding: 3px 8px;
      font-size: 11px; font-family: var(--vscode-font-family); outline: none;
    }
    .filter-input:focus { border-color: var(--vscode-focusBorder); }
    .hide-done-btn {
      flex-shrink: 0; background: none; border: 1px solid var(--vscode-input-border);
      color: var(--vscode-descriptionForeground); border-radius: 3px; padding: 2px 6px;
      font-size: 10px; cursor: pointer; white-space: nowrap; line-height: 1.4;
    }
    .hide-done-btn:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground); }
    .hide-done-btn.active { border-color: rgba(110,118,129,.4); color: #6e7681; background: rgba(110,118,129,.08); }

    /* ── activity timeline ── */
    .activity-timeline { padding: 0 8px 6px 20px; display: flex; flex-direction: column; gap: 3px; }
    .act-row { display: flex; align-items: center; gap: 5px; font-size: 11px; }
    .act-pip { width: 3px; height: 3px; border-radius: 50%; flex-shrink: 0; }
    .act-row.act-current .act-pip   { background: var(--vscode-textLink-foreground, #4fc1ff); }
    .act-row.act-current .act-label { color: var(--vscode-textLink-foreground, #4fc1ff); }
    .act-row.act-prev1 { opacity: 0.55; }
    .act-row.act-prev2 { opacity: 0.32; }
    .act-row .act-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); }
    .act-row .act-time  { font-size: 10px; color: var(--vscode-disabledForeground); flex-shrink: 0; }
    .stuck-badge {
      margin: 0 8px 6px; padding: 2px 7px; border-radius: 3px; font-size: 10px;
    }
    .stuck-loop { background: rgba(120,53,15,.4); border: 1px solid rgba(120,53,15,.6); color: #fb923c; }
    .stuck-stall { background: rgba(55,48,163,.3); border: 1px solid rgba(55,48,163,.5); color: #a5b4fc; }

    /* ── meta-bar ── */
    .meta-bar { display: flex; align-items: center; gap: 6px; padding: 0 8px 5px 20px; font-size: 10px; color: var(--vscode-disabledForeground); }
    .model-chip {
      display: inline-flex; align-items: center;
      background: rgba(79,193,255,.08); border: 1px solid rgba(79,193,255,.15);
      border-radius: 3px; padding: 0 5px; height: 14px; font-size: 9px;
      color: var(--vscode-textLink-foreground, #4fc1ff); white-space: nowrap; flex-shrink: 0;
    }
    .meta-sep { color: var(--vscode-input-border); flex-shrink: 0; }
    .ctx-wrap { display: flex; align-items: center; gap: 4px; }
    .ctx-bar-bg { width: 40px; height: 3px; border-radius: 2px; background: rgba(128,128,128,.2); overflow: hidden; }
    .ctx-bar-fill { height: 100%; border-radius: 2px; background: var(--vscode-textLink-foreground, #4fc1ff); opacity: .65; transition: width 0.3s; }
    .ctx-pct { font-size: 9px; }

    /* ── subagent state dots ── */
    .sub-state-dots { display: flex; gap: 3px; margin-left: 3px; }
    .ssd { width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0; }
    .ssd.running { background: #3fb950; box-shadow: 0 0 3px rgba(63,185,80,.5); }
    .ssd.idle    { background: #d29922; }
    .ssd.done    { background: #6e7681; }

    /* ── ended sessions toggle ── */
    .ended-toggle {
      display: flex; align-items: center; gap: 4px;
      padding: 3px 8px 3px 10px; margin: 1px 4px;
      font-size: 11px; color: var(--vscode-descriptionForeground);
      cursor: pointer; user-select: none; border-radius: 3px;
    }
    .ended-toggle:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground); }

    .load-more-done {
      display: block; width: calc(100% - 16px); margin: 6px 8px 2px;
      padding: 5px 0; background: none;
      border: 1px dashed var(--vscode-input-border); border-radius: 4px;
      color: var(--vscode-descriptionForeground); font-size: 11px;
      cursor: pointer; text-align: center;
    }
    .load-more-done:hover { color: var(--vscode-foreground); border-color: var(--vscode-focusBorder); background: var(--vscode-list-hoverBackground); }

    @keyframes spin { to { transform: rotate(360deg); } }
    .scanning-label {
      display: flex; align-items: center; justify-content: center; gap: 6px;
      color: var(--vscode-descriptionForeground); padding: 8px 12px;
    }
    .spinner {
      flex-shrink: 0; width: 11px; height: 11px; border-radius: 50%;
      border: 1.5px solid var(--vscode-disabledForeground);
      border-top-color: var(--vscode-descriptionForeground);
      animation: spin 0.75s linear infinite;
    }
  </style>
</head>
<body>
  <div class="filter-bar">
    <input class="filter-input" id="filter-input" placeholder="Filter agents…" />
    <button class="hide-done-btn" id="hide-done-btn" title="Show or hide completed sessions"></button>
  </div>
  <div id="root" class="empty-global">Loading agents…</div>
  <button class="load-more-done" id="load-more-done" style="display:none"></button>

  <script>
    const vscode = acquireVsCodeApi();
    const root = document.getElementById('root');
    const filterInput = document.getElementById('filter-input');
    const hideDoneBtn = document.getElementById('hide-done-btn');

    const savedState = vscode.getState() || {};
    let hideDone = savedState.hideDone !== false; // default: hide done — mirrored in extension host
    let lastDoneParentCount = 0;
    const loadMoreBtn = document.getElementById('load-more-done');

    const openSections = {};
    const projGroupEls = new Map();
    const cardEls = new Map();
    let archivedEl = null;
    let lastAgents = null;
    let lastNow = Date.now();
    let lastReady = false;

    function esc(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function stripTags(s) {
      return s ? String(s).replace(/<[^>]*>/g, '').trim() : s;
    }

    function relTimeShort(ms, now) {
      if (!ms) return '';
      const d = now - ms;
      if (d < 10000) return 'now';
      if (d < 60000) return Math.floor(d/1000)+'s';
      if (d < 3600000) return Math.floor(d/60000)+'m';
      if (d < 86400000) return Math.floor(d/3600000)+'h';
      return Math.floor(d/86400000)+'d';
    }

    function parentEffectiveState(p) {
      const subs = p.subagents||[];
      if (p.state==='running'||subs.some(s=>s.state==='running')) return 'running';
      if (p.state==='idle'   ||subs.some(s=>s.state==='idle'))    return 'idle';
      return 'done';
    }

    function parentMaxMtime(p) {
      return (p.subagents||[]).reduce((m,s)=>Math.max(m,s.mtimeMs),p.mtimeMs);
    }

    function projectKey(cwd) {
      const parts = cwd.split('/').filter(Boolean);
      return parts.slice(-3).join('/') || cwd;
    }

    function projectLabel(cwd) {
      const parts = cwd.split('/').filter(Boolean);
      if (parts.length >= 2) return parts.slice(-3).join(' / ');
      return parts[parts.length-1] || cwd;
    }

    function groupByProject(parents) {
      const map = new Map();
      for (const p of parents) {
        const key = projectKey(p.cwd);
        if (!map.has(key)) map.set(key, { key, label: projectLabel(p.cwd), agents: [] });
        map.get(key).agents.push(p);
      }
      return map;
    }

    function groupBadge(agents) {
      const running = agents.filter(a => parentEffectiveState(a)==='running').length;
      const idle    = agents.filter(a => parentEffectiveState(a)==='idle').length;
      if (running) return { cls:'running', text: running+' running' };
      if (idle)    return { cls:'idle',    text: idle+' idle' };
      return { cls:'done', text: agents.length+' done' };
    }

    function rollupSubagentDots(subagents) {
      const counts = { running:0, idle:0, done:0 };
      for (const s of subagents) counts[s.state]=(counts[s.state]||0)+1;
      let html = '';
      if (counts.running) html += '<span class="ssd running" title="'+counts.running+' running"></span>';
      if (counts.idle)    html += '<span class="ssd idle"    title="'+counts.idle+' idle"></span>';
      if (counts.done)    html += '<span class="ssd done"    title="'+counts.done+' done"></span>';
      return html ? '<div class="sub-state-dots">'+html+'</div>' : '';
    }

    const RECENCY_WINDOW_MS = 2 * 60 * 1000;
    const STALL_MS = 8 * 60 * 1000;

    function renderTimeline(activityHistory, now) {
      if (!activityHistory || activityHistory.length === 0) return '';
      const current = activityHistory[0];
      let html = '<div class="activity-timeline">';
      html += '<div class="act-row act-current"><span class="act-pip"></span>'
           + '<span class="act-label">'+esc(current.summary)+'</span>'
           + '<span class="act-time">'+relTimeShort(current.at, now)+'</span></div>';
      const classes = ['act-prev1','act-prev2'];
      for (let i = 1; i < activityHistory.length && i < 3; i++) {
        const entry = activityHistory[i];
        if (current.at && entry.at && (current.at - entry.at) > RECENCY_WINDOW_MS) break;
        html += '<div class="act-row '+classes[i-1]+'">'
             + '<span class="act-pip"></span>'
             + '<span class="act-label">'+esc(entry.summary)+'</span>'
             + '<span class="act-time">'+relTimeShort(entry.at, now)+'</span></div>';
      }
      html += '</div>';
      return html;
    }

    function renderStuckBadge(activityHistory, state, now) {
      if (state !== 'running' || !activityHistory || activityHistory.length === 0) return '';
      const current = activityHistory[0];
      if (activityHistory.length >= 3 &&
          activityHistory[0].summary === activityHistory[1].summary &&
          activityHistory[1].summary === activityHistory[2].summary) {
        return '<div class="stuck-badge stuck-loop">⧓ Possibly looping — same command 3\xd7</div>';
      }
      if (current.at && (now - current.at) > STALL_MS) {
        const mins = Math.floor((now - current.at) / 60000);
        return '<div class="stuck-badge stuck-stall">⏱ No new activity for '+mins+' min</div>';
      }
      return '';
    }

    function renderMetaBar(agent) {
      if (!agent.model && !agent.turnCount && !agent.contextPct) return '';
      let html = '<div class="meta-bar">';
      if (agent.model) html += '<span class="model-chip">⚡ '+esc(agent.model)+'</span>';
      if (agent.model && agent.turnCount) html += '<span class="meta-sep">\xb7</span>';
      if (agent.turnCount) html += '<span>'+agent.turnCount+' turn'+(agent.turnCount!==1?'s':'')+'</span>';
      if (agent.contextPct) {
        if (agent.model || agent.turnCount) html += '<span class="meta-sep">\xb7</span>';
        html += '<div class="ctx-wrap"><div class="ctx-bar-bg"><div class="ctx-bar-fill" style="width:'+agent.contextPct+'%"></div></div>'
             + '<span class="ctx-pct">'+agent.contextPct+'%</span></div>';
      }
      html += '</div>';
      return html;
    }

    function renderActionBtns(stopBtn) {
      return '<button class="action-btn" data-act="previewTranscript" title="Preview transcript">&#x1F4AC;</button>'
           + '<button class="action-btn" data-act="openJsonl" title="Open raw JSONL">&#x1F4C4;</button>'
           + '<button class="action-btn" data-act="openFolder" title="Open folder">&#x1F4C1;</button>'
           + stopBtn
           + '<button class="action-btn danger" data-act="delete" title="Delete">✕</button>';
    }

    function renderSubRow(sub, now) {
      const task = stripTags(sub.taskDescription||(sub.details&&sub.details.latestUserPrompt)||sub.sessionId.slice(0,8));
      const doneCls = sub.state==='done' ? ' done-sub' : '';
      const stopBtn = sub.state==='running'
        ? '<button class="action-btn danger" data-act="stop" title="Stop">■</button>' : '';
      return '<div class="sub-row'+doneCls+'" data-sid="'+esc(sub.sessionId)+'">'
           + '<span class="status-dot '+esc(sub.state)+'"></span>'
           + '<span class="sub-name">'+esc(task)+'</span>'
           + '<div class="card-slot">'
           +   '<span class="sub-time">'+relTimeShort(sub.mtimeMs,now)+'</span>'
           +   '<div class="sub-actions">'+renderActionBtns(stopBtn)+'</div>'
           + '</div></div>';
    }

    function renderCard(parent, now) {
      const key = 'proj:'+projectKey(parent.cwd)+':subs:'+parent.sessionId;
      const allSubs = parent.subagents||[];
      const effState = parentEffectiveState(parent);
      const subsOpen = openSections[key]||false;

      const d = parent.details||{};
      const prompt = stripTags(d.customTitle||d.aiTitle||d.latestUserPrompt||d.lastPrompt||null);
      const nameCls = prompt ? '' : ' no-prompt';

      const stopBtn = effState==='running'
        ? '<button class="action-btn danger" data-act="stop" title="Stop">■</button>' : '';

      const subSection = allSubs.length > 0
        ? '<div class="sub-toggle" data-sub-key="'+esc(key)+'">'
          + '<span class="sub-caret">▶</span>'
          + '<span>'+allSubs.length+' subagent'+(allSubs.length!==1?'s':'')+'</span>'
          + rollupSubagentDots(allSubs)
          + '</div>'
          + '<div class="sub-list">'
          + allSubs.slice().sort((a,b)=>b.mtimeMs-a.mtimeMs).map(s=>renderSubRow(s,now)).join('')
          + '</div>'
        : '';

      return '<div class="card'+(subsOpen?' subs-open':'')+'" data-key="'+esc(key)+'" data-sid="'+esc(parent.sessionId)+'">'
           + '<div class="card-top">'
           +   '<span class="status-dot '+esc(effState)+'" style="transition:background 0.3s"></span>'
           +   '<span class="card-name'+nameCls+'">'+esc(prompt||'(no prompt yet)')+'</span>'
           +   '<div class="card-slot">'
           +     '<span class="card-time">'+relTimeShort(parentMaxMtime(parent),now)+'</span>'
           +     '<div class="card-actions">'+renderActionBtns(stopBtn)+'</div>'
           +   '</div>'
           + '</div>'
           + '<div class="card-path"><span class="proj-path">‎'+esc(parent.cwd)+'</span><span class="session-id">'+esc(parent.sessionId)+'</span></div>'
           + (effState !== 'done' ? renderMetaBar(parent) : '')
           + (effState !== 'done' ? renderTimeline(parent.activityHistory, now) : '')
           + renderStuckBadge(parent.activityHistory, effState, now)
           + subSection
           + '</div>';
    }

    function patchCard(cardEl, agent, now) {
      const effState = parentEffectiveState(agent);
      const d = agent.details||{};
      const prompt = stripTags(d.customTitle||d.aiTitle||d.latestUserPrompt||d.lastPrompt||'(no prompt yet)');

      const dot = cardEl.querySelector('.status-dot:first-child');
      if (dot) { dot.className = 'status-dot '+effState; }

      const nameEl = cardEl.querySelector('.card-name');
      if (nameEl) { nameEl.textContent = prompt; nameEl.className = 'card-name'+(prompt==='(no prompt yet)'?' no-prompt':''); }

      const timeEl = cardEl.querySelector('.card-time');
      if (timeEl) timeEl.textContent = relTimeShort(parentMaxMtime(agent), now);

      const existingMeta = cardEl.querySelector('.meta-bar');
      const newMeta = effState !== 'done' ? renderMetaBar(agent) : '';
      if (existingMeta) existingMeta.outerHTML = newMeta || '';
      else if (newMeta) {
        const pathEl = cardEl.querySelector('.card-path');
        if (pathEl) pathEl.insertAdjacentHTML('afterend', newMeta);
      }

      const existingTimeline = cardEl.querySelector('.activity-timeline');
      const newTimeline = effState !== 'done' ? renderTimeline(agent.activityHistory, now) : '';
      if (existingTimeline) existingTimeline.outerHTML = newTimeline || '';
      else if (newTimeline) {
        const metaEl = cardEl.querySelector('.meta-bar');
        const anchor = metaEl || cardEl.querySelector('.card-path');
        if (anchor) anchor.insertAdjacentHTML('afterend', newTimeline);
      }

      const existingBadge = cardEl.querySelector('.stuck-badge');
      const newBadge = renderStuckBadge(agent.activityHistory, effState, now);
      if (existingBadge) existingBadge.outerHTML = newBadge || '';
      else if (newBadge) {
        const tl = cardEl.querySelector('.activity-timeline');
        if (tl) tl.insertAdjacentHTML('afterend', newBadge);
      }

      const toggleEl = cardEl.querySelector('.sub-toggle');
      const allSubs = agent.subagents||[];
      if (toggleEl && allSubs.length > 0) {
        toggleEl.innerHTML = '<span class="sub-caret">▶</span>'
          + '<span>'+allSubs.length+' subagent'+(allSubs.length!==1?'s':'')+'</span>'
          + rollupSubagentDots(allSubs);
      }

      const stopBtn = cardEl.querySelector('.card-actions [data-act="stop"]');
      if (effState !== 'running' && stopBtn) stopBtn.remove();
    }

    function reconcile(groups, now) {
      for (const [key, el] of projGroupEls) {
        if (!groups.has(key)) {
          for (const [sid, cardEl] of cardEls) {
            if (el.contains(cardEl)) cardEls.delete(sid);
          }
          el.remove();
          projGroupEls.delete(key);
        }
      }

      const sorted = [...groups.values()].sort((a, b) => {
        const aActive = a.agents.some(p=>parentEffectiveState(p)!=='done');
        const bActive = b.agents.some(p=>parentEffectiveState(p)!=='done');
        if (aActive !== bActive) return bActive ? 1 : -1;
        const aMtime = Math.max(...a.agents.map(parentMaxMtime));
        const bMtime = Math.max(...b.agents.map(parentMaxMtime));
        return bMtime - aMtime;
      });

      // Build/update archived section (appended to root after the active-group loop)
      const inactiveGroups = sorted.filter(g => !g.agents.some(p=>parentEffectiveState(p)!=='done'));
      if (inactiveGroups.length > 0) {
        if (!archivedEl) {
          archivedEl = document.createElement('div');
          archivedEl.className = 'archived-section' + (openSections['archived'] ? ' open' : '');
          archivedEl.innerHTML = '<div class="archived-header">'
            + '<span class="archived-caret">▶</span>'
            + '<span>Archived</span>'
            + '<span class="archived-count"></span>'
            + '</div><div class="archived-body"></div>';
        }
        const countEl = archivedEl.querySelector('.archived-count');
        if (countEl) countEl.textContent = '('+inactiveGroups.length+')';
      } else if (archivedEl) {
        archivedEl.remove();
      }
      const archivedBody = archivedEl && inactiveGroups.length > 0 ? archivedEl.querySelector('.archived-body') : null;

      for (const group of sorted) {
        const isActive = group.agents.some(p=>parentEffectiveState(p)!=='done');
        let groupEl = projGroupEls.get(group.key);

        if (!groupEl) {
          groupEl = document.createElement('div');
          groupEl.className = 'proj-group'+(isActive?' open':'')+(isActive?'':' inactive');
          groupEl.dataset.projKey = group.key;
          const badge = groupBadge(group.agents);
          groupEl.innerHTML = '<div class="proj-header" data-proj-key="'+esc(group.key)+'">'
            + '<span class="proj-caret">▶</span>'
            + '<span class="proj-name">'+esc(group.label)+'</span>'
            + '<span class="proj-badge '+badge.cls+'">'+esc(badge.text)+'</span>'
            + '</div><div class="proj-body"></div>';
          if (openSections['proj:'+group.key] !== undefined) {
            groupEl.classList.toggle('open', openSections['proj:'+group.key]);
          }
          projGroupEls.set(group.key, groupEl);
        } else {
          const badgeEl = groupEl.querySelector('.proj-badge');
          const badge = groupBadge(group.agents);
          if (badgeEl) { badgeEl.className = 'proj-badge '+badge.cls; badgeEl.textContent = badge.text; }
          groupEl.classList.toggle('inactive', !isActive);
        }

        if (isActive) {
          root.appendChild(groupEl);
        } else if (archivedBody) {
          archivedBody.appendChild(groupEl);
        }

        const body = groupEl.querySelector('.proj-body');
        const sortedAgents = group.agents.slice().sort((a,b)=>parentMaxMtime(b)-parentMaxMtime(a));
        const activeAgents = sortedAgents.filter(a => parentEffectiveState(a) !== 'done');
        const doneAgents   = sortedAgents.filter(a => parentEffectiveState(a) === 'done');
        const endedOpen    = openSections['ended:'+group.key] || false;

        // Remove stale cards
        for (const [sid, el] of cardEls) {
          if (body.contains(el) && !group.agents.find(a=>a.sessionId===sid)) {
            el.remove(); cardEls.delete(sid);
          }
        }

        // Update or create all cards without touching DOM order yet
        for (const agent of sortedAgents) {
          let cardEl = cardEls.get(agent.sessionId);
          if (!cardEl) {
            const tmp = document.createElement('div');
            tmp.innerHTML = renderCard(agent, now);
            cardEl = tmp.firstElementChild;
            cardEls.set(agent.sessionId, cardEl);
          } else {
            patchCard(cardEl, agent, now);
          }
        }

        // Update or create ended toggle
        let endedToggle = body.querySelector('.ended-toggle');
        if (doneAgents.length > 0) {
          if (!endedToggle) {
            endedToggle = document.createElement('div');
            endedToggle.className = 'ended-toggle';
          }
          endedToggle.innerHTML = '<span class="sub-caret">'+(endedOpen?'▼':'▶')+'</span> '+doneAgents.length+' ended';
          endedToggle.dataset.endedKey = group.key;
        } else {
          if (endedToggle) { endedToggle.remove(); endedToggle = null; }
        }

        // Set DOM order: active cards → toggle → done cards
        for (const agent of activeAgents) {
          const cardEl = cardEls.get(agent.sessionId);
          cardEl.style.display = '';
          body.appendChild(cardEl);
        }
        if (endedToggle) body.appendChild(endedToggle);
        for (const agent of doneAgents) {
          const cardEl = cardEls.get(agent.sessionId);
          cardEl.style.display = endedOpen ? '' : 'none';
          body.appendChild(cardEl);
        }
      }

      // Archived section always sits at the bottom of root
      if (archivedEl && inactiveGroups.length > 0) root.appendChild(archivedEl);
    }

    function applyFilter(query) {
      const q = query.toLowerCase().trim();
      for (const [key, groupEl] of projGroupEls) {
        const group = lastGroups ? lastGroups.get(key) : null;
        if (!group) continue;
        let anyMatch = false;
        const endedOpen = openSections['ended:'+key] || false;
        for (const [sid, cardEl] of cardEls) {
          if (!groupEl.querySelector('.proj-body').contains(cardEl)) continue;
          const agent = group.agents.find(a=>a.sessionId===sid);
          if (!agent) continue;
          const isDone = parentEffectiveState(agent) === 'done';
          if (isDone && !endedOpen) { cardEl.style.display = 'none'; continue; }
          const d = agent.details||{};
          const text = [
            d.customTitle||'', d.aiTitle||'', d.latestUserPrompt||'',
            agent.cwd, agent.projectName,
            ...(agent.activityHistory||[]).map(h=>h.summary),
          ].join(' ').toLowerCase();
          const match = !q || text.includes(q);
          cardEl.style.display = match ? '' : 'none';
          if (match) anyMatch = true;
        }
        groupEl.style.display = (!q || anyMatch) ? '' : 'none';
      }
    }

    let lastGroups = null;
    let rootIsEmpty = true;

    function updateHideDoneBtn(doneCount) {
      if (!hideDoneBtn) return;
      if (hideDone) {
        hideDoneBtn.textContent = doneCount > 0 ? 'Show ' + doneCount + ' hidden' : 'None hidden';
        hideDoneBtn.classList.add('active');
      } else {
        hideDoneBtn.textContent = doneCount > 0 ? 'Hide ' + doneCount + ' done' : 'None done';
        hideDoneBtn.classList.remove('active');
      }
    }

    function render(agents, now, ready, doneParentCount, remainingDone) {
      lastAgents = agents; lastNow = now; lastReady = ready;
      lastDoneParentCount = doneParentCount || 0;
      if (!ready) {
        root.className = 'empty-global';
        root.innerHTML = '<div class="scanning-label"><span class="spinner"></span>Scanning…</div>';
        rootIsEmpty = true;
        if (loadMoreBtn) loadMoreBtn.style.display = 'none';
        return;
      }
      if (!agents || agents.length === 0) {
        root.className = 'empty-global';
        root.innerHTML = lastDoneParentCount > 0
          ? lastDoneParentCount + ' ended sessions hidden'
          : 'No agents yet — run <code>claude</code> in any project';
        rootIsEmpty = true;
        updateHideDoneBtn(lastDoneParentCount);
        if (loadMoreBtn) loadMoreBtn.style.display = 'none';
        return;
      }
      if (rootIsEmpty) { root.innerHTML = ''; rootIsEmpty = false; }
      root.className = '';
      const parents = agents.filter(a => !a.parentSessionId);
      lastGroups = groupByProject(parents);
      reconcile(lastGroups, now);
      applyFilter(filterInput ? filterInput.value : '');
      updateHideDoneBtn(lastDoneParentCount);
      if (loadMoreBtn) {
        if (remainingDone > 0) {
          loadMoreBtn.style.display = '';
          loadMoreBtn.textContent = 'Load ' + Math.min(remainingDone, 100) + ' more ended sessions (' + remainingDone + ' remaining)';
        } else {
          loadMoreBtn.style.display = 'none';
        }
      }
    }

    root.addEventListener('click', (e) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;

      const btn = target.closest('[data-act]');
      if (btn) {
        const sidEl = btn.closest('[data-sid]');
        const sid = sidEl ? sidEl.getAttribute('data-sid') : null;
        if (sid) vscode.postMessage({ command: btn.getAttribute('data-act'), sessionId: sid });
        return;
      }

      const endedToggle = target.closest('.ended-toggle');
      if (endedToggle) {
        const key = endedToggle.dataset.endedKey;
        if (key) {
          openSections['ended:'+key] = !openSections['ended:'+key];
          if (lastGroups) reconcile(lastGroups, Date.now());
        }
        return;
      }

      const archivedHeader = target.closest('.archived-header');
      if (archivedHeader) {
        const section = archivedHeader.closest('.archived-section');
        if (section) openSections['archived'] = section.classList.toggle('open');
        return;
      }

      const projHeader = target.closest('.proj-header');
      if (projHeader) {
        const groupEl = projHeader.closest('.proj-group');
        if (!groupEl) return;
        const isOpen = groupEl.classList.toggle('open');
        const key = groupEl.dataset.projKey;
        if (key) openSections['proj:'+key] = isOpen;
        return;
      }

      const subToggle = target.closest('.sub-toggle');
      if (subToggle) {
        const card = subToggle.closest('.card');
        if (!card) return;
        const isOpen = card.classList.toggle('subs-open');
        const key = card.dataset.key;
        if (key) openSections[key] = isOpen;
        return;
      }

      const subRow = target.closest('.sub-row');
      if (subRow && !target.closest('[data-act]')) {
        const sid = subRow.getAttribute('data-sid');
        if (sid) vscode.postMessage({ command: 'previewTranscript', sessionId: sid });
        return;
      }

      const cardTop = target.closest('.card-top');
      if (cardTop) {
        const card = cardTop.closest('.card');
        const sid = card ? card.getAttribute('data-sid') : null;
        if (sid) vscode.postMessage({ command: 'previewTranscript', sessionId: sid });
      }
    });

    if (filterInput) {
      filterInput.addEventListener('input', () => applyFilter(filterInput.value));
      filterInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { filterInput.value = ''; applyFilter(''); filterInput.blur(); }
      });
    }

    if (hideDoneBtn) {
      hideDoneBtn.addEventListener('click', () => {
        hideDone = !hideDone;
        vscode.setState({ ...vscode.getState(), hideDone });
        // Tell the extension host — it will re-filter and send a new render message.
        // This is the only place that can change what done agents are included,
        // since the filtering now happens server-side.
        vscode.postMessage({ command: 'setHideDone', value: hideDone });
      });
    }

    if (loadMoreBtn) {
      loadMoreBtn.addEventListener('click', () => vscode.postMessage({ command: 'loadMoreDone' }));
    }

    window.addEventListener('message', (event) => {
      const { command, agents, ready, now, doneParentCount, remainingDone } = event.data;
      if (command === 'reset') {
        root.className = 'empty-global';
        root.innerHTML = '<div class="scanning-label"><span class="spinner"></span>Scanning…</div>';
        rootIsEmpty = true;
        projGroupEls.clear();
        cardEls.clear();
        archivedEl = null;
        if (loadMoreBtn) loadMoreBtn.style.display = 'none';
      } else if (command === 'render') {
        render(agents, now, ready, doneParentCount || 0, remainingDone || 0);
      }
    });

    // Sync persisted preferences with the extension host. Uses 'syncPrefs' (not
    // 'refresh') so the extension host only updates its filter state and re-sends
    // agents — it does NOT trigger a full agentService.refresh() re-scan.
    vscode.postMessage({ command: 'syncPrefs', hideDone });
  </script>

</body>
</html>`;
  }
}
