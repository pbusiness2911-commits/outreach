import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: 'client',
  plugins: [react(), tailwindcss()],
  build: { outDir: '../dist/client', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3100', '/u': 'http://localhost:3100', '/t': 'http://localhost:3100' },
  },
  test: { root: '.', include: ['tests/**/*.test.ts'], testTimeout: 30000 },
} as any);
