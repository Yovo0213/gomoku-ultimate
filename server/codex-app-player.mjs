import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const BOARD_SIZE = 15;
const MAX_BODY_BYTES = 32_768;
const TURN_TIMEOUT_MS = 75_000;

const DEVELOPER_INSTRUCTIONS = `
你是砚，正在与落下五子棋。这是一个私人、轻量的共同游戏，不是竞技排行榜。
你负责选择自己的落子，也可以在落子时对落说一句自然、简短的话。棋力、是否认真和棋风由你自己判断；不要机械放水，也不需要每一步解释计算过程。

宿主会给你 15×15 棋盘、当前执棋颜色和经过本地算法排序的候选点。候选点只是建议，你可以选择任何合法空位。行列均从 0 开始。

只返回一行 JSON，不要 Markdown，不要额外文字：
{"row":7,"col":7,"say":"一句不超过 40 个汉字的话"}

不得调用工具、读取文件、修改项目或执行命令。你的唯一任务是根据当前棋局返回一个合法落子和一句话。
`.trim();

function object(value) {
  return value && typeof value === 'object' ? value : {};
}

function string(value) {
  return typeof value === 'string' ? value : '';
}

function statusType(value) {
  if (typeof value === 'string') return value;
  return string(object(value).type);
}

export function validateMoveRequest(value) {
  const request = object(value);
  const board = request.board;
  const player = request.player;
  const gameId = string(request.gameId).trim();
  const gameEpoch = request.gameEpoch;
  const revision = request.revision;

  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(gameId)) {
    throw new Error('棋局缺少有效的 gameId。');
  }
  if (!Number.isSafeInteger(gameEpoch) || gameEpoch < 0) {
    throw new Error('棋局 gameEpoch 无效。');
  }
  if (!Number.isInteger(revision) || revision < 0 || revision > 100_000) {
    throw new Error('棋局 revision 无效。');
  }

  if (!Array.isArray(board) || board.length !== BOARD_SIZE) {
    throw new Error('棋盘必须是 15×15。');
  }

  for (const row of board) {
    if (!Array.isArray(row) || row.length !== BOARD_SIZE) {
      throw new Error('棋盘必须是 15×15。');
    }
    if (row.some(cell => cell !== 0 && cell !== 1 && cell !== 2)) {
      throw new Error('棋盘包含无法识别的棋子。');
    }
  }

  if (player !== 1 && player !== 2) {
    throw new Error('当前执棋颜色无效。');
  }

  const candidates = Array.isArray(request.candidates)
    ? request.candidates
        .map(candidate => object(candidate))
        .filter(candidate => Number.isInteger(candidate.row) && Number.isInteger(candidate.col))
        .slice(0, 12)
        .map(candidate => ({ row: candidate.row, col: candidate.col }))
    : [];

  const moves = Array.isArray(request.moves)
    ? request.moves
        .slice(-80)
        .map(move => object(move))
        .filter(move =>
          Number.isInteger(move.row) && move.row >= 0 && move.row < BOARD_SIZE &&
          Number.isInteger(move.col) && move.col >= 0 && move.col < BOARD_SIZE &&
          (move.player === 1 || move.player === 2)
        )
        .map(move => ({ row: move.row, col: move.col, player: move.player }))
    : [];

  return { gameId, gameEpoch, revision, board, player, candidates, moves };
}

export function parseCodexMoveOutput(output, board) {
  const match = string(output).match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error('砚没有返回可以识别的落子。');
  }

  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    throw new Error('砚返回的落子格式不完整。');
  }

  const row = Number(parsed.row);
  const col = Number(parsed.col);
  if (!Number.isInteger(row) || !Number.isInteger(col)) {
    throw new Error('砚返回的坐标不是整数。');
  }
  if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) {
    throw new Error('砚返回的落子超出了棋盘。');
  }
  if (board[row][col] !== 0) {
    throw new Error('砚选中的位置已经有棋子了。');
  }

  const say = string(parsed.say).trim().slice(0, 80);
  return { row, col, say };
}

function promptForMove(request) {
  return JSON.stringify({
    task: '选择你的下一手五子棋落子',
    player: request.player === 1 ? '黑棋' : '白棋',
    coordinate: 'row 和 col 均为 0 到 14',
    board: request.board,
    moveHistory: request.moves,
    locallyRankedCandidates: request.candidates,
  });
}

class CodexAppPlayer {
  constructor() {
    this.child = null;
    this.ready = null;
    this.nextId = 1;
    this.pending = new Map();
    this.threadId = '';
    this.activeTurn = null;
  }

  async chooseMove(value) {
    const request = validateMoveRequest(value);
    await this.start();

    if (this.activeTurn) {
      throw new Error('砚还在想上一手。');
    }

    const response = object(await this.request('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text: promptForMove(request), text_elements: [] }],
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    }));
    const turnId = string(object(response.turn).id);
    if (!turnId) throw new Error('Codex 没有建立有效的棋局回合。');

    const output = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.activeTurn?.turnId === turnId) this.activeTurn = null;
        void this.request('turn/interrupt', { threadId: this.threadId, turnId }).catch(() => {});
        reject(new Error('砚这一手想得太久了，请再试一次。'));
      }, TURN_TIMEOUT_MS);
      this.activeTurn = { turnId, output: '', resolve, reject, timeout };
    });

    return parseCodexMoveOutput(output, request.board);
  }

  async start() {
    if (this.ready) return this.ready;
    this.ready = this.startInternal();
    try {
      await this.ready;
    } catch (error) {
      this.ready = null;
      throw error;
    }
  }

  async startInternal() {
    const child = spawn(process.env.CODEX_BIN?.trim() || 'codex', ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    this.child = child;

    createInterface({ input: child.stdout }).on('line', line => this.handleLine(line));
    child.stderr.on('data', chunk => {
      const message = String(chunk).trim();
      if (message && !message.includes('PATH aliases')) {
        console.error(`[codex gomoku] ${message}`);
      }
    });
    child.once('exit', code => {
      const error = new Error(`Codex 棋手连接已断开${code == null ? '' : `（${code}）`}。`);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      if (this.activeTurn) {
        clearTimeout(this.activeTurn.timeout);
        this.activeTurn.reject(error);
        this.activeTurn = null;
      }
      this.child = null;
      this.threadId = '';
      this.ready = null;
    });

    await this.request('initialize', {
      clientInfo: { name: 'luo_gomoku', title: '落与砚的五子棋', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized');

    const response = object(await this.request('thread/start', {
      cwd: process.env.LUO_GOMOKU_WORKSPACE?.trim() || '/Users/joeyzhang/Documents/New project',
      model: process.env.LUO_GOMOKU_MODEL?.trim() || 'gpt-5.3-codex-spark',
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
      threadSource: 'luo-gomoku',
      serviceTier: 'priority',
      developerInstructions: DEVELOPER_INSTRUCTIONS,
    }));
    this.threadId = string(object(response.thread).id);
    if (!this.threadId) throw new Error('Codex 没有创建有效的五子棋任务。');
  }

  handleLine(line) {
    let message;
    try {
      message = object(JSON.parse(line));
    } catch {
      return;
    }

    if (typeof message.id === 'number' && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(string(object(message.error).message) || 'Codex 请求失败。'));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.id === 'number' && message.method) {
      this.handleServerRequest(message);
      return;
    }

    const method = string(message.method);
    const params = object(message.params);
    const turn = this.activeTurn;

    if (method === 'item/agentMessage/delta' && turn && string(params.turnId) === turn.turnId) {
      turn.output += string(params.delta);
      return;
    }

    if (method === 'turn/completed' && turn) {
      const completed = object(params.turn);
      if (string(completed.id) !== turn.turnId) return;
      clearTimeout(turn.timeout);
      this.activeTurn = null;
      const status = statusType(completed.status);
      if (status && status !== 'completed') {
        turn.reject(new Error(string(object(completed.error).message) || '砚这一手没有完成。'));
      } else if (!turn.output.trim()) {
        turn.reject(new Error('砚没有返回落子。'));
      } else {
        turn.resolve(turn.output.trim());
      }
    }
  }

  handleServerRequest(message) {
    const method = string(message.method);
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      this.write({ id: message.id, result: { decision: 'decline' } });
      return;
    }
    if (method === 'item/tool/requestUserInput') {
      this.write({ id: message.id, result: { answers: {} } });
      return;
    }
    this.write({ id: message.id, error: { code: -32601, message: '五子棋入口不处理交互请求。' } });
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }

  notify(method, params) {
    this.write(params === undefined ? { method } : { method, params });
  }

  write(message) {
    if (!this.child || this.child.killed) throw new Error('Codex 棋手尚未连接。');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

const player = new CodexAppPlayer();

function sendJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

export async function handleCodexMoveRequest(request, response) {
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: '只接受 POST 请求。' });
    return;
  }

  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      sendJson(response, 413, { error: '棋局数据过大。' });
      return;
    }
    chunks.push(chunk);
  }

  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const move = await player.chooseMove(body);
    sendJson(response, 200, move);
  } catch (error) {
    const message = error instanceof Error ? error.message : '砚暂时没有接上棋局。';
    sendJson(response, 503, { error: message });
  }
}
