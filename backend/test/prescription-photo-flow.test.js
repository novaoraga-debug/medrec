const test = require('node:test');
const assert = require('node:assert/strict');

// Isolated per-process store; must be required before the server module.
require('./helpers/isolated-store');
const { app, cleanPrescription } = require('../src/server');
const jwt = require('jsonwebtoken');

async function withServer(run) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function mintToken(role, extra = {}) {
  return jwt.sign(
    { role, email: `${role}@medrec.local`, ...extra, type: 'session', sub: `USR-TEST-${role}` },
    process.env.JWT_SECRET || 'replace-me-dev-secret',
    { expiresIn: '15m' }
  );
}

// Minimal valid 1x1 PNG.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

test('prescription photo flow: upload -> OCR structure -> verified soft copy -> confirm', async () => {
  await withServer(async (base) => {
    const doctorToken = mintToken('doctor');
    const pharmacistToken = mintToken('pharmacist');

    // Handwriting-typo text the OCR draft might produce.
    const form = new FormData();
    form.append('file', new Blob([PNG_BYTES], { type: 'image/png' }), 'rx.png');
    form.append('patientId', 'PT-1001');
    form.append('rawText', 'Amoxiciilin 500mg BD for 5 days');

    const upload = await fetch(`${base}/api/prescriptions/upload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${doctorToken}` },
      body: form
    });
    assert.equal(upload.status, 201);
    const prescription = await upload.json();

    assert.ok(prescription.id.startsWith('RX-'));
    assert.ok(prescription.originalImageUrl.startsWith('/uploads/'));
    assert.equal(prescription.reviewStatus, 'awaiting-ocr-review');
    // Fuzzy match fixes the OCR typo and normalizes the BD abbreviation.
    assert.equal(prescription.cleaned.drug, 'Amoxicillin');
    assert.equal(prescription.cleaned.dosage, '500mg');
    assert.equal(prescription.cleaned.frequency, 'twice daily');
    assert.ok(prescription.ocrConfidence > 0.5);
    assert.ok(prescription.ocrWarnings.some((warning) => /verify/i.test(warning)));

    // Original photo is accessible only with a valid token.
    const filename = prescription.originalImageUrl.replace('/uploads/', '');
    const denied = await fetch(`${base}/api/files/${filename}`);
    assert.equal(denied.status, 401);

    const image = await fetch(`${base}/api/files/${filename}`, {
      headers: { authorization: `Bearer ${pharmacistToken}` }
    });
    assert.equal(image.status, 200);
    assert.match(image.headers.get('content-type'), /image\/png/);

    // Path traversal is rejected before any file system access.
    const traversal = await fetch(`${base}/api/files/..%2F..%2Fserver.js`, {
      headers: { authorization: `Bearer ${pharmacistToken}` }
    });
    assert.ok([400, 404].includes(traversal.status));

    // Legacy full-session tokens in the query string are no longer accepted.
    const legacyQuery = await fetch(`${base}/api/files/${filename}?access_token=${pharmacistToken}`);
    assert.equal(legacyQuery.status, 401);

    // <img> flow: exchange the session token for a short-lived, file-scoped token.
    const mint = await fetch(`${base}/api/files/token`, {
      method: 'POST',
      headers: { authorization: `Bearer ${pharmacistToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ filename })
    });
    assert.equal(mint.status, 200);
    const minted = await mint.json();
    assert.ok(minted.fileToken);
    assert.equal(typeof minted.expiresIn, 'string');
    assert.ok(minted.expiresIn.length > 0);

    const viaFileToken = await fetch(
      `${base}/api/files/${filename}?file_token=${encodeURIComponent(minted.fileToken)}`
    );
    assert.equal(viaFileToken.status, 200);
    assert.match(viaFileToken.headers.get('content-type'), /image\/png/);

    // The token is bound to one filename — any other file must be refused.
    const wrongFile = await fetch(
      `${base}/api/files/some-other-file.png?file_token=${encodeURIComponent(minted.fileToken)}`
    );
    assert.equal(wrongFile.status, 401);

    // …and a file token cannot authenticate regular API calls.
    const apiWithFileToken = await fetch(`${base}/api/prescriptions/ocr-status`, {
      headers: { authorization: `Bearer ${minted.fileToken}` }
    });
    assert.equal(apiWithFileToken.status, 401);

    // Minting requires auth and rejects traversal filenames.
    const mintDenied = await fetch(`${base}/api/files/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename })
    });
    assert.equal(mintDenied.status, 401);

    const mintTraversal = await fetch(`${base}/api/files/token`, {
      method: 'POST',
      headers: { authorization: `Bearer ${pharmacistToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ filename: '../../server.js' })
    });
    assert.equal(mintTraversal.status, 400);

    // Pharmacist stores the human-verified transcription (the soft copy).
    const correct = await fetch(`${base}/api/prescriptions/${prescription.id}/correct`, {
      method: 'POST',
      headers: { authorization: `Bearer ${pharmacistToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ verifiedText: 'Amoxicillin 500mg twice daily for 5 days' })
    });
    assert.equal(correct.status, 200);
    const verified = await correct.json();
    assert.equal(verified.reviewStatus, 'human-verified');
    assert.equal(verified.verifiedText, 'Amoxicillin 500mg twice daily for 5 days');
    assert.equal(verified.cleaned.frequency, 'twice daily');

    // Confirming freezes the record.
    const confirm = await fetch(`${base}/api/prescriptions/${prescription.id}/confirm`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${pharmacistToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'confirmed' })
    });
    assert.equal(confirm.status, 200);
    const confirmed = await confirm.json();
    assert.equal(confirmed.immutable, true);

    // Post-confirmation corrections are blocked.
    const lateEdit = await fetch(`${base}/api/prescriptions/${prescription.id}/correct`, {
      method: 'POST',
      headers: { authorization: `Bearer ${pharmacistToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ verifiedText: 'Tampered' })
    });
    assert.equal(lateEdit.status, 409);

    // Upload without a photo is rejected.
    const noFile = await fetch(`${base}/api/prescriptions/upload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${doctorToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ patientId: 'PT-1001', rawText: 'Aspirin 100mg od' })
    });
    assert.equal(noFile.status, 400);
  });
});

test('structured transcription: fuzzy medication names, abbreviations, and confidence', () => {
  const exact = cleanPrescription('Metformin 500mg OD for 30 days');
  assert.equal(exact.drug, 'Metformin');
  assert.equal(exact.frequency, 'once daily');
  assert.equal(exact.dosage, '500mg');
  assert.ok(exact.confidence >= 0.8);

  const fuzzy = cleanPrescription('Atorvastatn 20mg at night');
  assert.equal(fuzzy.drug, 'Atorvastatin');
  assert.ok(fuzzy.warnings.some((warning) => /Atorvastatn/.test(warning)));

  const unknown = cleanPrescription('Zombifyxol 10mg twice daily');
  assert.equal(unknown.drug, 'Zombifyxol');
  assert.ok(unknown.confidence < 0.6);
  assert.ok(unknown.warnings.some((warning) => /formulary/i.test(warning)));
});