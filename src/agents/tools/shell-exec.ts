import { resolve } from "node:path";
import { validatePath } from "../../security/path-guard.js";
import { runProcess } from "../../utils/process-runner.js";
import type { ITool, ToolContext, ToolExecutionResult } from "./tool.interface.js";

const DEFAULT_TIMEOUT_MS = 30_000; // 30 seconds
const MAX_TIMEOUT_MS = 300_000; // 5 minutes

/**
 * Commands that are always blocked for safety.
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

    // Resolve and validate working directory using path-guard
    const relWd = String(input["working_directory"] ?? "");
    let cwd = context.projectPath;
    if (relWd) {
      const pathCheck = await validatePath(context.projectPath, relWd);
      if (!pathCheck.valid) {
        return {
          content: "Error: working directory must be within the project",
          isError: true,
        };
      }
      cwd = pathCheck.fullPath;
    }

    try {
      const result = await runProcess({
        command: "/bin/bash",
        args: ["-c", command],
        cwd,
        timeoutMs,
        env: { ...process.env, FORCE_COLOR: "0" },
      });
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

function formatResult(command: string, result: { stdout: string; stderr: string; exitCode: number; timedOut: boolean; durationMs: number }): string {
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

  for (const blocked of BLOCKED_COMMANDS) {
    if (lower.includes(blocked.toLowerCase())) {
      return { safe: false, reason: `blocked command pattern: ${blocked}` };
    }
  }

  for (const pattern of DANGEROUS_PIPE_PATTERNS) {
    if (pattern.test(command)) {
      return { safe: false, reason: "dangerous pipe pattern detected" };
    }
  }

  return { safe: true };
}
