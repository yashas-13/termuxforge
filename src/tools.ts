// TermuxForge v0.1 — Tool Executor (Node.js)
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { ToolResult } from "./types.js";

const BLOCKED_COMMANDS = new Set(["sudo", "su", "passwd", "useradd", "userdel", "groupadd", "groupdel"]);
const CONFIRM_PATTERNS = [/^rm\s+/, /chmod\s+/, /chown\s+/];

function checkPermission(cmd: string): "allow" | "confirm" | "block" {
  const base = cmd.trim().split(/\s+/)[0];
  if (BLOCKED_COMMANDS.has(base)) return "block";
  if (CONFIRM_PATTERNS.some(p => p.test(cmd.trim()))) {
    console.error(`⚠️  Confirm: ${cmd.trim()}`);
  }
  return "allow";
}

function execBash(command: string, timeoutMs = 120000): Promise<ToolResult> {
  const start = Date.now();
  const perm = checkPermission(command);
  if (perm === "block") return Promise.resolve({ tool: "bash", input: { command }, output: "", exitCode: -1, durationMs: 0, error: `Blocked: ${command}` });

  return new Promise((resolve) => {
    const proc = spawn("bash", ["-c", command], { cwd: process.cwd() });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve({ tool: "bash", input: { command }, output: stdout + (stderr ? `\n[stderr]\n${stderr}` : ""), exitCode: -1, durationMs: Date.now() - start, error: `Timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ tool: "bash", input: { command }, output: stdout + (stderr ? `\n[stderr]\n${stderr}` : ""), exitCode: code ?? 1, durationMs: Date.now() - start, error: code !== 0 ? stderr : undefined });
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      resolve({ tool: "bash", input: { command }, output: "", exitCode: 1, durationMs: Date.now() - start, error: String(e) });
    });
  });
}

export async function executeRead(path: string): Promise<ToolResult> {
  const start = Date.now();
  try {
    const content = await readFile(path, "utf-8");
    return { tool: "read", input: { path }, output: content, exitCode: 0, durationMs: Date.now() - start };
  } catch (e) { return { tool: "read", input: { path }, output: "", exitCode: 1, durationMs: Date.now() - start, error: String(e) }; }
}

export async function executeWrite(path: string, content: string): Promise<ToolResult> {
  const start = Date.now();
  try {
    await writeFile(path, content, "utf-8");
    return { tool: "write", input: { path }, output: `Written ${content.length} bytes to ${path}`, exitCode: 0, durationMs: Date.now() - start };
  } catch (e) { return { tool: "write", input: { path }, output: "", exitCode: 1, durationMs: Date.now() - start, error: String(e) }; }
}

export async function executeEdit(path: string, oldText: string, newText: string): Promise<ToolResult> {
  const start = Date.now();
  try {
    const content = await readFile(path, "utf-8");
    if (!content.includes(oldText)) return { tool: "edit", input: { path, oldText, newText }, output: "", exitCode: 1, durationMs: Date.now() - start, error: "oldText not found in file" };
    await writeFile(path, content.replace(oldText, newText), "utf-8");
    return { tool: "edit", input: { path }, output: "Edited successfully", exitCode: 0, durationMs: Date.now() - start };
  } catch (e) { return { tool: "edit", input: { path }, output: "", exitCode: 1, durationMs: Date.now() - start, error: String(e) }; }
}

export async function executeGrep(pattern: string, path = ".", include?: string): Promise<ToolResult> {
  const start = Date.now();
  const args = ["-r", "-n", "--color=never", pattern, path];
  if (include) args.push("--include", include);
  return new Promise((resolve) => {
    const proc = spawn("grep", args, { cwd: process.cwd() });
    let out = "";
    proc.stdout.on("data", (d) => { out += d.toString(); });
    proc.on("close", (code) => {
      resolve({ tool: "grep", input: { pattern, path, include }, output: out || "No matches", exitCode: code ?? 1, durationMs: Date.now() - start });
    });
  });
}

export async function executeFind(pattern: string, path = "."): Promise<ToolResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    const proc = spawn("find", [path, "-name", pattern], { cwd: process.cwd() });
    let out = "";
    proc.stdout.on("data", (d) => { out += d.toString(); });
    proc.on("close", (code) => {
      resolve({ tool: "find", input: { pattern, path }, output: out.trim() || "No files found", exitCode: code ?? 0, durationMs: Date.now() - start });
    });
  });
}

export const TOOLS = [
  { name: "bash", description: "Execute a shell command in Termux", parameters: { type: "object", properties: { command: { type: "string" }, timeoutMs: { type: "number" } }, required: ["command"] }, execute: async (a: any) => execBash(String(a.command), Number(a.timeoutMs) || 120000) },
  { name: "read", description: "Read file contents", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, execute: async (a: any) => executeRead(String(a.path)) },
  { name: "write", description: "Create or overwrite a file", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] }, execute: async (a: any) => executeWrite(String(a.path), String(a.content)) },
  { name: "edit", description: "Edit a file by replacing exact text", parameters: { type: "object", properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } }, required: ["path", "oldText", "newText"] }, execute: async (a: any) => executeEdit(String(a.path), String(a.oldText), String(a.newText)) },
  { name: "grep", description: "Search file contents by regex", parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, include: { type: "string" } }, required: ["pattern"] }, execute: async (a: any) => executeGrep(String(a.pattern), String(a.path || "."), a.include ? String(a.include) : undefined) },
  { name: "find", description: "Find files by name glob", parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] }, execute: async (a: any) => executeFind(String(a.pattern), String(a.path || ".")) },
] as const;