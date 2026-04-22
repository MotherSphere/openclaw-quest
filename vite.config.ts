import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
const backendUrl = process.env.VITE_BACKEND_URL || 'http://localhost:8420'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // NPC chat and /api/cycle/start both wait on a 30-90s `openclaw agent`
      // turn. The http-proxy default (~30s) aborts before the backend can
      // reply, surfacing as `NetworkError when attempting to fetch resource`
      // in the browser. Give the whole /api proxy a generous timeout.
      '/api': { target: backendUrl, timeout: 180000, proxyTimeout: 180000 },
      '/ws': { target: backendUrl, ws: true, changeOrigin: true },
      '/bg': backendUrl,
      '/skills': backendUrl,
      '/items': backendUrl,
      '/npc': backendUrl,
      '/sprites': backendUrl,
      '/icons': backendUrl,
      '/icon-manifest.json': backendUrl,
      '/avatar.png': backendUrl,
      '/favicon.svg': backendUrl,
    },
  },
})
