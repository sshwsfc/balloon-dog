# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Commands

### Development
- `npm run dev` - Start Vite dev server (http://localhost:5173)
- `npm run mock-server` - Start Express mock API server (http://localhost:3000)
- `npm run dev:all` - Start both frontend and backend concurrently (recommended)

### Build & Quality
- `npm run build` - TypeScript type check + Vite production build
- `npm run lint` - Run ESLint

## Architecture

This is a parental control/child device monitoring app with a **dual-server architecture**:

1. **Frontend** (Vite dev server on :5173): React 19 + TypeScript app using React Router for navigation
2. **Mock Backend** (Express server on :3000): API server that persists state to [src/mock/db.json](src/mock/db.json)

The two servers run independently - when developing, run both with `npm run dev:all`.

### Key Data Flow

- API calls go through the centralized [`api`](src/services/api.ts) service (has 10s timeout, Chinese error messages)
- Mock server reads/writes to `db.json` directly (in-memory sync on startup)
- State management uses React hooks only (no global state library)
- Toast notifications use `sonner` - call `toast.success()` / `toast.error()` with Chinese messages

### Route Structure

- `/` - [HomePage](src/pages/HomePage.tsx) - Device controls and feature toggles
- `/location` - [LocationPage](src/pages/LocationPage.tsx) - Location history and safe zones
- `/profile` - [ProfilePage](src/pages/ProfilePage.tsx) - User profile and child device management

### Path Alias

Use `@` to import from `src/`:
```typescript
import { api } from '@/services/api'
import { Card } from '@/components/ui/card'
```

### Conventions

- **UI Language**: All user-facing text is in Chinese (this is a Chinese parental control app)
- **Component Exports**: Use named exports: `export function HomePage() {}`
- **Styling**: WeChat-inspired UI with primary green `#07c160`, shadcn/ui components, Tailwind CSS v4
- **Error Handling**: Always use try-catch with toast.error() for async operations
- **API Mutations**: Reload data after mutations (call `loadData()` or similar)
- **Dialogs**: Use shadcn/ui Dialog with DialogHeader/DialogContent/DialogFooter pattern

See [AGENTS.md](AGENTS.md) for detailed code style guidelines.
