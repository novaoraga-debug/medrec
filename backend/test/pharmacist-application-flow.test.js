const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

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

function mintAdminToken(role = 'super_admin', clinicId = null) {
  return jwt.sign(
    { role, email: `${role}@medrec.local`, clinicId, admin: true, type: 'admin-session', sub: 'USR-TEST-ADMIN' },
    process.env.JWT_SECRET || 'replace-me-dev-secret',
    { expiresIn: '15m' }
  );
}

test('pharmacist application flow: apply -> approve activates login with no doctor record', async () => {
  try {
    await withServer(async (base) => {
      const email = `pharm.apply.${Date.now()}@medrec.demo`;

      const applyResponse = await fetch(`${base}/api/doctors/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          role: 'pharmacist',
          firstName: 'Pharma',
          lastName: 'Applicant',
          email,
          password: 'PharmaPass123!',
          licenseNumber: 'PHA-APPLY-001'
        })
      });
      assert.equal(applyResponse.status, 201);
      const applyBody = await applyResponse.json();
      assert.equal(applyBody.application.status, 'pending');
      assert.equal(applyBody.application.role, 'pharmacist');
      const applicationId = applyBody.application.id;

      // Not active until staff approves.
      const prematureLogin = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'PharmaPass123!' })
      });
      assert.equal(prematureLogin.status, 401);

      const statusResponse = await fetch(`${base}/api/doctors/apply/status?email=${encodeURIComponent(email)}`);
      assert.equal(statusResponse.status, 200);
      const statusBody = await statusResponse.json();
      assert.equal(statusBody.status, 'pending');
      assert.equal(statusBody.role, 'pharmacist');
      assert.equal(statusBody.accountCreated, false);

      const adminToken = mintAdminToken();
      const approveResponse = await fetch(`${base}/api/admin/doctor-applications/${applicationId}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({})
      });
      assert.equal(approveResponse.status, 200);
      const approveBody = await approveResponse.json();
      assert.equal(approveBody.user.role, 'pharmacist');
      assert.equal(approveBody.doctor, null, 'pharmacist approval must not create a doctor record');

      // Account is live only after approval.
      const loginResponse = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'PharmaPass123!' })
      });
      assert.equal(loginResponse.status, 200);
      const loginBody = await loginResponse.json();
      assert.equal(loginBody.user.role, 'pharmacist');

      const finalStatus = await fetch(`${base}/api/doctors/apply/status?email=${encodeURIComponent(email)}`);
      const finalStatusBody = await finalStatus.json();
      assert.equal(finalStatusBody.status, 'approved');
      assert.equal(finalStatusBody.accountCreated, true);
    });
  } finally {
    restoreStore();
  }
});
