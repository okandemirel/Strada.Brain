import path from "node:path";

const UNIT_SUFFIX = /\.(service|slice|target|socket|mount|timer|path|scope|device|swap|automount)$/;

/**
 * `systemd-analyze verify <unit>` also loads the units the unit depends on and
 * reports on the host's own files (the CI image's xfs_scrub_all.service, a new
 * systemd's "Support for option CPUAccounting= has been removed"). Only the
 * complaints about our unit are ours to fail on.
 *
 * Every complaint starts `<file or unit name>:` (`/path/x.service:8: ...`,
 * `x.service: Command ... is not executable`). A line naming another file is
 * dropped; a line naming our file, or naming no file at all, is kept, so an
 * unattributed complaint can never hide a problem in our unit.
 */
export function complaintsAboutUnit(output: string, unitPath: string): string[] {
  const ownNames = new Set([unitPath, path.basename(unitPath)]);
  return output
    .split("\n")
    .filter(Boolean)
    .filter((line) => {
      const owner = /^([^\s:]+):/.exec(line)?.[1];
      // "Warning:" / "Error:" name no file: only a path or a unit name is an owner.
      const namesAFile = owner !== undefined && (owner.includes("/") || UNIT_SUFFIX.test(owner));
      return !namesAFile || ownNames.has(owner);
    })
    // The runner may not have Node at /usr/bin/node; that is the host, not the unit.
    .filter((line) => !/Command \/usr\/bin\/node is not executable/.test(line));
}
