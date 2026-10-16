# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Commands

### Development
- `npm run preview:all` - Build, then serve the built site + backend (**this is the exposed one**:
  `vite preview` on :2727 — the reverse proxy and the public domain point here)
- `npm run preview` - Serve the built `dist/` on :2727 only (requires `npm run build` first)
- `npm run dev` - Vite dev server on :5173 (parent app `/`, admin console `/admin`), HMR, local only
- `npm run server:dev` - Start the backend (http://localhost:4000)
- `npm run dev:all` - Dev server + backend concurrently (:5173 + :4000)

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
- `npm run server:smoke` - End-to-end backend smoke test (167 assertions). Needs a running backend
  and a seeded database. Covers auth, authorization, multi-user isolation, device binding, the full
  device-command queue round trip, and the admin console (token isolation, role split, audit). Its
  two throwaway parent accounts are deleted again in the last section.
- `cd server && npm run agent:example` - Simulated child device that polls for and executes commands.
- `npm run server:e2e:icons` / `npm run server:e2e:membership` / `npm run server:e2e:referral` /
  `npm run server:e2e:health` / `npm run server:e2e:notifications` / `npm run server:e2e:time-requests` /
  `npm run server:e2e:wechat` / `npm run server:e2e:child-home` / `npm run server:e2e:device-members` /
  `npm run server:e2e:children` / `npm run server:e2e:privacy` / `npm run server:e2e:payments` /
  `npm run server:e2e:flags` / `npm run server:e2e:alerts` / `npm run server:e2e:tickets` -
  Feature-level backend e2e tests
  (icons: 32 assertions; membership: 180; referral: 159; health: 91; notifications: 69;
  time-requests: 73; wechat: 52, which spawns its own backend + fake upstream; child-home: 43;
  device-members: 67, roles owner/admin/viewer with every write entry re-checked server-side;
  children: 74, child profiles + daily tasks, age computed from the birth year, cross-account reads 404;
  privacy: 76, consent versioning + export + deletion, and the rule that withdrawing consent or deleting
  the account **deletes the device rows** (plus the files on disk) rather than nulling `userId`, because
  device-owned data is archived by `deviceId`; payments: 82, the order → notify → refund → invoice
  pipeline driven through a fake provider on its own :4102 backend, because the real WeChat/Alipay
  channels have no merchant credentials here and are reported as `未配置`; flags: 45, the runtime
  roll-out switches driven on their own :4103 backend — a missing row means the **code default** rather
  than "off", the rollout is a stable hash instead of a coin flip, and the payment-channel /
  self-service-refund flags are wired into the real paths; alerts: 65, the operations dashboard on :4104
  — five built-in rules with their own unit/window/threshold, a zero denominator reported as `null`
  ("no data") and never as `0%`, a threshold edit flipping the trigger without touching the metrics, and
  acknowledgement recording who/when **without** making the number look healthy; tickets: 69, the support
  loop on :4105 — cross-account access is 404, a support reply claims the ticket and advances its status
  while the parent never learns which admin replied, a closed ticket refuses both sides, and switching
  the intake flag off blocks new tickets but keeps history readable). All the others need a running
  backend + seeded database and clean up the throwaway parent/device they register. Membership covers
  dynamic pricing, order snapshots, the three billing periods, auto-renew CAS, mock pay, and every
  `403 MEMBERSHIP_REQUIRED` gate. Referral covers invite-code binding (validated **before** the
  account is created), first-purchase tiers, renewal cashback, coupon milestones, next-month
  settlement, the withdrawal gates and review state machine, and coupon redemption on membership
  orders — and it resets the activity config / reward tiers to the platform defaults at both ends,
  so an aborted run cannot poison the next one. Health covers the device-health snapshot contract
  (never-reported is "not checked yet", uknown is `unknown`, the device's own level wins, whole-replace
  snapshots, the four liveness bands, and `self_check` through the command queue). Notifications covers
  the in-app message centre: six producers, idempotent dedupe, and the hard rule that turning a
  category off stops it **at the source** (not in the UI); titles/bodies are stored as templates +
  params so the English UI never shows an interpolated Chinese sentence. WeChat service-account template
  messages are the one real out-of-app channel (env-gated, delivery table with a 3-attempt retry cap);
  vendor push is reported as **not applicable** rather than offered as a dead switch.
- `npm run e2e` - Browser end-to-end test for both SPAs (200 checks: parent app 120 + admin 80) via CDP-driven headless Chrome;
  targets `http://localhost:2727` by default, so have `npm run preview:all` running (override with
  `APP_URL=http://localhost:5173` to run against the dev server instead).
  `--only=parent|admin|responsive|ux` runs one suite;
  `e2e:responsive` walks 5 viewports × 27 routes (134 per viewport), `e2e:ux` (128 checks) covers the first-run guide
  (decoding the APK QR code with `BarcodeDetector`), per-feature tips, login centering, the English
  UI and session robustness. Running
  `e2e:responsive` requires a raised `RATE_LIMIT_MAX` (see `server/.env.example`) — it peaks at
  300+ requests/minute and a 429 otherwise shows up as a bogus "logged out" failure.
- No frontend unit-test framework is configured.

## Internationalization

The parent app ships in **Chinese and English**. **The Chinese source text IS the i18n key** — `zh`
has no locale file (i18next echoes the key when no translation exists, so Chinese is always
correct), and `en` needs only [`src/i18n/locales/en.ts`](src/i18n/locales/en.ts).

- Components use `t()` from `useTranslation()`; module-level helpers that cannot call a hook use
  `tt()` from [`src/i18n`](src/i18n/index.ts). The app shell re-renders the tree on
  `languageChanged`, so `tt()` output stays fresh.
- **Never wrap a module-level Chinese constant in `t()` at its definition** — modules evaluate once,
  which would freeze the language at first load. Keep the constant in Chinese, wrap at the *read*
  site.
- Dates, numbers and sorting go through [`src/lib/format.ts`](src/lib/format.ts). Never call
  `toLocaleString('zh-CN')` directly.
- Backend-sent Chinese (command names, command errors, insight notes, alert titles) is wrapped in
  `t()` at the render site too — same key rule, and unknown keys pass through unchanged.
- **Notifications store a template plus params** (`Notification.titleParams` / `bodyParams` are JSONB;
  the title/body themselves are key-shaped templates like `'{{v0}} 已失联'`), and the client runs
  `tt()` over the template *and* every string param in
  [`src/pages/NotificationsPage.tsx`](src/pages/NotificationsPage.tsx) (`renderNotificationText`).
  Baking a variable into a Chinese sentence at the producer loses translatability — `e2e:ux`'s
  English scan is what caught it.
- `npm run i18n:coverage` is the acceptance check (exits 1 on any untranslated string — CI-ready).
  `i18n:wrap` / `i18n:wrap-consts` are idempotent codemods that add the wrapping; `i18n:keys` lists
  static keys. All of them skip `src/admin/**`, which is Chinese-only by design.

## Architecture

Parental control / child device monitoring app with a **two-package, three-SPA layout**:

1. **Parent app** (repo root, entry `index.html`) — React 19 +
   TypeScript, React Router, Tailwind v4 + shadcn/ui, WeChat-style mobile UI.
   Two ports, see `vite.config.ts`: **`:2727`** = `vite preview` on the built `dist/`, this is
   what the reverse proxy and the public domain hit (dev server is noticeably slower over a
   remote proxy); **`:5173`** = `vite dev` for local work, HMR, not exposed.
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

- **Every endpoint is scoped to the logged-in parent, and device scope is role-aware.** Device-scoped
  handlers resolve the device through
  [`server/src/shared/deviceScope.ts`](server/src/shared/deviceScope.ts) (`403` on mismatch):
  `requireDeviceAccess` for reads, `requireWritableDevice` for writes, `requireOwnerDevice` for
  unbinding and for managing family members (planning §5.1 — a viewer is read-only, an admin can
  write but cannot unbind or re-role anyone). Never re-derive ownership by hand in a new handler,
  and never introduce global device state — the old mock kept
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
- `/membership` - [MembershipPage](src/pages/MembershipPage.tsx) - 会员档位、动态报价、收银台；**支付渠道实况完全来自 `GET /api/payments/catalog`**（未配置就如实显示缺哪个环境变量，不画扫不出来的二维码），已支付订单可自助退款（窗口内）与申请开票
- `/referral` - [ReferralPage](src/pages/ReferralPage.tsx) - invite code/link/QR, cashback tiers, withdrawals, coupons
- `/media` - [MediaPage](src/pages/MediaPage.tsx) - photos/screenshots/recordings from the device
- `/device-health` - [DeviceHealthPage](src/pages/DeviceHealthPage.tsx) - whether the controls still hold (device-owner / accessibility / permissions / battery / VPN gaps reported by the child device), plus a `self_check` re-check
- `/notifications` - [NotificationsPage](src/pages/NotificationsPage.tsx) - in-app message centre (unread badge, mark read/all, delete, jump to the source page)
- `/support` - [SupportPage](src/pages/SupportPage.tsx) - 帮助与反馈：提交客服工单（分类 / 正文上限 / 未关闭上限全部由服务端下发）、补充说明、关闭后不可再回；页面上没有任何附件上传入口
- `/notifications/settings` - [NotificationSettingsPage](src/pages/NotificationSettingsPage.tsx) - per-category in-app switches, plus a per-category WeChat switch that only appears once the server has WeChat credentials **and** the parent has linked WeChat (with a "send a test message" button that surfaces WeChat's own error text); vendor push is labelled "not applicable" (a mobile web app has no native push SDK) rather than offered as a switch that can never fire

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
- `/admin/membership` - [Membership](src/admin/pages/Membership.tsx) - 会员统计 / 套餐 / 定价规则（含试算）/ 受邀用户定价（含试算）/ 订单
- `/admin/payments` - [Payments](src/admin/pages/Payments.tsx) - 收款统计（含渠道配置体检）/ 订单（流水、人工退款）/ 退款 / 发票（开具必须填发票号）
- `/admin/referral` - [Referral](src/admin/pages/Referral.tsx) - 分享提成统计 / 提现审核 / 邀请记录 / 返现明细 / 优惠券 / 活动配置 / 规则阶梯 / 风险排查
- `/admin/admins` - [AdminManage](src/admin/pages/AdminManage.tsx) - super admin only
- `/admin/logs` - [OperationLogs](src/admin/pages/OperationLogs.tsx)
- `/admin/settings` - [Settings](src/admin/pages/Settings.tsx) - own password
- `/admin/alerts` - [Alerts](src/admin/pages/Alerts.tsx) - 告警大盘（总览 / 规则 / 确认记录），分母为 0 显示「—」而不是 0%
- `/admin/flags` - [Flags](src/admin/pages/Flags.tsx) - 灰度开关（稳定哈希放量、白名单、缺行回落代码默认）
- `/admin/tickets` - [Tickets](src/admin/pages/Tickets.tsx) - 客服工单（筛选 / 详情 / 分派 / 回复 / 关闭）

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
  验证：`npm run e2e:responsive`（5 档视口 × 27 个页面，每档 134 项）
- **Component Exports**: Use named exports: `export function HomePage() {}`
- **Styling**: WeChat-inspired UI with primary green `#07c160`, shadcn/ui, Tailwind CSS v4
- **Error Handling**: try-catch with `toast.error(toUserMessage(error))`; type caught values as `unknown`
- **Types**: shared types live in [`src/types/index.ts`](src/types/index.ts) — do not redeclare
  `Device` / `Features` locally (they were previously duplicated in three files)
- **Dialogs**: Use shadcn/ui Dialog with DialogHeader/DialogContent/DialogFooter

See [AGENTS.md](AGENTS.md) for detailed code style guidelines.
