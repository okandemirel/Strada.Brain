/**
 * Wire contract shared by the web channel (server) and the web portal
 * (client, which imports this file directly). Keep it browser-safe: no Node
 * imports, constants and pure functions only. Each value here used to be an
 * assumption each side encoded on its own, and the two drifted apart.
 */

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
