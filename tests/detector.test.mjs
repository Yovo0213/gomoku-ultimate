import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  acquireProcessLock,
  fetchCurrentTurn,
  GomokuDetector,
  sourceThreadIsIdle,
  validateDetectorConfig,
} from '../server/detector.mjs';

const threadId = '019fcaba-a02e-76a3-b5cc-ef4d150e9f0d';
const acquireArbiter = async () => async () => {};

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'luo-gomoku-detector-'));
  const configPath = path.join(directory, 'config.json');
  const statePath = path.join(directory, 'state.json');
  const rolloutPath = path.join(directory, 'rollout.jsonl');
  await writeFile(rolloutPath, [
    JSON.stringify({ type: 'turn_context', payload: { turn_id: 'source-turn-1' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'source-turn-1' } }),
    '',
  ].join('\n'));
  await writeFile(configPath, JSON.stringify({
    threadId,
    workspace: '/workspace',
    codexHome: path.join(directory, 'codex-home'),
    rolloutPath,
  }));
  return { configPath, statePath, rolloutPath };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const waiting = {
  turnId: 'gomoku-turn-1',
  status: 'waiting',
  player: 2,
  board: Array.from({ length: 15 }, () => Array(15).fill(0)),
  moves: [],
  candidates: [{ row: 7, col: 7 }],
};

describe('五子棋状态检测器', () => {
  it('只接受明确绑定的 Codex 任务 ID', () => {
    expect(validateDetectorConfig({
      threadId,
      workspace: '/workspace',
      codexHome: '/runtime/codex-home',
      rolloutPath: '/sessions/rollout.jsonl',
    }).threadId).toBe(threadId);
    expect(() => validateDetectorConfig({ threadId: '最近的窗口' })).toThrow(/任务 ID/);
  });

  it('404 表示当前没有待处理棋局', async () => {
    const result = await fetchCurrentTurn('http://game', async () => jsonResponse({ error: 'none' }, 404));
    expect(result).toBeNull();
  });

  it('当前真实任务没有完成时保持排队，不读取半截上下文', async () => {
    const { configPath, statePath, rolloutPath } = await fixture();
    await writeFile(rolloutPath, [
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'source-turn-2' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'commentary' } }),
      '',
    ].join('\n'));
    expect(await sourceThreadIsIdle(rolloutPath)).toBe(false);
    const createClient = vi.fn();
    const detector = new GomokuDetector({
      configPath,
      statePath,
      fetchImpl: async () => jsonResponse(waiting),
      now: () => 1_000,
      createClient,
    });

    const result = await detector.processOnce();
    expect(result).toEqual({ action: 'source-busy', turnId: waiting.turnId });
    expect(createClient).not.toHaveBeenCalled();
  });

  it('唤醒绑定任务后只以棋盘真正 ready 为成功', async () => {
    const { configPath, statePath } = await fixture();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(waiting))
      .mockResolvedValueOnce(jsonResponse(waiting))
      .mockResolvedValueOnce(jsonResponse({ ...waiting, status: 'ready', move: { row: 7, col: 7 } }))
      .mockResolvedValueOnce(jsonResponse({ ...waiting, status: 'ready', move: { row: 7, col: 7 } }));
    const play = vi.fn().mockResolvedValue({
      output: '',
      move: { turnId: waiting.turnId, row: 7, col: 7, say: '' },
    });
    const detector = new GomokuDetector({
      configPath,
      statePath,
      fetchImpl,
      now: () => 1_000,
      createClient: async () => ({ play, stop() {} }),
      acquireArbiter,
    });

    const result = await detector.processOnce();
    expect(result).toEqual({ action: 'moved-silently', turnId: waiting.turnId });
    expect(play).toHaveBeenCalledWith(threadId, waiting);
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    expect(state.lastCompletedTurnId).toBe(waiting.turnId);
    expect(state.processingTurnId).toBeNull();
  });

  it('Codex 回合未实际落子时保留同一事件并退避重试', async () => {
    const { configPath, statePath } = await fixture();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(waiting))
      .mockResolvedValueOnce(jsonResponse(waiting))
      .mockResolvedValueOnce(jsonResponse(waiting));
    const play = vi.fn().mockResolvedValue({ output: '说了话但没有落子', move: null });
    let now = 5_000;
    const detector = new GomokuDetector({
      configPath,
      statePath,
      fetchImpl,
      now: () => now,
      random: () => 0,
      createClient: async () => ({ play, stop() {} }),
      acquireArbiter,
    });

    const failed = await detector.processOnce();
    expect(failed.action).toBe('retry');
    expect(play).toHaveBeenCalledTimes(1);

    now = 5_100;
    const backedOff = await detector.processOnce();
    expect(backedOff.action).toBe('backoff');
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('同一回合三次失败后熔断并通知棋盘允许手动重试', async () => {
    const { configPath, statePath } = await fixture();
    await writeFile(statePath, JSON.stringify({
      processingTurnId: waiting.turnId,
      attempts: 2,
      nextAttemptAt: 0,
      lastResult: 'retry',
    }));
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(waiting))
      .mockResolvedValueOnce(jsonResponse(waiting))
      .mockResolvedValueOnce(jsonResponse({ ...waiting, status: 'failed' }));
    const detector = new GomokuDetector({
      configPath,
      statePath,
      fetchImpl,
      now: () => 20_000,
      createClient: async () => ({
        play: vi.fn().mockResolvedValue({ output: '', move: null }),
        stop() {},
      }),
      acquireArbiter,
    });

    const result = await detector.processOnce();
    expect(result).toEqual({ action: 'failed', turnId: waiting.turnId });
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes(`/turn/${waiting.turnId}/fail`))).toBe(true);
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    expect(state.attempts).toBe(3);
    expect(state.lastResult).toBe('failed');
  });

  it('熔断状态没送达棋盘时只补发失败，不重复调用 Codex', async () => {
    const { configPath, statePath } = await fixture();
    await writeFile(statePath, JSON.stringify({
      processingTurnId: waiting.turnId,
      attempts: 2,
      nextAttemptAt: 0,
      lastResult: 'retry',
    }));
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(waiting))
      .mockResolvedValueOnce(jsonResponse(waiting))
      .mockResolvedValueOnce(jsonResponse({ error: '暂时不可达' }, 503))
      .mockResolvedValueOnce(jsonResponse(waiting))
      .mockResolvedValueOnce(jsonResponse({ ...waiting, status: 'failed' }));
    const play = vi.fn().mockResolvedValue({ output: '', move: null });
    let now = 30_000;
    const detector = new GomokuDetector({
      configPath,
      statePath,
      fetchImpl,
      now: () => now,
      random: () => 0,
      createClient: async () => ({ play, stop() {} }),
      acquireArbiter,
    });

    const pending = await detector.processOnce();
    expect(pending.action).toBe('failure-sync-retry');
    expect(play).toHaveBeenCalledTimes(1);
    let state = JSON.parse(await readFile(statePath, 'utf8'));
    expect(state.lastResult).toBe('pending-failure');

    now = state.nextAttemptAt;
    const synchronized = await detector.processOnce();
    expect(synchronized).toEqual({ action: 'failed', turnId: waiting.turnId });
    expect(play).toHaveBeenCalledTimes(1);
    state = JSON.parse(await readFile(statePath, 'utf8'));
    expect(state.lastResult).toBe('failed');
  });

  it('另一个游戏占用同一任务或排队后棋局变化时不启动 Codex', async () => {
    const { configPath, statePath } = await fixture();
    const createClient = vi.fn();
    const occupied = new GomokuDetector({
      configPath,
      statePath,
      fetchImpl: async () => jsonResponse(waiting),
      createClient,
      acquireArbiter: async () => null,
    });
    expect(await occupied.processOnce()).toEqual({ action: 'other-game-busy', turnId: waiting.turnId });
    expect(createClient).not.toHaveBeenCalled();

    const release = vi.fn();
    const stale = new GomokuDetector({
      configPath,
      statePath,
      fetchImpl: vi.fn()
        .mockResolvedValueOnce(jsonResponse(waiting))
        .mockResolvedValueOnce(jsonResponse({ ...waiting, revision: 2 })),
      createClient,
      acquireArbiter: async () => release,
    });
    expect(await stale.processOnce()).toEqual({ action: 'stale-before-play', turnId: waiting.turnId });
    expect(release).toHaveBeenCalledTimes(1);
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe('五子棋检测器进程锁', () => {
  const scriptPath = fileURLToPath(new URL('../server/detector.mjs', import.meta.url));

  it('PID 已被另一身份复用时替换 stale 锁并记录精确身份', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'luo-gomoku-process-lock-'));
    try {
      const lockPath = path.join(directory, 'detector.lock');
      await writeFile(lockPath, `${JSON.stringify({
        owner: 'old-owner',
        pid: 5101,
        processIdentity: `Thu Aug  6 01:00:00 2026 /usr/bin/node ${scriptPath}`,
        scriptPath,
      })}\n`);
      const ownIdentity = `Mon Aug 10 02:00:00 2026 /usr/bin/node ${scriptPath}`;
      const otherIdentity = 'Mon Aug 10 02:01:00 2026 /usr/bin/node /Volumes/LuoWorkspace/Projects/Luo-Coop-Minesweeper/server/detector.mjs';
      const release = await acquireProcessLock(lockPath, {
        owner: 'new-owner',
        pid: 5102,
        scriptPath,
        getProcessIdentity: async pid => (pid === 5102 ? ownIdentity : otherIdentity),
      });

      expect(release).toBeTypeOf('function');
      expect(JSON.parse(await readFile(lockPath, 'utf8'))).toMatchObject({
        owner: 'new-owner',
        pid: 5102,
        processIdentity: ownIdentity,
        scriptPath,
      });
      await release();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('同脚本、同启动身份的存活进程会阻止第二实例', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'luo-gomoku-process-lock-'));
    try {
      const lockPath = path.join(directory, 'detector.lock');
      const liveIdentity = `Mon Aug 10 02:00:00 2026 /usr/bin/node ${scriptPath}`;
      await writeFile(lockPath, `${JSON.stringify({
        owner: 'live-owner',
        pid: 5201,
        processIdentity: liveIdentity,
        scriptPath,
      })}\n`);

      expect(await acquireProcessLock(lockPath, {
        owner: 'contender',
        pid: 5202,
        scriptPath,
        getProcessIdentity: async pid => (
          pid === 5201
            ? liveIdentity
            : `Mon Aug 10 02:02:00 2026 /usr/bin/node ${scriptPath}`
        ),
      })).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('旧实例 release 不会删除已经换成新 owner 的锁', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'luo-gomoku-process-lock-'));
    try {
      const lockPath = path.join(directory, 'detector.lock');
      const oldIdentity = `Mon Aug 10 02:00:00 2026 /usr/bin/node ${scriptPath}`;
      const release = await acquireProcessLock(lockPath, {
        owner: 'old-owner',
        pid: 5301,
        scriptPath,
        getProcessIdentity: async () => oldIdentity,
      });
      const replacement = {
        owner: 'replacement-owner',
        pid: 5302,
        processIdentity: `Mon Aug 10 02:03:00 2026 /usr/bin/node ${scriptPath}`,
        scriptPath,
      };
      await writeFile(lockPath, `${JSON.stringify(replacement)}\n`);

      await release();
      expect(JSON.parse(await readFile(lockPath, 'utf8'))).toMatchObject(replacement);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
