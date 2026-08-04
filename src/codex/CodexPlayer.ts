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

interface TurnResponse extends MoveResponse {
  turnId?: unknown;
  status?: unknown;
  move?: MoveResponse | null;
}

const POLL_INTERVAL_MS = 900;
const WAIT_TIMEOUT_MS = 10 * 60 * 1000;

function pause(milliseconds: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, milliseconds));
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
      const response = await fetch('/api/current-game/turn', {
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
      const body = await response.json() as TurnResponse;

      if (!response.ok) {
        throw new Error(typeof body.error === 'string' ? body.error : '棋盘暂时没有接上当前任务。');
      }

      const turnId = typeof body.turnId === 'string' ? body.turnId : '';
      if (!turnId) throw new Error('棋盘没有建立有效的待处理回合。');

      const startedAt = Date.now();
      let move: MoveResponse | null = null;
      while (Date.now() - startedAt < WAIT_TIMEOUT_MS) {
        await pause(POLL_INTERVAL_MS);
        const turnResponse = await fetch(`/api/current-game/turn/${encodeURIComponent(turnId)}`);
        const turn = await turnResponse.json() as TurnResponse;
        if (turnResponse.status === 202) continue;
        if (!turnResponse.ok) {
          throw new Error(typeof turn.error === 'string' ? turn.error : '当前任务没有接住这一手。');
        }
        move = turn.move && typeof turn.move === 'object' ? turn.move : null;
        break;
      }

      if (!move) throw new Error('这一手等得太久了，可以再让我想一次。');

      const row = Number(move.row);
      const col = Number(move.col);
      if (!Number.isInteger(row) || !Number.isInteger(col)) {
        throw new Error('砚返回的落子无法识别。');
      }
      if (row < 0 || row >= 15 || col < 0 || col >= 15 || !board.isEmpty(row, col)) {
        throw new Error('砚刚才选了一个不能落子的位置。');
      }

      return {
        position: { row, col },
        say: typeof move.say === 'string' ? move.say.trim().slice(0, 80) : '',
      };
    } finally {
      this.thinking = false;
    }
  }
}
