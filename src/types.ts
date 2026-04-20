export type AgentState = 'running' | 'idle' | 'done';

export interface ToolCallSummary {
  summary: string;
  at: number;
}

export interface AgentDetails {
  recentToolCalls: ToolCallSummary[];
  recentFiles: string[];
  latestUserPrompt: string | null;
  lastPrompt: string | null;
  customTitle: string | null;
  aiTitle: string | null;
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
  taskDescription?: string;  // set during tree-build; shown in sidebar as subagent label
  agentCallDescs?: string[]; // descriptions from this agent's own Agent tool_use calls; NOT serialized to webview
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

export interface HookInfo {
  hookType: string;        // e.g. "Stop", "PostToolUse"
  command: string;
  durationMs: number;
  hasOutput: boolean;
  preventedContinuation: boolean;
  errors: string[];
}

export interface TurnEntry {
  kind: 'tool_use' | 'tool_result' | 'thinking' | 'system';
  label: string;        // e.g. "Bash - ls -la", "Result - Bash", "Thinking"
  timestamp: string;    // ISO 8601
  body: string;         // raw content - caller decides JSON vs markdown
  rawJson?: string;     // full content block JSON from the JSONL line
  result?: TurnEntry;   // paired tool_result (tool_use only)
  hooks?: HookInfo[];   // stop_hook_summary data (tool_use only)
  isError?: boolean;    // tool_result is_error=true OR api_error/hook error system entries
}

export interface Turn {
  role: 'user' | 'assistant';
  timestamp: string;    // ISO 8601 - from first event in the turn
  text?: string;        // markdown bubble text
  attachments: TurnAttachment[];
  entries: TurnEntry[]; // tool/thinking/system entries; empty on user turns
  model?: string;       // from message.model (assistant turns only)
  index?: number;       // 1-based assistant turn counter
  rawJson?: string;     // the raw JSONL line that originated this turn
}
