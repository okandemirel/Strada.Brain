/**
 * File Watch Observer
 * Wraps file system change events into observations.
 * Uses a simple buffer that collects events between collect() calls.
 */

import { createObservation, type Observer, type AgentObservation } from "../observation-types.js";

export interface FileEvent {
  type: "add" | "change" | "unlink";
  path: string;
  timestamp: number;
}

export class FileWatchObserver implements Observer {
  readonly name = "file-watch-observer";
  private buffer: FileEvent[] = [];
  private static readonly MAX_BUFFER = 100;

  /** Push a file event (called by external file watcher integration) */
  pushEvent(event: FileEvent): void {
    if (this.buffer.length < FileWatchObserver.MAX_BUFFER) {
      this.buffer.push(event);
    }
  }

  collect(): AgentObservation[] {
    if (this.buffer.length === 0) return [];

    const events = this.buffer.splice(0); // Drain buffer
    const byType = { add: 0, change: 0, unlink: 0 };
    for (const e of events) {
      byType[e.type]++;
    }

    const parts: string[] = [];
    if (byType.change > 0) parts.push(`${byType.change} modified`);
    if (byType.add > 0) parts.push(`${byType.add} added`);
    if (byType.unlink > 0) parts.push(`${byType.unlink} deleted`);

    const summary = `File changes: ${parts.join(", ")}`;
    const priority = byType.unlink > 0 ? 70 : byType.change > 0 ? 50 : 30;

    return [
      createObservation("file-watch", summary, {
        priority,
        context: {
          eventCount: events.length,
          files: events.slice(0, 10).map((e) => `${e.type}: ${e.path}`),
          byType,
        },
      }),
    ];
  }
}
