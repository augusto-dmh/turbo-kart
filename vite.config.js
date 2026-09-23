import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 4096,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
});
