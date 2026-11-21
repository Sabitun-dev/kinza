import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/app/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('../src/shared', import.meta.url)) },
  },
  build: {
    outDir: fileURLToPath(new URL('../public/app', import.meta.url)),
    emptyOutDir: true,
    target: 'es2019',
    cssTarget: 'chrome61',
    chunkSizeWarningLimit: 400,
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8888' },
  },
});
