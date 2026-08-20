import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureDir, resolveSkillsDir } from './paths';

function preferIpv4(url: string): string {
  return String(url || '').replace('://localhost', '://127.0.0.1');
}

async function unzipTo(zipPath: string, destDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('python3', ['-c', 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zipPath, destDir], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`unzip failed, exit ${code}`));
    });
  });
}

export async function syncSkills(opts: {
  sessionId: number;
  syncUrl: string;
  removed?: unknown;
  baseUrl: string;
  token: string | null;
}): Promise<void> {
  const origin = preferIpv4(opts.baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, ''));
  const fullUrl = preferIpv4(/^https?:\/\//.test(opts.syncUrl) ? opts.syncUrl : `${origin}${opts.syncUrl}`);
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const response = await fetch(fullUrl, { method: 'POST', headers });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Skill sync download failed: ${response.status} ${response.statusText} ${body}`.trim());
  }
  const zipBuffer = Buffer.from(await response.arrayBuffer());
  const skillsDir = resolveSkillsDir(opts.sessionId);
  ensureDir(skillsDir);
  const tmp = path.join(os.tmpdir(), `mao-skills-${opts.sessionId}-${Date.now()}.zip`);
  fs.writeFileSync(tmp, zipBuffer);
  try {
    await unzipTo(tmp, skillsDir);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
  const removed = Array.isArray(opts.removed) ? opts.removed.map(String) : [];
  for (const name of removed) {
    if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) continue;
    const target = path.join(skillsDir, name);
    if (target.startsWith(skillsDir + path.sep) || target === skillsDir) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }
}
