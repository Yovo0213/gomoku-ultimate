import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const JSONRPC_VERSION = '2.0';
const PROTOCOL_VERSION = '2025-06-18';
const BOARD_SIZE = 15;
const MAX_SAY_LENGTH = 80;

const TOOLS = [
  {
    name: 'read_game',
    title: '读取当前五子棋局',
    description: '读取落与砚当前等待处理的五子棋回合，包括棋盘、执棋方、候选点和回合编号。',
    inputSchema: {
      type: 'object',
      properties: {
        turnId: {
          type: 'string',
          description: '可选；若传入，必须与当前回合一致。',
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'place_move',
    title: '落下一颗棋子',
    description: '为指定的当前回合提交砚的下一手；行列坐标均从 0 开始。',
    inputSchema: {
      type: 'object',
      properties: {
        turnId: {
          type: 'string',
          minLength: 1,
          description: 'read_game 返回的 turnId。',
        },
        row: {
          type: 'integer',
          minimum: 0,
          maximum: BOARD_SIZE - 1,
          description: '棋盘行号，0 到 14。',
        },
        col: {
          type: 'integer',
          minimum: 0,
          maximum: BOARD_SIZE - 1,
          description: '棋盘列号，0 到 14。',
        },
        say: {
          type: 'string',
          maxLength: MAX_SAY_LENGTH,
          description: '可选的落子短句。',
        },
      },
      required: ['turnId', 'row', 'col'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rpcResult(id, result) {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

function rpcError(id, code, message) {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: { code, message },
  };
}

function textContent(value) {
  return [{ type: 'text', text: JSON.stringify(value) }];
}

function toolResult(value) {
  return {
    content: textContent(value),
    structuredContent: value,
  };
}

function toolError(message) {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}

function errorMessage(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function validatePlaceMoveArguments(value) {
  if (!isObject(value)) {
    throw new Error('place_move 的参数必须是对象。');
  }

  const allowed = new Set(['turnId', 'row', 'col', 'say']);
  if (Object.keys(value).some(key => !allowed.has(key))) {
    throw new Error('place_move 包含无法识别的参数。');
  }

  const turnId = typeof value.turnId === 'string' ? value.turnId.trim() : '';
  if (!turnId) {
    throw new Error('turnId 不能为空。');
  }
  if (turnId.length > 200) {
    throw new Error('turnId 过长。');
  }

  if (!Number.isInteger(value.row) || value.row < 0 || value.row >= BOARD_SIZE) {
    throw new Error('row 必须是 0 到 14 的整数。');
  }
  if (!Number.isInteger(value.col) || value.col < 0 || value.col >= BOARD_SIZE) {
    throw new Error('col 必须是 0 到 14 的整数。');
  }

  if (value.say !== undefined && typeof value.say !== 'string') {
    throw new Error('say 必须是字符串。');
  }
  const say = value.say ?? '';
  if (say.length > MAX_SAY_LENGTH) {
    throw new Error(`say 不能超过 ${MAX_SAY_LENGTH} 个字符。`);
  }

  return { turnId, row: value.row, col: value.col, say };
}

function validateReadGameArguments(value, turn) {
  if (value === undefined) return;
  if (!isObject(value) || Object.keys(value).some(key => key !== 'turnId')) {
    throw new Error('read_game 包含无法识别的参数。');
  }
  if (value.turnId !== undefined && value.turnId !== turn?.turnId) {
    throw new Error('这已经不是当前等待的那一手了。');
  }
}

function parseGameTurn(value) {
  let turn = value;
  if (typeof value === 'string') {
    if (!value.trim()) return null;
    try {
      turn = JSON.parse(value);
    } catch {
      throw new Error('五子棋回合环境数据无法识别。');
    }
  }
  if (!isObject(turn) || typeof turn.turnId !== 'string' || !turn.turnId) {
    return null;
  }
  if (!Array.isArray(turn.board) || turn.board.length !== BOARD_SIZE) {
    throw new Error('五子棋回合缺少完整棋盘。');
  }
  for (const row of turn.board) {
    if (!Array.isArray(row) || row.length !== BOARD_SIZE || row.some(cell => ![0, 1, 2].includes(cell))) {
      throw new Error('五子棋回合包含无效棋盘。');
    }
  }
  return JSON.parse(JSON.stringify(turn));
}

export function createMcpHandler({
  gameTurn = process.env.LUO_GOMOKU_TURN_JSON || '',
} = {}) {
  const turn = parseGameTurn(gameTurn);
  let acceptedMove = null;

  async function readGame(argumentsValue) {
    validateReadGameArguments(argumentsValue, turn);
    if (!turn) throw new Error('当前没有交给砚的五子棋回合。');
    return toolResult(turn);
  }

  async function placeMove(argumentsValue) {
    const move = validatePlaceMoveArguments(argumentsValue);
    if (!turn || move.turnId !== turn.turnId) {
      throw new Error('这已经不是当前等待的那一手了。');
    }
    if (turn.board[move.row][move.col] !== 0) {
      throw new Error('这个位置已经有棋子了。');
    }
    if (acceptedMove) {
      if (acceptedMove.row !== move.row || acceptedMove.col !== move.col) {
        throw new Error('这一手已经落在别处了。');
      }
      return toolResult({ turnId: turn.turnId, status: 'ready', move: acceptedMove });
    }
    acceptedMove = move;
    return toolResult({ turnId: turn.turnId, status: 'ready', move });
  }

  return async function handleMcpMessage(message) {
    if (!isObject(message) || message.jsonrpc !== JSONRPC_VERSION) {
      return rpcError(null, -32600, '无效的 JSON-RPC 请求。');
    }

    const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
    if (!hasId) return undefined;

    const id = message.id;
    if (id !== null && typeof id !== 'string' && typeof id !== 'number') {
      return rpcError(null, -32600, 'JSON-RPC id 必须是字符串、数字或 null。');
    }
    if (typeof message.method !== 'string' || !message.method) {
      return rpcError(id, -32600, 'JSON-RPC method 无效。');
    }

    if (message.method === 'initialize') {
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: 'luo-gomoku',
          title: '落与砚的五子棋',
          version: '1.0.0',
        },
        instructions: '先用 read_game 读取当前回合，再用同一个 turnId 调用 place_move。',
      });
    }

    if (message.method === 'ping') {
      return rpcResult(id, {});
    }

    if (message.method === 'tools/list') {
      return rpcResult(id, { tools: TOOLS });
    }

    if (message.method === 'tools/call') {
      const params = message.params;
      if (!isObject(params) || typeof params.name !== 'string') {
        return rpcError(id, -32602, 'tools/call 缺少有效的工具名称。');
      }

      try {
        if (params.name === 'read_game') {
          return rpcResult(id, await readGame(params.arguments));
        }
        if (params.name === 'place_move') {
          return rpcResult(id, await placeMove(params.arguments));
        }
        return rpcError(id, -32602, `未知工具：${params.name}`);
      } catch (error) {
        return rpcResult(id, toolError(errorMessage(error, '五子棋工具调用失败。')));
      }
    }

    return rpcError(id, -32601, `不支持的方法：${message.method}`);
  };
}

export async function runStdioMcp({
  input = process.stdin,
  output = process.stdout,
  handler = createMcpHandler(),
} = {}) {
  const lines = createInterface({ input, crlfDelay: Infinity });

  for await (const line of lines) {
    if (!line.trim()) continue;

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      output.write(`${JSON.stringify(rpcError(null, -32700, 'JSON 解析失败。'))}\n`);
      continue;
    }

    let response;
    try {
      response = await handler(message);
    } catch (error) {
      response = rpcError(
        isObject(message) && Object.prototype.hasOwnProperty.call(message, 'id') ? message.id : null,
        -32603,
        errorMessage(error, 'MCP 服务内部错误。'),
      );
    }

    if (response !== undefined) {
      output.write(`${JSON.stringify(response)}\n`);
    }
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runStdioMcp().catch(error => {
    process.stderr.write(`[luo-gomoku-mcp] ${errorMessage(error, '服务异常退出。')}\n`);
    process.exitCode = 1;
  });
}
