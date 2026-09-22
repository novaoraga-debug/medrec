const test = require('node:test');
const assert = require('node:assert/strict');

const { buildFhirBundle, queueOfflineSyncEntry } = require('../src/server');

test('FHIR export includes patient, medication, and consent resources', () => {
  const patient = {
    id: 'PT-42',
    mrn: 'MRN-42',
    name: 'Aisha Okafor',
    dob: '1988-04-12',
    gender: 'female',
    allergies: ['Penicillin'],
    activeMeds: [{ name: 'Metformin' }],
    phone: '+254700000000'
  };

  const data = {
    prescriptions: [{ id: 'RX-1', patientId: 'PT-42', status: 'active', cleaned: { drug: 'Amoxicillin', dosage: '500mg', frequency: 'twice daily' }, createdAt: '2026-09-21T00:00:00.000Z' }],
    consents: [{ id: 'CONS-1', patientId: 'PT-42', purpose: 'Referral', status: 'approved', createdAt: '2026-09-21T00:00:00.000Z' }]
  };

  const bundle = buildFhirBundle(patient, data);

  assert.equal(bundle.resourceType, 'Bundle');
  assert.ok(bundle.entry.some((entry) => entry.resource.resourceType === 'Patient'));
  assert.ok(bundle.entry.some((entry) => entry.resource.resourceType === 'MedicationRequest'));
  assert.ok(bundle.entry.some((entry) => entry.resource.resourceType === 'Consent'));
});

test('offline sync queues duplicate patient updates for manual review instead of silently overwriting', () => {
  const data = {
    syncQueue: [{ recordId: 'PT-42', status: 'queued' }]
  };

  const queueItem = queueOfflineSyncEntry(data, { recordId: 'PT-42', type: 'patient-record-sync' });

  assert.equal(queueItem.conflictState, 'manual-review');
  assert.equal(queueItem.status, 'queued-conflict');
});
