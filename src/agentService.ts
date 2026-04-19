import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as vscode from 'vscode';
import chokidar from 'chokidar';
import { Agent, AgentDetails, AgentState, RawEvent, ToolCallSummary } from './types';
import { buildTree } from './agentTree';

const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');
const TAIL_BYTES = 64 * 1024;
const HEAD_BYTES = 8 * 1024;
const TITLE_EVENT_TYPES = new Set(['ai-title', 'custom-title', 'last-prompt']);
const KEEP_EVENTS = 20;
const RUNNING_WINDOW_MS = 5 * 60 * 1000;
const DONE_AGE_MS = 6 * 60 * 60 * 1000;
const DEBOUNCE_MS = 200;
const STATE_TICK_MS = 5000;

interface TitleCache {
  customTitle: string | null;
  aiTitle: string | null;
  lastPrompt: string | null;
  firstUserPrompt: string | null;
}

export class AgentService {
  private agents = new Map<string, Agent>();
  private titleCache = new Map<string, TitleCache>();
  private watcher?: chokidar.FSWatcher;
  private debounceTimer?: NodeJS.Timeout;
  private tickTimer?: NodeJS.Timeout;
  private _ready = false;
  private _onDidChange = new vscode.EventEmitter<Agent[]>();
  readonly onDidChange = this._onDidChange.event;

  isReady(): boolean { return this._ready; }

  start(): void {
    if (!fs.existsSync(PROJECTS_ROOT)) {
      this._ready = true;
      this._onDidChange.fire([]);
      return;
    }

    this.watcher = chokidar.watch(`${PROJECTS_ROOT}/**/*.jsonl`, {
      ignoreInitial: false,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    });

    this.watcher
      .on('add', (p) => this.refreshFile(p))
      .on('change', (p) => this.refreshFile(p))
      .on('unlink', (p) => this.dropFile(p))
      .on('error', (err) => console.error('[agent-viewer] watcher error:', err))
      .on('ready', () => { this._ready = true; this.scheduleEmit(); });

    this.tickTimer = setInterval(() => this.reclassifyAll(), STATE_TICK_MS);
  }

  getAgents(): Agent[] {
    return Array.from(this.agents.values()).sort(
      (a, b) => b.mtimeMs - a.mtimeMs,
    );
  }

  private async refreshFile(filePath: string): Promise<void> {
    try {
      const stat = await fsp.stat(filePath);
      const sessionId = sessionIdFromPath(filePath);
      // One-time full-file scan for title events. Subsequent updates use the cached
      // values (titles don't change). Without this, ai-title/custom-title events
      // written mid-file are missed by head+tail reads on large transcripts.
      if (!this.titleCache.has(sessionId)) {
        this.titleCache.set(sessionId, await scanFullFileForTitles(filePath));
      }
      const events = await this.tailEvents(filePath, stat.size);
      const cached = this.titleCache.get(sessionId)!;
      const agent = buildAgent(filePath, stat.mtimeMs, events, cached);
      this.agents.set(agent.sessionId, agent);
      this.scheduleEmit();
    } catch {
      // File likely vanished mid-read; next unlink event will clean up.
    }
  }

  private dropFile(filePath: string): void {
    const sessionId = sessionIdFromPath(filePath);
    this.titleCache.delete(sessionId);
    if (this.agents.delete(sessionId)) {
      this.scheduleEmit();
    }
  }

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

      // For long files, also read the head to capture title events (ai-title, custom-title)
      // that were written early in the session and fall outside the tail window.
      if (tailStart > HEAD_BYTES) {
        const headBuf = Buffer.alloc(HEAD_BYTES);
        await handle.read(headBuf, 0, HEAD_BYTES, 0);
        const headLines = headBuf.toString('utf8').split('\n');
        headLines.pop(); // last line is likely partial
        const titleEvents: RawEvent[] = [];
        for (const line of headLines) {
          if (!line) continue;
          try {
            const evt = JSON.parse(line) as RawEvent;
            if (typeof evt.type === 'string' && TITLE_EVENT_TYPES.has(evt.type)) {
              titleEvents.push(evt);
            }
          } catch { /* skip */ }
        }
        return [...titleEvents, ...tailEvents.slice(-KEEP_EVENTS)];
      }

      return tailEvents.slice(-KEEP_EVENTS);
    } finally {
      await handle.close();
    }
  }

  private scheduleEmit(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      buildTree(this.agents);
      assignTaskDescriptions(this.agents);
      this._onDidChange.fire(this.getAgents());
    }, DEBOUNCE_MS);
  }

  private reclassifyAll(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, agent] of this.agents) {
      const hasActiveSubagent = agent.subagents.some(s => s.state === 'running');
      const nextState = classifyState(agent.mtimeMs, now, agent.state === 'done', hasActiveSubagent);
      if (nextState !== agent.state) {
        this.agents.set(id, { ...agent, state: nextState });
        changed = true;
      }
    }
    if (changed) {
      buildTree(this.agents);
      assignTaskDescriptions(this.agents);
      this._onDidChange.fire(this.getAgents());
    }
  }

  dispose(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.watcher?.close();
    this._onDidChange.dispose();
  }
}

function buildAgent(filePath: string, mtimeMs: number, events: RawEvent[], titles: TitleCache): Agent {
  const sessionId = sessionIdFromPath(filePath);
  const cwd = resolveCwd(filePath, events);
  const projectName = path.basename(cwd);
  const terminated = events.some(isTerminator);
  const state = classifyState(mtimeMs, Date.now(), terminated);
  const activity = deriveActivity(events, state);
  const { details, agentCallDescs } = extractDetails(events);
  // Merge cached title/prompt values (scanned once from whole file) with tail-derived details.
  // Cached values win for titles since they were collected from the complete file.
  details.customTitle = titles.customTitle ?? details.customTitle;
  details.aiTitle = titles.aiTitle ?? details.aiTitle;
  details.lastPrompt = titles.lastPrompt ?? details.lastPrompt;
  details.latestUserPrompt = details.latestUserPrompt ?? titles.firstUserPrompt;
  return { sessionId, transcriptPath: filePath, cwd, projectName, state, activity, mtimeMs, details, subagents: [], agentCallDescs };
}

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
    }
  } catch { /* file vanished */ }
  return out;
}

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
  // Normalize slashes and lowercase the drive letter so e.g. C:\ and c:/ group together.
  return path.normalize(p).replace(/^[A-Z]:/, d => d.toLowerCase());
}

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

function deriveActivity(events: RawEvent[], state: AgentState): string {
  if (state === 'done') return 'Session ended';
  const meaningful = [...events].reverse().find((e) => !isNoise(e));
  if (!meaningful) return state === 'running' ? 'Working…' : 'Idle';
  const label = labelFromEvent(meaningful);
  return label ?? (state === 'running' ? 'Working…' : 'Idle');
}

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
