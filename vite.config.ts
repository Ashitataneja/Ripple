/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative asset paths: the build works at any sub-path (e.g. GitHub Pages' /<repo>/) and in any
  // letter case. BASE_PATH can still force an absolute base for hosts that need one.
  base: process.env.BASE_PATH ? `${process.env.BASE_PATH.replace(/\/$/, '')}/` : './',
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
