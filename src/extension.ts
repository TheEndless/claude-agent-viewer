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

    context.subscriptions.push(
      log,
      vscode.window.registerWebviewViewProvider(AgentWebviewProvider.viewType, provider),
      vscode.commands.registerCommand('agentViewer.refresh', () => provider.refresh()),
      { dispose: () => agentService.dispose() },
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      `Agent Viewer failed to activate: ${(err as Error).message}`,
    );
  }
}

export function deactivate(): void {}
