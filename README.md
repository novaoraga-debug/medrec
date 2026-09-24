# MedRec — Unified Frontend with Role-Separated Portals

MedRec ships a **single unified frontend** (`frontend/`, port 5173): the sign-in screen
offers Patient, Doctor and Pharmacist roles, while the Staff/Admin card stays hidden
behind a staff unlock code. Doctor and pharmacist accounts activate only after a
one-time application is **approved by staff**. The four legacy role-locked portals under
`portals/` remain available as separate Vite apps (each accepts only its own role) but
are no longer the primary interface. Everything talks to the same Express backend.

## Architecture

```
backend/                 Express API + JSON file store (JWT auth, roles, audit)
frontend/                Unified React app (5173) — PRIMARY UI
  src/App.tsx            Role cards, Sign in / Apply once / Check status tabs,
                         role-tailored dashboards, staff console + admin approval
  src/styles.css         Design system, animations, responsive + print styles
portals/                 Legacy role-locked portals (kept as alternatives)
  shared/                Code shared by every portal
    api.js               API client for all endpoints
    auth.js              Per-portal session persistence + role lock helper
    ui.jsx               Shared UI (header, empty state, skeletons, role notice)
    styles.css           Shared design system styles
  patient/    (5181)     Patient portal    — role: patient
  doctor/     (5182)     Doctor portal     — role: doctor
  pharmacist/ (5183)     Pharmacist portal — role: pharmacist
  staff/      (5184)     Staff/admin portal — roles: super_admin, clinic_admin, admin, staff
```

The unified frontend and each portal are their own Vite project with its own `index.html`,
config and dependencies, so they can be built and deployed separately.

## Doctor & pharmacist verification workflow

This is the end-to-end flow requested (both privileged roles):

1. **Applicant applies** — from the unified app's *Apply once* tab (or the doctor portal's
   *Apply for verification*), name, email, password, specialty and licence number go to
   `POST /api/doctors/apply` with `role: doctor|pharmacist` (portals also upload documents).
   **No login account is created at this stage.**
2. **Status is visible** — the applicant sees a *pending* status card and cannot sign in
   yet (login returns `401`). `GET /api/doctors/apply/status?email=...` powers *Check status*.
3. **Staff reviews** — in the unified app's staff console (or the staff portal), the
   application queue lists every pending request with its uploaded documents.
4. **Staff approves** — `POST /api/admin/doctor-applications/:id/approve` **creates the
   login account**; for doctors it also creates the doctor record and **generates the
   verification QR token** (pharmacists get a login only). Rejecting stores a reason
   instead and creates no account.
5. **Applicant signs in** — the approved doctor signs in, sees their QR, and can
   scan/verify; the approved pharmacist gets the dispensing queue.

## Backend endpoints added/changed

| Method | Path | Auth | Purpose |
| ------ | ---- | ---- | ------- |
| POST | `/api/doctors/apply` | public (multipart or JSON) | Submit a doctor/pharmacist verification application |
| GET | `/api/doctors/apply/status` | public | Check application status by email |
| GET | `/api/admin/doctor-applications` | admin | List applications (clinic-scoped) |
| GET | `/api/admin/doctor-applications/:id` | admin | Application detail + documents |
| POST | `/api/admin/doctor-applications/:id/approve` | admin | Create account + doctor + QR |
| POST | `/api/admin/doctor-applications/:id/reject` | admin | Reject with reason |
| GET | `/api/doctors/pending` | admin | Pending doctor records |

Admin endpoints now use `requireAdminAuth`, so `super_admin` and `clinic_admin` (the real
admin roles) work — previously they were gated behind `requireRole('admin')`.

## Google Sign-In

The unified frontend supports **Continue with Google** for patients (self-service sign-in /
sign-up). Doctor and pharmacist Google identities are intentionally excluded there — the
identity pre-fills the one-time *Apply once* form instead, because those logins are only
created after staff approval. Staff keep email + MFA. The role-locked portals follow the
same rule: the pharmacist portal submits the verification application instead of
self-registering or self-serving Google.

To enable it:

1. Create an OAuth 2.0 **Client ID** (type *Web application*) in Google Cloud Console.
2. Add each origin as an *Authorized JavaScript origin*
   (`http://localhost:5173` for the unified app, `http://localhost:5181`–`5184` for portals).
3. Set the ID where the app runs:
   - backend: `GOOGLE_CLIENT_ID` in `backend/.env` (copy from `backend/.env.example`)
   - unified frontend: `VITE_GOOGLE_CLIENT_ID` in `frontend/.env`
     (copy `frontend/.env.example`)
   - portals: `VITE_GOOGLE_CLIENT_ID` (copy `portals/.env.example` to `.env` in each portal,
     or set it in your shell)

While the client ID is unset, the portals show a clearly labelled disabled button instead
of a broken widget. The backend also exposes `GET /api/auth/providers` so the UI can detect
whether Google is configured.

Security rules enforced by `/api/auth/google`:

- Only the `patient` role can self-serve with Google — doctors and pharmacists get a `403`
  pointing at the verification/approval flow, and any other role is refused.
- A Google login can never escalate or change an existing account's role; an account that
  already holds a privileged role cannot use Google at all ("use email and password").
- New Google users are created with role `patient` only, with a random unusable password.
- `POST /api/auth/register` enforces the same policy: patient self-registration succeeds,
  while `doctor`, `pharmacist`, and admin roles return `403`. Verified clinical accounts are
  minted only by staff approving `/api/doctors/apply`.

The unified frontend additionally routes **pharmacist** Google identities through the
*Apply once* flow (staff approval) instead of issuing a session — only patients get an
immediate Google session there. Doctors were already excluded.

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

Logins return a refresh token plus `expiresInSeconds`; the unified app and portals store both and
automatically refresh the access token one minute before it expires, so 15-minute sessions
no longer drop mid-use.

Refresh tokens are single-use: `POST /api/auth/refresh` rotates the token, retires the value
that was presented, and returns the replacement, which the clients persist. Expired entries are
pruned and each account keeps at most `MEDREC_MAX_REFRESH_TOKENS` live tokens (default 10).
Signing out calls `POST /api/auth/logout`, which revokes only that session, while
**Sign out everywhere** still calls `POST /api/auth/logout-all`.

Cross-origin access is an allowlist: list the deployed portal origins in `CORS_ORIGINS`
(comma separated). Outside production any localhost port is accepted so the four role portals
keep working on their own dev ports.

## Auth hardening

- `login`, `register`, and `google` routes are rate limited (`authLimiter`).
- All routes sit behind helmet (CSP with frame-ancestors none, X-Frame-Options DENY, COOP,
  strict-origin-when-cross-origin referrers), the CORS allowlist, and request logging with
  token redaction, plus layered rate limits: 600 req/15 min globally, 120 req/min on `/api`.
- Refresh tokens rotate on use and can be revoked one session at a time, so a token stolen
  before a refresh can no longer be replayed.
- Google role rules are covered by `backend/test/google-auth.test.js`, the self-registration
  role policy by `backend/test/registration-role-guard.test.js`, and rotation plus
  single-session revocation by `backend/test/refresh-rotation.test.js`.

## Running

```bash
# 1. install everything (backend + unified frontend + portals)
npm run install:all

# 2. backend (http://localhost:4000)
npm run dev:backend

# 3. unified frontend (http://localhost:5173) — primary UI
npm run dev:frontend

# optional: legacy role-locked portals (each in its own terminal)
npm run dev:patient
npm run dev:doctor
npm run dev:pharmacist
npm run dev:staff

# or run every portal together
npm run dev:portals
# or backend + frontend + portals
npm run dev:all
```

Set `VITE_API_URL` in `frontend/.env` (or a portal) to point at a non-default backend.
The staff-card unlock code and Google button are configured in `frontend/.env` — see
`frontend/.env.example` (`VITE_STAFF_UNLOCK_CODE`, `VITE_GOOGLE_CLIENT_ID`).

## Demo credentials

| Portal | Email | Password |
| ------ | ----- | -------- |
| Patient | `qa.user.2026@example.com` | `Password123!` |
| Doctor | `doctor.demo@medrec.local` | `Password123!` |
| Pharmacist | `pharmacist.demo@medrec.local` | `Password123!` |
| Staff (super admin, MFA) | `super.admin@medrec.local` | `SuperAdmin!2026` |
| Staff (clinic admin, MFA) | `clinic.admin@medrec.local` | `ClinicAdmin!2026` |

Staff sign-in uses TOTP MFA (`JBSWY3DPEHPK3PXP` is the seeded test secret).

In the unified app, entering the staff unlock code (`SuperAdmin!2026` by default,
overridable via `VITE_STAFF_UNLOCK_CODE`) reveals the **Staff** card; *Open staff
console* then takes you to the MFA login above.

## Tests

```bash
cd backend && node --test
```

20 tests covering the doctor application flow (apply → pending → staff approve →
account + QR), the reject and duplicate-application paths, and the pharmacist
application flow (approval creates a login only — no doctor record or QR).