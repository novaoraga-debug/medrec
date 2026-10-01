import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { googleEnabled, renderGoogleButton } from './google.js';
import { uploadPrescriptionPhoto } from './api.js';

export const pageTransition = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
  transition: { duration: 0.2, ease: 'easeOut' }
};

export function EmptyState({ icon, title, description, actionLabel, onAction }) {
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

export function SkeletonBlock({ className = '' }) {
  return <div className={`skeleton ${className}`} aria-hidden="true" />;
}

export function PortalHeader({ title, subtitle, role, onSignOut, onSignOutEverywhere }) {
  return (
    <header className="topbar">
      <div className="brand-lockup">
        <div className="brand-mark" aria-hidden="true">M</div>
        <div>
          <p className="eyebrow">MEDREC / {role.toUpperCase()} PORTAL</p>
          <h1>{title}</h1>
          <p className="topbar-subtitle">{subtitle}</p>
        </div>
      </div>
      <div className="topbar-actions">
        <span className="portal-badge">{role} portal</span>
        <button className="secondary small" onClick={onSignOut}>Sign out</button>
        {onSignOutEverywhere && (
          <button className="secondary small" onClick={onSignOutEverywhere} title="Revoke refresh tokens on every device">
            Sign out everywhere
          </button>
        )}
      </div>
    </header>
  );
}

// Official Google button. Renders the real Google widget only when
// VITE_GOOGLE_CLIENT_ID is configured; otherwise a disabled placeholder is
// shown so the UI never looks broken.
export function GoogleSignInButton({ onToken, onError, label = 'Continue with Google' }) {
  const containerRef = useRef(null);
  const tokenRef = useRef(onToken);
  const errorRef = useRef(onError);
  const [status, setStatus] = useState('idle');

  useEffect(() => {
    tokenRef.current = onToken;
  }, [onToken]);

  useEffect(() => {
    errorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    if (!googleEnabled()) {
      setStatus('unconfigured');
      return undefined;
    }

    let cancelled = false;
    setStatus('loading');
    renderGoogleButton(containerRef.current, {
      onToken: (token) => tokenRef.current?.(token),
      onError: (error) => {
        if (!cancelled) setStatus('error');
        errorRef.current?.(error);
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
        aria-label={label}
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
          {status === 'unconfigured' ? `${label} (not configured)` : label}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Prescription photo capture + OCR review (shared by doctor & pharmacist).
// ---------------------------------------------------------------------------

// Quick quality checks before an image is uploaded or OCR'd.
export async function assessImageQuality(file) {
  if (!file) return { ok: false, warnings: ['No image selected.'] };
  const warnings = [];
  if (file.size > 8 * 1024 * 1024) warnings.push('Image is larger than 8 MB and will be rejected.');
  if (file.size < 10 * 1024) warnings.push('Image looks very small — it may be too low quality to read.');

  try {
    const bitmap = await createImageBitmap(file);
    if (bitmap.width < 500 || bitmap.height < 500) {
      warnings.push('Image resolution is low — handwriting may be unreadable. Retake closer up.');
    }
    const canvas = document.createElement('canvas');
    canvas.width = 100;
    canvas.height = 100;
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0, 100, 100);
    const { data } = context.getImageData(0, 0, 100, 100);
    let totalLuma = 0;
    let edgeEnergy = 0;
    for (let i = 0; i < data.length; i += 4) {
      const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      totalLuma += luma;
      if (i >= 4 && Math.abs(luma - (0.299 * data[i - 4] + 0.587 * data[i - 3] + 0.114 * data[i - 2])) > 40) edgeEnergy += 1;
    }
    const avgLuma = totalLuma / (data.length / 4);
    if (avgLuma < 60) warnings.push('Image is very dark — use better lighting or flash.');
    else if (avgLuma > 230) warnings.push('Image is overexposed — reduce glare and retake.');
    if (edgeEnergy < 40) warnings.push('Image looks blurry — hold the camera steady and retake.');
    bitmap.close?.();
  } catch {
    warnings.push('Could not analyse image quality automatically.');
  }

  return { ok: warnings.length === 0, warnings };
}

export function RoleLockedNotice({ portalRole, onSignOut }) {
  return (
    <div className="auth-shell">
      <div className="panel login-panel">
        <p className="eyebrow">access restricted</p>
        <h2>This portal is for {portalRole}s only</h2>
        <p className="hero-copy">
          Your account does not have access to the {portalRole} portal. Please use the portal that
          matches your role, or contact MedRec support.
        </p>
        <div className="button-row">
          <button className="primary" onClick={() => (onSignOut ? onSignOut() : window.location.reload())}>Try another account</button>
        </div>
      </div>
    </div>
  );
}

// Front-end OCR draft: grayscale + contrast boost, then Tesseract.js from CDN.
// The draft is always editable and always requires human verification.
export async function generateOcrDraft(file, onProgress) {
  let processedBlob = file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = bitmap.width < 900 ? Math.min(2, 900 / bitmap.width) : 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext('2d');
    context.filter = 'grayscale(1) contrast(1.4) brightness(1.1)';
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    processedBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  } catch {
    // Fall back to the raw file if the canvas pipeline is unavailable.
  }

  let Tesseract = null;
  try {
    const module = await import('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.esm.min.js');
    Tesseract = module.default || module;
  } catch {
    return {
      text: '',
      confidence: 0,
      engine: 'unavailable',
      warning: 'OCR engine could not be loaded (offline?). You can still upload the photo and transcribe it manually.'
    };
  }

  onProgress?.('Reading handwriting…');
  const result = await Tesseract.recognize(processedBlob, 'eng', {
    logger: (message) => {
      if (message?.status === 'recognizing text' && typeof message.progress === 'number') {
        onProgress?.(`Reading handwriting… ${Math.round(message.progress * 100)}%`);
      }
    }
  });

  return {
    text: (result?.data?.text || '').trim(),
    confidence: Math.round(result?.data?.confidence || 0) / 100,
    engine: 'tesseract-browser',
    warning: (result?.data?.confidence || 0) < 60 ? 'Low OCR confidence — check every field against the photo.' : ''
  };
}

// ---------------------------------------------------------------------------
// Role hero art: hand-crafted animated SVG illustrations, one per portal.
// Gentle, clinical motion (pulse, float, scan) — all disabled with
// prefers-reduced-motion. Pure inline SVG, no external assets.
// ---------------------------------------------------------------------------
export function RoleHeroArt({ role = 'patient' }) {
  return (
    <div className={`hero-art hero-art--${role}`} aria-hidden="true">
      <svg viewBox="0 0 320 240" role="presentation" focusable="false">
        {role === 'patient' && <PatientHeroArt />}
        {role === 'doctor' && <DoctorHeroArt />}
        {role === 'pharmacist' && <PharmacistHeroArt />}
        {(role === 'staff' || role === 'admin') && <StaffHeroArt />}
      </svg>
    </div>
  );
}

function PatientHeroArt() {
  return (
    <>
      <circle className="ha-plate" cx="160" cy="118" r="88" />
      <circle className="ha-ring ha-ring--a" cx="160" cy="118" r="94" />
      <circle className="ha-ring ha-ring--b" cx="160" cy="118" r="94" />
      {/* Heart with a gentle heartbeat */}
      <path
        className="ha-heart"
        d="M160 156c-2.4 0-23.4-14.2-35.4-28.3-9.8-11.4-10.6-28.4 1.4-37.3 10.3-7.7 24.5-5 32.4 4.5l1.6 2 1.6-2c7.9-9.5 22.1-12.2 32.4-4.5 12 8.9 11.2 25.9 1.4 37.3C183.4 141.8 162.4 156 160 156Z"
      />
      {/* ECG trace drawing across */}
      <polyline className="ha-ecg" points="58,110 118,110 132,84 148,136 162,102 172,110 262,110" />
      {/* Floating medication pluses */}
      <g className="ha-float ha-float--a">
        <path d="M232 52h12v12h12v12h-12v12h-12V76h-12V64h12z" />
      </g>
      <g className="ha-float ha-float--b">
        <path d="M76 62h9v9h9v9h-9v9h-9v-9h-9v-9h9z" />
      </g>
    </>
  );
}

function DoctorHeroArt() {
  return (
    <>
      <circle className="ha-plate" cx="160" cy="118" r="88" />
      <circle className="ha-ring ha-ring--a" cx="160" cy="118" r="94" />
      {/* Clipboard */}
      <rect className="ha-board" x="118" y="56" width="84" height="116" rx="12" />
      <rect className="ha-clip" x="144" y="47" width="32" height="15" rx="7" />
      {/* Medical cross on the board */}
      <path className="ha-cross" d="M152 96h16v-14h14v16h14v16h-14v14h-16v-14h-14V98h14z" transform="translate(-8 -4) scale(0.92)" />
      {/* Stethoscope */}
      <path className="ha-scope" d="M104 92v40a24 24 0 0 0 48 0v-12" />
      <circle className="ha-bell" cx="128" cy="160" r="11" />
      {/* Chart line on the board */}
      <polyline className="ha-ecg" points="130,144 142,144 148,130 156,152 164,138 170,144 190,144" />
      {/* Scanning line */}
      <path className="ha-scan" d="M84 60h152" />
      <g className="ha-float ha-float--a">
        <path d="M244 78h10v10h10v10h-10v10h-10V98h-10V88h10z" />
      </g>
    </>
  );
}

function PharmacistHeroArt() {
  return (
    <>
      <circle className="ha-plate" cx="160" cy="118" r="88" />
      <circle className="ha-ring ha-ring--a" cx="160" cy="118" r="94" />
      {/* Medicine bottle */}
      <rect className="ha-board" x="126" y="88" width="68" height="84" rx="12" />
      <rect className="ha-clip" x="134" y="66" width="52" height="24" rx="8" />
      <rect className="ha-label" x="126" y="114" width="68" height="30" />
      <path className="ha-cross" d="M150 121h20v-8h8v8h8v8h-8v8h-8v8h-8v-8h-8v-8h8z" transform="translate(0 8) scale(0.9)" />
      {/* Capsules drifting */}
      <g className="ha-capsule ha-float ha-float--a">
        <rect x="206" y="60" width="40" height="18" rx="9" transform="rotate(-18 226 69)" />
      </g>
      <g className="ha-capsule ha-float ha-float--b">
        <rect x="64" y="138" width="36" height="16" rx="8" transform="rotate(14 82 146)" />
      </g>
      <g className="ha-float ha-float--b">
        <path d="M246 128h9v9h9v9h-9v9h-9v-9h-9v-9h9z" />
      </g>
    </>
  );
}

function StaffHeroArt() {
  return (
    <>
      <circle className="ha-plate" cx="160" cy="118" r="88" />
      <circle className="ha-spin" cx="160" cy="118" r="94" />
      {/* Shield */}
      <path
        className="ha-shield"
        d="M160 54l48 18v38c0 30-20 52-48 62-28-10-48-32-48-62V72l48-18Z"
      />
      {/* Verification check */}
      <path className="ha-check" d="M140 118l15 15 27-30" />
      {/* Access dots */}
      <g className="ha-float ha-float--a">
        <path d="M238 62h10v10h10v10h-10v10h-10V82h-10V72h10z" />
      </g>
      <g className="ha-float ha-float--b">
        <circle cx="82" cy="160" r="7" />
      </g>
    </>
  );
}
export function PrescriptionPhotoCapture({ accessToken, onUploaded, onDraftReady }) {
  const fileInputRef = useRef(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [pendingFile, setPendingFile] = useState(null);
  const [status, setStatus] = useState('Take or choose a prescription photo.');
  const [warnings, setWarnings] = useState([]);
  const [ocrDraft, setOcrDraft] = useState(null);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, []);

  async function handleFile(file) {
    setOcrDraft(null);
    setWarnings([]);
    const quality = await assessImageQuality(file);
    setWarnings(quality.warnings);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(file));
    setPendingFile(file);
    setStatus(quality.ok ? 'Photo ready. Run OCR or upload as-is.' : 'Photo ready with quality warnings.');
  }

  async function openCamera() {
    if (!navigator.mediaDevices?.getUserMedia) { setStatus('Camera not available in this browser.'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      streamRef.current = stream;
      setCameraOpen(true);
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
      setStatus('Camera open. Capture the full prescription in frame.');
    } catch {
      setStatus('Camera permission denied — use file upload instead.');
    }
  }

  function captureFrame() {
    const video = videoRef.current;
    if (!video || video.readyState < 2) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(async (blob) => {
      if (!blob) return;
      const file = new File([blob], `rx-capture-${Date.now()}.jpg`, { type: 'image/jpeg' });
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setCameraOpen(false);
      await handleFile(file);
    }, 'image/jpeg', 0.92);
  }

  async function runOcr() {
    if (!pendingFile) return;
    setOcrBusy(true);
    try {
      const draft = await generateOcrDraft(pendingFile, (message) => setStatus(message));
      setOcrDraft(draft);
      onDraftReady?.(draft);
      setStatus(draft.text
        ? `OCR complete — ${Math.round(draft.confidence * 100)}% confidence. Review every field before submitting.`
        : 'OCR produced no text — transcribe manually below.');
    } catch {
      setStatus('OCR failed — you can still upload the photo and transcribe manually.');
    } finally {
      setOcrBusy(false);
    }
  }

  async function uploadNow(ocrText) {
    if (!pendingFile) return;
    try {
      setStatus('Uploading prescription…');
      const prescription = await uploadPrescriptionPhoto(accessToken, {
        file: pendingFile,
        ocrText: ocrText || ocrDraft?.text || ''
      });
      setStatus('Prescription uploaded. The pharmacist must verify the transcription.');
      onUploaded?.(prescription);
      setPendingFile(null);
      setOcrDraft(null);
      if (previewUrl) { URL.revokeObjectURL(previewUrl); setPreviewUrl(null); }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Upload failed');
    }
  }


  return (
    <div className="rx-capture">
      <div className="button-row">
        <button type="button" className="primary small" onClick={openCamera}>Open camera</button>
        <button type="button" className="secondary small" onClick={() => fileInputRef.current?.click()}>Choose file</button>
        {cameraOpen && <button type="button" className="secondary small" onClick={captureFrame}>Capture photo</button>}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,application/pdf"
        capture="environment"
        hidden
        onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
      />
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={{ width: '100%', borderRadius: '12px', background: '#081b1d', display: cameraOpen ? 'block' : 'none' }}
      />
      {previewUrl && <img src={previewUrl} alt="Prescription preview" className="rx-preview" />}
      <small>{status}</small>
      {warnings.length > 0 && (
        <ul className="rx-quality-warnings">
          {warnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
      )}
      <div className="button-row">
        <button type="button" className="secondary small" disabled={!pendingFile || ocrBusy} onClick={runOcr}>
          {ocrBusy ? 'Reading…' : 'Scan handwriting (OCR)'}
        </button>
        <button type="button" className="primary small" disabled={!pendingFile} onClick={() => uploadNow()}>Upload prescription</button>
      </div>
      {ocrDraft && (
        <label className="field-label">
          <span>OCR draft — edit before submitting {ocrDraft.confidence ? `(${Math.round(ocrDraft.confidence * 100)}% confidence)` : ''}</span>
          <textarea
            rows={4}
            value={ocrDraft.text}
            onChange={(e) => setOcrDraft({ ...ocrDraft, text: e.target.value })}
          />
        </label>
      )}
      {ocrDraft?.warning && <small className="rx-warning">{ocrDraft.warning}</small>}
      {ocrDraft && (
        <div className="button-row">
          <button type="button" className="primary small" onClick={() => uploadNow(ocrDraft.text)}>Upload with corrected text</button>
        </div>
      )}
    </div>
  );
}