import react from '@vitejs/plugin-react'
import { configDefaults, defineConfig } from 'vitest/config'

// whisper.cpp's WASM build uses pthreads, which need SharedArrayBuffer, which
// the browser only exposes to cross-origin-isolated documents. Production
// hosting must set these same two headers -- see README.
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  plugins: [react()],
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    exclude: [...configDefaults.exclude, 'tests/e2e/**'],
  },
})
