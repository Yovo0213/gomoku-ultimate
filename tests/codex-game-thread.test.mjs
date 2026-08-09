import { describe, expect, it, vi } from 'vitest';
import {
  CodexGameThreadClient,
  buildCodexGameArgs,
  buildGameEventContext,
  buildGameForkParams,
  buildGameTurnParams,
  GAME_PERMISSION_PROFILE,
} from '../server/codex-game-thread.mjs';

describe('当前 Codex 任务五子棋接入', () => {
  it('只给专用 App Server 接入五子棋工具箱', () => {
    const args = buildCodexGameArgs({
      nodeExecutable: '/usr/local/bin/node',
      mcpServerPath: '/game/gomoku-mcp-server.mjs',
      gameTurn: { turnId: 'gomoku-123', board: [] },
    });
    const joined = args.join('\n');

    expect(args.slice(0, 2)).toEqual(['app-server', '--stdio']);
    expect(joined).toContain('mcp_servers.luo-gomoku.command="/usr/local/bin/node"');
    expect(joined).toContain('mcp_servers.luo-gomoku.enabled_tools=["read_game","place_move"]');
    expect(joined).toContain('LUO_GOMOKU_TURN_JSON');
    expect(joined).toContain('features.shell_tool=false');
    expect(args).toContain('--strict-config');
    expect(joined).toContain('web_search="disabled"');
  });

  it('后台上下文保留精确回合且要求普通落子保持安静', () => {
    const context = buildGameEventContext({
      turnId: 'gomoku-123',
      player: 2,
      board: [[1, 0], [0, 0]],
      moves: [{ row: 0, col: 0, player: 1 }],
      candidates: [{ row: 0, col: 1 }],
    });

    expect(context).toContain('gomoku-123');
    expect(context).toContain('当前真实任务');
    expect(context).toContain('普通回合可以留空');
    expect(context).toContain('聊天区始终保持安静');
    expect(context).toContain('read_game 与 place_move');
  });

  it('后台回合使用独立的最小权限档案而不继承项目沙盒', () => {
    const turnParams = buildGameTurnParams('fork-thread-123', {
      turnId: 'gomoku-123',
      player: 2,
      board: [[1, 0], [0, 0]],
      moves: [{ row: 0, col: 0, player: 1 }],
      candidates: [{ row: 0, col: 1 }],
    });
    const forkParams = buildGameForkParams('source-thread-123', '/rollout/source.jsonl');

    expect(GAME_PERMISSION_PROFILE).toBe('gomoku-only');
    expect(forkParams.permissions).toBe('gomoku-only');
    expect(forkParams.approvalPolicy).toBe('never');
    expect(forkParams.ephemeral).toBe(true);
    expect(forkParams.runtimeWorkspaceRoots).toEqual([]);
    expect(turnParams).not.toHaveProperty('permissions');
    expect(turnParams).not.toHaveProperty('approvalPolicy');
    expect(turnParams.additionalContext['luo-gomoku-event'].kind).toBe('application');
  });

  it('只从明确 ready 的 MCP 结果捕获第一手合法落子', () => {
    const client = new CodexGameThreadClient({
      executable: 'codex',
      workspace: '/game',
      mcpServerPath: '/game/gomoku-mcp-server.mjs',
      codexHome: '/isolated/codex-home',
      rolloutPath: '/rollout/source.jsonl',
      gameTurn: { turnId: 'gomoku-123', board: [] },
    });
    const modelTurnId = 'model-turn-1';
    const channel = {
      resolve: vi.fn(),
      reject: vi.fn(),
      timer: setTimeout(() => {}, 60_000),
      output: '',
      move: null,
    };
    client.turns.set(modelTurnId, channel);
    const move = { turnId: 'gomoku-123', row: 7, col: 8, say: '' };
    const completedTool = ({
      result,
      error,
      arguments: rawArguments = move,
    } = {}) => JSON.stringify({
      method: 'item/completed',
      params: {
        turnId: modelTurnId,
        item: {
          type: 'mcpToolCall',
          server: 'luo-gomoku',
          tool: 'place_move',
          status: 'completed',
          arguments: rawArguments,
          ...(result === undefined ? {} : { result }),
          ...(error === undefined ? {} : { error }),
        },
      },
    });

    client.handleLine(completedTool({ result: { structuredContent: { move } } }));
    client.handleLine(completedTool({ result: { structuredContent: { status: 'failed', move } } }));
    client.handleLine(completedTool({ result: { isError: true, structuredContent: { status: 'ready', move } } }));
    client.handleLine(completedTool({
      result: { structuredContent: { status: 'ready', move } },
      error: { message: 'rejected' },
    }));
    expect(channel.move).toBeNull();

    client.handleLine(completedTool({
      arguments: { ...move, row: 1, col: 1 },
      result: { structuredContent: { status: 'ready', move } },
      error: null,
    }));
    expect(channel.move).toEqual(move);

    const laterMove = { ...move, row: 8, col: 8 };
    client.handleLine(completedTool({
      arguments: laterMove,
      result: { isError: true, structuredContent: { status: 'ready', move: laterMove } },
    }));
    client.handleLine(completedTool({
      arguments: laterMove,
      result: { structuredContent: { status: 'ready', move: laterMove } },
    }));
    expect(channel.move).toEqual(move);

    clearTimeout(channel.timer);
    client.turns.delete(modelTurnId);
  });

  it('stop 会立即拒绝并清空等待中的 RPC 与活动回合，再终止子进程', async () => {
    const client = new CodexGameThreadClient({
      executable: 'codex',
      workspace: '/game',
      mcpServerPath: '/game/gomoku-mcp-server.mjs',
      codexHome: '/isolated/codex-home',
      rolloutPath: '/rollout/source.jsonl',
      gameTurn: { turnId: 'gomoku-123', board: [] },
    });
    const child = { killed: false, kill: vi.fn() };
    client.child = child;
    client.forkThreads.set('source-thread', 'fork-thread');
    client.pendingMoves.set('model-turn-pending', { row: 1, col: 1 });

    let rejectRpc;
    const rpc = new Promise((resolve, reject) => { rejectRpc = reject; });
    const rpcTimer = setTimeout(() => {}, 60_000);
    client.pending.set(1, { resolve: vi.fn(), reject: rejectRpc, timer: rpcTimer });

    let rejectTurn;
    const turn = new Promise((resolve, reject) => { rejectTurn = reject; });
    const turnTimer = setTimeout(() => {}, 60_000);
    client.turns.set('model-turn-active', {
      resolve: vi.fn(),
      reject: rejectTurn,
      timer: turnTimer,
      output: '',
      move: null,
    });
    const rpcResult = rpc.catch(error => error);
    const turnResult = turn.catch(error => error);

    client.stop();

    const [rpcError, turnError] = await Promise.all([rpcResult, turnResult]);
    expect(rpcError).toBeInstanceOf(Error);
    expect(rpcError.message).toContain('已停止');
    expect(turnError).toBeInstanceOf(Error);
    expect(turnError.message).toContain('已停止');
    expect(client.pending.size).toBe(0);
    expect(client.turns.size).toBe(0);
    expect(client.forkThreads.size).toBe(0);
    expect(client.pendingMoves.size).toBe(0);
    expect(client.child).toBeNull();
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
