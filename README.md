# FlowPilot Intelligence (MVP)

Purchase/expense request approvals with organizations, roles, a frozen approval chain, and an append-only audit log.
Stack: React (Vite) + Node/Express + PostgreSQL. One Railway service serves both the API and the built frontend.

## Roles
| Role | Can do |
|---|---|
| employee | Create, submit and track own requests |
| approver | Everything an employee can, plus decide requests routed to approvers |
| admin | Manage users (add, change role, reset password, delete approver/employee/auditor accounts) and the approval threshold, decide any step, view dashboard and audit log |
| auditor | Read-only: all submitted requests, dashboard, audit log |

Rules enforced in the backend: nobody can decide their own request; requests at or above the organization's
high-value threshold need a second (admin) approval; the chain is frozen when a request is submitted;
two people cannot complete the same step at once (row lock); audit rows cannot be updated or deleted.

## Run locally
```bash
npm run setup                 # installs server + client dependencies
docker compose up -d          # PostgreSQL on :5432
cp .env.example .env          # set JWT_SECRET
npm run dev:server            # API on :3000 (creates tables automatically)
npm run dev:client            # UI on :5173 (proxies /api to :3000)
```
Open http://localhost:5173 and choose "Create one" to register your organization. You become its admin.
Add an approver and an employee under Team, then sign in as each to try the flow.

## Deploy: GitHub + Railway
1. Push this folder to a GitHub repository.
2. Railway: New Project > Deploy from GitHub repo > select it.
3. In the project, add a PostgreSQL database (New > Database > PostgreSQL).
4. Open your web service > Variables and add:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (reference variable; use your database service's name)
   - `JWT_SECRET` = a long random string (for example the output of `openssl rand -hex 32`)
   - `NODE_ENV` = `production`
5. Settings > Networking > Generate Domain. Open it and register your organization.

Railway builds with `npm run build` and starts with `npm start`. Tables are created on first boot.
Future API keys (OpenAI, OCR, email) go in the same Variables tab and are read from `process.env`.

## Not in this MVP yet
Document upload and private storage, email/Telegram notifications, background jobs, OCR/AI, editable draft requests.
