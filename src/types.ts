// TermuxForge v0.1 — Types

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  tool: string;
  input: Record<string, unknown>;
  output: string;
  exitCode: number;
  durationMs: number;
  error?: string;
}

export interface SessionEvent {
  id: string;
  sessionId: string;
  seq: number;
  timestamp: string;
  type: string;
  data: Record<string, unknown>;
}

export interface Session {
  id: string;
  mission: string;
  startedAt: string;
  events: SessionEvent[];
  status: "running" | "completed" | "error";
}

export interface AgentConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  record: boolean;
  sessionDir: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<ToolResult>;
}
