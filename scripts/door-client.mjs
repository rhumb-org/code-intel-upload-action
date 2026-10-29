/**
 * door-client.mjs -- client for rhumb-code-intel's CI upload door
 * (`/api/code-intel/v1/uploads`). Every authenticated call carries a GitHub
 * Actions OIDC bearer. A 401 response is re-minted and retried exactly once:
 * a second consecutive 401 after a fresh mint means the door itself is
 * rejecting this identity (unregistered repo, wrong audience), not that the
 * token merely expired mid-run, so it is reported as a normal failure
 * rather than retried again.
 */

import { API_TIMEOUT_MS, TRANSFER_TIMEOUT_MS } from './timeouts.mjs';

export async function mintOidcToken(audience, fetchImpl = fetch) {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const reqToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (url === undefined || reqToken === undefined) {
    throw new Error('ACTIONS_ID_TOKEN_REQUEST_URL/_TOKEN unset -- the caller workflow needs `permissions: id-token: write`');
  }
  const resp = await fetchImpl(`${url}&audience=${encodeURIComponent(audience)}`, {
    headers: { Authorization: `Bearer ${reqToken}` },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(`OIDC token mint failed: ${resp.status} ${await resp.text()}`);
  }
  const body = await resp.json();
  if (typeof body.value !== 'string' || body.value.length === 0) {
    throw new Error('OIDC token mint response carried no value');
  }
  return body.value;
}

/**
 * The failure reason that is sent to the door's `/fail` route. An error from
 * a child process (`npm`, an indexer) carries its full command line and
 * stderr in its message -- runner paths and, for a compiler or indexer,
 * fragments of the tenant's own source. Those stay in the step summary on
 * the tenant's side; the door only needs the shape of the failure (exit
 * code, signal, timeout) to tell an out-of-memory kill from a bad config.
 */
export function describeFailureForDoor(err) {
  if (err !== null && typeof err === 'object' && typeof err.cmd === 'string') {
    const parts = [];
    if (err.code !== undefined && err.code !== null) parts.push(`exit code ${err.code}`);
    if (err.signal) parts.push(`signal ${err.signal}`);
    if (err.killed) parts.push('killed (timed out)');
    return `child process failed${parts.length > 0 ? ` (${parts.join(', ')})` : ''}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export class UploadDoorClient {
  #baseUrl;
  #audience;
  #fetchImpl;
  #mintOidcTokenImpl;
  #jwt;
  #remintedOnce = false;

  constructor({ baseUrl, audience, fetchImpl = fetch, mintOidcTokenImpl = mintOidcToken }) {
    this.#baseUrl = baseUrl.replace(/\/$/, '');
    this.#audience = audience;
    this.#fetchImpl = fetchImpl;
    this.#mintOidcTokenImpl = mintOidcTokenImpl;
  }

  async #ensureToken() {
    if (this.#jwt === undefined) this.#jwt = await this.#mintOidcTokenImpl(this.#audience, this.#fetchImpl);
    return this.#jwt;
  }

  async #send(method, url, jwt, body) {
    return this.#fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  }

  async #authedRequest(method, pathSuffix, body) {
    const url = `${this.#baseUrl}${pathSuffix}`;
    const jwt = await this.#ensureToken();
    let resp = await this.#send(method, url, jwt, body);

    if (resp.status === 401 && !this.#remintedOnce) {
      this.#remintedOnce = true;
      this.#jwt = await this.#mintOidcTokenImpl(this.#audience, this.#fetchImpl);
      resp = await this.#send(method, url, this.#jwt, body);
    }

    // The re-mint allowance is for consecutive 401s only: a token that expires
    // again minutes later (a long verify poll) is a fresh expiry, not a door
    // rejecting this identity.
    if (resp.status !== 401) this.#remintedOnce = false;

    const text = await resp.text();
    let parsed;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }
    return { status: resp.status, body: parsed };
  }

  async createUpload(lang, roots) {
    return this.#authedRequest('POST', '/api/code-intel/v1/uploads', { lang, roots });
  }

  async completeUpload(uploadId, payload) {
    return this.#authedRequest('POST', `/api/code-intel/v1/uploads/${uploadId}/complete`, payload);
  }

  async statusUpload(uploadId) {
    return this.#authedRequest('GET', `/api/code-intel/v1/uploads/${uploadId}`);
  }

  /** Best-effort: never throws -- a failure reporting a failure is not
   *  itself fatal to the action's fail-soft contract. */
  async failUpload(uploadId, reason) {
    try {
      return await this.#authedRequest('POST', `/api/code-intel/v1/uploads/${uploadId}/fail`, {
        reason: reason.slice(0, 500),
      });
    } catch (err) {
      return { status: 0, body: { error: err instanceof Error ? err.message : String(err) } };
    }
  }

  /** The presigned PUT itself is never bearer-authenticated (the URL IS
   *  the credential), so it never goes through `#authedRequest` and never
   *  triggers an OIDC re-mint. */
  async putIndex(putUrl, gzBuf) {
    const resp = await this.#fetchImpl(putUrl, {
      method: 'PUT',
      body: gzBuf,
      signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
    });
    return { status: resp.status, ok: resp.ok, text: resp.ok ? undefined : await resp.text() };
  }
}
