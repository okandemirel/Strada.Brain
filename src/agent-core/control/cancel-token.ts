/**
 * Agent Core v2 — Control Plane: CancelToken — the abort fabric (ARCHITECTURE §2.2).
 *
 * One linked tree of AbortControllers. Aborting any node fans out to all descendants
 * and every registered in-flight op (the live `fetch`, a spawned subprocess, an SSE
 * reader). The reason is set first-writer-wins and carried (not inferred), so cancel-vs-
 * stall is data the rest of the system reads rather than re-derives from error strings.
 *
 * The v1 dual-signal provider contract is preserved at the provider boundary:
 *   `signal`         = the CALL token (first-token / stall / hard for this call)
 *   `externalSignal` = the TASK token (user-cancel / winddown / parent)
 */

import type { CancelReason } from "./cancel-reason.js";
import { isBenign } from "./cancel-reason.js";

/** A handle to undo a registration; `dispose()` is idempotent. */
export interface Registration {
  dispose(): void;
}

export interface CancelToken {
  readonly signal: AbortSignal; // handed to fetch()
  readonly reason: CancelReason | null; // null while live; set atomically, first-writer-wins
  readonly aborted: boolean;
  isBenign(): boolean;
  /** A linked descendant token. Cancelling the parent cancels it (as `parent-cancelled`). */
  child(): CancelToken;
  cancel(reason: CancelReason): void;
  /** Register an in-flight op to abort on cancel. Aborts immediately if already cancelled. */
  registerInFlight(label: string, abort: (r: CancelReason) => void): Registration;
  /** Subscribe to cancellation. Fires immediately if already cancelled. Returns an unsubscribe fn. */
  onAbort(cb: (r: CancelReason) => void): () => void;
}

class CancelTokenImpl implements CancelToken {
  private readonly controller = new AbortController();
  private _reason: CancelReason | null = null;
  private readonly children = new Set<CancelTokenImpl>();
  private readonly inflight = new Map<symbol, (r: CancelReason) => void>();
  private readonly abortCbs = new Set<(r: CancelReason) => void>();

  constructor(private readonly parent?: CancelTokenImpl) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get reason(): CancelReason | null {
    return this._reason;
  }

  get aborted(): boolean {
    return this.controller.signal.aborted;
  }

  isBenign(): boolean {
    return this._reason !== null && isBenign(this._reason);
  }

  child(): CancelToken {
    const c = new CancelTokenImpl(this);
    if (this._reason !== null) {
      // Parent already cancelled — the child is born cancelled with the parent's cause.
      c.cancel({ kind: "parent-cancelled", rootCause: this._reason });
    } else {
      this.children.add(c);
    }
    return c;
  }

  cancel(reason: CancelReason): void {
    if (this._reason !== null) return; // first-writer-wins
    this._reason = reason;

    // Fan out in order: in-flight ops first (cancel the live fetch/subprocess), then
    // descendant tokens, then plain listeners. Each is best-effort and isolated.
    for (const abort of this.inflight.values()) {
      try {
        abort(reason);
      } catch {
        /* a faulty aborter must not block the rest of the fan-out */
      }
    }
    this.inflight.clear();

    for (const c of this.children) {
      try {
        c.cancel({ kind: "parent-cancelled", rootCause: reason });
      } catch {
        /* isolate */
      }
    }
    this.children.clear();

    this.controller.abort(reason);

    for (const cb of this.abortCbs) {
      try {
        cb(reason);
      } catch {
        /* isolate */
      }
    }
    this.abortCbs.clear();

    this.parent?.children.delete(this);
  }

  registerInFlight(label: string, abort: (r: CancelReason) => void): Registration {
    if (this._reason !== null) {
      abort(this._reason);
      return { dispose() {} };
    }
    const key = Symbol(label);
    this.inflight.set(key, abort);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.inflight.delete(key);
      },
    };
  }

  onAbort(cb: (r: CancelReason) => void): () => void {
    if (this._reason !== null) {
      cb(this._reason);
      return () => {};
    }
    this.abortCbs.add(cb);
    return () => {
      this.abortCbs.delete(cb);
    };
  }
}

/** Create a root cancel token (the task token for a run). */
export function createCancelToken(): CancelToken {
  return new CancelTokenImpl();
}
