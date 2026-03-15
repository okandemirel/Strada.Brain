import { describe, it, expect, vi, beforeAll } from "vitest";
import { AuthManager } from "./auth.js";
import { createLogger } from "../utils/logger.js";

vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  createLogger: vi.fn(),
}));

beforeAll(() => {
  createLogger("error");
});

describe("AuthManager - Telegram", () => {
  it("returns true for an allowed user ID", () => {
    const auth = new AuthManager([100]);
    expect(auth.isTelegramUserAllowed(100)).toBe(true);
  });

  it("returns false for an unauthorized user", () => {
    const auth = new AuthManager([100]);
    expect(auth.isTelegramUserAllowed(999)).toBe(false);
  });

  it("allows multiple configured IDs", () => {
    const auth = new AuthManager([100, 200, 300]);
    expect(auth.isTelegramUserAllowed(100)).toBe(true);
    expect(auth.isTelegramUserAllowed(200)).toBe(true);
    expect(auth.isTelegramUserAllowed(300)).toBe(true);
  });

  it("returns true when the same ID is checked twice", () => {
    const auth = new AuthManager([42]);
    expect(auth.isTelegramUserAllowed(42)).toBe(true);
    expect(auth.isTelegramUserAllowed(42)).toBe(true);
  });
});

describe("AuthManager - Discord", () => {
  it("returns true for allowed Discord user ID", () => {
    const auth = new AuthManager([], {
      allowedDiscordIds: new Set(["user123", "user456"]),
      allowedDiscordRoles: new Set(),
    });
    expect(auth.isDiscordUserAllowed("user123")).toBe(true);
    expect(auth.isDiscordUserAllowed("user456")).toBe(true);
  });

  it("returns false for unauthorized Discord user", () => {
    const auth = new AuthManager([], {
      allowedDiscordIds: new Set(["user123"]),
      allowedDiscordRoles: new Set(),
    });
    expect(auth.isDiscordUserAllowed("user999")).toBe(false);
  });

  it("allows users with allowed roles", () => {
    const auth = new AuthManager([], {
      allowedDiscordIds: new Set(),
      allowedDiscordRoles: new Set(["admin", "moderator"]),
    });
    expect(auth.isDiscordUserAllowed("any", ["admin"])).toBe(true);
    expect(auth.isDiscordUserAllowed("any", ["moderator", "user"])).toBe(true);
  });

  it("denies users without allowed roles", () => {
    const auth = new AuthManager([], {
      allowedDiscordIds: new Set(),
      allowedDiscordRoles: new Set(["admin"]),
    });
    expect(auth.isDiscordUserAllowed("any", ["user", "member"])).toBe(false);
  });

  it("allows if user ID matches regardless of roles", () => {
    const auth = new AuthManager([], {
      allowedDiscordIds: new Set(["special"]),
      allowedDiscordRoles: new Set(["admin"]),
    });
    expect(auth.isDiscordUserAllowed("special", ["user"])).toBe(true);
  });

  it("returns false when no auth configured", () => {
    const auth = new AuthManager([], {
      allowedDiscordIds: new Set(),
      allowedDiscordRoles: new Set(),
    });
    expect(auth.isDiscordUserAllowed("any")).toBe(false);
  });
});

describe("AuthManager - Discord ID helpers", () => {
  it("should check if Discord ID is allowed", () => {
    const auth = new AuthManager([], {
      allowedDiscordIds: new Set(["user123"]),
    });
    expect(auth.isDiscordIdAllowed("user123")).toBe(true);
    expect(auth.isDiscordIdAllowed("user999")).toBe(false);
  });

  it("should check if has allowed Discord role", () => {
    const auth = new AuthManager([], {
      allowedDiscordRoles: new Set(["admin", "mod"]),
    });
    expect(auth.hasAllowedDiscordRole(["admin", "user"])).toBe(true);
    expect(auth.hasAllowedDiscordRole(["user", "member"])).toBe(false);
  });
});

describe("AuthManager - Discord runtime modification", () => {
  it("should add Discord user at runtime", () => {
    const auth = new AuthManager([], {
      allowedDiscordIds: new Set(),
    });
    
    expect(auth.isDiscordUserAllowed("newuser")).toBe(false);
    auth.addDiscordUser("newuser");
    expect(auth.isDiscordUserAllowed("newuser")).toBe(true);
  });

  it("should remove Discord user at runtime", () => {
    const auth = new AuthManager([], {
      allowedDiscordIds: new Set(["user123"]),
    });
    
    expect(auth.isDiscordUserAllowed("user123")).toBe(true);
    expect(auth.removeDiscordUser("user123")).toBe(true);
    expect(auth.isDiscordUserAllowed("user123")).toBe(false);
    expect(auth.removeDiscordUser("user123")).toBe(false);
  });

  it("should add Discord role at runtime", () => {
    const auth = new AuthManager([], {
      allowedDiscordRoles: new Set(),
    });
    
    expect(auth.isDiscordUserAllowed("any", ["vip"])).toBe(false);
    auth.addDiscordRole("vip");
    expect(auth.isDiscordUserAllowed("any", ["vip"])).toBe(true);
  });

  it("should remove Discord role at runtime", () => {
    const auth = new AuthManager([], {
      allowedDiscordRoles: new Set(["vip"]),
    });
    
    expect(auth.isDiscordUserAllowed("any", ["vip"])).toBe(true);
    expect(auth.removeDiscordRole("vip")).toBe(true);
    expect(auth.isDiscordUserAllowed("any", ["vip"])).toBe(false);
    expect(auth.removeDiscordRole("vip")).toBe(false);
  });
});

describe("AuthManager - Slack", () => {
  it("returns true for allowed Slack user ID", () => {
    const auth = new AuthManager([], {
      allowedSlackIds: ["U123", "U456"],
    });
    expect(auth.isSlackUserAllowed("U123")).toBe(true);
    expect(auth.isSlackUserAllowed("U456")).toBe(true);
  });

  it("returns false for unauthorized Slack user", () => {
    const auth = new AuthManager([], {
      allowedSlackIds: ["U123"],
    });
    expect(auth.isSlackUserAllowed("U999")).toBe(false);
  });

  it("denies all users when no Slack restrictions configured", () => {
    const auth = new AuthManager([], {});
    expect(auth.isSlackUserAllowed("any")).toBe(false);
  });

  it("returns true for allowed Slack workspace", () => {
    const auth = new AuthManager([], {
      allowedSlackWorkspaces: ["T123", "T456"],
    });
    expect(auth.isSlackWorkspaceAllowed("T123")).toBe(true);
    expect(auth.isSlackWorkspaceAllowed("T456")).toBe(true);
  });

  it("returns false for unauthorized Slack workspace", () => {
    const auth = new AuthManager([], {
      allowedSlackWorkspaces: ["T123"],
    });
    expect(auth.isSlackWorkspaceAllowed("T999")).toBe(false);
  });

  it("denies all workspaces when no restrictions configured", () => {
    const auth = new AuthManager([], {});
    expect(auth.isSlackWorkspaceAllowed("any")).toBe(false);
  });

  it("checks combined Slack authorization", () => {
    const auth = new AuthManager([], {
      allowedSlackIds: ["U123"],
      allowedSlackWorkspaces: ["T123"],
    });
    expect(auth.isSlackAllowed("U123", "T123")).toBe(true);
    expect(auth.isSlackAllowed("U999", "T123")).toBe(false);
    expect(auth.isSlackAllowed("U123", "T999")).toBe(false);
  });

  it("should get allowed Slack IDs", () => {
    const auth = new AuthManager([], {
      allowedSlackIds: ["U123", "U456"],
      allowedSlackWorkspaces: ["T123"],
    });
    expect(auth.getAllowedSlackIds()).toEqual(["U123", "U456"]);
    expect(auth.getAllowedSlackWorkspaces()).toEqual(["T123"]);
  });
});

describe("AuthManager - Status", () => {
  it("should return Discord auth status", () => {
    const auth = new AuthManager([], {
      allowedDiscordIds: new Set(["user1", "user2"]),
      allowedDiscordRoles: new Set(["admin"]),
    });
    
    const status = auth.getDiscordAuthStatus();
    expect(status.allowedUserCount).toBe(2);
    expect(status.allowedRoleCount).toBe(1);
    expect(status.hasAnyRestrictions).toBe(true);
  });

  it("should indicate no restrictions when empty", () => {
    const auth = new AuthManager([], {
      allowedUserIds: new Set(),
      allowedRoleIds: new Set(),
    });
    
    const status = auth.getDiscordAuthStatus();
    expect(status.hasAnyRestrictions).toBe(false);
  });
});
