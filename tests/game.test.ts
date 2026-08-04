import { afterEach, describe, expect, it, vi } from 'vitest';
import { Game } from '../src/core/Game';
import { BLACK, WHITE, type GameConfig } from '../src/core/types';
import { UIManager } from '../src/ui/UIManager';

const config: GameConfig = {
  mode: 'pvp',
  difficulty: 2,
  aiPlayer: WHITE,
  timeLimit: 10,
};

const games: Game[] = [];

function startGame(timeLimit = config.timeLimit): Game {
  const game = new Game({ ...config, timeLimit });
  games.push(game);
  game.start();
  return game;
}

afterEach(() => {
  games.splice(0).forEach((game) => game.destroy());
  vi.useRealTimers();
});

describe('计时规则', () => {
  it('只扣除当前执棋方的剩余时间', () => {
    vi.useFakeTimers();
    const game = startGame();

    expect(game.consumeCurrentPlayerTime(2.5)).toBe(false);
    expect(game.blackTime).toBe(7.5);
    expect(game.whiteTime).toBe(10);

    expect(game.makeMove(7, 7)).toBe(true);
    expect(game.currentPlayer).toBe(WHITE);
    expect(game.consumeCurrentPlayerTime(1.25)).toBe(false);
    expect(game.blackTime).toBe(7.5);
    expect(game.whiteTime).toBe(8.75);
  });

  it('当前方时间耗尽时，判定对手获胜并拒绝后续落子', () => {
    vi.useFakeTimers();
    const game = startGame(1);

    expect(game.consumeCurrentPlayerTime(1)).toBe(true);
    expect(game.status).toBe('over');
    expect(game.winner).toBe(WHITE);
    expect(game.blackTime).toBe(0);
    expect(game.makeMove(7, 7)).toBe(false);
  });

  it('无限时模式不改变时钟或对局状态', () => {
    vi.useFakeTimers();
    const game = startGame(0);

    expect(game.consumeCurrentPlayerTime(60)).toBe(false);
    expect(game.status).toBe('playing');
    expect(game.currentPlayer).toBe(BLACK);
    expect(game.blackTime).toBe(0);
  });
});

describe('异步 AI 落子', () => {
  it('Codex 连接失败时保留棋局并显示重试入口', async () => {
    const game = startGame(0);
    expect(game.makeMove(7, 7)).toBe(true);

    const ui = Object.create(UIManager.prototype) as UIManager;
    const thinkingIndicator = { classList: { add: vi.fn(), remove: vi.fn() } };
    const retryCodexBtn = { classList: { add: vi.fn(), remove: vi.fn() } };
    const codexMessageEl = { textContent: '' };

    Object.assign(ui as object, {
      codex: { computeMove: vi.fn().mockRejectedValue(new Error('连接已断开')) },
      game,
      currentDifficulty: 3,
      retryCodexBtn,
      codexMessageEl,
      container: { querySelector: vi.fn(() => thinkingIndicator) },
    });

    await (ui as any).triggerAIMove();

    expect(game.board.moveCount).toBe(1);
    expect(game.currentPlayer).toBe(WHITE);
    expect(codexMessageEl.textContent).toContain('这手还没有落下');
    expect(retryCodexBtn.classList.remove).toHaveBeenCalledWith('hidden');
  });

  it('重开或换边后拒绝旧棋局的计算结果', async () => {
    let resolveMove!: (move: { position: { row: number; col: number }; say: string }) => void;
    const oldGame = startGame(0);
    const newGame = startGame(0);

    expect(oldGame.makeMove(7, 7)).toBe(true);
    expect(newGame.makeMove(7, 7)).toBe(true);

    const ui = Object.create(UIManager.prototype) as UIManager;
    const thinkingIndicator = { classList: { add: vi.fn(), remove: vi.fn() } };
    const codex = {
      computeMove: vi.fn(() => new Promise<{ position: { row: number; col: number }; say: string }>((resolve) => {
        resolveMove = resolve;
      })),
    };

    Object.assign(ui as object, {
      codex,
      game: oldGame,
      currentDifficulty: 3,
      retryCodexBtn: { classList: { add: vi.fn(), remove: vi.fn() } },
      container: { querySelector: vi.fn(() => thinkingIndicator) },
    });

    const pendingMove = (ui as any).triggerAIMove();
    (ui as any).game = newGame;
    resolveMove({ position: { row: 7, col: 8 }, say: '这一手。' });
    await pendingMove;

    expect(newGame.board.moveCount).toBe(1);
    expect(newGame.board.getCell(7, 8)).toBe(0);
  });
});
