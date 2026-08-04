import { describe, expect, it } from 'vitest';
import { parseCodexMoveOutput, validateMoveRequest } from '../server/codex-app-player.mjs';

const emptyBoard = () => Array.from({ length: 15 }, () => Array(15).fill(0));

describe('Codex 棋手协议', () => {
  it('只接受完整的 15×15 棋盘', () => {
    expect(() => validateMoveRequest({ board: [[0]], player: 2 })).toThrow('15×15');
    expect(validateMoveRequest({ board: emptyBoard(), player: 2 }).player).toBe(2);
  });

  it('解析合法落子和短句', () => {
    expect(parseCodexMoveOutput('{"row":7,"col":8,"say":"这边。"}', emptyBoard()))
      .toEqual({ row: 7, col: 8, say: '这边。' });
  });

  it('拒绝已经有棋子的坐标', () => {
    const board = emptyBoard();
    board[7][8] = 1;
    expect(() => parseCodexMoveOutput('{"row":7,"col":8,"say":""}', board))
      .toThrow('已经有棋子');
  });
});
