#!/usr/bin/env node
// TermuxForge v0.1 — CLI Entry Point (Node.js)
import { Agent } from "./agent.js";
import { SessionManager } from "./session.js";
function parseArgs(argv) {
    const opts = {
        mission: undefined,
        record: false,
        apiKey: process.env.NINE_API_KEY || process.env.OPENAI_API_KEY || "",
        model: process.env.FORGE_MODEL || "gpt-4o",
        baseUrl: process.env.FORGE_BASE_URL || "http://localhost:20128/v1",
        sessionDir: process.env.FORGE_SESSIONS || `${process.env.HOME || "."}/.forge/sessions`,
        list: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
            case "--record":
                opts.record = true;
                break;
            case "--mission":
                opts.mission = argv[++i];
                break;
            case "--model":
                opts.model = argv[++i];
                break;
            case "--base-url":
                opts.baseUrl = argv[++i];
                break;
            case "--api-key":
                opts.apiKey = argv[++i];
                break;
            case "--session-dir":
                opts.sessionDir = argv[++i];
                break;
            case "--list":
                opts.list = true;
                break;
            case "--help":
            case "-h":
                printHelp();
                process.exit(0);
        }
    }
    return opts;
}
function printHelp() {
    console.log(`
🔨 TermuxForge — AI Coding Agent for Android/Termux

Usage:
  forge [options]

Options:
  --mission "Build a React app"   Mission prompt (or read from stdin if omitted)
  --record                        Record session events to JSONL
  --model "gpt-4o"                Model name (default: env FORGE_MODEL or gpt-4o)
  --base-url "url"                API base URL (default: env FORGE_BASE_URL or http://localhost:20128/v1)
  --api-key "key"                 API key (default: env NINE_API_KEY or OPENAI_API_KEY)
  --session-dir "dir"             Session output directory (default: ~/.forge/sessions)
  --list                          List all sessions
  --help                          Show this help

Environment:
  FORGE_MODEL, FORGE_BASE_URL, FORGE_SESSIONS, NINE_API_KEY, OPENAI_API_KEY

Examples:
  forge --mission "Build a Python web server" --record
  echo "Create a todo app" | forge --record
  forge --list
`);
}
async function listSessions() {
    const sessionDir = process.env.FORGE_SESSIONS || `${process.env.HOME || "."}/.forge/sessions`;
    console.log("📂 Sessions:\n");
    try {
        const mgr = new SessionManager(sessionDir);
        const sessions = await mgr.listSessions();
        if (sessions.length === 0) {
            console.log("  (no sessions yet)");
        }
        for (const s of sessions) {
            console.log(`  [${s.status}] ${s.id} — ${s.mission.substring(0, 50)}`);
        }
    }
    catch (e) {
        console.log("  (no sessions yet)");
    }
}
async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.list) {
        await listSessions();
        return;
    }
    let mission = opts.mission;
    // If no --mission, try reading from stdin
    if (!mission && process.stdin.isTTY) {
        console.error("❌ No mission provided. Use --mission or pipe via stdin.\n");
        printHelp();
        process.exit(1);
    }
    if (!mission && !process.stdin.isTTY) {
        mission = await new Promise((resolve) => {
            let data = "";
            process.stdin.setEncoding("utf-8");
            process.stdin.on("data", (chunk) => { data += chunk; });
            process.stdin.on("end", () => resolve(data.trim()));
            setTimeout(() => resolve(data.trim()), 3000);
        });
    }
    if (!mission) {
        console.error("❌ No mission provided.");
        process.exit(1);
    }
    if (opts.record) {
        console.log("🎥 Recording mode ON — events will be saved to JSONL.\n");
    }
    const agent = new Agent({
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl,
        model: opts.model,
        record: opts.record,
        sessionDir: opts.sessionDir,
    });
    await agent.run(mission);
}
main().catch((err) => {
    console.error(`Fatal: ${err}`);
    process.exit(1);
});
