import { defineConfig } from 'vite';

export default defineConfig({
  base: '/gpxtoprint/',
  server: {
    port: 3000,
    headers: {
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' https:; worker-src 'self' blob:; font-src 'self' https://cdn.jsdelivr.net https://unpkg.com data:;"
    }
  },
  build: { target: 'esnext' }
});
