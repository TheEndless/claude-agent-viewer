/**
 * agentService.ts
 *
 * Discovers, parses, and tracks Claude Code agent sessions by watching
 * ~/.claude/projects/ for JSONL transcript files. Exposes a live, sorted list
 * of Agent objects and fires onDidChange whenever the list or any agent's state
 * changes. Maintains a separate title cache so expensive full-file scans for
 * session names are only performed once per session.
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as vscode from 'vscode';
import chokidar from 'chokidar';
import { Agent, AgentDetails, AgentState, RawEvent, ToolCallSummary } from './types';
import { buildTree, parentSessionIdFromPath } from './agentTree';
import { logError, logInfo } from './logger';

const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');
const TAIL_BYTES = 64 * 1024;
const RUNNING_WINDOW_MS = 5 * 60 * 1000;
const DONE_AGE_MS = 6 * 60 * 60 * 1000;
const DEBOUNCE_MS = 200;
const STATE_TICK_MS = 5000;

/** Cached session name fields scanned from the full transcript file. */
interface TitleCache {
  customTitle: string | null;
  aiTitle: string | null;
  lastPrompt: string | null;
  firstUserPrompt: string | null;
}

/**
 * Watches the Claude projects directory for JSONL transcript files and
 * maintains an up-to-date in-memory map of Agent objects. Consumers subscribe
 * via onDidChange to receive the full sorted agent list after any update.
 */
export class AgentService {
  private agents = new Map<string, Agent>();
  private titleCache = new Map<string, TitleCache>();
  private watcher?: chokidar.FSWatcher;
  private debounceTimer?: NodeJS.Timeout;
  private tickTimer?: NodeJS.Timeout;
  // Pending unlink timers keyed by file path. An 'add' event for the same path
  // cancels the timer before it fires, handling atomic-write rename sequences.
  private pendingDrops = new Map<string, NodeJS.Timeout>();
  private _ready = false;
  private _onDidChange = new vscode.EventEmitter<Agent[]>();
  readonly onDidChange = this._onDidChange.event;
  private _onDidDrop = new vscode.EventEmitter<string>();
  /** Fires with the sessionId whenever a transcript file is deleted. */
  readonly onDidDrop = this._onDidDrop.event;

  /** Returns true once the initial scan of the projects directory has completed. */
  isReady(): boolean { return this._ready; }

  /** Begins the initial directory scan and starts the file watcher. */
  start(): void {
    // Periodic tick ensures time-based state transitions (running → idle → done)
    // fire even with no file changes. Routes through scheduleEmit so reclassification
    // always runs on a consistent snapshot, never interleaved with async file reads.
    this.tickTimer = setInterval(() => this.scheduleEmit('tick'), STATE_TICK_MS);
    void this.initialize();
  }

  private async initialize(): Promise<void> {
    const now = Date.now();
    try {
      const allFiles = await findJsonlFiles(PROJECTS_ROOT);
      const STAT_BATCH = 50;
      const statResults: Array<{ path: string; stat: fs.Stats } | null> = [];
      for (let i = 0; i < allFiles.length; i += STAT_BATCH) {
        const batch = await Promise.all(allFiles.slice(i, i + STAT_BATCH).map(async (f) => {
          try { return { path: f, stat: await fsp.stat(f) }; }
          catch (err) { logError(`stat(${f})`, err); return null; }
        }));
        statResults.push(...batch);
      }

      const recentFiles: Array<{ path: string; stat: fs.Stats }> = [];
      const archiveFiles: Array<{ path: string; stat: fs.Stats }> = [];
      for (const r of statResults) {
        if (!r) continue;
        (now - r.stat.mtimeMs > DONE_AGE_MS ? archiveFiles : recentFiles).push(r);
      }

      await Promise.all(recentFiles.map(({ path: p, stat }) => this.processFile(p, stat)));
      this._ready = true;
      this.scheduleEmit();

      // Archives: process in batches to avoid exhausting file descriptors.
      const BATCH = 20;
      for (let i = 0; i < archiveFiles.length; i += BATCH) {
        await Promise.all(archiveFiles.slice(i, i + BATCH).map(({ path: p, stat }) => this.processFile(p, stat)));
        this.scheduleEmit();
      }
    } catch (err) { logError('initialize', err); }

    if (!this._ready) {
      this._ready = true;
      this.scheduleEmit();
    }

    logInfo('initialize', `Initial scan complete — ${this.agents.size} sessions loaded`);
    // Watch for ongoing changes. ignoreInitial: true since we already scanned above.
    this.watcher = chokidar.watch(`${PROJECTS_ROOT}/**/*.jsonl`, {
      ignoreInitial: true,
      persistent: true,
      alwaysStat: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    });
    this.watcher
      .on('add',    (p, stats) => {
        // Cancel any pending drop for this path (atomic-write rename sequence).
        const t = this.pendingDrops.get(p);
        if (t) { clearTimeout(t); this.pendingDrops.delete(p); }
        void this.processFile(p, stats);
      })
      .on('change', (p, stats) => { void this.processFile(p, stats); })
      .on('unlink', (p)        => {
        // Defer removal to absorb atomic rename (unlink → add within ~500ms).
        const t = setTimeout(() => {
          this.pendingDrops.delete(p);
          this.dropFile(p);
        }, 500);
        this.pendingDrops.set(p, t);
      })
      .on('error',  (err)      => logError('watcher', err));
  }

  /**
   * Scans the projects directory for any new session files not yet tracked,
   * then re-processes all known files to pick up any changes. Fires onDidChange
   * when complete. Used by the sidebar refresh button.
   */
  async refresh(): Promise<void> {
    try {
      const allFiles = await findJsonlFiles(PROJECTS_ROOT);
      await Promise.all(allFiles.map(f => this.processFile(f)));
      this.scheduleEmit();
    } catch (err) { logError('refresh', err); }
  }

  /** Returns all known agents sorted by most-recently-modified first. */
  getAgents(): Agent[] {
    return Array.from(this.agents.values()).sort(
      (a, b) => b.mtimeMs - a.mtimeMs,
    );
  }

  /**
   * Parses (or re-parses) a single transcript file and upserts the resulting
   * Agent into the in-memory map. Title scan runs once per session and is cached.
   */
  private async processFile(filePath: string, stats?: fs.Stats): Promise<void> {
    try {
      const stat = stats ?? await fsp.stat(filePath);
      const sessionId = sessionIdFromPath(filePath);
      if (!this.titleCache.has(sessionId)) {
        this.titleCache.set(sessionId, await scanFullFileForTitles(filePath));
      }
      const events = await this.tailEvents(filePath, stat.size);
      const cached = this.titleCache.get(sessionId)!;
      const agent = buildAgent(filePath, stat.mtimeMs, events, cached);
      this.agents.set(agent.sessionId, agent);
      if (this._ready) this.scheduleEmit();
    } catch (err) {
      logError(`processFile(${filePath})`, err);
    }
  }

  /** Removes a deleted transcript file's agent and title cache entries, then fires onDidDrop. */
  private dropFile(filePath: string): void {
    const sessionId = sessionIdFromPath(filePath);
    this.titleCache.delete(sessionId);
    if (this.agents.delete(sessionId)) {
      this._onDidDrop.fire(sessionId);
      this.scheduleEmit();
    }
  }

  /**
   * Reads the last TAIL_BYTES of the file to extract the most recent JSONL events
   * without loading the entire (potentially large) transcript into memory.
   */
  private async tailEvents(filePath: string, size: number): Promise<RawEvent[]> {
    const tailStart = Math.max(0, size - TAIL_BYTES);
    const handle = await fsp.open(filePath, 'r');
    try {
      const tailLen = size - tailStart;
      const tailBuf = Buffer.alloc(tailLen);
      await handle.read(tailBuf, 0, tailLen, tailStart);
      const tailText = tailBuf.toString('utf8');
      const tailLines = tailText.split('\n');
      if (tailStart > 0) tailLines.shift(); // drop partial first line
      const tailEvents: RawEvent[] = [];
      for (const line of tailLines) {
        if (!line) continue;
        try { tailEvents.push(JSON.parse(line) as RawEvent); } catch { /* skip */ }
      }

      return tailEvents;
    } finally {
      await handle.close();
    }
  }

  /**
   * Debounces tree-building and change notification to avoid rapid-fire updates during bulk file scans.
   * State reclassification runs synchronously inside the callback so it always sees a consistent
   * agent snapshot — never interleaved with ongoing async file reads.
   *
   * `reason='tick'` suppresses the change event when no state transitions occurred, preventing
   * no-op re-renders every STATE_TICK_MS when all agents are idle or done.
   */
  private scheduleEmit(reason: 'tick' | 'change' = 'change'): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      const now = Date.now();
      let anyChanged = false;
      for (const [id, agent] of this.agents) {
        const hasActiveSubagent = agent.subagents.some(s => s.state === 'running');
        const nextState = classifyState(agent.mtimeMs, now, agent.state === 'done', hasActiveSubagent);
        if (nextState !== agent.state) {
          this.agents.set(id, { ...agent, state: nextState });
          anyChanged = true;
        }
      }
      if (reason === 'change' || anyChanged) {
        buildTree(this.agents);
        assignTaskDescriptions(this.agents);
        this._onDidChange.fire(this.getAgents());
      }
    }, DEBOUNCE_MS);
  }

  /** Stops all timers and the file watcher. Call on extension deactivation. */
  dispose(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    for (const t of this.pendingDrops.values()) clearTimeout(t);
    this.pendingDrops.clear();
    this.watcher?.close();
    this._onDidChange.dispose();
    this._onDidDrop.dispose();
  }
}

/**
 * Constructs an Agent from a file path, its mtime, the tail events, and the
 * cached title fields. Title cache values win over tail-derived values since
 * they came from the complete file.
 */
/** Returns all .jsonl file paths under rootDir at any depth. Throws if rootDir is unreadable. */
async function findJsonlFiles(rootDir: string): Promise<string[]> {
  const entries = await fsp.readdir(rootDir, { recursive: true, withFileTypes: true });
  return entries
    .filter(e => e.isFile() && e.name.endsWith('.jsonl'))
    .map(e => {
      // Node 20+ uses `parentPath`; older versions used `path`. Support both.
      const dirent = e as fs.Dirent & { parentPath?: string; path?: string };
      return path.join(dirent.parentPath ?? dirent.path ?? '', e.name);
    });
}

function buildAgent(filePath: string, mtimeMs: number, events: RawEvent[], titles: TitleCache): Agent {
  const sessionId = sessionIdFromPath(filePath);
  const cwd = resolveCwd(filePath, events);
  const projectName = path.basename(cwd);
  const terminated = events.some(isTerminator);
  const state = classifyState(mtimeMs, Date.now(), terminated);
  const activityHistory = buildActivityHistory(events, state);
  const { details, agentCallDescs } = extractDetails(events);
  const meta = extractSessionMeta(events);
  // Merge cached title/prompt values (scanned once from whole file) with tail-derived details.
  // Cached values win for titles since they were collected from the complete file.
  details.customTitle = titles.customTitle ?? details.customTitle;
  details.aiTitle = titles.aiTitle ?? details.aiTitle;
  details.lastPrompt = titles.lastPrompt ?? details.lastPrompt;
  details.latestUserPrompt = details.latestUserPrompt ?? titles.firstUserPrompt;
  // Set at construction time so the agent is never briefly at root before buildTree runs.
  const parentSessionId = parentSessionIdFromPath(filePath);
  return {
    sessionId,
    transcriptPath: filePath,
    parentSessionId,
    cwd,
    projectName,
    state,
    activityHistory,
    model: meta.model,
    turnCount: meta.turnCount,
    contextPct: meta.contextPct,
    mtimeMs,
    details,
    subagents: [],
    agentCallDescs,
  };
}

/**
 * Scans the entire transcript file for session name fields (custom-title,
 * ai-title, last-prompt, first user message). Called once per session on first
 * discovery; result is cached in titleCache for the session's lifetime.
 */
async function scanFullFileForTitles(filePath: string): Promise<TitleCache> {
  const out: TitleCache = { customTitle: null, aiTitle: null, lastPrompt: null, firstUserPrompt: null };
  try {
    const content = await fsp.readFile(filePath, 'utf8');
    const lines = content.split('\n');
    for (const line of lines) {
      if (!line) continue;
      // Cheap check before JSON.parse — skip lines that don't contain any title/prompt key.
      if (!/"(custom-title|ai-title|last-prompt|user)"/.test(line)) continue;
      try {
        const evt = JSON.parse(line) as RawEvent;
        const t = typeof evt.type === 'string' ? evt.type : '';
        if (t === 'custom-title' && typeof evt.customTitle === 'string' && evt.customTitle) {
          out.customTitle = evt.customTitle;
        } else if (t === 'ai-title' && typeof evt.aiTitle === 'string' && evt.aiTitle) {
          out.aiTitle = evt.aiTitle;
        } else if (t === 'last-prompt' && typeof evt.lastPrompt === 'string' && evt.lastPrompt) {
          out.lastPrompt = truncate(evt.lastPrompt as string, 200);
        } else if (t === 'user' && out.firstUserPrompt == null) {
          const text = extractUserText(evt.message?.content);
          if (text) out.firstUserPrompt = truncate(text, 200);
        }
      } catch { /* skip malformed line */ }
      // Stop scanning once all four fields are populated — no need to read further.
      if (out.customTitle && out.aiTitle && out.lastPrompt && out.firstUserPrompt) break;
    }
  } catch (err) { logError(`scanFullFileForTitles(${filePath})`, err); }
  return out;
}

/**
 * Matches each parent agent's Agent tool_use call descriptions to its subagents
 * (ordered by mtime) so the sidebar can show a meaningful task label per subagent.
 */
function assignTaskDescriptions(agents: Map<string, Agent>): void {
  for (const parent of agents.values()) {
    if (!parent.subagents.length) continue;
    const descs = parent.agentCallDescs ?? [];
    const sorted = [...parent.subagents].sort((a, b) => a.mtimeMs - b.mtimeMs);
    sorted.forEach((sub, i) => {
      if (!sub.taskDescription) {
        sub.taskDescription = descs[i]
          ?? sub.details.latestUserPrompt
          ?? sub.sessionId.slice(0, 8);
      }
    });
  }
}

/** Exported only for unit testing. */
export const assignTaskDescriptionsForTesting = assignTaskDescriptions;

function sessionIdFromPath(filePath: string): string {
  return path.basename(filePath, '.jsonl');
}

function resolveCwd(filePath: string, events: RawEvent[]): string {
  for (const evt of events) {
    if (typeof evt.cwd === 'string' && evt.cwd.length > 0) return normalizeCwd(evt.cwd);
  }
  // Fallback: decode dir name. Encoding is lossy (dashes → slashes), so this
  // is a best effort only when events lack a cwd field.
  const dir = path.basename(path.dirname(filePath));
  return dir.startsWith('-') ? dir.replace(/-/g, path.sep) : dir;
}

function normalizeCwd(p: string): string {
  // Always use forward slashes; uppercase drive letter (e.g. c:/foo -> C:/foo).
  return p.replace(/\\/g, '/').replace(/^[a-z]:/, d => d.toUpperCase());
}

/** Determines an agent's state from its mtime age, termination flag, and subagent activity. */
function classifyState(mtimeMs: number, now: number, terminated: boolean, hasActiveSubagent = false): AgentState {
  if (terminated) return 'done';
  const age = now - mtimeMs;
  if (age < RUNNING_WINDOW_MS || hasActiveSubagent) return 'running';
  if (age > DONE_AGE_MS) return 'done';
  return 'idle';
}

function isTerminator(evt: RawEvent): boolean {
  // Claude Code writes a 'summary' entry when a session wraps up.
  return evt.type === 'summary';
}

/** Produces a short human-readable activity string from the most recent meaningful event. */
function deriveActivity(events: RawEvent[], state: AgentState): string {
  if (state === 'done') return 'Session ended';
  const meaningful = [...events].reverse().find((e) => !isNoise(e));
  if (!meaningful) return state === 'running' ? 'Working…' : 'Idle';
  const label = labelFromEvent(meaningful);
  return label ?? (state === 'running' ? 'Working…' : 'Idle');
}

/**
 * Collects the last ≤3 meaningful events from tail events as an activity history,
 * newest first. Uses the same event-labelling logic as deriveActivity.
 */
function buildActivityHistory(events: RawEvent[], state: AgentState): ToolCallSummary[] {
  if (state === 'done') return [{ summary: 'Session ended', at: 0 }];
  const history: ToolCallSummary[] = [];
  for (let i = events.length - 1; i >= 0 && history.length < 3; i--) {
    const evt = events[i];
    if (isNoise(evt)) continue;
    const label = labelFromEvent(evt);
    if (!label) continue;
    const ts = typeof evt.timestamp === 'string' ? Date.parse(evt.timestamp) || 0 : 0;
    history.push({ summary: label, at: ts });
  }
  if (history.length === 0) {
    history.push({ summary: state === 'running' ? 'Working…' : 'Idle', at: 0 });
  }
  return history;
}

/** Exported only for unit testing. */
export const buildActivityHistoryForTesting = buildActivityHistory;

/** Context window size for all current Claude models (200k tokens). */
const CONTEXT_WINDOW = 200_000;

interface SessionMeta {
  model: string;
  turnCount: number;
  contextPct: number;
}

/**
 * Extracts model name, turn count, and context window usage from tail events.
 * All three values are approximations for long sessions where the tail doesn't
 * include all turns.
 */
function extractSessionMeta(events: RawEvent[]): SessionMeta {
  let model = '';
  let turnCount = 0;
  let lastInputTokens = 0;

  for (const evt of events) {
    if (evt.type !== 'assistant') continue;
    turnCount++;
    const msg = evt.message;
    if (!msg) continue;
    if (typeof msg.model === 'string' && msg.model) {
      // Strip "claude-" prefix for compact display, e.g. "claude-sonnet-4-6" → "sonnet-4-6"
      model = msg.model.replace(/^claude-/, '');
    }
    if (typeof msg.usage?.input_tokens === 'number') {
      lastInputTokens = msg.usage.input_tokens;
    }
  }

  const contextPct = lastInputTokens > 0
    ? Math.round((lastInputTokens / CONTEXT_WINDOW) * 100)
    : 0;

  return { model, turnCount, contextPct };
}

/** Exported only for unit testing. */
export const extractSessionMetaForTesting = extractSessionMeta;

function isNoise(evt: RawEvent): boolean {
  const t = typeof evt.type === 'string' ? evt.type : '';
  return t === 'queue-operation';
}

function labelFromEvent(evt: RawEvent): string | null {
  const type = typeof evt.type === 'string' ? evt.type : '';
  const content = evt.message?.content;
  if (type === 'assistant' && Array.isArray(content)) {
    const toolUse = content.find(isToolUse);
    if (toolUse?.name) return labelForToolUse(toolUse.name, toolUse.input);
    if (content.some(isTextPart)) return 'Thinking';
  }
  if (type === 'user') {
    if (Array.isArray(content) && content.some(isPartOfType('tool_result'))) {
      return 'Processing tool result';
    }
    return 'Awaiting response';
  }
  if (type === 'summary') return 'Session ended';
  return null;
}

function isPartOfType(kind: string): (part: unknown) => boolean {
  return (part) =>
    typeof part === 'object' && part !== null && (part as { type?: string }).type === kind;
}

function labelForToolUse(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) return `Running ${name}`;
  switch (name) {
    case 'Bash':
      if (typeof input.command === 'string') return `Bash: ${truncate(input.command, 40)}`;
      break;
    case 'Edit':
    case 'Write':
      if (typeof input.file_path === 'string') return `${name} ${path.basename(input.file_path)}`;
      break;
    case 'Read':
      if (typeof input.file_path === 'string') return `Reading ${path.basename(input.file_path)}`;
      break;
    case 'Grep':
      if (typeof input.pattern === 'string') return `Grep: ${truncate(input.pattern, 40)}`;
      break;
    case 'Glob':
      if (typeof input.pattern === 'string') return `Glob: ${truncate(input.pattern, 40)}`;
      break;
    case 'Agent':
      if (typeof input.description === 'string') return `Subagent: ${truncate(input.description, 40)}`;
      break;
  }
  return `Running ${name}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

const MAX_TRAIL = 5;
const MAX_FILES = 5;

/**
 * Scans tail events to extract sidebar-displayable details: recent tool calls,
 * recently touched files, user prompts, titles, and subagent descriptions.
 */
function extractDetails(events: RawEvent[]): { details: AgentDetails; agentCallDescs: string[] } {
  const trail: ToolCallSummary[] = [];
  const files: string[] = [];
  let latestUserPrompt: string | null = null;
  let lastPrompt: string | null = null;
  let customTitle: string | null = null;
  let aiTitle: string | null = null;
  let subagentCount = 0;
  const agentCallDescs: string[] = [];

  for (const evt of events) {
    const type = typeof evt.type === 'string' ? evt.type : '';
    const content = evt.message?.content;

    if (type === 'assistant' && Array.isArray(content)) {
      const ts = typeof evt.timestamp === 'string' ? Date.parse(evt.timestamp) || 0 : 0;
      for (const part of content) {
        if (!isToolUse(part)) continue;
        const name = typeof part.name === 'string' ? part.name : 'Tool';
        trail.push({ summary: labelForToolUse(name, part.input), at: ts });
        const filePath = part.input?.file_path;
        if (typeof filePath === 'string') files.push(filePath);
        if (name === 'Agent') {
          subagentCount += 1;
          if (typeof part.input?.description === 'string' && part.input.description) {
            agentCallDescs.push(part.input.description);
          }
        }
      }
    }

    if (type === 'user') {
      const text = extractUserText(content);
      if (text) latestUserPrompt = truncate(text, 200);
    }

    if (type === 'last-prompt' && typeof evt.lastPrompt === 'string' && evt.lastPrompt) {
      lastPrompt = truncate(evt.lastPrompt as string, 200);
    }
    if (type === 'custom-title' && typeof evt.customTitle === 'string' && evt.customTitle) {
      customTitle = evt.customTitle as string;
    }
    if (type === 'ai-title' && typeof evt.aiTitle === 'string' && evt.aiTitle) {
      aiTitle = evt.aiTitle as string;
    }
  }

  return {
    details: {
      recentToolCalls: trail.slice(-MAX_TRAIL).reverse(),
      recentFiles: dedupeLastN(files, MAX_FILES),
      latestUserPrompt,
      lastPrompt,
      customTitle,
      aiTitle,
      subagentCount,
    },
    agentCallDescs,
  };
}

function isToolUse(
  part: unknown,
): part is { type: 'tool_use'; name?: string; input?: Record<string, unknown> } {
  return isPartOfType('tool_use')(part);
}

function isTextPart(part: unknown): part is { type: 'text'; text?: string } {
  return isPartOfType('text')(part);
}

function extractUserText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  // Last non-empty text part wins — matches the behavior the UI cares about
  // (most recent prompt in a multi-part user message).
  for (let i = content.length - 1; i >= 0; i--) {
    const part = content[i];
    if (isTextPart(part) && typeof part.text === 'string' && part.text.trim()) {
      return part.text.trim();
    }
  }
  return '';
}

function dedupeLastN(items: string[], n: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = items.length - 1; i >= 0 && out.length < n; i--) {
    const v = items[i];
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}
