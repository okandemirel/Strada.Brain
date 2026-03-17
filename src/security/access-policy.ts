export type EmptyAllowlistMode = "open" | "closed";

type Allowlist<T> = readonly T[] | ReadonlySet<T>;

function toReadonlySet<T>(allowlist: Allowlist<T>): ReadonlySet<T> {
  return allowlist instanceof Set ? allowlist : new Set(allowlist);
}

export function isAllowedBySingleIdPolicy<T>(
  subjectId: T,
  allowlist: Allowlist<T>,
  emptyAllowlistMode: EmptyAllowlistMode,
): boolean {
  const allowedIds = toReadonlySet(allowlist);
  if (allowedIds.size === 0) {
    return emptyAllowlistMode === "open";
  }
  return allowedIds.has(subjectId);
}

export function isAllowedByDualAllowlistPolicy<TPrimary, TSecondary>(options: {
  primaryId: TPrimary | null | undefined;
  primaryAllowlist: Allowlist<TPrimary>;
  secondaryId: TSecondary | null | undefined;
  secondaryAllowlist: Allowlist<TSecondary>;
  emptyAllowlistMode: EmptyAllowlistMode;
}): boolean {
  const primaryAllowlist = toReadonlySet(options.primaryAllowlist);
  const secondaryAllowlist = toReadonlySet(options.secondaryAllowlist);

  if (primaryAllowlist.size === 0 && secondaryAllowlist.size === 0) {
    return options.emptyAllowlistMode === "open";
  }

  const primaryAllowed =
    primaryAllowlist.size === 0
      ? true
      : options.primaryId !== null &&
          options.primaryId !== undefined &&
          primaryAllowlist.has(options.primaryId);

  const secondaryAllowed =
    secondaryAllowlist.size === 0
      ? true
      : options.secondaryId !== null &&
          options.secondaryId !== undefined &&
          secondaryAllowlist.has(options.secondaryId);

  return primaryAllowed && secondaryAllowed;
}

export function isAllowedByAnyOfPolicy<TSubject, TAttribute>(options: {
  subjectId: TSubject;
  subjectAllowlist: Allowlist<TSubject>;
  attributes: readonly TAttribute[];
  attributeAllowlist: Allowlist<TAttribute>;
  emptyAllowlistMode: EmptyAllowlistMode;
}): boolean {
  const subjectAllowlist = toReadonlySet(options.subjectAllowlist);
  const attributeAllowlist = toReadonlySet(options.attributeAllowlist);

  if (subjectAllowlist.size === 0 && attributeAllowlist.size === 0) {
    return options.emptyAllowlistMode === "open";
  }

  if (subjectAllowlist.has(options.subjectId)) {
    return true;
  }

  return options.attributes.some((attribute) => attributeAllowlist.has(attribute));
}
