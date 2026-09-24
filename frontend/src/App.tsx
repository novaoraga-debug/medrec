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
  refreshToken?: string;
  expiresAt?: number;
};

const publicRoleOptions: Role[] = ['patient', 'doctor', 'pharmacist'];
const allRoleOptions: Role[] = ['patient', 'doctor', 'pharmacist', 'admin'];
const samplePrescription = `Amoxicillin 500mg twice daily for 5 days\nFinish the course unless directed otherwise\nMonitor for rash or GI upset`;

// Unlock code that reveals the hidden Staff/Admin role card on the sign-in
// screen. The staff console itself still requires email + password + MFA.
// Override per environment with VITE_STAFF_UNLOCK_CODE (see frontend/.env.example);
// the built-in default keeps local development working out of the box.
const STAFF_UNLOCK_CODE = (import.meta.env.VITE_STAFF_UNLOCK_CODE || 'SuperAdmin!2026').trim();

const SESSION_STORAGE_KEY = 'medrec.session';
const REMEMBERED_EMAIL_KEY = 'medrec.remembered-email';

// Demo credentials per role, shown as a micro-hint under the sign-in form.
const demoCredentials: Partial<Record<Role, { email: string; password: string }>> = {
  patient: { email: 'qa.user.2026@example.com', password: 'Password123!' },
  doctor: { email: 'doctor.demo@medrec.local', password: 'Password123!' },
  pharmacist: { email: 'pharmacist.demo@medrec.local', password: 'Password123!' }
};

type Notice = { id: number; type: 'success' | 'error' | 'info'; message: string };
let noticeListener: ((notice: Notice) => void) | null = null;
let noticeSeq = 0;

// Push an inline banner (never window.alert). Also usable from handlers
// defined outside the component, e.g. handleDemoAction.
function notify(type: Notice['type'], message: string) {
  noticeListener?.({ id: ++noticeSeq, type, message });
}

function createDemoAccountEmail(role: Role): string {
  const stamp = Date.now().toString().slice(-6);
  return `new.${role}.${stamp}@medrec.demo`;
}

function saveSession(session: AuthState, remember: boolean) {
  try {
    if (remember) {
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    } else {
      sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
      localStorage.removeItem(SESSION_STORAGE_KEY);
    }
  } catch {
    /* storage unavailable — session stays in memory only */
  }
}

function loadSession(): AuthState | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY) || sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.accessToken || !parsed?.user) return null;
    return parsed as AuthState;
  } catch {
    return null;
  }
}

function clearStoredSession() {
  try {
    localStorage.removeItem(SESSION_STORAGE_KEY);
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Google Identity Services (ported from portals/shared/google.js).
// The official button only activates when VITE_GOOGLE_CLIENT_ID is set;
// otherwise a disabled placeholder keeps the UI from looking broken.
// ---------------------------------------------------------------------------
type GoogleGlobal = { accounts?: { id?: any } };
let googleScriptPromise: Promise<GoogleGlobal> | null = null;

function googleClientId(): string {
  return (import.meta.env.VITE_GOOGLE_CLIENT_ID || '').trim();
}

function googleEnabled(): boolean {
  return Boolean(googleClientId());
}

function loadGoogleScript(): Promise<GoogleGlobal> {
  const w = window as unknown as { google?: GoogleGlobal };
  if (w.google?.accounts?.id) {
    return Promise.resolve(w.google);
  }
  if (googleScriptPromise) {
    return googleScriptPromise;
  }

  googleScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => {
      if (w.google?.accounts?.id) {
        resolve(w.google);
      } else {
        reject(new Error('Google Identity Services failed to initialize.'));
      }
    };
    script.onerror = () => {
      googleScriptPromise = null;
      reject(new Error('Failed to load Google Identity Services.'));
    };
    document.head.appendChild(script);
  });

  return googleScriptPromise;
}

async function renderGoogleButton(
  element: HTMLElement | null,
  handlers: { onToken: (credential: string) => void; onError: (error: Error) => void }
): Promise<boolean> {
  if (!element) return false;
  if (!googleEnabled()) {
    handlers.onError(new Error('Google sign-in is not configured. Set VITE_GOOGLE_CLIENT_ID.'));
    return false;
  }

  const google = await loadGoogleScript();
  google.accounts!.id!.initialize({
    client_id: googleClientId(),
    callback: (response: { credential?: string }) => {
      if (response?.credential) {
        handlers.onToken(response.credential);
      } else {
        handlers.onError(new Error('Google did not return a credential.'));
      }
    },
    auto_select: false,
    cancel_on_tap_outside: true
  });

  try {
    google.accounts!.id!.renderButton(element, {
      theme: 'outline',
      size: 'large',
      shape: 'pill',
      text: 'continue_with',
      width: 320,
      logo_alignment: 'left'
    });
  } catch (error) {
    handlers.onError(error instanceof Error ? error : new Error('Google button render failed.'));
    return false;
  }

  return true;
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
  notify('info', detail ? `${action}: ${detail}` : action);
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

async function getDoctorQr(token: string): Promise<{ qrCode?: string; token?: string; url?: string } | null> {
  try {
    // No doctorId — the backend resolves the signed-in doctor (or first verified).
    return await apiRequest<{ qrCode?: string; token?: string; url?: string }>('/api/doctors/qr', {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
  } catch {
    return null;
  }
}

// Documents are served only through the authenticated file route, so mint a
// short-lived, file-scoped token before opening one in a new tab.
async function mintFileUrl(token: string, imagePath: string): Promise<string | null> {
  if (!imagePath) return null;
  const filename = imagePath.split('/uploads/')[1] || imagePath.split('/').pop();
  if (!filename) return null;
  const { fileToken } = await apiRequest<{ fileToken: string }>('/api/files/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ filename })
  });
  const base = API_BASE_URL || '';
  return `${base}/api/files/${encodeURIComponent(filename)}?file_token=${encodeURIComponent(fileToken)}`;
}

const pageTransition = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
  transition: { duration: 0.2, ease: 'easeOut' as const }
};

// Official Google sign-in button with a graceful disabled placeholder when
// VITE_GOOGLE_CLIENT_ID is not configured.
function GoogleSignInButton({ onToken, onError }: { onToken: (credential: string) => void; onError: (error: Error) => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tokenRef = useRef(onToken);
  const errorRef = useRef(onError);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error' | 'unconfigured'>('loading');

  useEffect(() => { tokenRef.current = onToken; }, [onToken]);
  useEffect(() => { errorRef.current = onError; }, [onError]);

  useEffect(() => {
    if (!googleEnabled()) {
      setStatus('unconfigured');
      return undefined;
    }

    let cancelled = false;
    renderGoogleButton(containerRef.current, {
      onToken: (credential) => tokenRef.current(credential),
      onError: (error) => {
        if (!cancelled) setStatus('error');
        errorRef.current(error);
      }
    })
      .then((ok) => {
        if (!cancelled) setStatus(ok ? 'ready' : 'error');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="google-signin">
      <div
        ref={containerRef}
        className={`google-signin-slot ${status === 'ready' ? 'is-ready' : ''}`}
        aria-label="Continue with Google"
      />
      {status !== 'ready' && (
        <button
          type="button"
          className="secondary wide"
          disabled
          title={
            status === 'unconfigured'
              ? 'Google sign-in is not configured. Set VITE_GOOGLE_CLIENT_ID and GOOGLE_CLIENT_ID.'
              : 'Google sign-in is loading…'
          }
        >
          {status === 'unconfigured' ? 'Continue with Google (not configured)' : 'Continue with Google…'}
        </button>
      )}
    </div>
  );
}

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
  const [auth, setAuth] = useState<AuthState | null>(() => loadSession());
  const [adminSession, setAdminSession] = useState<any>(null);
  const [selectedRole, setSelectedRole] = useState<Role>('patient');
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [currentRoute, setCurrentRoute] = useState(typeof window !== 'undefined' ? window.location.pathname : '/');
  const [signIn, setSignIn] = useState(() => {
    let remembered = '';
    try {
      remembered = localStorage.getItem(REMEMBERED_EMAIL_KEY) || '';
    } catch {
      remembered = '';
    }
    return {
      email: remembered || 'qa.user.2026@example.com',
      password: 'Password123!',
      firstName: 'QA',
      lastName: 'User',
      role: 'patient' as Role
    };
  });
  const [adminLogin, setAdminLogin] = useState({ email: 'super.admin@medrec.local', password: 'SuperAdmin!2026', mfaCode: '' });
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
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [unlockCode, setUnlockCode] = useState('');
  const [authMode, setAuthMode] = useState<'signin' | 'apply' | 'status'>('signin');
  const [authBusy, setAuthBusy] = useState(false);
  const [rememberDevice, setRememberDevice] = useState(true);
  const [applicationForm, setApplicationForm] = useState({
    firstName: '',
    lastName: '',
    email: '',
    password: '',
    specialty: '',
    licenseNumber: '',
    affiliation: ''
  });
  const [applicationStatus, setApplicationStatus] = useState<any>(null);
  const [statusEmail, setStatusEmail] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [sessionWarning, setSessionWarning] = useState('');
  const [queuedCount, setQueuedCount] = useState(0);
  const [scanResult, setScanResult] = useState<{ ok: boolean; name?: string; specialty?: string; verified?: boolean; licenseNumber?: string } | null>(null);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
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

  // Register the module-level notice sink so every handler (including ones
  // defined outside this component) can push inline banners instead of alert().
  useEffect(() => {
    noticeListener = (next) => setNotice(next);
    return () => {
      noticeListener = null;
    };
  }, []);

  // Auto-dismiss notices after a few seconds.
  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // Esc closes transient UI: notice banner, notification popover, unlock row.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setNotice(null);
        setNotificationsOpen(false);
        setUnlockOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Persist the session whenever it changes (remember device → localStorage,
  // otherwise sessionStorage only).
  useEffect(() => {
    if (auth) {
      saveSession(auth, rememberDevice);
    }
  }, [auth, rememberDevice]);

  // Proactively refresh the access token shortly before it expires; when the
  // refresh fails, sign out with a clear session-expired warning.
  const refreshToken = auth?.refreshToken;
  const expiresAt = auth?.expiresAt;
  useEffect(() => {
    if (!refreshToken || !expiresAt) return undefined;
    const delay = Math.max(expiresAt - Date.now() - 60_000, 0);
    let cancelled = false;
    const timer = window.setTimeout(() => {
      (async () => {
        try {
          const data = await apiRequest<{ accessToken: string; expiresInSeconds?: number }>('/api/auth/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken })
          });
          if (cancelled) return;
          setSessionWarning('');
          setAuth((prev) => (prev
            ? { ...prev, accessToken: data.accessToken, expiresAt: Date.now() + (data.expiresInSeconds ?? 15 * 60) * 1000 }
            : prev));
        } catch {
          if (cancelled) return;
          setSessionWarning('Session expired. Please sign in again.');
          notify('error', 'Session expired. Please sign in again.');
          setAuth(null);
          clearStoredSession();
        }
      })();
    }, delay);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [refreshToken, expiresAt]);

  // Switching role cards prefills that role's demo credentials and resets the
  // auth sub-view so the form always matches the chosen role.
  useEffect(() => {
    const demo = demoCredentials[signIn.role];
    setAuthMode(signIn.role === 'patient' ? 'signin' : 'apply');
    setApplicationStatus(null);
    if (demo) {
      setSignIn((prev) => ({ ...prev, email: demo.email, password: demo.password }));
    } else if (signIn.role === 'admin') {
      setSignIn((prev) => ({ ...prev, email: '', password: '' }));
    }
    // Intentionally keyed on the role only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signIn.role]);

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

      setScanResult({
        ok: true,
        name: verification.name,
        specialty: verification.specialty,
        verified: verification.verified,
        licenseNumber: verification.licenseNumber
      });
      setScanStatus(`${verification.name} verified: ${verification.specialty} (${verification.verified ? 'approved' : 'pending'})`);
      notify(verification.verified ? 'success' : 'info', `Scan result: ${verification.name} (${verification.specialty}) is ${verification.verified ? 'verified' : 'pending verification'}.`);
      return;
    } catch {
      setScanResult({ ok: false });
      setScanStatus('QR detected, but it is not a valid MedRec doctor verification token.');
      notify('error', 'That QR code is not a valid MedRec doctor verification token.');
    }
  };

  const startQrScan = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      notify('error', 'Camera access is not available in this browser.');
      return;
    }

    setScanResult(null);
    try {
      // Continuous autofocus when the browser supports it; rear camera preferred.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          focusMode: 'continuous'
        } as MediaTrackConstraints
      });
      streamRef.current = stream;

      // Expose a flash/torch toggle only when the camera reports support.
      try {
        const track = stream.getVideoTracks()[0];
        const capabilities = (track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean };
        setTorchAvailable(Boolean(capabilities.torch));
      } catch {
        setTorchAvailable(false);
      }
      setTorchOn(false);

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
      notify('error', 'Camera access was blocked. Allow camera permission to scan QR codes.');
    }
  };

  // Toggle the camera flash/torch while scanning.
  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next }] } as any);
      setTorchOn(next);
      setScanStatus(next ? 'Flash on' : 'Flash off');
    } catch {
      setTorchAvailable(false);
      notify('error', 'Flash is not available on this camera.');
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
      notify('error', 'Please sign in before booking an appointment.');
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
    notify('success', 'Appointment booked and sent through the app and email to both parties.');
  };

  async function handleEmailSignIn() {
    if (signIn.role === 'admin') {
      // Staff use the dedicated MFA console, not the member login.
      window.history.pushState({}, '', '/staff-console');
      setCurrentRoute('/staff-console');
      return;
    }

    const email = signIn.email.trim();
    const password = signIn.password;
    if (!email || !password) {
      notify('error', 'Enter your email and password to continue.');
      return;
    }

    setAuthBusy(true);
    try {
      const data = await apiRequest<{ user: AuthState['user']; accessToken: string; refreshToken?: string; expiresInSeconds?: number }>('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });

      const session: AuthState = {
        user: data.user,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        expiresAt: Date.now() + (data.expiresInSeconds ?? 15 * 60) * 1000
      };
      setAuth(session);
      setSelectedRole(data.user.role || signIn.role);
      setSessionWarning('');
      if (rememberDevice) {
        try {
          localStorage.setItem(REMEMBERED_EMAIL_KEY, email);
        } catch {
          /* ignore */
        }
      }
      notify('success', `Signed in as ${data.user.email}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Sign in failed';
      const hint = signIn.role === 'doctor' || signIn.role === 'pharmacist'
        ? ' Not approved yet? Use the Apply once tab, then Check status.'
        : '';
      notify('error', `${message}${hint}`);
    } finally {
      setAuthBusy(false);
    }
  }

  function decodeJwtPayload(token: string): any {
    try {
      const base64 = token.split('.')[1]?.replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(atob(base64 || ''));
    } catch {
      return {};
    }
  }

  // Google ID token → MedRec session. Doctors (excluded by the backend) and
  // pharmacists (excluded by this app's approval policy) never get a session
  // directly: the identity only prefills the one-time verification application,
  // which staff must approve before either role can sign in.
  async function handleGoogleToken(idToken: string) {
    if (signIn.role === 'doctor' || signIn.role === 'pharmacist') {
      const claims = decodeJwtPayload(idToken);
      setApplicationForm((prev) => ({
        ...prev,
        email: String(claims.email || prev.email),
        firstName: String(claims.given_name || prev.firstName),
        lastName: String(claims.family_name || prev.lastName)
      }));
      setAuthMode('apply');
      notify('info', signIn.role === 'doctor'
        ? 'Google accounts cannot create doctor logins directly. Complete the verification application — staff will review it and activate your account.'
        : 'Pharmacist logins require staff verification. Complete the one-time application — your Google identity is prefilled and staff will activate your account after review.');
      return;
    }

    setAuthBusy(true);
    try {
      const data = await apiRequest<{ user: AuthState['user']; accessToken: string; refreshToken?: string; expiresInSeconds?: number; isNewUser?: boolean }>('/api/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken, role: signIn.role })
      });

      const session: AuthState = {
        user: data.user,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        expiresAt: Date.now() + (data.expiresInSeconds ?? 15 * 60) * 1000
      };
      setAuth(session);
      setSelectedRole(data.user.role || signIn.role);
      setSessionWarning('');
      notify('success', data.isNewUser
        ? `Welcome to MedRec — account created for ${data.user.email}.`
        : `Signed in with Google as ${data.user.email}.`);
    } catch (error) {
      notify('error', error instanceof Error ? error.message : 'Google sign-in failed.');
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleRegister() {
    if (signIn.role !== 'patient') {
      // Doctors and pharmacists activate only after staff verification.
      setAuthMode('apply');
      notify('info', `${signIn.role === 'doctor' ? 'Doctor' : 'Pharmacist'} accounts are created after staff verification. Submit the one-time application instead.`);
      return;
    }

    const cleanedEmail = signIn.email.trim();
    const email = !cleanedEmail || cleanedEmail.toLowerCase() === 'qa.user.2026@example.com'
      ? createDemoAccountEmail(signIn.role)
      : cleanedEmail;
    const password = signIn.password || 'Password123!';

    setAuthBusy(true);
    try {
      const data = await apiRequest<{ user: AuthState['user']; accessToken: string; refreshToken?: string; expiresInSeconds?: number }>('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          role: 'patient',
          firstName: signIn.firstName,
          lastName: signIn.lastName
        })
      });

      setSignIn((prev) => ({ ...prev, email }));
      const session: AuthState = {
        user: data.user,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        expiresAt: Date.now() + (data.expiresInSeconds ?? 15 * 60) * 1000
      };
      setAuth(session);
      setSelectedRole(data.user.role || 'patient');
      setSessionWarning('');
      notify('success', `Patient account created for ${email}.`);
    } catch (error) {
      const typedError = error instanceof Error ? error.message : 'Registration failed';
      if (typedError.toLowerCase().includes('already exists') || typedError.toLowerCase().includes('duplicate')) {
        const retryEmail = createDemoAccountEmail(signIn.role);
        setSignIn((prev) => ({ ...prev, email: retryEmail }));
        notify('error', 'That email already exists. A fresh demo account email was generated for you.');
        return;
      }

      notify('error', typedError || 'Registration failed');
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleApplicationSubmit() {
    const form = applicationForm;
    if (!form.firstName.trim() || !form.lastName.trim() || !form.email.trim() || !form.password || !form.licenseNumber.trim()) {
      notify('error', 'Name, email, password, and license number are required.');
      return;
    }
    if (form.password.length < 8) {
      notify('error', 'Password must be at least 8 characters.');
      return;
    }

    const targetRole = signIn.role === 'pharmacist' ? 'pharmacist' : 'doctor';
    setAuthBusy(true);
    try {
      const data = await apiRequest<{ application: any }>('/api/doctors/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, role: targetRole })
      });
      setApplicationStatus(data.application);
      setStatusEmail(form.email.trim());
      setSignIn((prev) => ({ ...prev, email: form.email.trim(), password: form.password }));
      setAuthMode('status');
      notify('success', 'Application submitted. Staff will review your documents — your account activates only after approval.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Application failed';
      const lower = message.toLowerCase();
      if (lower.includes('already exists') || lower.includes('awaiting review')) {
        setStatusEmail(form.email.trim());
        setAuthMode('status');
        notify('info', `${message} Check the status tab for this email.`);
        void handleStatusCheck(form.email.trim());
        return;
      }
      notify('error', message);
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleStatusCheck(emailOverride?: string) {
    const email = (emailOverride ?? statusEmail ?? signIn.email).trim();
    if (!email) {
      notify('error', 'Enter the email you applied with, then check status.');
      return;
    }
    try {
      const data = await apiRequest<any>(`/api/doctors/apply/status?email=${encodeURIComponent(email)}`);
      setApplicationStatus(data);
      setStatusEmail(email);
      if (data.status === 'approved' && data.accountCreated) {
        notify('success', `Application approved for ${data.name || email}. You can sign in now.`);
      } else if (data.status === 'rejected') {
        notify('error', `Application rejected: ${data.rejectionReason || 'documents could not be verified'}. You can re-apply.`);
      } else {
        notify('info', `Application ${data.status} — awaiting staff verification.`);
      }
    } catch (error) {
      setApplicationStatus(null);
      notify('error', error instanceof Error ? error.message : 'No application found for this email.');
    }
  }

  function handleStaffUnlock() {
    if (unlockCode === STAFF_UNLOCK_CODE) {
      setAdminUnlocked(true);
      setUnlockOpen(false);
      setUnlockCode('');
      setSignIn((prev) => ({ ...prev, role: 'admin' }));
      notify('success', 'Staff access unlocked. Continue to the staff console below.');
    } else {
      notify('error', 'Incorrect unlock code.');
    }
  }

  function handleSignOut() {
    setAuth(null);
    clearStoredSession();
    setSessionWarning('');
    notify('info', 'You have been signed out.');
  }

  async function handleSignOutAll() {
    if (auth?.accessToken) {
      try {
        await apiRequest('/api/auth/logout-all', {
          method: 'POST',
          headers: { Authorization: `Bearer ${auth.accessToken}` }
        });
      } catch {
        /* token may already be invalid — sign out locally regardless */
      }
    }
    setAuth(null);
    clearStoredSession();
    setSessionWarning('');
    notify('info', 'Signed out on all devices.');
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
      notify('error', 'Sign in before starting doctor verification.');
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

      notify('success', 'Doctor verification submitted. An admin can approve the QR and access permissions.');
      dashboardQuery.refetch();
    } catch (error) {
      notify('error', error instanceof Error ? error.message : 'Doctor registration failed');
    }
  }

  async function handleConsentRequest() {
    if (!auth?.accessToken) {
      notify('error', 'Sign in to request patient consent.');
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

      notify('success', 'Consent request sent to patient.');
      dashboardQuery.refetch();
    } catch (error) {
      notify('error', error instanceof Error ? error.message : 'Consent request failed');
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
      notify('error', 'Sign in before submitting a prescription.');
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

      notify('success', 'Prescription submitted for pharmacist verification.');
      dashboardQuery.refetch();
    } catch (error) {
      notify('error', error instanceof Error ? error.message : 'Prescription submission failed');
    }
  }

  async function handlePharmacistDecision(status: 'confirmed' | 'flagged', prescriptionId?: string, note?: string) {
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
        body: JSON.stringify({ status, note: note || undefined })
      });

      if (status === 'confirmed') {
        notify('success', 'Prescription confirmed and ready for dispensing.');
      } else {
        notify('info', 'Prescription flagged for clinician review.');
      }
      dashboardQuery.refetch();
    } catch (error) {
      notify('error', error instanceof Error ? error.message : 'Prescription confirmation failed');
    }
  }

  async function handleQueueOfflineSync() {
    if (!auth?.accessToken) {
      notify('error', 'Sign in to queue a sync.');
      return;
    }

    if (isOffline) {
      setQueuedCount((count) => count + 1);
      setSyncStatus('Saved locally — waiting to sync');
      notify('info', 'You are offline. Changes are queued locally — press Sync now when you are back online.');
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

      setQueuedCount(0);
      setSyncStatus(data.conflictState === 'manual-review' ? 'Queued with review required' : 'Saved locally');
      notify('success', 'Offline queue synced with the server.');
    } catch (error) {
      notify('error', error instanceof Error ? error.message : 'Offline sync failed');
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
      notify('success', 'FHIR bundle exported below.');
    } catch (error) {
      notify('error', error instanceof Error ? error.message : 'FHIR export failed');
    }
  }

  async function handleGuestPatientCreate() {
    if (!auth?.accessToken) {
      notify('error', 'Sign in as staff to create a walk-in record.');
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

      notify('success', `Walk-in patient record created: ${data.name}`);
      dashboardQuery.refetch();
    } catch (error) {
      notify('error', error instanceof Error ? error.message : 'Walk-in patient creation failed');
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
            <div id="main-content" tabIndex={-1} className="auth-shell">
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
                  <div className="panel-header">
                    <div>
                      <p className="eyebrow">medrec access</p>
                      <h2>
                        {signIn.role === 'patient' && 'Welcome back'}
                        {signIn.role === 'doctor' && 'Doctor access'}
                        {signIn.role === 'pharmacist' && 'Pharmacist access'}
                        {signIn.role === 'admin' && 'Staff access'}
                      </h2>
                      <p className="micro-hint">
                        {signIn.role === 'patient' && 'Create an account or continue with Google.'}
                        {signIn.role === 'doctor' && 'Doctors sign in only after staff approve the one-time application.'}
                        {signIn.role === 'pharmacist' && 'Pharmacists sign in only after staff approve the one-time application.'}
                        {signIn.role === 'admin' && 'Protected by email, password, and a one-time MFA code.'}
                      </p>
                    </div>
                  </div>

                  <div className="role-grid" aria-label="Choose how to sign in">
                    {visibleRoleOptions.map((role) => (
                      <button
                        key={role}
                        type="button"
                        className={`role-card ${signIn.role === role ? 'active' : ''}`}
                        aria-pressed={signIn.role === role}
                        onClick={() => setSignIn((prev) => ({ ...prev, role }))}
                      >
                        <span className="role-card-icon" aria-hidden="true">
                          {role === 'patient' ? '🧑‍⚕️' : role === 'doctor' ? '🩺' : role === 'pharmacist' ? '💊' : '🛡️'}
                        </span>
                        <span className="role-card-name">{role}</span>
                        <span className="role-card-hint">
                          {role === 'patient' && 'Self sign-up'}
                          {role === 'doctor' && 'Apply once · staff approve'}
                          {role === 'pharmacist' && 'Apply once · staff approve'}
                          {role === 'admin' && 'MFA protected'}
                        </span>
                      </button>
                    ))}
                  </div>

                  {signIn.role === 'admin' ? (
                    <div className="field-group">
                      <p className="micro-hint">
                        Staff sign-in uses email, password, and a one-time MFA code. Demo: super.admin@medrec.local / SuperAdmin!2026.
                      </p>
                      <button
                        className="primary wide"
                        type="button"
                        onClick={() => {
                          window.history.pushState({}, '', '/staff-console');
                          setCurrentRoute('/staff-console');
                        }}
                      >
                        Open staff console
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="auth-tabs" role="tablist" aria-label={`${signIn.role} access`}>
                        <button type="button" role="tab" aria-selected={authMode === 'signin'} className={`auth-tab ${authMode === 'signin' ? 'active' : ''}`} onClick={() => setAuthMode('signin')}>
                          Sign in
                        </button>
                        <button type="button" role="tab" aria-selected={authMode === 'apply'} className={`auth-tab ${authMode === 'apply' ? 'active' : ''}`} onClick={() => setAuthMode('apply')}>
                          Apply once
                        </button>
                        <button type="button" role="tab" aria-selected={authMode === 'status'} className={`auth-tab ${authMode === 'status' ? 'active' : ''}`} onClick={() => setAuthMode('status')}>
                          Check status
                        </button>
                      </div>

                      {authMode === 'signin' && (
                        <div className="auth-pane" role="tabpanel">
                          <GoogleSignInButton
                            onToken={handleGoogleToken}
                            onError={(error) => notify('error', error.message)}
                          />
                          <div className="auth-divider"><span>or use email</span></div>

                          {signIn.role === 'patient' && (
                            <div className="field-group compact">
                              <label>
                                First name
                                <input autoComplete="given-name" value={signIn.firstName} onChange={(e) => setSignIn({ ...signIn, firstName: e.target.value })} />
                              </label>
                              <label>
                                Last name
                                <input autoComplete="family-name" value={signIn.lastName} onChange={(e) => setSignIn({ ...signIn, lastName: e.target.value })} />
                              </label>
                            </div>
                          )}
                          <div className="field-group">
                            <label>
                              Email
                              <input type="email" autoComplete="email" value={signIn.email} onChange={(e) => setSignIn({ ...signIn, email: e.target.value })} />
                            </label>
                            <label>
                              Password
                              <input type="password" autoComplete="current-password" value={signIn.password} onChange={(e) => setSignIn({ ...signIn, password: e.target.value })} />
                            </label>
                          </div>

                          <label className="check-row">
                            <input type="checkbox" checked={rememberDevice} onChange={(e) => setRememberDevice(e.target.checked)} />
                            Remember this device
                          </label>

                          <div className="button-row">
                            <button className="primary" onClick={handleEmailSignIn} disabled={authBusy}>
                              {authBusy ? 'Signing in…' : 'Sign in'}
                            </button>
                            <button className="secondary" onClick={handleRegister} disabled={authBusy}>
                              Create account
                            </button>
                          </div>
                          <p className="micro-hint">
                            Demo: {demoCredentials[signIn.role]?.email ?? 'qa.user.2026@example.com'} / Password123!
                          </p>
                        </div>
                      )}

                      {authMode === 'apply' && (
                        <div className="auth-pane" role="tabpanel">
                          <p className="micro-hint">
                            One-time verification for {signIn.role === 'pharmacist' ? 'pharmacist' : 'doctor'} access.
                            Your account activates only after a staff administrator approves it.
                          </p>
                          <div className="field-group compact">
                            <label>
                              First name
                              <input autoComplete="given-name" value={applicationForm.firstName} onChange={(e) => setApplicationForm({ ...applicationForm, firstName: e.target.value })} />
                            </label>
                            <label>
                              Last name
                              <input autoComplete="family-name" value={applicationForm.lastName} onChange={(e) => setApplicationForm({ ...applicationForm, lastName: e.target.value })} />
                            </label>
                            <label>
                              Email
                              <input type="email" autoComplete="email" value={applicationForm.email} onChange={(e) => setApplicationForm({ ...applicationForm, email: e.target.value })} />
                            </label>
                            <label>
                              Password (for after approval)
                              <input type="password" autoComplete="new-password" value={applicationForm.password} onChange={(e) => setApplicationForm({ ...applicationForm, password: e.target.value })} />
                            </label>
                            <label>
                              {signIn.role === 'pharmacist' ? 'Pharmacy / discipline' : 'Specialty'}
                              <input
                                placeholder={signIn.role === 'pharmacist' ? 'Community pharmacy' : 'General medicine'}
                                value={applicationForm.specialty}
                                onChange={(e) => setApplicationForm({ ...applicationForm, specialty: e.target.value })}
                              />
                            </label>
                            <label>
                              Licence number
                              <input
                                placeholder={signIn.role === 'pharmacist' ? 'PHA-00000' : 'MED-00000'}
                                value={applicationForm.licenseNumber}
                                onChange={(e) => setApplicationForm({ ...applicationForm, licenseNumber: e.target.value })}
                              />
                            </label>
                            <label>
                              Clinic / affiliation
                              <input
                                placeholder="Optional"
                                value={applicationForm.affiliation}
                                onChange={(e) => setApplicationForm({ ...applicationForm, affiliation: e.target.value })}
                              />
                            </label>
                          </div>
                          <div className="button-row">
                            <button className="primary" onClick={handleApplicationSubmit} disabled={authBusy}>
                              {authBusy ? 'Submitting…' : 'Submit application'}
                            </button>
                            <button className="secondary" onClick={() => setAuthMode('status')}>Check status instead</button>
                          </div>
                        </div>
                      )}
                      {authMode === 'status' && (
                        <div className="auth-pane" role="tabpanel">
                          <div className="search-row">
                            <input
                              type="email"
                              placeholder="Email you applied with"
                              aria-label="Email you applied with"
                              value={statusEmail || signIn.email}
                              onChange={(e) => setStatusEmail(e.target.value)}
                            />
                            <button className="secondary" onClick={() => handleStatusCheck()}>Check status</button>
                          </div>

                          {applicationStatus && (
                            <div
                              className={`status-banner ${applicationStatus.status === 'approved' ? 'approved' : applicationStatus.status === 'rejected' ? 'rejected' : 'pending'}`}
                              role="status"
                            >
                              <div>
                                <strong>
                                  {applicationStatus.status === 'approved' && 'Approved — your account is active.'}
                                  {applicationStatus.status === 'rejected' && 'Rejected — you can re-apply.'}
                                  {(applicationStatus.status === 'pending' || applicationStatus.status === 'under_review') && 'Pending review — staff will verify your documents.'}
                                </strong>
                                <p>
                                  {applicationStatus.name || statusEmail}
                                  {applicationStatus.rejectionReason ? ` — ${applicationStatus.rejectionReason}` : ''}
                                </p>
                              </div>
                            </div>
                          )}

                          {applicationStatus?.status === 'approved' && applicationStatus?.accountCreated && (
                            <div className="button-row">
                              <button
                                className="primary"
                                onClick={() => {
                                  setSignIn((prev) => ({ ...prev, email: statusEmail || prev.email }));
                                  setAuthMode('signin');
                                }}
                              >
                                Sign in now
                              </button>
                            </div>
                          )}
                          {applicationStatus?.status === 'rejected' && (
                            <div className="button-row">
                              <button className="primary" onClick={() => setAuthMode('apply')}>Re-apply</button>
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  )}

                  {!adminUnlocked && (
                    <div className="staff-unlock">
                      {!unlockOpen ? (
                        <button type="button" className="link-button" onClick={() => setUnlockOpen(true)}>
                          Staff access?
                        </button>
                      ) : (
                        <div className="unlock-row">
                          <input
                            type="password"
                            placeholder="Staff unlock code"
                            aria-label="Staff unlock code"
                            value={unlockCode}
                            onChange={(e) => setUnlockCode(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') handleStaffUnlock(); }}
                          />
                          <button type="button" className="secondary small" onClick={handleStaffUnlock}>Unlock</button>
                          <button type="button" className="link-button" onClick={() => { setUnlockOpen(false); setUnlockCode(''); }}>Cancel</button>
                        </div>
                      )}
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
            <main id="main-content" tabIndex={-1} className="grid-layout">
              <div className="panel hero-panel"><SkeletonBlock className="skeleton-lg" /></div>
              <div className="panel"><SkeletonBlock className="skeleton-md" /></div>
              <div className="panel"><SkeletonBlock className="skeleton-md" /></div>
              <div className="panel span-2"><SkeletonBlock className="skeleton-lg" /></div>
            </main>
          </motion.div>
        </AnimatePresence>
      );
    }

    return (
      <AnimatePresence mode="wait">
        <motion.div key={`${currentRoute}-${selectedRole}`} {...pageTransition}>
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
              scanResult={scanResult}
              torchAvailable={torchAvailable}
              torchOn={torchOn}
              onToggleTorch={toggleTorch}
              videoRef={videoRef}
              canvasRef={canvasRef}
              queuedCount={queuedCount}
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
              prescriptions={prescriptions}
              scanResult={scanResult}
              torchAvailable={torchAvailable}
              torchOn={torchOn}
              onToggleTorch={toggleTorch}
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
              prescriptions={prescriptions}
              draftPrescription={draftPrescription}
              setDraftPrescription={setDraftPrescription}
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

  return (
    <div className={`app-shell role-${selectedRole}`}>
      <a className="skip-link" href="#main-content">Skip to main content</a>
      {(notice || sessionWarning) && (
        <div className={`notice-banner ${notice ? notice.type : 'error'}`} role="status" aria-live="polite">
          <span>{notice ? notice.message : sessionWarning}</span>
          <button
            type="button"
            className="notice-dismiss"
            aria-label="Dismiss message"
            onClick={() => {
              setNotice(null);
              setSessionWarning('');
            }}
          >
            ✕
          </button>
        </div>
      )}
      {auth && currentRoute === '/' && (
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
              {isOffline ? `Offline • ${queuedCount} queued` : 'Online • synced'}
            </div>
            {(isOffline || queuedCount > 0) && (
              <button className="secondary small" onClick={handleQueueOfflineSync} aria-label="Sync queued changes now">
                Sync now
              </button>
            )}
            <div className="pill">Last synced {new Date(lastSynced).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
            <div className="role-switcher" role="group" aria-label="Preview workspace">
              {(['patient', 'doctor', 'pharmacist'] as Role[]).map((role) => (
                <button
                  key={role}
                  type="button"
                  className={`role-switch ${selectedRole === role ? 'active' : ''}`}
                  aria-pressed={selectedRole === role}
                  title={`Preview the ${role} workspace`}
                  onClick={() => setSelectedRole(role)}
                >
                  {role}
                </button>
              ))}
            </div>
            <button
              className="theme-toggle small"
              aria-label="Toggle theme"
              onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
            >
              {theme === 'dark' ? 'Light mode' : 'Dark mode'}
            </button>
            <button
              className={`secondary small bell ${notificationsOpen ? 'active' : ''}`}
              aria-label={`Notifications (${notifications.length})`}
              aria-expanded={notificationsOpen}
              onClick={() => setNotificationsOpen((open) => !open)}
            >
              🔔 {notifications.length}
            </button>
            <div className="signed-in-role" aria-label={`Signed in as ${selectedRole}`}>
              <span className="role-dot" aria-hidden="true" />
              <span>{selectedRole === 'patient' ? 'Patient workspace' : selectedRole === 'doctor' ? 'Doctor workspace' : 'Pharmacist workspace'}</span>
            </div>
            <button className="secondary small" onClick={handleSignOut}>Sign out</button>
            <button className="secondary small" onClick={handleSignOutAll} title="Revoke refresh tokens on every device">Sign out everywhere</button>
            {notificationsOpen && (
              <div className="notifications-popover" role="region" aria-label="Notifications">
                <div className="notifications-head">
                  <strong>Notifications</strong>
                  <button type="button" className="notice-dismiss" aria-label="Close notifications" onClick={() => setNotificationsOpen(false)}>✕</button>
                </div>
                {notifications.slice(0, 8).map((item, index) => (
                  <div key={`${item.id}-${index}`} className="notification-item">
                    <strong>{item.title}</strong>
                    <small>{item.message}</small>
                  </div>
                ))}
                {!notifications.length && (
                  <div className="notification-item"><small>No notifications yet.</small></div>
                )}
              </div>
            )}
          </div>
        </header>
      )}
      {auth && currentRoute === '/' && (
        <nav className="bottom-bar" aria-label="Quick navigation">
          <button
            type="button"
            className="bottom-bar-item active"
            onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          >
            <span aria-hidden="true">🏠</span>
            Overview
          </button>
          <button
            type="button"
            className="bottom-bar-item"
            onClick={() => handleDemoAction('Records', 'Your consent-aware records are shown below.')}
          >
            <span aria-hidden="true">📋</span>
            Records
          </button>
          <button
            type="button"
            className="bottom-bar-item"
            onClick={() => handleDemoAction('Messages', 'Your care team messages are up to date.')}
          >
            <span aria-hidden="true">💬</span>
            Messages
          </button>
          <button
            type="button"
            className="bottom-bar-item"
            onClick={() => handleDemoAction('Support', 'MedRec support is available to help.')}
          >
            <span aria-hidden="true">🛟</span>
            Support
          </button>
        </nav>
      )}
      {primaryContent}
    </div>
  );
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
  scanResult,
  torchAvailable,
  torchOn,
  onToggleTorch,
  queuedCount,
  videoRef,
  canvasRef,
  appointmentForm,
  setAppointmentForm,
  appointments,
  onAppointmentBooking
}: any) {
  return (
    <main id="main-content" tabIndex={-1} className="grid-layout patient-layout">
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
            <input value={appointmentForm.patientName} onChange={(e) => setAppointmentForm((prev: any) => ({ ...prev, patientName: e.target.value }))} />
          </label>
          <label>
            Patient email
            <input type="email" value={appointmentForm.patientEmail} onChange={(e) => setAppointmentForm((prev: any) => ({ ...prev, patientEmail: e.target.value }))} />
          </label>
          <label>
            Doctor
            <input value={appointmentForm.doctorName} onChange={(e) => setAppointmentForm((prev: any) => ({ ...prev, doctorName: e.target.value }))} />
          </label>
          <label>
            Doctor email
            <input type="email" value={appointmentForm.doctorEmail} onChange={(e) => setAppointmentForm((prev: any) => ({ ...prev, doctorEmail: e.target.value }))} />
          </label>
          <label>
            Date
            <input type="date" value={appointmentForm.date} onChange={(e) => setAppointmentForm((prev: any) => ({ ...prev, date: e.target.value }))} />
          </label>
          <label>
            Time
            <input type="time" value={appointmentForm.time} onChange={(e) => setAppointmentForm((prev: any) => ({ ...prev, time: e.target.value }))} />
          </label>
          <label>
            Visit mode
            <input value={appointmentForm.mode} onChange={(e) => setAppointmentForm((prev: any) => ({ ...prev, mode: e.target.value }))} />
          </label>
          <label className="full-span">
            Notes
            <textarea value={appointmentForm.notes} onChange={(e) => setAppointmentForm((prev: any) => ({ ...prev, notes: e.target.value }))} />
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
        <div className="queue-chip-row">
          <span className={`queue-chip ${queuedCount ? 'pending' : ''}`}>
            {queuedCount ? `${queuedCount} change${queuedCount === 1 ? '' : 's'} queued` : 'All changes synced'}
          </span>
          <p className="eyebrow" style={{ marginTop: '0.75rem' }}> {syncStatus}</p>
        </div>
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
          {torchAvailable && (
            <button className="secondary small" onClick={onToggleTorch} aria-label={torchOn ? 'Turn flash off' : 'Turn flash on'}>
              {torchOn ? 'Flash on' : 'Flash off'}
            </button>
          )}
          <button className="secondary small" onClick={() => handleDemoAction('QR scan', 'Use the camera to verify a clinician credential card.')}>Need help?</button>
        </div>
        <div className="qr-card" style={{ marginTop: '1rem' }}>
          <video ref={videoRef} autoPlay playsInline muted style={{ width: '100%', borderRadius: '12px', background: '#081b1d' }} />
          <canvas ref={canvasRef} hidden />
          <small role="status" aria-live="polite">{scanStatus}</small>
        </div>
        {scanResult && (
          <div className={`trust-card ${scanResult.ok && scanResult.verified ? 'verified' : 'warning'}`}>
            {scanResult.ok ? (
              <>
                <span className={`trust-badge ${scanResult.verified ? 'ok' : 'pending'}`}>
                  {scanResult.verified ? '✓ Verified clinician' : '⏳ Verification pending'}
                </span>
                <strong>{scanResult.name}</strong>
                <small>{scanResult.specialty} · Licence {scanResult.licenseNumber}</small>
              </>
            ) : (
              <span className="trust-badge bad">⚠ Could not verify this QR code</span>
            )}
          </div>
        )}
      </section>
    </main>
  );
}

function DoctorView({ doctor, patient, prescriptions, draftPrescription, setDraftPrescription, aiCleaned, qrCode, doctorProfile, setDoctorProfile, onDoctorRegistration, onPrescriptionSubmit, onGenerateQr, onScanDoctorQr, scanStatus, scanResult, torchAvailable, torchOn, onToggleTorch, videoRef, canvasRef }: any) {
  const recentPatients = (prescriptions || []).slice(0, 5).map((item: any) => ({
    id: item.patientId || 'PT-0000',
    detail: `${item.cleaned?.drug || item.original || 'Prescription'}${item.doctorName ? ` • ${item.doctorName}` : ''}`,
    status: item.status || 'pending'
  }));
  const fallbackRecentPatients = [
    { id: 'PT-1001', detail: 'Metformin • follow-up visit', status: 'active' },
    { id: 'PT-1042', detail: 'Amoxicillin • 5-day course', status: 'dispensed' },
    { id: 'PT-1088', detail: 'Atorvastatin • refill', status: 'active' }
  ];
  return (
    <main id="main-content" tabIndex={-1} className="grid-layout doctor-layout">
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
        <p className="eyebrow">issue QR</p>
        <div className="qr-card">
          {qrCode ? (
            <img src={qrCode} alt="Doctor verification QR" id="doctor-qr-image" />
          ) : (
            <div className="qr-placeholder">QR pending</div>
          )}
          <p>{doctor?.name || 'Dr. Priya Shah'}</p>
          <small>{doctor?.specialty || 'General medicine'} • {doctor?.affiliation || 'Nairobi Partners Clinic'}</small>
          <span className={`trust-badge ${doctor?.verified ? 'ok' : 'pending'}`}>
            {doctor?.verified ? '✓ Verified clinician' : '⏳ Verification pending'}
          </span>
          <div className="button-row" style={{ marginTop: '0.75rem' }}>
            <button className="primary small" onClick={onGenerateQr}>Generate QR</button>
            <button
              className="secondary small"
              disabled={!qrCode}
              onClick={async () => {
                if (!qrCode) return;
                try {
                  const blob = await (await fetch(qrCode)).blob();
                  const item = new ClipboardItem({ 'image/png': blob });
                  await navigator.clipboard.write([item]);
                  notify('success', 'QR image copied to the clipboard.');
                } catch {
                  notify('error', 'This browser cannot copy images — use Download PNG instead.');
                }
              }}
            >
              Copy QR
            </button>
            <a
              className={`secondary small qr-download ${qrCode ? '' : 'disabled'}`}
              href={qrCode || '#'}
              download="medrec-doctor-qr.png"
              aria-disabled={!qrCode}
              onClick={(event) => {
                if (!qrCode) {
                  event.preventDefault();
                  return;
                }
                notify('success', 'QR image downloaded.');
              }}
            >
              Download PNG
            </a>
          </div>
        </div>

        <p className="eyebrow" style={{ marginTop: '1rem' }}>scan to verify</p>
        <div className="button-row">
          <button className="primary small" onClick={onScanDoctorQr}>Open camera scanner</button>
          {torchAvailable && (
            <button className="secondary small" onClick={onToggleTorch} aria-label={torchOn ? 'Turn flash off' : 'Turn flash on'}>
              {torchOn ? 'Flash on' : 'Flash off'}
            </button>
          )}
        </div>
        <div className="qr-card" style={{ marginTop: '0.75rem' }}>
          <video ref={videoRef} autoPlay playsInline muted style={{ width: '100%', borderRadius: '12px', background: '#081b1d' }} />
          <canvas ref={canvasRef} hidden />
          <small role="status" aria-live="polite">{scanStatus}</small>
          {scanResult && (
            <div className={`trust-card ${scanResult.ok && scanResult.verified ? 'verified' : 'warning'}`}>
              {scanResult.ok ? (
                <>
                  <span className={`trust-badge ${scanResult.verified ? 'ok' : 'pending'}`}>
                    {scanResult.verified ? '✓ Verified clinician' : '⏳ Verification pending'}
                  </span>
                  <strong>{scanResult.name}</strong>
                  <small>{scanResult.specialty} · Licence {scanResult.licenseNumber}</small>
                </>
              ) : (
                <span className="trust-badge bad">⚠ Could not verify this QR code</span>
              )}
            </div>
          )}
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

      <section className="panel">
        <p className="eyebrow">recent patients</p>
        <div className="list-stack stagger-list">
          {(recentPatients.length ? recentPatients : fallbackRecentPatients).map((entry: { id: string; detail: string; status: string }, index: number) => (
            <motion.div key={`${entry.id}-${index}`} className="detail-card" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.05, duration: 0.18 }}>
              <div>
                <strong>{entry.id}</strong>
                <small>{entry.detail}</small>
              </div>
              <span className="status-chip">{entry.status}</span>
            </motion.div>
          ))}
        </div>
      </section>
    </main>
  );
}

function PharmacistView({ prescriptions, draftPrescription, setDraftPrescription, aiCleaned, onPharmacistDecision }: any) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [flagNote, setFlagNote] = useState('');
  const [localError, setLocalError] = useState('');
  const [decision, setDecision] = useState<'confirmed' | 'flagged' | null>(null);

  const pendingList = (prescriptions || []).filter((item: any) => item.status !== 'confirmed');
  const activePrescription =
    (selectedId && (prescriptions || []).find((item: any) => item.id === selectedId)) ||
    pendingList[0] ||
    (prescriptions || [])[0] || {
      id: 'RX-1',
      original: draftPrescription || 'No prescription loaded yet',
      cleaned: aiCleaned,
      status: 'pending-confirmation'
    };

  const handleDecide = async (status: 'confirmed' | 'flagged') => {
    if (status === 'flagged' && !flagNote.trim()) {
      setLocalError('A reject note is required — tell the clinician what needs review.');
      return;
    }
    setLocalError('');
    await onPharmacistDecision(status, activePrescription.id, flagNote.trim());
    setDecision(status);
    if (status === 'flagged') setFlagNote('');
  };

  return (
    <main id="main-content" tabIndex={-1} className="grid-layout">
      {decision && (
        <div className={`status-banner ${decision === 'confirmed' ? 'approved' : 'rejected'}`} role="status">
          {decision === 'confirmed'
            ? 'Passed — prescription confirmed and ready for dispensing.'
            : 'Flagged — sent back to the clinician for review.'}
        </div>
      )}

      <section className="panel hero-panel">
        <div className="section-head">
          <div>
            <p className="eyebrow">dispense review</p>
            <h2>Prescription verification</h2>
          </div>
          <button className="primary" onClick={() => handleDemoAction('Prescription scanner', 'Image scanning is enabled for the next uploaded prescription capture.')}>Scan prescription</button>
        </div>

        <label className="field-label">
          <span>Scan or paste the prescription text</span>
          <textarea
            rows={4}
            value={draftPrescription}
            onChange={(e) => setDraftPrescription(e.target.value)}
            placeholder="Paste the prescription here — the AI-cleaned preview updates as you type."
            aria-label="Prescription text"
          />
        </label>
      </section>

      <section className="panel span-2">
        <p className="eyebrow">original vs AI-cleaned</p>
        <div className="prescribe-grid">
          <div className="preview-box">
            <h3>Original</h3>
            <p>{activePrescription.original || draftPrescription || 'No prescription loaded yet'}</p>
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
        <p className="eyebrow">pending queue</p>
        <div className="list-stack stagger-list">
          {(pendingList.length ? pendingList : [activePrescription]).map((item: any, index: number) => (
            <motion.button
              key={item.id}
              type="button"
              className={`detail-card selectable ${activePrescription.id === item.id ? 'active' : ''}`}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.05, duration: 0.18 }}
              onClick={() => {
                setSelectedId(item.id);
                setDecision(null);
                setLocalError('');
              }}
              aria-pressed={activePrescription.id === item.id}
            >
              <div>
                <strong>{item.id}</strong>
                <small>{item.cleaned?.drug || 'Prescription'} • {item.patientId || 'PT-1001'}</small>
              </div>
              <span className="status-chip">{item.status || 'pending'}</span>
            </motion.button>
          ))}
        </div>
      </section>

      <section className="panel">
        <p className="eyebrow">interaction warnings</p>
        <div className="warning-box">
          <strong>Medication interaction</strong>
          <p>Metformin + ibuprofen may require hydration check and renal function review.</p>
        </div>
        <div className="button-row">
          <button className="primary" onClick={() => handleDecide('confirmed')}>Approve &amp; pass</button>
          <button className="danger" onClick={() => handleDecide('flagged')}>Reject &amp; flag</button>
        </div>
        <label className="field-label">
          <span>Reject note (required to flag)</span>
          <textarea
            rows={4}
            value={flagNote}
            onChange={(e) => setFlagNote(e.target.value)}
            placeholder="Describe what needs clinician review…"
            aria-invalid={Boolean(localError)}
          />
        </label>
        {localError && <div className="error-banner" role="alert">{localError}</div>}
      </section>
    </main>
  );
}

function AdminLoginScreen({ adminLogin, setAdminLogin, adminError, adminMfaRequired, onSubmit, onBack }: any) {
  return (
    <div id="main-content" tabIndex={-1} className="auth-shell">
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
  const token: string = adminSession?.accessToken || '';
  const [applications, setApplications] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [loadError, setLoadError] = useState('');

  const loadApplications = async () => {
    try {
      const list = await apiRequest<any[]>('/api/admin/doctor-applications', {
        headers: { Authorization: `Bearer ${token}` }
      });
      setApplications(list);
      setLoadError('');
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not load applications');
    }
  };

  useEffect(() => {
    if (token) void loadApplications();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const openApplication = async (id: string) => {
    setLoadError('');
    try {
      const detail = await apiRequest<any>(`/api/admin/doctor-applications/${id}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setSelected(detail);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not open application');
    }
  };

  const handleApprove = async (id: string) => {
    setLoadError('');
    try {
      const result = await apiRequest<{ doctor?: any; user?: any; application?: any }>(`/api/admin/doctor-applications/${id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({})
      });
      notify('success', result.doctor
        ? `Approved ${result.doctor.name}. Account created and QR generated.`
        : `Approved ${result.application?.name || 'applicant'}. Account created.`);
      setSelected(null);
      void loadApplications();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Approval failed');
    }
  };

  const handleReject = async (id: string) => {
    setLoadError('');
    try {
      await apiRequest(`/api/admin/doctor-applications/${id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ reason: rejectReason || 'Documents could not be verified.' })
      });
      notify('info', 'Application rejected. No account was created.');
      setSelected(null);
      setRejectReason('');
      void loadApplications();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Rejection failed');
    }
  };

  // Documents are served only through the authenticated file route, so mint a
  // short-lived, file-scoped token before opening one in a new tab.
  const openDocument = async (doc: any) => {
    try {
      const url = await mintFileUrl(token, doc.url);
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not open the document.');
    }
  };

  const pendingCount = applications.filter((entry) => entry.status === 'pending').length;

  return (
    <main id="main-content" tabIndex={-1} className="grid-layout">
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
          <div className="stat-card"><span>Pending verifications</span><strong>{pendingCount}</strong></div>
          <div className="stat-card"><span>Total applications</span><strong>{applications.length}</strong></div>
        </div>
      </section>

      <section className="panel span-2">
        <div className="section-head">
          <div>
            <p className="eyebrow">verification queue</p>
            <h2>Doctor &amp; pharmacist applications</h2>
          </div>
          <button className="secondary small" onClick={() => void loadApplications()}>Refresh</button>
        </div>

        {loadError && <div className="error-banner" role="alert">{loadError}</div>}

        <div className="list-stack stagger-list">
          {applications.length ? applications.map((application, index) => (
            <motion.div key={application.id} className="detail-card" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.05, duration: 0.18 }}>
              <div>
                <strong>{application.name} <span className={`tag-${application.status}`}>{application.status}</span></strong>
                <small>{application.role || 'doctor'} • {application.specialty} • Licence {application.licenseNumber} • {application.email}</small>
              </div>
              <div className="inline-actions">
                <button className="secondary small" onClick={() => void openApplication(application.id)}>Review</button>
                {application.status === 'pending' && (
                  <button className="primary small" onClick={() => void handleApprove(application.id)}>Approve</button>
                )}
              </div>
            </motion.div>
          )) : (
            <EmptyState icon="🎓" title="No applications yet" description="Verification requests from the sign-in screen will appear here." />
          )}
        </div>

        {selected && (
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

            <p><strong>Role:</strong> {selected.role || 'doctor'}</p>
            <p><strong>Affiliation:</strong> {selected.affiliation}</p>
            <p><strong>Submitted:</strong> {selected.submittedAt ? new Date(selected.submittedAt).toLocaleString() : ''}</p>
            {selected.rejectionReason && <p><strong>Rejection reason:</strong> {selected.rejectionReason}</p>}

            <p className="eyebrow">documents</p>
            {(selected.documents || []).length ? (
              <ul className="document-list">
                {selected.documents.map((doc: any) => (
                  <li key={doc.filename}>
                    <span>{doc.originalName}</span>
                    <a href="#" onClick={(event) => { event.preventDefault(); void openDocument(doc); }}>Open</a>
                  </li>
                ))}
              </ul>
            ) : (
              <small>No documents uploaded.</small>
            )}

            {selected.status === 'pending' && (
              <>
                <div className="button-row" style={{ marginTop: '1rem' }}>
                  <button className="primary" onClick={() => void handleApprove(selected.id)}>Approve &amp; create account</button>
                </div>
                <label className="field-label">
                  <span>Rejection reason</span>
                  <input value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="e.g. Licence document unreadable" />
                </label>
                <div className="button-row">
                  <button className="danger" onClick={() => void handleReject(selected.id)}>Reject application</button>
                </div>
              </>
            )}
          </div>
        )}
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
    <main id="main-content" tabIndex={-1} className="grid-layout">
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
