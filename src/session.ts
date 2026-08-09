// TermuxForge v0.1 — Session Manager (Node.js)
import { mkdir, writeFile, readFile, appendFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Session, SessionEvent } from "./types.js";

export class EventLogger {
  private sessionId: string;
  private seq = 0;
  private eventsDir: string;
  private eventsFile: string;

  constructor(sessionId: string, sessionDir: string) {
    this.sessionId = sessionId;
    this.eventsDir = `${sessionDir}/${sessionId}`;
    this.eventsFile = `${this.eventsDir}/events.jsonl`;
  }

  async init() {
    await mkdir(this.eventsDir, { recursive: true });
    await writeFile(this.eventsFile, "");
  }

  async emit(type: string, data: Record<string, unknown>): Promise<SessionEvent> {
    const event: SessionEvent = {
      id: `evt_${String(this.seq++).padStart(4, "0")}`,
      sessionId: this.sessionId,
      seq: this.seq,
      timestamp: new Date().toISOString(),
      type,
      data,
    };
    await appendFile(this.eventsFile, JSON.stringify(event) + "\n");
    return event;
  }

  async emitToolStarted(tool: string, input: Record<string, unknown>) { return await this.emit("tool.started", { tool, input }); }
  async emitToolCompleted(result: { tool: string; input: Record<string, unknown>; output: string; exitCode: number; durationMs: number; error?: string }) {
    return await this.emit("tool.completed", result);
  }
  async emitError(error: string, severity = "medium") { return await this.emit("error.detected", { error, severity }); }
  async emitUserPrompt(prompt: string) { return await this.emit("user.prompt", { prompt }); }
  async emitAgentMessage(message: string) { return await this.emit("agent.message", { message }); }
  async emitSessionStarted(mission: string) { return await this.emit("session.started", { mission }); }
  async emitSessionCompleted(status: "completed" | "error") { return await this.emit("session.completed", { status }); }
}

export class SessionManager {
  constructor(private sessionDir: string) {}

  async createSession(mission: string): Promise<Session> {
    const id = `ses_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const session: Session = { id, mission, startedAt: new Date().toISOString(), events: [], status: "running" };
    const sessionPath = `${this.sessionDir}/${id}`;
    await mkdir(sessionPath, { recursive: true });
    await writeFile(`${sessionPath}/metadata.json`, JSON.stringify(session, null, 2));
    await writeFile(`${sessionPath}/commands.json`, "[]");
    await writeFile(`${sessionPath}/transcript.json`, "[]");
    return session;
  }

  async updateSession(session: Session) {
    const sessionPath = `${this.sessionDir}/${session.id}`;
    await writeFile(`${sessionPath}/metadata.json`, JSON.stringify(session, null, 2));
  }

  async logCommand(sessionId: string, command: string, result: { exitCode: number; stdout: string; stderr: string; durationMs: number }) {
    const sessionPath = `${this.sessionDir}/${sessionId}`;
    const file = `${sessionPath}/commands.json`;
    let existing: any[] = [];
    try { existing = JSON.parse(await readFile(file, "utf-8")); } catch {}
    existing.push({ timestamp: new Date().toISOString(), command, ...result });
    await writeFile(file, JSON.stringify(existing, null, 2));
  }

  async logTranscript(sessionId: string, role: "user" | "assistant" | "system", content: string) {
    const sessionPath = `${this.sessionDir}/${sessionId}`;
    const file = `${sessionPath}/transcript.json`;
    let existing: any[] = [];
    try { existing = JSON.parse(await readFile(file, "utf-8")); } catch {}
    existing.push({ timestamp: new Date().toISOString(), role, content });
    await writeFile(file, JSON.stringify(existing, null, 2));
  }

  async listSessions(): Promise<Session[]> {
    const sessions: Session[] = [];
    try {
      const entries = await readdir(this.sessionDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith("ses_")) {
          const meta = JSON.parse(await readFile(`${this.sessionDir}/${entry.name}/metadata.json`, "utf-8"));
          sessions.push(meta);
        }
      }
    } catch {}
    return sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
}