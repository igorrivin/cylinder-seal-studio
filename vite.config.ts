import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import wasm from 'vite-plugin-wasm'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [wasm(), react()],
  // The optional Three.js viewer is lazy-loaded into its own ~535 kB chunk.
  build: {
    chunkSizeWarningLimit: 550,
  },
  server: {
    port: 3000,
  },
  worker: {
    format: 'es',
    plugins: () => [wasm()],
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  ssr: {
    // Keep the tracer inside Vite's pipeline so Vitest can transform its WASM import on Node 20.
    noExternal: ['vectortracer'],
  },
})
