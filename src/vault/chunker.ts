import { chunkIdFor } from './hash.js';
import type { VaultChunk } from './vault.interface.js';

const TOKENS_PER_CHUNK = 400;
const CHARS_PER_TOKEN = 4;
const MAX_CHARS = TOKENS_PER_CHUNK * CHARS_PER_TOKEN;

function countTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function chunkMarkdown(path: string, content: string): VaultChunk[] {
  const lines = content.split(/\r?\n/);
  const sections: Array<{ start: number; body: string[] }> = [];
  let current: { start: number; body: string[] } = { start: 1, body: [] };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (/^##\s+/.test(line) && current.body.length) {
      sections.push(current);
      current = { start: i + 1, body: [line] };
    } else {
      current.body.push(line);
    }
  }
  if (current.body.length) sections.push(current);
  return sections.flatMap((s) => splitIfOversized(path, s.body.join('\n'), s.start));
}

function splitIfOversized(path: string, body: string, startLine: number): VaultChunk[] {
  // Normalize CRLF→LF once so chunk content is always LF — consistent across paths and platforms.
  const normalized = body.includes('\r') ? body.replace(/\r\n?/g, '\n') : body;
  if (normalized.length <= MAX_CHARS) {
    const endLine = startLine + normalized.split('\n').length - 1;
    return [makeChunk(path, startLine, endLine, normalized)];
  }
  const out: VaultChunk[] = [];
  const lines = normalized.split('\n');
  let buf: string[] = [];
  let bufChars = 0;
  let bufStart = startLine;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.length > MAX_CHARS) {
      if (buf.length > 0) {
        out.push(makeChunk(path, bufStart, bufStart + buf.length - 1, buf.join('\n')));
        buf = [];
        bufChars = 0;
      }
      for (let off = 0; off < line.length; off += MAX_CHARS) {
        const slice = line.slice(off, off + MAX_CHARS);
        out.push(makeChunk(path, startLine + i, startLine + i, slice));
      }
      bufStart = startLine + i + 1;
      continue;
    }
    if (bufChars + line.length + 1 > MAX_CHARS && buf.length > 0) {
      out.push(makeChunk(path, bufStart, bufStart + buf.length - 1, buf.join('\n')));
      buf = [];
      bufChars = 0;
      bufStart = startLine + i;
    }
    buf.push(line);
    bufChars += line.length + 1;
  }
  if (buf.length > 0) out.push(makeChunk(path, bufStart, bufStart + buf.length - 1, buf.join('\n')));
  return out;
}

function makeChunk(path: string, startLine: number, endLine: number, body: string): VaultChunk {
  return {
    chunkId: chunkIdFor(path, startLine, body),
    path, startLine, endLine,
    content: body, tokenCount: countTokens(body),
  };
}

export function chunkFile(input: { path: string; content: string; lang: string }): VaultChunk[] {
  if (input.lang === 'markdown') return chunkMarkdown(input.path, input.content);
  return splitIfOversized(input.path, input.content, 1);
}
