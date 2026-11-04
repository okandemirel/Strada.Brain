import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The dependency-audit gate (scripts/ci/audit-gate.mjs). An exception names
 * one advisory and the exact install paths it covers, carries a reason and an
 * expiry, and nothing wider passes. Loaded through a non-literal specifier,
 * like the other .mjs CI scripts.
 */
interface Exception {
  project: string;
  advisory: string;
  nodes: string[];
  reason: string;
  expires: string;
}

interface Verdict {
  ok: boolean;
  blocking: string[];
  exempted: string[];
  stale: string[];
}

interface AuditGateModule {
  judgeAudit: (input: {
    report: unknown;
    exceptions: Exception[];
    project: string;
    today: string;
    level?: string;
  }) => Verdict;
  validateExceptions: (exceptions: unknown) => string[];
  advisoryId: (via: { url?: string; source?: number }) => string;
}

const modulePath = pathToFileURL(path.join(process.cwd(), "scripts", "ci", "audit-gate.mjs")).href;
const { judgeAudit, validateExceptions, advisoryId } = (await import(modulePath)) as AuditGateModule;

const ADVISORY = "GHSA-aaaa-bbbb-cccc";
const advisory = (severity = "high") => ({
  source: 1,
  name: "parser",
  title: "parser can exhaust memory",
  url: `https://github.com/advisories/${ADVISORY}`,
  severity,
  range: "<2.0.0",
});

/** An SDK bundling a vulnerable copy, plus (optionally) our own top-level copy. */
function report(nodes: string[], severity = "high") {
  return {
    vulnerabilities: {
      parser: { name: "parser", severity, via: [advisory(severity)], nodes },
      "chat-sdk": { name: "chat-sdk", severity, via: ["parser"], nodes: ["node_modules/chat-sdk"] },
    },
  };
}

const exception = (over: Partial<Exception> = {}): Exception => ({
  project: ".",
  advisory: ADVISORY,
  nodes: ["node_modules/chat-sdk/node_modules/parser"],
  reason: "the SDK bundles a parser release line the advisory covers in full; no SDK release is fixed",
  expires: "2026-12-04",
  ...over,
});

describe("audit gate", () => {
  it("passes an advisory an exception covers at the exact install path", () => {
    const v = judgeAudit({
      report: report(["node_modules/chat-sdk/node_modules/parser"]),
      exceptions: [exception()],
      project: ".",
      today: "2026-11-04",
    });
    expect(v.ok).toBe(true);
    expect(v.exempted).toEqual([`${ADVISORY} (parser) at node_modules/chat-sdk/node_modules/parser — excepted until 2026-12-04`]);
  });

  it("fails the same advisory at a path the exception does not name — our own copy", () => {
    const v = judgeAudit({
      report: report(["node_modules/chat-sdk/node_modules/parser", "node_modules/parser"]),
      exceptions: [exception()],
      project: ".",
      today: "2026-11-04",
    });
    expect(v.ok).toBe(false);
    expect(v.blocking).toEqual([`high ${ADVISORY} (parser) at node_modules/parser: parser can exhaust memory`]);
  });

  it("fails once the exception has expired", () => {
    const v = judgeAudit({
      report: report(["node_modules/chat-sdk/node_modules/parser"]),
      exceptions: [exception({ expires: "2026-11-03" })],
      project: ".",
      today: "2026-11-04",
    });
    expect(v.ok).toBe(false);
    expect(v.blocking[0]).toContain("its exception expired on 2026-11-03");
  });

  it("does not let one project's exception cover another project", () => {
    const v = judgeAudit({
      report: report(["node_modules/chat-sdk/node_modules/parser"]),
      exceptions: [exception({ project: "web-portal" })],
      project: ".",
      today: "2026-11-04",
    });
    expect(v.ok).toBe(false);
  });

  it("judges the advisory, not the packages that merely depend on it", () => {
    // chat-sdk's own entry is a dependency path ("parser"); it adds no finding.
    const v = judgeAudit({ report: report([]), exceptions: [], project: ".", today: "2026-11-04" });
    expect(v.ok).toBe(true);
  });

  it("ignores advisories below high, as npm audit --audit-level=high does", () => {
    const v = judgeAudit({
      report: report(["node_modules/parser"], "moderate"),
      exceptions: [],
      project: ".",
      today: "2026-11-04",
    });
    expect(v.ok).toBe(true);
  });

  it("reports an exception the audit no longer needs", () => {
    const v = judgeAudit({ report: { vulnerabilities: {} }, exceptions: [exception()], project: ".", today: "2026-11-04" });
    expect(v.ok).toBe(true);
    expect(v.stale).toEqual([`${ADVISORY} (node_modules/chat-sdk/node_modules/parser)`]);
  });

  it("refuses an exception without a reason, an expiry or the paths it covers", () => {
    expect(validateExceptions([exception()])).toEqual([]);
    expect(validateExceptions([exception({ reason: "because" })])).toEqual([
      "exception #1: reason must say why, in a sentence or more",
    ]);
    expect(validateExceptions([exception({ expires: "soon" })])).toEqual(["exception #1: expires must be YYYY-MM-DD"]);
    expect(validateExceptions([exception({ nodes: [] })])).toEqual([
      "exception #1: nodes must name the install paths it covers",
    ]);
  });

  it("names an advisory by its GHSA id", () => {
    expect(advisoryId({ url: "https://github.com/advisories/GHSA-mrhx-c7xc-m3w5" })).toBe("GHSA-mrhx-c7xc-m3w5");
  });

  it("the repository's own exceptions file is well formed and every entry expires", () => {
    const file = path.join(process.cwd(), "scripts", "ci", "audit-exceptions.json");
    const entries = JSON.parse(fs.readFileSync(file, "utf8")) as Exception[];
    expect(validateExceptions(entries)).toEqual([]);
    for (const e of entries) expect(e.expires > (e as Exception & { added?: string }).added!).toBe(true);
  });
});
