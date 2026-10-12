/**
 * How Strada.Core divides a game's work, in the words the deps context
 * (item 7) and the FILE TOO LONG gate both give a worker.
 *
 * One copy, because the two copies drifted together: both taught "a command
 * per action", and Core has no commands on any version. Each piece named here
 * is something Core lets a module register (`RegisterController`,
 * `RegisterSignalHandler`) or a base type it provides (`SystemBase`), and
 * strada-core-api-fidelity.test.ts holds it to a Core checkout.
 *
 * A leaf module: the gate reads it without importing the prompt builders.
 */
export const STRADA_WORK_DIVISION =
  "a controller per flow, a signal and its handler per action, a service for state and collaboration, " +
  "a model for data, a system for per-frame work";
