#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// CONFIG & CONSTANTS
const FORGE_DIR = path.join(process.cwd(), '.forge');
const SESSIONS_DIR = path.join(FORGE_DIR, 'sessions');

// Ensure directories exist
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// LLM settings
const LLM_API_URL = process.env.FORGE_LLM_API_URL || 'http://localhost:20128/v1/chat/completions';
const LLM_API_KEY = process.env.FORGE_LLM_API_KEY || 'sk_9router';
const LLM_MODEL = process.env.FORGE_LLM_MODEL || 'oc';

// HELPER: Format dates
const getTimestamp = () => new Date().toISOString();
const getSessionId = () => `ses_${Date.now()}`;
const getSessionDir = (id) => path.join(SESSIONS_DIR, new Date().toISOString().split('T')[0], id);

// Color Helpers
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  bgBlack: '\x1b[40m'
};

// POLICY ENGINE
const policy = {
  ALLOW: ['git', 'npm', 'node', 'python', 'ls', 'cat', 'grep', 'find', 'echo', 'pwd'],
  CONFIRM: ['rm', 'chmod', 'chown', 'package', 'apt', 'pkg', 'ssh', 'curl', 'wget', 'mv', 'cp'],
  BLOCK: ['reboot', 'poweroff', 'shutdown', 'dd']
};

function checkPolicy(command) {
  const binary = command.trim().split(/\s+/)[0];
  if (policy.BLOCK.includes(binary)) {
    return 'BLOCK';
  }
  if (policy.CONFIRM.includes(binary) || command.includes('>') || command.includes('|') || command.includes('&')) {
    return 'CONFIRM';
  }
  if (policy.ALLOW.includes(binary)) {
    return 'ALLOW';
  }
  return 'CONFIRM'; // Default to safe verification
}

// EVENT LOGGING
class SessionRecorder {
  constructor(sessionId, options = {}) {
    this.sessionId = sessionId;
    this.dir = getSessionDir(sessionId);
    fs.mkdirSync(this.dir, { recursive: true });
    this.logFile = path.join(this.dir, 'events.jsonl');
    this.seq = 0;
    this.mission = options.mission || 'Run agent';
    this.record = options.record !== false;
    
    // Write metadata
    fs.writeFileSync(
      path.join(this.dir, 'metadata.json'),
      JSON.stringify({ sessionId, mission: this.mission, startedAt: getTimestamp() }, null, 2)
    );
    this.logEvent('session.started', { mission: this.mission });
  }

  logEvent(type, data) {
    if (!this.record) return;
    const event = {
      id: `evt_${String(this.seq++).padStart(3, '0')}`,
      session_id: this.sessionId,
      seq: this.seq,
      timestamp: getTimestamp(),
      type,
      ...data
    };
    fs.appendFileSync(this.logFile, JSON.stringify(event) + '\n');
  }
}

// TOOL IMPLEMENTATIONS
const tools = {
  read: {
    description: 'Read the content of a file',
    schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to file' } },
      required: ['path']
    },
    run: async (args) => {
      try {
        const content = fs.readFileSync(path.resolve(args.path), 'utf8');
        return { success: true, stdout: content };
      } catch (err) {
        return { success: false, stderr: err.message };
      }
    }
  },
  write: {
    description: 'Write or replace content in a file',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to file' },
        content: { type: 'string', description: 'Content to write' }
      },
      required: ['path', 'content']
    },
    run: async (args) => {
      try {
        const resolved = path.resolve(args.path);
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, args.content, 'utf8');
        return { success: true, stdout: `Successfully wrote to ${args.path}` };
      } catch (err) {
        return { success: false, stderr: err.message };
      }
    }
  },
  edit: {
    description: 'Surgical edit of a file replacing target block with replacement block',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to file' },
        target: { type: 'string', description: 'The exact block to search for and replace' },
        replacement: { type: 'string', description: 'The replacement content' }
      },
      required: ['path', 'target', 'replacement']
    },
    run: async (args) => {
      try {
        const resolved = path.resolve(args.path);
        const original = fs.readFileSync(resolved, 'utf8');
        if (!original.includes(args.target)) {
          return { success: false, stderr: 'Target block not found in file.' };
        }
        const updated = original.replace(args.target, args.replacement);
        fs.writeFileSync(resolved, updated, 'utf8');
        return { success: true, stdout: `Successfully edited ${args.path}` };
      } catch (err) {
        return { success: false, stderr: err.message };
      }
    }
  },
  bash: {
    description: 'Execute a terminal command',
    schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The terminal command to run' },
        timeout_ms: { type: 'number', description: 'Execution timeout in milliseconds' }
      },
      required: ['command']
    },
    run: async (args, recorder) => {
      const command = args.command;
      const decision = checkPolicy(command);
      
      if (decision === 'BLOCK') {
        return { success: false, stderr: `Blocked: command violates policy.` };
      }
      
      if (decision === 'CONFIRM') {
        console.log(`\n${colors.yellow}${colors.bright}[POLICY WARNING]${colors.reset} Command requires confirmation:`);
        console.log(`  ${colors.cyan}$ ${command}${colors.reset}\n`);
        const confirm = await askUser('Allow execution? (y/N): ');
        if (confirm.toLowerCase() !== 'y') {
          return { success: false, stderr: 'Cancelled by operator policy confirmation request.' };
        }
      }

      return new Promise((resolve) => {
        const timeout = args.timeout_ms || 30000;
        const shell = process.env.SHELL || 'bash';
        // Spawn standard command shell execution
        const child = spawn(shell, ['-c', command]);
        let stdout = '';
        let stderr = '';

        const timer = setTimeout(() => {
          child.kill();
          resolve({ success: false, stderr: `Timeout after ${timeout}ms`, exit_code: -1 });
        }, timeout);

        child.stdout.on('data', (data) => {
          const str = data.toString();
          stdout += str;
          process.stdout.write(str);
        });

        child.stderr.on('data', (data) => {
          const str = data.toString();
          stderr += str;
          process.stderr.write(str);
        });

        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({ success: code === 0, stdout, stderr, exit_code: code });
        });
      });
    }
  },
  grep: {
    description: 'Search for patterns inside workspace files using grep/rg style',
    schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex/text pattern to match' },
        path: { type: 'string', description: 'Optional path limit' }
      },
      required: ['pattern']
    },
    run: async (args) => {
      const location = args.path || '.';
      return new Promise((resolve) => {
        const cmd = `rg -n "${args.pattern}" "${location}" 2>/dev/null || grep -rn "${args.pattern}" "${location}" 2>/dev/null`;
        const child = spawn('bash', ['-c', cmd]);
        let stdout = '';
        child.stdout.on('data', (d) => stdout += d.toString());
        child.on('close', (code) => {
          resolve({ success: true, stdout });
        });
      });
    }
  },
  find: {
    description: 'Find files within workspace directory tree',
    schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob/name pattern to match' }
      },
      required: ['pattern']
    },
    run: async (args) => {
      return new Promise((resolve) => {
        const cmd = `find . -name "${args.pattern}" -not -path '*/.*' 2>/dev/null`;
        const child = spawn('bash', ['-c', cmd]);
        let stdout = '';
        child.stdout.on('data', (d) => stdout += d.toString());
        child.on('close', (code) => {
          resolve({ success: true, stdout });
        });
      });
    }
  }
};

// USER INPUT
function askUser(query) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(query, (ans) => { rl.close(); resolve(ans); }));
}

// LIVE TUI RENDERING
function renderHUD(step, activeAction = '', details = '') {
  console.clear();
  console.log(`${colors.cyan}┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓${colors.reset}`);
  console.log(`${colors.cyan}┃                 ${colors.bright}⚡ TERMUXFORGE PIPELINE ⚡${colors.cyan}                 ┃${colors.reset}`);
  console.log(`${colors.cyan}┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫${colors.reset}`);
  console.log(`${colors.cyan}┃${colors.reset}  🤖 ${colors.bright}AGENT STATUS:${colors.reset}  %-44s ${colors.cyan}┃${colors.reset}`.replace('%-44s', `${colors.green}${step.padEnd(44)}${colors.reset}`));
  console.log(`${colors.cyan}┃${colors.reset}  ⚡ ${colors.bright}LAST ACTION :${colors.reset}  %-44s ${colors.cyan}┃${colors.reset}`.replace('%-44s', `${colors.yellow}${activeAction.substring(0, 44).padEnd(44)}${colors.reset}`));
  console.log(`${colors.cyan}┃${colors.reset}  📁 ${colors.bright}DETAILS     :${colors.reset}  %-44s ${colors.cyan}┃${colors.reset}`.replace('%-44s', `${colors.dim}${details.substring(0, 44).padEnd(44)}${colors.reset}`));
  console.log(`${colors.cyan}┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛${colors.reset}\n`);
}

// LLM CHAT CLIENT
async function callLLM(messages, useTools = true) {
  const apiTools = useTools ? Object.keys(tools).map((name) => ({
    type: 'function',
    function: {
      name,
      description: tools[name].description,
      parameters: tools[name].schema
    }
  })) : undefined;

  const payload = {
    model: LLM_MODEL,
    messages,
    tools: apiTools,
    tool_choice: apiTools ? 'auto' : undefined
  };

  try {
    const response = await fetch(LLM_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LLM_API_KEY}`
      },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`HTTP Error ${response.status}: ${errText}`);
    }
    const json = await response.json();
    return json.choices[0].message;
  } catch (err) {
    console.error(`${colors.red}LLM Call Failed: ${err.message}${colors.reset}`);
    throw err;
  }
}

// MAIN AGENT LOOP
async function runAgent(prompt, options = {}) {
  const sessionId = getSessionId();
  const recorder = new SessionRecorder(sessionId, { mission: prompt, record: options.record });

  console.log(`\n${colors.bright}${colors.green}TermuxForge session started: ${sessionId}${colors.reset}\n`);
  recorder.logEvent('user.prompt', { prompt });

  const messages = [
    {
      role: 'system',
      content: `You are TermuxForge, a terminal-native AI developer running inside Termux on Android.
You have direct tool access to read, write, edit, grep, find, and run bash commands.
Maintain absolute correctness, fix failures, run checks, and explain your progress concisely.`
    },
    { role: 'user', content: prompt }
  ];

  let loop = true;
  let turns = 0;
  const maxTurns = 20;

  while (loop && turns < maxTurns) {
    turns++;
    renderHUD(`Thinking (Turn ${turns})`, 'LLM request pending');
    recorder.logEvent('agent.thinking', { turn: turns });

    let response;
    try {
      response = await callLLM(messages);
    } catch (e) {
      recorder.logEvent('error.detected', { severity: 'high', summary: e.message });
      console.log(`${colors.red}Agent aborted: ${e.message}${colors.reset}`);
      break;
    }

    if (response.content) {
      renderHUD(`Communicating`, 'Replying to user', response.content);
      console.log(`${colors.bright}🤖 Agent:${colors.reset} ${response.content}\n`);
      recorder.logEvent('agent.message', { content: response.content });
    }

    messages.push(response);

    if (response.tool_calls && response.tool_calls.length > 0) {
      for (const call of response.tool_calls) {
        const name = call.function.name;
        let args = {};
        try {
          args = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments;
        } catch (e) {
          args = { raw: call.function.arguments };
        }

        renderHUD(`Executing Tool`, name, JSON.stringify(args));
        recorder.logEvent('tool.started', { tool: name, input: args });

        const startTime = Date.now();
        let result;
        try {
          if (tools[name]) {
            result = await tools[name].run(args, recorder);
          } else {
            result = { success: false, stderr: `Tool ${name} not found.` };
          }
        } catch (err) {
          result = { success: false, stderr: err.message };
        }
        const duration = Date.now() - startTime;

        recorder.logEvent('tool.completed', {
          tool: name,
          input: args,
          output: result.stdout || '',
          error: result.stderr || '',
          exit_code: result.exit_code ?? (result.success ? 0 : 1),
          duration_ms: duration
        });

        // Report back to model
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: name,
          content: JSON.stringify(result)
        });
      }
    } else {
      loop = false;
    }
  }

  recorder.logEvent('session.completed', { status: 'success', total_turns: turns });
  renderHUD(`Completed`, 'Finished mission', `Logged to .forge/sessions/*/${sessionId}/events.jsonl`);
  console.log(`\n${colors.green}✔ Done. Session logged to directory: ${recorder.dir}${colors.reset}\n`);
}

// REPLAY FUNCTION
async function replaySession(sessionPath) {
  let resolvedPath = sessionPath;
  if (!fs.existsSync(resolvedPath)) {
    // Check inside sessions folder
    const all = fs.readdirSync(SESSIONS_DIR, { recursive: true });
    const match = all.find((f) => f.endsWith(sessionPath) || f.includes(sessionPath));
    if (match) {
      resolvedPath = path.join(SESSIONS_DIR, match);
    }
  }

  // If directory, resolve to events.jsonl
  if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory()) {
    resolvedPath = path.join(resolvedPath, 'events.jsonl');
  }

  if (!fs.existsSync(resolvedPath)) {
    console.error(`${colors.red}Error: Session file or directory not found at ${sessionPath}${colors.reset}`);
    process.exit(1);
  }

  console.log(`${colors.bright}${colors.blue}Replaying events from: ${resolvedPath}${colors.reset}\n`);
  const lines = fs.readFileSync(resolvedPath, 'utf8').trim().split('\n');

  for (const line of lines) {
    if (!line) continue;
    const evt = JSON.parse(line);
    const ts = evt.timestamp.split('T')[1].replace('Z', '');
    
    switch (evt.type) {
      case 'session.started':
        console.log(`[${ts}] ${colors.green}▶ Session started. Mission: ${evt.mission}${colors.reset}`);
        break;
      case 'user.prompt':
        console.log(`[${ts}] ${colors.bright}👤 User Prompt: ${evt.prompt}${colors.reset}`);
        break;
      case 'agent.thinking':
        console.log(`[${ts}] 🧠 ${colors.dim}Thinking (Turn ${evt.turn})...${colors.reset}`);
        break;
      case 'agent.message':
        console.log(`[${ts}] 🤖 ${colors.bright}Agent Response:${colors.reset}\n  ${evt.content.replace(/\n/g, '\n  ')}\n`);
        break;
      case 'tool.started':
        console.log(`[${ts}] 🛠️  ${colors.yellow}Tool invocation started: ${evt.tool}${colors.reset}`);
        console.log(`    Input: ${JSON.stringify(evt.input)}`);
        break;
      case 'tool.completed':
        const statusColor = evt.exit_code === 0 ? colors.green : colors.red;
        console.log(`[${ts}] 🛠️  ${colors.yellow}Tool finished: ${evt.tool} in ${evt.duration_ms}ms${colors.reset}`);
        if (evt.output) {
          console.log(`    Output:\n      ${evt.output.trim().substring(0, 300).replace(/\n/g, '\n      ')}`);
        }
        if (evt.error) {
          console.log(`    Error:\n      ${colors.red}${evt.error.trim().substring(0, 300).replace(/\n/g, '\n      ')}${colors.reset}`);
        }
        break;
      case 'error.detected':
        console.log(`[${ts}] ${colors.red}❌ Error details: [${evt.severity}] ${evt.summary}${colors.reset}`);
        break;
      case 'session.completed':
        console.log(`[${ts}] ${colors.green}✔ Session completed. Status: ${evt.status} (${evt.total_turns} turns)${colors.reset}`);
        break;
    }
    // Simulate real-time replay gap
    await new Promise((r) => setTimeout(r, 600));
  }
}

// STORY ENGINE & YOUTUBE SHORTS GENERATION
async function generateStory(sessionPath) {
  let resolvedPath = sessionPath;
  if (!fs.existsSync(resolvedPath)) {
    const all = fs.readdirSync(SESSIONS_DIR, { recursive: true });
    const match = all.find((f) => f.endsWith(sessionPath) || f.includes(sessionPath));
    if (match) {
      resolvedPath = path.join(SESSIONS_DIR, match);
    }
  }
  if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory()) {
    resolvedPath = path.join(resolvedPath, 'events.jsonl');
  }

  if (!fs.existsSync(resolvedPath)) {
    console.error(`${colors.red}Error: Session path not found.${colors.reset}`);
    process.exit(1);
  }

  const events = fs.readFileSync(resolvedPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  // Extract key moments
  const mission = events.find((e) => e.type === 'session.started')?.mission || 'Unknown';
  const toolsUsed = events.filter((e) => e.type === 'tool.completed').map((e) => e.tool);
  const failures = events.filter((e) => e.type === 'tool.completed' && e.exit_code !== 0);

  const summaryPrompt = `Analyze this TermuxForge coding session and generate:
1. A 30-second TikTok/YouTube Shorts script focusing on high drama (hook, setup, failure/obstacle, discovery, success, CTA).
2. Title ideas for YouTube.
3. Hook ideas.
4. An interestingness assessment score (0-100).

Session Info:
- Mission: "${mission}"
- Tools Executed: ${JSON.stringify(toolsUsed)}
- Failures Encountered: ${JSON.stringify(failures.map((f) => ({ tool: f.tool, cmd: f.input?.command, error: f.error || f.output })))}

Format output strictly as structured JSON:
{
  "score": 90,
  "hook": "string",
  "titles": ["title 1", "title 2"],
  "script": "narrator speech...",
  "peak_moment": "string"
}`;

  console.log(`\n${colors.bright}${colors.blue}Generating Shorts Script using LLM...${colors.reset}\n`);

  try {
    const reply = await callLLM([
      { role: 'system', content: 'You are the Story and Trend Engine for Yashas Tech. Output strictly JSON.' },
      { role: 'user', content: summaryPrompt }
    ], false);

    let parsed = {};
    try {
      parsed = JSON.parse(reply.content.replace(/```json|```/g, '').trim());
    } catch (e) {
      parsed = { raw: reply.content };
    }

    console.log(`${colors.bright}${colors.green}--- STORY ANALYSIS OUTCOME ---${colors.reset}`);
    console.log(JSON.stringify(parsed, null, 2));
  } catch (err) {
    console.error(`Failed to analyze session with LLM. Falling back to local heuristics.`);
    // Local fallback
    const fallback = {
      score: failures.length > 0 ? 85 : 60,
      hook: `I gave an AI agent terminal access to my Android phone to do: "${mission}"`,
      titles: [
        `I Let AI control my Android Terminal`,
        `AI builds app inside Termux! 🤯`
      ],
      script: `Hook: ${mission}.
Step 1: AI starts and inspects the filesystem.
Step 2: AI attempts execution.
Step 3: Success! The task is fully complete.`,
      peak_moment: failures.length > 0 ? `AI encountered a failure and fixed it!` : 'AI executed code seamlessly.'
    };
    console.log(JSON.stringify(fallback, null, 2));
  }
}

// SELFTEST ROUTINE
async function runSelfTest() {
  console.log(`\n${colors.bright}${colors.cyan}--- Starting TermuxForge Self-Test ---${colors.reset}\n`);

  const mockSessionId = 'ses_selftest';
  const recorder = new SessionRecorder(mockSessionId, { mission: 'Self-Test Forge', record: true });

  console.log('Testing Read/Write/Edit tools locally...');
  const testFile = path.join(__dirname, 'selftest_temp.txt');

  // 1. Write tool
  const writeRes = await tools.write.run({ path: testFile, content: 'line 1\nline 2\nline 3' });
  console.log(`Write: ${writeRes.success ? 'PASSED' : 'FAILED'} (${writeRes.stdout || writeRes.stderr})`);
  
  // 2. Read tool
  const readRes = await tools.read.run({ path: testFile });
  console.log(`Read: ${readRes.success && readRes.stdout.includes('line 2') ? 'PASSED' : 'FAILED'}`);

  // 3. Edit tool
  const editRes = await tools.edit.run({
    path: testFile,
    target: 'line 2',
    replacement: 'line 2 edited'
  });
  console.log(`Edit: ${editRes.success ? 'PASSED' : 'FAILED'}`);

  // 4. Verification read
  const verifyRes = await tools.read.run({ path: testFile });
  console.log(`Verify: ${verifyRes.success && verifyRes.stdout.includes('line 2 edited') ? 'PASSED' : 'FAILED'}`);

  // 5. Bash policy check
  console.log('Checking Policy checks...');
  const allowRes = checkPolicy('ls -l');
  const blockRes = checkPolicy('dd if=/dev/zero of=/dev/null');
  const confirmRes = checkPolicy('rm -rf /');
  console.log(`Policy (ls): ${allowRes === 'ALLOW' ? 'PASSED' : 'FAILED'}`);
  console.log(`Policy (dd): ${blockRes === 'BLOCK' ? 'PASSED' : 'FAILED'}`);
  console.log(`Policy (rm): ${confirmRes === 'CONFIRM' ? 'PASSED' : 'FAILED'}`);

  // Cleanup
  if (fs.existsSync(testFile)) {
    fs.unlinkSync(testFile);
  }

  recorder.logEvent('session.completed', { status: 'success', test: true });

  console.log(`\n${colors.green}✔ Self-Test Completed Successfully.${colors.reset}\n`);
}

// MAIN PARSER
const args = process.argv.slice(2);
const command = args[0];

if (!command) {
  console.log(`
${colors.bright}${colors.cyan}TermuxForge v0.1.0${colors.reset} - AI developer inside Android.

Usage:
  ${colors.bright}forge run "<prompt>"${colors.reset}     Run agent loop on a prompt/mission.
  ${colors.bright}forge replay <session>${colors.reset}   Replay event logs from a session.
  ${colors.bright}forge story <session>${colors.reset}    Generate YouTube/TikTok story from session events.
  ${colors.bright}forge selftest${colors.reset}           Run integrated tools and policy diagnostics.

Environment Variables:
  FORGE_LLM_API_URL       LLM chat endpoint (default: http://localhost:20128/v1/chat/completions)
  FORGE_LLM_API_KEY       LLM api key (default: sk_9router)
  FORGE_LLM_MODEL         LLM model identifier (default: oc)
`);
  process.exit(0);
}

if (command === 'run') {
  const prompt = args[1];
  if (!prompt) {
    console.error('Error: Please provide a prompt or mission.');
    process.exit(1);
  }
  await runAgent(prompt);
} else if (command === 'replay') {
  const session = args[1];
  if (!session) {
    console.error('Error: Please provide session ID or path.');
    process.exit(1);
  }
  await replaySession(session);
} else if (command === 'story') {
  const session = args[1];
  if (!session) {
    console.error('Error: Please provide session ID or path.');
    process.exit(1);
  }
  await generateStory(session);
} else if (command === 'selftest') {
  await runSelfTest();
} else {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}
