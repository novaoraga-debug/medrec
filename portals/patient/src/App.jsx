import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import jsQR from 'jsqr';
import {
  login,
  register,
  googleLogin,
  fetchDashboard,
  requestConsent,
  decideConsent,
  exportFhir,
  queueOfflineSync,
  verifyDoctorToken
} from '../../shared/api.js';
import { useSession, roleAllowed, sessionFromAuth } from '../../shared/auth.js';
import { PortalHeader, RoleLockedNotice, EmptyState, pageTransition, GoogleSignInButton } from '../../shared/ui.jsx';

const PORTAL_ROLE = 'patient';
const ALLOWED_ROLES = ['patient'];

export default function App() {
  const { session, saveSession, signOut } = useSession(PORTAL_ROLE);
  const [tab, setTab] = useState('signin'); // signin | register
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [signIn, setSignIn] = useState({
    email: import.meta.env.DEV ? 'qa.user.2026@example.com' : '',
    password: import.meta.env.DEV ? 'Password123!' : ''
  });
  const [signUp, setSignUp] = useState({ firstName: '', lastName: '', email: '', password: '' });

  async function handleSignIn() {
    setBusy(true); setError('');
    try {
      const data = await login(signIn.email.trim(), signIn.password);
      if (!roleAllowed(data.user?.role, ALLOWED_ROLES)) {
        setError('This portal is for patients only. Use the portal that matches your role.');
        return;
      }
      saveSession(sessionFromAuth(data));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed');
    } finally { setBusy(false); }
  }

  async function handleRegister() {
    setBusy(true); setError('');
    try {
      const data = await register({ ...signUp, role: 'patient' });
      if (!roleAllowed(data.user?.role, ALLOWED_ROLES)) {
        setError('This portal is for patients only.');
        return;
      }
      saveSession(sessionFromAuth(data));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    } finally { setBusy(false); }
  }

  // Google sign-in is self-service for patients: an existing patient signs in,
  // a new Google account is registered as a patient automatically.
  async function handleGoogleToken(idToken) {
    setBusy(true); setError('');
    try {
      const data = await googleLogin({ idToken, role: PORTAL_ROLE });
      if (!roleAllowed(data.user?.role, ALLOWED_ROLES)) {
        setError('This portal is for patients only. Use the portal that matches your role.');
        return;
      }
      saveSession(sessionFromAuth(data));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google sign-in failed');
    } finally { setBusy(false); }
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
                    <div className="brand-badge">MedRec Patient Portal</div>
                    <p className="eyebrow">your health, in your hands</p>
                    <h1>Connected records for your care.</h1>
                    <p className="hero-copy">
                      Secure access to appointments, prescriptions, consent, and verifiable clinician
                      identity — all in one place.
                    </p>
                    <RoleHeroArt role="patient" />
                  </section>

                  <section className="panel login-panel">
                    <div className="login-status"><span className="status-pulse" /> Patient portal — role locked</div>
                    <div className="panel-header">
                      <div>
                        <p className="eyebrow">{tab === 'signin' ? 'patient sign in' : 'create account'}</p>
                        <h2>{tab === 'signin' ? 'Welcome back' : 'Register as a patient'}</h2>
                      </div>
                    </div>

                    <div className="field-group">
                      {tab === 'register' && (
                        <>
                          <label>First name<input value={signUp.firstName} onChange={(e) => setSignUp({ ...signUp, firstName: e.target.value })} /></label>
                          <label>Last name<input value={signUp.lastName} onChange={(e) => setSignUp({ ...signUp, lastName: e.target.value })} /></label>
                        </>
                      )}
                      <label>Email<input type="email" value={tab === 'signin' ? signIn.email : signUp.email} onChange={(e) => tab === 'signin' ? setSignIn({ ...signIn, email: e.target.value }) : setSignUp({ ...signUp, email: e.target.value })} /></label>
                      <label>Password<input type="password" value={tab === 'signin' ? signIn.password : signUp.password} onChange={(e) => tab === 'signin' ? setSignIn({ ...signIn, password: e.target.value }) : setSignUp({ ...signUp, password: e.target.value })} /></label>
                    </div>

                    {error && <div className="error-banner">{error}</div>}

                    <div className="button-row">
                      {tab === 'signin' ? (
                        <>
                          <button className="primary" onClick={handleSignIn} disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
                          <button className="secondary" onClick={() => { setTab('register'); setError(''); }}>Create account</button>
                        </>
                      ) : (
                        <>
                          <button className="primary" onClick={handleRegister} disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
                          <button className="secondary" onClick={() => { setTab('signin'); setError(''); }}>Back to sign in</button>
                        </>
                      )}
                    </div>

                    <div className="auth-divider"><span>or</span></div>
                    <GoogleSignInButton
                      onToken={handleGoogleToken}
                      onError={(err) => setError(err instanceof Error ? err.message : 'Google sign-in failed')}
                    />
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
    return <div className="portal-shell"><RoleLockedNotice portalRole="patient" onSignOut={signOut} /></div>;
  }

  return <PatientWorkspace session={session} onSignOut={signOut} />;
}

function PatientWorkspace({ session, onSignOut }) {
  const token = session.accessToken;
  const [dashboard, setDashboard] = useState({});
  const [consentForm, setConsentForm] = useState({ patientId: 'PT-1001', provider: 'Dr. Priya Shah', purpose: 'Cardiology referral summary' });
  const [fhirBundle, setFhirBundle] = useState(null);
  const [status, setStatus] = useState('');
  const [scanStatus, setScanStatus] = useState('QR scanner ready');
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const scanLoopRef = useRef(null);

  useEffect(() => { fetchDashboard(token).then(setDashboard).catch(() => {}); }, [token]);

  const patient = dashboard.patient || {};
  const prescriptions = dashboard.prescriptions || [];
  const consents = dashboard.consentRequests || [];

  const stopCamera = () => {
    if (scanLoopRef.current) { window.clearTimeout(scanLoopRef.current); scanLoopRef.current = null; }
    if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
    if (videoRef.current) videoRef.current.srcObject = null;
  };
  useEffect(() => () => stopCamera(), []);

  async function startQrScan() {
    if (!navigator.mediaDevices?.getUserMedia) { setScanStatus('Camera not available.'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      streamRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
      const canvas = canvasRef.current ?? document.createElement('canvas');
      canvasRef.current = canvas;
      setScanStatus('Camera active. Point at a doctor QR code…');
      const scanFrame = () => {
        const video = videoRef.current;
        const context = canvas.getContext('2d');
        if (!video || !context || video.readyState < 2) { scanLoopRef.current = window.setTimeout(scanFrame, 250); return; }
        const width = video.videoWidth || 640; const height = video.videoHeight || 480;
        canvas.width = width; canvas.height = height;
        context.drawImage(video, 0, 0, width, height);
        const image = context.getImageData(0, 0, width, height);
        const code = jsQR(image.data, image.width, image.height, { inversionAttempts: 'attemptBoth' });
        if (code) {
          stopCamera();
          try {
            const parsed = JSON.parse(code.data);
            verifyDoctorToken(parsed?.token || code.data)
              .then((result) => setScanStatus(`${result.name} verified: ${result.specialty}`))
              .catch(() => setScanStatus('QR detected, but not a valid MedRec doctor token.'));
          } catch { setScanStatus('QR detected, but not a valid MedRec doctor token.'); }
          return;
        }
        scanLoopRef.current = window.setTimeout(scanFrame, 250);
      };
      scanFrame();
    } catch { setScanStatus('Camera permission denied.'); }
  }

  async function handleConsentRequest() {
    try { await requestConsent(token, consentForm); setStatus('Consent request sent.'); }
    catch (err) { setStatus(err instanceof Error ? err.message : 'Consent request failed'); }
  }

  async function handleConsentDecision(id, decision) {
    try { await decideConsent(token, id, decision); setStatus('Consent updated.'); }
    catch (err) { setStatus(err instanceof Error ? err.message : 'Consent update failed'); }
  }

  async function handleExportFhir() {
    if (!patient?.id) return;
    try { setFhirBundle(await exportFhir(token, patient.id)); }
    catch (err) { setStatus(err instanceof Error ? err.message : 'FHIR export failed'); }
  }

  async function handleOfflineSync() {
    try {
      await queueOfflineSync(token, { type: 'patient-record-sync', recordId: patient?.id || 'PT-1001', recordType: 'patient-record', payload: { status: 'queued' } });
      setStatus('Queued offline sync.');
    } catch (err) { setStatus(err instanceof Error ? err.message : 'Offline sync failed'); }
  }

  return (
    <div className="app-shell role-patient">
      <PortalHeader title="Your health overview" subtitle="Consent-aware patient workspace" role="patient" onSignOut={onSignOut} />

      {status && <div className="status-banner approved">{status}</div>}

      <main className="grid-layout patient-layout">
        <section className="panel hero-panel patient-hero">
          <div className="section-head">
            <div>
              <p className="eyebrow">home</p>
              <h2>{patient?.name || 'Your health overview'}</h2>
            </div>
          </div>
          <div className="stats-grid">
            <div className="stat-card"><span>MRN</span><strong>{patient?.mrn || '—'}</strong></div>
            <div className="stat-card"><span>Active prescriptions</span><strong>{prescriptions.length}</strong></div>
            <div className="stat-card"><span>Allergies</span><strong>{(patient?.allergies || []).length}</strong></div>
            <div className="stat-card"><span>Home clinic</span><strong>{patient?.homeClinic || '—'}</strong></div>
          </div>
        </section>

        <section className="panel patient-section">
          <p className="eyebrow">records</p>
          <div className="list-stack">
            {(patient?.diagnoses || []).map((item, index) => (
              <div key={`${item.code}-${index}`} className="detail-card"><div><strong>{item.title}</strong><small>{item.code}</small></div></div>
            ))}
            {(patient?.allergies || []).map((item) => (
              <div key={item} className="detail-card muted"><span>Allergy: {item}</span></div>
            ))}
            {!patient?.diagnoses?.length && !patient?.allergies?.length && (
              <EmptyState icon="📋" title="No record notes yet" description="Diagnoses and allergies appear here once a clinician adds them." />
            )}
          </div>
        </section>

        <section className="panel patient-section">
          <p className="eyebrow">consent manager</p>
          <div className="field-group compact">
            <label>Provider<input value={consentForm.provider} onChange={(e) => setConsentForm({ ...consentForm, provider: e.target.value })} /></label>
            <label>Purpose<input value={consentForm.purpose} onChange={(e) => setConsentForm({ ...consentForm, purpose: e.target.value })} /></label>
          </div>
          <div className="button-row"><button className="primary small" onClick={handleConsentRequest}>Request access</button></div>
          <div className="list-stack">
            {consents.map((request) => (
              <div key={request.id} className="detail-card">
                <div><strong>{request.provider}</strong><small>{request.purpose}</small></div>
                <div className="inline-actions">
                  <button className="secondary small" onClick={() => handleConsentDecision(request.id, 'approved')}>Grant</button>
                  <button className="danger small" onClick={() => handleConsentDecision(request.id, 'revoked')}>Revoke</button>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="panel span-2 patient-section">
          <p className="eyebrow">active prescriptions</p>
          <div className="list-stack">
            {prescriptions.length ? prescriptions.map((item) => (
              <div key={item.id} className="detail-card">
                <div>
                  <strong>{item.cleaned?.drug || 'Medication'}</strong>
                  <small>{item.cleaned?.dosage} • {item.cleaned?.frequency} • {item.cleaned?.duration}</small>
                </div>
                <span className="status-chip">{item.status}</span>
              </div>
            )) : (
              <EmptyState icon="💊" title="No active prescriptions" description="Prescriptions from your doctor appear here." />
            )}
          </div>
          <div className="button-row" style={{ marginTop: '1rem' }}>
            <button className="primary small" onClick={handleOfflineSync}>Queue offline sync</button>
            <button className="secondary small" onClick={handleExportFhir}>Export FHIR bundle</button>
          </div>
        </section>

        <section className="panel patient-section">
          <p className="eyebrow">scan doctor QR</p>
          <div className="button-row"><button className="primary small" onClick={startQrScan}>Open camera scanner</button></div>
          <div className="qr-card" style={{ marginTop: '1rem' }}>
            <video ref={videoRef} autoPlay playsInline muted style={{ width: '100%', borderRadius: '12px', background: '#081b1d' }} />
            <canvas ref={canvasRef} hidden />
            <small>{scanStatus}</small>
          </div>
        </section>

        {fhirBundle && (
          <section className="panel span-2">
            <p className="eyebrow">FHIR bundle</p>
            <pre>{JSON.stringify(fhirBundle, null, 2)}</pre>
          </section>
        )}
      </main>
    </div>
  );
}