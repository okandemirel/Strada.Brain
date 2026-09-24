import { describe, it, expect } from "vitest";
import type { ConversationMessage, MessageContent, ToolCall } from "./providers/provider-core.interface.js";
import { normalizeConversation, INTERRUPTED_TOOL_RESULT } from "./conversation-normalizer.js";

type Msg = ConversationMessage;
type Blocks = MessageContent[];

const call = (...ids: string[]): Msg => ({
  role: "assistant",
  content: "",
  tool_calls: ids.map((id) => ({ id, name: "file_read", input: { path: id } }) as ToolCall),
});
const result = (id: string, content = `res-${id}`): MessageContent => ({ type: "tool_result", tool_use_id: id, content });
const text = (t: string): MessageContent => ({ type: "text", text: t });

/** The contract every provider needs. */
function assertContract(messages: readonly Msg[]): void {
  if (messages.length === 0) return;
  expect(messages[0]!.role).toBe("user");
  const answered = new Set<number>();
  messages.forEach((m, i) => {
    if (m.role === "assistant") {
      const calls = m.tool_calls ?? [];
      if (calls.length === 0) {
        expect(String(m.content).trim().length, `empty assistant turn at ${i}`).toBeGreaterThan(0);
        return;
      }
      const next = messages[i + 1];
      expect(next?.role, `tool_use at ${i} unanswered`).toBe("user");
      expect(Array.isArray(next!.content)).toBe(true);
      const ids = [...new Set(calls.map((c) => c.id))];
      const leading = (next!.content as Blocks).slice(0, ids.length);
      // Every call answered, results first; their order among themselves is free.
      expect(leading.map((b) => (b.type === "tool_result" ? b.tool_use_id : `<${b.type}>`)).sort()).toEqual([...ids].sort());
      answered.add(i + 1);
    }
  });
  messages.forEach((m, i) => {
    if (m.role !== "user" || typeof m.content === "string") return;
    const results = m.content.filter((b) => b.type === "tool_result");
    if (!answered.has(i)) expect(results, `orphan tool_result at ${i}`).toHaveLength(0);
    else expect(m.content.slice(results.length).every((b) => b.type !== "tool_result")).toBe(true);
  });
}

describe("normalizeConversation — the cases the review measured", () => {
  it("a tool_use left dangling by a throw gets an interrupted result (ORC-2)", () => {
    const out = normalizeConversation([{ role: "user", content: "plan first" }, call("sp1"), { role: "assistant", content: "error: message too long" }]);
    assertContract(out);
    expect((out[2]!.content as Blocks)[0]).toMatchObject({ tool_use_id: "sp1", content: INTERRUPTED_TOOL_RESULT, is_error: true });
  });

  it("gate text between tool_use and tool_result is moved behind the result (ORC-5)", () => {
    const out = normalizeConversation([
      { role: "user", content: "go" },
      call("r7"),
      { role: "user", content: "[READ-ONLY STREAK] stop reading" },
      { role: "user", content: [result("r7")] },
    ]);
    assertContract(out);
    expect(out).toHaveLength(3);
    expect(out[2]!.content).toEqual([result("r7"), text("[READ-ONLY STREAK] stop reading")]);
  });

  it("text blocks ahead of the results are reordered behind them (ORC-5)", () => {
    const out = normalizeConversation([{ role: "user", content: "go" }, call("a", "b"), { role: "user", content: [text("reflect"), result("b"), result("a")] }]);
    assertContract(out);
    expect(out[2]!.content).toEqual([result("a"), result("b"), text("reflect")]);
  });

  it("an orphan result at the head becomes text, and an assistant head gets a user note (ORC-6/7)", () => {
    const orphanHead = normalizeConversation([{ role: "user", content: [result("t5")] }, { role: "assistant", content: "done" }]);
    assertContract(orphanHead);
    expect(JSON.stringify(orphanHead)).toContain("res-t5");
    const assistantHead = normalizeConversation([{ role: "assistant", content: "" }, { role: "assistant", content: "done reading" }]);
    assertContract(assistantHead);
    expect(assistantHead.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("returns the same array when the conversation is already valid", () => {
    const valid: Msg[] = [{ role: "user", content: "go" }, call("a"), { role: "user", content: [result("a"), text("state")] }, { role: "assistant", content: "ok" }];
    expect(normalizeConversation(valid)).toBe(valid);
  });
});

// Property-style: random valid conversations, randomly broken the ways the loop, compaction and
// persistence break them, must always come out valid, idempotent, and without losing content.
describe("normalizeConversation — property: any mutation of a valid session comes out valid", () => {
  function prng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function build(rand: () => number): Msg[] {
    const msgs: Msg[] = [{ role: "user", content: "u-0" }];
    let n = 0;
    const turns = 2 + Math.floor(rand() * 10);
    for (let t = 0; t < turns; t++) {
      const kind = rand();
      if (kind < 0.55) {
        const ids = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => `c${++n}`);
        msgs.push(call(...ids));
        const blocks: Blocks = ids.map((id) => result(id));
        if (rand() < 0.4) blocks.push(text(`note-${++n}`));
        msgs.push({ role: "user", content: blocks });
      } else if (kind < 0.8) {
        msgs.push({ role: "assistant", content: `a-${++n}` });
        msgs.push({ role: "user", content: `u-${++n}` });
      } else {
        msgs.push({ role: "user", content: `u-${++n}` });
      }
    }
    return msgs;
  }

  function mutate(msgs: Msg[], rand: () => number): Msg[] {
    const out = [...msgs];
    const pick = () => Math.floor(rand() * out.length);
    const steps = 1 + Math.floor(rand() * 4);
    for (let s = 0; s < steps && out.length > 0; s++) {
      const op = Math.floor(rand() * 8);
      const i = pick();
      const m = out[i]!;
      switch (op) {
        case 0: out.splice(i, 1); break; // a lost message (throw / stream death / compaction)
        case 1: out.splice(i, 0, { role: "user", content: `gate-${s}-${i}` }); break; // gate inserted anywhere
        case 2: out.splice(0, i); break; // a persistence / trim cut at an arbitrary index
        case 3: out.splice(i, 0, { role: "assistant", content: "" }); break; // empty assistant turn
        case 4: // text first in a result message
          if (m.role === "user" && Array.isArray(m.content)) out[i] = { role: "user", content: [...m.content].reverse() };
          break;
        case 5: // split a result message into two
          if (m.role === "user" && Array.isArray(m.content) && m.content.length > 1) {
            out.splice(i, 1, { role: "user", content: m.content.slice(0, 1) }, { role: "user", content: m.content.slice(1) });
          }
          break;
        case 6: // one result lost from its message
          if (m.role === "user" && Array.isArray(m.content) && m.content.length > 0) out[i] = { role: "user", content: m.content.slice(1) };
          break;
        case 7: out.splice(i, 0, { role: "user", content: [result(`stray-${s}`)] }); break; // orphan result
      }
    }
    return out;
  }

  /** Every piece of content a provider should still see after the repair. */
  function payloads(msgs: readonly Msg[]): string[] {
    return msgs.flatMap((m) => {
      if (typeof m.content === "string") return m.content.trim() ? [m.content] : [];
      return (m.content as Blocks).flatMap((b) => (b.type === "text" ? [b.text] : b.type === "tool_result" ? [b.content] : []));
    });
  }

  it("holds for 2 000 seeded random sessions", () => {
    for (let seed = 1; seed <= 2_000; seed++) {
      const rand = prng(seed);
      const broken = mutate(build(rand), rand);
      const out = normalizeConversation(broken);
      try {
        assertContract(out);
        expect(normalizeConversation(out)).toBe(out); // idempotent: a second pass changes nothing
        const seen = JSON.stringify(out);
        for (const p of payloads(broken)) expect(seen).toContain(p);
      } catch (err) {
        throw new Error(`seed ${seed}: ${JSON.stringify(broken)}\n${(err as Error).message}`);
      }
    }
  });
});
