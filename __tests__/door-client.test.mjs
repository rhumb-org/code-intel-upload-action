import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { UploadDoorClient, mintOidcToken, describeFailureForDoor } from '../scripts/door-client.mjs';

async function startFakeDoor(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
  });
}

function fakeMint(tokens) {
  let i = 0;
  return async () => tokens[Math.min(i++, tokens.length - 1)];
}

test('createUpload / completeUpload send the expected request sequence, auth header, and payloads', async () => {
  const seen = [];
  const { server, baseUrl } = await startFakeDoor(async (req, res) => {
    const body = await readBody(req);
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body.length ? JSON.parse(body) : undefined });
    res.writeHead(req.url === '/api/code-intel/v1/uploads' ? 201 : 200, { 'Content-Type': 'application/json' });
    res.end(
      req.url === '/api/code-intel/v1/uploads'
        ? JSON.stringify({ upload_id: 'up_1', put_url: 'https://example.test/put', max_bytes: 1000 })
        : JSON.stringify({ id: 'up_1', status: 'uploaded' }),
    );
  });

  const door = new UploadDoorClient({ baseUrl, audience: 'aud', fetchImpl: fetch, mintOidcTokenImpl: fakeMint(['jwt-1']) });
  const created = await door.createUpload('typescript', ['.']);
  assert.equal(created.status, 201);
  const completed = await door.completeUpload('up_1', { sha256: 'a'.repeat(64), raw_bytes: 10 });
  assert.equal(completed.status, 200);

  assert.deepEqual(
    seen.map((s) => ({ method: s.method, url: s.url })),
    [
      { method: 'POST', url: '/api/code-intel/v1/uploads' },
      { method: 'POST', url: '/api/code-intel/v1/uploads/up_1/complete' },
    ],
  );
  assert.equal(seen[0].auth, 'Bearer jwt-1');
  assert.deepEqual(seen[0].body, { lang: 'typescript', roots: ['.'] });
  assert.equal(seen[1].auth, 'Bearer jwt-1');

  server.close();
});

test('a 401 triggers exactly one OIDC re-mint and retry, which then succeeds', async () => {
  let calls = 0;
  const { server, baseUrl } = await startFakeDoor(async (req, res) => {
    await readBody(req);
    calls += 1;
    if (calls === 1) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'oidc_expired' }));
      return;
    }
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ upload_id: 'up_2', put_url: 'https://example.test/put', max_bytes: 1000 }));
  });

  let mintCalls = 0;
  const mint = fakeMint(['stale-jwt', 'fresh-jwt']);
  const door = new UploadDoorClient({
    baseUrl,
    audience: 'aud',
    fetchImpl: fetch,
    mintOidcTokenImpl: async (...args) => {
      mintCalls += 1;
      return mint(...args);
    },
  });

  const result = await door.createUpload('python', ['.']);

  assert.equal(result.status, 201);
  assert.equal(calls, 2);
  assert.equal(mintCalls, 2); // one initial mint, one re-mint after the 401

  server.close();
});

test('a second consecutive 401 after the re-mint is not retried again', async () => {
  const { server, baseUrl } = await startFakeDoor(async (req, res) => {
    await readBody(req);
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'oidc_expired' }));
  });

  const door = new UploadDoorClient({ baseUrl, audience: 'aud', fetchImpl: fetch, mintOidcTokenImpl: fakeMint(['jwt-a', 'jwt-b']) });
  const result = await door.createUpload('rust', ['.']);

  assert.equal(result.status, 401);

  server.close();
});

test('failUpload never throws even when the door is unreachable', async () => {
  const door = new UploadDoorClient({
    baseUrl: 'http://127.0.0.1:1',
    audience: 'aud',
    mintOidcTokenImpl: fakeMint(['jwt']),
  });
  const result = await door.failUpload('up_x', 'boom');
  assert.equal(result.status, 0);
});

test('every door request and the index PUT carry an abort signal', async () => {
  const signals = [];
  const fetchImpl = async (url, opts) => {
    signals.push(opts.signal);
    return { status: 201, ok: true, text: async () => '{}' };
  };
  const door = new UploadDoorClient({ baseUrl: 'https://door.test', audience: 'aud', fetchImpl, mintOidcTokenImpl: fakeMint(['jwt']) });

  await door.createUpload('rust', ['.']);
  await door.putIndex('https://store.test/put', Buffer.from('x'));

  assert.equal(signals.length, 2);
  for (const signal of signals) assert.ok(signal instanceof AbortSignal);
});

test('describeFailureForDoor keeps a child process failure to its exit shape, without command line or stderr', () => {
  const err = Object.assign(new Error('Command failed: /runner/tool index\nsrc/private.ts: error'), {
    cmd: '/runner/tool index',
    code: 134,
    signal: null,
    killed: false,
  });
  assert.equal(describeFailureForDoor(err), 'child process failed (exit code 134)');

  const timedOut = Object.assign(new Error('Command failed'), { cmd: 'tool', code: null, signal: 'SIGTERM', killed: true });
  assert.equal(describeFailureForDoor(timedOut), 'child process failed (signal SIGTERM, killed (timed out))');
});

test('describeFailureForDoor passes an ordinary error message through', () => {
  assert.equal(describeFailureForDoor(new Error('PUT to presigned URL failed: 500')), 'PUT to presigned URL failed: 500');
  assert.equal(describeFailureForDoor('plain'), 'plain');
});

test('mintOidcToken requires ACTIONS_ID_TOKEN_REQUEST_URL/_TOKEN', async () => {
  const savedUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const savedToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  try {
    await assert.rejects(() => mintOidcToken('aud'), /id-token: write/);
  } finally {
    if (savedUrl !== undefined) process.env.ACTIONS_ID_TOKEN_REQUEST_URL = savedUrl;
    if (savedToken !== undefined) process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = savedToken;
  }
});
