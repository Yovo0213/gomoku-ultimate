import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createMcpHandler, runStdioMcp } from '../server/gomoku-mcp-server.mjs';

function request(id, method, params) {
  return { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
}

const emptyBoard = () => Array.from({ length: 15 }, () => Array(15).fill(0));

describe('五子棋 MCP 服务', () => {
  it('完成 initialize、ping 和工具枚举', async () => {
    const handler = createMcpHandler();

    const initialized = await handler(request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' },
    }));
    expect(initialized.result.protocolVersion).toBe('2025-06-18');
    expect(initialized.result.capabilities.tools).toEqual({ listChanged: false });

    const pinged = await handler(request('ping-1', 'ping'));
    expect(pinged).toEqual({ jsonrpc: '2.0', id: 'ping-1', result: {} });

    const listed = await handler(request(2, 'tools/list', {}));
    expect(listed.result.tools.map(tool => tool.name)).toEqual(['read_game', 'place_move']);
    expect(listed.result.tools[1].inputSchema.required).toEqual(['turnId', 'row', 'col']);
  });

  it('read_game 读取当前完整棋局', async () => {
    const board = emptyBoard();
    board[7][7] = 1;
    const game = { turnId: 'gomoku-1', status: 'waiting', player: 2, board };
    const handler = createMcpHandler({ gameTurn: game });

    const response = await handler(request(3, 'tools/call', {
      name: 'read_game',
      arguments: {},
    }));

    expect(response.result.isError).toBeUndefined();
    expect(response.result.structuredContent.board[7][7]).toBe(1);
    expect(JSON.parse(response.result.content[0].text)).toEqual(game);
  });

  it('place_move 校验参数并只向指定回合提交一次', async () => {
    const board = emptyBoard();
    const handler = createMcpHandler({
      gameTurn: { turnId: 'gomoku/one', status: 'waiting', player: 2, board },
    });

    const invalid = await handler(request(4, 'tools/call', {
      name: 'place_move',
      arguments: { turnId: 'gomoku/one', row: 15, col: 8 },
    }));
    expect(invalid.result.isError).toBe(true);
    expect(invalid.result.content[0].text).toContain('row');

    const placed = await handler(request(5, 'tools/call', {
      name: 'place_move',
      arguments: { turnId: 'gomoku/one', row: 7, col: 8, say: '这里。' },
    }));
    expect(placed.result.structuredContent.move).toEqual({
      turnId: 'gomoku/one',
      row: 7,
      col: 8,
      say: '这里。',
    });
  });

  it('拒绝旧回合和已经有棋子的坐标', async () => {
    const board = emptyBoard();
    board[1][2] = 1;
    const handler = createMcpHandler({
      gameTurn: { turnId: 'current', status: 'waiting', player: 2, board },
    });
    const stale = await handler(request(6, 'tools/call', {
      name: 'place_move',
      arguments: { turnId: 'old', row: 1, col: 2 },
    }));
    expect(stale.result.isError).toBe(true);
    expect(stale.result.content[0].text).toBe('这已经不是当前等待的那一手了。');

    const occupied = await handler(request(7, 'tools/call', {
      name: 'place_move',
      arguments: { turnId: 'current', row: 1, col: 2 },
    }));
    expect(occupied.result.isError).toBe(true);
    expect(occupied.result.content[0].text).toContain('已经有棋子');
  });

  it('使用 JSONL stdio 输出响应并报告坏 JSON', async () => {
    const input = Readable.from([
      '{bad json}\n',
      '{"jsonrpc":"2.0","id":8,"method":"ping"}\n',
      '{"jsonrpc":"2.0","method":"notifications/initialized"}\n',
    ]);
    const chunks = [];
    const output = {
      write(chunk) {
        chunks.push(String(chunk));
        return true;
      },
    };

    await runStdioMcp({
      input,
      output,
      handler: createMcpHandler(),
    });

    const responses = chunks.join('').trim().split('\n').map(line => JSON.parse(line));
    expect(responses).toHaveLength(2);
    expect(responses[0].error.code).toBe(-32700);
    expect(responses[0].id).toBeNull();
    expect(responses[1]).toEqual({ jsonrpc: '2.0', id: 8, result: {} });
  });
});
