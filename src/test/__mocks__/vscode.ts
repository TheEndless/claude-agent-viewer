/** Minimal vscode mock for unit tests running outside the VS Code host. */
export class EventEmitter<T> {
  event = (_listener: (e: T) => void) => ({ dispose: () => {} });
  fire(_data: T): void {}
  dispose(): void {}
}

// Create a proxy that returns an empty object for any property access
const handler = {
  get: (target: any, prop: string) => {
    if (prop in target) return target[prop];
    return {};
  },
};

const mockModule = new Proxy({
  EventEmitter,
  config: {},
  window: {},
  commands: {},
}, handler);

export const config = mockModule.config;
export const window = mockModule.window;
export const commands = mockModule.commands;
export default mockModule;
