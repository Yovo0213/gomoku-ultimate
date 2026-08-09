import { describe, expect, it } from 'vitest';
import {
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
});
