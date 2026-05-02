export type AgentState = 'running' | 'idle' | 'done';

export interface ToolCallSummary {
  summary: string;
  at: number; // Unix ms timestamp; 0 when unknown
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
  activityHistory: ToolCallSummary[]; // last ≤3 meaningful events, newest first
  model: string;        // short model name, e.g. "sonnet-4-6"; empty string if unknown
  turnCount: number;    // assistant turns seen in the tail (approximation for long sessions)
  contextPct: number;   // input_tokens / 200000 * 100; 0 if unknown
  mtimeMs: number;
  pid?: number;
  details: AgentDetails;
  parentSessionId?: string;
  subagents: Agent[];
  taskDescription?: string;
  agentCallDescs?: string[];
}

export interface RawEvent {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  message?: {
    role?: string;
    content?: unknown;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  [key: string]: unknown;
}

// ── Transcript preview model ──────────────────────────────────────

export interface TurnAttachment {
  type: 'image' | 'document';
  name?: string;
  mediaType?: string;
  data?: string;
}

export interface TurnEntry {
  kind: 'tool_use' | 'tool_result' | 'thinking' | 'system';
  label: string;
  timestamp: string;
  body: string;
  rawJson?: string;
  result?: TurnEntry;
  isError?: boolean;
}

export interface Turn {
  role: 'user' | 'assistant';
  timestamp: string;
  text?: string;
  attachments: TurnAttachment[];
  entries: TurnEntry[];
  model?: string;
  index?: number;
  rawJson?: string;
}
