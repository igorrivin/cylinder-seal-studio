import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [react()],
  // The optional Three.js viewer is lazy-loaded into its own ~535 kB chunk.
  build: {
    chunkSizeWarningLimit: 550,
  },
  server: {
    port: 3000,
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
})
