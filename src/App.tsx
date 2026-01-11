import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { HomePage } from './pages/HomePage'
import { LocationPage } from './pages/LocationPage'
import { ProfilePage } from './pages/ProfilePage'
import { BottomNav } from './components/BottomNav'
import { Toaster } from 'sonner'

function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-gray-100">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/location" element={<LocationPage />} />
          <Route path="/profile" element={<ProfilePage />} />
        </Routes>
        <BottomNav />
        <Toaster position="top-center" richColors />
      </div>
    </BrowserRouter>
  )
}

export default App
