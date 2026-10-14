/**
 * WHICH FRAMEWORK CONSTRUCT A ROW IS IMPLEMENTED WITH, read from the check the
 * system itself wrote.
 *
 * The north star's fourth rung asks that every requirement row map to a
 * framework construct. Measured 2026-10-14: no row had ever named one, because
 * nothing recorded it — and the two cheap ways to record it are both claims (a
 * planner saying "R3 uses EntityView", a worker saying so in prose), which is
 * the class of statement every other gate here exists to refuse.
 *
 * An acceptance check is evidence instead: its body is code the system wrote,
 * it runs against the built game, and it may not use reflection (the harness
 * rejects `typeof`, `GetType()`, `GetInterfaces` — the shape of code is not
 * the behaviour of the game). So what a check NAMES is what the row's
 * behaviour actually went through:
 *
 *   - a `global::Strada.Core.…` or `global::Strada.Modules.…` type the body
 *     names: that construct, by its own full name;
 *   - a type resolved through the harness's `Service<T>()`: the game's own
 *     type, reached through the framework's registration — recorded as
 *     `Strada.Core.DI:<type>`, because the construct is the registration, not
 *     the type.
 *
 * A check that names neither leaves the row with no construct, and the rung
 * says so. Nothing is inferred from a milestone's files or from prose.
 */

/**
 * A framework path the body spells from the root. The path is kept AS WRITTEN,
 * a member access included (`…ScreenStack.Current`): telling a type from its
 * member needs a compiler, and for this rung what matters is that the row's
 * check went through the framework at all — guessing where the type ends
 * would be a cleverness that could only be wrong.
 */
const FRAMEWORK_TYPE_RE = /global::((?:Strada\.Core|Strada\.Modules)(?:\.[A-Za-z_][A-Za-z0-9_]*)+)/gu;

/**
 * `Service<global::Game.Modules.X.IY>()` — the harness's own resolver, so the
 * type inside it is reached through the framework's DI. The generic argument is
 * read as written; a nested generic (`Service<global::A.B<global::C.D>>()`) is
 * taken up to its first `<`, which is the registered type.
 */
const RESOLVED_SERVICE_RE = /\bService\s*<\s*global::([A-Za-z_][A-Za-z0-9_.]*)/gu;

/** How a resolved service is written: the construct is the registration. */
export const DI_PREFIX = "Strada.Core.DI:";

/**
 * The framework constructs an acceptance check's parts name, sorted and
 * without repeats. The parts are joined as written — a construct named in
 * `setup` counts exactly as one named in `body`.
 */
export function constructsNamedBy(parts: {
  readonly setup?: string;
  readonly act?: string;
  readonly observe?: string;
  readonly body?: string;
}): string[] {
  const text = [parts.setup, parts.act, parts.observe, parts.body].filter((p) => p !== undefined).join("\n");
  if (text === "") return [];
  const found = new Set<string>();
  for (const m of text.matchAll(FRAMEWORK_TYPE_RE)) found.add(m[1]!);
  for (const m of text.matchAll(RESOLVED_SERVICE_RE)) found.add(`${DI_PREFIX}${m[1]!}`);
  return [...found].sort();
}
