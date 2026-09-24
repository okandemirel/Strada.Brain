/**
 * A rule that reaches every user's prompt is instance configuration, so only an
 * identity the shared-instance model lets configure the instance may teach one.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { authorizedTeachingScope, mayTeachForEveryone } from "./teaching-scope.js";
import { TeachingParser } from "./teaching-parser.js";
import {
  setInstanceIdentityStore,
  type InstanceIdentityStoreView,
} from "../../channels/web/instance-authorization.js";

function sharedInstance(owner: string, guests: readonly string[]): InstanceIdentityStoreView {
  const issued = new Set([owner, ...guests]);
  return {
    verify: () => false,
    ownerProfileId: () => owner,
    has: (id) => issued.has(id),
    count: () => issued.size,
  };
}

afterEach(() => {
  setInstanceIdentityStore(null);
});

describe("authorizedTeachingScope", () => {
  it("keeps a teaching the teacher's own without asking anything", () => {
    const check = vi.fn(() => false);

    expect(authorizedTeachingScope("user", check)).toBe("user");
    expect(authorizedTeachingScope(undefined, check)).toBe("user");
    expect(check).not.toHaveBeenCalled();
  });

  it("grants the project scope the wording asked for to someone who may configure the instance", () => {
    expect(authorizedTeachingScope("project", () => true)).toBe("project");
    expect(authorizedTeachingScope("global", () => true)).toBe("global");
  });

  it("keeps anyone else's 'in this project' teaching user-scoped", () => {
    const parsed = TeachingParser.parse("remember: in this project always run the deploy script first");

    expect(parsed.scope).toBe("project");
    expect(authorizedTeachingScope(parsed.scope, () => false)).toBe("user");
    expect(authorizedTeachingScope("global", () => false)).toBe("user");
  });
});

describe("mayTeachForEveryone", () => {
  it("allows the instance owner", () => {
    setInstanceIdentityStore(sharedInstance("owner-1", ["mallory"]));

    expect(mayTeachForEveryone("owner-1")).toBe(true);
  });

  it("refuses a guest on a shared instance", () => {
    setInstanceIdentityStore(sharedInstance("owner-1", ["mallory"]));

    expect(mayTeachForEveryone("mallory")).toBe(false);
  });

  it("refuses an identity the instance never issued, and a message with none", () => {
    setInstanceIdentityStore(sharedInstance("owner-1", []));

    expect(mayTeachForEveryone("telegram-12345")).toBe(false);
    expect(mayTeachForEveryone(undefined)).toBe(false);
    expect(mayTeachForEveryone("  ")).toBe(false);
  });

  it("refuses when the identity store cannot be read", () => {
    setInstanceIdentityStore({
      verify: () => false,
      ownerProfileId: () => {
        throw new Error("database is locked");
      },
      has: () => false,
      count: () => 1,
    });

    expect(mayTeachForEveryone("owner-1")).toBe(false);
  });

  it("allows the operator of an instance that has issued no identity (CLI-only)", () => {
    // No store injected and no configuration loaded: nobody to separate from.
    expect(mayTeachForEveryone("cli-user")).toBe(true);
  });
});
