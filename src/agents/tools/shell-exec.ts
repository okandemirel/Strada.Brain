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
  /\|\s*sh\b/i,
  /\|\s*bash\b/i,
  /\|\s*zsh\b/i,
  /\|\s*rm\b/i,
  />\s*\/dev\/sd/i,
  />\s*\/dev\/nvme/i,
];

/**
 * Patterns that detect command substitution, inline script execution,
 * and other shell injection vectors that bypass the simple blocklist.
 */
const INJECTION_PATTERNS: [RegExp, string][] = [
  // Command substitution
  [/\$\(/, "command substitution $()"],
  [/`[^`]+`/, "command substitution via backticks"],

  // Inline script execution via interpreters
  [/\bpython[23]?\s+-c\b/i, "inline Python execution"],
  [/\bnode\s+-e\b/i, "inline Node.js execution"],
  [/\bperl\s+-e\b/i, "inline Perl execution"],
  [/\bruby\s+-e\b/i, "inline Ruby execution"],
  [/\bphp\s+-r\b/i, "inline PHP execution"],

  // Dangerous binaries with broad targets
  [/\brm\s+(-[a-zA-Z]*f|-[a-zA-Z]*r){2}\b/, "recursive force remove"],
  [/\bchmod\s+(-R\s+)?[0-7]{3,4}\s+\/(?!app\b)/i, "chmod on system path"],
  [/\bchown\s+-R\b/i, "recursive chown"],

  // Process/network manipulation
  [/\bkill\s+-9\s+-1\b/, "kill all processes"],
  [/\bnc\s+-[a-zA-Z]*l/i, "netcat listener"],
  [/\bncat\s+-[a-zA-Z]*l/i, "ncat listener"],

  // Encoding-based bypass attempts
  [/\bbase64\s.*\|\s*(sh|bash|zsh)\b/i, "base64-decoded shell execution"],
  [/\bprintf\s.*\|\s*(sh|bash|zsh)\b/i, "printf-to-shell execution"],
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
    if (lower.includes(blocked)) {
      return { safe: false, reason: `blocked command pattern: ${blocked}` };
    }
  }

  for (const pattern of DANGEROUS_PIPE_PATTERNS) {
    if (pattern.test(command)) {
      return { safe: false, reason: "dangerous pipe pattern detected" };
    }
  }

  for (const [pattern, label] of INJECTION_PATTERNS) {
    if (pattern.test(command)) {
      return { safe: false, reason: `blocked: ${label}` };
    }
  }

  return { safe: true };
}
