# Balloon Dog - Agent Guidelines

This is a React + TypeScript mobile web app for child device monitoring with WeChat-style UI,
plus an operator admin console at `/admin`. The backend is a separate npm package under
`server/` (Express + Prisma + PostgreSQL) — see [`server/README.md`](server/README.md) for its
architecture, full API reference, and the admin/auth design.

## Commands

### Development
- `npm run preview:all` - Build, then serve the built site + backend. **This is the exposed one**:
  `vite preview` on :2727 — the reverse proxy and the public domain point here, because the dev
  server is noticeably slower over a remote proxy (on-demand module transform + HMR websocket)
- `npm run preview` - Serve the built `dist/` on :2727 only (needs `npm run build` first)
- `npm run dev` - Vite dev server on :5173 (parent app at `/`, admin console at `/admin`), HMR,
  local development only
- `npm run server:dev` - Start the backend (http://localhost:4000)
- `npm run dev:all` - Dev server + backend concurrently (:5173 + :4000)

### Database
- `npm run db:up` / `db:down` - Start/stop the PostgreSQL container (port **5433**)
- `npm run db:migrate` - Apply Prisma migrations
- `npm run db:seed` - Seed demo data (idempotent). Accounts:
  parent `13800138000` / `balloon123`, admin `admin` / `balloon-admin-2026`,
  operator `operator` / `balloon-operator-2026`
- `npm run db:clean` - Remove accounts/devices created by the smoke test (dry run by default;
  `APPLY=1 npm run db:clean` to actually delete)

### Build & Quality
- `npm run build` - TypeScript type check + Vite production build (frontend)
- `npm run lint` - Run ESLint (frontend)
- `npm run preview` - Serve the production build on :2727 (see Development above)
- `npm run server:typecheck` - Type check the backend
- `npm --prefix server run lint` - Run ESLint (backend)

### Testing
- `npm run server:smoke` - End-to-end backend smoke test (167 assertions: auth, authorization,
  multi-user isolation, device binding, the full device-command queue round trip, and the admin
  console's auth isolation / role split / audit trail). Requires a running backend and a seeded
  database. It registers two throwaway parent accounts and deletes them again in its last section.
- `cd server && npm run agent:example` - Run a simulated child device that polls for commands.
- `npm run server:e2e:children` - Child-profile + daily-task end-to-end test (74 assertions): a parent keeps
  profiles for their children (name / birth year / school), attaches devices to a profile, and sets today's
  tasks. Key assertions: the age is **computed from the birth year** (never stored, and a missing year is
  `null` rather than 0), the three caps (5 profiles / 10 devices / 20 tasks a day) each answer 409, every
  cross-account access is **404 rather than 403** (not even a family member with the `admin` role — §5.1 —
  can read another family's child), device assignment is a **whole-set replacement** that moves a device off
  the previous child and rolls back as a transaction when one id is bad, completion stamps `doneAt`
  (re-completing does not rewrite it, un-completing clears it), and a device reporting a finished task
  through `POST /api/agent/tasks/:taskId` writes exactly one `child_task` notification
  (`dedupeKey: child_task:<taskId>`) while a parent ticking it themselves notifies nobody.
- `npm run server:e2e:privacy` - Compliance end-to-end test (76 assertions): consent records, export and
  deletion against the real database. The two required documents (`guardian_agreement` /
  `minor_data_notice`) are versioned — changing a word bumps `PRIVACY_DOC_VERSION`, and an old record
  flips to `needsReaccept` instead of being silently renewed or deleted; re-consenting to the same
  version is idempotent. Withdrawing consent needs the password **and** a typed confirmation word, and
  it **immediately stops monitoring by deleting the device rows** (plus the media/screen files on disk) —
  *not* by nulling `userId`: device-owned data (`DeviceEvent` / `MediaAsset` / `ScreenBatch`) is archived
  by `deviceId`, so a row without an owner would hand the previous family's photos to whoever binds that
  device next. Deleting an account does the same immediately, then leaves the account in a 7-day
  cooling-off period; the expiry sweep (hourly, plus on boot) removes the files first and then
  `user.delete`s so the cascade takes the child profiles, tasks, orders and consents. The export returns
  metadata only (never the photo/recording bytes) and flags `truncated` at `EXPORT_ROW_LIMIT`.
- `npm run server:e2e:icons` - App-icon end-to-end test (32 assertions): a simulated device reports
  icons, then the parent-side contract is checked — `hasIcon` / signed `iconUrl`, **no icon bytes in
  the list payload**, signature enforcement (missing / tampered / cross-app / expired → 403), server-side
  image sniffing, size caps, and the incremental rule that a re-report *without* `icon` must not wipe the
  stored one. Needs a running backend and a seeded database; cleans up its throwaway device itself.
  The same thing in the browser (real `<img>` decode on `/mode/apps`, `/app-plugins`, `/app-audit`) is
  covered by `npm run e2e`.
- `npm run server:e2e:membership` - Membership end-to-end test (180 assertions): registers a throwaway
  parent (deleted at the end, orders and all), then drives the whole paid flow against the real
  database — dynamic pricing (the test recomputes every rule's arithmetic independently), order
  snapshots, the three billing periods, same-tier renewal extending the period while an upgrade
  restarts it, auto-renew CAS, the `MEMBERSHIP_MOCK_PAY` switch, and every entitlement gate returning
  `403 MEMBERSHIP_REQUIRED` with the right `requiredTier`. Needs a running backend and a seeded database.
- `npm run server:e2e:notifications` - In-app notification end-to-end test (69 assertions): registers a
  throwaway parent and deletes it at the end, then proves the seven producers it owns really write rows (the
  family-member invite is covered by `server:e2e:device-members`, the child-task completion by
  `server:e2e:children`)
  (device lost, controls failed, geofence enter/exit, child requesting an app install, child
  requesting extra time, child sending an SOS), that
  `(userId, dedupeKey)` makes a repeat a no-op rather than a duplicate, and that switching a category
  off stops the row **at the source** — not by hiding it in the UI (otherwise the unread badge stays
  lit and the parent taps into an empty list). Titles/bodies are stored as **templates + params**
  (`{{v0}} 已失联` + `titleParams`), never as pre-interpolated Chinese, because a sentence with a
  device name baked in is not an i18n key and leaks Chinese into the English UI.
- `npm run server:e2e:wechat` - WeChat service-account template-message end-to-end test (52 assertions):
  spawns its own backend (:4101) plus a fake WeChat upstream (`server/scripts/mock-wechat-server.mjs`,
  :4100) so it needs neither `server:dev` nor real credentials. Covers the config gate (default off,
  per-type switch, no delivery row while off), lazy dispatch on `/unread-count`, the rendered Chinese
  template content and link url, token invalidation (40001) forcing one token re-fetch and retry, the
  3-attempt cap with `lastError` recorded, unbound WeChat staying **pending** rather than failed, and
  per-user isolation. Vendor push is **not applicable** (a mobile web app has no native push SDK) and
  the API says so with a reason instead of offering a switch that can never fire.
- `npm run server:e2e:child-home` - Child-home end-to-end test (43 assertions): the child-facing page
  reads `GET /api/agent/child-home` for the parent's name/phone (everything else on that page — time
  left today, whether the device is locked — is computed **on the device**), and its SOS button hits
  `POST /api/agent/sos`, which writes a `sos` device event plus a **danger**-level `child_sos`
  notification (template `'{{v0}} 发起了求助'`). Key assertions: an **unclaimed** device gets
  `bound:false` and `success:false / reason:'unbound'` with **nothing written at all** (a notification
  with no recipient must not exist), a second tap within the same minute does **not** duplicate the
  notification but **does** append another device event, a >200-char message → 422, no token → 401,
  and one parent's SOS never shows up in another parent's message centre.
- `npm run server:e2e:device-members` - Family-member end-to-end test (67 assertions): a device can be
  looked after by several parent accounts. Roles are only two (`admin` can change settings and send
  commands, `viewer` can only look), the owner stays `ChildDevice.userId` and is **not** a row in
  `DeviceMember`, and every write endpoint re-checks the role server-side. Key assertions: a viewer's
  every write entry point → 403, an unrelated parent cannot even learn the device exists (403 on the
  member list and on commands), an admin can write but **still cannot unbind the device or touch the
  member list** (privileges do not copy themselves), removal takes read access away immediately, the
  limit counts **members** so the 5th is allowed and the 6th → 409, phone numbers are always masked,
  and the device side is unaffected (`child-home` still returns the owner's phone).
- `npm run server:e2e:time-requests` - Child time-request end-to-end test (73 assertions): the child
  submits an extra-time request, the parent sees it in `/time-requests`, and approving it really
  enqueues a `temp_unlock` command (the device claims it and reports back, so `locked` converges from
  the report — the server never declares success on the device's behalf). Also covers idempotency (a
  repeat with the same content must not bump `createdAt`), the three-way isolation split (someone
  else's device → 403, an unknown request on your own device → 404, a device with no requests → an
  empty 200 list, deliberately not an empty list for other people's devices), the "the parent may only
  grant **less** than asked" rule, and re-reviewing an already-decided request → 409.
- `npm run server:e2e:health` - Device-health end-to-end test (91 assertions): registers a throwaway
  parent plus a device, then drives the whole snapshot contract against the real database — a device
  that never reported must read "not checked yet" rather than "all good", gap text is passed through
  verbatim, an unreported switch is `unknown` (never guessed), the device's own `level` wins over the
  server's fallback, the snapshot is whole-replace rather than additive, the four liveness bands, the
  deduped `agent_offline` event, `self_check` going through the command queue (enqueue → claim →
  report → snapshot refreshed), and the OEM-specific repair steps (a recognisable Xiaomi model gets
  MIUI paths, an unknown model gets the generic ones, and auto-fixable gaps get **no** manual steps).
  Three liveness assertions backdate `lastActiveAt` directly, so they
  **skip loudly** when `@prisma/client` is unavailable instead of pretending to pass.
- `npm run server:e2e:referral` - Referral (invite-cashback) end-to-end test (159 assertions): registers
  throwaway parents and deletes them again at the end. Drives invite-code generation, binding at
  registration (a bad code must fail **before** the account is created), first-purchase tiers,
  renewal cashback, coupon milestones, idempotency, the identity check (HMAC only, one ID per
  account), lazy next-month settlement, the four withdrawal gates and the review state machine,
  coupon redemption on membership orders, and the admin stats/rules/config/risk endpoints. It
  **rewrites the activity config and the reward tiers to the platform defaults at both the start and
  the end**, because an aborted run used to leave a paused activity behind and poison the next run.
- `npm run server:e2e:payments` - Real-payment-pipeline end-to-end test (82 assertions): spawns its own
  backend on :4102 plus `PAYMENT_FAKE_PROVIDER=true`, so the whole order → notify → refund → invoice
  pipeline runs without a merchant account. Covers signature verification (a bad signature → 401 and the
  order **untouched**, with no `notify/ok` event on that order), unknown order 404, amount mismatch 400,
  an unconfigured channel → 503 naming the exact missing env vars, channel mismatch 400, a successful
  notify applying the membership (`tier` + `transactionId` + `refundDeadline`) and a replayed notify
  being idempotent, cross-account reads/refunds 404, self-service refund (tier revoked, `refundNo`
  recorded) and its ordering conflicts (second refund 409, outside the refund window 403, refund
  blocked while an invoice request is pending **or** issued), the invoice rules, and the admin
  stats/orders/events endpoints. It deletes the throwaway parent it registers. **This is the only
  end-to-end evidence for payments**: the WeChat/Alipay messages are implemented from the public docs
  but there is no merchant account here to test against, so the real channels are honestly reported as
  `未配置` (missing env vars) instead of pretending to work.
- `npm run server:e2e:flags` - Runtime feature-flag end-to-end test (45 assertions): spawns its own
  backend on :4103 and proves the roll-out switches behave like switches — a missing database row means
  the **code default**, not "off" (an operator deleting a row must not make a feature vanish), the
  percentage rollout is a **stable hash** (the same account gets the same answer every time, never a
  coin flip), a whitelist overrides a disabled flag, an unknown flag key is an error rather than a
  silent "off", the payment-channel and self-service-refund flags are wired into the real catalog /
  create-order / refund paths (the refund flag disables **self-service**, not refunds — the admin can
  still refund), `reset` returns to the code default, and every change lands in the audit log.
- `npm run server:e2e:alerts` - Operations alert-dashboard end-to-end test (65 assertions): spawns its
  own backend on :4104, fabricates the four signal kinds (liveness, control effectiveness, payment
  anomalies, notification-delivery failures) on throwaway devices, then checks the contract — five
  built-in rules each advertise their own unit/window/threshold, **a zero denominator is `null`
  ("no data") and never rendered as `0%`**, the three counting kinds agree with a raw recount, changing
  a threshold or disabling a rule flips the trigger state without touching the metrics, snapshot
  metrics reject a window, an unknown rule is 404 instead of silently passing, acknowledging an alert
  records who/when but does not make the number look healthy, and the whole capability is admin-only
  and never leaves the server (no SMS/WeChat/e-mail fan-out).
- `npm run server:e2e:tickets` - Customer-support ticket end-to-end test (69 assertions): spawns its own
  backend on :4105 and drives the whole loop — the intake ignores client-sent status/priority hand-ins
  and reports the fixed categories plus the open-ticket cap and body length, a cross-account read or
  reply is **404 rather than 403**, the admin side can filter/assign/set priority, a support reply
  advances the status and claims the ticket (and the parent still never learns **which** admin replied),
  a parent reply sends it back to the support queue, both sides are refused once the ticket is closed
  (closing one frees the cap for a new one), turning the intake flag off blocks new tickets **but keeps
  history readable**, and every admin action is audited. It deletes its throwaway parent and tickets.
- `npm run e2e` - Browser end-to-end test (parent app + admin console, 200 checks: parent app 120 + admin console 80) driving headless
  Chrome over CDP with no npm dependencies. Targets `http://localhost:2727` by default, so it needs
  `npm run preview:all` running; set `APP_URL=http://localhost:5173` to point it at the dev server
  instead. Override the
  browser with `CHROME_PATH`. Use `--only=parent` / `--only=admin` / `--only=responsive` /
  `--only=ux` to run a single suite; `e2e:responsive` walks 5 viewports × 27 routes (134 checks per
  viewport) and `e2e:ux` (134 checks) covers the **four-step** first-run guide (download QR +
  the child-side authorization checklist, where 「设备管理器」 is the one required item) (including the APK download QR
  code, which it decodes with `BarcodeDetector`), the per-feature tips, login centering, the
  English UI and session robustness. **`e2e:responsive` needs a raised
  `RATE_LIMIT_MAX`**: it does 90 full page reloads, peaking at 300+ requests/minute, and being
  rate-limited makes the app look logged-out (`/login`) so failures masquerade as missing text.
- No frontend unit-test framework is configured yet.

## Internationalization

The parent app ships in **Chinese and English**. The rule is **the Chinese source text IS the
i18n key** — `zh` has no locale file at all (i18next echoes the key when no translation exists, so
Chinese is always correct), and `en` needs only one dictionary:
[`src/i18n/locales/en.ts`](src/i18n/locales/en.ts).

- Components use `t()` from `useTranslation()`; module-level helpers that cannot call a hook use
  `tt()` from [`src/i18n`](src/i18n/index.ts), which reads the singleton directly. The app shell
  re-renders the whole tree on `languageChanged`, so `tt()` output stays fresh after a switch.
- **Never wrap a module-level Chinese constant in `t()` at its definition** — modules evaluate once,
  which would freeze the language at first load. Keep the constant in Chinese and wrap at the *read*
  site instead.
- Dates, numbers and sorting must go through [`src/lib/format.ts`](src/lib/format.ts)
  (`formatDateTime` / `formatDateTimeShort` / `formatTime` / `compareByLocale`). Never call
  `toLocaleString('zh-CN')` directly — it would ignore the selected language.
- The backend sends some display-ready Chinese (command names, command errors, insight notes and
  alert titles). The client wraps those fields in `t()` as well: same "Chinese is the key" rule, and
  unknown keys pass through unchanged, so it is zero-risk.
- **Notification titles/bodies are stored as a template plus params, never as a finished sentence.**
  The producer writes a key-shaped template (`'{{v0}} 已失联'`) and puts the variables in the
  `titleParams` / `bodyParams` JSONB columns. The client renders it through
  `renderNotificationText()` in [`src/pages/NotificationsPage.tsx`](src/pages/NotificationsPage.tsx),
  which runs `tt()` over the template **and** over every string param — params are frequently keys
  themselves (`无障碍看门狗`, `申请加时`), while user data (device name, the reason the child typed)
  passes through unchanged. Interpolating a variable into a Chinese sentence at the producer makes the
  whole string untranslatable, which is exactly the English-UI leak `e2e:ux` caught (twice).

Tooling:

- `npm run i18n:coverage` - **the acceptance check**: lists every Chinese string in `src/` with no
  English entry; exits 1 when anything is missing, so it can be wired into CI. It also catches the
  dynamic `t(SOME_CONST[x].label)` cases the codemod's static scan cannot see.
- `npm run i18n:wrap` - wrap unwrapped Chinese literals in the right helper (`t` / `tt`) and add the
  missing import / `useTranslation()` binding.
- `npm run i18n:wrap-consts` - wrap *accesses* to module-level Chinese constant tables.
- `npm run i18n:keys` - dump the static keys each file uses.
- Both wrap modes are idempotent, and they deliberately skip `key` / `id` / `value` identity
  attributes (a `key` that changes with the language would remount the subtree).
- `src/admin/**` is Chinese-only by design and is excluded from all of the above.

## Tech Stack
- **Framework**: React 19 + TypeScript
- **Build Tool**: Vite 7
- **Styling**: Tailwind CSS v4 (@tailwindcss/vite)
- **UI Components**: shadcn/ui (Radix UI primitives)
- **Routing**: react-router-dom v7
- **State Management**: React hooks (useState, useEffect) + one AuthContext
- **Notifications**: Sonner (toast)
- **Icons**: lucide-react
- **Backend**: Express 5 + Prisma 5 + PostgreSQL 16 + zod + pino + JWT (in `server/`)


## Admin Console (`/admin`)

- Separate Vite entry (`admin/index.html` + `src/admin/`), `basename=/admin`, mount `#admin-root`.
  Admin code must not leak into the parent app's bundle — keep imports one-directional
  (`src/admin/**` may import from `src/components/ui/**` and `src/lib/**`, never the reverse).
- Admin auth is fully separate: its own `Admin` table, its own token (`kind: 'admin'` in the JWT),
  its own localStorage key (`balloon_dog_admin_token`) and its own 401 event channel. A parent
  token can never reach `/api/admin/*` and an admin token can never reach parent endpoints —
  both directions are asserted in the smoke test.
- Every `/api/admin/*` request is written to `OperationLog` by `admin.audit.ts` (including failed
  logins). Sensitive fields must be sanitized before persisting — never store raw passwords,
  tokens, or codes in the audit detail.
- Use `authenticateAdmin` for any admin endpoint; add `requireSuperAdmin` for endpoints that
  manage admin accounts. Server-side guardrails (cannot disable/delete self, cannot remove the
  last active super admin) exist in `admin.service.ts` — do not bypass them in the UI only.
- **Do not expose children's content to admins.** The console shows control settings and counts
  (media size, location counts), never photos, location trails, or recordings. SMS audit never
  returns `codeHash`. Keep it that way unless a separately authorized, audited flow is designed.
- List pages must use `useAsyncData` + `useFilters` from `src/admin/hooks/useAsyncData.ts`.
  Do not write `useEffect(() => { setLoading(true); fetch() }, [])` — it triggers
  `react-hooks/set-state-in-effect`. Reset pagination in the filter change handler
  (`useFilters` already does this), not in an effect.

## Frontend ↔ Backend Contract

- All HTTP calls go through `src/services/api.ts`. Never call `fetch` directly from a page.
- Use relative paths (`/api/...`) — dev goes through the Vite proxy, prod through Nginx.
- Errors: `ApiError.userMessage` holds a ready-to-display Chinese sentence from the backend.
  Always surface it with `toUserMessage(error)`; never render raw `error.message` or HTTP codes.
- 401 is handled centrally in `api.ts` (clears the token, notifies `AuthContext` which
  redirects to `/login`). Pages should not implement their own 401 handling.
- Every endpoint is scoped to the logged-in parent. When adding a device-scoped endpoint,
  resolve the device through `shared/deviceScope.ts` — never trust a `deviceId` without an
  ownership check, and never introduce global device state (that was the old mock's core bug).
- Device scope is **role-aware** (`shared/deviceScope.ts`): `resolveDevice` / `requireDeviceAccess`
  for reads, `resolveWritableDevice` / `requireWritableDevice` for anything that changes state, and
  `requireOwnerDevice` for the two things only the owner may do (unbind the device, invite/remove/
  re-role family members). Do not re-derive ownership with a bare `device.userId !== userId` check
  in a new handler — that silently forgets the invited members, and the one endpoint that forgets is
  always a write endpoint.
- Remote capabilities (lock, photo, recording, screenshot) **must** go through the device
  command queue. Do not return success from an HTTP handler for something a device has to do:
  enqueue a command, let the agent claim it, and reconcile state from its report.
- The admin console has its own API layer at `src/admin/api/` — do not reuse
  `src/services/api.ts` there, and do not share token storage between the two.

## Code Style Guidelines

### Imports
- Use path alias `@` for imports from `src/` directory
- Group imports in this order:
  1. React hooks (useState, useEffect, etc.)
  2. UI components from `@/components/ui/`
  3. Custom components from `@/components/`
  4. Services/API from `@/services/`
  5. Third-party libraries (lucide-react, sonner, etc.)
  6. Utility types if needed
- Example:
```typescript
import { useState, useEffect } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import { Shield, Lock } from 'lucide-react'
import { api } from '@/services/api'
```

### Component Structure
- Use named exports for components: `export function HomePage() {}`
- Set displayName on forwardRef components: `Button.displayName = "Button"`
- Use functional components with hooks (no class components)
- Use `cn()` utility from `@/lib/utils` for conditional Tailwind classes

### TypeScript
- Strict mode is enabled in tsconfig
- Define interfaces for all data structures in `src/types/index.ts`
- Use proper types for props - extend built-in types when possible
- Use union types for string literals: `'online' | 'offline'`
- Use optional properties with `?` where appropriate
- Avoid `any` - prefer `unknown` or proper types

### Naming Conventions
- **Components**: PascalCase (HomePage, BottomNav)
- **Functions/Variables**: camelCase (loadData, device, features)
- **Constants**: PascalCase for component constants, camelCase for others
- **Interfaces**: PascalCase (Device, Features)
- **Files**: PascalCase for components (HomePage.tsx), camelCase for utilities (api.ts)
- **Events**: `handle` prefix for event handlers (handleClick, handleSubmit)
- **State**: use descriptive names (loading, device, features)

### Error Handling
- Use try-catch blocks for all async operations
- Use `toast.error()` for user-facing errors with Chinese messages
- Use `toast.success()` for success confirmations
- Log errors with `console.error()` for debugging
- `ApiError` in api.ts exposes `userMessage` (the backend's ready-to-display Chinese sentence),
  `status`, `code`, `detail` and `fieldErrors`
- Always call `toUserMessage(error, fallback)` to get display text — it also maps network
  failures and timeouts. Do not write `error.message || '...'` by hand.
- Type caught values as `unknown`, not `any`
- Example:
```typescript
const handleAction = async () => {
  try {
    await api.someAction()
    toast.success('操作成功')
  } catch (error: unknown) {
    toast.error(toUserMessage(error, '操作失败，请稍后重试'))
    console.error('操作失败：', error)
  }
}
```

### UI/UX Patterns
- **Mobile-first, but responsive**: 默认按手机竖屏设计（微信风格），但**必须**在横屏手机与
  宽屏下也成立。做法见 [`docs/RESPONSIVE.md`](docs/RESPONSIVE.md)：
  - 页面最外层用 `.page-shell`（必要时加 `--wide` / `--immersive` / `--center`），
    **不要**自己写 `min-h-screen pb-20 bg-gray-100`；
  - 白底标题栏加 `page-header` 类（必须是 `.page-shell` 的直接子元素）——
    它靠负 margin 铺满整个可用宽度，不加就会跟着内容一起被挤窄；
  - 固定列数的栅格一律给出 `sm:` / `lg:` 档位，别让宽屏继续用手机的列数；
  - 导航由 `BottomNav` 统一处理（窄屏底栏 / 宽屏侧栏），不要再写第二套；
  - 矮视口（横屏手机）要收紧纵向留白，别只盯着宽度。
- **Color Scheme**: Primary green `#07c160` (WeChat green), danger red, neutral grays
- **Dialogs**: Use shadcn/ui Dialog component with DialogHeader, DialogContent, DialogFooter
- **Forms**: Use proper input fields with focus states (border-[#07c160])
- **Loading**: Show loading state with spinner and "加载中..." text
- **Empty states**: Show user-friendly empty state messages
- **Hover/Active**: Use `hover:bg-gray-50 active:bg-gray-100` for clickable items

### API Layer
- All API calls go through `src/services/api.ts` (namespaced groups: `authApi`, `deviceApi`,
  `commandApi`, `featureApi`, `quizApi`, `locationApi`, `mediaApi`; plus a flat `api` alias)
- Base URL is the relative `/api` — dev uses the Vite proxy, prod uses Nginx. Never hardcode
  a host or port.
- 15 second timeout via `AbortSignal.timeout`
- All methods (including `delete`) send the `Authorization` header
- `ApiError` carries the backend's Chinese `message` as `userMessage`; use `toUserMessage(error)`
- 401 responses clear the token and notify `AuthContext`; pages must not duplicate that
- Always reload data after mutations (e.g. `await loadData({ silent: true })`)

### File Organization
```
src/
├── components/
│   ├── ui/            # shadcn/ui components
│   ├── BottomNav.tsx
│   └── ErrorBoundary.tsx
├── contexts/          # AuthContext (user, login/register, 401 wiring)
├── pages/             # HomePage / LocationPage / ProfilePage / DeviceManagePage
│                      # QuizUnlockPage / MediaPage / LoginPage
├── services/api.ts    # API layer
├── types/index.ts     # types mirroring the backend contract
├── lib/utils.ts       # cn()
├── App.tsx            # routing + ProtectedRoute + ErrorBoundary
└── main.tsx           # entry point
```

### Tailwind CSS
- Use Tailwind v4 with Vite plugin (no config file needed)
- WeChat-inspired color palette
- Use standard spacing (p-4, py-3, space-x-2)
- Responsive classes - mobile-first approach
- Utility-first: avoid custom CSS classes
- Safe area insets for iPhone: `safe-area-inset-top`, `safe-area-inset-bottom`

### Best Practices
- Always clean up useEffect with proper dependencies
- Use loading states during async operations
- Validate user inputs before API calls
- Close dialogs after successful operations
- Update state by reading current state or use functional updates
- Keep components focused and single-purpose
- Extract reusable logic into custom hooks if needed
- Use meaningful variable names, avoid abbreviations
- Add comments only when code is complex or unclear
