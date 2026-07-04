import { Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { useAuth } from './lib/AuthContext'
import { APP_VERSION, APP_COMMIT } from './version'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import AdminSeriesDetail from './pages/SeriesDetail'
import Browse from './pages/Browse'
import Title from './pages/Title'
import Watch from './pages/Watch'
import SchedulePage from './pages/SchedulePage'
import Signup from './pages/Signup'
import Profile from './pages/Profile'

function RequireAuth() {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    )
  }

  if (!user) return <Navigate to="/login" replace />
  return <Outlet />
}

function RequireAdmin() {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    )
  }

  if (!user || !user.isAdmin) return <Navigate to="/profile" replace />
  return <Outlet />
}

export default function App() {
  return (
    <>
      <Routes>
        {/* Public, no-login portal */}
        <Route path="/" element={<Browse />} />
        <Route path="/series/:id" element={<Title />} />
        <Route path="/movie/:id" element={<Title />} />
        <Route path="/watch/:id" element={<Watch />} />
        <Route path="/schedule" element={<SchedulePage />} />

        {/* Authenticated routes */}
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/profile" element={<RequireAuth />}>
          <Route index element={<Profile />} />
        </Route>

        {/* Admin routes */}
        <Route path="/manage" element={<RequireAdmin />}>
          <Route index element={<Dashboard />} />
          <Route path="series/:seriesId" element={<AdminSeriesDetail />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <div className="app-version" aria-hidden>
        v{APP_VERSION} ({APP_COMMIT})
      </div>
    </>
  )
}
