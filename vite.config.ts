import { defineConfig } from 'vite';

// Relative base so the production build works from any static host or subpath.
export default defineConfig({
  base: './',
  build: { chunkSizeWarningLimit: 900 }, // three.js is ~600 kB minified
});
