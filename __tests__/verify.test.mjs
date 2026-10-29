import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerifyTimeout, verifyUploads } from '../scripts/verify.mjs';
import { UploadDoorClient } from '../scripts/door-client.mjs';

/** A door whose status answers come from per-upload scripted sequences (the last one repeats). */
function fakeDoor(sequences) {
  const calls = [];
  const index = {};
  return {
    calls,
    async statusUpload(id) {
      calls.push(id);
      const seq = sequences[id];
      const i = Math.min(index[id] ?? 0, seq.length - 1);
      index[id] = (index[id] ?? 0) + 1;
      const step = seq[i];
      if (step instanceof Error) throw step;
      return step;
    },
  };
}

const ok = (status, extra = {}) => ({ status: 200, body: { id: 'x', status, ...extra } });

/** A clock that only moves when the poll loop sleeps. */
function fakeClock() {
  let t = 1_000_000;
  const sleeps = [];
  return {
    sleeps,
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms / 1000);
      t += ms;
    },
  };
}

test('parseVerifyTimeout: empty and "0" are off, numbers are whole seconds, anything else is off and flagged', () => {
  assert.deepEqual(parseVerifyTimeout('0'), { seconds: 0, invalid: false });
  assert.deepEqual(parseVerifyTimeout(''), { seconds: 0, invalid: false });
  assert.deepEqual(parseVerifyTimeout(undefined), { seconds: 0, invalid: false });
  assert.deepEqual(parseVerifyTimeout(' 120 '), { seconds: 120, invalid: false });
  assert.deepEqual(parseVerifyTimeout('90.7'), { seconds: 90, invalid: false });
  assert.deepEqual(parseVerifyTimeout('soon'), { seconds: 0, invalid: true });
  assert.deepEqual(parseVerifyTimeout('-5'), { seconds: 0, invalid: true });
  assert.deepEqual(parseVerifyTimeout('Infinity'), { seconds: 0, invalid: true });
});

test('uploaded -> verifying -> published polls every 15 s and reports OK', async () => {
  const door = fakeDoor({ up_1: [ok('uploaded'), ok('verifying'), ok('published')] });
  const clock = fakeClock();
  const logged = [];

  const out = await verifyUploads({
    door,
    targets: [{ label: 'typescript @ .', uploadId: 'up_1' }],
    timeoutSeconds: 300,
    sleep: clock.sleep,
    now: clock.now,
    log: (l) => logged.push(l),
  });

  assert.deepEqual(clock.sleeps, [15, 15, 15]);
  assert.equal(door.calls.length, 3);
  assert.equal(out.failed, false);
  assert.deepEqual(out.lines, ['OK      typescript @ .: verified, published']);
  assert.deepEqual(logged, out.lines);
  assert.deepEqual(out.statuses, { 'typescript @ .': { status: 'published' } });
});

test('the interval widens to 30 s after the first minute', async () => {
  const door = fakeDoor({ up_1: [ok('verifying')] });
  const clock = fakeClock();

  await verifyUploads({ door, targets: [{ label: 'a', uploadId: 'up_1' }], timeoutSeconds: 120, sleep: clock.sleep, now: clock.now, log: () => {} });

  assert.deepEqual(clock.sleeps, [15, 15, 15, 15, 30, 30]);
});

test('a rejection prints the rejection_reason class, marks failed, and stops polling that upload', async () => {
  const door = fakeDoor({
    up_1: [ok('verifying'), ok('rejected', { rejection_reason: 'sha256_mismatch' })],
    up_2: [ok('published')],
  });
  const clock = fakeClock();

  const out = await verifyUploads({
    door,
    targets: [
      { label: 'typescript @ .', uploadId: 'up_1' },
      { label: 'python @ svc', uploadId: 'up_2' },
    ],
    timeoutSeconds: 300,
    sleep: clock.sleep,
    now: clock.now,
    log: () => {},
  });

  assert.equal(out.failed, true);
  assert.deepEqual(out.lines, ['OK      python @ svc: verified, published', 'FAILED  typescript @ .: verify rejected (sha256_mismatch)']);
  assert.deepEqual(out.statuses['typescript @ .'], { status: 'rejected', rejection_reason: 'sha256_mismatch' });
  assert.equal(door.calls.filter((id) => id === 'up_2').length, 1, 'a resolved upload is not polled again');
});

test('without rejection_reason the status stands in; expired and failed_in_ci also fail', async () => {
  const door = fakeDoor({ a: [ok('rejected')], b: [ok('expired')], c: [ok('failed_in_ci')] });
  const clock = fakeClock();

  const out = await verifyUploads({
    door,
    targets: ['a', 'b', 'c'].map((id) => ({ label: `l_${id}`, uploadId: id })),
    timeoutSeconds: 60,
    sleep: clock.sleep,
    now: clock.now,
    log: () => {},
  });

  assert.equal(out.failed, true);
  assert.deepEqual(out.lines, [
    'FAILED  l_a: verify rejected (rejected)',
    'FAILED  l_b: verify rejected (expired)',
    'FAILED  l_c: verify rejected (failed_in_ci)',
  ]);
});

test('a superseded or duplicate upload is already served: OK, not failed', async () => {
  const door = fakeDoor({ a: [ok('superseded_by_worker')], b: [ok('superseded_by_upload')], c: [ok('duplicate_artifact')] });
  const clock = fakeClock();

  const out = await verifyUploads({
    door,
    targets: ['a', 'b', 'c'].map((id) => ({ label: `l_${id}`, uploadId: id })),
    timeoutSeconds: 60,
    sleep: clock.sleep,
    now: clock.now,
    log: () => {},
  });

  assert.equal(out.failed, false);
  assert.deepEqual(out.lines, [
    'OK      l_a: already served (superseded_by_worker)',
    'OK      l_b: already served (superseded_by_upload)',
    'OK      l_c: already served (duplicate_artifact)',
  ]);
});

test('budget spent: a still-verifying line, not a failure, and no sleep past the budget', async () => {
  const door = fakeDoor({ up_1: [ok('verifying')] });
  const clock = fakeClock();

  const out = await verifyUploads({ door, targets: [{ label: 'rust @ .', uploadId: 'up_1' }], timeoutSeconds: 40, sleep: clock.sleep, now: clock.now, log: () => {} });

  assert.deepEqual(clock.sleeps, [15, 15, 10]);
  assert.equal(out.failed, false);
  assert.deepEqual(out.lines, ['PENDING rust @ .: still verifying after 40 s (last status: verifying)']);
  assert.deepEqual(out.statuses, { 'rust @ .': { status: 'verifying' } });
});

test('a status call that errors is retried, and an unreadable status is reported as pending', async () => {
  const door = fakeDoor({ flaky: [new Error('fetch failed'), { status: 500, body: {} }, ok('published')], dead: [{ status: 500, body: {} }] });
  const clock = fakeClock();

  const out = await verifyUploads({
    door,
    targets: [
      { label: 'flaky', uploadId: 'flaky' },
      { label: 'dead', uploadId: 'dead' },
    ],
    timeoutSeconds: 60,
    sleep: clock.sleep,
    now: clock.now,
    log: () => {},
  });

  assert.equal(out.failed, false);
  assert.deepEqual(out.lines, ['OK      flaky: verified, published', 'PENDING dead: still verifying after 60 s (status unavailable: HTTP 500)']);
  assert.deepEqual(out.statuses.dead, { status: 'unknown' });
});

test('a 401 on a status poll re-mints the token once and the poll goes on', async () => {
  const seen = [];
  let polls = 0;
  const fetchImpl = async (url, opts) => {
    seen.push({ url, method: opts.method, auth: opts.headers.Authorization });
    polls += 1;
    const body = polls === 1 ? { error: 'oidc_expired' } : { id: 'up_1', status: 'published' };
    return { status: polls === 1 ? 401 : 200, text: async () => JSON.stringify(body) };
  };
  let mints = 0;
  const door = new UploadDoorClient({
    baseUrl: 'https://door.test',
    audience: 'aud',
    fetchImpl,
    mintOidcTokenImpl: async () => `jwt-${(mints += 1)}`,
  });
  const clock = fakeClock();

  const out = await verifyUploads({ door, targets: [{ label: 'go @ .', uploadId: 'up_1' }], timeoutSeconds: 60, sleep: clock.sleep, now: clock.now, log: () => {} });

  assert.equal(mints, 2);
  assert.deepEqual(
    seen.map((s) => [s.method, s.url, s.auth]),
    [
      ['GET', 'https://door.test/api/code-intel/v1/uploads/up_1', 'Bearer jwt-1'],
      ['GET', 'https://door.test/api/code-intel/v1/uploads/up_1', 'Bearer jwt-2'],
    ],
  );
  assert.deepEqual(out.lines, ['OK      go @ .: verified, published']);
});
