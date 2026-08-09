// TermuxForge v0.1 — Session Manager (Node.js)
import { mkdir, writeFile, readFile, appendFile, readdir } from "node:fs/promises";
export class EventLogger {
    sessionId;
    seq = 0;
    eventsDir;
    eventsFile;
    constructor(sessionId, sessionDir) {
        this.sessionId = sessionId;
        this.eventsDir = `${sessionDir}/${sessionId}`;
        this.eventsFile = `${this.eventsDir}/events.jsonl`;
    }
    async init() {
        await mkdir(this.eventsDir, { recursive: true });
        await writeFile(this.eventsFile, "");
    }
    async emit(type, data) {
        const event = {
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
    async emitToolStarted(tool, input) { return await this.emit("tool.started", { tool, input }); }
    async emitToolCompleted(result) {
        return await this.emit("tool.completed", result);
    }
    async emitError(error, severity = "medium") { return await this.emit("error.detected", { error, severity }); }
    async emitUserPrompt(prompt) { return await this.emit("user.prompt", { prompt }); }
    async emitAgentMessage(message) { return await this.emit("agent.message", { message }); }
    async emitSessionStarted(mission) { return await this.emit("session.started", { mission }); }
    async emitSessionCompleted(status) { return await this.emit("session.completed", { status }); }
}
export class SessionManager {
    sessionDir;
    constructor(sessionDir) {
        this.sessionDir = sessionDir;
    }
    async createSession(mission) {
        const id = `ses_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        const session = { id, mission, startedAt: new Date().toISOString(), events: [], status: "running" };
        const sessionPath = `${this.sessionDir}/${id}`;
        await mkdir(sessionPath, { recursive: true });
        await writeFile(`${sessionPath}/metadata.json`, JSON.stringify(session, null, 2));
        await writeFile(`${sessionPath}/commands.json`, "[]");
        await writeFile(`${sessionPath}/transcript.json`, "[]");
        return session;
    }
    async updateSession(session) {
        const sessionPath = `${this.sessionDir}/${session.id}`;
        await writeFile(`${sessionPath}/metadata.json`, JSON.stringify(session, null, 2));
    }
    async logCommand(sessionId, command, result) {
        const sessionPath = `${this.sessionDir}/${sessionId}`;
        const file = `${sessionPath}/commands.json`;
        let existing = [];
        try {
            existing = JSON.parse(await readFile(file, "utf-8"));
        }
        catch { }
        existing.push({ timestamp: new Date().toISOString(), command, ...result });
        await writeFile(file, JSON.stringify(existing, null, 2));
    }
    async logTranscript(sessionId, role, content) {
        const sessionPath = `${this.sessionDir}/${sessionId}`;
        const file = `${sessionPath}/transcript.json`;
        let existing = [];
        try {
            existing = JSON.parse(await readFile(file, "utf-8"));
        }
        catch { }
        existing.push({ timestamp: new Date().toISOString(), role, content });
        await writeFile(file, JSON.stringify(existing, null, 2));
    }
    async listSessions() {
        const sessions = [];
        try {
            const entries = await readdir(this.sessionDir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory() && entry.name.startsWith("ses_")) {
                    const meta = JSON.parse(await readFile(`${this.sessionDir}/${entry.name}/metadata.json`, "utf-8"));
                    sessions.push(meta);
                }
            }
        }
        catch { }
        return sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    }
}
