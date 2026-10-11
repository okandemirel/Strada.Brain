/**
 * Trigger Observer
 * Reports the triggers the heartbeat fired since the last collect, as observations.
 */

import { createObservation, type Observer, type AgentObservation } from "../observation-types.js";

/** Structural interface for TriggerRegistry — avoids import coupling */
interface TriggerRegistryRef {
  getByName(name: string): { metadata: { name: string; type: string; description?: string } } | undefined;
}

/** The daemon:trigger_fired payload (daemon-events.ts TriggerFiredEvent). */
interface TriggerFire {
  readonly triggerName: string;
  readonly taskId?: string;
  readonly timestamp: number;
}

/** Structural slice of the daemon event bus — the one event this observer reads. */
interface TriggerFireEvents {
  on(event: "daemon:trigger_fired", listener: (fire: TriggerFire) => void): void;
  off(event: "daemon:trigger_fired", listener: (fire: TriggerFire) => void): void;
}

/** Fires kept between collects; a heartbeat that cannot tick AgentCore keeps only the newest. */
const MAX_BUFFERED_FIRES = 50;

export class TriggerObserver implements Observer {
  readonly name = "trigger-observer";
  private readonly fired: TriggerFire[] = [];
  private readonly onFired = (fire: TriggerFire): void => {
    if (this.fired.length >= MAX_BUFFERED_FIRES) this.fired.shift();
    this.fired.push(fire);
  };

  constructor(
    private readonly registry: TriggerRegistryRef,
    private readonly events: TriggerFireEvents,
  ) {
    // A fire is an event, not a state: no trigger's getState() ever answers "fired"
    // (TriggerState is active | paused | backed_off | disabled), so polling the registry for
    // one never reported a fire (audit agent-core-goals#7). Subscribed here, so registering
    // the observer is enough to hear the fires.
    events.on("daemon:trigger_fired", this.onFired);
  }

  stop(): void {
    this.events.off("daemon:trigger_fired", this.onFired);
  }

  collect(): AgentObservation[] {
    return this.fired.splice(0).map((fire) => {
      const metadata = this.registry.getByName(fire.triggerName)?.metadata;
      const submitted = fire.taskId ? ` (task ${fire.taskId} submitted)` : "";
      return createObservation(
        "trigger",
        `Trigger "${fire.triggerName}" fired${submitted}: ${metadata?.description ?? metadata?.type ?? "trigger"}`,
        {
          priority: 60,
          context: {
            triggerName: fire.triggerName,
            triggerType: metadata?.type,
            taskId: fire.taskId,
          },
          // The heartbeat already turned the fire into its own task (or approval): this is what
          // happened, not work for AgentCore to start a second time.
          actionable: false,
        },
      );
    });
  }
}
