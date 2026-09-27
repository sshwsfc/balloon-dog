# Balloon Dog - Agent Guidelines

This is a React + TypeScript mobile web app for child device monitoring with WeChat-style UI,
plus an operator admin console at `/admin`. The backend is a separate npm package under
`server/` (Express + Prisma + PostgreSQL) — see [`server/README.md`](server/README.md) for its
architecture, full API reference, and the admin/auth design.

## Commands

### Development
- `npm run dev` - Start Vite dev server (parent app at `/`, admin console at `/admin`)
- `npm run server:dev` - Start the backend (http://localhost:4000)
- `npm run dev:all` - Start both frontend and backend concurrently

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
- `npm run preview` - Preview production build locally
- `npm run server:typecheck` - Type check the backend
- `npm --prefix server run lint` - Run ESLint (backend)

### Testing
- `npm run server:smoke` - End-to-end backend smoke test (158 assertions: auth, authorization,
  multi-user isolation, device binding, the full device-command queue round trip, and the admin
  console's auth isolation / role split / audit trail). Requires a running backend and a seeded
  database.
- `cd server && npm run agent:example` - Run a simulated child device that polls for commands.
- `npm run e2e` - Browser end-to-end test (parent app + admin console, 55 checks) driving headless
  Chrome over CDP with no npm dependencies. Requires `npm run dev:all` to be running. Override the
  browser with `CHROME_PATH`.
- No frontend unit-test framework is configured yet.

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
- **Mobile-first**: All designs are for mobile (WeChat style)
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
