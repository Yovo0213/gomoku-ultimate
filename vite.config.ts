import { defineConfig } from 'vite';
// The current-thread bridge is Node-only and intentionally excluded from the browser bundle.
// @ts-expect-error The bridge is a checked JavaScript module used by Vite middleware.
import { handleCurrentThreadGameRequest } from './server/current-thread-game.mjs';

export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: 8082,
  },
  plugins: [
    {
      name: 'current-thread-gomoku-bridge',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
          if (url.pathname.startsWith('/api/current-game/')) {
            void handleCurrentThreadGameRequest(request, response, url);
            return;
          }
          next();
        });
      },
    },
  ],
  build: {
    outDir: 'dist',
    assetsInlineLimit: 0,
  },
});
