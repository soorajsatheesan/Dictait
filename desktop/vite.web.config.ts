// Renders the UI in a normal browser with a simulated bridge, for fast design iteration.
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  plugins: [react()],
  server: { port: 5199, strictPort: true }
})
