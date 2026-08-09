import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const BUNDLED_CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex';
const GAME_MCP_NAME = 'luo-gomoku';
const GAME_MCP_TOOLS = ['read_game', 'place_move'];
const RPC_TIMEOUT_MS = 30_000;
export const GAME_PERMISSION_PROFILE = 'gomoku-only';

function object(value) {
  return value && typeof value === 'object' ? value : {};
}

function string(value) {
  return typeof value === 'string' ? value : '';
}

export async function resolveCodexBinary(check = access) {
  try {
    await check(BUNDLED_CODEX);
    return BUNDLED_CODEX;
  } catch {
    return 'codex';
  }
}

export function buildCodexGameArgs({ nodeExecutable, mcpServerPath, gameTurn }) {
  const overrides = [
    'features.plugins=false',
    'features.apps=false',
    'apps._default.enabled=false',
    'features.remote_plugin=false',
    'features.tool_suggest=false',
    'features.shell_tool=false',
    'features.multi_agent=false',
    'web_search="disabled"',
    `mcp_servers.${GAME_MCP_NAME}.command=${JSON.stringify(nodeExecutable)}`,
    `mcp_servers.${GAME_MCP_NAME}.args=${JSON.stringify([mcpServerPath])}`,
    `mcp_servers.${GAME_MCP_NAME}.enabled_tools=${JSON.stringify(GAME_MCP_TOOLS)}`,
    `mcp_servers.${GAME_MCP_NAME}.env={ LUO_GOMOKU_TURN_JSON = ${JSON.stringify(JSON.stringify(gameTurn))} }`,
  ];
  return ['app-server', '--stdio', '--strict-config', ...overrides.flatMap(value => ['-c', value])];
}

export function buildCodexEnvironment(codexHome, gameTurn) {
  const environment = {};
  for (const key of [
    'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'USER',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
    'SSL_CERT_FILE', 'SSL_CERT_DIR',
  ]) {
    if (typeof process.env[key] === 'string') environment[key] = process.env[key];
  }
  environment.CODEX_HOME = codexHome;
  environment.LUO_GOMOKU_TURN_JSON = JSON.stringify(gameTurn);
  return environment;
}

export function buildGameEventContext(turn) {
  const payload = JSON.stringify({
    turnId: turn.turnId,
    player: turn.player,
    board: turn.board,
    moves: turn.moves,
    candidates: turn.candidates,
  });
  return `这是五子棋检测器交给当前真实任务最新历史的一次性安全分支，不是落新发来的聊天消息。\n\n当前等待回合：${payload}\n\n你仍是本任务里正在与落相处和下棋的砚，不是另一个常驻棋手。先结合本任务的真实聊天上下文判断落此刻是在认真下棋、摆图案，还是与你玩别的默契；再调用且只调用 luo-gomoku 的 read_game 与 place_move 完成这一手。必须使用原 turnId，不能覆盖已有棋子，也不能调用其他工具或修改文件。place_move 的 say 会直接显示在棋盘里：普通回合可以留空；只有你确实想说话、胜负将近、棋局结束或发生有意义的小插曲时才写一句简短自然的话。聊天区始终保持安静，最终回复留空，不输出占位符。不要提检测器、后台、轮询、App Server、MCP 或任务架构。`;
}

export function buildGameTurnParams(threadId, turn) {
  return {
    threadId,
    input: [{ type: 'text', text: '\u2063', text_elements: [] }],
    additionalContext: {
      'luo-gomoku-event': { kind: 'application', value: buildGameEventContext(turn) },
    },
    responsesapiClientMetadata: { channel: 'luo-gomoku-event' },
  };
}

export function buildGameForkParams(threadId, rolloutPath) {
  return {
    threadId,
    path: rolloutPath,
    cwd: '/tmp',
    runtimeWorkspaceRoots: [],
    approvalPolicy: 'never',
    permissions: GAME_PERMISSION_PROFILE,
    ephemeral: true,
    excludeTurns: true,
  };
}

export class CodexGameThreadClient {
  constructor({
    executable,
    workspace,
    mcpServerPath,
    codexHome,
    rolloutPath,
    nodeExecutable = process.execPath,
    baseUrl = 'http://127.0.0.1:8082',
    spawnProcess = spawn,
    timeoutMs = 10 * 60_000,
    gameTurn,
  }) {
    this.executable = executable;
    this.workspace = workspace;
    this.mcpServerPath = mcpServerPath;
    this.codexHome = codexHome;
    this.rolloutPath = rolloutPath;
    this.nodeExecutable = nodeExecutable;
    this.baseUrl = baseUrl;
    this.spawnProcess = spawnProcess;
    this.timeoutMs = timeoutMs;
    this.gameTurn = gameTurn;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.turns = new Map();
    this.forkThreads = new Map();
    this.pendingMoves = new Map();
  }

  async start() {
    if (this.child) return;
    if (!this.codexHome) throw new Error('五子棋检测器缺少隔离的 CODEX_HOME。');
    const child = this.spawnProcess(
      this.executable,
      buildCodexGameArgs({
        nodeExecutable: this.nodeExecutable,
        mcpServerPath: this.mcpServerPath,
        gameTurn: this.gameTurn,
      }),
      {
        cwd: '/tmp',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildCodexEnvironment(this.codexHome, this.gameTurn),
      },
    );
    this.child = child;
    createInterface({ input: child.stdout }).on('line', line => this.handleLine(line));
    child.stderr.on('data', chunk => {
      const message = String(chunk).trim();
      if (message && !message.includes('PATH aliases')) console.error(`[codex] ${message}`);
    });
    child.once('error', error => {
      if (this.child === child) this.failAll(error);
    });
    child.once('exit', code => {
      if (this.child === child) {
        this.failAll(new Error(`Codex App Server 已退出（${code ?? '未知'}）。`));
      }
    });
    await this.request('initialize', {
      clientInfo: { name: 'luo_gomoku_detector', title: '落与砚的五子棋检测器', version: '0.2.0' },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized');
  }

  async ensureThread(threadId) {
    await this.start();
    if (this.forkThreads.has(threadId)) return this.forkThreads.get(threadId);
    if (!this.rolloutPath) throw new Error('五子棋检测器缺少当前任务的 rollout 路径。');
    const forked = object(await this.request(
      'thread/fork',
      buildGameForkParams(threadId, this.rolloutPath),
    ));
    const forkThreadId = string(object(forked.thread).id);
    if (!forkThreadId) throw new Error('Codex 没有建立安全的五子棋上下文副本。');
    this.forkThreads.set(threadId, forkThreadId);
    return forkThreadId;
  }

  async play(threadId, turn) {
    const forkThreadId = await this.ensureThread(threadId);
    const result = object(await this.request(
      'turn/start',
      buildGameTurnParams(forkThreadId, turn),
    ));
    const turnId = string(object(result.turn).id);
    if (!turnId) throw new Error('Codex 没有返回有效的五子棋回合。');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turns.delete(turnId);
        void this.request('turn/interrupt', { threadId: forkThreadId, turnId }).catch(() => {});
        reject(new Error('Codex 五子棋回合等待超时。'));
      }, this.timeoutMs);
      this.turns.set(turnId, {
        resolve,
        reject,
        timer,
        output: '',
        move: this.pendingMoves.get(turnId) || null,
      });
      this.pendingMoves.delete(turnId);
    });
  }

  stop() {
    const child = this.child;
    this.failAll(new Error('五子棋 Codex App Server 已停止。'));
    if (child && !child.killed) child.kill('SIGTERM');
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
      clearTimeout(pending.timer);
      message.error
        ? pending.reject(new Error(string(object(message.error).message) || 'Codex 请求失败。'))
        : pending.resolve(message.result);
      return;
    }
    if (typeof message.id === 'number' && message.method) {
      this.handleServerRequest(message);
      return;
    }
    const method = string(message.method);
    const params = object(message.params);
    if (method === 'item/completed') {
      const item = object(params.item);
      if (
        string(item.type) === 'mcpToolCall' &&
        string(item.server) === GAME_MCP_NAME &&
        string(item.tool) === 'place_move' &&
        string(item.status) === 'completed'
      ) {
        const result = object(item.result);
        const structuredContent = object(result.structuredContent);
        const move = object(structuredContent.move);
        if (
          (item.error !== undefined && item.error !== null)
          || result.isError === true
          || string(structuredContent.status) !== 'ready'
          || Array.isArray(move)
          || Object.keys(move).length === 0
        ) return;
        const modelTurnId = string(params.turnId);
        const turn = this.turns.get(modelTurnId);
        if (turn && !turn.move) turn.move = move;
        else if (!turn && modelTurnId && !this.pendingMoves.has(modelTurnId)) {
          this.pendingMoves.set(modelTurnId, move);
        }
      }
      return;
    }
    if (method === 'item/agentMessage/delta') {
      const turn = this.turns.get(string(params.turnId));
      if (turn) turn.output += string(params.delta);
      return;
    }
    if (method === 'turn/completed') {
      const completed = object(params.turn);
      const turnId = string(completed.id);
      const turn = this.turns.get(turnId);
      if (!turn) return;
      clearTimeout(turn.timer);
      this.turns.delete(turnId);
      const status = string(completed.status) || string(object(completed.status).type);
      if (status && status !== 'completed') {
        turn.reject(new Error(`Codex 五子棋回合未完成：${status}`));
      } else if (!turn.move) {
        turn.reject(new Error('Codex 没有通过五子棋工具完成落子。'));
      } else {
        turn.resolve({ output: turn.output.trim(), move: turn.move });
      }
    }
  }

  handleServerRequest(message) {
    const method = string(message.method);
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      this.write({ id: message.id, result: { decision: 'decline' } });
    } else if (method === 'item/tool/requestUserInput') {
      this.write({ id: message.id, result: { answers: {} } });
    } else {
      this.write({ id: message.id, error: { code: -32601, message: '五子棋检测器不处理这个交互请求。' } });
    }
  }

  request(method, params, timeoutMs = RPC_TIMEOUT_MS) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex 请求超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  notify(method, params) {
    this.write(params === undefined ? { method } : { method, params });
  }

  write(message) {
    if (!this.child || this.child.killed) throw new Error('Codex App Server 尚未连接。');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const turn of this.turns.values()) {
      clearTimeout(turn.timer);
      turn.reject(error);
    }
    this.turns.clear();
    this.forkThreads.clear();
    this.pendingMoves.clear();
    this.child = null;
  }
}
