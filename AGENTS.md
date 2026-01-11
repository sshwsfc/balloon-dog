# Balloon Dog - Agent Guidelines

This is a React + TypeScript mobile web app for child device monitoring with WeChat-style UI.

## Commands

### Development
- `npm run dev` - Start Vite dev server (http://localhost:5173)
- `npm run mock-server` - Start Express mock API server (http://localhost:3000)
- `npm run dev:all` - Start both dev server and mock server concurrently

### Build & Quality
- `npm run build` - TypeScript type check + Vite production build
- `npm run lint` - Run ESLint on the codebase
- `npm run preview` - Preview production build locally

### Testing
- No test framework is currently configured. Add test commands here when implemented.

## Tech Stack
- **Framework**: React 19 + TypeScript
- **Build Tool**: Vite 7
- **Styling**: Tailwind CSS v4 (@tailwindcss/vite)
- **UI Components**: shadcn/ui (Radix UI primitives)
- **Routing**: react-router-dom v7
- **State Management**: React hooks (useState, useEffect)
- **Notifications**: Sonner (toast)
- **Icons**: lucide-react
- **Mock Server**: Express + ts-node

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
- Custom `ApiError` class in api.ts has `userMessage` for friendly errors
- Example:
```typescript
const handleAction = async () => {
  try {
    await api.someAction()
    toast.success('操作成功')
  } catch (error: any) {
    toast.error(error.message || '操作失败，请稍后重试')
    console.error('Failed to perform action:', error)
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
- All API calls go through `src/services/api.ts`
- ApiError class provides user-friendly error messages
- 10 second timeout on all requests
- API base URL: `http://localhost:3000/api`
- Methods: get, post, put, delete
- Always reload data after mutations (await loadData())

### File Organization
```
src/
├── components/
│   ├── ui/        # shadcn/ui components
│   └── *.tsx      # custom components (BottomNav, etc.)
├── pages/         # route/page components (HomePage, LocationPage, ProfilePage)
├── services/      # API services, business logic
├── types/         # TypeScript interfaces and types
├── lib/           # utilities (cn() function)
├── App.tsx        # main app with routing
└── main.tsx       # entry point
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
