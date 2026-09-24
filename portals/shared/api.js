// Shared MedRec API client used by every role portal.
// Each portal is locked to a single role, but they all talk to the same backend.

export const API_BASE_URL = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '') ||
  (typeof window !== 'undefined' && ['5173', '5174', '5175', '4173', '5181', '5182', '5183', '5184'].includes(window.location.port)
    ? 'http://localhost:4000'
    : '');

export async function apiRequest(path, options = {}) {
  const url = path.startsWith('http') ? path : `${API_BASE_URL}${path}`;

  try {
    const response = await fetch(url, options);
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await response.json() : await response.text();

    if (!response.ok) {
      const message = typeof payload === 'object' && payload && 'error' in payload
        ? String(payload.error)
        : typeof payload === 'string' && payload
          ? payload
          : 'Request failed';
      const error = new Error(message);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }

    return payload;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error('Request failed');
  }
}

export function authHeaders(accessToken) {
  return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
}

export async function login(email, password) {
  return apiRequest('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
}

export async function register(payload) {
  return apiRequest('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

export async function fetchMe(accessToken) {
  return apiRequest('/api/auth/me', { headers: authHeaders(accessToken) });
}

// Exchange a Google ID token for a MedRec session. Self-service Google sign-in is
// limited to patients by the backend; privileged roles must use their approved
// verification flow instead.
export async function googleLogin({ idToken, role }) {
  return apiRequest('/api/auth/google', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken, role })
  });
}

export async function fetchAuthProviders() {
  return apiRequest('/api/auth/providers');
}

export async function refreshAccessToken(refreshToken) {
  return apiRequest('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken })
  });
}

export async function fetchPatient(accessToken, patientId) {
  return apiRequest(`/api/patients/${encodeURIComponent(patientId)}`, { headers: authHeaders(accessToken) });
}

export async function fetchDashboard(accessToken) {
  return apiRequest('/api/dashboard', { headers: authHeaders(accessToken) });
}

export async function adminLogin({ email, password, mfaCode }) {
  return apiRequest('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, mfaCode })
  });
}

// Doctor verification application (public).
export async function submitDoctorApplication(formData) {
  return apiRequest('/api/doctors/apply', {
    method: 'POST',
    body: formData
  });
}

export async function fetchApplicationStatus(email) {
  return apiRequest(`/api/doctors/apply/status?email=${encodeURIComponent(email)}`);
}

// Staff/admin review queue.
export async function listDoctorApplications(accessToken, status) {
  const query = status ? `?status=${encodeURIComponent(status)}` : '';
  return apiRequest(`/api/admin/doctor-applications${query}`, { headers: authHeaders(accessToken) });
}

export async function getDoctorApplication(accessToken, id) {
  return apiRequest(`/api/admin/doctor-applications/${id}`, { headers: authHeaders(accessToken) });
}

export async function approveDoctorApplication(accessToken, id, extra = {}) {
  return apiRequest(`/api/admin/doctor-applications/${id}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(accessToken) },
    body: JSON.stringify(extra)
  });
}

export async function rejectDoctorApplication(accessToken, id, reason) {
  return apiRequest(`/api/admin/doctor-applications/${id}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(accessToken) },
    body: JSON.stringify({ reason })
  });
}

// Doctor QR.
export async function getDoctorQr(accessToken, doctorId) {
  const query = doctorId ? `?doctorId=${encodeURIComponent(doctorId)}` : '';
  return apiRequest(`/api/doctors/qr${query}`, { headers: authHeaders(accessToken) });
}

export async function verifyDoctorToken(token) {
  return apiRequest(`/api/doctor/verify/${encodeURIComponent(token)}`);
}

// Consent + prescriptions (patient/doctor/pharmacist portals).
export async function requestConsent(accessToken, payload) {
  return apiRequest('/api/consent/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(accessToken) },
    body: JSON.stringify(payload)
  });
}

export async function decideConsent(accessToken, id, status) {
  return apiRequest(`/api/consent/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders(accessToken) },
    body: JSON.stringify({ status })
  });
}

export async function uploadPrescription(accessToken, payload) {
  return apiRequest('/api/prescriptions/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(accessToken) },
    body: JSON.stringify(payload)
  });
}

// Multipart prescription photo upload. The photo is the source of truth;
// optional typed text becomes the OCR draft.
export async function uploadPrescriptionPhoto(accessToken, { file, patientId, doctorId, ocrText }) {
  const formData = new FormData();
  formData.append('file', file);
  if (patientId) formData.append('patientId', patientId);
  if (doctorId) formData.append('doctorId', doctorId);
  if (ocrText) formData.append('rawText', ocrText);
  return apiRequest('/api/prescriptions/upload', {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: formData
  });
}

// Store the human-corrected transcription. This becomes the official soft copy.
export async function correctPrescription(accessToken, id, verifiedText) {
  return apiRequest(`/api/prescriptions/${id}/correct`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(accessToken) },
    body: JSON.stringify({ verifiedText })
  });
}

// Uploads are only served through the authenticated /api/files route. <img>
// tags cannot set headers, so we first exchange the session token for a
// short-lived, file-scoped token and put THAT in the query string — the full
// session token never appears in a URL.
export async function fileUrl(accessToken, imagePath) {
  if (!imagePath) return null;
  const filename = imagePath.split('/uploads/')[1] || imagePath.split('/').pop();
  if (!filename) return null;
  const { fileToken } = await apiRequest('/api/files/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(accessToken) },
    body: JSON.stringify({ filename })
  });
  const base = API_BASE_URL || '';
  return `${base}/api/files/${encodeURIComponent(filename)}?file_token=${encodeURIComponent(fileToken)}`;
}

export async function confirmPrescription(accessToken, id, status) {
  return apiRequest(`/api/prescriptions/${id}/confirm`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders(accessToken) },
    body: JSON.stringify({ status })
  });
}

export async function exportFhir(accessToken, patientId) {
  return apiRequest(`/api/fhir/${patientId}`, { headers: authHeaders(accessToken) });
}

export async function queueOfflineSync(accessToken, payload) {
  return apiRequest('/api/offline/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(accessToken) },
    body: JSON.stringify(payload)
  });
}

export async function createGuestPatient(accessToken, payload) {
  return apiRequest('/api/patients/guest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(accessToken) },
    body: JSON.stringify(payload)
  });
}