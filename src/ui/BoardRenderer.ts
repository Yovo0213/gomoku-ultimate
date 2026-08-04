import { BOARD_SIZE, Position, Player, BLACK, WHITE, EMPTY } from '../core/types';
import { Board } from '../core/Board';
import { Game } from '../core/Game';
import { Suggestion } from '../ai/search';

export interface ThemeColors {
  boardBg: string;
  boardBgEnd: string;
  gridLine: string;
  starPoint: string;
  blackStone: string;
  blackStoneHighlight: string;
  blackStoneShadow: string;
  whiteStone: string;
  whiteStoneHighlight: string;
  whiteStoneShadow: string;
  lastMoveMarker: string;
  winLine: string;
  winGlow: string;
  labelColor: string;
  coordinateColor: string;
}

const LIGHT_THEME: ThemeColors = {
  boardBg: '#c9dfe1',
  boardBgEnd: '#b9d2d5',
  gridLine: '#66858d',
  starPoint: '#587a82',
  blackStone: '#26363d',
  blackStoneHighlight: '#60737a',
  blackStoneShadow: '#10191c',
  whiteStone: '#f5f9f9',
  whiteStoneHighlight: '#ffffff',
  whiteStoneShadow: '#b7c9cc',
  lastMoveMarker: '#bd7f8b',
  winLine: '#ad6f7b',
  winGlow: 'rgba(173, 111, 123, 0.24)',
  labelColor: '#587a82',
  coordinateColor: '#66858d',
};

const DARK_THEME: ThemeColors = {
  boardBg: '#2d2416',
  boardBgEnd: '#3d2e1a',
  gridLine: '#8a7a5a',
  starPoint: '#8a7a5a',
  blackStone: '#1a1a1a',
  blackStoneHighlight: '#444444',
  blackStoneShadow: '#000000',
  whiteStone: '#f0f0f0',
  whiteStoneHighlight: '#ffffff',
  whiteStoneShadow: '#888888',
  lastMoveMarker: '#ff5555',
  winLine: '#ff4400',
  winGlow: 'rgba(255, 68, 0, 0.3)',
  labelColor: '#8a7a5a',
  coordinateColor: '#6a5a3a',
};

export class BoardRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private animFrame: number | null = null;

  // Layout
  private padding: number = 32;
  private cellSize: number = 38;
  private stoneRadius: number = 16;
  private totalSize: number = 0;

  // Animation
  private hoverPos: Position | null = null;
  private winAnimProgress: number = 0;
  private winAnimStart: number = 0;
  private darkMode: boolean = false;

  // Suggestions
  private suggestions: Suggestion[] = [];
  private showSuggestions: boolean = false;

  get theme(): ThemeColors {
    return this.darkMode ? DARK_THEME : LIGHT_THEME;
  }

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.resize();
  }

  setDarkMode(dark: boolean): void {
    this.darkMode = dark;
  }

  setSuggestions(suggestions: Suggestion[], show: boolean): void {
    this.suggestions = suggestions;
    this.showSuggestions = show;
  }

  resize(): void {
    const container = this.canvas.parentElement!;
    const rect = container.getBoundingClientRect();

    // Use the smaller of container width/height to keep square
    const maxSize = Math.min(rect.width, rect.height);

    this.cellSize = (maxSize - 2 * this.padding) / (BOARD_SIZE - 1);
    this.stoneRadius = Math.max(9, this.cellSize * 0.43);
    this.totalSize = this.cellSize * (BOARD_SIZE - 1) + 2 * this.padding;

    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = this.totalSize * dpr;
    this.canvas.height = this.totalSize * dpr;
    this.canvas.style.width = `${this.totalSize}px`;
    this.canvas.style.height = `${this.totalSize}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  screenToBoard(screenX: number, screenY: number): Position | null {
    const rect = this.canvas.getBoundingClientRect();
    const x = screenX - rect.left;
    const y = screenY - rect.top;

    const col = Math.round((x - this.padding) / this.cellSize);
    const row = Math.round((y - this.padding) / this.cellSize);

    if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) return null;

    // Check if click is close enough to intersection
    const bx = this.padding + col * this.cellSize;
    const by = this.padding + row * this.cellSize;
    const dist = Math.sqrt((x - bx) ** 2 + (y - by) ** 2);

    if (dist > this.cellSize * 0.45) return null;

    return { row, col };
  }

  setHover(pos: Position | null): void {
    this.hoverPos = pos;
  }

  startWinAnimation(): void {
    this.winAnimStart = Date.now();
    this.winAnimProgress = 0;
  }

  render(game: Game): void {
    if (this.animFrame) {
      cancelAnimationFrame(this.animFrame);
    }

    const renderLoop = () => {
      this.drawBoard(game);
      this.animFrame = requestAnimationFrame(renderLoop);
    };

    // Just do one render by default, use animation only for win
    this.drawBoard(game);

    if (game.status === 'over' && game.winner !== EMPTY) {
      this.winAnimProgress = Math.min(1, (Date.now() - this.winAnimStart) / 2000);
      if (this.winAnimProgress < 1) {
        this.animFrame = requestAnimationFrame(() => this.drawBoard(game));
      }
    }
  }

  private drawBoard(game: Game): void {
    const ctx = this.ctx;
    const t = this.theme;
    const size = this.totalSize;

    // Background
    this.drawBackground(ctx, size, t);

    // Grid
    this.drawGrid(ctx, t);

    // Star points
    this.drawStarPoints(ctx, t);

    // Coordinates
    this.drawCoordinates(ctx, t);

    // Stones
    const lastMove = game.getLastMove();
    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        const cell = game.board.grid[row][col];
        if (cell !== EMPTY) {
          const isLast = lastMove !== null && lastMove.row === row && lastMove.col === col;
          this.drawStone(ctx, row, col, cell, isLast, t);
        }
      }
    }

    // Winning line
    if (game.status === 'over' && game.winLine.length > 0) {
      this.drawWinLine(ctx, game.winLine, t);
    }

    // Suggestions (AI analysis overlay)
    if (this.showSuggestions && this.suggestions.length > 0 && game.status === 'playing') {
      this.drawSuggestions(ctx, t);
    }

    // Hover
    if (this.hoverPos && game.status === 'playing') {
      const cell = game.board.grid[this.hoverPos.row][this.hoverPos.col];
      if (cell === EMPTY) {
        this.drawHover(ctx, this.hoverPos, game.currentPlayer, t);
      }
    }
  }

  private drawBackground(ctx: CanvasRenderingContext2D, size: number, t: ThemeColors): void {
    // A quiet, cool board surface rather than the fork's competitive wood texture.
    const grad = ctx.createLinearGradient(0, 0, size, size);
    grad.addColorStop(0, t.boardBg);
    grad.addColorStop(0.3, t.boardBgEnd);
    grad.addColorStop(0.6, t.boardBg);
    grad.addColorStop(1, t.boardBgEnd);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    // Deterministic paper-like lines; unlike random wood grain, these do not flicker on hover.
    ctx.save();
    ctx.globalAlpha = 0.08;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    for (let i = 0; i < 12; i++) {
      const y = (i + 1) * size / 13;
      ctx.beginPath();
      ctx.moveTo(0, y);
      for (let x = 0; x <= size; x += 8) {
        ctx.lineTo(x, y + Math.sin((x + i * 13) * 0.025) * 1.5);
      }
      ctx.stroke();
    }
    ctx.restore();

    // Border shadow
    ctx.save();
    ctx.shadowColor = 'rgba(63, 94, 102, 0.2)';
    ctx.shadowBlur = 12;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 3;
    ctx.strokeStyle = 'rgba(73, 109, 117, 0.25)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, size, size);
    ctx.restore();
  }

  private drawGrid(ctx: CanvasRenderingContext2D, t: ThemeColors): void {
    ctx.strokeStyle = t.gridLine;
    ctx.lineWidth = 1;

    for (let i = 0; i < BOARD_SIZE; i++) {
      const x = this.padding + i * this.cellSize;
      const y = this.padding;
      const y2 = this.padding + (BOARD_SIZE - 1) * this.cellSize;
      const x2 = this.padding + (BOARD_SIZE - 1) * this.cellSize;

      // Vertical line
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y2);
      ctx.stroke();

      // Horizontal line
      ctx.beginPath();
      ctx.moveTo(y, x);
      ctx.lineTo(y2, x);
      ctx.stroke();
    }
  }

  private drawStarPoints(ctx: CanvasRenderingContext2D, t: ThemeColors): void {
    const stars = [
      [3, 3], [3, 7], [3, 11],
      [7, 3], [7, 7], [7, 11],
      [11, 3], [11, 7], [11, 11],
    ];

    ctx.fillStyle = t.starPoint;
    for (const [row, col] of stars) {
      const x = this.padding + col * this.cellSize;
      const y = this.padding + row * this.cellSize;
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawCoordinates(ctx: CanvasRenderingContext2D, t: ThemeColors): void {
    ctx.fillStyle = t.coordinateColor;
    ctx.font = `${Math.max(10, this.cellSize * 0.3)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const letters = 'ABCDEFGHIJKLMNO';
    for (let i = 0; i < BOARD_SIZE; i++) {
      const x = this.padding + i * this.cellSize;

      // Top label
      ctx.fillText(letters[i], x, this.padding - 15);

      // Bottom label
      ctx.fillText(letters[i], x, this.padding + (BOARD_SIZE - 1) * this.cellSize + 15);

      // Left label
      ctx.textAlign = 'right';
      ctx.fillText(`${BOARD_SIZE - i}`, this.padding - 10, this.padding + i * this.cellSize);

      // Right label
      ctx.textAlign = 'left';
      ctx.fillText(`${BOARD_SIZE - i}`, this.padding + (BOARD_SIZE - 1) * this.cellSize + 10, this.padding + i * this.cellSize);
    }
  }

  private drawStone(
    ctx: CanvasRenderingContext2D,
    row: number, col: number,
    player: Player,
    isLast: boolean,
    t: ThemeColors
  ): void {
    const x = this.padding + col * this.cellSize;
    const y = this.padding + row * this.cellSize;
    const r = this.stoneRadius;

    ctx.save();

    // Shadow
    ctx.beginPath();
    ctx.arc(x + 2, y + 2, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fill();

    // Stone body
    const grad = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
    if (player === BLACK) {
      grad.addColorStop(0, t.blackStoneHighlight);
      grad.addColorStop(0.4, t.blackStone);
      grad.addColorStop(1, t.blackStoneShadow);
    } else {
      grad.addColorStop(0, t.whiteStoneHighlight);
      grad.addColorStop(0.4, t.whiteStone);
      grad.addColorStop(1, t.whiteStoneShadow);
    }

    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    // Stone border
    ctx.strokeStyle = player === BLACK ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.15)';
    ctx.lineWidth = 0.5;
    ctx.stroke();

    // Highlight reflection
    if (player === BLACK) {
      ctx.beginPath();
      ctx.arc(x - r * 0.25, y - r * 0.25, r * 0.35, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(x - r * 0.25, y - r * 0.25, r * 0.4, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fill();
    }

    // Last move marker
    if (isLast) {
      const markerSize = r * 0.3;
      ctx.fillStyle = t.lastMoveMarker;
      ctx.beginPath();
      ctx.arc(x, y, markerSize, 0, Math.PI * 2);
      ctx.fill();

      // Glow
      ctx.beginPath();
      ctx.arc(x, y, markerSize * 1.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,0,0,0.15)';
      ctx.fill();
    }

    ctx.restore();
  }

  private drawHover(ctx: CanvasRenderingContext2D, pos: Position, player: Player, t: ThemeColors): void {
    const x = this.padding + pos.col * this.cellSize;
    const y = this.padding + pos.row * this.cellSize;
    const r = this.stoneRadius;

    ctx.save();
    ctx.globalAlpha = 0.4;

    const grad = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
    if (player === BLACK) {
      grad.addColorStop(0, t.blackStoneHighlight);
      grad.addColorStop(1, t.blackStone);
    } else {
      grad.addColorStop(0, t.whiteStoneHighlight);
      grad.addColorStop(1, t.whiteStone);
    }

    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();
  }

  private drawWinLine(ctx: CanvasRenderingContext2D, line: Position[], t: ThemeColors): void {
    if (line.length < 2) return;

    ctx.save();

    // Pulsing animation
    const pulse = Math.sin(Date.now() / 300) * 0.3 + 0.7;

    // Background glow
    ctx.shadowColor = t.winGlow;
    ctx.shadowBlur = 15 * pulse;

    // Find the two endpoints of the line (farthest apart)
    let maxDist = 0;
    let startIdx = 0;
    let endIdx = line.length - 1;
    for (let i = 0; i < line.length; i++) {
      for (let j = i + 1; j < line.length; j++) {
        const dist = Math.abs(line[i].row - line[j].row) + Math.abs(line[i].col - line[j].col);
        if (dist > maxDist) {
          maxDist = dist;
          startIdx = i;
          endIdx = j;
        }
      }
    }

    const x1 = this.padding + line[startIdx].col * this.cellSize;
    const y1 = this.padding + line[startIdx].row * this.cellSize;
    const x2 = this.padding + line[endIdx].col * this.cellSize;
    const y2 = this.padding + line[endIdx].row * this.cellSize;

    // Win line
    ctx.strokeStyle = t.winLine;
    ctx.lineWidth = 3 * pulse;
    ctx.globalAlpha = 0.8 * pulse;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    // Endpoint markers
    for (const pos of line) {
      const px = this.padding + pos.col * this.cellSize;
      const py = this.padding + pos.row * this.cellSize;
      ctx.beginPath();
      ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.fillStyle = t.winLine;
      ctx.globalAlpha = 0.6 * pulse;
      ctx.fill();
    }

    ctx.restore();
  }

  // ===== Suggestions =====

  private drawSuggestions(ctx: CanvasRenderingContext2D, t: ThemeColors): void {
    const now = Date.now();
    const pulse = Math.sin(now / 400) * 0.08 + 0.92; // subtle breathing

    for (const s of this.suggestions) {
      const { row, col, winRate } = s;
      const x = this.padding + col * this.cellSize;
      const y = this.padding + row * this.cellSize;

      // Skip occupied cells
      // (suggestions should only be empty cells, but guard just in case)

      // Color: green (high) → yellow (mid) → red (low)
      const hue = winRate * 1.2; // 0=red, 120=green
      const color = `hsla(${hue}, 85%, ${55 * pulse}%, 0.75)`;
      const glowColor = `hsla(${hue}, 90%, 60%, 0.25)`;

      ctx.save();

      // Glow ring
      const ringR = this.stoneRadius * 0.85;
      ctx.beginPath();
      ctx.arc(x, y, ringR + 3, 0, Math.PI * 2);
      ctx.fillStyle = glowColor;
      ctx.fill();

      // Colored ring
      ctx.beginPath();
      ctx.arc(x, y, ringR, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5 * pulse;
      ctx.stroke();

      // Center dot
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      // Win rate label
      const label = `${winRate}%`;
      ctx.font = `bold ${Math.max(10, this.cellSize * 0.28)}px var(--font-mono, monospace)`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';

      // Label shadow
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      const labelY = y - this.stoneRadius * 0.6;
      ctx.fillText(label, x + 1, labelY + 1);

      // Label text
      ctx.fillStyle = winRate >= 50 ? '#ffffff' : '#ffdddd';
      ctx.fillText(label, x, labelY);

      ctx.restore();
    }
  }

  destroy(): void {
    if (this.animFrame) {
      cancelAnimationFrame(this.animFrame);
    }
  }
}
