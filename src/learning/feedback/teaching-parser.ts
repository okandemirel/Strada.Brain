/**
 * Teaching Parser
 *
 * Detects explicit teaching intent in user messages and extracts
 * the content and optional scope hint.
 */

export interface TeachingResult {
  content: string;
  scope?: 'user' | 'project' | 'global';
}

// Teaching trigger keywords (EN + TR) followed by colon or "that"
const TEACHING_PATTERNS_EN = ['remember', 'learn', 'note', 'memorize'];
const TEACHING_PATTERNS_TR = ['hatirla', 'ogren', 'not et', 'unutma'];

const ALL_PATTERNS = [...TEACHING_PATTERNS_EN, ...TEACHING_PATTERNS_TR];

// Build a single regex: ^(keyword)(:\s*|\s+that\s+)(.+)
const TEACHING_REGEX = new RegExp(
  `^(?:${ALL_PATTERNS.map(p => p.replace(/\s+/g, '\\s+')).join('|')})(?::\\s*|\\s+that\\s+)(.+)`,
  'is',
);

// Detection regex (just checks if the text starts with a teaching keyword followed by colon or "that")
const DETECTION_REGEX = new RegExp(
  `^(?:${ALL_PATTERNS.map(p => p.replace(/\s+/g, '\\s+')).join('|')})(?:\\s*:|\\s+that\\s)`,
  'i',
);

export class TeachingParser {
  /**
   * Returns true if the text matches a teaching intent pattern.
   */
  static isTeachingIntent(text: string): boolean {
    if (!text) return false;
    return DETECTION_REGEX.test(text.trim());
  }

  /**
   * Parses teaching text and extracts the content and optional scope hint.
   */
  static parse(text: string): TeachingResult {
    const trimmed = text.trim();
    const match = TEACHING_REGEX.exec(trimmed);

    const content = match?.[1]?.trim() ?? trimmed;
    const scope = TeachingParser.detectScope(content);

    return { content, scope };
  }

  private static detectScope(content: string): 'user' | 'project' | 'global' | undefined {
    const lower = content.toLowerCase();
    if (/\bi prefer\b/.test(lower) || /\bmy /.test(lower)) return 'user';
    if (/\bin this project\b/.test(lower) || /\bthis repo\b/.test(lower)) return 'project';
    return undefined;
  }
}
