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
  timestamp?: string;
  message?: { role?: string; content?: unknown };
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

  // Maps tool_use id -> { entry, toolName } so tool_result labels can reference
  // the originating tool name.
  const pendingToolUse = new Map<string, { entry: TurnEntry; toolName: string }>();

  for (const event of events) {
    const ts = typeof event.timestamp === 'string' ? event.timestamp : new Date().toISOString();
    const role = event.message?.role;

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
      currentAssistant = { role: 'assistant', timestamp: ts, attachments: [], entries: [] };
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
        // Merge tool results onto the preceding assistant turn - do not create a new turn.
        for (const block of blocks) {
          const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
          const pending = pendingToolUse.get(toolUseId);
          const label = pending ? `Result · ${pending.toolName}` : 'Result';
          const body = extractResultBody(block);
          if (currentAssistant) {
            currentAssistant.entries.push({ kind: 'tool_result', label, timestamp: ts, body });
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
    case 'Agent': return `Subagent · ${trunc(String(input.description ?? ''), 60)}`;
    default:      return name;
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
