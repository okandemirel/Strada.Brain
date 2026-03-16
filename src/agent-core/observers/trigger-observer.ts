/**
 * Trigger Observer
 * Wraps TriggerRegistry to report recently fired triggers as observations.
 */

import { createObservation, type Observer, type AgentObservation } from "../observation-types.js";

/** Structural interface for TriggerRegistry — avoids import coupling */
interface TriggerRegistryRef {
  getAll(): Array<{
    metadata: { name: string; type: string; description?: string };
    getState(): string;
    getNextRun?(): Date | null;
  }>;
}

export class TriggerObserver implements Observer {
  readonly name = "trigger-observer";

  constructor(private readonly registry: TriggerRegistryRef) {}

  collect(): AgentObservation[] {
    const observations: AgentObservation[] = [];
    const triggers = this.registry.getAll();

    for (const trigger of triggers) {
      if (trigger.getState() === "fired") {
        observations.push(
          createObservation("trigger", `Trigger "${trigger.metadata.name}" fired: ${trigger.metadata.description ?? trigger.metadata.type}`, {
            priority: 60,
            context: {
              triggerName: trigger.metadata.name,
              triggerType: trigger.metadata.type,
            },
          }),
        );
      }
    }

    return observations;
  }
}
