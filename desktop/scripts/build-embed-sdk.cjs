#!/usr/bin/env node
/**
 * desktop prebuild：构建 sdk/embed 并把产物复制进 desktop/public/embed/，
 * 随 desktop vite build 打包、deploy-desktop.sh rsync 上线（最终路径 /embed/mao-chat.js）。
 *
 * 失败策略：sdk/embed 构建失败时中止 desktop build（产物缺失 = 嵌入功能不可用）。
 * 容忍场景：sdk/embed 未安装依赖（本仓独立开发 desktop 时）→ 跳过并告警，不阻断。
 */
const { execSync } = require('node:child_process');
const { existsSync, mkdirSync, copyFileSync, readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const root = resolve(__dirname, '..', '..');
const sdkDir = join(root, 'sdk', 'embed');
const distFile = join(sdkDir, 'dist', 'mao-chat.js');
const publicDir = join(root, 'desktop', 'public', 'embed');

if (!existsSync(join(sdkDir, 'package.json'))) {
  console.warn('[build-embed-sdk] sdk/embed not found, skip');
  process.exit(0);
}

if (!existsSync(join(sdkDir, 'node_modules'))) {
  console.warn('[build-embed-sdk] sdk/embed node_modules missing — run `npm install` in sdk/embed to include embed bundle, skip for now');
  process.exit(0);
}

execSync('npm run build', { cwd: sdkDir, stdio: 'inherit' });

if (!existsSync(distFile)) {
  console.error('[build-embed-sdk] dist/mao-chat.js missing after build');
  process.exit(1);
}

mkdirSync(publicDir, { recursive: true });
copyFileSync(distFile, join(publicDir, 'mao-chat.js'));
// 版本化副本（长期缓存可锁定版本；latest 供 <script> 无版本引用）
const pkg = JSON.parse(readFileSync(join(sdkDir, 'package.json'), 'utf8'));
copyFileSync(distFile, join(publicDir, `mao-chat.v${pkg.version}.js`));
console.info(`[build-embed-sdk] copied mao-chat.js + mao-chat.v${pkg.version}.js -> desktop/public/embed/`);
