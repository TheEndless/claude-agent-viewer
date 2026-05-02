/** Minimal vscode mock for unit tests running outside the VS Code host. */
class EventEmitter {
  constructor() {
    this.event = (_listener) => ({ dispose: () => {} });
  }
  fire(_data) {}
  dispose() {}
}

module.exports = {
  EventEmitter,
  config: {},
  window: {},
  commands: {},
};
