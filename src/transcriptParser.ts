/**
 * transcriptParser.ts
 *
 * Parses Claude Code JSONL transcript files into a structured Turn[] array
 * suitable for rendering in the agent viewer webview.
 *
 * Each line of input is a JSON event emitted by the Claude Code CLI.
 * The parser handles assistant, user, and result event types, collapsing
 * tool_result user messages onto the preceding assistant turn rather than
 * creating spurious user turns.
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
 * Parse a JSONL transcript string into an ordered array of conversation turns.
 *
 * Rules:
 * - Malformed lines are silently skipped.
 * - User messages whose content is exclusively tool_result blocks are merged
 *   into the preceding assistant turn rather than creating a new user turn.
 * - "result" / "summary" events are attached as system entries to the
 *   preceding assistant turn, or become a synthetic assistant turn if none exists.
 */
export function parseTranscript(jsonlText: string): Turn[] {
  const events: ParsedEvent[] = [];
  for (const rawLine of jsonlText.split('\n')) {
    if (!rawLine.trim()) continue;
    try {
      events.push(JSON.parse(rawLine));
    } catch {
      // skip malformed lines
    }
  }

  const turns: Turn[] = [];
  let currentAssistant: Turn | null = null;
  let assistantIndex = 0;

  // Maps tool_use id -> { entry, toolName } so tool_result labels can reference
  // the originating tool name and hook summaries can be attached.
  const pendingToolUse = new Map<string, { entry: TurnEntry; toolName: string }>();

  for (const event of events) {
    const ts = typeof event.timestamp === 'string' ? event.timestamp : new Date().toISOString();
    const role = event.message?.role;

    // ── Attachment events — hook_success carries actual stdout/stderr ──────────
    if (event.type === 'attachment') {
      const att = event.attachment ?? {};
      if (att.type === 'hook_success' && typeof att.hookEvent === 'string' && att.hookEvent) {
        const hookEvent = att.hookEvent as string;
        const command = typeof att.command === 'string' ? att.command : '';
        const stdout = typeof att.stdout === 'string' ? att.stdout.trim() : '';
        const stderr = typeof att.stderr === 'string' ? att.stderr.trim() : '';
        const durationMs = typeof att.durationMs === 'number' ? att.durationMs : 0;
        const exitCode = typeof att.exitCode === 'number' ? att.exitCode : 0;
        const prevented = att.preventedContinuation === true;
        // Cap combined output — some hooks dump megabytes of context which would bloat
        // every turn's HTML. The full file is always available via "View raw JSONL".
        const MAX = 8000;
        const rawOutput = [stdout, stderr].filter(Boolean).join('\n');
        const output = rawOutput.length > MAX
          ? rawOutput.slice(0, MAX) + `\n… (${rawOutput.length - MAX} more chars truncated)`
          : rawOutput;
        const label = `${hookEvent} Hook · ${hookScriptName(command)}`;
        const bodyLines = [
          `**Event:** ${hookEvent}`,
          command ? `**Command:** \`${command}\`` : '',
          `**Duration:** ${durationMs}ms · **Exit:** ${exitCode}`,
          output ? `**Output:**\n\`\`\`\n${output}\n\`\`\`` : '',
          prevented ? '⚠ **Prevented continuation**' : '',
        ];
        const body = bodyLines.filter(Boolean).join('\n');
        const entry: TurnEntry = { kind: 'system', label, timestamp: ts, body };
        if (currentAssistant) {
          currentAssistant.entries.push(entry);
        } else {
          turns.push({ role: 'assistant', timestamp: ts, attachments: [], entries: [entry] });
        }
      }
      continue;
    }

    // ── stop_hook_summary — skip; hook_success attachments carry the output ───
    if (event.type === 'system' && event.subtype === 'stop_hook_summary') continue;

    // ── Session-end events (type: "result" | "summary") ───────────────────────
    if (event.type === 'result' || event.type === 'summary') {
      const entry: TurnEntry = {
        kind: 'system',
        label: 'Session ended',
        timestamp: ts,
        body: JSON.stringify(event),
      };
      if (currentAssistant) {
        currentAssistant.entries.push(entry);
      } else {
        turns.push({ role: 'assistant', timestamp: ts, attachments: [], entries: [entry] });
      }
      continue;
    }

    // ── Assistant turn ─────────────────────────────────────────────────────────
    if (role === 'assistant') {
      if (currentAssistant) turns.push(currentAssistant);
      assistantIndex++;
      const model = typeof event.message?.model === 'string' ? event.message.model : undefined;
      currentAssistant = { role: 'assistant', timestamp: ts, attachments: [], entries: [], model, index: assistantIndex };
      pendingToolUse.clear();

      for (const block of normalizeContent(event.message?.content)) {
        if (block.type === 'text') {
          currentAssistant.text = ((currentAssistant.text ?? '') + (block.text as string)).trim();
        } else if (block.type === 'thinking') {
          currentAssistant.entries.push({
            kind: 'thinking',
            label: 'Thinking',
            timestamp: ts,
            body: block.thinking as string,
          });
        } else if (block.type === 'tool_use') {
          const name = typeof block.name === 'string' ? block.name : 'Tool';
          const input = (block.input ?? {}) as Record<string, unknown>;
          const id = typeof block.id === 'string' ? block.id : '';
          const entry: TurnEntry = {
            kind: 'tool_use',
            label: labelForToolUse(name, input),
            timestamp: ts,
            body: JSON.stringify(input),
          };
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

      if (allToolResults) {
        // Attach results directly to their matching tool_use entry for grouped rendering.
        for (const block of blocks) {
          const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
          const pending = pendingToolUse.get(toolUseId);
          const label = pending ? `Result · ${pending.toolName}` : 'Result';
          const body = extractResultBody(block);
          const resultEntry: TurnEntry = { kind: 'tool_result', label, timestamp: ts, body };
          if (pending) {
            pending.entry.result = resultEntry;
          } else if (currentAssistant) {
            // No matching tool_use (e.g. outside our tail window) — add standalone.
            currentAssistant.entries.push(resultEntry);
          }
        }
      } else {
        // Real user turn - flush pending assistant turn first.
        if (currentAssistant) {
          turns.push(currentAssistant);
          currentAssistant = null;
        }
        pendingToolUse.clear();

        const turn: Turn = { role: 'user', timestamp: ts, attachments: [], entries: [] };
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
            turn.attachments.push({
              type: 'document',
              name: block.title as string | undefined,
              data: src?.data,
            });
          }
          // tool_result blocks in a mixed message are intentionally ignored here -
          // the turn text is what matters for display purposes.
        }
        turns.push(turn);
      }
    }
  }

  if (currentAssistant) turns.push(currentAssistant);
  return turns;
}

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
  switch (name) {
    case 'Bash':  return `Bash · ${trunc(String(input.command ?? ''), 60)}`;
    case 'Read':  return `Read · ${path.basename(String(input.file_path ?? ''))}`;
    case 'Edit':  return `Edit · ${path.basename(String(input.file_path ?? ''))}`;
    case 'Write': return `Write · ${path.basename(String(input.file_path ?? ''))}`;
    case 'Grep':  return `Grep · ${trunc(String(input.pattern ?? ''), 60)}`;
    case 'Glob':  return `Glob · ${trunc(String(input.pattern ?? ''), 60)}`;
    case 'Agent':     return `Subagent · ${trunc(String(input.description ?? ''), 60)}`;
    case 'TodoWrite': return `TodoWrite · ${(input.todos as unknown[] | undefined)?.length ?? 0} items`;
    case 'TodoRead':  return 'TodoRead';
    default:          return name;
  }
}

/** Extract the string body from a tool_result content block. */
function extractResultBody(block: ContentBlock): string {
  const { content } = block;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as ContentBlock[])
      .map(b => (b.type === 'text' ? String(b.text ?? '') : JSON.stringify(b)))
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
