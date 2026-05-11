import * as vscode from 'vscode';
import { AgentService } from './agentService';
import { AgentWebviewProvider } from './webviewProvider';
import { initLogger } from './logger';

export function activate(context: vscode.ExtensionContext): void {
  try {
    const log = vscode.window.createOutputChannel('Agent Viewer');
    initLogger(log);

    const agentService = new AgentService();
    agentService.start();
    const provider = new AgentWebviewProvider(agentService);

    agentService.setWindowFocused(vscode.window.state.focused);
    context.subscriptions.push(
      log,
      vscode.window.registerWebviewViewProvider(AgentWebviewProvider.viewType, provider),
      vscode.commands.registerCommand('agentViewer.refresh', () => provider.refresh()),
      vscode.commands.registerCommand('agentViewer.flushQueue', () => {
        agentService.flushQueue();
        vscode.window.showInformationMessage('Agent Viewer queue flushed.');
      }),
      vscode.window.onDidChangeWindowState(state => agentService.setWindowFocused(state.focused)),
      { dispose: () => agentService.dispose() },
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      `Agent Viewer failed to activate: ${(err as Error).message}`,
    );
  }
}

export function deactivate(): void {}
