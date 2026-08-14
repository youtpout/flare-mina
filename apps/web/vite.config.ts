import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    host: true,
    // Mirrors what Caddy does in production, where /api is proxied to the
    // relayer on the same origin. Without it a relative VITE_API_URL calls the
    // dev server itself and 404s.
    proxy: {
      '/api': {
        target: process.env.VITE_RELAYER ?? 'http://127.0.0.1:8787',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  preview: { port: 4173, host: true },
});
