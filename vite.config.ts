/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // GitHub Pages serves project sites under /<repo>/; the deploy workflow sets BASE_PATH.
  base: process.env.BASE_PATH ? `${process.env.BASE_PATH.replace(/\/$/, '')}/` : '/',
  plugins: [react()],
  server: { host: 'localhost', port: 5173 },
  // The hand-tracking worker is a module worker (it lazy-loads MediaPipe).
  worker: { format: 'es' },
  build: {
    target: 'es2021',
    chunkSizeWarningLimit: 1200,
  },
  test: {
    environment: 'node',
    include: ['src/tests/**/*.test.ts'],
  },
});
