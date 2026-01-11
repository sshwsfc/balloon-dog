import { Link, useLocation } from 'react-router-dom'
import { Home, MapPin, User } from 'lucide-react'
import { cn } from '@/lib/utils'

const navItems = [
  { path: '/', icon: Home, label: '首页' },
  { path: '/location', icon: MapPin, label: '位置' },
  { path: '/profile', icon: User, label: '我的' },
]

export function BottomNav() {
  const location = useLocation()

  return (
    <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 safe-area-inset-bottom z-50">
      <div className="flex justify-around items-center h-14">
        {navItems.map((item) => {
          const Icon = item.icon
          const isActive = location.pathname === item.path
          
          return (
            <Link
              key={item.path}
              to={item.path}
              className={cn(
                "flex flex-col items-center justify-center space-y-0.5 w-full h-full",
                isActive ? "text-green-500" : "text-gray-400"
              )}
            >
              <Icon className={cn("w-6 h-6", isActive ? "text-green-500" : "text-gray-400")} />
              <span className="text-xs">{item.label}</span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
