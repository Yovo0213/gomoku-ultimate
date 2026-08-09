import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseCodexMoveOutput, validateMoveRequest } from './codex-app-player.mjs';

const MAX_BODY_BYTES = 32_768;
const BODY_TIMEOUT_MS = 5_000;
const TURN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const NEW_TURN_LIMIT = 12;
const NEW_TURN_WINDOW_MS = 60_000;

let currentTurn = null;
let statePath = '';
let requestQueue = Promise.resolve();
let newTurnTimestamps = [];

function sendJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function clientError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function validateMutationHeaders(request) {
  const contentType = String(request.headers?.['content-type'] || '');
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw clientError('棋局接口只接受 application/json。', 415);
  }
  const fetchSite = String(request.headers?.['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    throw clientError('棋局接口拒绝跨站请求。', 403);
  }
  const localPort = Number(request.socket?.localPort || process.env.LUO_GOMOKU_PORT || 8082);
  const allowedHosts = new Set([
    `127.0.0.1:${localPort}`,
    `localhost:${localPort}`,
    `[::1]:${localPort}`,
  ]);
  const host = String(request.headers?.host || '').toLowerCase();
  if (!allowedHosts.has(host)) {
    throw clientError('棋局接口拒绝不匹配的主机。', 403);
  }
  const origin = String(request.headers?.origin || '').toLowerCase();
  const allowedOrigins = new Set([...allowedHosts].map(value => `http://${value}`));
  if (origin && !allowedOrigins.has(origin)) {
    throw clientError('棋局接口拒绝不匹配的来源。', 403);
  }
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      error ? reject(error) : resolve(value);
    };
    const onData = chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish(clientError('棋局数据过大。', 413));
        request.destroy?.();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      try {
        finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        finish(clientError('棋局数据格式无法识别。'));
      }
    };
    const onError = error => finish(error);
    const timer = setTimeout(() => {
      finish(clientError('棋局请求体等待超时。', 408));
      request.destroy?.();
    }, BODY_TIMEOUT_MS);
    request.on('data', onData);
    request.on('end', onEnd);
    request.on('error', onError);
  });
}

function publicTurn(turn, includeBoard = false) {
  const base = {
    turnId: turn.id,
    gameId: turn.gameId,
    gameEpoch: turn.gameEpoch,
    revision: turn.revision,
    status: turn.status,
    player: turn.player,
    moves: turn.moves,
    candidates: turn.candidates,
    createdAt: turn.createdAt,
    move: turn.move,
    error: turn.error || null,
  };
  return includeBoard ? { ...base, board: turn.board } : base;
}

async function persistCurrentTurn() {
  if (!statePath) return;
  await mkdir(dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ currentTurn }, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, statePath);
}

function fingerprint(game) {
  return createHash('sha256').update(JSON.stringify({
    board: game.board,
    player: game.player,
    moves: game.moves,
    candidates: game.candidates,
  })).digest('hex');
}

async function expireOldTurn() {
  if (currentTurn && Date.now() - currentTurn.createdAt > TURN_TTL_MS) {
    currentTurn = null;
    await persistCurrentTurn();
  }
}

function withCurrentTurnLock(operation) {
  const result = requestQueue.then(operation, operation);
  requestQueue = result.catch(() => {});
  return result;
}

function recordNewTurn(now = Date.now()) {
  newTurnTimestamps = newTurnTimestamps.filter(timestamp => now - timestamp < NEW_TURN_WINDOW_MS);
  if (newTurnTimestamps.length >= NEW_TURN_LIMIT) {
    throw clientError('新棋局请求太频繁，请稍后再试。', 429);
  }
  newTurnTimestamps.push(now);
}

function decodeTurnId(raw) {
  let turnId;
  try {
    turnId = decodeURIComponent(raw);
  } catch {
    throw clientError('回合编号格式无法识别。');
  }
  if (!/^gomoku-\d{10,16}-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(turnId)) {
    throw clientError('回合编号格式无法识别。');
  }
  return turnId;
}

export async function initializeCurrentThreadGame(options = {}) {
  statePath = options.statePath || process.env.LUO_GOMOKU_STATE_PATH || '';
  if (!statePath) return;
  try {
    const stored = JSON.parse(await readFile(statePath, 'utf8'));
    const turn = stored?.currentTurn;
    if (turn && typeof turn.id === 'string' && Number.isFinite(turn.createdAt)) {
      currentTurn = turn;
      await expireOldTurn();
    }
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.name !== 'SyntaxError') throw error;
  }
}

export function resetCurrentThreadGameForTests() {
  currentTurn = null;
  statePath = '';
  requestQueue = Promise.resolve();
  newTurnTimestamps = [];
}

export function getCurrentThreadTurnForTests() {
  return currentTurn;
}

export async function handleCurrentThreadGameRequest(request, response, url) {
  if (url.pathname === '/api/current-game/turn' && request.method === 'POST') {
    let game;
    try {
      validateMutationHeaders(request);
      game = validateMoveRequest(await readJson(request));
    } catch (error) {
      sendJson(response, Number(error?.status) || 400, {
        error: error instanceof Error ? error.message : '棋局无法识别。',
      });
      return;
    }
    return withCurrentTurnLock(async () => {
      await expireOldTurn();
      const requestFingerprint = fingerprint(game);
      if (currentTurn) {
        if (currentTurn.gameId === game.gameId) {
          if (currentTurn.gameEpoch !== game.gameEpoch) {
            sendJson(response, 409, { error: '同一棋局收到了不一致的世代编号。' });
            return;
          }
          if (game.revision < currentTurn.revision) {
            sendJson(response, 409, { error: '这个棋盘版本已经过期。' });
            return;
          }
          if (game.revision === currentTurn.revision) {
            if (currentTurn.fingerprint !== requestFingerprint) {
              sendJson(response, 409, { error: '同一棋盘版本收到了不一致的数据。' });
              return;
            }
            sendJson(response, currentTurn.status === 'waiting' ? 202 : 200, publicTurn(currentTurn));
            return;
          }
        } else if (game.gameEpoch <= Number(currentTurn.gameEpoch || 0)) {
          sendJson(response, 409, { error: '这已经不是当前棋局了。' });
          return;
        }
      }
      try {
        recordNewTurn();
      } catch (error) {
        sendJson(response, Number(error?.status) || 429, { error: error.message });
        return;
      }
      currentTurn = {
        id: `gomoku-${Date.now()}-${randomUUID()}`,
        ...game,
        fingerprint: requestFingerprint,
        status: 'waiting',
        move: null,
        error: null,
        createdAt: Date.now(),
      };
      await persistCurrentTurn();
      sendJson(response, 202, publicTurn(currentTurn));
    });
  }

  if (url.pathname === '/api/current-game/turn' && request.method === 'GET') {
    return withCurrentTurnLock(async () => {
      await expireOldTurn();
      if (!currentTurn) {
        sendJson(response, 404, { error: '当前没有等待砚的棋局。' });
        return;
      }
      sendJson(response, 200, publicTurn(currentTurn, true));
    });
  }

  const match = url.pathname.match(/^\/api\/current-game\/turn\/([^/]+)(?:\/(move|fail))?$/);
  if (!match) {
    sendJson(response, 404, { error: '找不到这个棋局接口。' });
    return;
  }

  let turnId;
  try {
    turnId = decodeTurnId(match[1]);
  } catch (error) {
    sendJson(response, Number(error?.status) || 400, { error: error.message });
    return;
  }

  if (match[2] === 'move' && request.method === 'POST') {
    let body;
    try {
      validateMutationHeaders(request);
      body = await readJson(request);
    } catch (error) {
      sendJson(response, Number(error?.status) || 400, {
        error: error instanceof Error ? error.message : '落子无法识别。',
      });
      return;
    }
    return withCurrentTurnLock(async () => {
      await expireOldTurn();
      if (!currentTurn || currentTurn.id !== turnId) {
        sendJson(response, 409, { error: '这已经不是当前等待的那一手了。' });
        return;
      }
      if (currentTurn.status === 'ready') {
        if (Number(body.row) === currentTurn.move?.row && Number(body.col) === currentTurn.move?.col) {
          sendJson(response, 200, publicTurn(currentTurn));
        } else {
          sendJson(response, 409, { error: '这一手已经由砚落在别处了。' });
        }
        return;
      }
      if (currentTurn.status !== 'waiting') {
        sendJson(response, 409, { error: '这一手已经失败，请从棋盘重新尝试。' });
        return;
      }
      try {
        const move = parseCodexMoveOutput(JSON.stringify(body), currentTurn.board);
        currentTurn = { ...currentTurn, move, status: 'ready' };
        await persistCurrentTurn();
        sendJson(response, 200, publicTurn(currentTurn));
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : '落子无法识别。' });
      }
    });
  }

  if (match[2] === 'fail' && request.method === 'POST') {
    let body;
    try {
      validateMutationHeaders(request);
      body = await readJson(request);
    } catch (error) {
      sendJson(response, Number(error?.status) || 400, { error: error.message });
      return;
    }
    return withCurrentTurnLock(async () => {
      await expireOldTurn();
      if (!currentTurn || currentTurn.id !== turnId) {
        sendJson(response, 409, { error: '这已经不是当前等待的那一手了。' });
        return;
      }
      if (currentTurn.status === 'ready') {
        sendJson(response, 409, { error: '这一手已经落下，不能再标记失败。' });
        return;
      }
      const message = typeof body.error === 'string'
        ? body.error.trim().slice(0, 160)
        : '砚暂时没有接住这一手。';
      currentTurn = { ...currentTurn, status: 'failed', error: message, move: null };
      await persistCurrentTurn();
      sendJson(response, 200, publicTurn(currentTurn));
    });
  }

  if (request.method === 'GET') {
    return withCurrentTurnLock(async () => {
      await expireOldTurn();
      if (!currentTurn || currentTurn.id !== turnId) {
        sendJson(response, 409, { error: '这已经不是当前等待的那一手了。' });
        return;
      }
      sendJson(response, currentTurn.status === 'waiting' ? 202 : 200, publicTurn(currentTurn));
    });
  }

  sendJson(response, 405, { error: '这个棋局接口不支持该操作。' });
}
