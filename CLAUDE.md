# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Commands

### Development
- `npm run dev` - Start Vite dev server (parent app `/`, admin console `/admin`)
- `npm run server:dev` - Start the backend (http://localhost:4000)
- `npm run dev:all` - Start frontend and backend concurrently (recommended)

### Database
- `npm run db:up` / `npm run db:down` - Start/stop the PostgreSQL container (port **5433**)
- `npm run db:migrate` - Apply Prisma migrations
- `npm run db:seed` - Seed demo data (idempotent). Parent `13800138000` / `balloon123`;
  admin `admin` / `balloon-admin-2026`; operator `operator` / `balloon-operator-2026`
- `npm run db:clean` - Remove smoke-test accounts/devices (`APPLY=1 npm run db:clean` to delete)

### Build & Quality
- `npm run build` - Frontend type check + Vite production build
- `npm run lint` - ESLint (frontend)
- `npm run server:typecheck` - Backend type check
- `npm --prefix server run lint` - ESLint (backend)

### Testing
- `npm run server:smoke` - End-to-end backend smoke test (158 assertions). Needs a running backend
  and a seeded database. Covers auth, authorization, multi-user isolation, device binding, the full
  device-command queue round trip, and the admin console (token isolation, role split, audit).
- `cd server && npm run agent:example` - Simulated child device that polls for and executes commands.
- `npm run e2e` - Browser end-to-end test for both SPAs (55 checks) via CDP-driven headless Chrome;
  requires `npm run dev:all` running.
- No frontend unit-test framework is configured.

## Architecture

Parental control / child device monitoring app with a **two-package, three-SPA layout**:

1. **Parent app** (repo root, Vite dev server on :5173, entry `index.html`) — React 19 +
   TypeScript, React Router, Tailwind v4 + shadcn/ui, WeChat-style mobile UI.
2. **Admin console** (`/admin`, entry `admin/index.html`, code in `src/admin/`) — desktop-oriented
   operator console: dashboard, account/device/command management, question bank, SMS audit,
   operation logs. Built as a **second Vite entry** so its code never ships to parents.
3. **Backend** (`server/`, Express on :4000) — a separate npm package:
   **Express 5 + TypeScript + Prisma + PostgreSQL**, feature slices
   (`dto / routes / controller / service / repository`).

See [`server/README.md`](server/README.md) for the backend's design notes, full API reference,
and the device-agent protocol.

### Key Data Flow

- All HTTP calls go through [`src/services/api.ts`](src/services/api.ts). Pages never call `fetch`
  directly. The base URL is the relative `/api` (Vite proxy in dev, Nginx in prod).
- Errors: the backend returns `{ title, status, message, detail, errors, request_id }` where
  `message` is a display-ready Chinese sentence. `ApiError.userMessage` carries it; pages surface
  it via `toUserMessage(error)`.
- 401 is handled centrally in `api.ts`: it clears the stored token and notifies
  [`AuthContext`](src/contexts/AuthContext.tsx), which drops `user` and lets `ProtectedRoute`
  redirect to `/login`.
- State management is React hooks plus the single `AuthContext`. No global state library.
- Toast notifications use `sonner` with Chinese messages.

### Backend Design Rules (important)

These encode fixes for bugs the original mock server had — do not reintroduce them:

- **Every endpoint is scoped to the logged-in parent.** Device-scoped handlers must resolve the
  device through [`server/src/shared/deviceScope.ts`](server/src/shared/deviceScope.ts), which
  enforces ownership (`403` on mismatch). Never introduce global device state — the old mock kept
  a single global `device` object, so users could read and mutate each other's data.
- **Remote capabilities go through the command queue.** Lock, temp-unlock, photo, screenshot,
  and recording cannot be performed by the server. Enqueue a `DeviceCommand`, let the device
  agent claim and report it, and reconcile the device's state from that report. Never return
  success from an HTTP handler for work a device must actually do.
- **Passwords are real.** `bcryptjs` hashing on write and comparison on login; the old mock never
  stored or checked the password, so any password logged in.
- **SMS codes are real.** Hashed in the `SmsCode` table, purpose-scoped, single-use, with resend
  interval, daily cap, and a verify-attempt limit. In non-production without Tencent credentials
  the send endpoint returns `devCode` so local flows work.
- **Errors are typed.** Throw from the `AppError` family in `server/src/errors/`; the global
  `errorHandler` converts Zod errors, Prisma codes, and body-parser failures into the unified
  error shape. Never leak stack traces or SQL details.

### Admin Console Design Rules

- Separate auth: own `Admin` table, own JWT kind (`admin`), own token key and 401 channel.
  Parent and admin tokens are mutually rejected — asserted in the smoke test.
- Every `/api/admin/*` request is audited to `OperationLog` (including failed logins), with
  sensitive fields sanitized before persisting.
- `authenticateAdmin` guards all admin routes; `requireSuperAdmin` guards admin-account management.
  Server-side guardrails (no self-disable/delete, keep at least one active super admin) are in
  `admin.service.ts` — the UI only reflects them.
- **Never expose children's content** (photos, location trails, recordings) to admins, and never
  return `codeHash` from the SMS audit. Only counts and control settings.
- List pages use `useAsyncData` + `useFilters` (`src/admin/hooks/useAsyncData.ts`); do not fetch
  with a bare `useEffect` that calls `setLoading` synchronously.

### Route Structure (parent frontend)

- `/login` - [LoginPage](src/pages/LoginPage.tsx) - password / SMS-code / register, plus WeChat QR login
- `/` - [HomePage](src/pages/HomePage.tsx) - device overview, feature toggles, command history, media
- `/location` - [LocationPage](src/pages/LocationPage.tsx) - location trail and safe zones
- `/profile` - [ProfilePage](src/pages/ProfilePage.tsx) - account and device list
- `/devices` - [DeviceManagePage](src/pages/DeviceManagePage.tsx) - bind/select/unbind devices
- `/quiz-unlock` - [QuizUnlockPage](src/pages/QuizUnlockPage.tsx) - quiz config, stats, records
- `/media` - [MediaPage](src/pages/MediaPage.tsx) - photos/screenshots/recordings from the device

`BottomNav` is rendered per-route (not globally) so immersive pages like `/login` do not show it.

### Route Structure (admin console, basename `/admin`)

- `/admin/login` - [Login](src/admin/pages/Login.tsx)
- `/admin` - [Dashboard](src/admin/pages/Dashboard.tsx) - KPIs, trends, distributions
- `/admin/users` - [UserManage](src/admin/pages/UserManage.tsx) - parent accounts
- `/admin/devices` - [DeviceManage](src/admin/pages/DeviceManage.tsx) - all devices, force unbind
- `/admin/commands` - [CommandMonitor](src/admin/pages/CommandMonitor.tsx) - command queue monitor
- `/admin/questions` - [QuestionManage](src/admin/pages/QuestionManage.tsx) - quiz bank CRUD
- `/admin/quiz-records` - [QuizRecords](src/admin/pages/QuizRecords.tsx)
- `/admin/sms-codes` - [SmsAudit](src/admin/pages/SmsAudit.tsx)
- `/admin/admins` - [AdminManage](src/admin/pages/AdminManage.tsx) - super admin only
- `/admin/logs` - [OperationLogs](src/admin/pages/OperationLogs.tsx)
- `/admin/settings` - [Settings](src/admin/pages/Settings.tsx) - own password

### Path Alias

Use `@` to import from `src/`:
```typescript
import { api, toUserMessage } from '@/services/api'
import { Card } from '@/components/ui/card'
```

### Conventions

- **UI Language**: All user-facing text is in Chinese (this is a Chinese parental control app)
- **Responsive**: 页面最外层用 `.page-shell`（详见 [`docs/RESPONSIVE.md`](docs/RESPONSIVE.md)），
  栅格要给出 `sm:` / `lg:` 档位，导航统一走 `BottomNav`；横屏与宽屏都要能用。
  验证：`npm run e2e:responsive`（5 档视口 × 14 个页面）
- **Component Exports**: Use named exports: `export function HomePage() {}`
- **Styling**: WeChat-inspired UI with primary green `#07c160`, shadcn/ui, Tailwind CSS v4
- **Error Handling**: try-catch with `toast.error(toUserMessage(error))`; type caught values as `unknown`
- **Types**: shared types live in [`src/types/index.ts`](src/types/index.ts) — do not redeclare
  `Device` / `Features` locally (they were previously duplicated in three files)
- **Dialogs**: Use shadcn/ui Dialog with DialogHeader/DialogContent/DialogFooter

See [AGENTS.md](AGENTS.md) for detailed code style guidelines.
