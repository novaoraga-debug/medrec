import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import jsQR from 'jsQR';
import { useEffect, useMemo, useRef, useState } from 'react';

type Role = 'patient' | 'doctor' | 'pharmacist' | 'admin' | 'super_admin' | 'clinic_admin';

type DashboardData = {
  patient?: any;
  doctor?: any;
  prescriptions?: any[];
  notifications?: any[];
  audit?: any[];
  analytics?: any;
  labs?: any[];
  payments?: any[];
  referrals?: any[];
  consentRequests?: any[];
  queue?: any[];
};

type AuthState = {
  user: {
    id: string;
    email: string;
    role: Role;
    firstName?: string;
    lastName?: string;
  };
  accessToken: string;
};

const publicRoleOptions: Role[] = ['patient', 'doctor', 'pharmacist'];
const allRoleOptions: Role[] = ['patient', 'doctor', 'pharmacist', 'admin'];
const samplePrescription = `Amoxicillin 500mg twice daily for 5 days\nFinish the course unless directed otherwise\nMonitor for rash or GI upset`;

function createDemoAccountEmail(role: Role): string {
  const stamp = Date.now().toString().slice(-6);
  return `new.${role}.${stamp}@medrec.demo`;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: false,
      staleTime: 30000
    }
  }
});

const API_BASE_URL = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '') ||
  (typeof window !== 'undefined' && ['5173', '5174', '4173'].includes(window.location.port)
    ? 'http://localhost:4000'
    : '');

function handleDemoAction(action: string, detail?: string) {
  alert(detail ? `${action}: ${detail}` : action);
}

async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const url = path.startsWith('http') ? path : `${API_BASE_URL}${path}`;

  try {
    const response = await fetch(url, options);
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await response.json() : await response.text();

    if (!response.ok) {
      const message = typeof payload === 'object' && payload && 'error' in payload
        ? String((payload as { error?: string }).error)
        : typeof payload === 'string' && payload
          ? payload
          : 'Request failed';
      throw new Error(message);
    }

    return payload as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Request failed';
    throw new Error(message || 'Request failed');
  }
}

async function fetchDashboard(token: string): Promise<DashboardData> {
  return apiRequest<DashboardData>('/api/dashboard', {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
}

async function getDoctorQr(token: string): Promise<{ qrCode?: string } | null> {
  try {
    return await apiRequest<{ qrCode?: string }>('/api/doctors/qr?doctorId=DR-2001', {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
  } catch {
    return null;
  }
}

const pageTransition = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
  transition: { duration: 0.2, ease: 'easeOut' as const }
};

function SkeletonBlock({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden="true" />;
}

function EmptyState({ icon, title, description, actionLabel, onAction }: any) {
  return (
    <motion.div
      className="empty-state"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
    >
      <div className="empty-state-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {actionLabel && (
        <button className="primary small" onClick={onAction}>{actionLabel}</button>
      )}
    </motion.div>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <HealthcareApp />
    </QueryClientProvider>
  );
}

function HealthcareApp() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [adminSession, setAdminSession] = useState<any>(null);
  const [selectedRole, setSelectedRole] = useState<Role>('patient');
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [currentRoute, setCurrentRoute] = useState(typeof window !== 'undefined' ? window.location.pathname : '/');
  const [signIn, setSignIn] = useState({
    email: 'qa.user.2026@example.com',
    password: 'Password123!',
    firstName: 'QA',
    lastName: 'User',
    role: 'patient' as Role
  });
  const [showProfileForm, setShowProfileForm] = useState(false);
  const [adminLogin, setAdminLogin] = useState({ email: '', password: '', mfaCode: '' });
  const [adminError, setAdminError] = useState('');
  const [adminMfaRequired, setAdminMfaRequired] = useState(false);
  const [draftPrescription, setDraftPrescription] = useState(samplePrescription);
  const [doctorProfile, setDoctorProfile] = useState({
    firstName: 'Priya',
    lastName: 'Shah',
    specialty: 'General Medicine',
    licenseNumber: 'MED-44783',
    affiliation: 'Nairobi Partners Clinic'
  });
  const [consentForm, setConsentForm] = useState({
    patientId: 'PT-1001',
    provider: 'Dr. Priya Shah',
    purpose: 'Cardiology referral summary'
  });
  const [fhirBundle, setFhirBundle] = useState<any>(null);
  const [syncStatus, setSyncStatus] = useState('Saved locally');
  const [walkInForm, setWalkInForm] = useState({ name: 'Walk-in patient', dob: '1995-05-15', phone: '+254700000001', insurance: 'Walk-in / no insurance' });
  const [appointmentForm, setAppointmentForm] = useState({
    patientName: 'Aisha Okafor',
    patientEmail: 'aisha.okafor@medrec.demo',
    doctorName: 'Dr. Priya Shah',
    doctorEmail: 'priya.shah@medrec.demo',
    date: '2026-09-27',
    time: '10:30',
    mode: 'Clinic visit',
    notes: 'Follow-up review and medication update.'
  });
  const [appointments, setAppointments] = useState<any[]>([
    {
      id: 'APT-1001',
      patientName: 'Aisha Okafor',
      doctorName: 'Dr. Priya Shah',
      date: '2026-09-27',
      time: '10:30',
      mode: 'Clinic visit',
      status: 'Confirmed'
    }
  ]);
  const [localNotifications, setLocalNotifications] = useState<any[]>([
    { id: 'MSG-1001', title: 'Appointment confirmed', message: 'Your appointment has been booked and shared in-app and by email.', channel: 'in-app + email' }
  ]);
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  const [lastSynced, setLastSynced] = useState(new Date().toISOString());
  const [scanStatus, setScanStatus] = useState('QR scanner ready');
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanLoopRef = useRef<number | null>(null);

  useEffect(() => {
    const handlePathChange = () => setCurrentRoute(window.location.pathname);
    handlePathChange();
    window.addEventListener('popstate', handlePathChange);
    return () => window.removeEventListener('popstate', handlePathChange);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const stopCamera = () => {
    if (scanLoopRef.current) {
      window.clearTimeout(scanLoopRef.current);
      scanLoopRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  };

  useEffect(() => () => stopCamera(), []);

  const verifyScannedQr = async (rawValue: string) => {
    try {
      const payload = JSON.parse(rawValue);
      const token = payload?.token || rawValue;
      const verification = await apiRequest<{ name: string; specialty: string; verified: boolean; licenseNumber: string }>(
        `/api/doctor/verify/${encodeURIComponent(token)}`,
        { headers: { Authorization: `Bearer ${auth?.accessToken || ''}` } }
      );

      setScanStatus(`${verification.name} verified: ${verification.specialty} (${verification.verified ? 'approved' : 'pending'})`);
      return;
    } catch {
      setScanStatus('QR detected, but it is not a valid MedRec doctor verification token.');
    }
  };

  const startQrScan = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      alert('Camera access is not available in this browser.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      const canvas = canvasRef.current ?? document.createElement('canvas');
      if (!canvasRef.current) {
        canvasRef.current = canvas;
      }

      setScanStatus('Camera active. Hold the QR code in front of the lens...');

      const scanFrame = () => {
        const video = videoRef.current;
        const context = canvas.getContext('2d');

        if (!video || !context || video.readyState < 2) {
          scanLoopRef.current = window.setTimeout(scanFrame, 250);
          return;
        }

        const width = video.videoWidth || 640;
        const height = video.videoHeight || 480;
        canvas.width = width;
        canvas.height = height;
        context.drawImage(video, 0, 0, width, height);

        const imageData = context.getImageData(0, 0, width, height);
        const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'attemptBoth' });

        if (code) {
          const rawValue = code.data;
          stopCamera();
          setScanStatus(`QR detected: ${rawValue}`);
          void verifyScannedQr(rawValue);
          return;
        }

        scanLoopRef.current = window.setTimeout(scanFrame, 250);
      };

      scanFrame();
    } catch (error) {
      console.error('Camera scan failed', error);
      setScanStatus('Camera permission denied or unavailable.');
      alert('Camera access was blocked. Please allow camera permission to scan QR codes.');
    }
  };

  const dashboardQuery = useQuery({
    enabled: !!auth?.accessToken,
    queryKey: ['dashboard', auth?.accessToken],
    queryFn: () => fetchDashboard(auth!.accessToken)
  });

  const qrQuery = useQuery({
    enabled: !!auth?.accessToken,
    queryKey: ['doctor-qr', auth?.accessToken],
    queryFn: () => getDoctorQr(auth!.accessToken)
  });

  useEffect(() => {
    const handleOnline = () => {
      setIsOffline(false);
      setLastSynced(new Date().toISOString());
    };

    const handleOffline = () => {
      setIsOffline(true);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    if (auth?.user.role) {
      setSelectedRole(auth.user.role);
    }
  }, [auth]);

  const dashboard = dashboardQuery.data ?? ({} as DashboardData);
  const patient = dashboard.patient ?? {};
  const doctor = dashboard.doctor ?? {};
  const notifications = [...localNotifications, ...(dashboard.notifications ?? [])];
  const audit = dashboard.audit ?? [];
  const prescriptions = dashboard.prescriptions ?? [];
  const analytics = dashboard.analytics ?? { dailyVolume: 0, diagnosisBreakdown: [], prescriptionPatterns: [] };
  const labs = dashboard.labs ?? [];
  const payments = dashboard.payments ?? [];
  const referrals = dashboard.referrals ?? [];
  const consentRequests = dashboard.consentRequests ?? [];
  const queue = dashboard.queue ?? [];

  const aiCleaned = useMemo(() => {
    const lines = draftPrescription.split(/\n|;|\./).filter(Boolean);
    const medication = lines.find((line) => /(amoxicillin|metformin|ibuprofen|atorvastatin|paracetamol|azithromycin|cetirizine)/i.test(line)) ?? 'Medication';
    const dosage = lines.find((line) => /\d+\s*(mg|mcg|g|ml|iu|tablet|capsule)/i.test(line)) ?? 'standard dose';
    const frequency = lines.find((line) => /(twice|daily|morning|night|bd|od|tid|qid)/i.test(line)) ?? 'as directed';
    const duration = lines.find((line) => /(for\s+\d+\s*(days|weeks|months)|\d+\s*(days|weeks|months))/i.test(line)) ?? 'duration not specified';

    const normalize = (value: string) => value.replace(/[^a-zA-Z ]/g, '').trim();
    const rateMatch = dosage.match(/\d+\s*(?:mg|mcg|g|ml|iu|tablet|capsule)/i)?.[0] ?? 'standard dose';
    const freqMatch = frequency.match(/(twice|daily|morning|night|bd|od|tid|qid)/i)?.[0] ?? 'as directed';
    const durationText = duration.replace(/.*?(for\s+\d+\s*(?:days|weeks|months)|\d+\s*(?:days|weeks|months)).*/i, '$1') || 'duration not specified';

    return {
      drug: normalize(medication) || 'Medication',
      dosage: rateMatch,
      frequency: freqMatch,
      duration: durationText,
      instructions: 'AI-assisted transcription � clinician confirmation required before dispensing.'
    };
  }, [draftPrescription]);

  const visibleRoleOptions = adminUnlocked ? allRoleOptions : publicRoleOptions;

  const sendAppointmentEmail = (subject: string, message: string, recipients: string[]) => {
    if (typeof window === 'undefined') {
      return;
    }

    const mailto = `mailto:${recipients.join(',')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}`;
    window.location.href = mailto;
  };

  const handleAppointmentBooking = () => {
    if (!auth?.accessToken) {
      alert('Please sign in before booking an appointment.');
      return;
    }

    const appointment = {
      id: `APT-${Date.now()}`,
      patientName: appointmentForm.patientName,
      doctorName: appointmentForm.doctorName,
      date: appointmentForm.date,
      time: appointmentForm.time,
      mode: appointmentForm.mode,
      status: 'Confirmed',
      notes: appointmentForm.notes
    };

    setAppointments((prev) => [appointment, ...prev]);

    const appMessage = `${appointment.patientName} booked an appointment with ${appointment.doctorName} on ${appointment.date} at ${appointment.time} (${appointment.mode}).`;
    const emailSubject = `Appointment confirmed: ${appointment.date} at ${appointment.time}`;
    const emailBody = `Hello,\n\nThis is a confirmation for ${appointment.patientName} with ${appointment.doctorName}.\nDate: ${appointment.date}\nTime: ${appointment.time}\nMode: ${appointment.mode}\nNotes: ${appointment.notes}\n\nThis message was sent in-app and by email through MedRec.`;

    setLocalNotifications((prev) => [{
      id: `MSG-${Date.now()}`,
      title: 'Appointment booked',
      message: `${appMessage} Shared through the app and email.`,
      channel: 'in-app + email'
    }, ...prev]);

    sendAppointmentEmail(emailSubject, emailBody, [appointmentForm.patientEmail, appointmentForm.doctorEmail]);
    alert('Appointment booked and sent through the app and email to both parties.');
  };

  async function handleEmailSignIn() {
    const email = (signIn.email || 'qa.user.2026@example.com').trim();
    const password = signIn.password || 'Password123!';

    try {
      const data = await apiRequest<{ user: AuthState['user']; accessToken: string }>('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });

      setAuth({ user: data.user, accessToken: data.accessToken });
      setSelectedRole(data.user.role || signIn.role);
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Sign in failed');
    }
  }

  async function handleGoogleSignIn() {
    setShowProfileForm(true);
    const fakeUser = {
      id: 'USR-google-demo',
      email: signIn.email || 'patient.demo@gmail.com',
      role: signIn.role,
      firstName: signIn.firstName || 'Google',
      lastName: signIn.lastName || 'User'
    };

    setAuth({
      user: fakeUser,
      accessToken: 'demo-google-token'
    });
  }

  async function handleRegister() {
    const cleanedEmail = signIn.email.trim();
    const email = !cleanedEmail || cleanedEmail.toLowerCase() === 'qa.user.2026@example.com'
      ? createDemoAccountEmail(signIn.role)
      : cleanedEmail;
    const password = signIn.password || 'Password123!';

    try {
      const data = await apiRequest<{ user: AuthState['user']; accessToken: string }>('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          role: signIn.role,
          firstName: signIn.firstName,
          lastName: signIn.lastName,
          specialty: signIn.role === 'doctor' ? doctorProfile.specialty : '',
          licenseNumber: signIn.role === 'doctor' ? doctorProfile.licenseNumber : ''
        })
      });

      setSignIn((prev) => ({ ...prev, email }));
      setAuth({ user: data.user, accessToken: data.accessToken });
      setSelectedRole(data.user.role || signIn.role);
    } catch (error) {
      const typedError = error instanceof Error ? error.message : 'Registration failed';
      if (typedError.toLowerCase().includes('already exists') || typedError.toLowerCase().includes('duplicate')) {
        const retryEmail = createDemoAccountEmail(signIn.role);
        setSignIn((prev) => ({ ...prev, email: retryEmail }));
        alert('That email already exists. A fresh demo account was generated for you.');
        return;
      }

      alert(typedError || 'Registration failed');
    }
  }

  async function handleAdminLogin() {
    try {
      const response = await apiRequest<{ user?: any; accessToken?: string; error?: string; requiresMfa?: boolean }>('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: adminLogin.email,
          password: adminLogin.password,
          mfaCode: adminLogin.mfaCode
        })
      });

      if (response.requiresMfa) {
        setAdminMfaRequired(true);
        setAdminError('');
        return;
      }

      if (!response.accessToken || !response.user) {
        setAdminError('Unable to complete secure sign-in.');
        return;
      }

      setAdminSession({ user: response.user, accessToken: response.accessToken });
      window.history.pushState({}, '', '/staff-console');
      setCurrentRoute('/staff-console');
      setAdminMfaRequired(false);
      setAdminError('');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Secure sign-in failed.';
      if (message === 'MFA required') {
        setAdminMfaRequired(true);
        setAdminError('');
        return;
      }
      setAdminError(message === 'Invalid credentials' ? 'Invalid credentials' : message);
      setAdminMfaRequired(false);
    }
  }

  async function handleAdminMfaSubmit() {
    const trimmedMfa = adminLogin.mfaCode.trim();
    if (!trimmedMfa) {
      setAdminError('Enter your MFA code.');
      return;
    }

    await handleAdminLogin();
  }

  async function handleDoctorRegistration() {
    if (!auth?.accessToken) {
      alert('Sign in before starting doctor verification.');
      return;
    }

    try {
      await apiRequest('/api/doctors/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${auth.accessToken}`
        },
        body: JSON.stringify({
          firstName: doctorProfile.firstName,
          lastName: doctorProfile.lastName,
          specialty: doctorProfile.specialty,
          licenseNumber: doctorProfile.licenseNumber,
          affiliation: doctorProfile.affiliation
        })
      });

      alert('Doctor verification submitted. An admin can approve the QR and access permissions.');
      dashboardQuery.refetch();
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Doctor registration failed');
    }
  }

  async function handleConsentRequest() {
    if (!auth?.accessToken) {
      alert('Sign in to request patient consent.');
      return;
    }

    try {
      await apiRequest('/api/consent/request', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${auth.accessToken}`
        },
        body: JSON.stringify({
          patientId: consentForm.patientId,
          provider: consentForm.provider,
          purpose: consentForm.purpose
        })
      });

      alert('Consent request sent to patient.');
      dashboardQuery.refetch();
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Consent request failed');
    }
  }

  async function handleConsentAction(status: 'approved' | 'pending' | 'revoked', id?: string) {
    if (!id || !auth) return;
    await apiRequest(`/api/consent/${id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.accessToken}`
      },
      body: JSON.stringify({ status })
    });
    dashboardQuery.refetch();
  }

  async function handlePrescriptionSubmit() {
    if (!auth?.accessToken) {
      alert('Sign in before submitting a prescription.');
      return;
    }

    try {
      await apiRequest('/api/prescriptions/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${auth.accessToken}`
        },
        body: JSON.stringify({
          patientId: patient?.id || 'PT-1001',
          doctorId: doctor?.id || 'DR-2001',
          rawText: draftPrescription
        })
      });

      alert('Prescription submitted for pharmacist verification.');
      dashboardQuery.refetch();
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Prescription submission failed');
    }
  }

  async function handlePharmacistDecision(status: 'confirmed' | 'flagged', prescriptionId?: string) {
    if (!auth?.accessToken || !prescriptionId) {
      return;
    }

    try {
      await apiRequest(`/api/prescriptions/${prescriptionId}/confirm`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${auth.accessToken}`
        },
        body: JSON.stringify({ status })
      });

      alert(status === 'confirmed' ? 'Prescription confirmed and ready for dispensing.' : 'Prescription flagged for clinician review.');
      dashboardQuery.refetch();
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Prescription confirmation failed');
    }
  }

  async function handleQueueOfflineSync() {
    if (!auth?.accessToken) {
      alert('Sign in to queue a sync.');
      return;
    }

    try {
      const data = await apiRequest<{ conflictState?: string }>('/api/offline/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${auth.accessToken}`
        },
        body: JSON.stringify({
          type: 'patient-record-sync',
          recordId: patient?.id || 'PT-1001',
          recordType: 'patient-record',
          payload: {
            patientId: patient?.id || 'PT-1001',
            lastUpdated: new Date().toISOString(),
            status: 'queued'
          }
        })
      });

      setSyncStatus(data.conflictState === 'manual-review' ? 'Queued with review required' : 'Saved locally');
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Offline sync failed');
    }
  }

  async function handleExportFhir() {
    if (!patient?.id) {
      return;
    }

    try {
      const data = await apiRequest<any>(`/api/fhir/${patient.id}`, {
        headers: {
          Authorization: `Bearer ${auth?.accessToken || ''}`
        }
      });

      setFhirBundle(data);
    } catch (error) {
      alert(error instanceof Error ? error.message : 'FHIR export failed');
    }
  }

  async function handleGuestPatientCreate() {
    if (!auth?.accessToken) {
      alert('Sign in as staff to create a walk-in record.');
      return;
    }

    try {
      const data = await apiRequest<{ name: string }>('/api/patients/guest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${auth.accessToken}`
        },
        body: JSON.stringify(walkInForm)
      });

      alert(`Walk-in patient record created: ${data.name}`);
      dashboardQuery.refetch();
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Walk-in patient creation failed');
    }
  }

  const primaryContent = (() => {
    if (currentRoute === '/staff-console') {
      if (adminSession) {
        return (
          <AnimatePresence mode="wait">
            <motion.div key="admin-console" {...pageTransition}>
              <AdminConsole
                adminSession={adminSession}
                onSignOut={() => {
                  setAdminSession(null);
                  setAdminLogin({ email: '', password: '', mfaCode: '' });
                  setAdminMfaRequired(false);
                  setAdminError('');
                  window.history.pushState({}, '', '/');
                  setCurrentRoute('/');
                }}
              />
            </motion.div>
          </AnimatePresence>
        );
      }

      return (
        <AnimatePresence mode="wait">
          <motion.div key="admin-login" {...pageTransition}>
            <AdminLoginScreen
              adminLogin={adminLogin}
              setAdminLogin={setAdminLogin}
              adminError={adminError}
              adminMfaRequired={adminMfaRequired}
              onSubmit={handleAdminLogin}
              onBack={() => {
                setAdminSession(null);
                window.history.pushState({}, '', '/');
                setCurrentRoute('/');
              }}
            />
          </motion.div>
        </AnimatePresence>
      );
    }

    if (!auth) {
      return (
        <AnimatePresence mode="wait">
          <motion.div key="auth-screen" {...pageTransition}>
            <div className="auth-shell">
              <div className="auth-layout">
                <section className="brand-panel">
                  <div className="medical-signal" aria-hidden="true">
                    <span className="signal-dot" />
                    <span className="signal-line" />
                    <span className="signal-dot signal-dot-end" />
                  </div>
                  <div className="brand-badge">MedRec Health</div>
                  <p className="eyebrow">trusted digital care</p>
                  <h1>Connected records for patients, clinicians, and care teams.</h1>
                  <p className="hero-copy">
                    Secure access to appointments, prescriptions, visit summaries, consent, and verifiable clinician identity — all in one place.
                  </p>

                  <div className="feature-list">
                    <div className="feature-item reveal-step">
                      <span className="feature-check">✓</span>
                      <div>
                        <strong>Plain-language summaries</strong>
                        <small>Easy for patients and clinicians to read quickly.</small>
                      </div>
                    </div>
                    <div className="feature-item reveal-step">
                      <span className="feature-check">✓</span>
                      <div>
                        <strong>Consent-aware access</strong>
                        <small>Every record view respects who was granted access.</small>
                      </div>
                    </div>
                    <div className="feature-item reveal-step">
                      <span className="feature-check">✓</span>
                      <div>
                        <strong>Offline resilience</strong>
                        <small>Cached patient data and sync status remain visible.</small>
                      </div>
                    </div>
                  </div>
                </section>

                <section className="panel login-panel">
                  <div className="login-status"><span className="status-pulse" /> Secure care workspace</div>
                  <div className="panel-header">
                    <div>
                      <p className="eyebrow">medrec access</p>
                      <h2>Welcome back</h2>
                    </div>
                  </div>

                  <div className="auth-actions">
                    <button className="primary wide" onClick={handleGoogleSignIn}>Continue with Google</button>
                    <button className="secondary wide" type="button" onClick={() => handleDemoAction('Microsoft sign-in', 'This demo uses the email/password flow for the healthcare workspace.')}>Continue with Microsoft</button>
                  </div>

                  <div className="role-grid" aria-label="Choose role">
                    {visibleRoleOptions.map((role) => (
                      <button
                        key={role}
                        type="button"
                        className={`role-card ${signIn.role === role ? 'active' : ''}`}
                        onClick={() => setSignIn((prev) => ({ ...prev, role }))}
                      >
                        {role}
                      </button>
                    ))}
                  </div>

                  <div className="field-group">
                    <label>
                      First name
                      <input value={signIn.firstName} onChange={(e) => setSignIn({ ...signIn, firstName: e.target.value })} />
                    </label>
                    <label>
                      Last name
                      <input value={signIn.lastName} onChange={(e) => setSignIn({ ...signIn, lastName: e.target.value })} />
                    </label>
                    <label>
                      Email
                      <input type="email" value={signIn.email} onChange={(e) => setSignIn({ ...signIn, email: e.target.value })} />
                    </label>
                    <label>
                      Password
                      <input type="password" value={signIn.password} onChange={(e) => setSignIn({ ...signIn, password: e.target.value })} />
                    </label>
                  </div>

                  <div className="button-row">
                    <button className="primary" onClick={handleEmailSignIn}>Sign in</button>
                    <button className="secondary" onClick={handleRegister}>Create account</button>
                  </div>
                  {showProfileForm && (
                    <div className="profile-form">
                      <p className="eyebrow">complete profile</p>
                      <div className="field-group compact">
                        <label>
                          Clinic or specialty
                          <input placeholder="General medicine" />
                        </label>
                        <label>
                          License number
                          <input placeholder="MED-00000" />
                        </label>
                        <label>
                          Phone number
                          <input placeholder="+254 700 000 000" />
                        </label>
                      </div>
                      <button className="primary" onClick={() => setShowProfileForm(false)}>Continue to dashboard</button>
                    </div>
                  )}
                </section>
              </div>
            </div>
          </motion.div>
        </AnimatePresence>
      );
    }

    if (dashboardQuery.isLoading && !dashboardQuery.data) {
      return (
        <AnimatePresence mode="wait">
          <motion.div key="dashboard-loading" {...pageTransition}>
            <header className="topbar">
              <div>
                <p className="eyebrow">medrec care network</p>
                <h1>Loading your workspace</h1>
              </div>
            </header>
            <div className="grid-layout">
              <div className="panel hero-panel"><SkeletonBlock className="skeleton-lg" /></div>
              <div className="panel"><SkeletonBlock className="skeleton-md" /></div>
              <div className="panel"><SkeletonBlock className="skeleton-md" /></div>
              <div className="panel span-2"><SkeletonBlock className="skeleton-lg" /></div>
            </div>
          </motion.div>
        </AnimatePresence>
      );
    }

    return (
      <AnimatePresence mode="wait">
        <motion.div key={`${currentRoute}-${selectedRole}`} {...pageTransition}>
          <header className="topbar">
            <div className="brand-lockup">
              <div className="brand-mark" aria-hidden="true">M</div>
              <div>
                <p className="eyebrow">MEDREC / CARE OS</p>
                <h1>Clinical access and record review</h1>
                <p className="topbar-subtitle">One trusted workspace for every care decision.</p>
              </div>
            </div>

            <div className="topbar-actions">
              <div className={`sync-banner ${isOffline ? 'offline' : 'online'}`}>
                {isOffline ? 'Offline • cached data only' : 'Online • synced'}
              </div>
              <div className="pill">Last synced {new Date(lastSynced).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
              <button
                className="theme-toggle small"
                aria-label="Toggle theme"
                onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
              >
                {theme === 'dark' ? 'Light mode' : 'Dark mode'}
              </button>
              <div className="signed-in-role" aria-label={`Signed in as ${selectedRole}`}>
                <span className="role-dot" aria-hidden="true" />
                <span>{selectedRole === 'patient' ? 'Patient workspace' : selectedRole === 'doctor' ? 'Doctor workspace' : 'Pharmacist workspace'}</span>
              </div>
              <button className="secondary small" onClick={() => setAuth(null)}>Sign out</button>
            </div>
          </header>

          <nav className="workspace-nav" aria-label="Workspace sections">
            <span className="workspace-nav-label">Workspace</span>
            <button className="workspace-nav-item active">Overview</button>
            <button className="workspace-nav-item" onClick={() => handleDemoAction('Records', 'Your consent-aware records are shown below.')}>Records</button>
            <button className="workspace-nav-item" onClick={() => handleDemoAction('Messages', 'Your care team messages are up to date.')}>Messages</button>
            <button className="workspace-nav-item" onClick={() => handleDemoAction('Support', 'MedRec support is available to help.')}>Support</button>
          </nav>

          <div className="trust-banner">
            AI-assisted transcription is for clinician review only. It is not a diagnosis or a final prescription.
          </div>

          <div className={`care-flow ${selectedRole}-flow`} aria-label="Care workflow">
            {(selectedRole === 'patient'
              ? ['Your next step', 'Your records', 'Your care team']
              : selectedRole === 'doctor'
                ? ["Today's queue", 'Clinical review', 'Prescription safety']
                : ['Prescription queue', 'Safety review', 'Dispense decision']
            ).map((step, index) => (
              <div className={`care-flow-step ${index === 0 ? 'active' : ''}`} key={step}>
                <span>{index + 1}</span>
                <strong>{step}</strong>
              </div>
            ))}
          </div>

          {selectedRole === 'patient' && (
            <PatientView
              patient={patient}
              notifications={notifications}
              prescriptions={prescriptions}
              consentRequests={consentRequests}
              consentForm={consentForm}
              setConsentForm={setConsentForm}
              onConsentAction={handleConsentAction}
              onConsentRequest={handleConsentRequest}
              fhirBundle={fhirBundle}
              syncStatus={syncStatus}
              onQueueOfflineSync={handleQueueOfflineSync}
              onExportFhir={handleExportFhir}
              onScanDoctorQr={startQrScan}
              scanStatus={scanStatus}
              videoRef={videoRef}
              canvasRef={canvasRef}
              appointmentForm={appointmentForm}
              setAppointmentForm={setAppointmentForm}
              appointments={appointments}
              onAppointmentBooking={handleAppointmentBooking}
              setLocalNotifications={setLocalNotifications}
            />
          )}

          {selectedRole === 'doctor' && (
            <DoctorView
              doctor={doctor}
              patient={patient}
              draftPrescription={draftPrescription}
              setDraftPrescription={setDraftPrescription}
              aiCleaned={aiCleaned}
              qrCode={qrQuery.data?.qrCode}
              doctorProfile={doctorProfile}
              setDoctorProfile={setDoctorProfile}
              onDoctorRegistration={handleDoctorRegistration}
              onPrescriptionSubmit={handlePrescriptionSubmit}
              onGenerateQr={() => qrQuery.refetch()}
              onScanDoctorQr={startQrScan}
              scanStatus={scanStatus}
              videoRef={videoRef}
              canvasRef={canvasRef}
            />
          )}

          {selectedRole === 'pharmacist' && (
            <PharmacistView
              patient={patient}
              prescriptions={prescriptions}
              draftPrescription={draftPrescription}
              aiCleaned={aiCleaned}
              onPharmacistDecision={handlePharmacistDecision}
            />
          )}

          {selectedRole === 'admin' && (
            <AdminView
              analytics={analytics}
              audit={audit}
              queue={queue}
              walkInForm={walkInForm}
              setWalkInForm={setWalkInForm}
              onGuestPatientCreate={handleGuestPatientCreate}
            />
          )}
        </motion.div>
      </AnimatePresence>
    );
  })();

  return <div className={`app-shell role-${selectedRole}`}>{primaryContent}</div>;
}

function PatientView({
  patient,
  notifications,
  prescriptions,
  consentRequests,
  consentForm,
  setConsentForm,
  onConsentAction,
  onConsentRequest,
  fhirBundle,
  syncStatus,
  onQueueOfflineSync,
  onExportFhir,
  onScanDoctorQr,
  scanStatus,
  videoRef,
  canvasRef,
  appointmentForm,
  setAppointmentForm,
  appointments,
  onAppointmentBooking
}: any) {
  return (
    <main className="grid-layout patient-layout">
      <section className="panel hero-panel patient-hero">
        <div className="section-head">
          <div>
            <p className="eyebrow">home</p>
            <h2>{patient?.name || 'Your health overview'}</h2>
          </div>
          <button className="primary" onClick={onAppointmentBooking}>Book appointment</button>
        </div>

        <div className="appointment-form-grid">
          <label>
            Patient name
            <input value={appointmentForm.patientName} onChange={(e) => setAppointmentForm((prev) => ({ ...prev, patientName: e.target.value }))} />
          </label>
          <label>
            Patient email
            <input type="email" value={appointmentForm.patientEmail} onChange={(e) => setAppointmentForm((prev) => ({ ...prev, patientEmail: e.target.value }))} />
          </label>
          <label>
            Doctor
            <input value={appointmentForm.doctorName} onChange={(e) => setAppointmentForm((prev) => ({ ...prev, doctorName: e.target.value }))} />
          </label>
          <label>
            Doctor email
            <input type="email" value={appointmentForm.doctorEmail} onChange={(e) => setAppointmentForm((prev) => ({ ...prev, doctorEmail: e.target.value }))} />
          </label>
          <label>
            Date
            <input type="date" value={appointmentForm.date} onChange={(e) => setAppointmentForm((prev) => ({ ...prev, date: e.target.value }))} />
          </label>
          <label>
            Time
            <input type="time" value={appointmentForm.time} onChange={(e) => setAppointmentForm((prev) => ({ ...prev, time: e.target.value }))} />
          </label>
          <label>
            Visit mode
            <input value={appointmentForm.mode} onChange={(e) => setAppointmentForm((prev) => ({ ...prev, mode: e.target.value }))} />
          </label>
          <label className="full-span">
            Notes
            <textarea value={appointmentForm.notes} onChange={(e) => setAppointmentForm((prev) => ({ ...prev, notes: e.target.value }))} />
          </label>
        </div>

        <div className="stats-grid">
          <div className="stat-card"><span>Upcoming appointment</span><strong>Tue 10:30 AM</strong></div>
          <div className="stat-card"><span>Active prescriptions</span><strong>{prescriptions.length || 2}</strong></div>
          <div className="stat-card"><span>Last visit summary</span><strong>Follow-up complete</strong></div>
          <div className="stat-card"><span>Care team</span><strong>Dr. Priya Shah</strong></div>
        </div>
      </section>

      <section className="panel patient-section records-section">
        <p className="eyebrow">records</p>
        <div className="list-stack stagger-list">
          {((patient?.diagnoses && patient.diagnoses.length) ? patient.diagnoses : []).map((item: any, index: number) => (
            <motion.div key={`${item.code}-${index}`} className="detail-card" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.06, duration: 0.18 }}>
              <div>
                <strong>{item.title}</strong>
                <small>{item.code}</small>
              </div>
              <button className="secondary small" onClick={() => handleDemoAction('Medical record detail', 'This record view opens the full structured patient timeline.')}>Medical detail</button>
            </motion.div>
          ))}
          {((patient?.allergies && patient.allergies.length) ? patient.allergies : []).map((item: string, index: number) => (
            <motion.div key={`${item}-${index}`} className="detail-card muted" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.04, duration: 0.18 }}>
              <span>Allergy: {item}</span>
            </motion.div>
          ))}
          {(!patient?.diagnoses?.length && !patient?.allergies?.length) && (
            <EmptyState
              icon="📋"
              title="No active record notes yet"
              description="Recent diagnoses and allergies will appear here once a clinician adds them."
              actionLabel="View care plan"
              onAction={() => handleDemoAction('Care plan', 'The patient care plan can be opened here once records are added.')}
            />
          )}
        </div>
      </section>

      <section className="panel patient-section consent-section">
        <p className="eyebrow">consent manager</p>
        <div className="field-group compact">
          <label>
            Patient record
            <input value={consentForm.patientId} onChange={(e) => setConsentForm({ ...consentForm, patientId: e.target.value })} />
          </label>
          <label>
            Provider
            <input value={consentForm.provider} onChange={(e) => setConsentForm({ ...consentForm, provider: e.target.value })} />
          </label>
          <label>
            Purpose
            <input value={consentForm.purpose} onChange={(e) => setConsentForm({ ...consentForm, purpose: e.target.value })} />
          </label>
        </div>
        <div className="button-row">
          <button className="primary small" onClick={onConsentRequest}>Request access</button>
        </div>
        <div className="list-stack stagger-list">
          {(consentRequests.length ? consentRequests : []).map((request: any, index: number) => (
            <motion.div key={request.id} className="detail-card" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.05, duration: 0.18 }}>
              <div>
                <strong>{request.provider}</strong>
                <small>{request.purpose}</small>
              </div>
              <div className="inline-actions">
                <button className="secondary small" onClick={() => onConsentAction('approved', request.id)}>Grant</button>
                <button className="danger small" onClick={() => onConsentAction('revoked', request.id)}>Revoke</button>
              </div>
            </motion.div>
          ))}
          {!consentRequests.length && (
            <EmptyState
              icon="🔐"
              title="No consent requests yet"
              description="Allow a provider to request access and approve or revoke them here."
              actionLabel="Request access"
              onAction={onConsentRequest}
            />
          )}
        </div>
      </section>

      <section className="panel span-2 patient-section prescriptions-section">
        <p className="eyebrow">active prescriptions</p>
        <div className="list-stack stagger-list">
          {(prescriptions.length ? prescriptions : []).map((item: any, index: number) => (
            <motion.div key={item.id} className="detail-card" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.05, duration: 0.18 }}>
              <div>
                <strong>{item.cleaned?.drug || 'Metformin'}</strong>
                <small>{item.cleaned?.dosage || '500mg'} • {item.cleaned?.frequency || 'Twice daily'} • {item.cleaned?.duration || '30 days'}</small>
              </div>
              <span className="status-chip">{item.status || 'Refill pending'}</span>
            </motion.div>
          ))}
          {!prescriptions.length && (
            <EmptyState
              icon="💊"
              title="No active prescriptions"
              description="Once a doctor submits a prescription, it will appear here for review."
              actionLabel="Create follow-up"
              onAction={() => handleDemoAction('Prescription follow-up', 'A new medication review can be started from this screen.')}
            />
          )}
        </div>
        <div className="button-row" style={{ marginTop: '1rem' }}>
          <button className="primary small" onClick={onQueueOfflineSync}>Queue offline sync</button>
          <button className="secondary small" onClick={onExportFhir}>Export FHIR bundle</button>
        </div>
        <p className="eyebrow" style={{ marginTop: '0.75rem' }}> {syncStatus}</p>
      </section>

      {fhirBundle && (
        <section className="panel span-2">
          <p className="eyebrow">FHIR bundle</p>
          <pre>{JSON.stringify(fhirBundle, null, 2)}</pre>
        </section>
      )}

      <section className="panel">
        <p className="eyebrow">notifications</p>
        <div className="list-stack stagger-list">
          {notifications.length ? notifications.map((item: any, index: number) => (
            <motion.div key={item.id} className="detail-card notification-card" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.04, duration: 0.18 }}>
              <div>
                <strong>{item.title}</strong>
                <small>{item.message}</small>
              </div>
              <span className="status-chip">{item.channel || 'app'}</span>
            </motion.div>
          )) : (
            <EmptyState
              icon="🔔"
              title="No notifications"
              description="Medication reminders, consent alerts, and appointment updates will show here."
              actionLabel="Review inbox"
              onAction={() => handleDemoAction('Inbox review', 'Notification feed is ready for the next care update.')}
            />
          )}
        </div>
      </section>

      <section className="panel span-2">
        <p className="eyebrow">appointments</p>
        <div className="appointments-grid stagger-list">
          {appointments.length ? appointments.map((item: any, index: number) => (
            <motion.div key={item.id} className="appointment-card" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.05, duration: 0.18 }}>
              <div>
                <strong>{item.patientName}</strong>
                <small>{item.doctorName}</small>
              </div>
              <div className="appointment-meta">
                <span>{item.date}</span>
                <span>{item.time}</span>
                <span>{item.mode}</span>
              </div>
              <span className="status-chip">{item.status}</span>
            </motion.div>
          )) : (
            <EmptyState
              icon="📅"
              title="No appointments scheduled"
              description="Add a follow-up visit or booking for the next patient check-in."
              actionLabel="Book visit"
              onAction={() => handleDemoAction('Booking', 'The scheduling flow can be opened for a new visit.')}
            />
          )}
        </div>
      </section>

      <section className="panel span-2">
        <p className="eyebrow">scan doctor QR</p>
        <div className="button-row">
          <button className="primary small" onClick={onScanDoctorQr}>Open camera scanner</button>
          <button className="secondary small" onClick={() => handleDemoAction('QR scan', 'Use the camera to verify a clinician credential card.')}>Need help?</button>
        </div>
        <div className="qr-card" style={{ marginTop: '1rem' }}>
          <video ref={videoRef} autoPlay playsInline muted style={{ width: '100%', borderRadius: '12px', background: '#081b1d' }} />
          <canvas ref={canvasRef} hidden />
          <small>{scanStatus}</small>
        </div>
      </section>
    </main>
  );
}

function DoctorView({ doctor, patient, draftPrescription, setDraftPrescription, aiCleaned, qrCode, doctorProfile, setDoctorProfile, onDoctorRegistration, onPrescriptionSubmit, onGenerateQr, onScanDoctorQr, scanStatus, videoRef, canvasRef }: any) {
  return (
    <main className="grid-layout doctor-layout">
      <section className="panel hero-panel doctor-queue">
        <div className="section-head">
          <div>
            <p className="eyebrow">doctor workspace</p>
            <h2>Patient lookup and care coordination</h2>
          </div>
          <button className="primary" onClick={() => handleDemoAction('Patient search', 'A patient lookup is ready for the next clinical record request.')}>Patient search</button>
        </div>

        <div className="search-row">
          <input placeholder="Search by patient or MRN" />
          <button className="secondary" onClick={() => handleDemoAction('Patient search', 'Search results are scoped to the clinician consent set.')}>Consent scoped results</button>
        </div>
      </section>

      <section className="panel">
        <p className="eyebrow">doctor verification</p>
        <div className="field-group compact">
          <label>
            First name
            <input value={doctorProfile.firstName} onChange={(e) => setDoctorProfile({ ...doctorProfile, firstName: e.target.value })} />
          </label>
          <label>
            Last name
            <input value={doctorProfile.lastName} onChange={(e) => setDoctorProfile({ ...doctorProfile, lastName: e.target.value })} />
          </label>
          <label>
            Specialty
            <input value={doctorProfile.specialty} onChange={(e) => setDoctorProfile({ ...doctorProfile, specialty: e.target.value })} />
          </label>
          <label>
            License number
            <input value={doctorProfile.licenseNumber} onChange={(e) => setDoctorProfile({ ...doctorProfile, licenseNumber: e.target.value })} />
          </label>
          <label>
            Clinic / affiliation
            <input value={doctorProfile.affiliation} onChange={(e) => setDoctorProfile({ ...doctorProfile, affiliation: e.target.value })} />
          </label>
        </div>
        <div className="button-row">
          <button className="primary" onClick={onDoctorRegistration}>Submit verification</button>
        </div>
      </section>

      <section className="panel">
        <p className="eyebrow">verified QR</p>
        <div className="qr-card">
          {qrCode ? <img src={qrCode} alt="Doctor verification QR" /> : <div className="qr-placeholder">QR pending</div>}
          <p>{doctor?.name || 'Dr. Priya Shah'}</p>
          <small>{doctor?.specialty || 'General medicine'} • {doctor?.affiliation || 'Nairobi Partners Clinic'}</small>
          <div className="button-row" style={{ marginTop: '0.75rem' }}>
            <button className="primary small" onClick={onGenerateQr}>Generate QR</button>
            <button className="secondary small" onClick={onScanDoctorQr}>Scan QR</button>
          </div>
          <small>{scanStatus}</small>
          <video ref={videoRef} autoPlay playsInline muted style={{ width: '100%', borderRadius: '12px', background: '#081b1d', marginTop: '0.75rem' }} />
          <canvas ref={canvasRef} hidden />
        </div>
      </section>

      <section className="panel span-2">
        <p className="eyebrow">prescription writer</p>
        <div className="prescribe-grid">
          <label className="field-label">
            <span>Write prescription</span>
            <textarea value={draftPrescription} onChange={(e) => setDraftPrescription(e.target.value)} rows={10} />
          </label>
          <div className="preview-box">
            <h3>AI-cleaned preview</h3>
            <ul>
              <li><strong>Drug:</strong> {aiCleaned.drug}</li>
              <li><strong>Dosage:</strong> {aiCleaned.dosage}</li>
              <li><strong>Frequency:</strong> {aiCleaned.frequency}</li>
              <li><strong>Duration:</strong> {aiCleaned.duration}</li>
              <li><strong>Notes:</strong> {aiCleaned.instructions}</li>
            </ul>
            <div className="button-row">
              <button className="primary" onClick={onPrescriptionSubmit}>Submit for pharmacist review</button>
              <button className="secondary" onClick={() => handleDemoAction('AI suggestion approved', 'The cleaned prescription has been saved for clinician review.')}>Approve AI suggestion</button>
            </div>
          </div>
        </div>
      </section>

      <section className="panel">
        <p className="eyebrow">patient history</p>
        <div className="list-stack stagger-list">
          {((patient?.diagnoses || [{ title: 'Type 2 diabetes', code: 'E11.9' }]).slice(0, 3).map((item: any, index: number) => (
            <motion.div key={`${item.code}-${index}`} className="detail-card" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.06, duration: 0.18 }}>
              <div>
                <strong>{item.title}</strong>
                <small>{item.code}</small>
              </div>
              <button className="secondary small" onClick={() => handleDemoAction('Relevant record view', 'This opens the matching care-history context for the current clinical summary.')}>Relevant view</button>
            </motion.div>
          )))}
        </div>
      </section>
    </main>
  );
}

function PharmacistView({ patient, prescriptions, draftPrescription, aiCleaned, onPharmacistDecision }: any) {
  const activePrescription = prescriptions[0] ?? {
    id: 'RX-1',
    original: draftPrescription || 'No image loaded yet',
    cleaned: aiCleaned,
    status: 'pending-confirmation'
  };

  return (
    <main className="grid-layout">
      <section className="panel hero-panel">
        <div className="section-head">
          <div>
            <p className="eyebrow">dispense review</p>
            <h2>Prescription verification</h2>
          </div>
          <button className="primary" onClick={() => handleDemoAction('Prescription scanner', 'Image scanning is enabled for the next uploaded prescription capture.')}>Scan prescription</button>
        </div>

        <div className="search-row">
          <input placeholder="Scan or search by patient / RX ID" />
          <button className="secondary" onClick={() => handleDemoAction('Prescription lookup', 'Search is ready for a real patient or RX scan workflow.')}>Search</button>
        </div>
      </section>

      <section className="panel span-2">
        <p className="eyebrow">original vs AI-cleaned</p>
        <div className="prescribe-grid">
          <div className="preview-box">
            <h3>Original</h3>
            <p>{activePrescription.original || draftPrescription || 'No image loaded yet'}</p>
          </div>
          <div className="preview-box warning-box">
            <h3>AI-assisted transcription — pending confirmation</h3>
            <ul>
              <li><strong>Drug:</strong> {activePrescription.cleaned?.drug || aiCleaned.drug}</li>
              <li><strong>Dosage:</strong> {activePrescription.cleaned?.dosage || aiCleaned.dosage}</li>
              <li><strong>Frequency:</strong> {activePrescription.cleaned?.frequency || aiCleaned.frequency}</li>
              <li><strong>Duration:</strong> {activePrescription.cleaned?.duration || aiCleaned.duration}</li>
              <li><strong>Instructions:</strong> {activePrescription.cleaned?.instructions || aiCleaned.instructions}</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="panel">
        <p className="eyebrow">interaction warnings</p>
        <div className="warning-box">
          <strong>Medication interaction</strong>
          <p>Metformin + ibuprofen may require hydration check and renal function review.</p>
        </div>
        <div className="button-row">
          <button className="primary" onClick={() => onPharmacistDecision('confirmed', activePrescription.id)}>Confirm</button>
          <button className="danger" onClick={() => onPharmacistDecision('flagged', activePrescription.id)}>Flag mismatch</button>
        </div>
        <label className="field-label">
          <span>Flag comment</span>
          <textarea rows={4} placeholder="Add note for clinical follow-up..." />
        </label>
      </section>
    </main>
  );
}

function AdminLoginScreen({ adminLogin, setAdminLogin, adminError, adminMfaRequired, onSubmit, onBack }: any) {
  return (
    <div className="auth-shell">
      <div className="auth-layout">
        <section className="brand-panel">
          <div className="brand-badge">Secure access</div>
          <p className="eyebrow">staff portal</p>
          <h1>Protected operational access</h1>
          <p className="hero-copy">
            This area is restricted to verified administrative users. Access is controlled by email, password, and MFA.
          </p>
        </section>

        <section className="panel login-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">admin sign in</p>
              <h2>Secure staff login</h2>
            </div>
          </div>

          <div className="field-group">
            <label>
              Email
              <input
                type="email"
                value={adminLogin.email}
                onChange={(e) => setAdminLogin((prev: any) => ({ ...prev, email: e.target.value }))}
                placeholder="admin@clinic.local"
              />
            </label>
            <label>
              Password
              <input
                type="password"
                value={adminLogin.password}
                onChange={(e) => setAdminLogin((prev: any) => ({ ...prev, password: e.target.value }))}
                placeholder="Enter password"
              />
            </label>
            {adminMfaRequired && (
              <label>
                MFA code
                <input
                  type="text"
                  value={adminLogin.mfaCode}
                  onChange={(e) => setAdminLogin((prev: any) => ({ ...prev, mfaCode: e.target.value }))}
                  placeholder="123456"
                />
              </label>
            )}
          </div>

          {adminError && <div className="error-banner">{adminError}</div>}

          <div className="button-row">
            <button className="primary" type="button" onClick={onSubmit}>Continue securely</button>
            <button className="secondary" type="button" onClick={onBack}>Back to portal</button>
          </div>
        </section>
      </div>
    </div>
  );
}

function AdminConsole({ adminSession, onSignOut }: any) {
  return (
    <main className="grid-layout">
      <section className="panel hero-panel">
        <div className="section-head">
          <div>
            <p className="eyebrow">staff console</p>
            <h2>{adminSession?.user?.role === 'super_admin' ? 'Platform administration' : 'Clinic administration'}</h2>
          </div>
          <button className="secondary" onClick={onSignOut}>Sign out</button>
        </div>

        <div className="stats-grid">
          <div className="stat-card"><span>Access level</span><strong>{adminSession?.user?.role || 'clinic_admin'}</strong></div>
          <div className="stat-card"><span>Clinic scope</span><strong>{adminSession?.user?.clinicId || 'System-wide'}</strong></div>
          <div className="stat-card"><span>Pending verifications</span><strong>3</strong></div>
          <div className="stat-card"><span>Review queue</span><strong>12 items</strong></div>
        </div>
      </section>

      <section className="panel">
        <p className="eyebrow">priority actions</p>
        <div className="list-stack">
          <div className="detail-card">
            <div>
              <strong>Doctor verification queue</strong>
              <small>Approve or reject pending clinicians for this clinic.</small>
            </div>
            <button className="secondary small" onClick={() => handleDemoAction('Verification queue', 'Pending clinician reviews are available in this admin console.')}>Review</button>
          </div>
          <div className="detail-card">
            <div>
              <strong>Clinic settings</strong>
              <small>Update staffing access, scheduling, and operational rules.</small>
            </div>
            <button className="secondary small" onClick={() => handleDemoAction('Clinic settings', 'Settings workspace is ready for clinic administration.')}>Manage</button>
          </div>
        </div>
      </section>

      <section className="panel">
        <p className="eyebrow">break-glass audit</p>
        <div className="list-stack compact-list">
          <div className="detail-card">
            <div>
              <strong>Emergency access reason required</strong>
              <small>All patient medical record access prompts for a documented break-glass reason.</small>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

function AdminView({ analytics, audit, queue, walkInForm, setWalkInForm, onGuestPatientCreate }: any) {
  return (
    <main className="grid-layout">
      <section className="panel hero-panel">
        <div className="section-head">
          <div>
            <p className="eyebrow">admin workspace</p>
            <h2>Clinic operations and verification</h2>
          </div>
          <button className="primary" onClick={() => handleDemoAction('Clinic registration', 'This admin workflow is ready to link to a real onboarding form.')}>Register clinic</button>
        </div>

        <div className="stats-grid">
          <div className="stat-card"><span>Daily volume</span><strong>{analytics?.dailyVolume || 38}</strong></div>
          <div className="stat-card"><span>Pending doctors</span><strong>3</strong></div>
          <div className="stat-card"><span>Audit events</span><strong>{audit.length || 3}</strong></div>
          <div className="stat-card"><span>Sync queue</span><strong>{queue.length || 0}</strong></div>
        </div>
      </section>

      <section className="panel">
        <p className="eyebrow">walk-in / unclaimed patient</p>
        <div className="field-group compact">
          <label>
            Name
            <input value={walkInForm.name} onChange={(e) => setWalkInForm({ ...walkInForm, name: e.target.value })} />
          </label>
          <label>
            DOB
            <input type="date" value={walkInForm.dob} onChange={(e) => setWalkInForm({ ...walkInForm, dob: e.target.value })} />
          </label>
          <label>
            Phone
            <input value={walkInForm.phone} onChange={(e) => setWalkInForm({ ...walkInForm, phone: e.target.value })} />
          </label>
          <label>
            Insurance
            <input value={walkInForm.insurance} onChange={(e) => setWalkInForm({ ...walkInForm, insurance: e.target.value })} />
          </label>
        </div>
        <div className="button-row">
          <button className="primary" onClick={onGuestPatientCreate}>Create walk-in record</button>
        </div>
      </section>

      <section className="panel">
        <p className="eyebrow">doctor verification queue</p>
        <div className="list-stack">
          {['Dr. Amina Yusuf', 'Dr. James Otieno', 'Dr. Lina Mora'].map((name) => (
            <div key={name} className="detail-card">
              <div>
                <strong>{name}</strong>
                <small>License review + document verified</small>
              </div>
              <div className="inline-actions">
                <button className="primary small" onClick={() => handleDemoAction('Doctor approved', `${name} was approved for verified clinician access.`)}>Approve</button>
                <button className="danger small" onClick={() => handleDemoAction('Doctor rejected', `${name} has been marked for document resubmission.`)}>Reject</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <p className="eyebrow">audit log</p>
        <div className="list-stack compact-list">
          {(audit || []).slice(0, 5).map((entry: any) => (
            <div key={entry.id} className="detail-card">
              <div>
                <strong>{entry.action}</strong>
                <small>{entry.actor} � {entry.resource}</small>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="panel span-2">
        <p className="eyebrow">clinic metrics</p>
        <div className="analytics-grid">
          {(analytics?.diagnosisBreakdown || []).map((entry: any) => (
            <div key={entry.label} className="metric-box">
              <span>{entry.label}</span>
              <strong>{entry.value}%</strong>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

export default App;
