import { useAuth } from '../lib/AuthContext'
import { PortalLayout, Avatar } from '../components/PortalLayout'
import { useNavigate } from 'react-router-dom'

export default function Profile() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  const handleLogout = async () => {
    await logout()
    navigate('/')
  }

  return (
    <PortalLayout>
      <div className="p-8 max-w-2xl mx-auto w-full">
        <div className="bg-white/5 border border-white/10 rounded-lg p-6">
          <h1 className="text-2xl font-semibold mb-6">Profile</h1>
          
          <div className="flex items-center gap-4 mb-8">
            {user && <Avatar user={user} size={64} />}
            <div>
              <div className="text-lg font-medium">{user?.username}</div>
              <div className="text-sm text-white/50">ID: {user?.id}</div>
              {user?.isAdmin && (
                <div className="mt-1">
                  <span className="text-xs bg-accent text-accent-fg px-2 py-0.5 rounded font-medium">Admin</span>
                </div>
              )}
            </div>
          </div>

          <div className="pt-6 border-t border-white/10 flex items-center gap-4">
            {user?.isAdmin && (
              <button 
                onClick={() => navigate('/manage')}
                className="px-4 py-2 bg-white/10 text-white hover:bg-white/20 rounded transition-colors"
              >
                Admin Dashboard
              </button>
            )}
            <button 
              onClick={handleLogout}
              className="px-4 py-2 bg-red-500/10 text-red-400 hover:bg-red-500/20 rounded transition-colors"
            >
              Log Out
            </button>
          </div>
        </div>
      </div>
    </PortalLayout>
  )
}
