/** Minimal vscode mock for unit tests running outside the VS Code host. */
export class EventEmitter<T> {
  event = (_listener: (e: T) => void) => ({ dispose: () => {} });
  fire(_data: T): void {}
  dispose(): void {}
}
