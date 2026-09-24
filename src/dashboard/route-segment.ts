/**
 * The one percent-decoder for dashboard route parameters (CHN-1).
 *
 * `decodeURIComponent` THROWS a URIError on an escape that does not decode (a
 * lone `%`, a truncated `%E0%A4`). The route handlers run synchronously inside
 * the HTTP server's request listener, so that throw left the listener as an
 * uncaughtException — which the daemon answers with a full shutdown. A route
 * parameter that does not decode is a client error: callers answer 400 when
 * this returns undefined.
 */
export function safeDecodeSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}
