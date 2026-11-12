#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const SECTION_ORDER = [
  '后端',
  '前端（桌面 / Web / 安卓）',
  '桌面 Electron',
  '管理后台',
  '安卓原生',
  '终端 CLI（mao-agent）',
  '终端 CLI（mao-cli）',
];

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    importLegacy: false,
    reindex: false,
    root: path.resolve(__dirname, '..'),
    date: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--import-legacy') opts.importLegacy = true;
    else if (arg === '--reindex') opts.reindex = true;
    else if (arg === '--root') opts.root = path.resolve(argv[++i] || '');
    else if (arg === '--date') opts.date = argv[++i] || '';
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else throw new Error('未知参数: ' + arg);
  }
  if (opts.date && !/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) {
    throw new Error('--date 需要 YYYY-MM-DD');
  }
  if (opts.importLegacy && opts.reindex) {
    throw new Error('--import-legacy 与 --reindex 不能同时使用');
  }
  return opts;
}

function printHelp() {
  console.log(`用法：
  changelog-cut.sh [--dry-run] [--date YYYY-MM-DD] [--root DIR]
  changelog-cut.sh --reindex [--root DIR]
  changelog-cut.sh --import-legacy [--root DIR]

把 changelog/unreleased/*.md 合成下一个版本，写入 changelog/YYYY/MM.md，并刷新根目录 CHANGELOG.md 索引。
碎片只写 ### 小节和条目，不写版本号。README.md 会被跳过。`);
}

function today() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function listMonthFiles(root) {
  const dir = path.join(root, 'changelog');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const year of fs.readdirSync(dir)) {
    if (!/^\d{4}$/.test(year)) continue;
    const yearDir = path.join(dir, year);
    if (!fs.statSync(yearDir).isDirectory()) continue;
    for (const name of fs.readdirSync(yearDir)) {
      if (!/^\d{2}\.md$/.test(name)) continue;
      out.push(path.join(yearDir, name));
    }
  }
  out.sort((a, b) => b.localeCompare(a));
  return out;
}

function listFragments(root) {
  const dir = path.join(root, 'changelog', 'unreleased');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => {
      if (!name.endsWith('.md')) return false;
      if (name.toLowerCase() === 'readme.md') return false;
      if (name.startsWith('.') || name.startsWith('_')) return false;
      return true;
    })
    .sort((a, b) => a.localeCompare(b, 'en'))
    .map((name) => path.join(dir, name));
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

function bumpVersion(version) {
  const parts = version.split('.').map(Number);
  parts[parts.length - 1] += 1;
  return parts.join('.');
}

function maxPublishedVersion(root) {
  let max = null;
  for (const file of listMonthFiles(root)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      const match = line.match(/^## (\d+(?:\.\d+)+) /);
      if (!match) continue;
      if (!max || compareVersions(match[1], max) > 0) max = match[1];
    }
  }
  return max;
}

function parseFragment(text, name) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines.some((line) => line.startsWith('## '))) {
    throw new Error(`${name} 含版本标题（## ）。碎片不要写版本号，交给 changelog-cut 分配`);
  }
  const sections = [];
  const preamble = [];
  let current = null;
  for (const line of lines) {
    const heading = line.match(/^###\s+(.+?)\s*$/);
    if (heading) {
      current = { heading: heading[1], lines: [] };
      sections.push(current);
      continue;
    }
    if (!current) {
      if (line.trim()) preamble.push(line);
      continue;
    }
    current.lines.push(line);
  }
  if (!sections.length) {
    const body = preamble.join('\n').trim();
    if (!body.split('\n').some((line) => line.startsWith('- '))) {
      throw new Error(`${name} 没有以「- 」开头的条目`);
    }
    return [{ heading: null, body }];
  }
  if (preamble.some((line) => line.startsWith('- '))) {
    throw new Error(`${name} 有条目写在 ### 小节之前`);
  }
  const out = sections
    .map((section) => ({ heading: section.heading, body: section.lines.join('\n').trim() }))
    .filter((section) => section.body);
  if (!out.length || !out.some((section) => section.body.split('\n').some((line) => line.startsWith('- ')))) {
    throw new Error(`${name} 没有以「- 」开头的条目`);
  }
  return out;
}

function mergeSections(fragments) {
  const bodies = new Map();
  const seen = [];
  for (const sections of fragments) {
    for (const section of sections) {
      const key = section.heading ?? '';
      if (!bodies.has(key)) {
        bodies.set(key, []);
        seen.push(key);
      }
      bodies.get(key).push(section.body);
    }
  }
  const keys = [...bodies.keys()].sort((a, b) => {
    if (a === '') return -1;
    if (b === '') return 1;
    const ia = SECTION_ORDER.indexOf(a);
    const ib = SECTION_ORDER.indexOf(b);
    const ra = ia === -1 ? SECTION_ORDER.length + seen.indexOf(a) : ia;
    const rb = ib === -1 ? SECTION_ORDER.length + seen.indexOf(b) : ib;
    return ra - rb;
  });
  return keys.map((key) => ({
    heading: key === '' ? null : key,
    body: bodies.get(key).map((body) => body.trim()).filter(Boolean).join('\n'),
  }));
}

function renderBlock(version, date, sections) {
  const lines = [`## ${version} (${date})`, ''];
  for (const section of sections) {
    if (section.heading) lines.push(`### ${section.heading}`);
    lines.push(section.body);
    lines.push('');
  }
  return lines.join('\n').replace(/\n+$/, '\n');
}

function upsertMonth(root, date, block) {
  const ym = date.slice(0, 7);
  const [year, month] = ym.split('-');
  const dir = path.join(root, 'changelog', year);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${month}.md`);
  let rest = '';
  if (fs.existsSync(file)) {
    rest = fs.readFileSync(file, 'utf8').replace(/^#[^\n]*\n+/, '');
  }
  const body = rest.trim() ? `${block.trim()}\n\n${rest.trim()}\n` : `${block.trim()}\n`;
  fs.writeFileSync(file, `# ${ym}\n\n${body}`);
  return file;
}

function renderIndex(root) {
  const files = listMonthFiles(root);
  const lines = [
    '# 更新日志',
    '',
    '开发期不要改本文件。用户可见改动写到 [`changelog/unreleased/`](changelog/unreleased/README.md)；打包、发版或 OTA 前在 main 上运行 `./scripts/changelog-cut.sh`。',
    '',
  ];
  if (!files.length) {
    lines.push('还没有已发布版本。', '');
    return lines.join('\n');
  }
  const first = fs.readFileSync(files[0], 'utf8');
  const latest = first.match(/^## (\S+) \(([^)]+)\)/m);
  if (latest) lines.push(`最新版本：${latest[1]}（${latest[2]}）`, '');
  lines.push('已发布记录按月归档，新版本在当月文件顶部：', '');
  for (const file of files) {
    const year = path.basename(path.dirname(file));
    const month = path.basename(file, '.md');
    lines.push(`- [${year}-${month}](changelog/${year}/${month}.md)`);
  }
  lines.push('');
  return lines.join('\n');
}

function writeIndex(root) {
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), renderIndex(root));
}

function importLegacy(root) {
  const changelogPath = path.join(root, 'CHANGELOG.md');
  if (!fs.existsSync(changelogPath)) throw new Error('找不到 CHANGELOG.md');
  const text = fs.readFileSync(changelogPath, 'utf8');
  if (!/^## /m.test(text)) {
    console.log('CHANGELOG.md 不含版本标题，无需导入');
    return;
  }
  if (listMonthFiles(root).length) {
    throw new Error('changelog/ 里已有月份文件，为避免重复导入已停止');
  }
  const parts = text.split(/(?=^## )/m).filter((part) => part.startsWith('## '));
  if (parts.join('') !== text) {
    throw new Error('CHANGELOG.md 不是以版本标题开头的纯列表，已停止导入');
  }
  const groups = new Map();
  for (const part of parts) {
    const match = part.match(/^## \S+ \((\d{4})-(\d{2})-\d{2}\)/);
    if (!match) throw new Error('无法解析日期:\n' + part.slice(0, 80));
    const ym = `${match[1]}-${match[2]}`;
    if (!groups.has(ym)) groups.set(ym, []);
    groups.get(ym).push(part);
  }
  const flat = [...groups.values()].flat().map((part) => part.replace(/\s+$/, ''));
  const source = parts.map((part) => part.replace(/\s+$/, ''));
  if (flat.slice().sort().join('\0') !== source.slice().sort().join('\0')) {
    throw new Error('按月归并后条目丢失，已停止导入');
  }
  for (const [ym, chunks] of groups) {
    const [year, month] = ym.split('-');
    const dir = path.join(root, 'changelog', year);
    fs.mkdirSync(dir, { recursive: true });
    let body = chunks.join('');
    if (!body.endsWith('\n')) body += '\n';
    fs.writeFileSync(path.join(dir, `${month}.md`), `# ${ym}\n\n${body}`);
  }
  writeIndex(root);
  console.log(`已按月归档 ${parts.length} 个版本，写入 ${groups.size} 个月份文件`);
}

function cut(root, opts) {
  const files = listFragments(root);
  if (!files.length) {
    console.log('没有未发布碎片，未分配新版本');
    return;
  }
  const parsed = files.map((file) => parseFragment(fs.readFileSync(file, 'utf8'), path.basename(file)));
  const sections = mergeSections(parsed);
  const current = maxPublishedVersion(root);
  const version = current ? bumpVersion(current) : '0.0.1';
  const date = opts.date || today();
  const block = renderBlock(version, date, sections);
  const ym = date.slice(0, 7);
  const [year, month] = ym.split('-');
  const rel = `changelog/${year}/${month}.md`;
  const names = files.map((file) => path.basename(file));
  if (opts.dryRun) {
    console.log(`[dry-run] 将写入 ${rel} ，版本 ${version}（${date}）`);
    console.log('收录碎片：');
    for (const name of names) console.log('  ' + name);
    console.log('');
    console.log(block.trimEnd());
    return;
  }
  upsertMonth(root, date, block);
  writeIndex(root);
  for (const file of files) fs.unlinkSync(file);
  console.log(`已写入 ${rel} ，版本 ${version}（${date}），收录 ${names.length} 个碎片`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }
  if (opts.importLegacy) {
    if (opts.dryRun) throw new Error('--import-legacy 不支持 --dry-run');
    importLegacy(opts.root);
    return;
  }
  if (opts.reindex) {
    if (opts.dryRun) {
      process.stdout.write(renderIndex(opts.root));
      return;
    }
    writeIndex(opts.root);
    console.log('已刷新 CHANGELOG.md 索引');
    return;
  }
  cut(opts.root, opts);
}

try {
  main();
} catch (err) {
  console.error(err.message || err);
  process.exit(1);
}
