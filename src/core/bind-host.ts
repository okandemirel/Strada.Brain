/**
 * The address the HTTP listeners bind to (14F2 / D71).
 *
 * BIND_HOST is a setting, and config's schema validates it, so its schema and
 * resolver are declared in config, the foundation layer. This file re-exports
 * them so the listeners and their tests keep their path.
 */

export { DEFAULT_BIND_HOST, bindHostSchema, resolveBindHost } from "../config/bind-host.js";
