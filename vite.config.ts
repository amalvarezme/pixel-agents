import { defineConfig } from 'vite';

// Vite is already present transitively (Vitest's own dependency, confirmed in node_modules/
// package-lock.json before adding it here) and needs zero extra runtime dependencies to bundle
// pixi.js for the browser (browser-entrypoint work unit). The dev server proxies `/stream` and
// `/launch` (tasks.md 26.2) to the Node backend (`src/server.ts`, started separately by
// `npm run dev:server`) so the browser only ever talks to one origin.
const BACKEND_PORT = Number(process.env.PORT ?? 4317);

export default defineConfig({
  server: {
    host: '127.0.0.1',
    proxy: {
      '/stream': `http://127.0.0.1:${BACKEND_PORT}`,
      '/launch': `http://127.0.0.1:${BACKEND_PORT}`,
    },
  },
});
