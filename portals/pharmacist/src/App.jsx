import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  login,
  submitDoctorApplication,
  fetchApplicationStatus,
  fetchDashboard,
  confirmPrescription,
  correctPrescription,
  fileUrl
} from '../../shared/api.js';
import { useSession, roleAllowed, sessionFromAuth } from '../../shared/auth.js';
import { PortalHeader, RoleLockedNotice, EmptyState, pageTransition, GoogleSignInButton, RoleHeroArt } from '../../shared/ui.jsx';

const PORTAL_ROLE = 'pharmacist';
const ALLOWED_ROLES = ['pharmacist'];

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
  const [tab, setTab] = useState('signin');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [signIn, setSignIn] = useState({ email: 'pharmacist.demo@medrec.local', password: 'Password123!' });
  // Verification application (staff approval only — pharmacists cannot self-register).
  const [applyForm, setApplyForm] = useState({
    firstName: '',
    lastName: '',
    email: '',
    password: '',
    specialty: 'Community pharmacy',
    licenseNumber: ''
  });
  const [submittedEmail, setSubmittedEmail] = useState('');
  const [applicationStatus, setApplicationStatus] = useState(null);

  async function handleSignIn() {
    setBusy(true); setError('');
    try {
      const data = await login(signIn.email.trim(), signIn.password);
      if (!roleAllowed(data.user?.role, ALLOWED_ROLES)) {
        setError('This portal is for pharmacists only. Use the portal that matches your role.');
        return;
      }
      saveSession(sessionFromAuth(data));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed');
    } finally { setBusy(false); }
  }

  // Pharmacist logins are created only by staff approval of a verification
  // application, so this portal submits the application instead of registering
  // an account (the API refuses pharmacist self-registration).
  async function handleApply() {
    setBusy(true); setError('');
    try {
      const formData = new FormData();
      formData.append('role', PORTAL_ROLE);
      Object.entries(applyForm).forEach(([key, value]) => formData.append(key, value));

      const result = await submitDoctorApplication(formData);
      setSubmittedEmail(applyForm.email.trim().toLowerCase());
      setApplicationStatus({ status: 'pending', ...result.application });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Application submission failed');
    } finally { setBusy(false); }
  }

  async function refreshApplicationStatus() {
    if (!submittedEmail) { setError('Submit an application first, then check its status.'); return; }
    try {
      const status = await fetchApplicationStatus(submittedEmail);
      setApplicationStatus((prev) => ({ ...prev, ...status }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not refresh status');
    }
  }

  // Google cannot create a pharmacist login — the backend allows patient
  // self-service only. The identity pre-fills the application for staff review.
  function handleGoogleToken(idToken) {
    const claims = decodeJwtPayload(idToken);
    setTab('apply');
    setError('Google accounts cannot create pharmacist logins directly. Complete the verification application — staff review your licence before the account is activated.');
    setApplyForm((prev) => ({
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
            <motion.div key={tab} {...pageTransition}>
              <div className="auth-shell">
                <div className="auth-layout">
                  <section className="brand-panel">
                    <div className="brand-badge">MedRec Pharmacist Portal</div>
                    <p className="eyebrow">dispensing review</p>
                    <h1>Verify every prescription.</h1>
                    <p className="hero-copy">
                      Review AI-assisted transcription against the original, check interaction
                      warnings, and confirm or flag before dispensing.
                    </p>
                    <RoleHeroArt role="pharmacist" />
                  </section>

                  <section className="panel login-panel">
                    <div className="login-status"><span className="status-pulse" /> Pharmacist portal — role locked</div>
                    <div className="panel-header">
                      <div>
                        <p className="eyebrow">{tab === 'signin' ? 'pharmacist sign in' : 'verification application'}</p>
                        <h2>{tab === 'signin' ? 'Welcome back' : 'Apply for pharmacist access'}</h2>
                      </div>
                    </div>

                    {applicationStatus && (
                      <div className={`status-banner ${applicationStatus.status}`}>
                        Application {applicationStatus.status} — {applicationStatus.name}
                      </div>
                    )}

                    <div className="field-group">
                      {tab === 'apply' && (
                        <>
                          <label>First name<input value={applyForm.firstName} onChange={(e) => setApplyForm({ ...applyForm, firstName: e.target.value })} /></label>
                          <label>Last name<input value={applyForm.lastName} onChange={(e) => setApplyForm({ ...applyForm, lastName: e.target.value })} /></label>
                        </>
                      )}
                      <label>Email<input type="email" value={tab === 'signin' ? signIn.email : applyForm.email} onChange={(e) => tab === 'signin' ? setSignIn({ ...signIn, email: e.target.value }) : setApplyForm({ ...applyForm, email: e.target.value })} /></label>
                      <label>Password<input type="password" value={tab === 'signin' ? signIn.password : applyForm.password} onChange={(e) => tab === 'signin' ? setSignIn({ ...signIn, password: e.target.value }) : setApplyForm({ ...applyForm, password: e.target.value })} /></label>
                      {tab === 'apply' && (
                        <>
                          <label>Pharmacy / discipline<input value={applyForm.specialty} onChange={(e) => setApplyForm({ ...applyForm, specialty: e.target.value })} /></label>
                          <label>Licence number<input placeholder="PHA-00000" value={applyForm.licenseNumber} onChange={(e) => setApplyForm({ ...applyForm, licenseNumber: e.target.value })} /></label>
                        </>
                      )}
                    </div>

                    {error && <div className="error-banner">{error}</div>}

                    <div className="button-row">
                      {tab === 'signin' ? (
                        <>
                          <button className="primary" onClick={handleSignIn} disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
                          <button className="secondary" onClick={() => { setTab('apply'); setError(''); }}>Apply for verification</button>
                        </>
                      ) : (
                        <>
                          <button className="primary" onClick={handleApply} disabled={busy}>{busy ? 'Submitting…' : 'Submit application'}</button>
                          <button className="secondary" onClick={refreshApplicationStatus} disabled={!submittedEmail}>Check status</button>
                          <button className="secondary" onClick={() => { setTab('signin'); setError(''); }}>Back to sign in</button>
                        </>
                      )}
                    </div>

                    <div className="auth-divider"><span>or</span></div>
                    <GoogleSignInButton
                      label="Continue with Google to apply"
                      onToken={handleGoogleToken}
                      onError={(err) => setError(err instanceof Error ? err.message : 'Google sign-in failed')}
                    />
                    <p className="eyebrow" style={{ marginTop: '0.5rem' }}>
                      Pharmacist accounts are created only after staff approve your licence, so Google pre-fills the application instead of signing you in.
                    </p>
                  </section>
                </div>
              </div>
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    );
  }

  if (!roleAllowed(session.user?.role, ALLOWED_ROLES)) {
    return <div className="portal-shell"><RoleLockedNotice portalRole="pharmacist" onSignOut={signOut} /></div>;
  }

  return <PharmacistWorkspace session={session} onSignOut={signOut} />;
}

function PharmacistWorkspace({ session, onSignOut }) {
  const token = session.accessToken;
  const [dashboard, setDashboard] = useState({});
  const [status, setStatus] = useState('');
  const [flagNote, setFlagNote] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [verifiedDraft, setVerifiedDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [imageUrl, setImageUrl] = useState(null);
  const [queueSearch, setQueueSearch] = useState('');

  function load() {
    fetchDashboard(token).then(setDashboard).catch(() => {});
  }

  useEffect(() => { load(); }, [token]);

  const prescriptions = dashboard.prescriptions || [];
  const queueSearchTerm = queueSearch.trim().toLowerCase();
  const visiblePrescriptions = queueSearchTerm
    ? prescriptions.filter((item) => [item.id, item.patientId, item.doctorId, item.cleaned?.drug, item.original]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(queueSearchTerm)))
    : prescriptions;
  const active = prescriptions.find((item) => item.id === selectedId) || prescriptions[0] || {
    id: null,
    original: 'No prescription loaded yet',
    cleaned: null,
    status: 'pending-confirmation'
  };

  useEffect(() => {
    setVerifiedDraft(active.verifiedText || active.ocrRawText || '');
  }, [active.id, active.verifiedText, active.ocrRawText]);

  // <img> cannot send headers, so exchange the session token for a
  // short-lived, file-scoped token whenever the previewed photo changes.
  useEffect(() => {
    let cancelled = false;
    if (token && active.originalImageUrl) {
      fileUrl(token, active.originalImageUrl)
        .then((url) => { if (!cancelled) setImageUrl(url); })
        .catch(() => { if (!cancelled) setImageUrl(null); });
    } else {
      setImageUrl(null);
    }
    return () => { cancelled = true; };
  }, [token, active.originalImageUrl]);

  async function handleDecision(decision) {
    if (!active.id) { setStatus('No prescription selected.'); return; }
    try {
      await confirmPrescription(token, active.id, decision);
      setStatus(decision === 'confirmed' ? 'Prescription confirmed and ready for dispensing.' : 'Prescription flagged for clinician review.');
      load();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Decision failed');
    }
  }

  async function handleSaveCorrection() {
    if (!active.id || !verifiedDraft.trim()) { setStatus('Nothing to save — enter the verified transcription.'); return; }
    setSaving(true);
    try {
      await correctPrescription(token, active.id, verifiedDraft.trim());
      setStatus('Human-verified transcription saved. Review, then confirm or flag.');
      load();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Correction failed');
    } finally {
      setSaving(false);
    }
  }

  const confidence = active.ocrConfidence ?? 0;
  const confidenceLabel = confidence >= 0.8 ? 'high' : confidence >= 0.6 ? 'medium' : 'low';

  return (
    <div className="app-shell role-pharmacist">
      <PortalHeader title="Prescription verification" subtitle="Dispense review workspace" role="pharmacist" onSignOut={onSignOut} />

      <div className="care-flow">
        {['Prescription queue', 'Safety review', 'Dispense decision'].map((step, index) => (
          <div className={`care-flow-step ${index === 0 ? 'active' : ''}`} key={step}>
            <span>{index + 1}</span><strong>{step}</strong>
          </div>
        ))}
      </div>

      {status && <div className="status-banner approved">{status}</div>}

      <main className="grid-layout">
        <section className="panel hero-panel">
          <div className="section-head">
            <div>
              <p className="eyebrow">dispense review</p>
              <h2>Prescription verification</h2>
            </div>
            {active.id && (
              <div className="review-meta">
                <span>{active.id}</span>
                <span className={`ocr-chip ocr-${confidenceLabel}`}>OCR {Math.round(confidence * 100)}% ({confidenceLabel})</span>
                <span className={`tag-${active.reviewStatus || active.status}`}>{active.reviewStatus || active.status}</span>
              </div>
            )}
          </div>
          <div className="search-row">
            <input
              value={queueSearch}
              onChange={(e) => setQueueSearch(e.target.value)}
              placeholder="Scan or search by patient / RX ID"
            />
          </div>
        </section>

        <section className="panel span-2">
          <p className="eyebrow">original photo vs verified transcription</p>
          <div className="prescribe-grid">
            <div className="preview-box">
              <h3>Original prescription photo</h3>
              {imageUrl ? (
                <img src={imageUrl} alt="Original handwritten prescription" className="rx-preview" />
              ) : (
                <p>{active.original || 'No image loaded yet'}</p>
              )}
            </div>
            <div className="preview-box warning-box">
              <h3>Transcription — {active.reviewStatus === 'human-verified' ? 'human verified' : 'pending verification'}</h3>
              <ul>
                <li><strong>Drug:</strong> {active.cleaned?.drug || '—'}</li>
                <li><strong>Dosage:</strong> {active.cleaned?.dosage || '—'}</li>
                <li><strong>Frequency:</strong> {active.cleaned?.frequency || '—'}</li>
                <li><strong>Duration:</strong> {active.cleaned?.duration || '—'}</li>
              </ul>
              {(active.ocrWarnings || []).length > 0 && (
                <ul className="rx-quality-warnings">
                  {active.ocrWarnings.map((warning) => <li key={warning}>{warning}</li>)}
                </ul>
              )}
              <label className="field-label">
                <span>Verified transcription (becomes the official soft copy)</span>
                <textarea
                  rows={4}
                  value={verifiedDraft}
                  onChange={(e) => setVerifiedDraft(e.target.value)}
                  placeholder="Check the photo, then type the exact intended prescription…"
                />
              </label>
              <div className="button-row">
                <button className="secondary small" disabled={!active.id || saving} onClick={handleSaveCorrection}>
                  {saving ? 'Saving…' : 'Save verified text'}
                </button>
              </div>
            </div>
          </div>
        </section>

        <section className="panel">
          <p className="eyebrow">interaction warnings</p>
          <div className="warning-box">
            <strong>Medication safety</strong>
            <p>{active.safety?.warnings?.[0] || 'No automated warnings for the current transcription.'}</p>
          </div>
          <div className="button-row">
            <button className="primary" onClick={() => handleDecision('confirmed')} disabled={!active.id}>Confirm</button>
            <button className="danger" onClick={() => handleDecision('flagged')} disabled={!active.id}>Flag mismatch</button>
          </div>
          <label className="field-label">
            <span>Flag comment</span>
            <textarea rows={4} value={flagNote} onChange={(e) => setFlagNote(e.target.value)} placeholder="Add note for clinical follow-up…" />
          </label>
        </section>

        <section className="panel span-2">
          <p className="eyebrow">queue</p>
          <div className="list-stack">
            {visiblePrescriptions.length ? visiblePrescriptions.map((item) => (
              <div key={item.id} className="detail-card">
                <button type="button" className="queue-row" onClick={() => setSelectedId(item.id)}>
                  <div>
                    <strong>{item.cleaned?.drug || item.original || 'Medication'}</strong>
                    <small>{item.cleaned?.dosage} • {item.cleaned?.frequency} • {item.cleaned?.duration}</small>
                  </div>
                  <span className={`ocr-chip ocr-${(item.ocrConfidence ?? 0) >= 0.8 ? 'high' : (item.ocrConfidence ?? 0) >= 0.6 ? 'medium' : 'low'}`}>
                    {Math.round((item.ocrConfidence ?? 0) * 100)}%
                  </span>
                </button>
                <span className="status-chip">{item.status}</span>
              </div>
            )) : (
              <EmptyState icon="💊" title={queueSearchTerm ? 'No matching prescriptions' : 'No prescriptions in queue'} description={queueSearchTerm ? 'No queue entries match your search — clear the field to see the full queue.' : 'Prescription photos submitted by doctors appear here for verification.'} />
            )}
          </div>
        </section>
      </main>
    </div>
  );
}