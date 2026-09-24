/**
 * Path-glob matching for vault query filters (`pathGlob`).
 *
 * The vaults used to compile the glob into a RegExp. Each `*` became a
 * `[^/]*` run, so a glob with many stars (which the LLM or the dashboard
 * search route can supply) backtracked exponentially: measured 34 s for one
 * 63-character path, with the event loop blocked throughout (MEM-8). This
 * matcher walks the path once per glob token, O(path × glob), and the glob
 * length is capped.
 *
 * Syntax: `**` matches any run of characters including "/" (and `**` + "/"
 * also matches no directory at all, so "src/**" + "/*.ts" matches
 * "src/a.ts"), `*` any run without "/", `?` any one character. Everything
 * else is literal.
 */

export const MAX_PATH_GLOB_LENGTH = 256;

type GlobToken =
  | { kind: "literal"; char: string }
  | { kind: "any-char" }
  | { kind: "star" }
  | { kind: "globstar" }
  | { kind: "globstar-dir" };

function tokenize(glob: string): GlobToken[] {
  const tokens: GlobToken[] = [];
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        while (glob[i + 1] === "*") i++; // "***" is still one globstar
        if (glob[i + 1] === "/") {
          tokens.push({ kind: "globstar-dir" });
          i++;
        } else {
          tokens.push({ kind: "globstar" });
        }
      } else {
        tokens.push({ kind: "star" });
      }
    } else if (c === "?") {
      tokens.push({ kind: "any-char" });
    } else {
      tokens.push({ kind: "literal", char: c });
    }
  }
  return tokens;
}

/**
 * Compile `glob` into a predicate over "/"-separated paths.
 * @throws when the glob is longer than MAX_PATH_GLOB_LENGTH.
 */
export function compilePathGlob(glob: string): (path: string) => boolean {
  if (glob.length > MAX_PATH_GLOB_LENGTH) {
    throw new Error(`pathGlob is too long (${glob.length} characters, max ${MAX_PATH_GLOB_LENGTH})`);
  }
  const tokens = tokenize(glob);
  return (path: string) => matchTokens(tokens, path);
}

/** Set-of-positions simulation: reach[i] = the tokens so far can consume path[0, i). */
function matchTokens(tokens: GlobToken[], path: string): boolean {
  const n = path.length;
  let reach = new Uint8Array(n + 1);
  reach[0] = 1;
  for (const token of tokens) {
    const next = new Uint8Array(n + 1);
    let any = false;
    switch (token.kind) {
      case "literal":
        for (let i = 0; i < n; i++) if (reach[i] && path[i] === token.char) next[i + 1] = 1;
        break;
      case "any-char":
        for (let i = 0; i < n; i++) if (reach[i]) next[i + 1] = 1;
        break;
      case "star": {
        let running = false;
        for (let i = 0; i <= n; i++) {
          if (i > 0 && path[i - 1] === "/") running = false;
          if (reach[i]) running = true;
          if (running) next[i] = 1;
        }
        break;
      }
      case "globstar": {
        let running = false;
        for (let i = 0; i <= n; i++) {
          if (reach[i]) running = true;
          if (running) next[i] = 1;
        }
        break;
      }
      case "globstar-dir": {
        // Zero directories, or any run that ends with "/".
        let seen = false;
        for (let i = 0; i <= n; i++) {
          if (reach[i] || (seen && i > 0 && path[i - 1] === "/")) next[i] = 1;
          if (reach[i]) seen = true;
        }
        break;
      }
    }
    for (let i = 0; i <= n; i++) if (next[i]) { any = true; break; }
    if (!any) return false;
    reach = next;
  }
  return reach[n] === 1;
}
