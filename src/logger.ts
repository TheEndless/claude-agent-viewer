/**
 * logger.ts
 *
 * Singleton logger backed by a VS Code OutputChannel. Call initLogger() once
 * on extension activation, then use logError() / logInfo() anywhere in the
 * extension without threading a channel reference through every call site.
 */

import * as vscode from 'vscode';

let _channel: vscode.OutputChannel | undefined;

/** Initialise the logger with the extension's output channel. Call once in activate(). */
export function initLogger(channel: vscode.OutputChannel): void {
  _channel = channel;
}

/** Logs an error with context label to the output channel and the extension host console. */
export function logError(context: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  const line = `[${new Date().toISOString()}] ERROR ${context}: ${msg}`;
  _channel?.appendLine(line);
  console.error('[agent-viewer]', line);
}

/** Logs an informational message to the output channel. */
export function logInfo(context: string, msg: string): void {
  const line = `[${new Date().toISOString()}] INFO  ${context}: ${msg}`;
  _channel?.appendLine(line);
}
