import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  getCurrentThreadTurnForTests,
  handleCurrentThreadGameRequest,
  resetCurrentThreadGameForTests,
} from '../server/current-thread-game.mjs';

const emptyBoard = () => Array.from({ length: 15 }, () => Array(15).fill(0));

function request(method, body) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  stream.method = method;
  return stream;
}

function response() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body = '') {
      this.body = String(body);
    },
  };
}

async function call(path, method, body) {
  const result = response();
  await handleCurrentThreadGameRequest(
    request(method, body),
    result,
    new URL(path, 'http://127.0.0.1:8082'),
  );
  return { status: result.status, body: JSON.parse(result.body) };
}

beforeEach(() => resetCurrentThreadGameForTests());

describe('当前 Codex 任务棋局桥', () => {
  it('发布局面后可以由当前任务读取', async () => {
    const board = emptyBoard();
    board[7][7] = 1;

    const published = await call('/api/current-game/turn', 'POST', {
      board,
      player: 2,
      moves: [{ row: 7, col: 7, player: 1 }],
      candidates: [{ row: 7, col: 8 }],
    });

    expect(published.status).toBe(202);
    expect(published.body.turnId).toMatch(/^gomoku-/);
    expect(getCurrentThreadTurnForTests().board[7][7]).toBe(1);

    const current = await call('/api/current-game/turn', 'GET');
    expect(current.status).toBe(200);
    expect(current.body.status).toBe('waiting');
    expect(current.body.board[7][7]).toBe(1);
  });

  it('接受当前任务的合法落子并拒绝覆盖已有棋子', async () => {
    const board = emptyBoard();
    board[7][7] = 1;
    const published = await call('/api/current-game/turn', 'POST', { board, player: 2 });
    const turnId = published.body.turnId;

    const invalid = await call(`/api/current-game/turn/${turnId}/move`, 'POST', {
      row: 7,
      col: 7,
      say: '不能落在这里。',
    });
    expect(invalid.status).toBe(400);

    const placed = await call(`/api/current-game/turn/${turnId}/move`, 'POST', {
      row: 7,
      col: 8,
      say: '这次是我亲自下的。',
    });
    expect(placed.status).toBe(200);
    expect(placed.body.move).toEqual({ row: 7, col: 8, say: '这次是我亲自下的。' });

    const ready = await call(`/api/current-game/turn/${turnId}`, 'GET');
    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe('ready');
  });
});
