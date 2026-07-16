import { lazy, Suspense } from 'react'
import { Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from './lib/AuthContext'
import { APP_VERSION, APP_COMMIT } from './version'
import Login from './pages/Login'
import ManageLayout from './pages/manage/ManageLayout'
import Library from './pages/manage/Library'
import Flows from './pages/manage/Flows'
import Schedules from './pages/manage/Schedules'
import Activity from './pages/manage/Activity'
import Users from './pages/manage/Users'
import Suggestions from './pages/manage/Suggestions'
import AdminSeriesDetail from './pages/SeriesDetail'

// The graph editor / map pull in @xyflow/react — keep them out of the portal bundle.
const FlowEditor = lazy(() => import('./pages/manage/FlowEditor'))
const FlowMap = lazy(() => import('./pages/manage/FlowMap'))
import Browse from './pages/Browse'
import Title from './pages/Title'
import Watch from './pages/Watch'
import SchedulePage from './pages/SchedulePage'
import Signup from './pages/Signup'
import Profile from './pages/Profile'
import PersonalLibrary from './pages/PersonalLibrary'

function RequireAuth() {
  const { user, loading } = useAuth()
  const location = useLocation()

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    )
  }

  // Stash where the user was headed so Login can send them back after sign-in.
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />
  return <Outlet />
}

function RequireAuthSignup() {
  const { user, loading } = useAuth()
  const location = useLocation()

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    )
  }

  if (!user) return <Navigate to="/signup" replace state={{ from: location }} />
  return <Outlet />
}

function RequireAdmin() {
  const { user, loading, adminReady } = useAuth()

  // isAdmin resolves asynchronously (server round trip) after loading flips
  // false — without the adminReady wait, a hard refresh on /manage would
  // bounce to /profile before the real answer arrives.
  if (loading || (user && !adminReady)) {
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
        
        <Route element={<RequireAuthSignup />}>
          <Route path="/library" element={<PersonalLibrary />} />
        </Route>

        {/* Admin routes */}
        <Route path="/manage" element={<RequireAdmin />}>
          <Route element={<ManageLayout />}>
            <Route index element={<Library />} />
            <Route path="series/:seriesId" element={<AdminSeriesDetail />} />
            <Route path="activity" element={<Activity />} />
            <Route path="users" element={<Users />} />
            <Route path="suggestions" element={<Suggestions />} />
            <Route path="flows" element={<Flows />} />
            <Route path="schedules" element={<Schedules />} />
            <Route
              path="flows/map"
              element={
                <Suspense
                  fallback={
                    <div className="flex h-screen items-center justify-center">
                      <div className="text-muted-foreground">Loading map…</div>
                    </div>
                  }
                >
                  <FlowMap />
                </Suspense>
              }
            />
            <Route
              path="flows/:flowId"
              element={
                <Suspense
                  fallback={
                    <div className="flex h-screen items-center justify-center">
                      <div className="text-muted-foreground">Loading editor…</div>
                    </div>
                  }
                >
                  <FlowEditor />
                </Suspense>
              }
            />
          </Route>
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <div className="app-version" aria-hidden>
        v{APP_VERSION} ({APP_COMMIT})
      </div>
    </>
  )
}
