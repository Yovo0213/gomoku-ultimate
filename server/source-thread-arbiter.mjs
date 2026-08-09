import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const MAX_LOCK_AGE_MS = 20 * 60_000;

function defaultDirectory() {
  return path.join(os.homedir(), 'Library', 'Application Support', 'Luo-Codex-Game-Bridge', 'thread-locks');
}

function lockName(threadId) {
  return `${createHash('sha256').update(threadId).digest('hex').slice(0, 24)}.lock`;
}

async function processIdentity(pid) {
  const { stdout } = await exec('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command=']);
  return stdout.trim();
}

async function liveOwner(record, now, currentIdentity) {
  const pid = Number(record?.pid);
  if (!Number.isInteger(pid) || pid <= 1) return false;
  if (!Number.isFinite(record?.acquiredAt) || now - record.acquiredAt > MAX_LOCK_AGE_MS) return false;
  if (pid === process.pid) {
    return Boolean(currentIdentity && record.processIdentity === currentIdentity);
  }
  try {
    process.kill(pid, 0);
    const identity = await processIdentity(pid);
    return Boolean(identity && identity === record.processIdentity && identity.includes('server/detector.mjs'));
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function publishCompleteLock(pathname, record) {
  const temporary = `${pathname}.${record.pid}.${record.owner}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, pathname);
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export async function acquireSourceThreadTurn({
  threadId,
  directory = process.env.LUO_GAME_ARBITER_DIR || defaultDirectory(),
  now = () => Date.now(),
  identity,
} = {}) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(threadId || ''))) {
    throw new Error('共享游戏回合锁缺少有效任务编号。');
  }
  const normalizedThreadId = String(threadId).toLowerCase();
  await mkdir(directory, { recursive: true });
  const pathname = path.join(directory, lockName(normalizedThreadId));
  const owner = randomUUID();
  const acquiredAt = now();
  const processToken = identity || await processIdentity(process.pid);
  const record = {
    owner,
    pid: process.pid,
    processIdentity: processToken,
    threadId: normalizedThreadId,
    acquiredAt,
  };

  if (await publishCompleteLock(pathname, record)) {
    return async () => {
      try {
        const current = JSON.parse(await readFile(pathname, 'utf8'));
        if (current?.owner === owner) await unlink(pathname);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    };
  }

    let existing;
    let existingText = '';
    try {
      existingText = await readFile(pathname, 'utf8');
      existing = JSON.parse(existingText);
    } catch (readError) {
      if (readError?.code === 'ENOENT') {
        return acquireSourceThreadTurn({ threadId: normalizedThreadId, directory, now, identity });
      }
      existing = null;
    }
    if (await liveOwner(existing, acquiredAt, processToken)) return null;
    try {
      const latestText = await readFile(pathname, 'utf8');
      if (latestText !== existingText) return null;
      if (existing) {
        const latest = JSON.parse(latestText);
        if (latest?.owner !== existing.owner) return null;
      }
      await unlink(pathname);
    } catch (unlinkError) {
      if (unlinkError?.code !== 'ENOENT') return null;
    }
    return acquireSourceThreadTurn({ threadId: normalizedThreadId, directory, now, identity });
}
