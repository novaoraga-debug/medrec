const test = require('node:test');
const assert = require('node:assert/strict');

// Isolated per-process store; must be required before the server module.
require('./helpers/isolated-store');
const { consentActiveFor, evaluateMedicationSafety } = require('../src/server');

test('doctor consent is active when the patient has approved access for the clinician', () => {
  const data = {
    patients: [{ id: 'PT-42', ownerId: 'USR-1' }],
    consents: [{ patientId: 'PT-42', actorId: 'USR-2001', actorRole: 'doctor', status: 'approved', expiresAt: '9999-12-31T00:00:00.000Z' }]
  };

  assert.equal(consentActiveFor('PT-42', 'doctor', 'USR-2001', data), true);
});

test('medication safety flags allergy and interaction risk for documented contraindications', () => {
  const patient = {
    id: 'PT-42',
    allergies: ['Penicillin'],
    activeMeds: [{ name: 'Metformin' }, { name: 'Atorvastatin' }]
  };

  const result = evaluateMedicationSafety(patient, { drug: 'Amoxicillin' });

  assert.ok(result.warnings.some((warning) => /allergy/i.test(warning)));
  assert.equal(result.overrideRequired, true);
});
