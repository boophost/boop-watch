import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import './kagura.css'
import App from './App.tsx'
import { AuthProvider } from './lib/AuthContext.tsx'
import { RouteAnalytics } from './components/RouteAnalytics.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <RouteAnalytics />
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
)
