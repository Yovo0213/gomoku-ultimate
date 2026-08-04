import { Board } from '../core/Board';
import { Move, Player, Position } from '../core/types';
import { getSuggestions } from '../ai/search';

export interface CodexMove {
  position: Position;
  say: string;
}

interface MoveResponse {
  row?: unknown;
  col?: unknown;
  say?: unknown;
  error?: unknown;
}

export class CodexPlayer {
  private thinking = false;

  isThinking(): boolean {
    return this.thinking;
  }

  async computeMove(board: Board, player: Player, moves: Move[]): Promise<CodexMove> {
    this.thinking = true;

    try {
      const candidates = getSuggestions(board, player, 1, 12)
        .slice(0, 12)
        .map(({ row, col }) => ({ row, col }));
      const response = await fetch('/api/codex-move', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          board: board.toJSON(),
          player,
          moves: moves.map(({ row, col, player: movePlayer }) => ({
            row,
            col,
            player: movePlayer,
          })),
          candidates,
        }),
      });
      const body = await response.json() as MoveResponse;

      if (!response.ok) {
        throw new Error(typeof body.error === 'string' ? body.error : '砚暂时没有接上棋局。');
      }

      const row = Number(body.row);
      const col = Number(body.col);
      if (!Number.isInteger(row) || !Number.isInteger(col)) {
        throw new Error('砚返回的落子无法识别。');
      }
      if (row < 0 || row >= 15 || col < 0 || col >= 15 || !board.isEmpty(row, col)) {
        throw new Error('砚刚才选了一个不能落子的位置。');
      }

      return {
        position: { row, col },
        say: typeof body.say === 'string' ? body.say.trim().slice(0, 80) : '',
      };
    } finally {
      this.thinking = false;
    }
  }
}
