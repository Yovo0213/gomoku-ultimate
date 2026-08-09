import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  handleCurrentThreadGameRequest,
  initializeCurrentThreadGame,
} from './server/current-thread-game.mjs';

const root = fileURLToPath(new URL('./dist/', import.meta.url));
const port = Number(process.env.LUO_GOMOKU_PORT || 8082);
const statePath = process.env.LUO_GOMOKU_STATE_PATH
  || fileURLToPath(new URL('./.runtime/game-state.json', import.meta.url));
const mime = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

await initializeCurrentThreadGame({ statePath });

async function serveRequest(request, response) {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
    if (url.pathname.startsWith('/api/current-game/')) {
      await handleCurrentThreadGameRequest(request, response, url);
      return;
    }

    const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const safePath = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, '');
    let filePath = join(root, safePath);

    try {
      if (!(await stat(filePath)).isFile()) throw new Error('not a file');
    } catch {
      filePath = join(root, 'index.html');
    }

    try {
      const body = await readFile(filePath);
      response.writeHead(200, {
        'content-type': mime[extname(filePath)] || 'application/octet-stream',
        'cache-control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=3600',
      });
      response.end(body);
    } catch {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('五子棋页面还没有构建。请先运行 npm run build。');
    }
  } catch (error) {
    console.error('[gomoku request]', error instanceof Error ? error.message : String(error));
    if (!response.headersSent) {
      response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    }
    if (!response.writableEnded) response.end(JSON.stringify({ error: '五子棋服务暂时没有接住这个请求。' }));
  }
}

function requestListener(request, response) {
  void serveRequest(request, response);
}

const server = createServer(requestListener);

server.listen(port, '127.0.0.1', () => {
  console.log(`落与砚的五子棋：http://127.0.0.1:${port}`);
});
