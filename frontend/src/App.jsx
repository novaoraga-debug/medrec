import { useEffect, useMemo, useState } from 'react';

const dictionaries = {
  en: {
    title: 'MedRec Care Network',
    patientSummary: 'Patient summary',
    doctorVerification: 'Doctor verification',
    prescriptionWorkflow: 'Prescription workflow',
    pharmacistReview: 'Pharmacist review',
    safetyChecks: 'Safety checks',
    compliance: 'Compliance & liability',
    offlineStatus: 'Offline mode',
    consent: 'Consent dashboard',
    notifications: 'Notifications',
    admin: 'Admin analytics',
    referrals: 'Referral flow',
    labs: 'Lab / imaging',
    payment: 'Payment tracking',
    recover: 'Account recovery',
    onboarding: 'Onboarding',
    guestMode: 'Guest / walk-in',
    languages: 'Languages',
    patientName: 'Patient name',
    status: 'Status',
    preferLanguage: 'Preferred language',
    insurer: 'Insurance',
    allergyLabel: 'Allergies',
    activeMeds: 'Active meds',
    emergency: 'Emergency access',
    verification: 'Verification',
    license: 'License number',
    affiliation: 'Affiliation',
    issueToken: 'Issue signed token',
    qrCodeLabel: 'Signed QR',
    rawText: 'Raw prescription text',
    generate: 'Generate AI cleanup',
    queueSync: 'Queue sync',
    confirm: 'Confirm',
    flagMismatch: 'Flag mismatch',
    interactions: 'Interactions',
    noInteraction: 'No direct interaction flagged',
    liability: 'AI is assistive and never a substitute for clinician judgment.',
    syncQueue: 'Queued changes',
    save: 'Save draft',
    route: 'Role selection',
    google: 'Google Sign-In',
    email: 'Email / password',
    apple: 'Apple Sign-In',
    completeProfile: 'Complete profile',
    signOutDevices: 'Sign out of all devices',
    guestLabel: 'Guest record claim',
    idMatch: 'Identity match',
    exportFhir: 'Export FHIR',
    exportPdf: 'Export PDF summary',
    audit: 'Access log',
    consentRequest: 'Consent request',
    noWarnings: 'No active safety warnings',
    queueMessage: 'Changes are stored locally and will sync when the network is back.'
  },
  fr: {
    title: 'Réseau de soins MedRec',
    patientSummary: 'Résumé du patient',
    doctorVerification: 'Vérification du médecin',
    prescriptionWorkflow: 'Flux de prescription',
    pharmacistReview: 'Validation pharmacie',
    safetyChecks: 'Contrôles de sécurité',
    compliance: 'Conformité & responsabilité',
    offlineStatus: 'Mode hors ligne',
    consent: 'Tableau de consentement',
    notifications: 'Notifications',
    admin: 'Analytique admin',
    referrals: 'Flux d’orientation',
    labs: 'Laboratoire / imagerie',
    payment: 'Suivi des paiements',
    recover: 'Récupération du compte',
    onboarding: 'Inscription',
    guestMode: 'Visiteur / walk-in',
    languages: 'Langues',
    patientName: 'Nom du patient',
    status: 'Statut',
    preferLanguage: 'Langue préférée',
    insurer: 'Assurance',
    allergyLabel: 'Allergies',
    activeMeds: 'Médicaments actifs',
    emergency: 'Accès d’urgence',
    verification: 'Vérification',
    license: 'Numéro de licence',
    affiliation: 'Affiliation',
    issueToken: 'Émettre un token signé',
    qrCodeLabel: 'QR signé',
    rawText: 'Texte brut de prescription',
    generate: 'Générer la correction IA',
    queueSync: 'Synchronisation en file',
    confirm: 'Confirmer',
    flagMismatch: 'Signaler un écart',
    interactions: 'Interactions',
    noInteraction: 'Aucune interaction directe signalée',
    liability: 'L’IA est assistive et ne remplace jamais le jugement clinique.',
    syncQueue: 'Modifications en attente',
    save: 'Enregistrer le brouillon',
    route: 'Sélection du rôle',
    google: 'Connexion Google',
    email: 'Email / mot de passe',
    apple: 'Connexion Apple',
    completeProfile: 'Compléter le profil',
    signOutDevices: 'Se déconnecter de tous les appareils',
    guestLabel: 'Dossier invité',
    idMatch: 'Correspondance d’identité',
    exportFhir: 'Exporter FHIR',
    exportPdf: 'Exporter un résumé PDF',
    audit: 'Journal d’accès',
    consentRequest: 'Demande de consentement',
    noWarnings: 'Aucune alerte de sécurité active',
    queueMessage: 'Les changements sont enregistrés localement et seront synchronisés dès la reprise du réseau.'
  }
};

const initialPrescription = `Amoxicillin 500mg twice daily for 5 days\nContinue until the course is complete\nMonitor for rash or GI upset`;

function App() {
  const [language, setLanguage] = useState('en');
  const [dashboard, setDashboard] = useState(null);
  const [rawText, setRawText] = useState(initialPrescription);
  const [cleanedPrescription, setCleanedPrescription] = useState(null);
  const [offline, setOffline] = useState(!navigator.onLine);
  const [qrCode, setQrCode] = useState('');
  const [fhirBundle, setFhirBundle] = useState(null);
  const [queue, setQueue] = useState(() => JSON.parse(localStorage.getItem('medrec-queue') || '[]'));

  const t = dictionaries[language];

  const loadDashboard = async () => {
    const response = await fetch('/api/dashboard');
    const data = await response.json();
    setDashboard(data);

    const qrcodeResponse = await fetch('/api/doctors/qr?doctorId=DR-2001');
    const qrcodeData = await qrcodeResponse.json();
    setQrCode(qrcodeData.qrCode);
  };

  useEffect(() => {
    loadDashboard();

    const handleOnline = () => setOffline(false);
    const handleOffline = () => setOffline(true);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const pendingWarnings = useMemo(() => {
    if (!dashboard?.patient) return [];
    const meds = dashboard.patient.activeMeds.map((item) => item.name.toLowerCase());
    const target = (cleanedPrescription?.drug || '').toLowerCase();

    if (!target) return [];
    const warnings = [];
    if (meds.includes('metformin') && target.includes('amoxicillin')) warnings.push('No major interaction; continue routine monitoring.');
    if (meds.includes('atorvastatin') && target.includes('ibuprofen')) warnings.push('NSAID may raise bleeding risk when combined with statin therapy.');
    if (meds.includes('metformin') && target.includes('metformin')) warnings.push('Medication duplication suspected — confirm dose and frequency.');
    return warnings.length ? warnings : [t.noInteraction];
  }, [cleanedPrescription, dashboard, t.noInteraction]);

  const patient = dashboard?.patient;
  const doctor = dashboard?.doctor;

  const handlePrescriptionGenerate = async () => {
    if (!dashboard) return;
    const response = await fetch('/api/prescriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patientId: patient.id,
        doctorId: doctor.id,
        rawText
      })
    });

    const data = await response.json();
    setCleanedPrescription(data.cleaned);
    await loadDashboard();
  };

  const handleVerifyPrescription = async (status) => {
    if (!dashboard || !dashboard.prescriptions[0]) return;

    await fetch(`/api/prescriptions/${dashboard.prescriptions[0].id}/verify`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status,
        reviewedBy: 'Pharmacist team'
      })
    });

    await loadDashboard();
  };

  const handleConsentApprove = async () => {
    await fetch('/api/consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'Dr. Priya Shah',
        purpose: 'Specialist referral and treatment coordination',
        patientId: patient.id
      })
    });

    await loadDashboard();
  };

  const handleExportFhir = async () => {
    const response = await fetch(`/api/fhir/${patient.id}`);
    const data = await response.json();
    setFhirBundle(data);
  };

  const saveLocalQueue = (entry) => {
    const nextQueue = JSON.parse(localStorage.getItem('medrec-queue') || '[]');
    nextQueue.push(entry);
    localStorage.setItem('medrec-queue', JSON.stringify(nextQueue));
    setQueue(nextQueue);
  };

  const handleQueueSync = async () => {
    const entry = {
      type: 'prescription',
      payload: { patient: patient?.id, rawText, language },
      createdAt: new Date().toISOString(),
      status: 'queued'
    };

    saveLocalQueue(entry);
    await fetch('/api/offline-queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry)
    });
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Healthcare coordination</p>
          <h1>{t.title}</h1>
        </div>
        <div className="toolbar">
          <div className="status-pill">
            <span className={`dot ${offline ? 'offline' : 'online'}`}></span>
            {offline ? t.offlineStatus : 'Online'}
          </div>
          <select value={language} onChange={(e) => setLanguage(e.target.value)}>
            <option value="en">English</option>
            <option value="fr">Français</option>
          </select>
        </div>
      </header>

      <main className="grid-layout">
        <section className="panel hero-panel">
          <div className="hero-row">
            <div>
              <p className="eyebrow">{t.patientSummary}</p>
              <h2>{patient?.name || 'Patient record'}</h2>
            </div>
            <button className="primary" onClick={handleExportFhir}>{t.exportFhir}</button>
          </div>

          <div className="stats-grid">
            <div className="stat-card">
              <span>{t.status}</span>
              <strong>{patient?.status || 'Active'}</strong>
            </div>
            <div className="stat-card">
              <span>{t.preferLanguage}</span>
              <strong>{patient?.preferredLanguage || 'English'}</strong>
            </div>
            <div className="stat-card">
              <span>{t.insurer}</span>
              <strong>{patient?.insurance || 'Plan A'}</strong>
            </div>
            <div className="stat-card">
              <span>{t.emergency}</span>
              <strong>{patient?.consent?.emergencyBreakGlass || 'Enabled'}</strong>
            </div>
          </div>
        </section>

        <section className="panel">
          <p className="eyebrow">{t.doctorVerification}</p>
          <div className="doctor-box">
            <div>
              <h3>{doctor?.name || 'Dr. Priya Shah'}</h3>
              <p>{doctor?.specialty || 'General Medicine'}</p>
              <ul>
                <li>License: {doctor?.licenseNumber || 'MED-44783'}</li>
                <li>Affiliation: {doctor?.affiliation || 'Nairobi Partners Clinic'}</li>
                <li>Verification: {doctor?.verified ? 'Verified' : 'Pending'}</li>
              </ul>
            </div>
            <div className="qr-box">
              {qrCode ? <img src={qrCode} alt="Signed doctor QR" /> : null}
              <small>{t.qrCodeLabel}</small>
            </div>
          </div>
        </section>

        <section className="panel">
          <p className="eyebrow">{t.consent}</p>
          <div className="stack">
            <div className="info-row">
              <strong>{t.consentRequest}</strong>
              <span>{patient?.consent?.status || 'Consent request pending'}</span>
            </div>
            <div className="info-row">
              <strong>{t.patientName}</strong>
              <span>{patient?.name}</span>
            </div>
            <button className="primary" onClick={handleConsentApprove}>{t.completeProfile}</button>
          </div>
        </section>

        <section className="panel span-2">
          <p className="eyebrow">{t.prescriptionWorkflow}</p>
          <div className="prescription-grid">
            <label className="textarea-wrap">
              <span>{t.rawText}</span>
              <textarea value={rawText} onChange={(e) => setRawText(e.target.value)} rows={8} />
            </label>

            <div className="result-card">
              <h3>{cleanedPrescription ? 'AI-cleaned transcription' : 'AI-assisted transcription — pending confirmation'}</h3>
              {cleanedPrescription ? (
                <ul>
                  <li>Drug: {cleanedPrescription.drug}</li>
                  <li>Dosage: {cleanedPrescription.dosage}</li>
                  <li>Frequency: {cleanedPrescription.frequency}</li>
                  <li>Duration: {cleanedPrescription.duration}</li>
                  <li>Notes: {cleanedPrescription.notes}</li>
                </ul>
              ) : (
                <p>{t.liability}</p>
              )}
              <div className="button-row">
                <button className="primary" onClick={handlePrescriptionGenerate}>{t.generate}</button>
                <button className="secondary" onClick={handleQueueSync}>{t.queueSync}</button>
              </div>
            </div>
          </div>
        </section>

        <section className="panel">
          <p className="eyebrow">{t.pharmacistReview}</p>
          <div className="review-grid">
            <div>
              <h4>Original</h4>
              <p>{dashboard?.prescriptions?.[0]?.original || rawText}</p>
            </div>
            <div>
              <h4>AI-cleaned</h4>
              <p>{cleanedPrescription ? `${cleanedPrescription.drug} ${cleanedPrescription.dosage} ${cleanedPrescription.frequency}` : 'Waiting for transcription'}</p>
            </div>
          </div>
          <div className="button-row">
            <button className="primary" onClick={() => handleVerifyPrescription('verified')}>{t.confirm}</button>
            <button className="danger" onClick={() => handleVerifyPrescription('flagged')}>{t.flagMismatch}</button>
          </div>
        </section>

        <section className="panel">
          <p className="eyebrow">{t.safetyChecks}</p>
          <ul className="list">
            {pendingWarnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </section>

        <section className="panel">
          <p className="eyebrow">{t.compliance}</p>
          <p>{t.liability}</p>
          <ul className="list compact">
            <li>Encryption in transit and at rest</li>
            <li>Consent-aware access review</li>
            <li>Right-to-deletion and retention controls</li>
          </ul>
        </section>

        <section className="panel">
          <p className="eyebrow">{t.notifications}</p>
          <ul className="list compact">
            {dashboard?.notifications?.map((entry) => (
              <li key={entry.id}><strong>{entry.title}</strong> — {entry.message}</li>
            ))}
          </ul>
        </section>

        <section className="panel">
          <p className="eyebrow">{t.admin}</p>
          <div className="analytics">
            <div className="metric-box">
              <span>Daily volume</span>
              <strong>{dashboard?.analytics?.dailyVolume || 38}</strong>
            </div>
            {dashboard?.analytics?.diagnosisBreakdown?.map((entry) => (
              <div key={entry.label} className="metric-box">
                <span>{entry.label}</span>
                <strong>{entry.value}%</strong>
              </div>
            ))}
          </div>
        </section>

        <section className="panel">
          <p className="eyebrow">{t.lab}</p>
          <ul className="list compact">
            {dashboard?.labs?.map((lab) => (
              <li key={lab.id}>{lab.name}: {lab.result} ({lab.status})</li>
            ))}
          </ul>
        </section>

        <section className="panel">
          <p className="eyebrow">{t.referrals}</p>
          <ul className="list compact">
            {dashboard?.referrals?.map((ref) => (
              <li key={ref.id}><strong>{ref.to}</strong> — {ref.reason}</li>
            ))}
          </ul>
        </section>

        <section className="panel">
          <p className="eyebrow">{t.payment}</p>
          <ul className="list compact">
            {dashboard?.payments?.map((payment) => (
              <li key={payment.id}>{payment.visitDate}: {payment.status} / {payment.coveredBy}</li>
            ))}
          </ul>
        </section>

        <section className="panel">
          <p className="eyebrow">{t.audit}</p>
          <ul className="list compact">
            {dashboard?.audit?.slice(0, 4).map((entry) => (
              <li key={entry.id}>{entry.actor} — {entry.action}</li>
            ))}
          </ul>
        </section>

        <section className="panel">
          <p className="eyebrow">{t.onboarding}</p>
          <div className="auth-grid">
            <button className="primary">{t.google}</button>
            <button className="secondary">{t.email}</button>
            <button className="secondary">{t.apple}</button>
          </div>
          <div className="stack small-gap">
            <label>{t.route}<input value="Patient" readOnly /></label>
            <button className="secondary">{t.signOutDevices}</button>
          </div>
        </section>

        <section className="panel">
          <p className="eyebrow">{t.guestMode}</p>
          <div className="stack small-gap">
            <button className="primary">{t.guestLabel}</button>
            <button className="secondary">{t.idMatch}</button>
          </div>
        </section>

        <section className="panel">
          <p className="eyebrow">{t.recover}</p>
          <div className="stack small-gap">
            <button className="secondary">Recovery via email</button>
            <button className="secondary">Recovery via Google</button>
          </div>
        </section>

        <section className="panel">
          <p className="eyebrow">{t.syncQueue}</p>
          <p>{t.queueMessage}</p>
          <ul className="list compact">
            {queue.map((item) => (
              <li key={item.createdAt}>{item.type} — {item.status}</li>
            ))}
          </ul>
        </section>

        {fhirBundle ? (
          <section className="panel span-2">
            <p className="eyebrow">FHIR bundle</p>
            <pre>{JSON.stringify(fhirBundle, null, 2)}</pre>
          </section>
        ) : null}
      </main>
    </div>
  );
}

export default App;
