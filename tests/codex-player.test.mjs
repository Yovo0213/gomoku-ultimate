import { describe, expect, it } from 'vitest';
import { parseCodexMoveOutput, validateMoveRequest } from '../server/codex-app-player.mjs';

const emptyBoard = () => Array.from({ length: 15 }, () => Array(15).fill(0));
const request = overrides => ({
  gameId: '11111111-1111-4111-8111-111111111111',
  gameEpoch: 1_000,
  revision: 1,
  board: emptyBoard(),
  player: 2,
  ...overrides,
});

describe('Codex 棋手协议', () => {
  it('只接受完整的 15×15 棋盘', () => {
    expect(() => validateMoveRequest(request({ board: [[0]] }))).toThrow('15×15');
    expect(validateMoveRequest(request()).player).toBe(2);
  });

  it('要求稳定的 gameId、gameEpoch 与 revision', () => {
    expect(() => validateMoveRequest(request({ gameId: '' }))).toThrow('gameId');
    expect(() => validateMoveRequest(request({ gameEpoch: -1 }))).toThrow('gameEpoch');
    expect(() => validateMoveRequest(request({ revision: -1 }))).toThrow('revision');
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
