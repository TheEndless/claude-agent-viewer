/**
 * transcriptParser.ts
 *
 * Parses Claude Code JSONL transcript files into a structured Turn[] array
 * suitable for rendering in the agent viewer webview.
 *
 * Supports both full-file parsing and incremental delta parsing so that
 * subsequent updates only need to process the bytes appended since the last
 * parse, rather than re-reading the whole (potentially large) file.
 */

import * as path from 'path';
import { Turn, TurnAttachment, TurnEntry } from './types';

/** Minimal shape of a parsed content block from a message. */
interface ContentBlock {
  type: string;
  [key: string]: unknown;
}

/** Minimal shape of a top-level JSONL event. */
interface ParsedEvent {
  type?: string;
  subtype?: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown; model?: string };
  attachment?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Mutable parser state that can be carried between incremental parse calls.
 * Allows resuming exactly where a prior parse left off without re-reading
 * already-processed content.
 */
export interface ParseState {
  /** The assistant turn currently being assembled, or null if between turns. */
  currentAssistant: Turn | null;
  /** Tool_use entries awaiting a matching tool_result, keyed by tool_use id. */
  pendingToolUse: Map<string, { entry: TurnEntry; toolName: string }>;
  /** Running count of assistant turns seen so far. */
  assistantIndex: number;
}

function emptyState(): ParseState {
  return { currentAssistant: null, pendingToolUse: new Map(), assistantIndex: 0 };
}

/**
 * Core line-by-line parser. Processes `jsonlText` starting from `initState`
 * and returns the turns produced plus the final parser state.
 *
 * When `initState.currentAssistant` is non-null, the first events in
 * `jsonlText` are treated as continuations of that in-progress turn (e.g.
 * tool_result blocks for its pending tool_use entries).
 */
function parseLines(jsonlText: string, initState: ParseState): { turns: Turn[]; state: ParseState } {
  const turns: Turn[] = [];
  let currentAssistant: Turn | null = initState.currentAssistant;
  // Shallow-copy so mutations don't affect the caller's state reference.
  const pendingToolUse = new Map(initState.pendingToolUse);
  let assistantIndex = initState.assistantIndex;

  const attachSystemEntry = (entry: TurnEntry): void => {
    if (currentAssistant) {
      currentAssistant.entries.push(entry);
    } else {
      turns.push({ role: 'assistant', timestamp: entry.timestamp, attachments: [], entries: [entry] });
    }
  };

  for (const rawLine of jsonlText.split('\n')) {
    if (!rawLine.trim()) continue;
    let event: ParsedEvent;
    try { event = JSON.parse(rawLine); } catch { continue; }
    const ts = typeof event.timestamp === 'string' ? event.timestamp : new Date().toISOString();
    const role = event.message?.role;

    // ── Attachment events ──────────────────────────────────────────────────────
    if (event.type === 'attachment') {
      const att = event.attachment ?? {};
      const attType = typeof att.type === 'string' ? att.type : '';
      const hookEvent = typeof att.hookEvent === 'string' ? att.hookEvent : '';

      if (attType === 'hook_success' && hookEvent) {
        const command = typeof att.command === 'string' ? att.command : '';
        const stdout = typeof att.stdout === 'string' ? att.stdout.trim() : '';
        const stderr = typeof att.stderr === 'string' ? att.stderr.trim() : '';
        const durationMs = typeof att.durationMs === 'number' ? att.durationMs : 0;
        const exitCode = typeof att.exitCode === 'number' ? att.exitCode : 0;
        const prevented = att.preventedContinuation === true;
        const MAX = 8000;
        const rawOutput = [stdout, stderr].filter(Boolean).join('\n');
        const output = rawOutput.length > MAX
          ? rawOutput.slice(0, MAX) + `\n… (${rawOutput.length - MAX} more chars truncated)`
          : rawOutput;
        const body = [
          `**Event:** ${hookEvent}`,
          command ? `**Command:** \`${command}\`` : '',
          `**Duration:** ${durationMs}ms · **Exit:** ${exitCode}`,
          output ? `**Output:**\n\`\`\`\n${output}\n\`\`\`` : '',
          prevented ? '⚠ **Prevented continuation**' : '',
        ].filter(Boolean).join('\n');
        attachSystemEntry({ kind: 'system', label: `${hookEvent} Hook · ${hookScriptName(command)}`, timestamp: ts, body, rawJson: rawLine });
      } else if (attType === 'hook_non_blocking_error') {
        const msg = String(att.error ?? att.message ?? att.stderr ?? JSON.stringify(att));
        attachSystemEntry({ kind: 'system', label: `Hook error · ${hookEvent || 'unknown'}`, timestamp: ts, body: msg, isError: true, rawJson: rawLine });
      } else if (attType === 'hook_system_message') {
        const msg = String(att.message ?? att.content ?? JSON.stringify(att));
        attachSystemEntry({ kind: 'system', label: `Hook · ${hookEvent || 'system message'}`, timestamp: ts, body: msg, rawJson: rawLine });
      }
      // Other attachment types (todo_reminder, auto_mode, file-history, etc.) are internal metadata — skip.
      continue;
    }

    // ── System events with subtypes ────────────────────────────────────────────
    if (event.type === 'system') {
      const subtype = typeof event.subtype === 'string' ? event.subtype : '';
      if (subtype === 'stop_hook_summary') continue;
      if (subtype === 'compact_boundary') {
        const meta = (event as { compactMetadata?: unknown }).compactMetadata;
        attachSystemEntry({ kind: 'system', label: 'Context compacted', timestamp: ts, body: typeof meta === 'object' && meta !== null ? JSON.stringify(meta, null, 2) : '', rawJson: rawLine });
        continue;
      }
      if (subtype === 'api_error') {
        const err = (event as { error?: unknown }).error;
        const content = (event as { content?: unknown }).content;
        let body: string;
        if (typeof err === 'string') body = err;
        else if (typeof content === 'string') body = content;
        else body = JSON.stringify(err ?? content ?? event);
        attachSystemEntry({ kind: 'system', label: 'API error', timestamp: ts, body, isError: true, rawJson: rawLine });
        continue;
      }
      if (subtype === 'informational' || subtype === 'local_command') {
        attachSystemEntry({ kind: 'system', label: subtype === 'informational' ? 'Info' : 'Local command', timestamp: ts, body: JSON.stringify(event), rawJson: rawLine });
        continue;
      }
      continue; // unknown subtypes ignored
    }

    // ── Session-end events (type: "result" | "summary") ───────────────────────
    if (event.type === 'result' || event.type === 'summary') {
      attachSystemEntry({ kind: 'system', label: 'Session ended', timestamp: ts, body: JSON.stringify(event), rawJson: rawLine });
      continue;
    }

    // ── Assistant turn ─────────────────────────────────────────────────────────
    if (role === 'assistant') {
      if (currentAssistant) turns.push(currentAssistant);
      assistantIndex++;
      const model = typeof event.message?.model === 'string' ? event.message.model : undefined;
      currentAssistant = { role: 'assistant', timestamp: ts, attachments: [], entries: [], model, index: assistantIndex, rawJson: rawLine };
      pendingToolUse.clear();

      for (const block of normalizeContent(event.message?.content)) {
        if (block.type === 'text') {
          currentAssistant.text = ((currentAssistant.text ?? '') + (block.text as string)).trim();
        } else if (block.type === 'thinking') {
          currentAssistant.entries.push({ kind: 'thinking', label: 'Thinking', timestamp: ts, body: block.thinking as string, rawJson: rawLine });
        } else if (block.type === 'tool_use') {
          const name = typeof block.name === 'string' ? block.name : 'Tool';
          const input = (block.input ?? {}) as Record<string, unknown>;
          const id = typeof block.id === 'string' ? block.id : '';
          const entry: TurnEntry = { kind: 'tool_use', label: labelForToolUse(name, input), timestamp: ts, body: JSON.stringify(input), rawJson: rawLine };
          currentAssistant.entries.push(entry);
          if (id) pendingToolUse.set(id, { entry, toolName: name });
        }
      }
      continue;
    }

    // ── User turn ──────────────────────────────────────────────────────────────
    if (role === 'user') {
      const blocks = normalizeContent(event.message?.content);
      const allToolResults = blocks.length > 0 && blocks.every(b => b.type === 'tool_result');
      const isCompactSummary = (event as { isCompactSummary?: boolean }).isCompactSummary === true;

      if (allToolResults) {
        // Attach results directly to their matching tool_use entry for grouped rendering.
        for (const block of blocks) {
          const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
          const pending = pendingToolUse.get(toolUseId);
          const label = pending ? `Result · ${pending.toolName}` : 'Result';
          const body = extractResultBody(block);
          const isError = block.is_error === true;
          const resultEntry: TurnEntry = { kind: 'tool_result', label, timestamp: ts, body, isError };
          if (pending) {
            pending.entry.result = resultEntry;
          } else if (currentAssistant) {
            // No matching tool_use (e.g. outside our tail window) — add standalone.
            currentAssistant.entries.push(resultEntry);
          }
        }
      } else {
        // Real user turn — flush pending assistant turn first.
        if (currentAssistant) {
          turns.push(currentAssistant);
          currentAssistant = null;
        }
        pendingToolUse.clear();

        const turn: Turn = { role: 'user', timestamp: ts, attachments: [], entries: [], rawJson: rawLine };
        if (isCompactSummary) {
          turn.entries.push({ kind: 'system', label: 'Compacted summary', timestamp: ts, body: 'Preceding conversation was auto-compacted; this turn is the summary placeholder.' });
        }
        for (const block of blocks) {
          if (block.type === 'text') {
            turn.text = ((turn.text ?? '') + (block.text as string)).trim();
          } else if (block.type === 'image') {
            const src = block.source as { type?: string; media_type?: string; data?: string } | undefined;
            if (src?.type === 'base64') {
              turn.attachments.push({ type: 'image', mediaType: src.media_type, data: src.data });
            }
          } else if (block.type === 'document') {
            const src = block.source as { type?: string; data?: string } | undefined;
            turn.attachments.push({ type: 'document', name: block.title as string | undefined, data: src?.data });
          }
          // tool_result blocks in a mixed message are intentionally ignored here —
          // the turn text is what matters for display purposes.
        }
        turns.push(turn);
      }
    }
  }

  if (currentAssistant) turns.push(currentAssistant);
  return { turns, state: { currentAssistant, pendingToolUse, assistantIndex } };
}

/**
 * Parse a complete JSONL transcript into turns.
 * Kept for backward compatibility — callers that don't need incremental updates
 * can continue using this form.
 */
export function parseTranscript(jsonlText: string): Turn[] {
  return parseLines(jsonlText, emptyState()).turns;
}

/**
 * Async variant of parseLines that yields control to the event loop every
 * YIELD_EVERY lines. Used by the full-file parse path in getTurns so that
 * large transcripts (50MB+) don't block the VS Code extension host event loop
 * and freeze toolbar button responses while loading.
 */
const YIELD_EVERY = 500;
async function parseLinesAsync(jsonlText: string, initState: ParseState): Promise<{ turns: Turn[]; state: ParseState }> {
  const yld = () => new Promise<void>(resolve => setImmediate(resolve));
  const turns: Turn[] = [];
  let currentAssistant: Turn | null = initState.currentAssistant;
  const pendingToolUse = new Map(initState.pendingToolUse);
  let assistantIndex = initState.assistantIndex;

  const attachSystemEntry = (entry: TurnEntry): void => {
    if (currentAssistant) {
      currentAssistant.entries.push(entry);
    } else {
      turns.push({ role: 'assistant', timestamp: entry.timestamp, attachments: [], entries: [entry] });
    }
  };

  const rawLines = jsonlText.split('\n');
  for (let lineIdx = 0; lineIdx < rawLines.length; lineIdx++) {
    if (lineIdx > 0 && lineIdx % YIELD_EVERY === 0) await yld();
    const rawLine = rawLines[lineIdx];
    if (!rawLine.trim()) continue;
    let event: ParsedEvent;
    try { event = JSON.parse(rawLine); } catch { continue; }
    const ts = typeof event.timestamp === 'string' ? event.timestamp : new Date().toISOString();
    const role = event.message?.role;

    if (event.type === 'attachment') {
      const att = event.attachment ?? {};
      const attType = typeof att.type === 'string' ? att.type : '';
      const hookEvent = typeof att.hookEvent === 'string' ? att.hookEvent : '';
      if (attType === 'hook_success' && hookEvent) {
        const command = typeof att.command === 'string' ? att.command : '';
        const stdout = typeof att.stdout === 'string' ? att.stdout.trim() : '';
        const stderr = typeof att.stderr === 'string' ? att.stderr.trim() : '';
        const durationMs = typeof att.durationMs === 'number' ? att.durationMs : 0;
        const exitCode = typeof att.exitCode === 'number' ? att.exitCode : 0;
        const prevented = att.preventedContinuation === true;
        const MAX = 8000;
        const rawOutput = [stdout, stderr].filter(Boolean).join('\n');
        const output = rawOutput.length > MAX
          ? rawOutput.slice(0, MAX) + `\n… (${rawOutput.length - MAX} more chars truncated)`
          : rawOutput;
        const body = [
          `**Event:** ${hookEvent}`,
          command ? `**Command:** \`${command}\`` : '',
          `**Duration:** ${durationMs}ms · **Exit:** ${exitCode}`,
          output ? `**Output:**\n\`\`\`\n${output}\n\`\`\`` : '',
          prevented ? '⚠ **Prevented continuation**' : '',
        ].filter(Boolean).join('\n');
        attachSystemEntry({ kind: 'system', label: `${hookEvent} Hook · ${hookScriptName(command)}`, timestamp: ts, body, rawJson: rawLine });
      } else if (attType === 'hook_non_blocking_error') {
        const msg = String(att.error ?? att.message ?? att.stderr ?? JSON.stringify(att));
        attachSystemEntry({ kind: 'system', label: `Hook error · ${hookEvent || 'unknown'}`, timestamp: ts, body: msg, isError: true, rawJson: rawLine });
      } else if (attType === 'hook_system_message') {
        const msg = String(att.message ?? att.content ?? JSON.stringify(att));
        attachSystemEntry({ kind: 'system', label: `Hook · ${hookEvent || 'system message'}`, timestamp: ts, body: msg, rawJson: rawLine });
      }
      continue;
    }

    if (event.type === 'system') {
      const subtype = typeof event.subtype === 'string' ? event.subtype : '';
      if (subtype === 'stop_hook_summary') continue;
      if (subtype === 'compact_boundary') {
        const meta = (event as { compactMetadata?: unknown }).compactMetadata;
        attachSystemEntry({ kind: 'system', label: 'Context compacted', timestamp: ts, body: typeof meta === 'object' && meta !== null ? JSON.stringify(meta, null, 2) : '', rawJson: rawLine });
        continue;
      }
      if (subtype === 'api_error') {
        const err = (event as { error?: unknown }).error;
        const content = (event as { content?: unknown }).content;
        let body: string;
        if (typeof err === 'string') body = err;
        else if (typeof content === 'string') body = content;
        else body = JSON.stringify(err ?? content ?? event);
        attachSystemEntry({ kind: 'system', label: 'API error', timestamp: ts, body, isError: true, rawJson: rawLine });
        continue;
      }
      if (subtype === 'informational' || subtype === 'local_command') {
        attachSystemEntry({ kind: 'system', label: subtype === 'informational' ? 'Info' : 'Local command', timestamp: ts, body: JSON.stringify(event), rawJson: rawLine });
        continue;
      }
      continue;
    }

    if (event.type === 'result' || event.type === 'summary') {
      attachSystemEntry({ kind: 'system', label: 'Session ended', timestamp: ts, body: JSON.stringify(event), rawJson: rawLine });
      continue;
    }

    if (role === 'assistant') {
      if (currentAssistant) turns.push(currentAssistant);
      assistantIndex++;
      const model = typeof event.message?.model === 'string' ? event.message.model : undefined;
      currentAssistant = { role: 'assistant', timestamp: ts, attachments: [], entries: [], model, index: assistantIndex, rawJson: rawLine };
      pendingToolUse.clear();
      for (const block of normalizeContent(event.message?.content)) {
        if (block.type === 'text') {
          currentAssistant.text = ((currentAssistant.text ?? '') + (block.text as string)).trim();
        } else if (block.type === 'thinking') {
          currentAssistant.entries.push({ kind: 'thinking', label: 'Thinking', timestamp: ts, body: block.thinking as string, rawJson: rawLine });
        } else if (block.type === 'tool_use') {
          const name = typeof block.name === 'string' ? block.name : 'Tool';
          const input = (block.input ?? {}) as Record<string, unknown>;
          const id = typeof block.id === 'string' ? block.id : '';
          const entry: TurnEntry = { kind: 'tool_use', label: labelForToolUse(name, input), timestamp: ts, body: JSON.stringify(input), rawJson: rawLine };
          currentAssistant.entries.push(entry);
          if (id) pendingToolUse.set(id, { entry, toolName: name });
        }
      }
      continue;
    }

    if (role === 'user') {
      const blocks = normalizeContent(event.message?.content);
      const allToolResults = blocks.length > 0 && blocks.every(b => b.type === 'tool_result');
      const isCompactSummary = (event as { isCompactSummary?: boolean }).isCompactSummary === true;
      if (allToolResults) {
        for (const block of blocks) {
          const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
          const pending = pendingToolUse.get(toolUseId);
          const label = pending ? `Result · ${pending.toolName}` : 'Result';
          const body = extractResultBody(block);
          const isError = block.is_error === true;
          const resultEntry: TurnEntry = { kind: 'tool_result', label, timestamp: ts, body, isError };
          if (pending) {
            pending.entry.result = resultEntry;
          } else if (currentAssistant) {
            currentAssistant.entries.push(resultEntry);
          }
        }
      } else {
        if (currentAssistant) {
          turns.push(currentAssistant);
          currentAssistant = null;
        }
        pendingToolUse.clear();
        const turn: Turn = { role: 'user', timestamp: ts, attachments: [], entries: [], rawJson: rawLine };
        if (isCompactSummary) {
          turn.entries.push({ kind: 'system', label: 'Compacted summary', timestamp: ts, body: 'Preceding conversation was auto-compacted; this turn is the summary placeholder.' });
        }
        for (const block of blocks) {
          if (block.type === 'text') {
            turn.text = ((turn.text ?? '') + (block.text as string)).trim();
          } else if (block.type === 'image') {
            const src = block.source as { type?: string; media_type?: string; data?: string } | undefined;
            if (src?.type === 'base64') {
              turn.attachments.push({ type: 'image', mediaType: src.media_type, data: src.data });
            }
          } else if (block.type === 'document') {
            const src = block.source as { type?: string; data?: string } | undefined;
            turn.attachments.push({ type: 'document', name: block.title as string | undefined, data: src?.data });
          }
        }
        turns.push(turn);
      }
    }
  }

  if (currentAssistant) turns.push(currentAssistant);
  return { turns, state: { currentAssistant, pendingToolUse, assistantIndex } };
}

/**
 * Parse a complete JSONL transcript, returning both turns and the parser state
 * at end-of-file. Yields to the event loop every YIELD_EVERY lines so large
 * transcripts don't block the VS Code extension host during cold-cache loads.
 * Pass the state to parseTranscriptDelta for subsequent incremental updates.
 */
export async function parseTranscriptWithState(jsonlText: string): Promise<{ turns: Turn[]; state: ParseState }> {
  return parseLinesAsync(jsonlText, emptyState());
}

/**
 * Parse only the bytes appended to a transcript since the last full (or delta)
 * parse. `priorState` must come from a previous parseTranscriptWithState or
 * parseTranscriptDelta call on the same session.
 *
 * If `priorState.currentAssistant` was non-null, the first element of the
 * returned turns array is that same turn (now possibly updated with new
 * tool_results or fully completed by a subsequent user event).
 */
export function parseTranscriptDelta(deltaText: string, priorState: ParseState): { turns: Turn[]; state: ParseState } {
  return parseLines(deltaText, priorState);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Normalize message content to a ContentBlock array regardless of raw format. */
function normalizeContent(content: unknown): ContentBlock[] {
  if (Array.isArray(content)) return content as ContentBlock[];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}

/**
 * Build a human-readable label for a tool_use block.
 * For well-known tools, includes the most relevant input field as a suffix.
 */
function labelForToolUse(name: string, input: Record<string, unknown>): string {
  // MCP tools: mcp__<server>__<tool> — strip the prefix for display.
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    const server = parts[1] ?? '';
    const tool = parts.slice(2).join('.') || '';
    return tool ? `MCP · ${server} · ${tool}` : `MCP · ${server}`;
  }
  switch (name) {
    case 'Bash':          return `Bash · ${trunc(String(input.command ?? ''), 60)}`;
    case 'Read':          return `Read · ${path.basename(String(input.file_path ?? ''))}`;
    case 'Edit':          return `Edit · ${path.basename(String(input.file_path ?? ''))}`;
    case 'MultiEdit':     return `MultiEdit · ${path.basename(String(input.file_path ?? ''))}`;
    case 'Write':         return `Write · ${path.basename(String(input.file_path ?? ''))}`;
    case 'NotebookEdit':  return `NotebookEdit · ${path.basename(String(input.notebook_path ?? ''))}`;
    case 'Grep':          return `Grep · ${trunc(String(input.pattern ?? ''), 60)}`;
    case 'Glob':          return `Glob · ${trunc(String(input.pattern ?? ''), 60)}`;
    case 'Agent':
    case 'Task':          return `Subagent · ${trunc(String(input.description ?? ''), 60)}`;
    case 'TodoWrite':     return `TodoWrite · ${(input.todos as unknown[] | undefined)?.length ?? 0} items`;
    case 'TodoRead':      return 'TodoRead';
    case 'Skill':         return `Skill · ${trunc(String(input.skill ?? input.name ?? ''), 60)}`;
    case 'ToolSearch':    return `ToolSearch · ${trunc(String(input.query ?? ''), 60)}`;
    case 'WebFetch':      return `WebFetch · ${trunc(String(input.url ?? ''), 60)}`;
    case 'WebSearch':     return `WebSearch · ${trunc(String(input.query ?? ''), 60)}`;
    case 'AskUserQuestion': return `AskUserQuestion · ${trunc(String(input.question ?? ''), 60)}`;
    case 'ExitPlanMode':  return 'ExitPlanMode';
    case 'EnterPlanMode': return 'EnterPlanMode';
    case 'Monitor':       return `Monitor · pid ${input.pid ?? '?'}`;
    case 'TaskOutput':    return `TaskOutput · ${String(input.task_id ?? input.taskId ?? '').slice(0, 12)}`;
    case 'TaskStop':      return `TaskStop · ${String(input.task_id ?? input.taskId ?? '').slice(0, 12)}`;
    default:              return name;
  }
}

/** Extract the string body from a tool_result content block. */
function extractResultBody(block: ContentBlock): string {
  const { content } = block;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as ContentBlock[])
      .map(b => {
        if (b.type === 'text') return String(b.text ?? '');
        if (b.type === 'image') {
          const src = b.source as { media_type?: string } | undefined;
          return `[image${src?.media_type ? ` · ${src.media_type}` : ''}]`;
        }
        return JSON.stringify(b);
      })
      .join('\n');
  }
  return JSON.stringify(block);
}

/** Truncate a string to at most n characters, appending an ellipsis if truncated. */
function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '...' : s;
}

function hookScriptName(command: string): string {
  // Extract script filename from e.g. python "C:/path/to/script.py"
  const m = command.match(/[/\\]([^/\\"]+(?:\.py|\.sh|\.js|\.ts)?)"?\s*$/);
  return m ? m[1] : command.slice(0, 30);
}
