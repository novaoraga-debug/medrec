import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import jsQR from 'jsqr';
import {
  login,
  fetchMe,
  fetchDashboard,
  fetchPatient,
  getDoctorQr,
  submitDoctorApplication,
  fetchApplicationStatus,
  verifyDoctorToken
} from '../../shared/api.js';
import { useSession, roleAllowed, sessionFromAuth } from '../../shared/auth.js';
import { PortalHeader, RoleLockedNotice, EmptyState, pageTransition, GoogleSignInButton, PrescriptionPhotoCapture, RoleHeroArt } from '../../shared/ui.jsx';

const PORTAL_ROLE = 'doctor';
const ALLOWED_ROLES = ['doctor'];
const samplePrescription = `Amoxicillin 500mg twice daily for 5 days\nFinish the course unless directed otherwise\nMonitor for rash or GI upset`;

// Client-side JWT payload decode (no verification) used only to pre-fill the
// verification application from a Google identity. The backend always verifies.
function decodeJwtPayload(token) {
  try {
    const base64 = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(
      atob(base64)
        .split('')
        .map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
        .join('')
    );
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export default function App() {
  const { session, saveSession, signOut } = useSession(PORTAL_ROLE);
  const [mode, setMode] = useState('signin'); // signin | apply
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Sign-in form
  const [signIn, setSignIn] = useState({
    email: import.meta.env.DEV ? 'doctor.demo@medrec.local' : '',
    password: import.meta.env.DEV ? 'Password123!' : ''
  });

  // Application form
  const [application, setApplication] = useState({
    firstName: '',
    lastName: '',
    email: '',
    password: '',
    specialty: 'General Medicine',
    licenseNumber: '',
    affiliation: '',
    phone: ''
  });
  const [documents, setDocuments] = useState([]);
  const [submittedEmail, setSubmittedEmail] = useState('');
  const [applicationStatus, setApplicationStatus] = useState(null);

  async function handleSignIn() {
    setBusy(true);
    setError('');
    try {
      const data = await login(signIn.email.trim(), signIn.password);
      if (!roleAllowed(data.user?.role, ALLOWED_ROLES)) {
        setError('This portal is for doctors only. Use the correct portal for your role.');
        setBusy(false);
        return;
      }
      const me = await fetchMe(data.accessToken).catch(() => ({ user: data.user }));
      saveSession(sessionFromAuth({ ...data, user: me.user || data.user }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleApply() {
    setBusy(true);
    setError('');
    try {
      const formData = new FormData();
      Object.entries(application).forEach(([key, value]) => formData.append(key, value));
      documents.forEach((file) => formData.append('documents', file));

      const result = await submitDoctorApplication(formData);
      setSubmittedEmail(application.email.trim().toLowerCase());
      setApplicationStatus({ status: 'pending', ...result.application });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Application submission failed');
    } finally {
      setBusy(false);
    }
  }

  async function refreshApplicationStatus() {
    try {
      const status = await fetchApplicationStatus(submittedEmail);
      setApplicationStatus((prev) => ({ ...prev, ...status }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not refresh status');
    }
  }

  // Doctor logins cannot be created with Google — the backend only allows
  // patient/pharmacist self-service. Instead, a Google identity pre-fills the
  // verification application so the doctor completes the document review flow.
  function handleGoogleToken(idToken) {
    const claims = decodeJwtPayload(idToken);
    setMode('apply');
    setError('Google accounts cannot create doctor logins directly. Complete the verification application below — staff will review your documents and create your account.');
    setApplication((prev) => ({
      ...prev,
      email: claims?.email || prev.email,
      firstName: claims?.given_name || prev.firstName,
      lastName: claims?.family_name || prev.lastName
    }));
  }

  if (!session) {
    return (
      <div className="portal-shell">
        <div className="app-shell">
          <AnimatePresence mode="wait">
            <motion.div key={mode} {...pageTransition}>
              {mode === 'signin' ? (
                <SignInScreen
                  signIn={signIn}
                  setSignIn={setSignIn}
                  onSubmit={handleSignIn}
                  busy={busy}
                  error={error}
                  onApplyInstead={() => { setMode('apply'); setError(''); }}
                  onGoogleToken={handleGoogleToken}
                  applicationStatus={applicationStatus}
                />
              ) : (
                <ApplyScreen
                  application={application}
                  setApplication={setApplication}
                  documents={documents}
                  setDocuments={setDocuments}
                  onSubmit={handleApply}
                  onBack={() => { setMode('signin'); setError(''); }}
                  onRefreshStatus={refreshApplicationStatus}
                  busy={busy}
                  error={error}
                  applicationStatus={applicationStatus}
                  submittedEmail={submittedEmail}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    );
  }

  if (!roleAllowed(session.user?.role, ALLOWED_ROLES)) {
    return <div className="portal-shell"><RoleLockedNotice portalRole="doctor" onSignOut={signOut} /></div>;
  }

  return (
    <DoctorWorkspace session={session} onSignOut={signOut} />
  );
}

function SignInScreen({ signIn, setSignIn, onSubmit, busy, error, onApplyInstead, onGoogleToken, applicationStatus }) {
  return (
    <div className="auth-shell">
      <div className="auth-layout">
        <section className="brand-panel">
          <div className="brand-badge">MedRec Doctor Portal</div>
          <p className="eyebrow">clinician access</p>
          <h1>Verified clinicians only.</h1>
          <p className="hero-copy">
            Doctor accounts are created only after staff review and approval of your verification
            documents. Submit an application to get started.
          </p>
          <div className="feature-list">
            <div className="feature-item">
              <span className="feature-check">✓</span>
              <div><strong>Document review</strong><small>Licence and ID checked by staff.</small></div>
            </div>
            <div className="feature-item">
              <span className="feature-check">✓</span>
              <div><strong>Verified QR</strong><small>Scan-to-verify clinician identity.</small></div>
            </div>
          </div>
          <RoleHeroArt role="doctor" />
          {applicationStatus && (
            <div className={`status-banner ${applicationStatus.status}`}>
              Application {applicationStatus.status} — {applicationStatus.name}
            </div>
          )}
        </section>

        <section className="panel login-panel">
          <div className="login-status"><span className="status-pulse" /> Doctor portal — role locked</div>
          <div className="panel-header">
            <div>
              <p className="eyebrow">doctor sign in</p>
              <h2>Welcome back, doctor</h2>
            </div>
          </div>

          <div className="field-group">
            <label>
              Email
              <input type="email" value={signIn.email} onChange={(e) => setSignIn({ ...signIn, email: e.target.value })} />
            </label>
            <label>
              Password
              <input type="password" value={signIn.password} onChange={(e) => setSignIn({ ...signIn, password: e.target.value })} />
            </label>
          </div>

          {error && <div className="error-banner">{error}</div>}

          <div className="button-row">
            <button className="primary" onClick={onSubmit} disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
            <button className="secondary" onClick={onApplyInstead}>Apply for verification</button>
          </div>

          <div className="auth-divider"><span>or</span></div>
          <GoogleSignInButton
            label="Continue with Google to apply"
            onToken={onGoogleToken}
            onError={(err) => setError(err instanceof Error ? err.message : 'Google sign-in failed')}
          />
          <p className="eyebrow" style={{ marginTop: '0.5rem' }}>
            Doctor accounts are created only after staff approval, so Google pre-fills the application instead of signing you in.
          </p>
        </section>
      </div>
    </div>
  );
}

function ApplyScreen({ application, setApplication, documents, setDocuments, onSubmit, onBack, onRefreshStatus, busy, error, applicationStatus, submittedEmail }) {
  const update = (key) => (e) => setApplication((prev) => ({ ...prev, [key]: e.target.value }));

  if (applicationStatus && applicationStatus.status) {
    return (
      <div className="auth-shell">
        <div className="panel login-panel" style={{ width: 'min(760px, 100%)' }}>
          <p className="eyebrow">application status</p>
          <h2>{applicationStatus.name || application.email}</h2>
          <div className={`status-banner ${applicationStatus.status}`}>
            {applicationStatus.status === 'pending' && 'Pending review — a staff administrator will verify your documents.'}
            {applicationStatus.status === 'approved' && 'Approved — your account is active. You can sign in now.'}
            {applicationStatus.status === 'rejected' && `Rejected — ${applicationStatus.rejectionReason || 'documents could not be verified.'}`}
          </div>
          <p className="hero-copy">
            Submitted {applicationStatus.submittedAt ? new Date(applicationStatus.submittedAt).toLocaleString() : ''}.
            You cannot sign in until the review is approved.
          </p>

          {Array.isArray(applicationStatus.documents) && applicationStatus.documents.length > 0 && (
            <ul className="document-list">
              {applicationStatus.documents.map((doc) => (
                <li key={doc.filename}>
                  <span>{doc.originalName}</span>
                  <small>on file — reviewed by staff only</small>
                </li>
              ))}
            </ul>
          )}

          <div className="button-row" style={{ marginTop: '1rem' }}>
            <button className="primary" onClick={onRefreshStatus}>Refresh status</button>
            {applicationStatus.status === 'approved' && (
              <button className="secondary" onClick={onBack}>Go to sign in</button>
            )}
            {applicationStatus.status !== 'approved' && (
              <button className="secondary" onClick={onBack}>Back</button>
            )}
          </div>
          {submittedEmail && <p className="eyebrow" style={{ marginTop: '0.75rem' }}>Tracking: {submittedEmail}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="auth-shell">
      <div className="panel login-panel" style={{ width: 'min(960px, 100%)' }}>
        <div className="panel-header">
          <div>
            <p className="eyebrow">doctor verification</p>
            <h2>Apply for a doctor account</h2>
          </div>
          <button className="secondary small" onClick={onBack}>Back to sign in</button>
        </div>

        <p className="hero-copy">
          Submit your details and upload your licence/ID. A staff administrator reviews your
          documents and, on approval, your account and verification QR code are created.
        </p>

        <div className="application-grid">
          <label>First name<input value={application.firstName} onChange={update('firstName')} /></label>
          <label>Last name<input value={application.lastName} onChange={update('lastName')} /></label>
          <label>Email<input type="email" value={application.email} onChange={update('email')} /></label>
          <label>Password (min 8 chars)<input type="password" value={application.password} onChange={update('password')} /></label>
          <label>Specialty<input value={application.specialty} onChange={update('specialty')} /></label>
          <label>License number<input value={application.licenseNumber} onChange={update('licenseNumber')} /></label>
          <label>Clinic / affiliation<input value={application.affiliation} onChange={update('affiliation')} /></label>
          <label>Phone<input value={application.phone} onChange={update('phone')} /></label>
          <label className="full-span">
            Upload documents (licence, ID) — up to 5 files
            <input type="file" multiple onChange={(e) => setDocuments(Array.from(e.target.files || []))} />
          </label>
        </div>

        {documents.length > 0 && (
          <ul className="document-list">
            {documents.map((file) => (
              <li key={file.name}><span>{file.name}</span><span>{Math.round(file.size / 1024)} KB</span></li>
            ))}
          </ul>
        )}

        {error && <div className="error-banner">{error}</div>}

        <div className="button-row">
          <button className="primary" onClick={onSubmit} disabled={busy}>{busy ? 'Submitting…' : 'Submit application'}</button>
        </div>
      </div>
    </div>
  );
}

function DoctorWorkspace({ session, onSignOut }) {
  const token = session.accessToken;
  const [dashboard, setDashboard] = useState({});
  const [qr, setQr] = useState(null);
  const [draftPrescription, setDraftPrescription] = useState(samplePrescription);
  const [lastPrescription, setLastPrescription] = useState(null);
  const [status, setStatus] = useState('');
  const [lookupQuery, setLookupQuery] = useState('');
  const [lookupPatient, setLookupPatient] = useState(null);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const scanLoopRef = useRef(null);

  useEffect(() => {
    fetchDashboard(token).then(setDashboard).catch(() => {});
    getDoctorQr(token).then(setQr).catch(() => {});
  }, [token]);

  const patient = dashboard.patient || {};
  const shownPatient = lookupPatient || patient;
  const doctor = dashboard.doctor || {};

  const aiCleaned = useMemo(() => {
    const lines = draftPrescription.split(/\n|;|\./).filter(Boolean);
    const medication = lines.find((line) => /(amoxicillin|metformin|ibuprofen|atorvastatin|paracetamol|azithromycin|cetirizine)/i.test(line)) ?? 'Medication';
    const dosage = lines.find((line) => /\d+\s*(mg|mcg|g|ml|iu|tablet|capsule)/i.test(line)) ?? 'standard dose';
    const frequency = lines.find((line) => /(twice|daily|morning|night|bd|od|tid|qid)/i.test(line)) ?? 'as directed';
    const duration = lines.find((line) => /(for\s+\d+\s*(days|weeks|months)|\d+\s*(days|weeks|months))/i.test(line)) ?? 'duration not specified';
    return {
      drug: medication.replace(/[^a-zA-Z ]/g, '').trim() || 'Medication',
      dosage: dosage.match(/\d+\s*(?:mg|mcg|g|ml|iu|tablet|capsule)/i)?.[0] ?? 'standard dose',
      frequency: frequency.match(/(twice|daily|morning|night|bd|od|tid|qid)/i)?.[0] ?? 'as directed',
      duration: duration.replace(/.*?(for\s+\d+\s*(?:days|weeks|months)|\d+\s*(?:days|weeks|months)).*/i, '$1') || 'duration not specified',
      instructions: 'AI-assisted transcription — clinician confirmation required before dispensing.'
    };
  }, [draftPrescription]);

  const stopCamera = () => {
    if (scanLoopRef.current) { window.clearTimeout(scanLoopRef.current); scanLoopRef.current = null; }
    if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
    if (videoRef.current) videoRef.current.srcObject = null;
  };

  useEffect(() => () => stopCamera(), []);

  async function startQrScan() {
    if (!navigator.mediaDevices?.getUserMedia) { setStatus('Camera not available in this browser.'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      streamRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
      const canvas = canvasRef.current ?? document.createElement('canvas');
      canvasRef.current = canvas;
      setStatus('Camera active. Point at a doctor QR code…');

      const scanFrame = () => {
        const video = videoRef.current;
        const context = canvas.getContext('2d');
        if (!video || !context || video.readyState < 2) { scanLoopRef.current = window.setTimeout(scanFrame, 250); return; }
        const width = video.videoWidth || 640;
        const height = video.videoHeight || 480;
        canvas.width = width; canvas.height = height;
        context.drawImage(video, 0, 0, width, height);
        const image = context.getImageData(0, 0, width, height);
        const code = jsQR(image.data, image.width, image.height, { inversionAttempts: 'attemptBoth' });
        if (code) {
          stopCamera();
          try {
            const parsed = JSON.parse(code.data);
            verifyDoctorToken(parsed?.token || code.data)
              .then((result) => setStatus(`${result.name} verified: ${result.specialty}`))
              .catch(() => setStatus('QR detected, but not a valid MedRec doctor token.'));
          } catch {
            setStatus(`QR detected: ${code.data}`);
          }
          return;
        }
        scanLoopRef.current = window.setTimeout(scanFrame, 250);
      };
      scanFrame();
    } catch {
      setStatus('Camera permission denied or unavailable.');
    }
  }

  async function handleLookup() {
    const id = lookupQuery.trim();
    if (!id) { setStatus('Enter a patient ID (e.g. PT-1001) to look up.'); return; }
    setStatus('Looking up patient…');
    try {
      const found = await fetchPatient(token, id);
      setLookupPatient(found);
      setStatus(`Loaded ${found.name || found.id} (${found.mrn || found.id}).`);
    } catch (err) {
      setLookupPatient(null);
      setStatus(err instanceof Error ? err.message : 'Patient not found.');
    }
  }

  async function handleGenerateQr() {
    try {
      const result = await getDoctorQr(token);
      setQr(result);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'QR generation failed');
    }
  }

  async function handlePrescriptionUploaded(prescription) {
    setLastPrescription(prescription);
    const fields = prescription.cleaned;
    if (fields) {
      setDraftPrescription(
        `${fields.drug} ${fields.dosage} ${fields.frequency}\n${fields.duration}`
      );
    }
    setStatus(prescription.ocrConfidence < 0.6
      ? 'Uploaded — low OCR confidence, pharmacist must verify carefully.'
      : 'Prescription uploaded for pharmacist verification.');
  }

  return (
    <div className="app-shell role-doctor">
      <PortalHeader
        title="Clinical access and record review"
        subtitle="Verified clinician workspace"
        role="doctor"
        onSignOut={onSignOut}
      />

      <div className="care-flow">
        {["Today's queue", 'Clinical review', 'Prescription safety'].map((step, index) => (
          <div className={`care-flow-step ${index === 0 ? 'active' : ''}`} key={step}>
            <span>{index + 1}</span><strong>{step}</strong>
          </div>
        ))}
      </div>

      <main className="grid-layout doctor-layout">
        <section className="panel hero-panel doctor-queue">
          <div className="section-head">
            <div>
              <p className="eyebrow">doctor workspace</p>
              <h2>Patient lookup and care coordination</h2>
            </div>
          </div>
          <div className="search-row">
            <input
              value={lookupQuery}
              onChange={(e) => setLookupQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleLookup(); }}
              placeholder="Look up patient by ID (e.g. PT-1001), press Enter"
            />
          </div>
          {status && <p className="eyebrow" style={{ marginTop: '0.75rem' }}>{status}</p>}
        </section>

        <section className="panel">
          <p className="eyebrow">verified QR</p>
          <div className="qr-card">
            {qr?.qrCode ? <img src={qr.qrCode} alt="Doctor verification QR" /> : <div className="qr-placeholder">QR pending</div>}
            <p>{qr?.doctorName || doctor.name || 'Doctor'}</p>
            <small>{qr?.specialty || doctor.specialty || 'General medicine'} • {qr?.affiliation || doctor.affiliation || ''}</small>
            <div className="button-row" style={{ marginTop: '0.75rem' }}>
              <button className="primary small" onClick={handleGenerateQr}>Generate QR</button>
              <button className="secondary small" onClick={startQrScan}>Scan QR</button>
            </div>
            <video ref={videoRef} autoPlay playsInline muted style={{ width: '100%', borderRadius: '12px', background: '#081b1d', marginTop: '0.75rem' }} />
            <canvas ref={canvasRef} hidden />
          </div>
        </section>

        <section className="panel span-2">
          <p className="eyebrow">prescription photo — capture, scan, upload</p>
          <div className="prescribe-grid">
            <PrescriptionPhotoCapture
              accessToken={token}
              onUploaded={handlePrescriptionUploaded}
              onDraftReady={(draft) => draft?.text && setDraftPrescription(draft.text)}
            />
            <div className="preview-box">
              <h3>Transcription draft</h3>
              <label className="field-label">
                <span>Edit the draft before uploading (optional)</span>
                <textarea value={draftPrescription} onChange={(e) => setDraftPrescription(e.target.value)} rows={6} />
              </label>
              <ul>
                <li><strong>Drug:</strong> {aiCleaned.drug}</li>
                <li><strong>Dosage:</strong> {aiCleaned.dosage}</li>
                <li><strong>Frequency:</strong> {aiCleaned.frequency}</li>
                <li><strong>Duration:</strong> {aiCleaned.duration}</li>
              </ul>
              {lastPrescription && (
                <p className="rx-warning">
                  Uploaded as {lastPrescription.id} — {Math.round((lastPrescription.ocrConfidence || 0) * 100)}% OCR confidence,
                  awaiting pharmacist verification.
                </p>
              )}
              <small>Every transcription is reviewed by a pharmacist before dispensing. The photo stays attached as evidence.</small>
            </div>
          </div>
        </section>

        <section className="panel">
          <p className="eyebrow">patient history</p>
          <div className="list-stack">
            {(shownPatient?.diagnoses || []).slice(0, 3).map((item, index) => (
              <div key={`${item.code}-${index}`} className="detail-card">
                <div><strong>{item.title}</strong><small>{item.code}</small></div>
              </div>
            ))}
            {!shownPatient?.diagnoses?.length && (
              <EmptyState icon="🗂" title="No patient history" description="Consent-scoped records will appear here." />
            )}
          </div>
        </section>
      </main>
    </div>
  );
}