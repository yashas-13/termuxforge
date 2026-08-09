// TermuxForge v0.1 — Agent Engine (Node.js)
import { readFile } from "node:fs/promises";
import { TOOLS } from "./tools.js";
import { EventLogger, SessionManager } from "./session.js";
export class Agent {
    config;
    logger;
    sessionManager;
    messages = [];
    constructor(config) {
        this.config = config;
        this.sessionManager = new SessionManager(config.sessionDir);
    }
    async run(mission) {
        const session = await this.sessionManager.createSession(mission);
        this.logger = new EventLogger(session.id, this.config.sessionDir);
        await this.logger.init();
        await this.logger.emitSessionStarted(mission);
        this.messages = [
            {
                role: "system",
                content: `You are TermuxForge, a secure, local AI coding agent running on Android/Termux.
You have access to files and tools. Execute the mission step-by-step.
If errors occur, analyze the error output and correct it. Use the minimal changes possible.

Available Tools:
${TOOLS.map((t) => `- ${t.name}: ${t.description}`).join("\n")}
`,
            },
            { role: "user", content: mission },
        ];
        await this.sessionManager.logTranscript(session.id, "system", this.messages[0].content);
        await this.sessionManager.logTranscript(session.id, "user", mission);
        console.log(`🤖 Start Mission: "${mission}" (Session: ${session.id})`);
        let loop = 0;
        const maxLoops = 25;
        while (loop++ < maxLoops) {
            await this.logger.emit("agent.thinking", { loop });
            const payload = {
                model: this.config.model,
                messages: this.messages,
                tools: TOOLS.map((t) => ({
                    type: "function",
                    function: {
                        name: t.name,
                        description: t.description,
                        parameters: t.parameters,
                    },
                })),
            };
            const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${this.config.apiKey}`,
                },
                body: JSON.stringify(payload),
            });
            if (!response.ok) {
                const errorText = await response.text();
                const err = `API returned: ${response.status} ${errorText}`;
                console.error(`❌ API error: ${err}`);
                await this.logger.emitError(err, "high");
                session.status = "error";
                await this.sessionManager.updateSession(session);
                await this.logger.emitSessionCompleted("error");
                return;
            }
            const json = await response.json();
            const choice = json.choices[0];
            const message = choice.message;
            this.messages.push(message);
            if (message.content) {
                console.log(`💬 Agent: ${message.content}`);
                await this.logger.emitAgentMessage(message.content);
                await this.sessionManager.logTranscript(session.id, "assistant", message.content);
            }
            if (!message.tool_calls || message.tool_calls.length === 0) {
                // Final response
                console.log("🏁 Mission complete!");
                session.status = "completed";
                await this.sessionManager.updateSession(session);
                await this.logger.emitSessionCompleted("completed");
                break;
            }
            for (const call of message.tool_calls) {
                const name = call.function.name;
                const args = JSON.parse(call.function.arguments);
                console.log(`⚡ Tool Call: ${name}(${JSON.stringify(args)})`);
                await this.logger.emitToolStarted(name, args);
                const tool = TOOLS.find((t) => t.name === name);
                let result;
                if (!tool) {
                    result = { tool: name, input: args, output: "", exitCode: 1, durationMs: 0, error: `Tool ${name} not found` };
                }
                else {
                    try {
                        result = await tool.execute(args);
                    }
                    catch (e) {
                        result = { tool: name, input: args, output: "", exitCode: 1, durationMs: 0, error: String(e) };
                    }
                }
                console.log(`✅ Tool Completed (Exit Code: ${result.exitCode})`);
                await this.logger.emitToolCompleted(result);
                if (name === "bash") {
                    await this.sessionManager.logCommand(session.id, args.command, {
                        exitCode: result.exitCode,
                        stdout: result.output,
                        stderr: result.error || "",
                        durationMs: result.durationMs,
                    });
                }
                this.messages.push({
                    role: "tool",
                    tool_call_id: call.id,
                    name,
                    content: result.output || result.error || "Success",
                });
            }
        }
        // Run interestingness scoring after completion
        await this.scoreSession(session.id);
    }
    async scoreSession(sessionId) {
        const sessionPath = `${this.config.sessionDir}/${sessionId}`;
        const eventsFile = `${sessionPath}/events.jsonl`;
        let eventsText = "";
        try {
            eventsText = await readFile(eventsFile, "utf-8");
        }
        catch (e) {
            console.error(`Could not read events for interestingness scoring: ${e}`);
            return;
        }
        console.log("📊 Analyzing session for viral moments & Short generation...");
        const payload = {
            model: this.config.model,
            messages: [
                {
                    role: "system",
                    content: `You are the Yashas Tech Content Engine & Story Analyzer.
Analyze the provided session events and generate an 'interestingness report' in JSON format.
Your JSON must strictly contain:
1. "hook": A short, viral title hook (max 8 words).
2. "peak_event": The most dramatic/interesting moment in the session (e.g. debugging a hard bug, creating a key file).
3. "story": An array of key phases (e.g., ["mission", "tool_installation", "failure", "recovery", "success"]).
4. "score": An interestingness score between 0 and 100 based on error frequency, tool density, and overall complexity.
5. "duration": Optimal vertical Short video duration in seconds (15 to 30).
6. "title": A YouTube title optimized for SEO.
7. "description": An SEO optimized description with hashtags.
`,
                },
                {
                    role: "user",
                    content: `Events for session ${sessionId}:\n${eventsText}`,
                },
            ],
            response_format: { type: "json_object" },
        };
        try {
            const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${this.config.apiKey}`,
                },
                body: JSON.stringify(payload),
            });
            if (response.ok) {
                const json = await response.json();
                const report = json.choices[0].message.content;
                const { writeFile } = await import("node:fs/promises");
                await writeFile(`${sessionPath}/interestingness.json`, report, "utf-8");
                console.log(`🎉 Interestingness report generated!\n${report}`);
            }
        }
        catch (e) {
            console.error(`Failed to analyze session: ${e}`);
        }
    }
}
