#!/usr/bin/env node

import { open, readFile, rename, unlink, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CodexGameThreadClient, resolveCodexBinary } from './codex-game-thread.mjs';

const exec = promisify(execFile);

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('../.runtime/detector-config.json', import.meta.url));
const DEFAULT_STATE_PATH = fileURLToPath(new URL('../.runtime/detector-state.json', import.meta.url));
const DEFAULT_LOCK_PATH = fileURLToPath(new URL('../.runtime/detector.lock', import.meta.url));
const MCP_SERVER_PATH = fileURLToPath(new URL('./gomoku-mcp-server.mjs', import.meta.url));
const DEFAULT_BASE_URL = 'http://127.0.0.1:8082';
const POLL_MS = 900;
const LEASE_MS = 15 * 60_000;
const HTTP_TIMEOUT_MS = 5_000;
const MAX_AUTO_ATTEMPTS = 3;
const SOURCE_BUSY_RECHECK_MS = 5_000;
const MAX_ROLLOUT_TAIL_BYTES = 16 * 1024 * 1024;

function pause(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function readJson(pathname, fallback) {
  try {
    return JSON.parse(await readFile(pathname, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJson(pathname, value) {
  await mkdir(dirname(pathname), { recursive: true });
  const temporary = `${pathname}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, pathname);
}

export async function sourceThreadIsIdle(rolloutPath) {
  const handle = await open(rolloutPath, 'r');
  try {
    const metadata = await handle.stat();
    const length = Math.min(metadata.size, MAX_ROLLOUT_TAIL_BYTES);
    const start = metadata.size - length;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    let text = buffer.toString('utf8');
    if (start > 0) {
      const newline = text.indexOf('\n');
      if (newline < 0) return false;
      text = text.slice(newline + 1);
    }
    const events = text
      .split('\n')
      .filter(Boolean)
      .flatMap(line => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    let contextIndex = -1;
    let sourceTurnId = '';
    for (let index = 0; index < events.length; index++) {
      if (events[index]?.type === 'turn_context') {
        contextIndex = index;
        sourceTurnId = typeof events[index]?.payload?.turn_id === 'string'
          ? events[index].payload.turn_id
          : '';
      }
    }
    if (contextIndex < 0 || !sourceTurnId) return false;
    let completedIndex = -1;
    for (let index = contextIndex + 1; index < events.length; index++) {
      const event = events[index];
      if (
        event?.type === 'event_msg'
        && event?.payload?.type === 'task_complete'
        && event?.payload?.turn_id === sourceTurnId
      ) {
        completedIndex = index;
      }
    }
    if (completedIndex < 0) return false;
    return !events.slice(completedIndex + 1).some(event => (
      event?.type === 'turn_context'
      || (event?.type === 'response_item'
        && event?.payload?.type === 'message'
        && event?.payload?.role === 'user')
    ));
  } finally {
    await handle.close();
  }
}

export function validateDetectorConfig(value) {
  const threadId = typeof value?.threadId === 'string' ? value.threadId.trim() : '';
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId)) {
    throw new Error('检测器尚未绑定有效的 Codex 任务 ID。');
  }
  const codexHome = typeof value.codexHome === 'string' ? value.codexHome : '';
  const rolloutPath = typeof value.rolloutPath === 'string' ? value.rolloutPath : '';
  if (!codexHome || !rolloutPath) {
    throw new Error('检测器缺少隔离目录或当前任务的 rollout 路径。');
  }
  return {
    threadId,
    workspace: typeof value.workspace === 'string' && value.workspace
      ? value.workspace
      : PROJECT_ROOT,
    codexHome,
    rolloutPath,
  };
}

export async function fetchCurrentTurn(baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch) {
  const response = await fetchImpl(`${baseUrl}/api/current-game/turn`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (response.status === 404) return null;
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error || `棋局服务返回 ${response.status}。`);
  return body;
}

export async function submitMove(baseUrl, turnId, move, fetchImpl = fetch) {
  if (!move || move.turnId !== turnId || !Number.isInteger(move.row) || !Number.isInteger(move.col)) {
    throw new Error('Codex 没有通过五子棋工具提交有效落子。');
  }
  const response = await fetchImpl(
    `${baseUrl}/api/current-game/turn/${encodeURIComponent(turnId)}/move`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', accept: 'application/json' },
      body: JSON.stringify({ row: move.row, col: move.col, say: String(move.say || '').slice(0, 80) }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    },
  );
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error || `棋局落子返回 ${response.status}。`);
  return body;
}

async function markTurnFailed(baseUrl, turnId, message, fetchImpl = fetch) {
  const response = await fetchImpl(
    `${baseUrl}/api/current-game/turn/${encodeURIComponent(turnId)}/fail`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', accept: 'application/json' },
      body: JSON.stringify({ error: String(message).slice(0, 160) }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    },
  );
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error || `棋局失败状态返回 ${response.status}。`);
  return body;
}

function backoffMilliseconds(attempts, random = Math.random) {
  const base = Math.min(120_000, 5_000 * (4 ** Math.min(3, Math.max(0, attempts - 1))));
  return Math.round(base * (1 + 0.2 * random()));
}

export class GomokuDetector {
  constructor({
    configPath = process.env.LUO_GOMOKU_DETECTOR_CONFIG || DEFAULT_CONFIG_PATH,
    statePath = process.env.LUO_GOMOKU_DETECTOR_STATE || DEFAULT_STATE_PATH,
    baseUrl = process.env.LUO_GOMOKU_BASE_URL || DEFAULT_BASE_URL,
    fetchImpl = fetch,
    now = () => Date.now(),
    random = Math.random,
    createClient,
  } = {}) {
    this.configPath = configPath;
    this.statePath = statePath;
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.random = random;
    this.createClient = createClient;
    this.client = null;
    this.owner = randomUUID();
    this.sourceBusyUntil = 0;
  }

  async getClient(config, turn) {
    if (this.client) return this.client;
    if (this.createClient) {
      this.client = await this.createClient(config, turn);
      return this.client;
    }
    const executable = await resolveCodexBinary();
    this.client = new CodexGameThreadClient({
      executable,
      workspace: config.workspace,
      mcpServerPath: MCP_SERVER_PATH,
      codexHome: config.codexHome,
      rolloutPath: config.rolloutPath,
      baseUrl: this.baseUrl,
      gameTurn: turn,
    });
    return this.client;
  }

  resetClient() {
    this.client?.stop?.();
    this.client = null;
  }

  async synchronizeFailure(state, turn, attempts, message) {
    try {
      await markTurnFailed(this.baseUrl, turn.turnId, message, this.fetchImpl);
      await writeJson(this.statePath, {
        ...state,
        processingTurnId: turn.turnId,
        leaseOwner: null,
        leaseUntil: 0,
        attempts,
        nextAttemptAt: 0,
        lastResult: 'failed',
        lastError: message,
        failureReason: null,
        updatedAt: new Date(this.now()).toISOString(),
      });
      return { action: 'failed', turnId: turn.turnId };
    } catch (error) {
      const syncMessage = error instanceof Error ? error.message : String(error);
      const failureReason = String(state.failureReason || message).slice(0, 160);
      const nextAttemptAt = this.now() + backoffMilliseconds(attempts, this.random);
      await writeJson(this.statePath, {
        ...state,
        processingTurnId: turn.turnId,
        leaseOwner: null,
        leaseUntil: 0,
        attempts,
        nextAttemptAt,
        lastResult: 'pending-failure',
        lastError: syncMessage,
        failureReason,
        updatedAt: new Date(this.now()).toISOString(),
      });
      return { action: 'failure-sync-retry', turnId: turn.turnId, nextAttemptAt };
    }
  }

  async processOnce() {
    const config = validateDetectorConfig(await readJson(this.configPath, {}));
    const state = await readJson(this.statePath, { attempts: 0 });
    let turn;
    try {
      turn = await fetchCurrentTurn(this.baseUrl, this.fetchImpl);
    } catch (error) {
      return { action: 'service-unavailable', error: error instanceof Error ? error.message : String(error) };
    }

    if (!turn) return { action: 'idle' };
    if (turn.status === 'ready') {
      if (state.lastCompletedTurnId !== turn.turnId || state.processingTurnId) {
        await writeJson(this.statePath, {
          ...state,
          lastCompletedTurnId: turn.turnId,
          processingTurnId: null,
          leaseOwner: null,
          leaseUntil: 0,
          attempts: 0,
          nextAttemptAt: 0,
          lastResult: 'ready',
          updatedAt: new Date(this.now()).toISOString(),
        });
      }
      return { action: 'ready', turnId: turn.turnId };
    }
    if (turn.status === 'failed') return { action: 'failed', turnId: turn.turnId };
    if (turn.status !== 'waiting') return { action: 'ignored', turnId: turn.turnId };
    if (state.lastCompletedTurnId === turn.turnId) return { action: 'already-completed', turnId: turn.turnId };

    const now = this.now();
    if (Number(state.nextAttemptAt) > now) return { action: 'backoff', turnId: turn.turnId };
    if (
      state.processingTurnId === turn.turnId
      && ['pending-failure', 'failed'].includes(state.lastResult)
    ) {
      return this.synchronizeFailure(
        state,
        turn,
        Math.max(MAX_AUTO_ATTEMPTS, Number(state.attempts || 0)),
        state.failureReason || state.lastError || '砚连续三次没有接住这一手。',
      );
    }
    if (state.processingTurnId === turn.turnId
      && state.leaseOwner !== this.owner
      && Number(state.leaseUntil) > now) {
      return { action: 'leased', turnId: turn.turnId };
    }
    if (this.sourceBusyUntil > now) return { action: 'source-busy', turnId: turn.turnId };
    let sourceIdle;
    try {
      sourceIdle = await sourceThreadIsIdle(config.rolloutPath);
    } catch (error) {
      return {
        action: 'source-unavailable',
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (!sourceIdle) {
      this.sourceBusyUntil = now + SOURCE_BUSY_RECHECK_MS;
      return { action: 'source-busy', turnId: turn.turnId };
    }

    const attempts = state.processingTurnId === turn.turnId ? Number(state.attempts || 0) + 1 : 1;
    await writeJson(this.statePath, {
      ...state,
      processingTurnId: turn.turnId,
      leaseOwner: this.owner,
      leaseUntil: now + LEASE_MS,
      attempts,
      nextAttemptAt: 0,
      lastResult: 'processing',
      updatedAt: new Date(now).toISOString(),
    });

    try {
      const client = await this.getClient(config, turn);
      const played = await client.play(config.threadId, turn);
      await submitMove(this.baseUrl, turn.turnId, played?.move, this.fetchImpl);
      const confirmed = await fetchCurrentTurn(this.baseUrl, this.fetchImpl);
      if (!confirmed || confirmed.turnId !== turn.turnId || confirmed.status !== 'ready') {
        throw new Error('Codex 回合结束了，但棋盘还没有收到合法落子。');
      }
      this.resetClient();
      const messaged = typeof played?.move?.say === 'string' && played.move.say.trim().length > 0;
      await writeJson(this.statePath, {
        lastCompletedTurnId: turn.turnId,
        processingTurnId: null,
        leaseOwner: null,
        leaseUntil: 0,
        attempts: 0,
        nextAttemptAt: 0,
        lastResult: messaged ? 'moved-and-messaged' : 'moved-silently',
        updatedAt: new Date(this.now()).toISOString(),
      });
      return { action: messaged ? 'moved-and-messaged' : 'moved-silently', turnId: turn.turnId };
    } catch (error) {
      this.resetClient();
      const message = error instanceof Error ? error.message : String(error);
      if (attempts >= MAX_AUTO_ATTEMPTS) {
        return this.synchronizeFailure(state, turn, attempts, message);
      }
      const nextAttemptAt = this.now() + backoffMilliseconds(attempts, this.random);
      await writeJson(this.statePath, {
        ...state,
        processingTurnId: turn.turnId,
        leaseOwner: null,
        leaseUntil: 0,
        attempts,
        nextAttemptAt,
        lastResult: 'retry',
        lastError: message,
        updatedAt: new Date(this.now()).toISOString(),
      });
      return { action: 'retry', turnId: turn.turnId, nextAttemptAt };
    }
  }
}

async function acquireProcessLock(pathname = process.env.LUO_GOMOKU_DETECTOR_LOCK || DEFAULT_LOCK_PATH) {
  await mkdir(dirname(pathname), { recursive: true });
  try {
    const handle = await open(pathname, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
    return async () => {
      await handle.close().catch(() => {});
      await unlink(pathname).catch(() => {});
    };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let stale = true;
    try {
      const existing = JSON.parse(await readFile(pathname, 'utf8'));
      const pid = Number(existing.pid);
      if (!Number.isInteger(pid) || pid <= 1) throw new Error('invalid lock pid');
      process.kill(pid, 0);
      const { stdout } = await exec('/bin/ps', ['-p', String(pid), '-o', 'command=']);
      stale = !stdout.includes('server/detector.mjs');
    } catch (lockError) {
      stale = lockError?.code !== 'EPERM';
    }
    if (!stale) return null;
    await unlink(pathname).catch(() => {});
    return acquireProcessLock(pathname);
  }
}

export async function runForever(options = {}) {
  const release = await acquireProcessLock(options.lockPath);
  if (!release) return { action: 'already-running' };
  const detector = options.detector || new GomokuDetector(options);
  let stopping = false;
  let lastLog = '';
  const stop = () => { stopping = true; detector.resetClient(); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    while (!stopping) {
      let result;
      try {
        result = await detector.processOnce();
      } catch (error) {
        result = { action: 'detector-error', error: error instanceof Error ? error.message : String(error) };
      }
      if (![
        'idle',
        'ready',
        'already-completed',
        'backoff',
        'leased',
        'service-unavailable',
        'source-busy',
      ].includes(result.action)) {
        const serialized = JSON.stringify(result);
        if (serialized !== lastLog) process.stdout.write(`${serialized}\n`);
        lastLog = serialized;
      }
      await pause(POLL_MS);
    }
    return { action: 'stopped' };
  } finally {
    detector.resetClient();
    await release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runForever();
}
