import { describe, expect, it } from "vitest";
import {
  SURFACE_POLICY,
  decideInstanceAccess,
  describeAccessModel,
  instanceRoleOf,
  ownerOnlyProxySurface,
  type InstanceFacts,
  type InstanceSurface,
} from "./instance-access.js";

// ── Plan 6.14: the shared-instance management model, as code ──
//
// One daemon serves more than one person. These tests pin the MODEL itself:
// which surfaces are owner-only, which are scoped to the acting identity, and
// that no branch ever ends in an unexplained "allowed".

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GUEST = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const shared: InstanceFacts = { shared: true, ownerProfileId: OWNER };
const solo: InstanceFacts = { shared: false, ownerProfileId: OWNER };
const issued = (id: string) => id === OWNER || id === GUEST;

const ownerActor = { profileId: OWNER, role: "owner" as const };
const guestActor = { profileId: GUEST, role: "guest" as const };
const anonActor = { role: "unidentified" as const };

describe("instance access model — roles", () => {
  it("names the first identity owner and every other issued identity a guest", () => {
    expect(instanceRoleOf(OWNER, shared, issued)).toBe("owner");
    expect(instanceRoleOf(GUEST, shared, issued)).toBe("guest");
    expect(instanceRoleOf("telegram-chat-4711", shared, issued)).toBe("unidentified");
    expect(instanceRoleOf(undefined, shared, issued)).toBe("unidentified");
  });

  it("names nobody owner on an instance that has recorded no owner", () => {
    expect(instanceRoleOf(OWNER, { shared: false }, issued)).toBe("guest");
  });
});

describe("instance access model — owner-only surfaces", () => {
  const ownerOnly = (Object.keys(SURFACE_POLICY) as InstanceSurface[]).filter(
    (s) => SURFACE_POLICY[s].scope === "owner-only",
  );

  it("covers setup writes and instance control", () => {
    expect(ownerOnly).toEqual(["instance:control", "setup:write"]);
  });

  it.each(ownerOnly)("lets the owner %s and refuses a guest by name", (surface) => {
    expect(decideInstanceAccess({ surface, actor: ownerActor, instance: shared }).allowed).toBe(true);

    const refused = decideInstanceAccess({ surface, actor: guestActor, instance: shared, what: "x" });
    expect(refused.allowed).toBe(false);
    expect(refused.code).toBe("deny:guest-owner-only");
    // The refusal names WHICH identity was refused, WHY, and who may.
    expect(refused.reason).toContain(GUEST);
    expect(refused.reason).toContain("guest");
    expect(refused.reason).toContain(OWNER);
  });

  it.each(ownerOnly)("refuses an unattributed %s once the instance is shared", (surface) => {
    const onShared = decideInstanceAccess({ surface, actor: anonActor, instance: shared });
    expect(onShared.allowed).toBe(false);
    expect(onShared.code).toBe("deny:unidentified");
    expect(onShared.reason).toContain("shared");

    // …but a single-identity instance has nobody to be separated from, so the
    // portal that does not present an identity still works for its one user.
    const onSolo = decideInstanceAccess({ surface, actor: anonActor, instance: solo });
    expect(onSolo.allowed).toBe(true);
    expect(onSolo.code).toBe("allow:sole-identity");
  });
});

describe("instance access model — own-identity surfaces", () => {
  const scoped = (Object.keys(SURFACE_POLICY) as InstanceSurface[]).filter(
    (s) => SURFACE_POLICY[s].scope === "own-identity",
  );

  it("covers boards, chat, confirmations, attachments and task control", () => {
    expect(scoped).toEqual([
      "monitor:frames",
      "chat:frames",
      "confirmation:answer",
      "attachment:read",
      "task:control",
    ]);
  });

  it.each(scoped)("lets an identity act on its own %s", (surface) => {
    const own = decideInstanceAccess({ surface, actor: guestActor, resource: { profileId: GUEST }, instance: shared });
    expect(own.allowed).toBe(true);
    expect(own.code).toBe("allow:self");
  });

  it.each(scoped)("refuses a guest another identity's %s", (surface) => {
    const other = decideInstanceAccess({
      surface,
      actor: guestActor,
      resource: { profileId: OWNER },
      instance: shared,
      what: "thing-1",
    });
    expect(other.allowed).toBe(false);
    expect(other.code).toBe("deny:other-identity");
    expect(other.reason).toContain(GUEST);
    expect(other.reason).toContain(OWNER);
    expect(other.reason).toContain("thing-1");
  });

  it.each(scoped)("gives the OWNER no power to read a guest's %s", (surface) => {
    // Deliberate: owner powers change the instance; they do not read people.
    const decision = decideInstanceAccess({ surface, actor: ownerActor, resource: { profileId: GUEST }, instance: shared });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("deny:other-identity");
  });

  it("still carries traffic that belongs to no identity here", () => {
    const decision = decideInstanceAccess({ surface: "monitor:frames", actor: guestActor, resource: {}, instance: shared });
    expect(decision.allowed).toBe(true);
    expect(decision.code).toBe("allow:unattributed");
  });

  it("matches on chatId when that is the scope the surface knows", () => {
    const own = decideInstanceAccess({
      surface: "task:control",
      actor: { profileId: GUEST, chatId: "chat-b", role: "guest" },
      resource: { chatId: "chat-b" },
      instance: shared,
    });
    expect(own.allowed).toBe(true);

    const other = decideInstanceAccess({
      surface: "task:control",
      actor: { profileId: GUEST, chatId: "chat-b", role: "guest" },
      resource: { chatId: "chat-a" },
      instance: shared,
    });
    expect(other.allowed).toBe(false);
    expect(other.reason).toContain("chat-a");
  });
});

describe("instance access model — no silent fallthrough", () => {
  const surfaces = Object.keys(SURFACE_POLICY) as InstanceSurface[];
  const actors = [ownerActor, guestActor, anonActor];
  const resources = [undefined, {}, { profileId: OWNER }, { profileId: GUEST }, { chatId: "chat-x" }];

  it("returns a coded, identity-naming reason for every surface × actor × resource", () => {
    for (const surface of surfaces) {
      for (const actor of actors) {
        for (const resource of resources) {
          for (const instance of [shared, solo]) {
            const d = decideInstanceAccess({ surface, actor, instance, ...(resource ? { resource } : {}) });
            expect(d.surface, `${surface}/${actor.role}`).toBe(surface);
            expect(d.reason.length, `${surface}/${actor.role}`).toBeGreaterThan(20);
            expect(d.code.startsWith(d.allowed ? "allow:" : "deny:"), `${surface}/${actor.role}/${d.code}`).toBe(true);
            if (actor.profileId) {
              expect(d.reason, `${surface}/${actor.role}`).toContain(actor.profileId);
            }
          }
        }
      }
    }
  });

  it("publishes the model as a table with a row per surface", () => {
    const table = describeAccessModel();
    expect(table).toHaveLength(surfaces.length);
    for (const row of table) {
      expect(row.owner.length).toBeGreaterThan(0);
      expect(row.guest.length).toBeGreaterThan(0);
    }
    expect(table.find((r) => r.surface === "setup:write")?.guest).toBe("nothing");
  });
});

describe("instance access model — dashboard proxy classification", () => {
  it("classifies setup/settings writes as owner-only setup writes", () => {
    for (const path of ["/api/settings/env", "/api/config", "/api/providers/switch", "/api/budget/config", "/api/vaults", "/api/vaults/v1/sync", "/api/personality/switch"]) {
      expect(ownerOnlyProxySurface(path), path).toBe("setup:write");
    }
  });

  it("classifies daemon lifecycle and autonomous mode as instance control", () => {
    for (const path of ["/api/daemon/start", "/api/daemon/stop", "/api/user/autonomous", "/api/deployment/check"]) {
      expect(ownerOnlyProxySurface(path), path).toBe("instance:control");
    }
  });

  it("leaves per-identity surfaces unclassified so they stay open to guests", () => {
    for (const path of ["/api/metrics", "/api/canvas", "/api/monitor/state", "/api/chat/history", "/api/skills/list", "/api/settingsnot"]) {
      expect(ownerOnlyProxySurface(path), path).toBeUndefined();
    }
  });
});

// ── Plan 6.14, the durable half: "nobody's" is not "everybody's" ──
//
// An attachment row written before the owner column records no owner. Reading
// that absence as a grant made the same link readable or not depending on when
// the daemon last booted; the conservative direction is a refusal on a shared
// instance. A monitor frame that carries no conversation scope is the opposite
// case — it genuinely belongs to every identity — so the difference is stated
// per surface rather than guessed.
describe("instance access model — unattributable resources", () => {
  it("marks only monitor frames as shared-by-all when nothing owns them", () => {
    const shareable = (Object.keys(SURFACE_POLICY) as InstanceSurface[])
      .filter((s) => SURFACE_POLICY[s].unattributedIsPublic);
    expect(shareable).toEqual(["monitor:frames"]);
  });

  it("refuses an attachment no identity is recorded for on a shared instance", () => {
    for (const actor of [ownerActor, guestActor, anonActor]) {
      const d = decideInstanceAccess({ surface: "attachment:read", actor, resource: {}, instance: shared, what: "tok" });
      expect(d.allowed, actor.role).toBe(false);
      expect(d.code, actor.role).toBe("deny:unattributable");
      expect(d.reason).toContain("no identity is recorded");
      expect(d.reason).toContain("tok");
    }
  });

  it("still serves it on a single-identity instance", () => {
    const d = decideInstanceAccess({ surface: "attachment:read", actor: anonActor, resource: {}, instance: solo });
    expect(d.allowed).toBe(true);
    expect(d.code).toBe("allow:sole-identity");
  });

  it("still broadcasts an unattributed monitor frame on a shared instance", () => {
    const d = decideInstanceAccess({ surface: "monitor:frames", actor: guestActor, resource: {}, instance: shared });
    expect(d.allowed).toBe(true);
    expect(d.code).toBe("allow:unattributed");
  });
});
