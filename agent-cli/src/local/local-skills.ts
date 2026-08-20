import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOCAL_SKILLS_DIR = path.join(os.homedir(), '.agents', 'skills');

export interface LocalSkillReport {
  name: string;
  description: string;
  folderName: string;
}

function parseSkillMd(content: string): { name: string; description: string } | null {
  if (!content.startsWith('---')) return null;
  const second = content.indexOf('---', 3);
  if (second < 0) return null;
  const frontmatter = content.slice(3, second);
  let name: string | null = null;
  let description = '';
  for (const line of frontmatter.split('\n')) {
    const nm = line.match(/^name:\s*(.+)$/);
    if (nm) name = nm[1].trim().replace(/^["']|["']$/g, '');
    const dm = line.match(/^description:\s*(.+)$/);
    if (dm) description = dm[1].trim().replace(/^["']|["']$/g, '');
  }
  if (!name) return null;
  return { name, description };
}

export function collectLocalUnsyncedSkills(): LocalSkillReport[] {
  if (!fs.existsSync(LOCAL_SKILLS_DIR)) return [];
  const skills: LocalSkillReport[] = [];
  for (const entry of fs.readdirSync(LOCAL_SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const skillMd = path.join(LOCAL_SKILLS_DIR, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillMd)) continue;
    try {
      const parsed = parseSkillMd(fs.readFileSync(skillMd, 'utf8'));
      if (parsed) skills.push({ name: parsed.name, description: parsed.description, folderName: entry.name });
    } catch {
      // skip
    }
  }
  return skills;
}

export function readAgentsMd(workspace: string | undefined): string | undefined {
  if (!workspace) return undefined;
  const p = path.join(workspace, 'AGENTS.md');
  try {
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return undefined;
    const content = fs.readFileSync(p, 'utf8');
    return content || undefined;
  } catch {
    return undefined;
  }
}
