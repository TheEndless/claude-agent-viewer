import * as vscode from 'vscode';
import * as fs from 'fs';
import { Agent, Turn } from './types';
import { parseTranscript } from './transcriptParser';

const parseCache = new Map<string, { turns: Turn[]; mtimeMs: number }>();
const openPanels = new Map<string, vscode.WebviewPanel>();

export function openTranscriptPreview(agent: Agent): void {
  const existing = openPanels.get(agent.sessionId);
  if (existing) {
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

// - HTML generation
// (buildWebviewHtml and helpers added in Task 6)
export function buildWebviewHtml(turns: Turn[], title: string): string {
  return `<!DOCTYPE html><html><body>Loading...</body></html>`;
}
