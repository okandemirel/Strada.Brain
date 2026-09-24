/**
 * Wire contract shared by the web channel (server) and the web portal
 * (client, which imports this file directly). Keep it browser-safe: no Node
 * imports, constants and pure functions only. Each value here used to be an
 * assumption each side encoded on its own, and the two drifted apart.
 */

/**
 * Path the portal opens its chat socket on. The server accepts the upgrade on
 * any path, but `vite dev` proxies only this one to the daemon: the portal used
 * to connect to `/`, so chat never connected under `vite dev` (WEB-14).
 */
export const WS_CHAT_PATH = "/ws";

/**
 * Close code for a socket whose chat was reclaimed by another socket holding
 * the same reconnect token (another tab of the same browser profile). The
 * portal must NOT auto-reconnect on it: two tabs that both did would take the
 * chat from each other forever. It offers "use it here" instead.
 */
export const WS_CLOSE_SESSION_TAKEN = 4001;
export const WS_CLOSE_SESSION_TAKEN_REASON = "session_taken";

/** Close code the server uses for a rate-limited (policy-violating) socket. */
export const WS_CLOSE_POLICY_VIOLATION = 1008;

const MIB = 1024 * 1024;

/**
 * Largest frame the server accepts (the `ws` server's `maxPayload`). A bigger
 * frame is not refused politely: the socket is closed with 1009.
 */
export const WS_MAX_PAYLOAD_BYTES = 25 * MIB;

/** Room kept in a chat frame for the text, the file names and the JSON around them. */
const CHAT_FRAME_RESERVE_BYTES = 1 * MIB;

/**
 * Raw bytes all attachments of one message may add up to. They travel base64
 * encoded (4 bytes per 3) inside ONE frame, so this, not the per-type caps
 * below, is what bounds a large photo or video (18 MiB).
 */
export const MAX_ATTACHMENT_BYTES_PER_MESSAGE =
  Math.floor((WS_MAX_PAYLOAD_BYTES - CHAT_FRAME_RESERVE_BYTES) / 4) * 3;

export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

/**
 * The per-type caps of the server's media gate (src/utils/media-processor.ts
 * MAX_*_SIZE; a web channel test keeps the two equal).
 */
export const MEDIA_SIZE_LIMITS = {
  image: 20 * MIB,
  video: 50 * MIB,
  audio: 25 * MIB,
  document: 10 * MIB,
} as const;

/** The largest single attachment of this MIME type the web chat can deliver. */
export function maxAttachmentBytes(mimeType: string): number {
  const cap = mimeType.startsWith("image/") ? MEDIA_SIZE_LIMITS.image
    : mimeType.startsWith("video/") ? MEDIA_SIZE_LIMITS.video
    : mimeType.startsWith("audio/") ? MEDIA_SIZE_LIMITS.audio
    : MEDIA_SIZE_LIMITS.document;
  return Math.min(cap, MAX_ATTACHMENT_BYTES_PER_MESSAGE);
}

/**
 * A `stream_update` frame carries EITHER `delta` (append to what the client
 * shows) OR `text` (replace it). Streams are not always append-only: a live
 * status line is replaced by a new summary each time, and after a reconnect
 * the server no longer knows what the client already has. Treating every
 * update as a delta glued the tail of the new summary onto the old one.
 */
export type StreamUpdatePayload = { delta: string } | { text: string };

/**
 * What the server sends for `accumulated`, given the text the client already
 * has for the stream (`undefined` when unknown). `null` means nothing changed.
 */
export function nextStreamUpdate(sent: string | undefined, accumulated: string): StreamUpdatePayload | null {
  if (sent !== undefined && accumulated.startsWith(sent)) {
    const delta = accumulated.slice(sent.length);
    return delta.length > 0 ? { delta } : null;
  }
  return { text: accumulated };
}

/** A monitor board's topology, as `monitor:dag_init` / `monitor:dag_restructure` carry it. */
export interface DagTopology<N extends { id: string } = { id: string }> {
  nodes: N[];
  edges: Array<{ source: string; target: string }>;
}

/**
 * `monitor:dag_init` ADDS to a root's board: the server sends a single new
 * card (a joined worker, a continued episode) or the full step list under the
 * same root, never a shrunken board meant to drop nodes; only
 * `monitor:dag_restructure` replaces a board. Nodes are matched by id (the
 * newer fields win) and edges are deduplicated.
 */
export function mergeDagTopology<N extends { id: string }>(prev: DagTopology<N>, next: DagTopology<N>): DagTopology<N> {
  const nodes = prev.nodes.slice();
  const indexById = new Map(nodes.map((node, index) => [node.id, index] as const));
  for (const node of next.nodes) {
    const at = indexById.get(node.id);
    if (at === undefined) {
      indexById.set(node.id, nodes.length);
      nodes.push(node);
    } else {
      nodes[at] = { ...nodes[at]!, ...node };
    }
  }
  const edgeKey = (edge: { source: string; target: string }) => `${edge.source}\u0000${edge.target}`;
  const seen = new Set(prev.edges.map(edgeKey));
  const edges = prev.edges.slice();
  for (const edge of next.edges) {
    if (seen.has(edgeKey(edge))) continue;
    seen.add(edgeKey(edge));
    edges.push(edge);
  }
  return { nodes, edges };
}

/** The text a client shows after applying a `stream_update` frame to `current`. */
export function applyStreamUpdate(current: string, frame: { delta?: unknown; text?: unknown }): string {
  if (typeof frame.text === "string") return frame.text;
  return typeof frame.delta === "string" ? current + frame.delta : current;
}
