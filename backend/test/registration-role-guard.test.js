const test = require('node:test');
const assert = require('node:assert/strict');

// Isolated per-process store; must be required before the server module.
const { restoreStore } = require('./helpers/isolated-store');
const { app } = require('../src/server');

async function withServer(run) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

function registerPayload(email, role) {
  return {
    role,
    email,
    password: 'SelfServe123!',
    firstName: 'Self',
    lastName: 'Serve'
  };
}

// Verified clinical roles are minted only by staff approval of a verification
// application, so the self-service registration door must refuse them.
test('self-service registration refuses privileged clinical roles', async () => {
  try {
    await withServer(async (base) => {
      for (const role of ['doctor', 'pharmacist']) {
        const email = `self.${role}.${Date.now()}@medrec.demo`;
        const blocked = await postJson(`${base}/api/auth/register`, registerPayload(email, role));
        assert.equal(blocked.status, 403, `${role} self-registration must be refused`);
        const blockedBody = await blocked.json();
        assert.match(blockedBody.error, /staff approve|verification/i);

        // A refused registration must not leave a usable account behind.
        const login = await postJson(`${base}/api/auth/login`, { email, password: 'SelfServe123!' });
        assert.equal(login.status, 401, `${role} account must not exist after a refused registration`);
      }

      const adminEmail = `self.admin.${Date.now()}@medrec.demo`;
      const admin = await postJson(`${base}/api/auth/register`, registerPayload(adminEmail, 'admin'));
      assert.equal(admin.status, 403);
      assert.match((await admin.json()).error, /cannot be self-registered/i);
    });
  } finally {
    restoreStore();
  }
});

test('self-service registration still creates patient accounts', async () => {
  try {
    await withServer(async (base) => {
      const email = `self.patient.${Date.now()}@medrec.demo`;
      const created = await postJson(`${base}/api/auth/register`, registerPayload(email, 'patient'));
      assert.equal(created.status, 201);
      const body = await created.json();
      assert.equal(body.user.role, 'patient');
      assert.ok(body.accessToken, 'patient self sign-up issues an access token');
      assert.ok(body.refreshToken, 'patient self sign-up issues a refresh token');

      const login = await postJson(`${base}/api/auth/login`, { email, password: 'SelfServe123!' });
      assert.equal(login.status, 200);
      assert.equal((await login.json()).user.role, 'patient');
    });
  } finally {
    restoreStore();
  }
});
