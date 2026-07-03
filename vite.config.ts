import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { execSync } from 'node:child_process'
import path from 'path'

// Short commit hash for the footer. In the Docker build `.git` is absent
// (.dockerignore), so CI passes it in via the GIT_SHA build arg; local host
// builds fall back to reading git directly.
function gitSha(): string {
  const fromEnv = process.env.GIT_SHA
  if (fromEnv) return fromEnv.slice(0, 7)
  try {
    return execSync('git rev-parse --short=7 HEAD').toString().trim()
  } catch {
    return 'dev'
  }
}

export default defineConfig({
  define: {
    __APP_COMMIT__: JSON.stringify(gitSha()),
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: true,
    proxy: {
      '/api': 'http://localhost:3001',
      '/img': 'http://localhost:3001',
    },
  },
})
