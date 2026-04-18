export type AgentState = 'running' | 'idle' | 'done';

export interface ToolCallSummary {
  summary: string;
  at: number;
}

export interface AgentDetails {
  recentToolCalls: ToolCallSummary[];
  recentFiles: string[];
  latestUserPrompt: string | null;
  subagentCount: number;
}

export interface Agent {
  sessionId: string;
  transcriptPath: string;
  cwd: string;
  projectName: string;
  state: AgentState;
  activity: string;
  mtimeMs: number;
  pid?: number;
  details: AgentDetails;
  parentSessionId?: string;  // set if this agent is a subagent
  subagents: Agent[];        // populated by tree-building pass; always initialized to []
}

export interface RawEvent {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
  [key: string]: unknown;
}

// ── Transcript preview model ──────────────────────────────────────

export interface TurnAttachment {
  type: 'image' | 'document';
  name?: string;
  mediaType?: string;   // image only - e.g. "image/png"
  data?: string;        // base64 for images; raw text for documents
}

export interface TurnEntry {
  kind: 'tool_use' | 'tool_result' | 'thinking' | 'system';
  label: string;        // e.g. "Bash - ls -la", "Result - Bash", "Thinking"
  timestamp: string;    // ISO 8601
  body: string;         // raw content - caller decides JSON vs markdown
}

export interface Turn {
  role: 'user' | 'assistant';
  timestamp: string;    // ISO 8601 - from first event in the turn
  text?: string;        // markdown bubble text
  attachments: TurnAttachment[];
  entries: TurnEntry[]; // tool/thinking/system entries; empty on user turns
}
