/**
 * The persistent delivery package (plan 6.1).
 *
 * The measure the plan states is that a developer reviews the work WITHOUT the
 * agent explaining it — so the contract under test is not "the page renders":
 * it is that a piece nobody measured READS as unmeasured, that a failure and an
 * absence are different rows, that every green with no proof under it carries a
 * root cause, and that a NEW PROCESS answers for the same campaign.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DELIVERY_PIECE_ORDER,
  DeliveryPackageStore,
  MAX_DELIVERY_ITEMS,
  artifactRunCommand,
  assembleDeliveryPackage,
  collectFalseGreens,
  gatherDeliveryPackageFacts,
  gatherDiffFacts,
  renderDeliveryPackage,
  type DeliveryCampaignFacts,
  type DeliveryPackageFacts,
  type DeliveryPiece,
  type DeliveryPieceId,
} from "./delivery-package.js";
import type { LedgerRow } from "./evidence-ledger.js";
import { encodeRequirement } from "./requirement-identity.js";
import type { CampaignMilestone } from "./types.js";

function milestone(over: Partial<CampaignMilestone> = {}): CampaignMilestone {
  return { id: "m1", title: "Sprint A — Foundations", prompt: "do the thing", status: "green", attempts: 1, ...over };
}

function campaign(over: Partial<DeliveryCampaignFacts> = {}): DeliveryCampaignFacts {
  return {
    id: "campaign_1",
    projectRoot: "/tmp/Game",
    state: "done",
    milestones: [milestone()],
    createdAt: 1_000,
    updatedAt: 1_000 + 3_600_000,
    ...over,
  };
}

function pieceOf(pkg: { pieces: readonly DeliveryPiece[] }, id: DeliveryPieceId): DeliveryPiece {
  const found = pkg.pieces.find((p) => p.id === id);
  if (found === undefined) throw new Error(`no piece ${id}`);
  return found;
}

describe("assembleDeliveryPackage — a missing piece reads as missing", () => {
  it("emits every piece as a row even when nothing at all was measured", () => {
    const pkg = assembleDeliveryPackage({ campaign: campaign({ milestones: [] }), now: 5 });
    expect(pkg.pieces.map((p) => p.id)).toEqual([...DELIVERY_PIECE_ORDER]);
    // Not one of the seven is omitted, and the summary counts say so.
    expect(pkg.completeness.of).toBe(DELIVERY_PIECE_ORDER.length);
    expect(pkg.completeness.present + pkg.completeness.failed + pkg.completeness.missing + pkg.completeness.notMeasured).toBe(
      DELIVERY_PIECE_ORDER.length,
    );
    for (const p of pkg.pieces) {
      expect(p.summary.length).toBeGreaterThan(0);
      expect(p.source.length).toBeGreaterThan(0);
    }
    // With no milestones there is no ladder, no build, no play-through and no
    // diff: every one of those says NOT MEASURED rather than rendering blank.
    expect(pieceOf(pkg, "diff").state).toBe("not-measured");
    expect(pieceOf(pkg, "artifact").state).toBe("not-measured");
    expect(pieceOf(pkg, "playthrough").state).toBe("not-measured");
    expect(pieceOf(pkg, "checklist").state).toBe("not-measured");
    expect(pieceOf(pkg, "gaps").state).toBe("not-measured");
  });

  it("names the unmeasured PARTS of a piece that is otherwise present", () => {
    const pkg = assembleDeliveryPackage({
      campaign: campaign(),
      diff: { commits: [{ sha: "a".repeat(40), subject: "add the thing" }] },
    });
    const diff = pieceOf(pkg, "diff");
    expect(diff.state).toBe("present");
    // A commit is carried as a plain line, not as a checklist item: it has no
    // met/open verdict and must not be rendered under one.
    expect(diff.lines).toEqual([`${"a".repeat(12)} add the thing`]);
    expect(diff.items).toBeUndefined();
    expect(diff.missing).toContain("files changed");
    expect(diff.missing).toContain("the command that shows the diff");
  });

  it("keeps an absent play-through apart from a failed one", () => {
    const none = pieceOf(assembleDeliveryPackage({ campaign: campaign() }), "playthrough");
    expect(none.state).toBe("not-measured");
    expect(none.summary).toContain("NOT MEASURED");
    expect(none.missing).toContain("a play-through inside the built player");

    const failed = pieceOf(
      assembleDeliveryPackage({
        campaign: campaign({
          milestones: [milestone({ playerPlaythrough: { found: true, ok: false, reasons: ["the player never booted"] } })],
        }),
      }),
      "playthrough",
    );
    expect(failed.state).toBe("failed");
    expect(failed.summary).toContain("PLAY FAILED");
    expect(failed.summary).toContain("the player never booted");

    const stale = pieceOf(
      assembleDeliveryPackage({
        campaign: campaign({ milestones: [milestone({ playthroughVerdict: { found: false, stale: true } })] }),
      }),
      "playthrough",
    );
    expect(stale.state).toBe("missing");
    expect(stale.summary).toContain("predates the sprint");
    // …and it says WHERE it was played: an editor run is not the shipped game.
    expect(stale.summary).toContain("NOT the shipped player");
  });

  it("keeps a build that FAILED apart from a build nobody ran, and from an artifact that is gone", () => {
    const notRun = pieceOf(
      assembleDeliveryPackage({ campaign: campaign({ milestones: [milestone({ buildVerdict: { ran: false, detail: "no builder" } })] }) }),
      "artifact",
    );
    expect(notRun.state).toBe("not-measured");
    expect(notRun.summary).toContain("never ran");

    const failed = pieceOf(
      assembleDeliveryPackage({
        campaign: campaign({ milestones: [milestone({ buildVerdict: { ran: true, ok: false, reasons: ["9 compile errors"] } })] }),
      }),
      "artifact",
    );
    expect(failed.state).toBe("failed");
    expect(failed.summary).toContain("9 compile errors");

    const gone = pieceOf(
      assembleDeliveryPackage({
        campaign: campaign({
          milestones: [milestone({ buildVerdict: { ran: true, ok: true, artifactPath: "/tmp/Game/Build/Game.app", target: "StandaloneOSX", sizeBytes: 5_000_000 } })],
        }),
        artifact: {
          verdict: { ran: true, ok: true, artifactPath: "/tmp/Game/Build/Game.app", target: "StandaloneOSX", sizeBytes: 5_000_000 },
          onDisk: false,
        },
      }),
      "artifact",
    );
    expect(gone.state).toBe("missing");
    expect(gone.summary).toContain("GONE");
  });

  it("says so when no HOW_TO_RUN was written, and still hands over the command it has", () => {
    const pkg = assembleDeliveryPackage({
      campaign: campaign(),
      artifact: { runCommand: 'open "/tmp/Game/Build/Game.app"' },
      howToRun: { note: "the project root was not writable" },
    });
    const run = pieceOf(pkg, "run-command");
    expect(run.state).toBe("missing");
    expect(run.summary).toContain("NO HOW_TO_RUN.md");
    expect(run.summary).toContain("the project root was not writable");
    expect(run.locators?.some((l) => l.value.includes("Game.app"))).toBe(true);
    expect(run.missing).toContain("the command that re-runs the suite");
  });

  it("refuses to attribute a dollar to work no ledger keys, and still reports the duration", () => {
    const pkg = assembleDeliveryPackage({
      campaign: campaign(),
      spend: { durationMs: 7_200_000, usdNote: "the budget ledger has no campaign column", source: "the campaign clock" },
    });
    const cost = pieceOf(pkg, "cost");
    expect(cost.state).toBe("present");
    expect(cost.summary).toContain("cost NOT MEASURED");
    expect(cost.summary).toContain("2.0 h");
    expect(cost.missing?.join(" ")).toContain("no campaign column");
    // Neither half measured is NOT a present piece.
    expect(pieceOf(assembleDeliveryPackage({ campaign: campaign() }), "cost").state).toBe("not-measured");
  });

  it("an unreadable commit history is not an empty one", () => {
    const empty = pieceOf(assembleDeliveryPackage({ campaign: campaign(), diff: { commits: [], note: "no commit since the sprint began" } }), "diff");
    expect(empty.state).toBe("missing");
    expect(empty.summary).toContain("NO COMMIT");

    const broken = pieceOf(
      assembleDeliveryPackage({ campaign: campaign(), diff: { commits: [], unreadable: true, note: "not a git repository" } }),
      "diff",
    );
    expect(broken.state).toBe("not-measured");
    expect(broken.summary).toContain("NOT MEASURED");
    expect(broken.summary).toContain("not a git repository");
  });
});

describe("the checklist and the gaps", () => {
  it("carries the unproven part of a green sprint on the item itself", () => {
    const pkg = assembleDeliveryPackage({
      campaign: campaign({
        milestones: [
          milestone({ id: "m1", title: "Sprint A", compileVerdict: { ok: true, ran: true }, testVerdict: "173 passed", testVerdictUnfiltered: true }),
          milestone({ id: "m2", title: "Sprint B" }),
        ],
      }),
    });
    const checklist = pieceOf(pkg, "checklist");
    const a = checklist.items?.find((i) => i.text === "Sprint A");
    const b = checklist.items?.find((i) => i.text === "Sprint B");
    expect(a).toMatchObject({ state: "met" });
    expect(a?.cause).toBeUndefined();
    // Round 11 #11: a green sprint nothing proved is NOT MEASURED, not met —
    // and it therefore counts as a gap instead of hiding in explanatory text.
    expect(b).toMatchObject({ state: "not-measured" });
    expect(b?.cause).toContain("never compiled");
    expect(b?.cause).toContain("no observed test run");
    const gaps = pieceOf(pkg, "gaps");
    expect(JSON.stringify(gaps)).toContain("Sprint B");
  });

  it("a green sprint whose compile FAILED is not a met requirement either (round 11 #11)", () => {
    const pkg = assembleDeliveryPackage({
      campaign: campaign({
        milestones: [
          milestone({
            id: "mf", title: "Sprint F", status: "green",
            compileVerdict: { ran: true, ok: false, errors: 3 } as never,
            testVerdict: "173 passed (PlayMode)", testVerdictUnfiltered: true,
          }),
        ],
      }),
    });
    const item = pieceOf(pkg, "checklist").items?.find((i) => i.text === "Sprint F");
    expect(item).toMatchObject({ state: "not-measured" });
    expect(item?.cause).toContain("compile FAILED");
  });

  it("states a repair sprint's requirement as the AUDIT closed it, not as the sprint ended", () => {
    const pkg = assembleDeliveryPackage({
      campaign: campaign({
        milestones: [milestone({ id: "m9", title: "Repair — pigs", status: "failed", coverageGap: "Pigs must flee the player", coverageClosed: true, coverageClosedRevision: "b".repeat(40) })],
      }),
    });
    const item = pieceOf(pkg, "checklist").items?.[0];
    expect(item).toMatchObject({ text: "Pigs must flee the player", state: "met", source: "the evidence audit" });
    expect(item?.cause).toContain("the sprint ended failed");
  });

  it("prints the requirement, never the plan-6.2 identity tail (the reader is a person)", () => {
    const encoded = encodeRequirement({
      id: "req-4-abc123",
      lineage: "req-4-abc123",
      text: "Pigs must flee the player",
      gddSha256: "c".repeat(64),
      gddRevision: 2,
    });
    const pkg = assembleDeliveryPackage({
      campaign: campaign({
        milestones: [milestone({ id: "m9", title: "Repair — pigs", status: "completed", coverageGap: encoded, coverageClosed: true })],
      }),
    });
    const item = pieceOf(pkg, "checklist").items?.[0];
    expect(item?.text).toBe("Pigs must flee the player");
    expect(renderDeliveryPackage(pkg)).not.toContain("rid:");
  });

  it("…and a PENDING gap is a person's row too (Codex round 13 #30)", () => {
    // The checklist went through requirementText; the gap list did not, so a
    // requirement that outlived the scheduling cap reached the reader as
    // "Shop: absent ⟦rid:req-001-… lin:… gdd:…⟧".
    const encoded = encodeRequirement({
      id: "req-001-abc123abc123",
      lineage: "req-001-abc123abc123",
      text: "Shop: absent",
      gddSha256: "d".repeat(64),
      gddRevision: 3,
    });
    const pkg = assembleDeliveryPackage({
      campaign: campaign({ state: "failed", pendingCoverageGaps: [encoded] }),
    });
    const gaps = pieceOf(pkg, "gaps");
    expect(gaps.items?.map((i) => i.text)).toContain("Shop: absent");
    // Nowhere in the package the reader is handed, in any field.
    const stored = JSON.stringify(pkg);
    expect(stored).toContain("Shop: absent");
    expect(stored).not.toContain("rid:");
    expect(stored).not.toContain("⟦");
    expect(renderDeliveryPackage(pkg)).not.toContain("rid:");
  });

  it("lists the GDD's own numbers with the state the claim check gave them", () => {
    const pkg = assembleDeliveryPackage({
      campaign: campaign({
        milestones: [
          milestone({
            gddClaims: [
              "at least 60 fps: MET — 61.2 fps measured in the player",
              "20 levels: NOT MET — the catalogue reports 7",
              "load under 2 s: NOT MEASURED — no boot timing was recorded",
            ],
          }),
        ],
      }),
    });
    const states = pieceOf(pkg, "checklist").items?.filter((i) => i.source.includes("GDD")).map((i) => i.state);
    expect(states).toEqual(["met", "not-met", "not-measured"]);
    // Everything that is not met is also an open gap, by construction.
    const gaps = pieceOf(pkg, "gaps").items ?? [];
    expect(gaps.map((g) => g.state)).toContain("not-met");
    expect(gaps.map((g) => g.state)).toContain("not-measured");
  });

  it("names BOTH missing halves of the checklist, not just the last one", () => {
    const checklist = pieceOf(assembleDeliveryPackage({ campaign: campaign() }), "checklist");
    expect(checklist.missing).toEqual(["the GDD this was judged against", "how the ladder covered the document"]);
    const withGdd = pieceOf(assembleDeliveryPackage({ campaign: campaign({ gddPath: "docs/GDD.md" }) }), "checklist");
    expect(withGdd.missing).toEqual(["how the ladder covered the document"]);
  });

  it("an empty gap list says it is the absence of a record, not a proof", () => {
    const gaps = pieceOf(
      assembleDeliveryPackage({
        campaign: campaign({
          milestones: [milestone({ compileVerdict: { ok: true, ran: true }, testVerdict: "173 passed", testVerdictUnfiltered: true })],
        }),
      }),
      "gaps",
    );
    expect(gaps.items).toBeUndefined();
    expect(gaps.summary).toContain("absence of a record");
  });

  it("drains the audit queue, the missing proofs and the refused structural check into the gaps", () => {
    const pkg = assembleDeliveryPackage({
      campaign: campaign({
        pendingCoverageGaps: ["Slingshot must aim"],
        coverageAuditNote: "the audit's round budget was spent",
        milestones: [
          milestone({ id: "m1", structureRefused: true, structureFindings: ["0 world renderers in the shipped scenes"] }),
          milestone({ id: "m2", deliveryProofsMissing: ["no play-through in the built player"], sceneHygieneUnresolved: "no enabled scene names an entry" }),
        ],
      }),
    });
    const texts = (pieceOf(pkg, "gaps").items ?? []).map((g) => g.text);
    expect(texts).toContain("Slingshot must aim");
    expect(texts).toContain("no play-through in the built player");
    expect(texts).toContain("the GDD-coverage audit did not run clean");
    expect(texts).toContain("the shipped scenes are not built the way the GDD specifies");
    expect(texts).toContain("no scene a person can open");
  });

  it("counts the items it did not list rather than truncating silently", () => {
    const many = Array.from({ length: MAX_DELIVERY_ITEMS + 5 }, (_, i) => milestone({ id: `m${i}`, title: `Sprint ${i}`, status: "failed" }));
    const checklist = pieceOf(assembleDeliveryPackage({ campaign: campaign({ milestones: many }) }), "checklist");
    expect(checklist.items).toHaveLength(MAX_DELIVERY_ITEMS);
    expect(checklist.itemsOmitted).toBe(5);
  });
});

describe("every false green has a root cause recorded", () => {
  it("records the absent proof under each green, naming the record it read", () => {
    const facts: DeliveryPackageFacts = {
      campaign: campaign({
        milestones: [
          milestone({ id: "m1", title: "Sprint A", compileVerdict: { ok: true, ran: false, detail: "no Unity on this machine" }, testVerdict: "12 passed", testVerdictUnfiltered: false }),
        ],
      }),
    };
    const greens = collectFalseGreens(facts);
    expect(greens.map((g) => g.rootCause)).toEqual([
      "compile NOT measured — no Unity on this machine",
      "its green test run was FILTERED — what the rest of the suite does was never observed",
    ]);
    for (const g of greens) {
      expect(g.claim).toBe("Sprint A landed green");
      expect(g.source).toContain("sprint m1");
    }
  });

  it("records a refused receipt and a dispatch nobody settled", () => {
    const rows: LedgerRow[] = [
      { runId: "r1".padEnd(12, "0"), campaignId: "campaign_1", generation: 0, milestoneId: "m1", attemptId: "a1", kind: "player-build", medium: "builder", issuedAt: 1, state: "refused", refusal: "ARTIFACT_MISMATCH", detail: "the digest is another build's" },
      { runId: "r2".padEnd(12, "0"), campaignId: "campaign_1", generation: 0, milestoneId: "m1", attemptId: "a1", kind: "playthrough", medium: "player", issuedAt: 2, state: "pending" },
    ];
    const pkg = assembleDeliveryPackage({
      campaign: campaign({ milestones: [milestone({ compileVerdict: { ok: true, ran: true }, testVerdict: "1 passed", testVerdictUnfiltered: true })] }),
      receipts: rows,
    });
    expect(pkg.falseGreens.map((g) => g.rootCause)).toEqual([
      "REFUSED (ARTIFACT_MISMATCH): the digest is another build's",
      "the run was dispatched and no receipt came back — its provenance is unverified",
    ]);
    // The receipts themselves are carried, so the reviewer sees the dispatches.
    expect(pkg.receipts).toHaveLength(2);
    expect(pkg.receiptsNote).toBeUndefined();
  });

  it("says a delivery rests on NO dispatch at all, rather than showing an empty list", () => {
    const pkg = assembleDeliveryPackage({ campaign: campaign() });
    expect(pkg.receipts).toEqual([]);
    expect(pkg.receiptsNote).toContain("No producer dispatch was recorded");
  });

  it("records a done campaign whose sprints never landed green", () => {
    const pkg = assembleDeliveryPackage({ campaign: campaign({ state: "done", milestones: [milestone({ status: "failed" })] }) });
    expect(pkg.falseGreens.some((g) => g.claim === "the campaign is done")).toBe(true);
  });
});

describe("gathering the facts", () => {
  it("reads the commits from the project's own history and offers a command that can run", () => {
    const calls: string[][] = [];
    const git = (args: readonly string[]): string => {
      calls.push([...args]);
      if (args[0] === "log" && args.includes("--name-only")) return "a.cs\nb.cs\na.cs\n";
      if (args[0] === "log") return `${"b".repeat(40)}\tsecond\n${"a".repeat(40)}\tfirst\n`;
      if (args[0] === "rev-parse") return `${"9".repeat(40)}\n`;
      throw new Error(`unexpected git ${args.join(" ")}`);
    };
    const facts = gatherDiffFacts({ projectRoot: "/tmp/Game", git }, 1_000);
    expect(facts.commits.map((c) => c.subject)).toEqual(["first", "second"]);
    expect(facts.filesChanged).toBe(2);
    expect(facts.range).toBe(`${"a".repeat(40)}~1..${"b".repeat(40)}`);
    expect(facts.command).toContain("git -C /tmp/Game diff --stat --patch");
    expect(calls[0]?.[1]).toBe(`--since=${new Date(1_000).toISOString()}`);
  });

  it("offers `show` instead of a range when the oldest commit has no parent", () => {
    const git = (args: readonly string[]): string => {
      if (args[0] === "log" && args.includes("--name-only")) return "a.cs\n";
      if (args[0] === "log") return `${"a".repeat(40)}\tfirst\n`;
      throw new Error("unknown revision");
    };
    const facts = gatherDiffFacts({ projectRoot: "/tmp/Game", git }, 0);
    expect(facts.range).toBeUndefined();
    expect(facts.command).toContain("show");
    expect(facts.note).toContain("no parent");
  });

  it("marks the history unreadable — never empty — when git cannot answer", () => {
    const facts = gatherDiffFacts({ projectRoot: "/tmp/Game", git: () => { throw new Error("not a git repository"); } }, 0);
    expect(facts).toMatchObject({ unreadable: true, commits: [] });
    expect(facts.note).toContain("not a git repository");
    // …and with no probe at all, the same: nothing looked.
    expect(gatherDiffFacts({ projectRoot: "/tmp/Game" }, 0).unreadable).toBe(true);
  });

  it("names a command only for an artifact a command can run", () => {
    expect(artifactRunCommand("/b/Game.app").command).toBe('open "/b/Game.app"');
    expect(artifactRunCommand("/b/Game.exe").command).toBe('"/b/Game.exe"');
    expect(artifactRunCommand("/b/Game.apk").command).toContain("adb install");
    expect(artifactRunCommand("/b/webgl/index.html").command).toBeUndefined();
    expect(artifactRunCommand("/b/webgl/index.html").note).toContain("served over HTTP");
    expect(artifactRunCommand(undefined).note).toContain("no artifact path");
  });

  it("copies the campaign's own records and probes nothing it was not given", () => {
    const facts = gatherDeliveryPackageFacts(
      campaign({
        milestones: [
          milestone({
            taskId: "task_7",
            startedAtMs: 500,
            buildVerdict: { ran: true, ok: true, artifactPath: "/tmp/Game/Build/Game.app", target: "StandaloneOSX" },
            testVerdict: "173 passed (PlayMode)",
          }),
        ],
      }),
      {
        projectRoot: "/tmp/Game",
        git: () => "",
        statSize: (path) => (path === "/tmp/Game/Build/Game.app" ? 5_000_000 : undefined),
        selectFrame: () => ({ reason: "no frame under Recordings/ was captured during this sprint" }),
        howToRunPath: "HOW_TO_RUN.md",
        now: 42,
      },
    );
    expect(facts.artifact?.onDisk).toBe(true);
    expect(facts.artifact?.runCommand).toBe('open "/tmp/Game/Build/Game.app"');
    // The suite command is the SAME string HOW_TO_RUN.md prints, with the
    // platform the recorded verdict names — not a guess.
    expect(facts.howToRun?.suiteCommand).toContain("-testPlatform PlayMode");
    expect(facts.recording?.path).toBeUndefined();
    expect(facts.recording?.note).toContain("no frame under Recordings/");
    // Spend: the duration is the campaign's own clock; the dollar figure has no
    // owner and must not be invented.
    expect(facts.spend?.durationMs).toBe(3_600_000);
    expect(facts.spend?.usd).toBeUndefined();
    // Nobody handed the gatherer a spend reading: that is "unread", never $0.
    expect(facts.spend?.usdNote).toContain("nobody read the budget ledger");
    const pkg = assembleDeliveryPackage(facts);
    expect(pkg.taskId).toBe("task_7");
    expect(pkg.assembledAt).toBe(42);
  });
});

describe("rendering", () => {
  it("prints every piece, its source and what it could not measure", () => {
    const text = renderDeliveryPackage(
      assembleDeliveryPackage({
        campaign: campaign({ milestones: [milestone({ title: "Sprint Z" })] }),
        diff: { commits: [{ sha: "c".repeat(40), subject: "the change" }], filesChanged: 3, insertions: 10, deletions: 2, command: "git diff" },
      }),
    );
    for (const p of DELIVERY_PIECE_ORDER) expect(text).toContain(p === "diff" ? "The change" : "");
    expect(text).toContain("The change");
    expect(text).toContain("The build artifact");
    expect(text).toContain("The play-through");
    expect(text).toContain("NOT MEASURED:");
    expect(text).toContain("Greens with no proof under them");
    expect(text).toContain("no test run was ever observed");
  });
});

describe("DeliveryPackageStore — it survives the process that wrote it", () => {
  let dir: string;
  let store: DeliveryPackageStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "delivery-package-"));
    store = new DeliveryPackageStore(join(dir, "packages.db"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("answers for the same campaign from a NEW store instance — a restart keeps the package", () => {
    const pkg = assembleDeliveryPackage({ campaign: campaign(), now: 10 });
    const stored = store.put(pkg, 10);
    expect(stored.revision).toBe(1);

    // The process that wrote it is gone; a different one opens the same file,
    // which is the whole point of 6.1 (a chat message could not do this).
    store.close();
    const reopened = new DeliveryPackageStore(join(dir, "packages.db"));
    try {
      const latest = reopened.latest("campaign_1");
      expect(latest?.revision).toBe(1);
      expect(latest?.package.pieces.map((p) => p.id)).toEqual([...DELIVERY_PIECE_ORDER]);
      expect(latest?.package.completeness).toEqual(pkg.completeness);
      expect(reopened.index()[0]).toMatchObject({ campaignId: "campaign_1", revision: 1, title: "Sprint A — Foundations" });
    } finally {
      reopened.close();
      store = new DeliveryPackageStore(join(dir, "packages.db"));
    }
  });

  it("does not multiply revisions for an unchanged assembly, and keeps the old one when it changes", () => {
    const first = assembleDeliveryPackage({ campaign: campaign(), now: 10 });
    expect(store.put(first, 10).revision).toBe(1);
    // A re-sent delivery report re-assembles the same document: one revision.
    expect(store.put(assembleDeliveryPackage({ campaign: campaign(), now: 10 }), 20).revision).toBe(1);
    // A real change is a new revision, and the FIRST is still readable: the
    // root cause a reviewer is chasing may only exist in the older package.
    const second = assembleDeliveryPackage({
      campaign: campaign({ milestones: [milestone({ testVerdict: "173 passed", testVerdictUnfiltered: true })] }),
      now: 30,
    });
    expect(store.put(second, 30).revision).toBe(2);
    expect(store.get("campaign_1", 1)?.package.falseGreens.some((g) => g.rootCause.includes("no test run"))).toBe(true);
    expect(store.latest("campaign_1")?.revision).toBe(2);
    expect(store.history("campaign_1").map((h) => h.revision)).toEqual([2, 1]);
  });

  it("a report assembled again at another moment is the same revision (CMP-14)", () => {
    // Production never passes `now`: each assembly carries its own clock.
    expect(store.put(assembleDeliveryPackage({ campaign: campaign(), now: 1_000 }), 1_000).revision).toBe(1);
    expect(store.put(assembleDeliveryPackage({ campaign: campaign(), now: 2_000 }), 2_000).revision).toBe(1);
    expect(store.history("campaign_1")).toHaveLength(1);
  });

  it("an unreadable newest row does not stop the next package from being stored (CMP-14)", () => {
    store.put(assembleDeliveryPackage({ campaign: campaign(), now: 10 }), 10);
    const db = (store as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => void } } }).db;
    db.prepare("UPDATE delivery_packages SET document_json = ? WHERE campaign_id = ?").run("{truncated", "campaign_1");
    const next = store.put(assembleDeliveryPackage({ campaign: campaign({ state: "failed" }), now: 20 }), 20);
    expect(next.revision).toBe(2);
    expect(store.latest("campaign_1")?.revision).toBe(2);
  });

  it("has nothing to say about a campaign it never stored", () => {
    expect(store.latest("campaign_missing")).toBeUndefined();
    expect(store.get("campaign_missing", 1)).toBeUndefined();
    expect(store.history("campaign_missing")).toEqual([]);
    expect(store.index()).toEqual([]);
  });

  it("refuses a row it cannot parse instead of hydrating half a package", () => {
    store.put(assembleDeliveryPackage({ campaign: campaign(), now: 10 }), 10);
    const db = (store as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => void } } }).db;
    db.prepare("UPDATE delivery_packages SET document_json = ? WHERE campaign_id = ?").run("{truncated", "campaign_1");
    expect(store.latest("campaign_1")).toBeUndefined();
    // The index row still lists it: the package is unreadable, not forgotten.
    expect(store.index()).toHaveLength(1);
  });

  it("keeps each campaign's newest package in the index", () => {
    store.put(assembleDeliveryPackage({ campaign: campaign({ id: "c_a" }), now: 10 }), 10);
    store.put(assembleDeliveryPackage({ campaign: campaign({ id: "c_b" }), now: 20 }), 20);
    store.put(assembleDeliveryPackage({ campaign: campaign({ id: "c_a", state: "failed" }), now: 30 }), 30);
    const index = store.index();
    expect(index.map((r) => `${r.campaignId}@${r.revision}`)).toEqual(["c_a@2", "c_b@1"]);
  });
});

// ---------------------------------------------------------------------------
// Plan 6.1's open item, closed: the ledger keys spend by campaign now, so the
// package answers with a number — and still refuses to invent one.
// ---------------------------------------------------------------------------
describe("what the work cost", () => {
  it("reports the ledger's own total for this campaign, with the entries behind it", () => {
    const facts = gatherDeliveryPackageFacts(campaign(), {
      projectRoot: "/p",
      spend: { totalUsd: 1.2345, entries: 7 },
    });
    expect(facts.spend?.usd).toBeCloseTo(1.2345, 6);
    expect(facts.spend?.usdNote).toBeUndefined();
    expect(facts.spend?.source).toContain("7 entries");
    const pkg = assembleDeliveryPackage(facts);
    const cost = pieceOf(pkg, "cost");
    expect(cost.state).toBe("present");
    expect(cost.summary).toContain("1.23");
    expect(cost.missing ?? []).toEqual([]);
  });

  it("a total with no entries behind it is UNATTRIBUTED, never zero dollars", () => {
    const facts = gatherDeliveryPackageFacts(campaign(), {
      projectRoot: "/p",
      spend: { totalUsd: 0, entries: 0 },
    });
    expect(facts.spend?.usd).toBeUndefined();
    expect(facts.spend?.usdNote).toContain("no row for this campaign");
    const cost = pieceOf(assembleDeliveryPackage(facts), "cost");
    expect(cost.summary).toContain("NOT MEASURED");
    expect(cost.missing.join(" ")).toContain("what it cost");
  });

  it("one entry reads as one entry (guard)", () => {
    const facts = gatherDeliveryPackageFacts(campaign(), {
      projectRoot: "/p",
      spend: { totalUsd: 0.5, entries: 1 },
    });
    expect(facts.spend?.source).toContain("1 entry");
  });
});

// ---------------------------------------------------------------------------
// Round 11 #12: commits chosen by wall clock are not the campaign's work.
// ---------------------------------------------------------------------------
describe("whose commits these are", () => {
  const OWN_A = "a".repeat(40);
  const OWN_B = "b".repeat(40);

  function gitFor(log: string[]): (args: readonly string[]) => string {
    return (args) => {
      log.push(args.join(" "));
      if (args[0] === "show" && args.includes("--pretty=format:%H%x09%s")) {
        const sha = args[args.length - 1]!;
        return `${sha}\tcampaign work ${sha.slice(0, 4)}`;
      }
      if (args[0] === "show" && args.includes("--name-only")) return "Assets/A.cs\nAssets/B.cs\n";
      if (args[0] === "rev-parse") return "parent-ok";
      if (args[0] === "log") return `${"c".repeat(40)}\tsomebody else's commit`;
      return "";
    };
  }

  it("reads the campaign's OWN commits and never asks the clock", () => {
    const log: string[] = [];
    const facts = gatherDeliveryPackageFacts(campaign(), { projectRoot: "/p", git: gitFor(log), ownedCommits: [OWN_A, OWN_B] });
    expect(facts.diff?.attribution).toBe("campaign");
    expect(facts.diff?.commits.map((c) => c.sha)).toEqual([OWN_A, OWN_B]);
    // A human's commit in the same window is nowhere near this package.
    expect(JSON.stringify(facts.diff)).not.toContain("somebody else");
    expect(log.some((cmd) => cmd.includes("--since="))).toBe(false);
    const pkg = assembleDeliveryPackage(facts);
    const diff = pieceOf(pkg, "diff");
    expect(diff.state).toBe("present");
    expect(diff.summary).not.toContain("UNATTRIBUTED");
    expect(diff.source).toContain("the campaign itself recorded");
  });

  it("says UNATTRIBUTED when it had to fall back to the sprint's clock", () => {
    const log: string[] = [];
    const facts = gatherDeliveryPackageFacts(campaign(), { projectRoot: "/p", git: gitFor(log) });
    expect(facts.diff?.attribution).toBe("time-window");
    const diff = pieceOf(assembleDeliveryPackage(facts), "diff");
    expect(diff.summary).toContain("UNATTRIBUTED");
    expect(diff.source).toContain("NOT attributed");
    expect(log.some((cmd) => cmd.includes("--since="))).toBe(true);
  });

  it("a recorded commit this repository does not have is named, not silently dropped", () => {
    const git = (args: readonly string[]): string => {
      if (args[0] === "show" && args.includes("--pretty=format:%H%x09%s")) {
        const sha = args[args.length - 1]!;
        if (sha === OWN_B) throw new Error("bad object");
        return `${sha}\tkept`;
      }
      if (args[0] === "rev-parse") return "ok";
      return "";
    };
    const facts = gatherDeliveryPackageFacts(campaign(), { projectRoot: "/p", git, ownedCommits: [OWN_A, OWN_B] });
    expect(facts.diff?.commits).toHaveLength(1);
    expect(facts.diff?.note).toContain("not in this repository");
  });
});
