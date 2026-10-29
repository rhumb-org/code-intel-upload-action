/**
 * verify.mjs -- the opt-in `verify-timeout` step. A completed upload is only
 * "uploaded": the worker verifies and ingests it afterwards and may reject it
 * (digest mismatch, ingest caps, unreachable commit, shard publish), which the
 * step has already exited past. With a budget above zero, run.mjs hands the
 * uploads that were left in `uploaded` to `verifyUploads`, which polls each
 * one's status through the door until it is terminal or the budget is spent.
 *
 * Polling runs the runner for up to the budget, so it is off by default.
 * Nothing here throws: a status call that fails is retried on the next tick,
 * and an upload still unresolved at the end is reported as pending, not as a
 * failure.
 */

/** The first minute polls every 15 s; after that every 30 s. */
const FAST_POLL_SECONDS = 15;
const SLOW_POLL_SECONDS = 30;
const FAST_POLL_WINDOW_SECONDS = 60;

/** Terminal statuses that mean the index is, or will be, served. */
const SERVED = new Set(['published', 'superseded_by_worker', 'superseded_by_upload', 'duplicate_artifact']);
/** Terminal statuses that mean the index will never serve. */
const NOT_SERVED = new Set(['rejected', 'expired', 'failed_in_ci']);

const MAX_REASON_CHARS = 200;

/**
 * `verify-timeout` is whole seconds. Empty and "0" mean off; so does anything
 * that is not a non-negative number, with `invalid` set so the caller can say
 * so instead of silently ignoring a typo.
 */
export function parseVerifyTimeout(raw) {
  const text = String(raw ?? '').trim();
  if (text === '' || text === '0') return { seconds: 0, invalid: false };
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return { seconds: 0, invalid: true };
  return { seconds: Math.floor(value), invalid: false };
}

function pollIntervalSeconds(elapsedSeconds) {
  return elapsedSeconds < FAST_POLL_WINDOW_SECONDS ? FAST_POLL_SECONDS : SLOW_POLL_SECONDS;
}

function clip(text) {
  return text.length > MAX_REASON_CHARS ? `${text.slice(0, MAX_REASON_CHARS)}...` : text;
}

function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}

/** One status read. Returns `{ status, rejectionReason }` or `{ error }`. */
async function readStatus(door, uploadId) {
  try {
    const resp = await door.statusUpload(uploadId);
    if (resp.status !== 200 || typeof resp.body?.status !== 'string') {
      return { error: `HTTP ${resp.status}` };
    }
    // `rejection_reason` is optional on the wire; the status stands in without it.
    const reason = typeof resp.body.rejection_reason === 'string' && resp.body.rejection_reason.length > 0 ? clip(resp.body.rejection_reason) : undefined;
    return { status: resp.body.status, rejectionReason: reason };
  } catch (err) {
    return { error: clip(messageOf(err)) };
  }
}

function resolvedLine(label, observed) {
  if (SERVED.has(observed.status)) {
    return observed.status === 'published' ? `OK      ${label}: verified, published` : `OK      ${label}: already served (${observed.status})`;
  }
  return `FAILED  ${label}: verify rejected (${observed.rejectionReason ?? observed.status})`;
}

/**
 * Polls `targets` (`[{ label, uploadId }]`) together until each is terminal or
 * `timeoutSeconds` is spent. `sleep(ms)` and `now()` are injectable.
 * Returns `{ lines, statuses, failed }`: the report lines, the
 * `verify-statuses` entries by label, and whether any upload was not served.
 */
export async function verifyUploads({
  door,
  targets,
  timeoutSeconds,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  log = console.log,
}) {
  const lines = [];
  const statuses = {};
  let failed = false;
  const last = new Map(targets.map((t) => [t.label, {}]));
  let pending = [...targets];

  const startedAt = now();
  const elapsedSeconds = () => (now() - startedAt) / 1000;

  while (pending.length > 0 && elapsedSeconds() < timeoutSeconds) {
    const elapsed = elapsedSeconds();
    await sleep(Math.min(pollIntervalSeconds(elapsed), timeoutSeconds - elapsed) * 1000);

    const stillPending = [];
    for (const target of pending) {
      const read = await readStatus(door, target.uploadId);
      const observed = last.get(target.label);
      if (read.error !== undefined) {
        observed.error = read.error;
      } else {
        observed.status = read.status;
        observed.rejectionReason = read.rejectionReason;
        delete observed.error;
      }

      if (SERVED.has(observed.status) || NOT_SERVED.has(observed.status)) {
        const line = resolvedLine(target.label, observed);
        if (NOT_SERVED.has(observed.status)) failed = true;
        lines.push(line);
        log(line);
        statuses[target.label] = entry(observed);
      } else {
        stillPending.push(target);
      }
    }
    pending = stillPending;
  }

  for (const target of pending) {
    const observed = last.get(target.label);
    const detail = observed.status !== undefined ? ` (last status: ${observed.status})` : observed.error !== undefined ? ` (status unavailable: ${observed.error})` : '';
    const line = `PENDING ${target.label}: still verifying after ${timeoutSeconds} s${detail}`;
    lines.push(line);
    log(line);
    statuses[target.label] = entry(observed);
  }

  return { lines, statuses, failed };
}

function entry(observed) {
  const out = { status: observed.status ?? 'unknown' };
  if (observed.rejectionReason !== undefined) out.rejection_reason = observed.rejectionReason;
  return out;
}
