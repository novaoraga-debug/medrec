const test = require('node:test');
const assert = require('node:assert/strict');
const { OAuth2Client } = require('google-auth-library');

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

// Patch the OAuth2Client prototype so the server's verifyIdToken call resolves
// with a controlled mock payload without needing real Google tokens.
const originalVerifyIdToken = OAuth2Client.prototype.verifyIdToken;
function mockGooglePayload(payload) {
  OAuth2Client.prototype.verifyIdToken = async () => ({ getPayload: () => payload });
}
function restoreGoogleMock() {
  OAuth2Client.prototype.verifyIdToken = originalVerifyIdToken;
}

test('google sign-in rejects privileged roles before token verification', async () => {
  try {
    await withServer(async (base) => {
      const admin = await fetch(`${base}/api/auth/google`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idToken: 'anything', role: 'super_admin' })
      });
      assert.equal(admin.status, 403);

      const doctor = await fetch(`${base}/api/auth/google`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idToken: 'anything', role: 'doctor' })
      });
      assert.equal(doctor.status, 403);
      const doctorBody = await doctor.json();
      assert.match(doctorBody.error, /verification|doctor portal/i);
    });
  } finally {
    restoreStore();
  }
});

test('google sign-in requires an id token', async () => {
  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/api/auth/google`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'patient' })
      });
      assert.equal(response.status, 400);
    });
  } finally {
    restoreStore();
  }
});

test('providers endpoint reports whether google is configured', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/auth/providers`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(typeof body.google.enabled, 'boolean');
    assert.equal(body.password, true);
  });
});

test('google sign-up creates a patient and repeat sign-in logs them in', async () => {
  const email = `google.patient.${Date.now()}@example.com`;
  try {
    mockGooglePayload({
      email,
      email_verified: true,
      given_name: 'Google',
      family_name: 'Patient'
    });

    await withServer(async (base) => {
      const first = await fetch(`${base}/api/auth/google`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idToken: 'mock-token', role: 'patient' })
      });
      assert.equal(first.status, 201);
      const firstBody = await first.json();
      assert.equal(firstBody.user.role, 'patient');
      assert.equal(firstBody.isNewUser, true);
      assert.ok(firstBody.refreshToken, 'session includes a refresh token');
      assert.equal(firstBody.expiresInSeconds, 15 * 60);

      const second = await fetch(`${base}/api/auth/google`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idToken: 'mock-token', role: 'patient' })
      });
      assert.equal(second.status, 200);
      const secondBody = await second.json();
      assert.equal(secondBody.isNewUser, false);
      assert.equal(secondBody.user.role, 'patient');
    });
  } finally {
    restoreGoogleMock();
    restoreStore();
  }
});

test('google sign-in cannot cross into another role or escalate', async () => {
  const email = `google.cross.${Date.now()}@example.com`;
  try {
    mockGooglePayload({ email, email_verified: true, given_name: 'Cross', family_name: 'Role' });

    await withServer(async (base) => {
      // Existing pharmacist tries to Google-sign-in as a patient.
      const signup = await fetch(`${base}/api/auth/google`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idToken: 'mock-token', role: 'pharmacist' })
      });
      assert.equal(signup.status, 201);

      const cross = await fetch(`${base}/api/auth/google`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idToken: 'mock-token', role: 'patient' })
      });
      assert.equal(cross.status, 403);
      const crossBody = await cross.json();
      assert.match(crossBody.error, /different role/i);

      // The stored role must be unchanged.
      const login = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'not-a-real-password' })
      });
      assert.equal(login.status, 401, 'google accounts keep an unusable password');
    });
  } finally {
    restoreGoogleMock();
    restoreStore();
  }
});