// ---------------------------------------------------------------------------
// System Info bundled skill — uptime, CPU/memory/disk, network interfaces.
// ---------------------------------------------------------------------------

import type { ITool, ToolContext, ToolExecutionResult } from "../../../agents/tools/tool.interface.js";
import { execFileNoThrow } from "../../../utils/execFileNoThrow.js";
import os from "node:os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format seconds into a human-readable duration string (Xd Xh Xm Xs).
 */
function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);

  return parts.join(" ");
}

/**
 * Format bytes into GB with 2 decimal places.
 */
function toGB(bytes: number): string {
  return (bytes / (1024 * 1024 * 1024)).toFixed(2);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const systemUptime: ITool = {
  name: "system_uptime",
  description: "Returns OS uptime and load averages.",
  inputSchema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
  async execute(
    _input: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolExecutionResult> {
    try {
      const uptimeSeconds = os.uptime();
      const loadAvg = os.loadavg();

      return {
        content: [
          `Uptime: ${formatUptime(uptimeSeconds)}`,
          `Load Average (1m / 5m / 15m): ${loadAvg[0]?.toFixed(2)} / ${loadAvg[1]?.toFixed(2)} / ${loadAvg[2]?.toFixed(2)}`,
        ].join("\n"),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: `Error: ${message}` };
    }
  },
};

const systemResources: ITool = {
  name: "system_resources",
  description: "Returns CPU count/model, total/free memory (GB), and disk usage.",
  inputSchema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
  async execute(
    _input: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolExecutionResult> {
    try {
      const cpus = os.cpus();
      const cpuModel = cpus[0]?.model ?? "Unknown";
      const cpuCount = cpus.length;
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;

      const lines: string[] = [
        `CPU: ${cpuModel} (${cpuCount} cores)`,
        `Memory: ${toGB(usedMem)} GB used / ${toGB(totalMem)} GB total (${toGB(freeMem)} GB free)`,
      ];

      // Disk usage via df
      const dfResult = await execFileNoThrow("df", ["-h", "/"], 5000);
      if (dfResult.exitCode === 0 && dfResult.stdout) {
        const dfLines = dfResult.stdout.trim().split("\n");
        if (dfLines.length >= 2) {
          lines.push(`Disk: ${dfLines[1]}`);
        }
      } else {
        lines.push("Disk: unavailable");
      }

      return { content: lines.join("\n") };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: `Error: ${message}` };
    }
  },
};

const systemNetwork: ITool = {
  name: "system_network",
  description: "Returns network interfaces with IP addresses (excluding loopback/internal).",
  inputSchema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
  async execute(
    _input: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolExecutionResult> {
    try {
      const interfaces = os.networkInterfaces();
      const entries: string[] = [];

      for (const [name, addrs] of Object.entries(interfaces)) {
        if (!addrs) continue;
        for (const addr of addrs) {
          if (addr.internal) continue;
          entries.push(`${name}: ${addr.family} ${addr.address}`);
        }
      }

      if (entries.length === 0) {
        return { content: "No external network interfaces found." };
      }

      return { content: entries.join("\n") };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: `Error: ${message}` };
    }
  },
};

export const tools = [systemUptime, systemResources, systemNetwork];
export default tools;
