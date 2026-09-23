# MedRec — Role-Separated Portals

MedRec is now split into **four independent front-end portals**, each locked to a single
role, plus the shared Express backend. A user who signs into the wrong portal is rejected
with a role-lock notice — a portal only accepts its own role.

## Architecture

```
backend/                 Express API + JSON file store (JWT auth, roles, audit)
portals/
  shared/                Code shared by every portal
    api.js               API client for all endpoints
    auth.js              Per-portal session persistence + role lock helper
    ui.jsx               Shared UI (header, empty state, skeletons, role notice)
    styles.css           Shared design system styles
  patient/    (5181)     Patient portal    — role: patient
  doctor/     (5182)     Doctor portal     — role: doctor
  pharmacist/ (5183)     Pharmacist portal — role: pharmacist
  staff/      (5184)     Staff/admin portal — roles: super_admin, clinic_admin, admin, staff
frontend/                Legacy single-app UI (kept for migration)
```

Each portal is its own Vite project with its own `index.html`, config and dependencies, so
they can be built and deployed separately.

## Doctor verification workflow

This is the end-to-end flow requested:

1. **Doctor applies** — on the doctor portal, *Apply for verification* submits name, email,
   password, specialty, licence number and document uploads to `POST /api/doctors/apply`.
   **No login account is created at this stage.**
2. **Status is visible** — the doctor sees a *pending* banner and cannot sign in yet.
   `GET /api/doctors/apply/status?email=...` powers a *Refresh status* button.
3. **Staff reviews** — on the staff portal, *Doctor applications* lists every pending
   request. Staff open the application to view the uploaded documents.
4. **Staff approves** — `POST /api/admin/doctor-applications/:id/approve` **creates the
   doctor login account**, creates the doctor record, and **generates the verification QR
   token**. Rejecting stores a reason instead and creates no account.
5. **Doctor signs in** — the approved doctor signs in on the doctor portal (role-locked),
   sees their QR, and can scan/verify. Data is stored via the backend.

## Backend endpoints added/changed

| Method | Path | Auth | Purpose |
| ------ | ---- | ---- | ------- |
| POST | `/api/doctors/apply` | public (multipart) | Submit a verification application |
| GET | `/api/doctors/apply/status` | public | Check application status by email |
| GET | `/api/admin/doctor-applications` | admin | List applications (clinic-scoped) |
| GET | `/api/admin/doctor-applications/:id` | admin | Application detail + documents |
| POST | `/api/admin/doctor-applications/:id/approve` | admin | Create account + doctor + QR |
| POST | `/api/admin/doctor-applications/:id/reject` | admin | Reject with reason |
| GET | `/api/doctors/pending` | admin | Pending doctor records |

Admin endpoints now use `requireAdminAuth`, so `super_admin` and `clinic_admin` (the real
admin roles) work — previously they were gated behind `requireRole('admin')`.

## Google Sign-In

Patient and pharmacist portals support **Continue with Google** (self-service sign-in /
sign-up). Doctor accounts are intentionally excluded — a Google identity there pre-fills
the verification application instead, because doctor logins are only created after staff
approval. Staff keep email + MFA.

To enable it:

1. Create an OAuth 2.0 **Client ID** (type *Web application*) in Google Cloud Console.
2. Add each portal origin as an *Authorized JavaScript origin*
   (`http://localhost:5181`, `http://localhost:5182`, `http://localhost:5183`).
3. Set the ID in both places:
   - backend: `GOOGLE_CLIENT_ID` in `backend/.env` (copy from `backend/.env.example`)
   - portals: `VITE_GOOGLE_CLIENT_ID` (copy `portals/.env.example` to `.env` in each portal,
     or set it in your shell)

While the client ID is unset, the portals show a clearly labelled disabled button instead
of a broken widget. The backend also exposes `GET /api/auth/providers` so the UI can detect
whether Google is configured.

Security rules enforced by `/api/auth/google`:

- Only `patient` and `pharmacist` roles can self-serve with Google — requesting any other
  role returns `403` (doctors are pointed to the application flow).
- A Google login can never escalate or change an existing account's role.
- New Google users are created with role `patient` / `pharmacist` only, with a random
  unusable password.

## UI

The four portals share a single design system in `portals/shared/`: dark clinical surfaces with a
calm teal accent (#2dd4bf), translucent glass panels, quiet micro-motion, and a hand-crafted animated
SVG illustration (heartbeat/ECG for patients, stethoscope + clipboard for doctors, medicine bottle +
capsules for pharmacists, shield + check for staff). All motion respects `prefers-reduced-motion`.
Buttons, inputs, and cards share consistent spacing, focus rings, and hover lift. The policy intent is
clean, trustworthy, and easy to use — not decorated for its own sake.

## Prescription photo → OCR → verified soft copy

Doctors capture or upload a photo of a handwritten prescription instead of typing it:

1. **Capture** — the doctor portal opens the device camera (or picks a file). Client-side
   quality checks warn about blur, darkness, glare, or low resolution before upload.
2. **OCR draft (assistive)** — *Scan handwriting* runs Tesseract.js in the browser over a
   preprocessed (grayscale/contrast) image and produces an **editable draft**. If the OCR
   engine can't load (e.g. offline), the photo can still be uploaded and transcribed manually.
3. **Upload** — `POST /api/prescriptions/upload` (multipart, image or PDF ≤ 8 MB) stores the
   photo as the source of truth plus the draft text. The backend structures the draft with a
   formulary fuzzy-match parser (Levenshtein + Rx abbreviations: BD/OD/TDS/PRN…) and stores
   per-prescription `ocrConfidence`, `ocrWarnings`, and `reviewStatus`.
4. **Pharmacist verification** — the pharmacist portal shows the original photo next to the
   transcription. The pharmacist types the verified text (`POST /api/prescriptions/:id/correct`)
   — this human-verified transcription **is the official soft copy** — then confirms or flags.
   Confirmed prescriptions become immutable.
5. **Patient view** — patients see the photo thumbnail and whether the transcription has been
   verified by the pharmacy team.

Safety rules: OCR output is never auto-confirmed; the photo always stays attached; low
confidence and unknown medications raise warnings; every view/upload/correction/confirm is
audit-logged.

Uploaded files are **not** publicly served. Images are fetched through the authenticated
`GET /api/files/:filename` route (Bearer header, or `?file_token=` for `<img>` tags), with
path-traversal protection and audit logging. Session tokens are **rejected** in query
strings: `<img>`/`<a>` loads first exchange the session token for a short-lived,
single-file token via `POST /api/files/token` (TTL from `FILE_TOKEN_TTL`, default `5m`),
and request logs redact any `file_token`/`access_token` query parameter.

### Backend endpoints added

| Method | Path | Auth | Purpose |
| ------ | ---- | ---- | ------- |
| POST | `/api/prescriptions/upload` | any (multipart) | Prescription photo + OCR draft |
| POST | `/api/prescriptions/:id/correct` | doctor/pharmacist/admin | Human-verified soft copy |
| POST | `/api/files/token` | any (token) | Mint short-lived, single-file token |
| GET | `/api/files/:filename` | any (Bearer or `file_token`) | Authenticated upload access |
| GET | `/api/prescriptions/ocr-status` | any | OCR pipeline capabilities |

## Token refresh

Logins return a refresh token plus `expiresInSeconds`; the portals store both and
automatically refresh the access token one minute before it expires, so 15-minute sessions
no longer drop mid-use.

## Auth hardening

- `login`, `register`, and `google` routes are rate limited (`authLimiter`).
- All routes sit behind helmet (CSP), CORS, and request logging with token redaction,
  plus layered rate limits: 600 req/15 min globally, 120 req/min on `/api`.
- Google role rules are covered by `backend/test/google-auth.test.js`.

## Running

```bash
# 1. install everything
npm run install:all

# 2. backend
npm run dev:backend

# 3. each portal (in separate terminals) or all at once
npm run dev:patient
npm run dev:doctor
npm run dev:pharmacist
npm run dev:staff

# or run every portal together
npm run dev:portals
# or portals + backend
npm run dev:all
```

Set `VITE_API_URL` in a portal to point at a non-default backend.

## Demo credentials

| Portal | Email | Password |
| ------ | ----- | -------- |
| Patient | `qa.user.2026@example.com` | `Password123!` |
| Doctor | `doctor.demo@medrec.local` | `Password123!` |
| Pharmacist | `pharmacist.demo@medrec.local` | `Password123!` |
| Staff (super admin, MFA) | `super.admin@medrec.local` | `SuperAdmin!2026` |
| Staff (clinic admin, MFA) | `clinic.admin@medrec.local` | `ClinicAdmin!2026` |

Staff sign-in uses TOTP MFA (`JBSWY3DPEHPK3PXP` is the seeded test secret).

## Tests

```bash
cd backend && node --test
```

Covers the new doctor application flow: apply → pending → staff approve → account + QR,
plus the reject and duplicate-application paths.