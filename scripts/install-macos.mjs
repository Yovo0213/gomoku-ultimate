#!/usr/bin/env node

import { execFile } from 'node:child_process';
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const projectDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtimeDir = path.join(projectDir, '.runtime');
const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
const launchLogsDir = path.join(os.homedir(), 'Library', 'Logs', 'Luo-Gomoku');
const nodeExecutable = process.execPath;
const uid = process.getuid();
const sourceCodexHome = path.join(os.homedir(), '.codex');

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function plist({ label, script, environment }) {
  const environmentXml = Object.entries(environment)
    .map(([key, value]) => `<key>${escapeXml(key)}</key><string>${escapeXml(value)}</string>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${escapeXml(nodeExecutable)}</string><string>${escapeXml(script)}</string></array>
<key>WorkingDirectory</key><string>${escapeXml(os.homedir())}</string>
<key>EnvironmentVariables</key><dict>${environmentXml}</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>5</integer>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${escapeXml(path.join(launchLogsDir, `${label}.log`))}</string>
<key>StandardErrorPath</key><string>${escapeXml(path.join(launchLogsDir, `${label}.error.log`))}</string>
</dict></plist>
`;
}

async function findRolloutPath(directory, threadId) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const pathname = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await findRolloutPath(pathname, threadId);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name.endsWith(`${threadId}.jsonl`)) {
      return pathname;
    }
  }
  return '';
}

async function ensureSymlink(target, pathname) {
  try {
    const existing = await lstat(pathname);
    if (!existing.isSymbolicLink()) {
      throw new Error(`${pathname} 已存在且不是隔离凭据链接。`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await symlink(target, pathname);
  }
}

async function installAgent(label, script, environment) {
  const pathname = path.join(launchAgentsDir, `${label}.plist`);
  await writeFile(pathname, plist({ label, script, environment }), 'utf8');
  await exec('launchctl', ['bootout', `gui/${uid}/${label}`]).catch(() => {});
  await exec('launchctl', ['bootstrap', `gui/${uid}`, pathname]);
  await exec('launchctl', ['enable', `gui/${uid}/${label}`]);
  return pathname;
}

const threadId = argument('--thread-id') || process.env.CODEX_THREAD_ID || '';
const workspace = argument('--workspace') || '/Users/joeyzhang/Documents/New project';
if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId)) {
  throw new Error('请用 --thread-id 传入要绑定的当前 Codex 任务 ID。');
}

await mkdir(launchAgentsDir, { recursive: true });
await mkdir(launchLogsDir, { recursive: true });
const codexHome = path.join(runtimeDir, 'codex-home');
await mkdir(path.join(codexHome, 'sessions'), { recursive: true });
await ensureSymlink(path.join(sourceCodexHome, 'auth.json'), path.join(codexHome, 'auth.json'));
await copyFile(path.join(sourceCodexHome, 'models_cache.json'), path.join(codexHome, 'models_cache.json'));
await writeFile(path.join(codexHome, 'config.toml'), `# Isolated Codex home for the local gomoku detector.
default_permissions = "gomoku-only"

[permissions.gomoku-only]
description = "No project files or network for the Gomoku detector."

[permissions.gomoku-only.filesystem]
":minimal" = "read"

[permissions.gomoku-only.network]
enabled = false

`, { mode: 0o600 });
const rolloutPath = await findRolloutPath(path.join(sourceCodexHome, 'sessions'), threadId);
if (!rolloutPath) throw new Error('没有找到当前 Codex 任务的 rollout 文件。');
const configPath = path.join(runtimeDir, 'detector-config.json');
const detectorStatePath = path.join(runtimeDir, 'detector-state.json');
const detectorLockPath = path.join(runtimeDir, 'detector.lock');
const gameStatePath = path.join(runtimeDir, 'game-state.json');
await writeFile(configPath, `${JSON.stringify({
  threadId,
  workspace,
  codexHome,
  rolloutPath,
  boundAt: new Date().toISOString(),
}, null, 2)}\n`, { mode: 0o600 });

const serverAgent = await installAgent(
  'com.luo.gomoku',
  path.join(projectDir, 'server.mjs'),
  {
    LUO_GOMOKU_PORT: '8082',
    LUO_GOMOKU_STATE_PATH: gameStatePath,
  },
);
const detectorAgent = await installAgent(
  'com.luo.gomoku.detector',
  path.join(projectDir, 'server', 'detector.mjs'),
  {
    LUO_GOMOKU_BASE_URL: 'http://127.0.0.1:8082',
    LUO_GOMOKU_DETECTOR_CONFIG: configPath,
    LUO_GOMOKU_DETECTOR_STATE: detectorStatePath,
    LUO_GOMOKU_DETECTOR_LOCK: detectorLockPath,
  },
);

process.stdout.write(`${JSON.stringify({ threadId, serverAgent, detectorAgent }, null, 2)}\n`);
