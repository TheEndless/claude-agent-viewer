# Agent Viewer

A VS Code sidebar that shows every Claude Code agent running on your machine, grouped by **Running / Idle / Done**, with live status and one-click controls.

Claude Code writes a JSONL transcript for each session under `~/.claude/projects/`. This extension watches that directory and surfaces what's happening across every project, so you can see at a glance which agents are active, what they're currently doing, and stop or clean up a session without leaving the editor.

## Features

- **Live dashboard** — all sessions across the machine, auto-refreshed every 5s
- **High-level status per agent** — e.g. `Bash: npm test`, `Edit auth.ts`, `Thinking`, `Awaiting response`
- **Click to expand** any card to see:
  - Working directory
  - Session timing (started / last activity)
  - Latest user prompt
  - Recent tool calls (last 5, newest first)
  - Recent files touched (Read/Edit/Write targets)
  - Subagents spawned
- **Per-agent actions** — view transcript, open project folder, stop (SIGTERM), delete transcript

## Install

Download the latest `.vsix` from the [Releases page](https://github.com/dipeshnx/agent-viewer/releases/latest), then install it:

```bash
code --install-extension agent-viewer-<version>.vsix
```

Or from inside VS Code: `⌘⇧P` → **Extensions: Install from VSIX…** → select the downloaded file.

Click the Agents icon in the Activity Bar once it's installed.

## Build from source

```bash
git clone https://github.com/dipeshnx/agent-viewer.git
cd agent-viewer
npm install
npm run build
npx @vscode/vsce package
code --install-extension agent-viewer-0.0.1.vsix
```

## Develop

```bash
npm install
npm run watch   # rebuild on change
```

Open the folder in VS Code and press `F5` to launch the Extension Development Host.

## How it works

- Watches `~/.claude/projects/**/*.jsonl` with [chokidar](https://github.com/paulmillr/chokidar)
- Tails the last ~64 KB of each JSONL and parses the last ~20 events
- Derives state from file mtime: `< 10s` → running, `> 24h` or terminator event → done, else idle
- Stop uses `ps` + `lsof` to match the Claude process by `cwd`; POSIX only (macOS / Linux)

## Privacy

This extension reads the JSONL transcripts Claude Code writes to `~/.claude/projects/` — these may contain your prompts, assistant replies, and tool output (file contents, shell output, etc.). Everything stays local: no network calls, no telemetry, nothing is sent anywhere. The Stop action invokes `ps` / `lsof` locally to find the Claude process matching an agent's working directory.

## Limitations

- macOS / Linux only for the Stop action. Everything else works cross-platform.
- "Started ago" reflects the earliest timestamp in the tailed window, not true session start, for very long sessions.
- Project-directory decoding from the `~/.claude/projects/` folder name is lossy; the extension prefers the `cwd` field embedded in events when present.

## License

MIT
