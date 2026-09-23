const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { OAuth2Client } = require('google-auth-library');
const { verifySync, createGuardrails } = require('otplib');
const { v4: uuid } = require('uuid');
const { readData, writeData } = require('./store');

// Express 4 does not catch rejected promises returned by async route handlers,
// so a single escaping error (e.g. during MFA verification) would otherwise
// exit the whole process. Log it and keep serving.
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  console.error(`[unhandledRejection] ${message}`);
});

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'replace-me-dev-secret';
const REFRESH_SECRET = process.env.REFRESH_SECRET || 'replace-me-dev-refresh';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'local-dev-google-client';
const QR_SECRET = process.env.QR_SECRET || 'replace-me-qr-secret';

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);
const ADMIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_RATE_LIMIT_MAX = 5;
const ADMIN_SESSION_TTL_SECONDS = 45 * 60;
const ADMIN_ALERT_WEBHOOK_URL = process.env.ADMIN_ALERT_WEBHOOK_URL || '';
const ADMIN_ATTEMPT_TRACKER = new Map();

const uploadDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename: (_, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/\s+/g, '-')}`)
});

const prescriptionUpload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (_, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Only JPEG, PNG, WebP, HEIC, or PDF prescription files are allowed.'));
  }
});

// Authenticated, audit-logged file access. <img>/<a> tags cannot send headers,
// so the browser first exchanges its session token for a short-lived,
// file-scoped token (POST /api/files/token) and loads the file with
// ?file_token=. A full session token is never accepted in a query string, so
// it cannot leak through URLs, server logs, or browser history.
const FILE_TOKEN_TTL = process.env.FILE_TOKEN_TTL || '5m';

function issueFileToken(userPayload, filename) {
  return jwt.sign({ ...userPayload, purpose: 'file', file: filename }, JWT_SECRET, { expiresIn: FILE_TOKEN_TTL });
}

function verifyFileToken(token, filename) {
  const payload = jwt.verify(token, JWT_SECRET);
  if (payload.purpose !== 'file' || payload.file !== filename) {
    throw new Error('File token does not match this file.');
  }
  return payload;
}

function isSafeFilename(filename) {
  return /^[A-Za-z0-9._-]+$/.test(filename) && !filename.includes('..');
}

// Global middleware is registered before any route so helmet headers, CORS,
// logging, body parsing, and rate limits cover EVERY endpoint — the file and
// OCR routes below previously bypassed all of them.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      'script-src': ["'self'", 'https://accounts.google.com'],
      'frame-src': ["'self'", 'https://accounts.google.com'],
      'connect-src': ["'self'", 'https://accounts.google.com'],
      'img-src': ["'self'", 'data:', 'blob:']
    }
  },
  // The portals run on their own origins and load API responses (images
  // included), so cross-origin resources must be allowed.
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
// morgan logs the full URL; redact token query parameters so short-lived file
// tokens (and any stray access_token) never land in request logs.
const TOKEN_QUERY_RE = /([?&](?:file_token|access_token)=)[^&\s]+/gi;
app.use(morgan((_, req, res) => {
  const url = String(req.originalUrl || req.url || '').replace(TOKEN_QUERY_RE, '$1[redacted]');
  const status = res.headersSent ? String(res.statusCode) : '-';
  const durationMs = req._startAt && res._startAt
    ? ((res._startAt[0] - req._startAt[0]) * 1e3 + (res._startAt[1] - req._startAt[1]) * 1e-6).toFixed(3)
    : '-';
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || '-';
  const agent = req.headers['user-agent'] || '-';
  return `${ip} - - "${req.method} ${url} HTTP/${req.httpVersion}" ${status} - "${req.headers.referer || '-'}" "${agent}" ${durationMs} ms`;
}));
// Layered rate limits: a generous global ceiling for everything (registered
// before static/routes), a stricter per-minute budget for API traffic, plus
// the tighter auth/QR route limiters.
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down and try again.' }
});

const auditLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait before retrying.' }
});

const qrLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Public QR verification rate limit reached.' }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts. Please wait and try again.' }
});

app.use(globalLimiter);
app.use('/api', auditLimiter);

app.use(express.static(path.join(__dirname, '../../frontend')));

app.get('/', (_, res) => {
  res.sendFile(path.join(__dirname, '../../frontend/index.html'));
});

app.use((req, _, next) => {
  req.accessReason = req.headers['x-access-reason'] || 'routine-access';
  next();
});

// Mint a short-lived token scoped to a single upload, for <img>/<a> loads.
app.post('/api/files/token', requireAuth, (req, res) => {
  const rawFilename = String(req.body?.filename || '');
  if (!isSafeFilename(rawFilename)) {
    return res.status(400).json({ error: 'Invalid file name.' });
  }
  const filename = path.basename(rawFilename);

  const filePath = path.join(uploadDir, filename);
  if (!filePath.startsWith(uploadDir) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found.' });
  }

  const fileToken = issueFileToken({ sub: req.user.sub, role: req.user.role }, filename);
  logAccess({ actor: req.user.sub, action: 'issue-file-token', resource: `uploads/${filename}`, reason: 'record-access' });
  res.json({ fileToken, expiresIn: FILE_TOKEN_TTL });
});

function resolveUploadToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return { kind: 'access', token: header.slice(7) };
  if (req.query.file_token) return { kind: 'file', token: String(req.query.file_token) };
  return { kind: null, token: null };
}

app.get('/api/files/:filename', (req, res) => {
  // Reject path traversal on the raw (URL-decoded) input before normalizing.
  const rawFilename = String(req.params.filename);
  if (!isSafeFilename(rawFilename)) {
    return res.status(400).json({ error: 'Invalid file name.' });
  }
  const filename = path.basename(rawFilename);

  const { kind, token } = resolveUploadToken(req);
  if (!token) return res.status(401).json({ error: 'Authentication required.' });

  try {
    req.user = kind === 'file'
      ? verifyFileToken(token, filename)
      : verifyAccessToken(token);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired access token.' });
  }

  const filePath = path.join(uploadDir, filename);
  if (!filePath.startsWith(uploadDir) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found.' });
  }

  logAccess({ actor: req.user.sub, action: 'view-file', resource: `uploads/${filename}`, reason: 'record-access' });
  res.sendFile(filePath);
});

// Health check for the prescription OCR pipeline.
app.get('/api/prescriptions/ocr-status', requireAuth, (req, res) => {
  res.json({
    engine: 'medrec-structured-parser',
    version: 1,
    capabilities: ['medication-fuzzy-match', 'frequency-abbreviations', 'field-confidence'],
    note: 'OCR drafts are assistive only and always require human verification.'
  });
});
const applicationUpload = multer({ storage, limits: { files: 5, fileSize: 8 * 1024 * 1024 } });

function makeId(prefix) {
  return `${prefix}-${uuid().slice(0, 8)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function sanitizeUser(user) {
  if (!user) return null;
  const { passwordHash, refreshTokens, ...safeUser } = user;
  return safeUser;
}

function issueToken(subject, payload, secret, expiresIn) {
  return jwt.sign({ ...payload, sub: subject }, secret, { expiresIn });
}

function verifyAccessToken(token) {
  const payload = jwt.verify(token, JWT_SECRET);
  // File-scoped tokens (?file_token=) must never authenticate regular API calls.
  if (payload.purpose === 'file') throw new Error('File tokens are not access tokens.');
  return payload;
}

function verifyRefreshToken(token) {
  return jwt.verify(token, REFRESH_SECRET);
}

function hashPassword(password) {
  return bcrypt.hashSync(password, 12);
}

function comparePassword(inputPassword, hash) {
  return bcrypt.compareSync(inputPassword, hash);
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || 'unknown';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logAdminAttempt({ email, ip, userAgent, success, reason = 'login-attempt' }) {
  console.info(JSON.stringify({
    level: success ? 'info' : 'warn',
    event: 'admin-login-attempt',
    email: email || 'unknown',
    ip,
    userAgent,
    success,
    reason,
    timestamp: nowIso()
  }));
}

async function alertRepeatedAdminFailures(ip, email, userAgent) {
  if (!ADMIN_ALERT_WEBHOOK_URL) {
    console.warn(JSON.stringify({
      level: 'warn',
      event: 'admin-alert',
      message: 'Repeated admin login failures detected',
      ip,
      email,
      userAgent,
      timestamp: nowIso()
    }));
    return;
  }

  try {
    await fetch(ADMIN_ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `Repeated admin login failures detected for IP ${ip}. Email attempted: ${email || 'unknown'}. User agent: ${userAgent || 'unknown'}`
      })
    });
  } catch (error) {
    console.error('Admin alert webhook failed', error);
  }
}

function registerAdminFailure(ip, email, userAgent) {
  const now = Date.now();
  const previous = ADMIN_ATTEMPT_TRACKER.get(ip) || { count: 0, firstAt: now, lastAt: now, email, userAgent };

  const windowAge = now - previous.firstAt;
  if (windowAge > ADMIN_RATE_LIMIT_WINDOW_MS) {
    previous.count = 0;
    previous.firstAt = now;
  }

  previous.count += 1;
  previous.lastAt = now;
  previous.email = email;
  previous.userAgent = userAgent;
  ADMIN_ATTEMPT_TRACKER.set(ip, previous);

  if (previous.count >= ADMIN_RATE_LIMIT_MAX) {
    void alertRepeatedAdminFailures(ip, email, userAgent);
  }
}

function clearAdminFailure(ip) {
  ADMIN_ATTEMPT_TRACKER.delete(ip);
}

async function enforceAdminRateLimit(req, res, next) {
  const ip = getClientIp(req);
  const now = Date.now();
  const record = ADMIN_ATTEMPT_TRACKER.get(ip);

  if (record && record.count >= ADMIN_RATE_LIMIT_MAX && now - record.firstAt < ADMIN_RATE_LIMIT_WINDOW_MS) {
    const retryDelayMs = Math.max(1500, 1000 * (record.count - ADMIN_RATE_LIMIT_MAX + 2));
    await delay(retryDelayMs);
    logAdminAttempt({ email: req.body?.email || 'unknown', ip, userAgent: req.get('user-agent') || 'unknown', success: false, reason: 'rate-limit-exceeded' });
    return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
  }

  next();
}

function encryptSensitive(value) {
  if (!value) return value;
  const algorithm = 'aes-256-gcm';
  const key = crypto.createHash('sha256').update(process.env.SENSITIVE_KEY || 'medrec-dev-sensitive-key').digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptSensitive(value) {
  if (!value || typeof value !== 'string' || !value.includes(':')) return value;
  const [ivHex, tagHex, encryptedHex] = value.split(':');
  const algorithm = 'aes-256-gcm';
  const key = crypto.createHash('sha256').update(process.env.SENSITIVE_KEY || 'medrec-dev-sensitive-key').digest();
  const decipher = crypto.createDecipheriv(algorithm, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}

function logAccess({ actor, action, resource, reason, status = 'success' }) {
  const data = readData();
  const entry = {
    id: makeId('AUD'),
    actor,
    action,
    resource,
    reason,
    status,
    timestamp: nowIso()
  };
  data.audit.unshift(entry);
  writeData(data);
  console.info(JSON.stringify({ level: 'info', event: 'audit', ...entry }));
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  try {
    const payload = verifyAccessToken(token);
    req.user = payload;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired access token.' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Access denied for this role.' });
    }
    next();
  };
}

function requireAdminAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  try {
    const payload = verifyAccessToken(token);
    if (!payload.admin && !['super_admin', 'clinic_admin'].includes(payload.role)) {
      return res.status(403).json({ error: 'Access denied for this admin role.' });
    }
    req.user = payload;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired access token.' });
  }
}

function requireClinicScope(req, res, next) {
  const user = req.user;
  if (!user || user.role === 'super_admin') {
    return next();
  }

  if (user.role !== 'clinic_admin') {
    return res.status(403).json({ error: 'Clinic scope required.' });
  }

  const requestedClinic = req.params.clinicId || req.body?.clinicId || req.query?.clinicId || req.params?.id;
  if (user.clinicId && requestedClinic && user.clinicId !== requestedClinic) {
    return res.status(403).json({ error: 'Clinic scope mismatch.' });
  }

  next();
}

function consentActiveFor(patientId, actorRole, actorId, data = readData()) {
  if (actorRole === 'admin' || actorRole === 'patient') return true;

  const patient = data.patients.find((entry) => entry.id === patientId);
  if (!patient) return false;

  const activeConsent = data.consents.find((entry) =>
    entry.patientId === patientId &&
    entry.actorId === actorId &&
    entry.status === 'approved' &&
    Date.now() < new Date(entry.expiresAt).getTime()
  );

  return Boolean(activeConsent || patient.ownerId === actorId);
}

const KNOWN_MEDICATIONS = [
  'amoxicillin', 'metformin', 'ibuprofen', 'paracetamol', 'acetaminophen', 'atorvastatin',
  'salbutamol', 'albuterol', 'cetirizine', 'insulin', 'azithromycin', 'lisinopril',
  'amlodipine', 'omeprazole', 'prednisone', 'warfarin', 'gabapentin', 'sertraline'
];

const FREQUENCY_MAP = [
  // Longer, more specific phrases must be checked before bare "daily"/"od",
  // otherwise "twice daily" would be swallowed by the generic daily rule.
  { pattern: /\b(bd|bid|twice daily|2\s*x\s*(a\s*)?day)\b/i, normalized: 'twice daily', confidence: 0.9 },
  { pattern: /\b(tds|tid|three times daily|3\s*x\s*(a\s*)?day)\b/i, normalized: 'three times daily', confidence: 0.9 },
  { pattern: /\b(qds|qid|four times daily|4\s*x\s*(a\s*)?day)\b/i, normalized: 'four times daily', confidence: 0.9 },
  { pattern: /\b(od|once daily|1\s*x\s*(a\s*)?day)\b/i, normalized: 'once daily', confidence: 0.9 },
  { pattern: /\b(prn|as needed)\b/i, normalized: 'as needed', confidence: 0.85 },
  { pattern: /\b(every\s+\d+\s*(hours|hrs))\b/i, normalized: null, confidence: 0.9 },
  { pattern: /\bdaily\b/i, normalized: 'once daily', confidence: 0.8 },
  { pattern: /\b(morning|night|evening|nocte|mane)\b/i, normalized: null, confidence: 0.7 }
];

// Levenshtein distance used for fuzzy medication-name matching (OCR typos).
function levenshtein(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = Array.from({ length: cols }, (_, i) => i);
  for (let i = 1; i < rows; i += 1) {
    const curr = [i];
    for (let j = 1; j < cols; j += 1) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = curr;
  }
  return prev[cols - 1];
}

function matchMedicationName(word) {
  const clean = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!clean || clean.length < 3) return null;
  const exact = KNOWN_MEDICATIONS.find((med) => med === clean);
  if (exact) return { name: exact, confidence: 0.95, distance: 0 };
  let best = null;
  for (const med of KNOWN_MEDICATIONS) {
    const distance = levenshtein(clean, med);
    const tolerance = med.length >= 8 ? 2 : 1;
    if (distance <= tolerance && (!best || distance < best.distance)) {
      best = { name: med, confidence: Math.max(0.5, 0.9 - distance * 0.2), distance };
    }
  }
  return best;
}

// Structured transcription of free prescription text. Every field carries a
// confidence so the pharmacist UI can flag low-certainty readings for review.
function cleanPrescription(rawText) {
  const text = rawText || '';
  const lines = text.split(/\n|;/).map((line) => line.trim()).filter(Boolean);
  const warnings = [];

  let medicationMatch = null;
  for (const line of lines) {
    const tokens = line.split(/\s+/);
    for (const token of tokens) {
      const match = matchMedicationName(token);
      if (match) {
        medicationMatch = { line, token, match };
        break;
      }
    }
    if (medicationMatch) break;
  }

  const dosageMatch = lines.find((line) => /\d+\s*(mg|mcg|g|ml|iu|tablet|capsule)/i.test(line));
  let frequency = null;
  let frequencyConfidence = 0;
  for (const rule of FREQUENCY_MAP) {
    const found = lines.find((line) => rule.pattern.test(line));
    if (found) {
      const raw = found.match(rule.pattern)?.[0] || '';
      frequency = rule.normalized || raw.toLowerCase();
      frequencyConfidence = rule.confidence;
      if (!rule.normalized) {
        frequency = frequency.match(/every\s+\d+\s*(hours|hrs)/i)?.[0] || frequency;
      }
      break;
    }
  }
  const durationMatch = lines.find((line) => /(for\s+\d+\s*(days|weeks|months)|\d+\s*(days|weeks|months))/i.test(line));

  let drug = 'Medication';
  let drugConfidence = 0.2;
  if (medicationMatch) {
    drug = medicationMatch.match.name;
    drugConfidence = medicationMatch.match.confidence;
    if (medicationMatch.match.distance > 0) {
      warnings.push(`Medication name "${medicationMatch.token}" was read as "${drug}" — verify against the original.`);
    }
  } else {
    // Fall back to the legacy leading-token heuristic for unknown drugs.
    const fallback = lines.find((line) => /\d/.test(line)) || lines[0] || '';
    const token = fallback.split(/\s+(?=\d)/)[0].replace(/[^a-zA-Z]/g, '');
    if (token) {
      drug = token.toLowerCase();
      drugConfidence = 0.3;
      warnings.push(`Medication name "${token}" is not in the recognized formulary — manual verification required.`);
    }
  }

  if (!dosageMatch) warnings.push('Dosage not clearly detected — confirm the dose before dispensing.');
  if (!frequency) warnings.push('Frequency not detected — confirm how often the medication is taken.');
  if (!durationMatch) warnings.push('Duration not detected — confirm the treatment length.');

  const dosage = dosageMatch ? dosageMatch.match(/\d+\s*(?:mg|mcg|g|ml|iu|tablet|capsule)/i)?.[0] || 'standard dose' : 'standard dose';
  const duration = durationMatch ? durationMatch.match(/(for\s+\d+\s*(?:days|weeks|months)|\d+\s*(?:days|weeks|months))/i)?.[0] || 'duration not specified' : 'duration not specified';

  const confidence = Math.round(((drugConfidence * 2) + (dosageMatch ? 0.9 : 0.2) + (frequencyConfidence || 0.2) + (durationMatch ? 0.9 : 0.2)) / 5 * 100) / 100;

  return {
    drug: drug.charAt(0).toUpperCase() + drug.slice(1),
    dosage,
    frequency: frequency || 'as directed',
    duration: duration.toLowerCase(),
    instructions: 'AI-assisted transcription — pending confirmation. Clinician review required before dispensing.',
    confidence,
    warnings
  };
}

function evaluateMedicationSafety(patient, prescription) {
  const activeMeds = patient?.activeMeds || [];
  const allergies = patient?.allergies || [];
  const warnings = [];
  const drugName = (prescription.drug || '').toLowerCase();

  const allergyFamilyMap = [
    { family: 'penicillin', aliases: ['penicillin', 'amoxicillin', 'ampicillin', 'cloxacillin'] },
    { family: 'sulfa', aliases: ['sulfa', 'sulfonamide', 'trimethoprim'] },
    { family: 'ibuprofen', aliases: ['ibuprofen', 'naproxen'] }
  ];

  const familyMatch = allergyFamilyMap.some(({ aliases }) => {
    const normalizedDrug = drugName.replace(/[^a-z]/g, '');
    return aliases.some((alias) => {
      const normalizedAlias = alias.replace(/[^a-z]/g, '');
      return normalizedDrug.includes(normalizedAlias) || normalizedAlias.includes(normalizedDrug);
    });
  });

  const allergyHit = allergies.some((item) => {
    const normalizedItem = item.toLowerCase().replace(/[^a-z]/g, '');
    const normalizedDrug = drugName.replace(/[^a-z]/g, '');
    return normalizedItem.includes(normalizedDrug) || normalizedDrug.includes(normalizedItem) || familyMatch;
  });

  if (allergyHit) {
    warnings.push('Allergy flag: the selected medication may match a documented allergy.');
  }

  if (activeMeds.some((entry) => entry.name.toLowerCase().includes('metformin') && drugName.includes('ibuprofen'))) {
    warnings.push('Metformin + ibuprofen interaction warning: monitor renal function and hydration status.');
  }

  if (activeMeds.some((entry) => entry.name.toLowerCase().includes('atorvastatin') && drugName.includes('amoxicillin'))) {
    warnings.push('Potential issue: amoxicillin may require tailored monitoring if co-administered with some cardiovascular therapy.');
  }

  if (warnings.length === 0) {
    warnings.push('No direct contraindication matched the active medication list.');
  }

  return {
    warnings,
    overrideRequired: warnings.some((warning) => warning.toLowerCase().includes('allergy') || warning.toLowerCase().includes('interaction')),
    patientId: patient?.id || null
  };
}

function buildGuestPatientRecord(input = {}) {
  const now = nowIso();
  return {
    id: makeId('PT'),
    ownerId: input.ownerId || null,
    name: input.name || 'Walk-in patient',
    dob: input.dob || '1990-01-01',
    gender: input.gender || 'unknown',
    mrn: input.mrn || `MRN-${Date.now()}`,
    insurance: input.insurance || 'Unassigned',
    activeMeds: input.activeMeds || [],
    allergies: input.allergies || [],
    diagnoses: input.diagnoses || [],
    immunizations: input.immunizations || [],
    visitHistory: input.visitHistory || [],
    preferredLanguage: input.preferredLanguage || 'English',
    status: 'unclaimed',
    claimToken: input.claimToken || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    consent: { patientControlled: false, emergencyBreakGlass: 'Enabled', status: 'pending-claim' },
    isGuest: true,
    createdAt: now,
    updatedAt: now
  };
}

function claimGuestPatientRecord(patient, user, payload = {}) {
  if (!patient || patient.status !== 'unclaimed') {
    return null;
  }

  if (payload.email && user.email && user.email.toLowerCase() !== payload.email.toLowerCase()) {
    return null;
  }

  patient.ownerId = user.id;
  patient.status = 'claimed';
  patient.isGuest = false;
  patient.claimToken = null;
  patient.consent = { patientControlled: true, emergencyBreakGlass: 'Enabled', status: 'claimed' };
  patient.updatedAt = nowIso();
  return patient;
}

function buildFhirBundle(patient, data = readData()) {
  const prescriptions = (data.prescriptions || []).filter((entry) => entry.patientId === patient.id);
  const consents = (data.consents || []).filter((entry) => entry.patientId === patient.id);

  return {
    resourceType: 'Bundle',
    type: 'collection',
    timestamp: nowIso(),
    entry: [
      {
        resource: {
          resourceType: 'Patient',
          id: patient.id,
          identifier: [{ system: 'https://medrec.local/mrn', value: patient.mrn }],
          name: [{ text: patient.name }],
          birthDate: patient.dob,
          gender: patient.gender || 'unknown',
          telecom: patient.phone ? [{ system: 'phone', value: patient.phone }] : []
        }
      },
      {
        resource: {
          resourceType: 'AllergyIntolerance',
          id: makeId('allergy'),
          patient: { reference: `Patient/${patient.id}` },
          code: { text: (patient.allergies || [])[0] || 'No known allergy' },
          clinicalStatus: { text: 'active' }
        }
      },
      {
        resource: {
          resourceType: 'MedicationStatement',
          id: makeId('med'),
          status: 'active',
          subject: { reference: `Patient/${patient.id}` },
          medicationCodeableConcept: { text: (patient.activeMeds || [])[0]?.name || 'Medication not recorded' }
        }
      },
      ...prescriptions.map((prescription) => ({
        resource: {
          resourceType: 'MedicationRequest',
          id: prescription.id,
          status: prescription.status || 'active',
          intent: 'order',
          subject: { reference: `Patient/${patient.id}` },
          medicationCodeableConcept: { text: prescription.cleaned?.drug || prescription.original || 'Medication' },
          dosageInstruction: [{
            text: `${prescription.cleaned?.dosage || 'standard dose'} ${prescription.cleaned?.frequency || 'as directed'}`
          }],
          authoredOn: prescription.createdAt || nowIso()
        }
      })),
      ...consents.map((consent) => ({
        resource: {
          resourceType: 'Consent',
          id: consent.id,
          status: consent.status === 'approved' ? 'active' : 'inactive',
          scope: { text: 'patient-access' },
          category: [{ text: consent.purpose || 'care-access' }],
          patient: { reference: `Patient/${patient.id}` },
          dateTime: consent.createdAt || nowIso()
        }
      }))
    ]
  };
}

function queueOfflineSyncEntry(data, payload = {}) {
  const original = payload || {};
  const recordId = original.recordId || original.id || makeId('SYNC');
  const normalized = {
    id: makeId('Q'),
    type: original.type || 'sync',
    recordType: original.recordType || 'patient-record',
    recordId,
    payload: original.payload || original,
    createdAt: nowIso(),
    status: 'queued',
    conflictState: 'last-write-wins'
  };

  const duplicate = (data.syncQueue || []).find((item) => item.recordId === recordId && item.status === 'queued');
  if (duplicate) {
    normalized.conflictState = 'manual-review';
    normalized.status = 'queued-conflict';
  }

  data.syncQueue = [...(data.syncQueue || []), normalized];
  return normalized;
}

app.get('/api/health', (_, res) => {
  res.json({ status: 'ok', timestamp: nowIso() });
});

app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { email, password, role = 'patient', firstName, lastName, phone, specialty, licenseNumber } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const data = readData();
  const emailLower = email.toLowerCase();
  const existing = data.users.find((user) => user.email.toLowerCase() === emailLower);
  if (existing) {
    return res.status(409).json({ error: 'Account already exists for this email.' });
  }

  const user = {
    id: makeId('USR'),
    email: emailLower,
    firstName: firstName || 'New',
    lastName: lastName || 'User',
    phone: phone || '',
    role,
    passwordHash: hashPassword(password),
    provider: 'email',
    verifiedEmail: true,
    mfaEnabled: role === 'doctor' || role === 'admin',
    refreshTokens: [],
    createdAt: nowIso(),
    status: 'active',
    specialty: specialty || '',
    licenseNumber: licenseNumber || ''
  };

  data.users.push(user);
  if (role === 'doctor') {
    data.doctors.push({
      id: makeId('DR'),
      userId: user.id,
      name: `${user.firstName} ${user.lastName}`,
      specialty: specialty || 'General Medicine',
      licenseNumber: licenseNumber || 'PENDING',
      affiliation: 'Pending verification',
      verificationStatus: 'pending',
      verified: false,
      createdAt: nowIso()
    });
  }
  writeData(data);

  const accessToken = issueToken(user.id, { role: user.role, email: user.email }, JWT_SECRET, '15m');
  const refreshToken = issueToken(user.id, { role: user.role, type: 'refresh' }, REFRESH_SECRET, '30d');
  const userRecord = sanitizeUser(user);

  user.refreshTokens.push(refreshToken);
  writeData(data);

  logAccess({ actor: user.id, action: 'register-account', resource: 'users', reason: 'first-time-account-creation' });
  res.status(201).json({ user: userRecord, accessToken, refreshToken, expiresInSeconds: 15 * 60 });
});

app.post('/api/auth/login', authLimiter, (req, res) => {
  const { email, password } = req.body;
  const data = readData();
  const user = data.users.find((entry) => entry.email.toLowerCase() === String(email).toLowerCase());

  if (!user || !comparePassword(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const accessToken = issueToken(user.id, { role: user.role, email: user.email }, JWT_SECRET, '15m');
  const refreshToken = issueToken(user.id, { role: user.role, type: 'refresh' }, REFRESH_SECRET, '30d');
  if (!user.refreshTokens) user.refreshTokens = [];
  user.refreshTokens.push(refreshToken);
  writeData(data);

  logAccess({ actor: user.id, action: 'login', resource: 'auth', reason: 'user-login' });
  res.json({ user: sanitizeUser(user), accessToken, refreshToken, expiresInSeconds: 15 * 60 });
});

// Only these roles may self-serve with Google. Privileged roles must use their
// dedicated flows: doctors go through application review, admins use MFA login.
const GOOGLE_SELF_SERVICE_ROLES = ['patient', 'pharmacist'];
const PRIVILEGED_ROLES = ['doctor', 'admin', 'super_admin', 'clinic_admin'];

app.get('/api/auth/providers', (_, res) => {
  res.json({
    google: {
      enabled: Boolean(process.env.GOOGLE_CLIENT_ID),
      clientId: process.env.GOOGLE_CLIENT_ID || null
    },
    password: true
  });
});

app.post('/api/auth/google', authLimiter, async (req, res) => {
  const { idToken, role, firstName, lastName, phone } = req.body;
  if (!idToken) {
    return res.status(400).json({ error: 'Google ID token is required.' });
  }

  const requestedRole = String(role || 'patient').toLowerCase();
  if (PRIVILEGED_ROLES.includes(requestedRole)) {
    if (requestedRole === 'doctor') {
      return res.status(403).json({ error: 'Doctor accounts require verification. Please apply through the doctor portal.' });
    }
    return res.status(403).json({ error: 'This role cannot be used with Google sign-in.' });
  }
  if (!GOOGLE_SELF_SERVICE_ROLES.includes(requestedRole)) {
    return res.status(403).json({ error: 'Unsupported role for Google sign-in.' });
  }

  try {
    const ticket = await googleClient.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    if (!payload?.email || payload.email_verified === false) {
      return res.status(401).json({ error: 'Google token missing a verified email.' });
    }

    const data = readData();
    const emailLower = String(payload.email).toLowerCase();
    let user = data.users.find((entry) => entry.email.toLowerCase() === emailLower);
    let isNewUser = false;

    if (!user) {
      user = {
        id: makeId('USR'),
        email: emailLower,
        firstName: firstName || payload.given_name || 'Google',
        lastName: lastName || payload.family_name || 'User',
        phone: phone || '',
        role: requestedRole,
        passwordHash: hashPassword(`${crypto.randomBytes(24).toString('hex')}A1!`),
        provider: 'google',
        verifiedEmail: true,
        mfaEnabled: false,
        refreshTokens: [],
        createdAt: nowIso(),
        status: 'active',
        specialty: '',
        licenseNumber: ''
      };
      data.users.push(user);
      isNewUser = true;
    } else {
      const existingRole = String(user.role || '').toLowerCase();
      // A Google login must never escalate or change an existing account's role.
      if (PRIVILEGED_ROLES.includes(existingRole)) {
        return res.status(403).json({ error: 'This role cannot sign in with Google. Use the correct portal.' });
      }
      if (existingRole !== requestedRole) {
        return res.status(403).json({ error: 'This account is registered with a different role. Use the correct portal.' });
      }
      user.provider = user.provider === 'email' ? 'email+google' : user.provider;
      user.firstName = firstName || user.firstName || payload.given_name || 'Google';
      user.lastName = lastName || user.lastName || payload.family_name || 'User';
      user.phone = phone || user.phone || '';
      user.verifiedEmail = true;
    }

    const accessToken = issueToken(user.id, { role: user.role, email: user.email }, JWT_SECRET, '15m');
    const refreshToken = issueToken(user.id, { role: user.role, type: 'refresh' }, REFRESH_SECRET, '30d');
    user.refreshTokens = user.refreshTokens || [];
    user.refreshTokens.push(refreshToken);
    writeData(data);

    logAccess({ actor: user.id, action: isNewUser ? 'google-register' : 'google-login', resource: 'auth', reason: 'oauth-authorized' });
    res.status(isNewUser ? 201 : 200).json({
      user: sanitizeUser(user),
      accessToken,
      refreshToken,
      expiresInSeconds: 15 * 60,
      isNewUser
    });
  } catch (error) {
    console.error('Google OAuth verification failed', error);
    res.status(401).json({ error: 'Google sign-in verification failed.' });
  }
});

app.post('/api/auth/onboard', requireAuth, (req, res) => {
  const data = readData();
  const user = data.users.find((entry) => entry.id === req.user.sub);
  if (!user) {
    return res.status(404).json({ error: 'User not found.' });
  }

  user.role = req.body.role || user.role || 'patient';
  user.specialty = req.body.specialty || user.specialty || '';
  user.licenseNumber = req.body.licenseNumber || user.licenseNumber || '';
  user.phone = req.body.phone || user.phone || '';
  user.mfaEnabled = user.role === 'doctor' || user.role === 'admin';
  writeData(data);

  logAccess({ actor: user.id, action: 'complete-onboarding', resource: 'users', reason: 'profile-completion' });
  res.json({ user: sanitizeUser(user) });
});

app.post('/api/auth/refresh', (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    return res.status(400).json({ error: 'Refresh token required.' });
  }

  try {
    const payload = verifyRefreshToken(refreshToken);
    const data = readData();
    const user = data.users.find((entry) => entry.id === payload.sub);
    if (!user || !user.refreshTokens?.includes(refreshToken)) {
      return res.status(401).json({ error: 'Refresh token invalid or revoked.' });
    }

    const accessToken = issueToken(user.id, { role: user.role, email: user.email }, JWT_SECRET, '15m');
    res.json({ accessToken });
  } catch (error) {
    res.status(401).json({ error: 'Refresh token expired or invalid.' });
  }
});

app.post('/api/admin/login', enforceAdminRateLimit, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const mfaCode = String(req.body?.mfaCode || '');
  const ip = getClientIp(req);
  const userAgent = req.get('user-agent') || 'unknown';

  await delay(260);

  const data = readData();
  const candidate = data.users.find((entry) => entry.email.toLowerCase() === email && ['super_admin', 'clinic_admin'].includes(entry.role));

  const dummyHash = hashPassword(`${Date.now()}-${Math.random().toString(36).slice(2)}-admin-dummy`);
  const passwordValid = candidate ? comparePassword(password, candidate.passwordHash) : comparePassword(password, dummyHash);

  if (!candidate || !passwordValid) {
    registerAdminFailure(ip, email, userAgent);
    logAdminAttempt({ email, ip, userAgent, success: false, reason: 'invalid-credentials' });
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  if (!mfaCode) {
    logAdminAttempt({ email, ip, userAgent, success: false, reason: 'mfa-required' });
    return res.status(401).json({ error: 'MFA required', requiresMfa: true });
  }

  // otplib v13 removed the v12 authenticator.check API; verifySync returns
  // { valid }. The seeded demo secrets are short base32 strings, so relax the
  // RFC minimum-length guardrail, and treat any thrown error as an invalid
  // code — as an async Express 4 handler, an escaping rejection kills the
  // whole process.
  let mfaValid = false;
  try {
    mfaValid = Boolean(candidate.totpSecret && verifySync({
      token: mfaCode,
      secret: candidate.totpSecret,
      epochTolerance: 30,
      guardrails: createGuardrails({ MIN_SECRET_BYTES: 10 })
    })?.valid);
  } catch {
    mfaValid = false;
  }

  if (!mfaValid) {
    registerAdminFailure(ip, email, userAgent);
    logAdminAttempt({ email, ip, userAgent, success: false, reason: 'invalid-mfa' });
    return res.status(401).json({ error: 'Invalid MFA code' });
  }

  clearAdminFailure(ip);
  const accessToken = issueToken(candidate.id, {
    role: candidate.role,
    email: candidate.email,
    clinicId: candidate.clinicId || null,
    admin: true,
    type: 'admin-session'
  }, JWT_SECRET, `${ADMIN_SESSION_TTL_SECONDS}s`);

  logAdminAttempt({ email, ip, userAgent, success: true, reason: 'admin-login-success' });
  return res.json({
    user: sanitizeUser(candidate),
    accessToken,
    expiresInSeconds: ADMIN_SESSION_TTL_SECONDS,
    admin: true
  });
});

app.get('/api/admin/me', requireAdminAuth, (req, res) => {
  const data = readData();
  const adminUser = data.users.find((entry) => entry.id === req.user.sub);
  if (!adminUser) {
    return res.status(404).json({ error: 'Admin not found.' });
  }
  res.json({ user: sanitizeUser(adminUser), admin: true });
});

app.post('/api/auth/logout-all', requireAuth, (req, res) => {
  const data = readData();
  const user = data.users.find((entry) => entry.id === req.user.sub);
  if (!user) {
    return res.status(404).json({ error: 'User not found.' });
  }

  user.refreshTokens = [];
  writeData(data);
  logAccess({ actor: user.id, action: 'logout-all-devices', resource: 'auth', reason: 'security-revocation' });
  res.json({ success: true, message: 'All refresh tokens revoked.' });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const data = readData();
  const user = data.users.find((entry) => entry.id === req.user.sub);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json({ user: sanitizeUser(user) });
});

function collectUploadedDocuments(files = []) {
  return files.map((file) => ({
    filename: file.filename,
    originalName: file.originalname,
    mimetype: file.mimetype,
    size: file.size,
    url: `/uploads/${file.filename}`,
    uploadedAt: nowIso()
  }));
}

function doctorNameFrom(firstName, lastName) {
  const name = `${firstName || 'Doctor'} ${lastName || 'User'}`.trim();
  return name.toLowerCase().startsWith('dr.') ? name : `Dr. ${name}`;
}

// Public: submit a verification application. No login account is created here.
app.post('/api/doctors/apply', applicationUpload.array('documents', 5), (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const firstName = String(req.body.firstName || '').trim();
  const lastName = String(req.body.lastName || '').trim();
  const licenseNumber = String(req.body.licenseNumber || '').trim();

  if (!email || !password || !firstName || !lastName || !licenseNumber) {
    return res.status(400).json({ error: 'Name, email, password, and license number are required.' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const data = readData();
  if (data.users.some((user) => user.email.toLowerCase() === email)) {
    return res.status(409).json({ error: 'An account already exists for this email.' });
  }

  const existingApplication = (data.doctorApplications || []).find(
    (application) => application.email === email && ['pending', 'under_review'].includes(application.status)
  );
  if (existingApplication) {
    return res.status(409).json({ error: 'An application for this email is already awaiting review.' });
  }

  const documents = collectUploadedDocuments(req.files || []);
  const application = {
    id: makeId('APP'),
    firstName,
    lastName,
    name: doctorNameFrom(firstName, lastName),
    email,
    passwordHash: hashPassword(password),
    specialty: String(req.body.specialty || 'General Medicine').trim() || 'General Medicine',
    licenseNumber,
    affiliation: String(req.body.affiliation || 'Pending verification').trim() || 'Pending verification',
    clinicId: req.body.clinicId || 'CLINIC-NAIROBI',
    phone: req.body.phone || '',
    documents,
    status: 'pending',
    submittedAt: nowIso(),
    reviewedBy: null,
    reviewedAt: null,
    rejectionReason: null,
    createdUserId: null,
    createdDoctorId: null
  };

  data.doctorApplications = [...(data.doctorApplications || []), application];
  writeData(data);

  logAccess({ actor: application.id, action: 'submit-doctor-application', resource: `doctorApplications/${application.id}`, reason: 'doctor-verification-request' });

  res.status(201).json({
    application: {
      id: application.id,
      name: application.name,
      email: application.email,
      specialty: application.specialty,
      licenseNumber: application.licenseNumber,
      affiliation: application.affiliation,
      status: application.status,
      documents: application.documents,
      submittedAt: application.submittedAt
    },
    message: 'Application submitted. A staff administrator will review your documents before your account is created.'
  });
});

// Public: check the status of a submitted application.
app.get('/api/doctors/apply/status', (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!email) {
    return res.status(400).json({ error: 'Email query is required.' });
  }

  const data = readData();
  const application = (data.doctorApplications || [])
    .filter((entry) => entry.email === email)
    .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt))[0];

  if (!application) {
    return res.status(404).json({ error: 'No application found for this email.' });
  }

  res.json({
    id: application.id,
    name: application.name,
    status: application.status,
    submittedAt: application.submittedAt,
    reviewedAt: application.reviewedAt,
    rejectionReason: application.rejectionReason,
    accountCreated: Boolean(application.createdUserId)
  });
});

// Kept for backward compatibility: an already-authenticated doctor can register a doctor record.
app.post('/api/doctors/register', requireAuth, (req, res) => {
  const data = readData();
  const doctor = {
    id: makeId('DR'),
    userId: req.user.sub,
    name: `${req.body.firstName || 'Doctor'} ${req.body.lastName || 'User'}`,
    specialty: req.body.specialty || 'General Medicine',
    licenseNumber: req.body.licenseNumber || 'PENDING',
    affiliation: req.body.affiliation || 'Pending verification',
    verificationStatus: 'pending',
    verified: false,
    documents: [],
    documentUrl: req.body.documentUrl || '',
    appliedAt: nowIso(),
    createdAt: nowIso()
  };

  data.doctors.push(doctor);
  writeData(data);
  logAccess({ actor: req.user.sub, action: 'register-doctor', resource: 'doctors', reason: req.accessReason });
  res.status(201).json(doctor);
});

app.get('/api/doctors/pending', requireAdminAuth, (req, res) => {
  const data = readData();
  res.json(data.doctors.filter((doctor) => doctor.verificationStatus === 'pending'));
});

// Staff/admin: list doctor applications awaiting or already through review.
app.get('/api/admin/doctor-applications', requireAdminAuth, (req, res) => {
  const data = readData();
  const status = req.query.status ? String(req.query.status) : null;
  let applications = [...(data.doctorApplications || [])];

  if (req.user.role === 'clinic_admin' && req.user.clinicId) {
    applications = applications.filter((application) => !application.clinicId || application.clinicId === req.user.clinicId);
  }

  if (status) {
    applications = applications.filter((application) => application.status === status);
  }

  applications.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));

  res.json(applications.map((application) => ({
    id: application.id,
    name: application.name,
    email: application.email,
    specialty: application.specialty,
    licenseNumber: application.licenseNumber,
    affiliation: application.affiliation,
    clinicId: application.clinicId,
    status: application.status,
    documentCount: (application.documents || []).length,
    submittedAt: application.submittedAt,
    reviewedAt: application.reviewedAt,
    rejectionReason: application.rejectionReason
  })));
});

// Staff/admin: full detail of a single application, including document links.
app.get('/api/admin/doctor-applications/:id', requireAdminAuth, (req, res) => {
  const data = readData();
  const application = (data.doctorApplications || []).find((entry) => entry.id === req.params.id);
  if (!application) return res.status(404).json({ error: 'Application not found.' });

  if (req.user.role === 'clinic_admin' && req.user.clinicId && application.clinicId && application.clinicId !== req.user.clinicId) {
    return res.status(403).json({ error: 'Clinic scope mismatch.' });
  }

  const { passwordHash, ...safeApplication } = application;
  res.json(safeApplication);
});

// Staff/admin: approve an application -> creates the doctor account + QR + doctor record.
app.post('/api/admin/doctor-applications/:id/approve', requireAdminAuth, (req, res) => {
  const data = readData();
  const application = (data.doctorApplications || []).find((entry) => entry.id === req.params.id);
  if (!application) return res.status(404).json({ error: 'Application not found.' });

  if (req.user.role === 'clinic_admin' && req.user.clinicId && application.clinicId && application.clinicId !== req.user.clinicId) {
    return res.status(403).json({ error: 'Clinic scope mismatch.' });
  }

  if (application.status === 'approved' && application.createdUserId) {
    return res.status(409).json({ error: 'This application has already been approved.' });
  }

  if (data.users.some((user) => user.email.toLowerCase() === application.email)) {
    return res.status(409).json({ error: 'An account already exists for this email.' });
  }

  const clinicId = req.body.clinicId || application.clinicId || (req.user.clinicId || 'CLINIC-NAIROBI');

  const user = {
    id: makeId('USR'),
    email: application.email,
    firstName: application.firstName,
    lastName: application.lastName,
    phone: application.phone || '',
    role: 'doctor',
    passwordHash: application.passwordHash,
    provider: 'email',
    verifiedEmail: true,
    mfaEnabled: true,
    refreshTokens: [],
    createdAt: nowIso(),
    status: 'active',
    specialty: application.specialty,
    licenseNumber: application.licenseNumber,
    clinicId
  };
  data.users.push(user);

  const doctor = {
    id: makeId('DR'),
    userId: user.id,
    name: application.name,
    specialty: application.specialty,
    licenseNumber: application.licenseNumber,
    email: application.email,
    affiliation: req.body.affiliation || application.affiliation,
    clinicId,
    verified: true,
    verificationStatus: 'approved',
    roles: ['Doctor'],
    documents: application.documents || [],
    appliedAt: application.submittedAt,
    approvedAt: nowIso(),
    reviewedBy: req.user.sub,
    createdAt: nowIso()
  };
  doctor.qrToken = issueToken(doctor.id, { type: 'doctor-qr', doctorId: doctor.id, verified: true }, QR_SECRET, '5m');
  data.doctors.push(doctor);

  application.status = 'approved';
  application.reviewedBy = req.user.sub;
  application.reviewedAt = nowIso();
  application.createdUserId = user.id;
  application.createdDoctorId = doctor.id;

  data.notifications.unshift({
    id: makeId('NOT'),
    patientId: null,
    channel: 'email',
    title: 'Doctor verification approved',
    message: `Your MedRec doctor account has been approved. You can now sign in and generate your verification QR code.`,
    read: false,
    createdAt: nowIso()
  });

  writeData(data);
  logAccess({ actor: req.user.sub, action: 'approve-doctor-application', resource: `doctorApplications/${application.id}`, reason: 'staff-verification' });

  res.json({ application, doctor, user: sanitizeUser(user) });
});

// Staff/admin: reject an application with a reason.
app.post('/api/admin/doctor-applications/:id/reject', requireAdminAuth, (req, res) => {
  const data = readData();
  const application = (data.doctorApplications || []).find((entry) => entry.id === req.params.id);
  if (!application) return res.status(404).json({ error: 'Application not found.' });

  if (req.user.role === 'clinic_admin' && req.user.clinicId && application.clinicId && application.clinicId !== req.user.clinicId) {
    return res.status(403).json({ error: 'Clinic scope mismatch.' });
  }

  application.status = 'rejected';
  application.reviewedBy = req.user.sub;
  application.reviewedAt = nowIso();
  application.rejectionReason = String(req.body.reason || 'Documents could not be verified.').trim();
  writeData(data);

  logAccess({ actor: req.user.sub, action: 'reject-doctor-application', resource: `doctorApplications/${application.id}`, reason: 'staff-verification' });
  res.json(application);
});

app.post('/api/admin/doctors/:id/approve', requireAdminAuth, (req, res) => {
  const data = readData();
  const doctor = data.doctors.find((entry) => entry.id === req.params.id);
  if (!doctor) return res.status(404).json({ error: 'Doctor not found.' });

  doctor.verificationStatus = 'approved';
  doctor.verified = true;
  doctor.affiliation = req.body.affiliation || doctor.affiliation;
  doctor.approvedAt = nowIso();
  doctor.reviewedBy = req.user.sub;
  doctor.qrToken = issueToken(doctor.id, { type: 'doctor-qr', doctorId: doctor.id, verified: true }, QR_SECRET, '5m');
  writeData(data);
  logAccess({ actor: req.user.sub, action: 'approve-doctor', resource: `doctors/${doctor.id}`, reason: 'admin-verification' });
  res.json({ doctor });
});

app.get('/api/doctors/qr', requireAuth, qrLimiter, async (req, res) => {
  const data = readData();
  const doctorId = req.query.doctorId || data.doctors.find((doc) => doc.verified)?.id;
  const doctor = data.doctors.find((entry) => entry.id === doctorId) || data.doctors[0];

  if (!doctor) return res.status(404).json({ error: 'Doctor not found.' });

  const token = issueToken(doctor.id, { type: 'doctor-qr', doctorId: doctor.id, verified: true }, QR_SECRET, '5m');
  const payload = {
    doctorName: doctor.name,
    specialty: doctor.specialty,
    affiliation: doctor.affiliation,
    verified: true,
    token
  };

  const qrCode = await QRCode.toDataURL(JSON.stringify(payload));
  res.json({ qrCode, doctorName: doctor.name, specialty: doctor.specialty, affiliation: doctor.affiliation, verified: true });
});

app.get('/api/doctor/verify/:token', qrLimiter, (req, res) => {
  try {
    const payload = jwt.verify(req.params.token, QR_SECRET);
    if (payload.type !== 'doctor-qr' || !payload.verified) {
      return res.status(400).json({ error: 'Invalid doctor QR token.' });
    }

    const data = readData();
    const doctor = data.doctors.find((entry) => entry.id === payload.doctorId);
    if (!doctor || !doctor.verified) {
      return res.status(404).json({ error: 'Doctor not verified.' });
    }

    res.json({
      name: doctor.name,
      specialty: doctor.specialty,
      affiliation: doctor.affiliation,
      licenseNumber: doctor.licenseNumber,
      verified: true
    });
  } catch (error) {
    res.status(401).json({ error: 'QR token expired or invalid.' });
  }
});

app.post('/api/patients', requireAuth, (req, res) => {
  const data = readData();
  const patient = {
    id: makeId('PT'),
    ownerId: req.user.sub,
    name: req.body.name || 'New patient',
    dob: req.body.dob || '1990-01-01',
    gender: req.body.gender || 'unknown',
    mrn: req.body.mrn || `MRN-${Date.now()}`,
    insurance: req.body.insurance || 'Unassigned',
    activeMeds: req.body.activeMeds || [],
    allergies: req.body.allergies || [],
    diagnoses: req.body.diagnoses || [],
    immunizations: req.body.immunizations || [],
    visitHistory: req.body.visitHistory || [],
    preferredLanguage: req.body.preferredLanguage || 'English',
    status: 'active',
    consent: { patientControlled: true, emergencyBreakGlass: 'Enabled', status: 'no-access' },
    createdAt: nowIso()
  };
  data.patients.push(patient);
  writeData(data);
  logAccess({ actor: req.user.sub, action: 'create-patient-record', resource: `patients/${patient.id}`, reason: req.accessReason });
  res.status(201).json(patient);
});

app.post('/api/patients/guest', requireAuth, (req, res) => {
  const data = readData();
  const patient = buildGuestPatientRecord({
    ownerId: req.user.sub,
    name: req.body.name || 'Walk-in patient',
    dob: req.body.dob || '1990-01-01',
    gender: req.body.gender || 'unknown',
    phone: req.body.phone || '',
    insurance: req.body.insurance || 'Walk-in / no insurance'
  });

  data.patients.push(patient);
  writeData(data);
  logAccess({ actor: req.user.sub, action: 'create-guest-patient-record', resource: `patients/${patient.id}`, reason: req.accessReason });
  res.status(201).json(patient);
});

app.post('/api/patients/:id/claim', requireAuth, (req, res) => {
  const data = readData();
  const patient = data.patients.find((entry) => entry.id === req.params.id);
  if (!patient) return res.status(404).json({ error: 'Patient record not found.' });

  const claimResult = claimGuestPatientRecord(patient, req.user, { email: req.body.email || req.user.email });
  if (!claimResult) {
    return res.status(409).json({ error: 'This record is not available to claim with the current account.' });
  }

  writeData(data);
  logAccess({ actor: req.user.sub, action: 'claim-guest-patient-record', resource: `patients/${patient.id}`, reason: req.accessReason });
  res.json(patient);
});

app.get('/api/patients/:id', requireAuth, (req, res) => {
  const data = readData();
  const patient = data.patients.find((entry) => entry.id === req.params.id);
  if (!patient) return res.status(404).json({ error: 'Patient not found.' });

  if (['super_admin', 'clinic_admin'].includes(req.user.role)) {
    const adminReason = req.headers['x-admin-reason'] || req.query.reason || req.body?.reason;
    if (req.user.role === 'clinic_admin' && patient.clinicId && req.user.clinicId && patient.clinicId !== req.user.clinicId) {
      return res.status(403).json({ error: 'Clinic scope mismatch.' });
    }
    if (!adminReason) {
      return res.status(403).json({ error: 'Break-glass reason required to access patient medical content.' });
    }

    data.notifications.unshift({
      id: makeId('NOT'),
      patientId: patient.id,
      channel: 'email',
      title: 'Administrative medical access notice',
      message: `Administrative access was used to review your record for: ${adminReason}`,
      read: false,
      createdAt: nowIso()
    });
    writeData(data);
    logAccess({ actor: req.user.sub, action: 'admin-read-patient-record', resource: `patients/${patient.id}`, reason: adminReason });
    return res.json(patient);
  }

  if (req.user.role !== 'admin' && req.user.role !== 'patient' && !consentActiveFor(patient.id, req.user.role, req.user.sub, data)) {
    return res.status(403).json({ error: 'Consent required before viewing this patient record.' });
  }

  logAccess({ actor: req.user.sub, action: 'read-patient-record', resource: `patients/${patient.id}`, reason: req.accessReason });
  res.json(patient);
});

app.patch('/api/patients/:id', requireAuth, (req, res) => {
  const data = readData();
  const patient = data.patients.find((entry) => entry.id === req.params.id);
  if (!patient) return res.status(404).json({ error: 'Patient not found.' });

  if (['super_admin', 'clinic_admin'].includes(req.user.role)) {
    const adminReason = req.headers['x-admin-reason'] || req.body?.reason || req.query.reason;
    if (req.user.role === 'clinic_admin' && patient.clinicId && req.user.clinicId && patient.clinicId !== req.user.clinicId) {
      return res.status(403).json({ error: 'Clinic scope mismatch.' });
    }
    if (!adminReason) {
      return res.status(403).json({ error: 'Break-glass reason required to update patient medical content.' });
    }
    data.notifications.unshift({
      id: makeId('NOT'),
      patientId: patient.id,
      channel: 'email',
      title: 'Administrative record update notice',
      message: `An administrative update was made to your record for: ${adminReason}`,
      read: false,
      createdAt: nowIso()
    });
    writeData(data);
    logAccess({ actor: req.user.sub, action: 'admin-update-patient-record', resource: `patients/${patient.id}`, reason: adminReason });
  }

  Object.assign(patient, req.body);
  writeData(data);
  logAccess({ actor: req.user.sub, action: 'update-patient-record', resource: `patients/${patient.id}`, reason: req.accessReason });
  res.json(patient);
});

app.post('/api/consent/request', requireAuth, (req, res) => {
  const data = readData();
  const request = {
    id: makeId('CONS'),
    patientId: req.body.patientId,
    actorId: req.user.sub,
    actorRole: req.user.role,
    provider: req.body.provider || 'Clinician',
    purpose: req.body.purpose || 'Treatment coordination',
    status: 'pending',
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  };

  data.consents.push(request);
  writeData(data);
  logAccess({ actor: req.user.sub, action: 'consent-requested', resource: `consent/${request.id}`, reason: req.accessReason });
  res.status(201).json(request);
});

app.patch('/api/consent/:id', requireAuth, (req, res) => {
  const data = readData();
  const consentRequest = data.consents.find((entry) => entry.id === req.params.id);
  if (!consentRequest) return res.status(404).json({ error: 'Consent request not found.' });

  consentRequest.status = req.body.status || consentRequest.status;
  consentRequest.updatedAt = nowIso();
  writeData(data);
  logAccess({ actor: req.user.sub, action: 'consent-decision', resource: `consent/${consentRequest.id}`, reason: req.accessReason });
  res.json(consentRequest);
});

app.post('/api/patients/:id/break-glass', requireAuth, requireRole('doctor', 'admin'), (req, res) => {
  const data = readData();
  const patient = data.patients.find((entry) => entry.id === req.params.id);
  if (!patient) return res.status(404).json({ error: 'Patient not found.' });

  const logEvent = {
    id: makeId('BG'),
    patientId: patient.id,
    actorId: req.user.sub,
    actorRole: req.user.role,
    reason: req.body.reason || 'Emergency access required',
    createdAt: nowIso(),
    notified: true
  };

  data.breakGlass.push(logEvent);
  data.notifications.push({
    id: makeId('NOT'),
    patientId: patient.id,
    channel: 'SMS',
    message: 'Emergency clinician access was used for your record. A summary has been logged and the patient has been notified.',
    createdAt: nowIso(),
    read: false
  });
  writeData(data);
  logAccess({ actor: req.user.sub, action: 'break-glass-access', resource: `patients/${patient.id}`, reason: 'emergency-access' });
  res.status(201).json({ success: true, event: logEvent });
});

app.post('/api/prescriptions/upload', requireAuth, prescriptionUpload.single('file'), (req, res) => {
  const data = readData();
  const patient = data.patients.find((entry) => entry.id === (req.body.patientId || 'PT-1001'));
  const doctor = data.doctors.find((entry) => entry.id === (req.body.doctorId || 'DR-1001')) || data.doctors[0];

  if (!patient) return res.status(404).json({ error: 'Patient not found.' });
  if (!req.file) {
    return res.status(400).json({ error: 'A prescription photo (file) is required.' });
  }

  // The photo is the source of truth. Any typed text is an OCR draft or a
  // clinician's note — it is stored as-is and always requires verification.
  const draftText = req.body.rawText || req.body.ocrText || '';
  const cleaned = draftText ? cleanPrescription(draftText) : null;
  const prescription = {
    id: makeId('RX'),
    patientId: patient.id,
    doctorId: doctor?.id || req.user.sub,
    original: draftText || 'Handwritten prescription captured as photo',
    ocrRawText: draftText || null,
    ocrConfidence: cleaned ? cleaned.confidence : 0,
    ocrEngine: cleaned ? 'medrec-structured-parser' : 'none',
    ocrWarnings: cleaned ? cleaned.warnings : ['No OCR draft yet — transcription pending.'],
    originalImageUrl: `/uploads/${req.file.filename}`,
    originalImageMimetype: req.file.mimetype,
    cleaned,
    verifiedText: null,
    verifiedBy: null,
    verifiedAt: null,
    reviewStatus: 'awaiting-ocr-review',
    status: 'pending-confirmation',
    safety: null,
    createdAt: nowIso(),
    immutable: false
  };

  if (cleaned) {
    prescription.safety = evaluateMedicationSafety(patient, cleaned);
  }

  data.prescriptions.push(prescription);
  writeData(data);
  logAccess({ actor: req.user.sub, action: 'upload-prescription-photo', resource: `prescriptions/${prescription.id}`, reason: req.accessReason });
  res.status(201).json(prescription);
});

// Human-verified soft copy: stores the corrected transcription alongside the
// original photo. This — not the raw OCR draft — is the official record.
app.post('/api/prescriptions/:id/correct', requireAuth, requireRole('doctor', 'pharmacist', 'admin'), (req, res) => {
  const data = readData();
  const prescription = data.prescriptions.find((entry) => entry.id === req.params.id);
  if (!prescription) return res.status(404).json({ error: 'Prescription not found.' });
  if (prescription.immutable) return res.status(409).json({ error: 'Confirmed prescriptions are immutable.' });

  const verifiedText = String(req.body.verifiedText || '').trim();
  if (!verifiedText) return res.status(400).json({ error: 'verifiedText is required.' });

  const patient = data.patients.find((entry) => entry.id === prescription.patientId);
  const corrected = cleanPrescription(verifiedText);

  prescription.verifiedText = verifiedText;
  prescription.cleaned = corrected;
  prescription.verifiedBy = req.user.sub;
  prescription.verifiedAt = nowIso();
  prescription.reviewStatus = 'human-verified';
  prescription.safety = evaluateMedicationSafety(patient, corrected);

  writeData(data);
  logAccess({ actor: req.user.sub, action: 'correct-prescription-transcription', resource: `prescriptions/${prescription.id}`, reason: req.accessReason });
  res.json(prescription);
});

app.get('/api/prescriptions/:id', requireAuth, (req, res) => {
  const data = readData();
  const prescription = data.prescriptions.find((entry) => entry.id === req.params.id);
  if (!prescription) return res.status(404).json({ error: 'Prescription not found.' });
  res.json(prescription);
});

app.patch('/api/prescriptions/:id/confirm', requireAuth, requireRole('pharmacist', 'doctor', 'admin'), (req, res) => {
  const data = readData();
  const prescription = data.prescriptions.find((entry) => entry.id === req.params.id);
  if (!prescription) return res.status(404).json({ error: 'Prescription not found.' });

  prescription.status = req.body.status || 'confirmed';
  prescription.reviewedBy = req.user.sub;
  prescription.reviewedAt = nowIso();
  prescription.immutable = req.body.status === 'confirmed';
  writeData(data);
  logAccess({ actor: req.user.sub, action: 'confirm-prescription', resource: `prescriptions/${prescription.id}`, reason: req.accessReason });
  res.json(prescription);
});

app.post('/api/prescriptions/:id/safety-check', requireAuth, (req, res) => {
  const data = readData();
  const prescription = data.prescriptions.find((entry) => entry.id === req.params.id);
  if (!prescription) return res.status(404).json({ error: 'Prescription not found.' });
  const patient = data.patients.find((entry) => entry.id === prescription.patientId);

  const result = evaluateMedicationSafety(patient, prescription.cleaned || prescription);
  res.json(result);
});

app.get('/api/audit', requireAuth, requireRole('admin', 'doctor', 'pharmacist'), (req, res) => {
  const data = readData();
  const { actor, resource } = req.query;
  const filtered = data.audit.filter((entry) => {
    const matchesActor = !actor || entry.actor === actor;
    const matchesResource = !resource || entry.resource === resource;
    return matchesActor && matchesResource;
  });
  res.json(filtered);
});

app.get('/api/fhir/:patientId', requireAuth, (req, res) => {
  const data = readData();
  const patient = data.patients.find((entry) => entry.id === req.params.patientId);
  if (!patient) return res.status(404).json({ error: 'Patient not found.' });

  if (['super_admin', 'clinic_admin'].includes(req.user.role)) {
    const adminReason = req.headers['x-admin-reason'] || req.query.reason || req.body?.reason;
    if (req.user.role === 'clinic_admin' && patient.clinicId && req.user.clinicId && patient.clinicId !== req.user.clinicId) {
      return res.status(403).json({ error: 'Clinic scope mismatch.' });
    }
    if (!adminReason) {
      return res.status(403).json({ error: 'Break-glass reason required to export patient medical content.' });
    }
    data.notifications.unshift({
      id: makeId('NOT'),
      patientId: patient.id,
      channel: 'email',
      title: 'FHIR export notice',
      message: `An administrative export was created for your record for: ${adminReason}`,
      read: false,
      createdAt: nowIso()
    });
    writeData(data);
    logAccess({ actor: req.user.sub, action: 'admin-fhir-export', resource: `patients/${patient.id}`, reason: adminReason });
  }

  res.json(buildFhirBundle(patient));
});

app.post('/api/offline/sync', requireAuth, (req, res) => {
  const data = readData();
  const payload = req.body || {};
  const queueItem = queueOfflineSyncEntry(data, payload);
  writeData(data);
  res.status(202).json(queueItem);
});

app.get('/api/offline/sync', requireAuth, (req, res) => {
  const data = readData();
  res.json(data.syncQueue || []);
});

app.get('/api/dashboard', requireAuth, (req, res) => {
  const data = readData();
  res.json({
    patient: data.patients[0],
    doctor: data.doctors[0],
    prescriptions: data.prescriptions.slice(-5).reverse(),
    notifications: data.notifications,
    audit: data.audit.slice(0, 8),
    consentRequests: data.consents.slice(0, 10),
    referrals: data.referrals,
    labs: data.labs,
    payments: data.payments,
    analytics: data.analytics,
    queue: data.syncQueue
  });
});

app.use((err, req, res, next) => {
  console.error('UnhandledError', { path: req.path, error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error.' });
});

module.exports = {
  app,
  makeId,
  nowIso,
  sanitizeUser,
  issueToken,
  verifyAccessToken,
  verifyRefreshToken,
  hashPassword,
  comparePassword,
  encryptSensitive,
  decryptSensitive,
  logAccess,
  requireAuth,
  requireRole,
  consentActiveFor,
  cleanPrescription,
  evaluateMedicationSafety,
  buildFhirBundle,
  buildGuestPatientRecord,
  claimGuestPatientRecord,
  queueOfflineSyncEntry,
  readData,
  writeData,
  defaultData: require('./store').defaultData
};

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`MedRec backend running on http://localhost:${PORT}`);
  });
}
