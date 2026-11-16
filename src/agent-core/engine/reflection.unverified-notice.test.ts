/**
 * The verifier's "Not verified: …" reaches the run's answer on every path that
 * finishes a run (#41, 2026-11-16).
 *
 * The unverifiable-failure exit opens on recorded facts and records a notice
 * for the run (verifier-pipeline-unverifiable.ts). Every finished run passes
 * settleVisibleBoundary, so the notice is attached there: rendered with the
 * answer in an interactive run, and written into the answer the handler
 * recorded in a background run, whose final text is read back from the last
 * visible assistant message. The golden runs drive the background path; the
 * interactive and reflection paths are pinned here.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../agents/orchestrator-end-turn-handler.js", () => ({
  handleBgEndTurn: vi.fn(),
  handleInteractiveEndTurn: vi.fn(),
}));
vi.mock("../../agents/orchestrator-reflection-handler.js", () => ({
  handleInteractiveReflectionDone: vi.fn(),
  handleInteractiveReflectionReplan: vi.fn(),
  handleInteractiveReflectionContinue: vi.fn(),
  handleBgReflectionDone: vi.fn(),
  handleBgReflectionReplan: vi.fn(),
  handleBgReflectionContinue: vi.fn(),
}));
vi.mock("./render.js", () => ({
  emitVisibleBoundary: vi.fn(async (_d: unknown, _c: unknown, _s: unknown, text: string) => ({ text, marked: false })),
  sanitizeBlockedVisibleText: vi.fn((_d: unknown, text: string) => ({ text, marked: false })),
}));

import { handleBgEndTurn, handleInteractiveEndTurn } from "../../agents/orchestrator-end-turn-handler.js";
import { handleBgReflectionDone, handleInteractiveReflectionDone } from "../../agents/orchestrator-reflection-handler.js";
import { emitVisibleBoundary } from "./render.js";
import { portDispatchEndTurn, portDispatchReflection, type ReflectionDeps } from "./reflection.js";
import type { EngineRunContext } from "./engine-deps.js";
import { createInitialState } from "../../agents/agent-state.js";
import type { ConversationMessage } from "../../agents/providers/provider-core.interface.js";
import {
  recordUnverifiedNotice,
  resetUnverifiableState,
  takeUnverifiedNotice,
  unverifiableRunKey,
} from "../../agents/autonomy/verifier-pipeline-unverifiable.js";

const STARTED_AT = 1_700_000_000_000;
const NOTICE = "Not verified: A step failed (file_write: Error: could not write file (ENOTDIR)) and was then redone.";
const ANSWER = "Wrote notes/lantern.txt.";

interface Session {
  messages: ConversationMessage[];
  visibleMessages: ConversationMessage[];
}

function deps(): ReflectionDeps {
  return {
    sessionManager: {
      getPendingSelfManagedWriteRejectionVisibleText: () => null,
      extractLastUserMessage: () => "write the lantern note",
      formatBoundaryVisibleText: (b: { visibleText: string }) => b.visibleText,
      appendVisibleAssistantMessage: (s: Session, text: string) => {
        const message: ConversationMessage = { role: "assistant", content: text };
        s.messages.push(message);
        s.visibleMessages.push(message);
      },
      persistSessionToMemory: async () => {},
      getVisibleTranscript: (s: Session) => s.visibleMessages,
    },
    buildInterventionDeps: () => ({}),
    taskClassifier: { classify: () => ({ type: "code_generation", criticality: "normal" }) },
    progressAssessmentEnabled: false,
    buildStructuredProgressSignal: (_p: unknown, _t: unknown, s: unknown) => s,
    getClarificationContext: () => ({ interactionConfig: {}, toolMetadataByName: new Map() }),
    synthesizeUserFacingResponse: async () => "",
  } as unknown as ReflectionDeps;
}

function runCtx(session: Session): EngineRunContext {
  return {
    chatId: "c",
    identityKey: "u",
    session,
    executionStrategy: {},
    lastToolNames: [],
    systemPrompt: "s",
    taskStartedAtMs: STARTED_AT,
    emitProgress: () => {},
  } as unknown as EngineRunContext;
}

const newSession = (): Session => ({ messages: [], visibleMessages: [] });
const state = () => createInitialState("write the lantern note");
const endTurn = (mode: "background" | "interactive") =>
  ({ mode, agentState: state(), responseText: ANSWER, chatId: "c" }) as never;
const reflection = (mode: "background" | "interactive") =>
  ({ mode, agentState: state(), responseText: ANSWER, chatId: "c", decision: "DONE" }) as never;

/** A background handler records its own answer before returning, as the real ones do. */
function answersItself(session: Session, text: string) {
  return async () => {
    deps().sessionManager.appendVisibleAssistantMessage(session as never, text);
    return { flow: "done", visibleText: text, newState: state(), status: "completed" } as never;
  };
}

beforeEach(() => {
  vi.mocked(handleBgEndTurn).mockReset();
  vi.mocked(handleInteractiveEndTurn).mockReset();
  vi.mocked(handleBgReflectionDone).mockReset();
  vi.mocked(handleInteractiveReflectionDone).mockReset();
  vi.mocked(emitVisibleBoundary).mockClear();
  resetUnverifiableState();
});

describe("the run's answer carries the verifier's notice", () => {
  it("interactive end turn: the chat is sent the answer with the notice under it, and the notice is taken", async () => {
    recordUnverifiedNotice(unverifiableRunKey("c", STARTED_AT), NOTICE);
    vi.mocked(handleInteractiveEndTurn).mockResolvedValue({ flow: "done", visibleText: ANSWER, newState: state() } as never);

    const out = await portDispatchEndTurn(deps(), endTurn("interactive"), runCtx(newSession()));

    expect(vi.mocked(emitVisibleBoundary).mock.calls[0]?.[3]).toBe(`${ANSWER}\n\n${NOTICE}`);
    expect(out.finalText).toBe(`${ANSWER}\n\n${NOTICE}`);
    expect(takeUnverifiedNotice("c", STARTED_AT)).toBeUndefined();
  });

  it("background end turn: the answer the handler recorded gets the notice, in the transcript and the history", async () => {
    recordUnverifiedNotice(unverifiableRunKey("c", STARTED_AT), NOTICE);
    const session = newSession();
    vi.mocked(handleBgEndTurn).mockImplementation(answersItself(session, ANSWER));

    await portDispatchEndTurn(deps(), endTurn("background"), runCtx(session));

    // One message, read back as the run's final text: the answer, then the notice.
    expect(session.visibleMessages).toEqual([{ role: "assistant", content: `${ANSWER}\n\n${NOTICE}` }]);
    expect(session.messages).toEqual(session.visibleMessages);
  });

  it("background end turn whose handler recorded nothing: the boundary records the answer with the notice", async () => {
    recordUnverifiedNotice(unverifiableRunKey("c", STARTED_AT), NOTICE);
    const session = newSession();
    vi.mocked(handleBgEndTurn).mockResolvedValue({ flow: "done", visibleText: ANSWER, newState: state() } as never);

    await portDispatchEndTurn(deps(), endTurn("background"), runCtx(session));

    expect(session.visibleMessages.map((m) => m.content)).toEqual([`${ANSWER}\n\n${NOTICE}`]);
  });

  it("reflection DONE, interactive and background", async () => {
    recordUnverifiedNotice(unverifiableRunKey("c", STARTED_AT), NOTICE);
    vi.mocked(handleInteractiveReflectionDone).mockResolvedValue({ flow: "done", visibleText: ANSWER, newState: state() } as never);
    await portDispatchReflection(deps(), reflection("interactive"), runCtx(newSession()));
    expect(vi.mocked(emitVisibleBoundary).mock.calls[0]?.[3]).toBe(`${ANSWER}\n\n${NOTICE}`);

    recordUnverifiedNotice(unverifiableRunKey("c", STARTED_AT), NOTICE);
    const session = newSession();
    vi.mocked(handleBgReflectionDone).mockImplementation(answersItself(session, ANSWER));
    await portDispatchReflection(deps(), reflection("background"), runCtx(session));
    expect(session.visibleMessages.map((m) => m.content)).toEqual([`${ANSWER}\n\n${NOTICE}`]);
  });

  it("no notice recorded for the run: the answer is unchanged", async () => {
    recordUnverifiedNotice(unverifiableRunKey("c", STARTED_AT + 1), NOTICE);
    vi.mocked(handleInteractiveEndTurn).mockResolvedValue({ flow: "done", visibleText: ANSWER, newState: state() } as never);

    const out = await portDispatchEndTurn(deps(), endTurn("interactive"), runCtx(newSession()));

    expect(out.finalText).toBe(ANSWER);
  });
});
