import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { ITool, ToolContext, ToolExecutionResult } from "./tool.interface.js";

const DEFAULT_TIMEOUT_MS = 30_000; // 30 seconds
const MAX_TIMEOUT_MS = 300_000; // 5 minutes
const MAX_OUTPUT_LENGTH = 16_384; // 16KB output cap

/**
 * Commands that are always blocked for safety.
 * These can cause irreversible damage or security issues.
 */
const BLOCKED_COMMANDS = [
  "rm -rf /",
  "rm -rf /*",
  "mkfs",
  "dd if=",
  ":(){",
  "fork bomb",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "init 0",
  "init 6",
  "chmod -R 777 /",
  "chown -R",
  "wget|sh",
  "curl|sh",
  "curl|bash",
  "wget|bash",
] as const;

/**
 * Patterns that indicate potentially dangerous piped commands.
 */
const DANGEROUS_PIPE_PATTERNS = [
  /\|\s*sh\b/,
  /\|\s*bash\b/,
  /\|\s*zsh\b/,
  /\|\s*rm\b/,
  />\s*\/dev\/sd/,
  />\s*\/dev\/nvme/,
];

export class ShellExecTool implements ITool {
  readonly name = "shell_exec";
  readonly description =
    "Execute a shell command in the project directory. Use this to run builds (dotnet build), " +
    "tests (dotnet test), git commands, and other development tools. " +
    "Commands run with a timeout and output is captured. " +
    "Dangerous commands (rm -rf /, shutdown, etc.) are blocked.";

  readonly inputSchema = {
    type: "object",
    properties: {
      command: {
        type: "string",
        description:
          "The shell command to execute (e.g., 'dotnet build', 'git status', 'ls -la')",
      },
      working_directory: {
        type: "string",
        description:
          "Working directory relative to project root. Optional, defaults to project root.",
      },
      timeout_ms: {
        type: "number",
        description:
          "Timeout in milliseconds (default: 30000, max: 300000). Use higher values for builds.",
      },
    },
    required: ["command"],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    if (context.readOnly) {
      return {
        content: "Error: shell execution is disabled in read-only mode",
        isError: true,
      };
    }

    const command = String(input["command"] ?? "").trim();
    if (!command) {
      return { content: "Error: 'command' is required", isError: true };
    }

    // Safety check: block dangerous commands
    const safety = checkCommandSafety(command);
    if (!safety.safe) {
      return {
        content: `Error: command blocked for safety — ${safety.reason}`,
        isError: true,
      };
    }

    const timeoutMs = Math.min(
      Math.max(1000, Number(input["timeout_ms"] ?? DEFAULT_TIMEOUT_MS)),
      MAX_TIMEOUT_MS,
    );

    // Resolve working directory
    const relWd = String(input["working_directory"] ?? "");
    const cwd = relWd
      ? resolve(context.projectPath, relWd)
      : context.projectPath;

    // Verify cwd is within project
    if (!cwd.startsWith(context.projectPath)) {
      return {
        content: "Error: working directory must be within the project",
        isError: true,
      };
    }

    try {
      const result = await executeCommand(command, cwd, timeoutMs);
      return {
        content: formatResult(command, result),
        metadata: {
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
        },
      };
    } catch (error) {
      return {
        content: `Error: failed to execute command — ${error instanceof Error ? error.message : "unknown error"}`,
        isError: true,
      };
    }
  }
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

function executeCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    const start = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn("/bin/bash", ["-c", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
      if (stdout.length > MAX_OUTPUT_LENGTH * 2) {
        stdout = stdout.slice(-MAX_OUTPUT_LENGTH);
      }
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
      if (stderr.length > MAX_OUTPUT_LENGTH * 2) {
        stderr = stderr.slice(-MAX_OUTPUT_LENGTH);
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000);
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(stderr),
        exitCode: code ?? (timedOut ? 124 : 1),
        timedOut,
        durationMs: Date.now() - start,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({
        stdout: "",
        stderr: err.message,
        exitCode: 127,
        timedOut: false,
        durationMs: Date.now() - start,
      });
    });
  });
}

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_LENGTH) return output;
  return "... (truncated)\n" + output.slice(-MAX_OUTPUT_LENGTH);
}

function formatResult(command: string, result: CommandResult): string {
  const parts: string[] = [];
  parts.push(`$ ${command}`);
  parts.push(`Exit code: ${result.exitCode} | Duration: ${result.durationMs}ms`);
  if (result.timedOut) {
    parts.push("⚠ Command timed out and was killed");
  }
  if (result.stdout) {
    parts.push(`\n--- stdout ---\n${result.stdout}`);
  }
  if (result.stderr) {
    parts.push(`\n--- stderr ---\n${result.stderr}`);
  }
  if (!result.stdout && !result.stderr) {
    parts.push("(no output)");
  }
  return parts.join("\n");
}

function checkCommandSafety(command: string): { safe: boolean; reason?: string } {
  const lower = command.toLowerCase().trim();

  // Check blocked commands
  for (const blocked of BLOCKED_COMMANDS) {
    if (lower.includes(blocked.toLowerCase())) {
      return { safe: false, reason: `blocked command pattern: ${blocked}` };
    }
  }

  // Check dangerous pipe patterns
  for (const pattern of DANGEROUS_PIPE_PATTERNS) {
    if (pattern.test(command)) {
      return { safe: false, reason: "dangerous pipe pattern detected" };
    }
  }

  return { safe: true };
}
