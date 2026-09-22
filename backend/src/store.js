const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, 'data');
const dataFile = path.join(dataDir, 'store.json');

const defaultData = {
  users: [
    {
      id: 'USR-1001',
      email: 'qa.user.2026@example.com',
      firstName: 'QA',
      lastName: 'User',
      phone: '',
      role: 'patient',
      passwordHash: '$2a$12$7mNMKL4aG/2UBTBa4QnAhOCAjZLqfrcLM.m3/an/WuUzBkipJpXVy',
      provider: 'email',
      verifiedEmail: true,
      mfaEnabled: false,
      refreshTokens: [],
      createdAt: '2026-09-21T07:37:46.773Z',
      status: 'active',
      specialty: '',
      licenseNumber: ''
    },
    {
      id: 'USR-2001',
      email: 'doctor.demo@medrec.local',
      firstName: 'Priya',
      lastName: 'Shah',
      phone: '',
      role: 'doctor',
      passwordHash: '$2a$12$7mNMKL4aG/2UBTBa4QnAhOCAjZLqfrcLM.m3/an/WuUzBkipJpXVy',
      provider: 'email',
      verifiedEmail: true,
      mfaEnabled: true,
      refreshTokens: [],
      createdAt: '2026-09-21T07:37:46.773Z',
      status: 'active',
      specialty: 'General Medicine',
      licenseNumber: 'MED-44783',
      clinicId: 'CLINIC-NAIROBI'
    },
    {
      id: 'USR-9001',
      email: 'super.admin@medrec.local',
      firstName: 'System',
      lastName: 'Administrator',
      phone: '',
      role: 'super_admin',
      passwordHash: '$2a$12$HQqJz6FA7EJ8hSK6eIF8yu44WHvXI1m4Her6Gl1SS7TuG37/hwHH6',
      provider: 'email',
      verifiedEmail: true,
      mfaEnabled: true,
      totpSecret: 'JBSWY3DPEHPK3PXP',
      refreshTokens: [],
      createdAt: '2026-09-21T07:37:46.773Z',
      status: 'active',
      specialty: '',
      licenseNumber: '',
      clinicId: null
    },
    {
      id: 'USR-9002',
      email: 'clinic.admin@medrec.local',
      firstName: 'Clinic',
      lastName: 'Manager',
      phone: '',
      role: 'clinic_admin',
      passwordHash: '$2a$12$pxdxrEY16PUxpHNWemc7qOptyzfJ.vbYMr0aNh9/CIScjPm8lf3r6',
      provider: 'email',
      verifiedEmail: true,
      mfaEnabled: true,
      totpSecret: 'JBSWY3DPEHPK3PXP',
      refreshTokens: [],
      createdAt: '2026-09-21T07:37:46.773Z',
      status: 'active',
      specialty: '',
      licenseNumber: '',
      clinicId: 'CLINIC-NAIROBI'
    }
  ],
  patients: [
    {
      id: 'PT-1001',
      ownerId: 'USR-1001',
      name: 'Aisha Okafor',
      dob: '1988-04-12',
      gender: 'female',
      mrn: 'MRN-1204',
      preferredLanguage: 'English',
      insurance: 'ACME Health Plan',
      clinicId: 'CLINIC-NAIROBI',
      status: 'active',
      homeClinic: 'Nairobi Community Clinic',
      allergies: ['Penicillin', 'Sulfa'],
      activeMeds: [
        { name: 'Metformin', dosage: '500mg', frequency: 'BD' },
        { name: 'Atorvastatin', dosage: '20mg', frequency: 'Nightly' }
      ],
      vitals: {
        bloodPressure: '118/76',
        heartRate: '72 bpm',
        temperature: '36.8°C',
        oxygenSaturation: '98%'
      },
      diagnoses: [
        { code: 'E11.9', title: 'Type 2 diabetes mellitus' },
        { code: 'I10', title: 'Essential hypertension' }
      ],
      immunizations: ['Influenza 2025', 'Tetanus booster'],
      visitHistory: [
        { date: '2026-09-10', clinic: 'Nairobi Community Clinic', reason: 'Follow-up' },
        { date: '2026-08-18', clinic: 'Western Referral Center', reason: 'Lab review' }
      ],
      consent: {
        patientControlled: true,
        pendingProviders: ['Dr. Priya Shah'],
        status: 'Consent request pending',
        emergencyBreakGlass: 'Enabled and logged'
      }
    }
  ],
  doctors: [
    {
      id: 'DR-2001',
      userId: 'USR-2001',
      name: 'Dr. Priya Shah',
      specialty: 'General Medicine',
      licenseNumber: 'MED-44783',
      affiliation: 'Nairobi Partners Clinic',
      clinicId: 'CLINIC-NAIROBI',
      verified: true,
      verificationStatus: 'approved',
      roles: ['Doctor'],
      qrToken: 'medrec-verified-DR-2001-2026'
    }
  ],
  prescriptions: [
    {
      id: 'RX-1001',
      patientId: 'PT-1001',
      doctorId: 'DR-2001',
      original: 'Amoxicillin 500mg twice daily for 5 days',
      cleaned: {
        drug: 'Amoxicillin',
        dosage: '500 mg',
        frequency: 'twice daily',
        duration: '5 days',
        instructions: 'Finish the full course unless directed otherwise.'
      },
      status: 'pending-confirmation',
      source: 'manual-entry',
      createdAt: '2026-09-21T09:15:00.000Z'
    }
  ],
  consents: [
    {
      id: 'CR-1',
      patientId: 'PT-1001',
      actorId: 'USR-2001',
      actorRole: 'doctor',
      provider: 'Dr. Priya Shah',
      purpose: 'Referral summary for cardiology follow-up',
      status: 'approved',
      createdAt: '2026-09-21T08:40:00.000Z',
      expiresAt: '2026-09-28T08:40:00.000Z'
    }
  ],
  consentRequests: [],
  notifications: [
    { id: 'N-1', type: 'prescription', title: 'Prescription ready', channel: 'SMS', message: 'Your prescription is ready for collection at Nairobi Partners Clinic.', read: false },
    { id: 'N-2', type: 'consent', title: 'Access request', channel: 'Push', message: 'Dr. Priya Shah is requesting access to your referral data.', read: false },
    { id: 'N-3', type: 'appointment', title: 'Follow-up booked', channel: 'Email', message: 'Your diabetes review is scheduled for 2026-09-30.', read: true }
  ],
  referrals: [
    {
      id: 'RF-1',
      patientId: 'PT-1001',
      to: 'Cardiology Unit',
      reason: 'BP evaluation and medication adjustment',
      summary: 'Patient has controlled diabetes with elevated blood pressure. Includes baseline vitals and active diagnoses.',
      status: 'sent'
    }
  ],
  labs: [
    { id: 'LB-1', patientId: 'PT-1001', date: '2026-09-16', name: 'HbA1c', result: '7.1%', status: 'requires-signoff' },
    { id: 'LB-2', patientId: 'PT-1001', date: '2026-09-16', name: 'Lipid Panel', result: 'Total cholesterol 176 mg/dL', status: 'verified' }
  ],
  payments: [
    { id: 'PY-1', patientId: 'PT-1001', visitDate: '2026-09-21', status: 'insured', coveredBy: 'ACME Health Plan', amount: 120.0 },
    { id: 'PY-2', patientId: 'PT-1001', visitDate: '2026-08-18', status: 'subsidized', coveredBy: 'Community Subsidy Program', amount: 55.0 }
  ],
  audit: [
    { id: 'AUD-1', actor: 'Dr. Priya Shah', action: 'Viewed patient record', resource: 'patients/PT-1001', reason: 'routine-access', timestamp: '2026-09-21T09:32:00.000Z', status: 'success' },
    { id: 'AUD-2', actor: 'Aisha Okafor', action: 'Granted provider consent', resource: 'consents/CR-1', reason: 'patient-consent', timestamp: '2026-09-20T15:10:00.000Z', status: 'success' },
    { id: 'AUD-3', actor: 'Pharmacy team', action: 'Requested prescription confirmation', resource: 'prescriptions/RX-1001', reason: 'dispensing-review', timestamp: '2026-09-21T09:16:00.000Z', status: 'success' }
  ],
  analytics: {
    dailyVolume: 38,
    diagnosisBreakdown: [
      { label: 'Diabetes', value: 26 },
      { label: 'Hypertension', value: 19 },
      { label: 'Respiratory', value: 12 }
    ],
    prescriptionPatterns: [
      { label: 'Antibiotics', value: 11 },
      { label: 'Insulin', value: 7 },
      { label: 'Pain management', value: 9 }
    ]
  },
  syncQueue: [],
  breakGlass: [],
  queue: []
};

function ensureDataStore() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  if (!fs.existsSync(dataFile)) {
    fs.writeFileSync(dataFile, JSON.stringify(defaultData, null, 2), 'utf8');
    return;
  }

  try {
    const raw = fs.readFileSync(dataFile, 'utf8');
    const parsed = JSON.parse(raw);
    const users = parsed.users || [];
    const seedByEmail = new Map(defaultData.users.map((user) => [user.email.toLowerCase(), user]));

    for (const user of users) {
      const seed = seedByEmail.get(String(user.email || '').toLowerCase());
      if (seed) {
        Object.assign(user, {
          ...seed,
          id: user.id || seed.id,
          refreshTokens: user.refreshTokens || [],
          createdAt: user.createdAt || seed.createdAt,
          status: user.status || seed.status
        });
      }
    }

    const currentEmails = new Set(users.map((user) => user.email?.toLowerCase()).filter(Boolean));
    const seededUsers = defaultData.users.filter((user) => !currentEmails.has(user.email.toLowerCase()));

    if (seededUsers.length > 0 || !parsed.patients?.length || !parsed.doctors?.length) {
      const next = {
        ...defaultData,
        ...parsed,
        users: [...seededUsers, ...users],
        patients: parsed.patients?.length ? parsed.patients : defaultData.patients,
        doctors: parsed.doctors?.length ? parsed.doctors : defaultData.doctors,
        consents: parsed.consents || defaultData.consents,
        notifications: parsed.notifications || defaultData.notifications,
        referrals: parsed.referrals || defaultData.referrals,
        labs: parsed.labs || defaultData.labs,
        payments: parsed.payments || defaultData.payments,
        audit: parsed.audit || defaultData.audit,
        analytics: parsed.analytics || defaultData.analytics,
        syncQueue: parsed.syncQueue || defaultData.syncQueue,
        breakGlass: parsed.breakGlass || defaultData.breakGlass,
        queue: parsed.queue || defaultData.queue,
        prescriptions: parsed.prescriptions || defaultData.prescriptions,
        consentRequests: parsed.consentRequests || defaultData.consentRequests
      };

      fs.writeFileSync(dataFile, JSON.stringify(next, null, 2), 'utf8');
    }
  } catch (error) {
    fs.writeFileSync(dataFile, JSON.stringify(defaultData, null, 2), 'utf8');
  }
}

function readData() {
  ensureDataStore();

  try {
    const raw = fs.readFileSync(dataFile, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    return JSON.parse(JSON.stringify(defaultData));
  }
}

function writeData(data) {
  ensureDataStore();
  fs.writeFileSync(dataFile, JSON.stringify(data, null, 2), 'utf8');
}

module.exports = {
  readData,
  writeData,
  defaultData
};
