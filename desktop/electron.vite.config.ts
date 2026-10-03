import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { contentSecurityPolicy } from './csp'

const shared = { alias: { '@shared': resolve(__dirname, 'src/shared') } }

export default defineConfig({
  main: { resolve: shared },
  preload: { resolve: shared },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: shared,
    plugins: [react(), contentSecurityPolicy()],
    build: {
      minify: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          hud: resolve(__dirname, 'src/renderer/hud.html')
        }
      }
    }
  }
})
