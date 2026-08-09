import { Readable } from 'node:stream';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  getCurrentThreadTurnForTests,
  handleCurrentThreadGameRequest,
  initializeCurrentThreadGame,
  resetCurrentThreadGameForTests,
} from '../server/current-thread-game.mjs';

const emptyBoard = () => Array.from({ length: 15 }, () => Array(15).fill(0));
const GAME_A = '11111111-1111-4111-8111-111111111111';
const GAME_B = '22222222-2222-4222-8222-222222222222';

function game(value, revision = 1, gameId = GAME_A, gameEpoch = 1_000) {
  return { gameId, gameEpoch, revision, ...value };
}

function request(method, body, headers = {}) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  stream.method = method;
  stream.headers = method === 'POST'
    ? { 'content-type': 'application/json', host: '127.0.0.1:8082', ...headers }
    : headers;
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

async function call(path, method, body, headers) {
  const result = response();
  await handleCurrentThreadGameRequest(
    request(method, body, headers),
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

    const published = await call('/api/current-game/turn', 'POST', game({
      board,
      player: 2,
      moves: [{ row: 7, col: 7, player: 1 }],
      candidates: [{ row: 7, col: 8 }],
    }));

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
    const published = await call('/api/current-game/turn', 'POST', game({ board, player: 2 }));
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

    const repeated = await call(`/api/current-game/turn/${turnId}/move`, 'POST', {
      row: 7,
      col: 8,
      say: '网络重试不会重复落子。',
    });
    expect(repeated.status).toBe(200);

    const conflicting = await call(`/api/current-game/turn/${turnId}/move`, 'POST', {
      row: 6,
      col: 8,
    });
    expect(conflicting.status).toBe(409);
  });

  it('重复发布同一局面只建立一个等待回合', async () => {
    const board = emptyBoard();
    board[7][7] = 1;
    const first = await call('/api/current-game/turn', 'POST', game({ board, player: 2 }));
    const second = await call('/api/current-game/turn', 'POST', game({ board, player: 2 }));

    expect(second.body.turnId).toBe(first.body.turnId);
  });

  it('同一局面已经落子后重试仍返回原回合与原落子', async () => {
    const board = emptyBoard();
    board[7][7] = 1;
    const position = game({ board, player: 2 });
    const first = await call('/api/current-game/turn', 'POST', position);
    await call(`/api/current-game/turn/${first.body.turnId}/move`, 'POST', {
      row: 7,
      col: 8,
      say: '接住了。',
    });

    const retried = await call('/api/current-game/turn', 'POST', position);
    expect(retried.status).toBe(200);
    expect(retried.body.turnId).toBe(first.body.turnId);
    expect(retried.body.status).toBe('ready');
    expect(retried.body.move).toEqual({ row: 7, col: 8, say: '接住了。' });
  });

  it('并发发布新局面时不会把旧回合落子写进新回合', async () => {
    const firstBoard = emptyBoard();
    firstBoard[7][7] = 1;
    const first = await call('/api/current-game/turn', 'POST', game({
      board: firstBoard,
      player: 2,
    }, 1));

    const delayedRequest = new Readable({ read() {} });
    delayedRequest.method = 'POST';
    delayedRequest.headers = { 'content-type': 'application/json', host: '127.0.0.1:8082' };
    const delayedResponse = response();
    const oldMove = handleCurrentThreadGameRequest(
      delayedRequest,
      delayedResponse,
      new URL(`/api/current-game/turn/${first.body.turnId}/move`, 'http://127.0.0.1:8082'),
    );

    const secondBoard = emptyBoard();
    secondBoard[6][6] = 1;
    const second = await call('/api/current-game/turn', 'POST', game({
      board: secondBoard,
      player: 2,
    }, 2));
    delayedRequest.push(Buffer.from(JSON.stringify({ row: 7, col: 8, say: '旧回合。' })));
    delayedRequest.push(null);

    await oldMove;
    expect(delayedResponse.status).toBe(409);
    expect(second.body.turnId).not.toBe(first.body.turnId);

    const current = await call('/api/current-game/turn', 'GET');
    expect(current.body.turnId).toBe(second.body.turnId);
    expect(current.body.status).toBe('waiting');
    expect(current.body.move).toBeNull();
    expect(current.body.board[6][6]).toBe(1);
  });

  it('把等待回合原子保存在 SSD 状态文件并能在重启后恢复', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'luo-gomoku-state-'));
    const statePath = path.join(directory, 'game-state.json');
    await initializeCurrentThreadGame({ statePath });

    const board = emptyBoard();
    board[7][7] = 1;
    const published = await call('/api/current-game/turn', 'POST', game({ board, player: 2 }));
    expect(JSON.parse(await readFile(statePath, 'utf8')).currentTurn.id).toBe(published.body.turnId);

    resetCurrentThreadGameForTests();
    await initializeCurrentThreadGame({ statePath });
    const restored = await call('/api/current-game/turn', 'GET');
    expect(restored.status).toBe(200);
    expect(restored.body.turnId).toBe(published.body.turnId);
    expect(restored.body.board[7][7]).toBe(1);
  });

  it('新游戏即使开局相同也会建立新回合', async () => {
    const board = emptyBoard();
    board[7][7] = 1;
    const first = await call('/api/current-game/turn', 'POST', game({ board, player: 2 }, 1, GAME_A));
    await call(`/api/current-game/turn/${first.body.turnId}/move`, 'POST', { row: 7, col: 8 });

    const second = await call('/api/current-game/turn', 'POST', game({ board, player: 2 }, 1, GAME_B, 2_000));
    expect(second.status).toBe(202);
    expect(second.body.turnId).not.toBe(first.body.turnId);
    expect(second.body.status).toBe('waiting');
  });

  it('拒绝迟到的旧 revision 覆盖较新的棋盘版本', async () => {
    const board = emptyBoard();
    board[7][7] = 1;
    const current = await call('/api/current-game/turn', 'POST', game({ board, player: 2 }, 2));
    const stale = await call('/api/current-game/turn', 'POST', game({ board, player: 2 }, 1));

    expect(stale.status).toBe(409);
    const preserved = await call('/api/current-game/turn', 'GET');
    expect(preserved.body.turnId).toBe(current.body.turnId);
    expect(preserved.body.revision).toBe(2);
  });

  it('拒绝迟到的旧 gameEpoch 覆盖已经开始的新游戏', async () => {
    const newBoard = emptyBoard();
    newBoard[6][6] = 1;
    const current = await call('/api/current-game/turn', 'POST', game(
      { board: newBoard, player: 2 },
      1,
      GAME_B,
      2_000,
    ));
    const oldBoard = emptyBoard();
    oldBoard[7][7] = 1;
    const stale = await call('/api/current-game/turn', 'POST', game(
      { board: oldBoard, player: 2 },
      9,
      GAME_A,
      1_000,
    ));

    expect(stale.status).toBe(409);
    const preserved = await call('/api/current-game/turn', 'GET');
    expect(preserved.body.turnId).toBe(current.body.turnId);
    expect(preserved.body.board[6][6]).toBe(1);
    expect(preserved.body.board[7][7]).toBe(0);
  });

  it('拒绝跨站、错误内容类型和畸形回合编号', async () => {
    const board = emptyBoard();
    const crossSite = await call('/api/current-game/turn', 'POST', game({ board, player: 2 }), {
      origin: 'https://example.com',
      'sec-fetch-site': 'cross-site',
    });
    expect(crossSite.status).toBe(403);

    const rebound = await call('/api/current-game/turn', 'POST', game({ board, player: 2 }), {
      host: 'evil.example:8082',
      origin: 'http://evil.example:8082',
      'sec-fetch-site': 'same-origin',
    });
    expect(rebound.status).toBe(403);

    const wrongType = await call('/api/current-game/turn', 'POST', game({ board, player: 2 }), {
      'content-type': 'text/plain',
    });
    expect(wrongType.status).toBe(415);

    const malformed = await call('/api/current-game/turn/%', 'GET');
    expect(malformed.status).toBe(400);
  });

  it('检测器熔断后把失败交还棋盘，下一 revision 可以手动重试', async () => {
    const board = emptyBoard();
    board[7][7] = 1;
    const first = await call('/api/current-game/turn', 'POST', game({ board, player: 2 }, 1));
    const failed = await call(`/api/current-game/turn/${first.body.turnId}/fail`, 'POST', {
      error: '这一手暂时没有接住。',
    });
    expect(failed.status).toBe(200);
    expect(failed.body.status).toBe('failed');

    const lateMove = await call(`/api/current-game/turn/${first.body.turnId}/move`, 'POST', {
      row: 7,
      col: 8,
    });
    expect(lateMove.status).toBe(409);

    const polled = await call(`/api/current-game/turn/${first.body.turnId}`, 'GET');
    expect(polled.status).toBe(200);
    expect(polled.body.error).toContain('暂时没有接住');

    const retry = await call('/api/current-game/turn', 'POST', game({ board, player: 2 }, 2));
    expect(retry.status).toBe(202);
    expect(retry.body.turnId).not.toBe(first.body.turnId);
  });
});
