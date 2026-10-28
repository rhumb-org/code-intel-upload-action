/**
 * timeouts.mjs -- the bounds that keep a hung network call or a wedged
 * indexer from stalling the caller's job until the runner's own job limit.
 * Every one surfaces as an ordinary thrown error, so it takes the same
 * fail-soft path as any other failure of that pipeline.
 */

/** Small JSON calls: OIDC mint, door API, npm registry metadata. */
export const API_TIMEOUT_MS = 30_000;

/** Bulk transfers: npm tarball, rust-analyzer release asset, index PUT. */
export const TRANSFER_TIMEOUT_MS = 10 * 60_000;

/** `npm install` / `dotnet tool install` of an already-downloaded, already-verified package. */
export const NPM_INSTALL_TIMEOUT_MS = 5 * 60_000;

/** One indexer run (or, for a language that restores first, one restore) over
 *  one root. Generous: a large repository legitimately takes tens of minutes,
 *  but not unbounded. */
export const INDEXER_TIMEOUT_MS = 60 * 60_000;
