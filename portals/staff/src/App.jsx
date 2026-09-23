import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  adminLogin,
  listDoctorApplications,
  getDoctorApplication,
  approveDoctorApplication,
  rejectDoctorApplication,
  fetchDashboard,
  createGuestPatient,
  fileUrl
} from '../../shared/api.js';
import { useSession } from '../../shared/auth.js';
import { PortalHeader, EmptyState, pageTransition } from '../../shared/ui.jsx';

const PORTAL_ROLE = 'staff';
const ADMIN_ROLES = ['super_admin', 'clinic_admin', 'admin', 'staff'];

export default function App() {
  const { session, saveSession, signOut } = useSession(PORTAL_ROLE);
  const [adminLoginState, setAdminLoginState] = useState({ email: '', password: '', mfaCode: '' });
  const [error, setError] = useState('');
  const [mfaRequired, setMfaRequired] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleAdminLogin() {
    setBusy(true);
    setError('');
    try {
      const response = await adminLogin(adminLoginState);
      if (response.requiresMfa) {
        setMfaRequired(true);
        return;
      }
      if (!response.accessToken || !response.user) {
        setError('Unable to complete secure sign-in.');
        return;
      }
      saveSession({ user: response.user, accessToken: response.accessToken });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Secure sign-in failed.';
      if (message === 'MFA required') {
        setMfaRequired(true);
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  }

  if (!session) {
    return (
      <div className="portal-shell">
        <div className="app-shell role-staff">
          <AnimatePresence mode="wait">
            <motion.div key="staff-login" {...pageTransition}>
              <div className="auth-shell">
                <div className="auth-layout">
                  <section className="brand-panel">
                    <div className="brand-badge">Secure staff access</div>
                    <p className="eyebrow">staff portal</p>
                    <h1>Protected operational access</h1>
                    <p className="hero-copy">
                      This portal is restricted to verified administrative users. Review doctor
                      verification applications and manage clinic operations.
                    </p>
                    <div className="feature-list">
                      <div className="feature-item">
                        <span className="feature-check">✓</span>
                        <div><strong>Doctor verification queue</strong><small>Review documents and approve accounts.</small></div>
                      </div>
                      <div className="feature-item">
                        <span className="feature-check">✓</span>
                        <div><strong>MFA protected</strong><small>Email, password, and one-time code.</small></div>
                        </div>
                     </div>
                    <RoleHeroArt role="staff" />
                  </section>

                  <section className="panel login-panel">
                    <div className="login-status"><span className="status-pulse" /> Staff portal — role locked</div>
                    <div className="panel-header">
                      <div>
                        <p className="eyebrow">staff sign in</p>
                        <h2>Secure staff login</h2>
                      </div>
                    </div>

                    <div className="field-group">
                      <label>
                        Email
                        <input
                          type="email"
                          value={adminLoginState.email}
                          onChange={(e) => setAdminLoginState((prev) => ({ ...prev, email: e.target.value }))}
                          placeholder="admin@clinic.local"
                        />
                      </label>
                      <label>
                        Password
                        <input
                          type="password"
                          value={adminLoginState.password}
                          onChange={(e) => setAdminLoginState((prev) => ({ ...prev, password: e.target.value }))}
                          placeholder="Enter password"
                        />
                      </label>
                      {mfaRequired && (
                        <label>
                          MFA code
                          <input
                            type="text"
                            value={adminLoginState.mfaCode}
                            onChange={(e) => setAdminLoginState((prev) => ({ ...prev, mfaCode: e.target.value }))}
                            placeholder="123456"
                          />
                        </label>
                      )}
                    </div>

                    {error && <div className="error-banner">{error}</div>}

                    <div className="button-row">
                      <button className="primary" onClick={handleAdminLogin} disabled={busy}>
                        {busy ? 'Verifying…' : 'Continue securely'}
                      </button>
                    </div>
                  </section>
                </div>
              </div>
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    );
  }

  if (!ADMIN_ROLES.includes(String(session.user?.role).toLowerCase())) {
    return <div className="portal-shell"><div className="auth-shell"><div className="panel login-panel"><h2>Staff access required</h2><button className="primary" onClick={signOut}>Sign out</button></div></div></div>;
  }

  return <StaffWorkspace session={session} onSignOut={signOut} />;
}

function StaffWorkspace({ session, onSignOut }) {
  const token = session.accessToken;
  const [tab, setTab] = useState('applications');
  const [applications, setApplications] = useState([]);
  const [selected, setSelected] = useState(null);
  const [rejectReason, setRejectReason] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [dashboard, setDashboard] = useState({});
  const [walkInForm, setWalkInForm] = useState({ name: '', dob: '1995-05-15', phone: '', insurance: '' });

  const loadApplications = useCallback(async () => {
    try {
      const list = await listDoctorApplications(token);
      setApplications(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load applications');
    }
  }, [token]);

  useEffect(() => { loadApplications(); }, [loadApplications]);
  useEffect(() => { fetchDashboard(token).then(setDashboard).catch(() => {}); }, [token]);

  async function openApplication(id) {
    setError('');
    try {
      const detail = await getDoctorApplication(token, id);
      setSelected(detail);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open application');
    }
  }

  async function handleApprove(id) {
    setError('');
    try {
      const result = await approveDoctorApplication(token, id);
      setMessage(`Approved ${result.doctor.name}. Account created and QR generated.`);
      setSelected(null);
      loadApplications();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Approval failed');
    }
  }

  async function handleReject(id) {
    setError('');
    try {
      await rejectDoctorApplication(token, id, rejectReason || 'Documents could not be verified.');
      setMessage('Application rejected.');
      setSelected(null);
      setRejectReason('');
      loadApplications();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rejection failed');
    }
  }

  async function handleGuestCreate() {
    setError('');
    try {
      const patient = await createGuestPatient(token, walkInForm);
      setMessage(`Walk-in record created: ${patient.name}`);
      setWalkInForm({ name: '', dob: '1995-05-15', phone: '', insurance: '' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Walk-in creation failed');
    }
  }

  // Documents are served only through the authenticated file route, so mint a
  // short-lived, file-scoped token before opening one in a new tab.
  async function openDocument(doc) {
    try {
      const url = await fileUrl(token, doc.url);
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the document.');
    }
  }

  const pendingCount = applications.filter((a) => a.status === 'pending').length;
  const analytics = dashboard.analytics || { dailyVolume: 0, diagnosisBreakdown: [] };

  return (
    <div className="app-shell role-staff">
      <PortalHeader
        title="Clinic operations and verification"
        subtitle={session.user?.role === 'super_admin' ? 'Platform administration' : 'Clinic administration'}
        role="staff"
        onSignOut={onSignOut}
      />

      <nav className="workspace-nav" aria-label="Staff sections">
        <span className="workspace-nav-label">Staff</span>
        <button className={`workspace-nav-item ${tab === 'applications' ? 'active' : ''}`} onClick={() => setTab('applications')}>Doctor applications</button>
        <button className={`workspace-nav-item ${tab === 'console' ? 'active' : ''}`} onClick={() => setTab('console')}>Admin console</button>
      </nav>

      {message && <div className="status-banner approved">{message}</div>}
      {error && <div className="error-banner">{error}</div>}

      {tab === 'applications' && (
        <main className="grid-layout">
          <section className="panel span-2 hero-panel">
            <div className="section-head">
              <div>
                <p className="eyebrow">doctor verification queue</p>
                <h2>Review applications and approve accounts</h2>
              </div>
              <button className="secondary small" onClick={loadApplications}>Refresh</button>
            </div>
            <div className="stats-grid">
              <div className="stat-card"><span>Pending</span><strong>{pendingCount}</strong></div>
              <div className="stat-card"><span>Total applications</span><strong>{applications.length}</strong></div>
              <div className="stat-card"><span>Access level</span><strong>{session.user?.role}</strong></div>
              <div className="stat-card"><span>Clinic scope</span><strong>{session.user?.clinicId || 'System-wide'}</strong></div>
            </div>
          </section>

          <section className="panel span-2">
            <p className="eyebrow">applications</p>
            <div className="list-stack">
              {applications.length ? applications.map((application) => (
                <div key={application.id} className="detail-card">
                  <div>
                    <strong>{application.name}</strong>
                    <small>
                      {application.specialty} • {application.licenseNumber} •{' '}
                      <span className={`tag-${application.status}`}>{application.status}</span>
                    </small>
                  </div>
                  <div className="inline-actions">
                    <button className="secondary small" onClick={() => openApplication(application.id)}>Review documents</button>
                    {application.status === 'pending' && (
                      <button className="primary small" onClick={() => handleApprove(application.id)}>Approve</button>
                    )}
                  </div>
                </div>
              )) : (
                <EmptyState icon="🎓" title="No doctor applications" description="New verification requests from the doctor portal will appear here." />
              )}
            </div>
          </section>

          {selected && (
            <section className="panel span-2">
              <div className="review-card">
                <div className="review-card-head">
                  <div>
                    <p className="eyebrow">application detail</p>
                    <h2>{selected.name}</h2>
                    <div className="review-meta">
                      <span>{selected.email}</span>
                      <span>{selected.specialty}</span>
                      <span>Licence {selected.licenseNumber}</span>
                      <span className={`tag-${selected.status}`}>{selected.status}</span>
                    </div>
                  </div>
                  <button className="secondary small" onClick={() => setSelected(null)}>Close</button>
                </div>

                <p><strong>Affiliation:</strong> {selected.affiliation}</p>
                <p><strong>Submitted:</strong> {selected.submittedAt ? new Date(selected.submittedAt).toLocaleString() : ''}</p>

                <p className="eyebrow">documents</p>
                {(selected.documents || []).length ? (
                  <ul className="document-list">
                    {selected.documents.map((doc) => (
                      <li key={doc.filename}>
                        <span>{doc.originalName}</span>
                        <a href="#" onClick={(event) => { event.preventDefault(); openDocument(doc); }}>Open</a>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <small>No documents uploaded.</small>
                )}

                {selected.status === 'pending' && (
                  <>
                    <div className="button-row" style={{ marginTop: '1rem' }}>
                      <button className="primary" onClick={() => handleApprove(selected.id)}>Approve & create account</button>
                    </div>
                    <label className="field-label">
                      <span>Rejection reason</span>
                      <input value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="e.g. Licence document unreadable" />
                    </label>
                    <div className="button-row">
                      <button className="danger" onClick={() => handleReject(selected.id)}>Reject application</button>
                    </div>
                  </>
                )}
              </div>
            </section>
          )}
        </main>
      )}

      {tab === 'console' && (
        <main className="grid-layout">
          <section className="panel hero-panel">
            <div className="section-head">
              <div>
                <p className="eyebrow">staff console</p>
                <h2>{session.user?.role === 'super_admin' ? 'Platform administration' : 'Clinic administration'}</h2>
              </div>
            </div>
            <div className="stats-grid">
              <div className="stat-card"><span>Daily volume</span><strong>{analytics.dailyVolume || 0}</strong></div>
              <div className="stat-card"><span>Pending doctors</span><strong>{pendingCount}</strong></div>
              <div className="stat-card"><span>Audit events</span><strong>{(dashboard.audit || []).length}</strong></div>
              <div className="stat-card"><span>Sync queue</span><strong>{(dashboard.queue || []).length}</strong></div>
            </div>
          </section>

          <section className="panel">
            <p className="eyebrow">walk-in / unclaimed patient</p>
            <div className="field-group compact">
              <label>Name<input value={walkInForm.name} onChange={(e) => setWalkInForm({ ...walkInForm, name: e.target.value })} /></label>
              <label>DOB<input type="date" value={walkInForm.dob} onChange={(e) => setWalkInForm({ ...walkInForm, dob: e.target.value })} /></label>
              <label>Phone<input value={walkInForm.phone} onChange={(e) => setWalkInForm({ ...walkInForm, phone: e.target.value })} /></label>
              <label>Insurance<input value={walkInForm.insurance} onChange={(e) => setWalkInForm({ ...walkInForm, insurance: e.target.value })} /></label>
            </div>
            <div className="button-row">
              <button className="primary" onClick={handleGuestCreate}>Create walk-in record</button>
            </div>
          </section>

          <section className="panel span-2">
            <p className="eyebrow">clinic metrics</p>
            <div className="analytics-grid">
              {(analytics.diagnosisBreakdown || []).map((entry) => (
                <div key={entry.label} className="metric-box">
                  <span>{entry.label}</span>
                  <strong>{entry.value}%</strong>
                </div>
              ))}
              {!(analytics.diagnosisBreakdown || []).length && (
                <EmptyState icon="📊" title="No metrics yet" description="Clinic analytics will appear once activity is recorded." />
              )}
            </div>
          </section>
        </main>
      )}
    </div>
  );
}