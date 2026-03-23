// ---------------------------------------------------------------------------
// Zero-dependency YAML frontmatter parser for SKILL.md files.
//
// Supports a restricted YAML subset:
//   - Top-level key: value (string values)
//   - JSON-style arrays: ["a", "b"]
//   - 1-level nested objects via 2-space indentation
//   - Double-quoted strings for values containing colons
//   - No multiline values, YAML anchors, or flow mappings
// ---------------------------------------------------------------------------

export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  content: string;
}

const FENCE = "---";

/**
 * Parse YAML frontmatter from a raw SKILL.md string.
 *
 * Returns `{ data, content }` where `data` is the parsed frontmatter object
 * and `content` is everything after the closing `---` fence.
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const lines = raw.split("\n");

  // First line must be exactly "---"
  if (lines[0]?.trim() !== FENCE) {
    return { data: {}, content: raw };
  }

  // Find closing fence
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === FENCE) {
      closeIdx = i;
      break;
    }
  }

  if (closeIdx === -1) {
    return { data: {}, content: raw };
  }

  const yamlLines = lines.slice(1, closeIdx);
  const data = parseYamlSubset(yamlLines);

  // Content is everything after the closing fence (skip the fence line itself).
  // Join remaining lines; preserve a leading newline only if there is content.
  const remaining = lines.slice(closeIdx + 1);
  const content = remaining.join("\n");

  return { data, content };
}

// ---------------------------------------------------------------------------
// Restricted YAML parser
// ---------------------------------------------------------------------------

function parseYamlSubset(
  lines: string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Skip blank lines
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Top-level key (no leading whitespace)
    const topMatch = line.match(/^(\w[\w-]*):\s*(.*)/);
    if (!topMatch) {
      i++;
      continue;
    }

    const key = topMatch[1]!;
    const valuePart = topMatch[2]!.trim();

    if (valuePart === "") {
      // Nested object — collect indented lines
      const nested: Record<string, unknown> = {};
      i++;
      while (i < lines.length) {
        const child = lines[i]!;
        // Must start with 2+ spaces
        if (!/^ {2}\w/.test(child)) break;
        const childMatch = child.match(/^\s+(\w[\w-]*):\s*(.*)/);
        if (!childMatch) break;
        nested[childMatch[1]!] = parseValue(childMatch[2]!.trim());
        i++;
      }
      result[key] = nested;
    } else {
      result[key] = parseValue(valuePart);
      i++;
    }
  }

  return result;
}

/**
 * Parse a single scalar or JSON-style array value.
 */
function parseValue(raw: string): unknown {
  const trimmed = raw.trim();

  // JSON-style array: ["a", "b"]
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return parseJsonArray(trimmed);
  }

  // Double-quoted string
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }

  // Boolean
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;

  // Number
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  // Plain string
  return trimmed;
}

/**
 * Parse a JSON-style array literal. We handle both `["a", "b"]` and
 * bare-word entries like `[a, b]`.
 */
function parseJsonArray(raw: string): string[] {
  const inner = raw.slice(1, -1).trim();
  if (inner === "") return [];

  return inner.split(",").map((item) => {
    const t = item.trim();
    // Strip surrounding quotes
    if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
      return t.slice(1, -1);
    }
    return t;
  });
}
