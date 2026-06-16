import { Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { useAuth } from './lib/AuthContext'
import { APP_VERSION } from './version'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import SeriesDetail from './pages/SeriesDetail'

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

export default function App() {
  return (
    <>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<RequireAuth />}>
          <Route index element={<Dashboard />} />
          <Route path="series/:seriesId" element={<SeriesDetail />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <div className="app-version" aria-hidden>
        v{APP_VERSION}
      </div>
    </>
  )
}
