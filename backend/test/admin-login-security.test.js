const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../src/server');

async function postAdminLogin(payload) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'node-test-agent' },
      body: JSON.stringify(payload)
    });
    const text = await response.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    return { status: response.status, data };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('admin login rejects non-admin or unknown emails with the same generic error message', async () => {
  const invalidEmail = await postAdminLogin({ email: 'does.not.exist@medrec.test', password: 'WrongPass123!' });
  const invalidRole = await postAdminLogin({ email: 'qa.user.2026@example.com', password: 'Password123!' });

  assert.equal(invalidEmail.status, 401);
  assert.equal(invalidEmail.data.error, 'Invalid credentials');
  assert.equal(invalidRole.status, 401);
  assert.equal(invalidRole.data.error, 'Invalid credentials');
});

test('valid admin credentials require MFA before issuing a session token', async () => {
  const result = await postAdminLogin({
    email: 'super.admin@medrec.local',
    password: 'SuperAdmin!2026'
  });

  assert.equal(result.status, 401);
  assert.equal(result.data.error, 'MFA required');
  assert.ok(result.data.requiresMfa === true);
});
