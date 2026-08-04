import { defineConfig } from 'vite';
// The local Codex bridge is Node-only and intentionally excluded from the browser bundle.
// @ts-expect-error The bridge is a checked JavaScript module used by Vite middleware.
import { handleCodexMoveRequest } from './server/codex-app-player.mjs';

export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: 8082,
  },
  plugins: [
    {
      name: 'local-codex-gomoku-player',
      configureServer(server) {
        server.middlewares.use('/api/codex-move', (request, response) => {
          void handleCodexMoveRequest(request, response);
        });
      },
    },
  ],
  build: {
    outDir: 'dist',
    assetsInlineLimit: 0,
  },
});
