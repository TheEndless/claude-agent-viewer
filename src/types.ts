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
