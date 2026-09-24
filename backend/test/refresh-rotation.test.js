const test = require('node:test');
const assert = require('node:assert/strict');

// Isolated per-process store; must be required before the server module.
const { restoreStore } = require('./helpers/isolated-store');
const { app } = require('../src/server');

async function withServer(run) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    return await run('http://127.0.0.1:' + port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function postJson(url, body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function registerPatient(base) {
  const email = 'rotation.' + Date.now() + '.' + Math.random().toString(36).slice(2, 8) + '@medrec.demo';
  const response = await postJson(base + '/api/auth/register', {
    role: 'patient',
    email,
    password: 'Rotate123!',
    firstName: 'Rot',
    lastName: 'Ate'
  });
  assert.equal(response.status, 201);
  return Object.assign({ email }, await response.json());
}

// A refresh token is single-use: refreshing retires the token that was
// presented and returns its replacement.
test('refresh rotates the token and retires the previous one', async () => {
  try {
    await withServer(async (base) => {
      const registered = await registerPatient(base);
      assert.ok(registered.refreshToken, 'registration issues a refresh token');

      const first = await postJson(base + '/api/auth/refresh', { refreshToken: registered.refreshToken });
      assert.equal(first.status, 200);
      const rotated = await first.json();
      assert.ok(rotated.accessToken, 'rotation returns a fresh access token');
      assert.ok(rotated.refreshToken, 'rotation returns a replacement refresh token');
      assert.notEqual(rotated.refreshToken, registered.refreshToken);

      const second = await postJson(base + '/api/auth/refresh', { refreshToken: rotated.refreshToken });
      assert.equal(second.status, 200, 'the replacement keeps working');
      assert.notEqual((await second.json()).refreshToken, rotated.refreshToken);
    });
  } finally {
    restoreStore();
  }
});

// Replaying a token that was already rotated means the value leaked, so the
// whole family must be revoked instead of only refusing the request.
test('replaying a retired refresh token revokes every session', async () => {
  try {
    await withServer(async (base) => {
      const registered = await registerPatient(base);
      const first = await postJson(base + '/api/auth/refresh', { refreshToken: registered.refreshToken });
      assert.equal(first.status, 200);
      const rotated = await first.json();

      const replay = await postJson(base + '/api/auth/refresh', { refreshToken: registered.refreshToken });
      assert.equal(replay.status, 401);
      assert.match((await replay.json()).error, /reuse/i, 'the reply reports reuse');

      const afterReuse = await postJson(base + '/api/auth/refresh', { refreshToken: rotated.refreshToken });
      assert.equal(afterReuse.status, 401, 'the replacement was revoked with the family');
    });
  } finally {
    restoreStore();
  }
});

test('unknown or missing refresh tokens are rejected', async () => {
  try {
    await withServer(async (base) => {
      const bogus = await postJson(base + '/api/auth/refresh', { refreshToken: 'not-a-real-token' });
      assert.equal(bogus.status, 401);

      const missing = await postJson(base + '/api/auth/refresh', {});
      assert.equal(missing.status, 400);
    });
  } finally {
    restoreStore();
  }
});

// Signing out of one device must invalidate only that device session.
test('single-session logout revokes only the presented refresh token', async () => {
  try {
    await withServer(async (base) => {
      const registered = await registerPatient(base);
      const second = await postJson(base + '/api/auth/login', { email: registered.email, password: 'Rotate123!' });
      assert.equal(second.status, 200);
      const session = await second.json();
      assert.ok(session.refreshToken, 'login issues its own refresh token');

      const logout = await postJson(base + '/api/auth/logout', { refreshToken: session.refreshToken }, session.accessToken);
      assert.equal(logout.status, 200);
      assert.equal((await logout.json()).revokedRefreshTokens, 1);

      const revoked = await postJson(base + '/api/auth/refresh', { refreshToken: session.refreshToken });
      assert.equal(revoked.status, 401, 'the signed-out session cannot refresh');

      const survivor = await postJson(base + '/api/auth/refresh', { refreshToken: registered.refreshToken });
      assert.equal(survivor.status, 200, 'the other session still refreshes');
    });
  } finally {
    restoreStore();
  }
});

test('logout requires an access token', async () => {
  try {
    await withServer(async (base) => {
      const anonymous = await postJson(base + '/api/auth/logout', { refreshToken: 'whatever' });
      assert.equal(anonymous.status, 401);
    });
  } finally {
    restoreStore();
  }
});
