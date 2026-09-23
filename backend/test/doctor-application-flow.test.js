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

async function loginAdmin(base) {
  const response = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'node-test-agent' },
    body: JSON.stringify({ email: 'super.admin@medrec.local', password: 'SuperAdmin!2026', mfaCode: '000000' })
  });

  // MFA uses a live TOTP secret; if the fixed code is rejected we still assert the flow guard.
  return response;
}

function mintAdminToken(role = 'super_admin', clinicId = null) {
  return jwt.sign(
    { role, email: `${role}@medrec.local`, clinicId, admin: true, type: 'admin-session', sub: 'USR-TEST-ADMIN' },
    process.env.JWT_SECRET || 'replace-me-dev-secret',
    { expiresIn: '15m' }
  );
}

test('doctor application flow: apply -> staff approve -> account + QR created', async () => {
  try {
    await withServer(async (base) => {
      const email = `apply.test.${Date.now()}@medrec.demo`;

      const applyResponse = await fetch(`${base}/api/doctors/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          firstName: 'Test',
          lastName: 'Applicant',
          email,
          password: 'DoctorPass123!',
          specialty: 'Cardiology',
          licenseNumber: 'MED-APPLY-001',
          affiliation: 'Test Clinic'
        })
      });

      assert.equal(applyResponse.status, 201);
      const applyBody = await applyResponse.json();
      assert.equal(applyBody.application.status, 'pending');
      const applicationId = applyBody.application.id;

      // A pending application must NOT have created a login account yet.
      const prematureLogin = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'DoctorPass123!' })
      });
      assert.equal(prematureLogin.status, 401);

      // Public status lookup reflects the pending state.
      const statusResponse = await fetch(`${base}/api/doctors/apply/status?email=${encodeURIComponent(email)}`);
      assert.equal(statusResponse.status, 200);
      const statusBody = await statusResponse.json();
      assert.equal(statusBody.status, 'pending');
      assert.equal(statusBody.accountCreated, false);

      // Staff review requires an admin session.
      const unauthList = await fetch(`${base}/api/admin/doctor-applications`);
      assert.equal(unauthList.status, 401);

      const adminToken = mintAdminToken();
      const listResponse = await fetch(`${base}/api/admin/doctor-applications`, {
        headers: { authorization: `Bearer ${adminToken}` }
      });
      assert.equal(listResponse.status, 200);
      const list = await listResponse.json();
      assert.ok(list.some((entry) => entry.id === applicationId));

      const approveResponse = await fetch(`${base}/api/admin/doctor-applications/${applicationId}/approve`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({})
      });
      assert.equal(approveResponse.status, 200);
      const approveBody = await approveResponse.json();
      assert.equal(approveBody.application.status, 'approved');
      assert.ok(approveBody.doctor.qrToken, 'approved doctor receives a QR token');
      assert.equal(approveBody.doctor.verified, true);

      // The account now exists and can sign in.
      const loginResponse = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'DoctorPass123!' })
      });
      assert.equal(loginResponse.status, 200);
      const loginBody = await loginResponse.json();
      assert.equal(loginBody.user.role, 'doctor');

      // QR generation works for the approved doctor.
      const qrResponse = await fetch(`${base}/api/doctors/qr?doctorId=${approveBody.doctor.id}`, { headers: { authorization: `Bearer ${loginBody.accessToken}` } });
      assert.equal(qrResponse.status, 200);
      const qrBody = await qrResponse.json();
      assert.ok(qrBody.qrCode && qrBody.qrCode.startsWith('data:image'));

      // Minting a QR requires a session (regression: was fully public).
      const unauthQr = await fetch(`${base}/api/doctors/qr`);
      assert.equal(unauthQr.status, 401);
    });
  } finally {
    restoreStore();
  }
});

test('doctor application flow: staff reject stores a reason and creates no account', async () => {
  try {
    await withServer(async (base) => {
      const email = `reject.test.${Date.now()}@medrec.demo`;

      const applyResponse = await fetch(`${base}/api/doctors/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          firstName: 'Reject',
          lastName: 'Case',
          email,
          password: 'DoctorPass123!',
          specialty: 'Dermatology',
          licenseNumber: 'MED-REJECT-001'
        })
      });
      assert.equal(applyResponse.status, 201);
      const applicationId = (await applyResponse.json()).application.id;

      const adminToken = mintAdminToken('clinic_admin', 'CLINIC-NAIROBI');
      const rejectResponse = await fetch(`${base}/api/admin/doctor-applications/${applicationId}/reject`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'License document unreadable.' })
      });
      assert.equal(rejectResponse.status, 200);
      const rejectBody = await rejectResponse.json();
      assert.equal(rejectBody.status, 'rejected');
      assert.equal(rejectBody.rejectionReason, 'License document unreadable.');

      const loginResponse = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'DoctorPass123!' })
      });
      assert.equal(loginResponse.status, 401);
    });
  } finally {
    restoreStore();
  }
});

test('doctor application rejects duplicate applications awaiting review', async () => {
  try {
    await withServer(async (base) => {
      const email = `dupe.test.${Date.now()}@medrec.demo`;
      const payload = {
        firstName: 'Dupe',
        lastName: 'Applicant',
        email,
        password: 'DoctorPass123!',
        specialty: 'Neurology',
        licenseNumber: 'MED-DUPE-001'
      };

      const first = await fetch(`${base}/api/doctors/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      assert.equal(first.status, 201);

      const second = await fetch(`${base}/api/doctors/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      assert.equal(second.status, 409);
    });
  } finally {
    restoreStore();
  }
});