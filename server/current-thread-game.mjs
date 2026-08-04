import { parseCodexMoveOutput, validateMoveRequest } from './codex-app-player.mjs';

const MAX_BODY_BYTES = 32_768;
const TURN_TTL_MS = 30 * 60 * 1000;

let turnSequence = 0;
let currentTurn = null;

function sendJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('棋局数据过大。');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new Error('棋局数据格式无法识别。');
  }
}

function publicTurn(turn, includeBoard = false) {
  const base = {
    turnId: turn.id,
    status: turn.status,
    player: turn.player,
    moves: turn.moves,
    candidates: turn.candidates,
    createdAt: turn.createdAt,
    move: turn.move,
  };
  return includeBoard ? { ...base, board: turn.board } : base;
}

function expireOldTurn() {
  if (currentTurn && Date.now() - currentTurn.createdAt > TURN_TTL_MS) {
    currentTurn = null;
  }
}

export function resetCurrentThreadGameForTests() {
  turnSequence = 0;
  currentTurn = null;
}

export function getCurrentThreadTurnForTests() {
  return currentTurn;
}

export async function handleCurrentThreadGameRequest(request, response, url) {
  expireOldTurn();

  if (url.pathname === '/api/current-game/turn' && request.method === 'POST') {
    try {
      const game = validateMoveRequest(await readJson(request));
      currentTurn = {
        id: `gomoku-${Date.now()}-${++turnSequence}`,
        ...game,
        status: 'waiting',
        move: null,
        createdAt: Date.now(),
      };
      sendJson(response, 202, publicTurn(currentTurn));
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : '棋局无法识别。' });
    }
    return;
  }

  if (url.pathname === '/api/current-game/turn' && request.method === 'GET') {
    if (!currentTurn) {
      sendJson(response, 404, { error: '当前没有等待砚的棋局。' });
      return;
    }
    sendJson(response, 200, publicTurn(currentTurn, true));
    return;
  }

  const match = url.pathname.match(/^\/api\/current-game\/turn\/([^/]+)(?:\/move)?$/);
  if (!match) {
    sendJson(response, 404, { error: '找不到这个棋局接口。' });
    return;
  }

  const turnId = decodeURIComponent(match[1]);
  if (!currentTurn || currentTurn.id !== turnId) {
    sendJson(response, 409, { error: '这已经不是当前等待的那一手了。' });
    return;
  }

  if (url.pathname.endsWith('/move') && request.method === 'POST') {
    if (currentTurn.status === 'ready') {
      sendJson(response, 409, { error: '这一手已经回到棋盘了。' });
      return;
    }
    try {
      const body = await readJson(request);
      currentTurn.move = parseCodexMoveOutput(JSON.stringify(body), currentTurn.board);
      currentTurn.status = 'ready';
      sendJson(response, 200, publicTurn(currentTurn));
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : '落子无法识别。' });
    }
    return;
  }

  if (request.method === 'GET') {
    sendJson(response, currentTurn.status === 'ready' ? 200 : 202, publicTurn(currentTurn));
    return;
  }

  sendJson(response, 405, { error: '这个棋局接口不支持该操作。' });
}
