import { describe, expect, it } from "vitest";
import { complaintsAboutUnit } from "./systemd-unit-contract.helpers.js";

const unitPath = "/work/repo/strada-brain.service";

// The three lines the runner image printed on 2026-11-11 (CI run 43029278746).
const hostNoise = [
  "/usr/lib/systemd/system/xfs_scrub_all.service:8: Support for option CPUAccounting= has been removed and it is ignored",
  "/usr/lib/systemd/system/system-xfs_scrub.slice:6: Support for option CPUAccounting= has been removed and it is ignored",
  "/usr/lib/systemd/system/walinuxagent.service:12: Support for option CPUAccounting= has been removed and it is ignored",
].join("\n");

describe("complaintsAboutUnit", () => {
  it("drops complaints about the host's own unit files", () => {
    expect(complaintsAboutUnit(hostNoise, unitPath)).toEqual([]);
  });

  it("keeps a complaint about our unit, by path or by name", () => {
    const ours = [
      `${unitPath}:14: Unknown key name 'Bogus' in section 'Service', ignoring.`,
      "strada-brain.service: Command /usr/bin/foo is not executable: No such file or directory",
    ];
    expect(complaintsAboutUnit(`${hostNoise}\n${ours.join("\n")}\n`, unitPath)).toEqual(ours);
  });

  it("keeps a complaint that names no file, so it cannot hide ours", () => {
    expect(complaintsAboutUnit("Failed to load something odd", unitPath)).toEqual(["Failed to load something odd"]);
  });

  it("does not treat another directory's strada-brain.service as ours", () => {
    expect(complaintsAboutUnit("/etc/systemd/system/strada-brain.service:3: Support for option X= has been removed", unitPath)).toEqual([]);
  });

  it("still ignores the missing /usr/bin/node of the host", () => {
    expect(complaintsAboutUnit("strada-brain.service: Command /usr/bin/node is not executable: No such file", unitPath)).toEqual([]);
  });
});
