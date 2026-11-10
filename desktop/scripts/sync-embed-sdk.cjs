#!/usr/bin/env node
/**
 * desktop 构建前的 Embed SDK 产物同步（不再构建 sdk/embed）。
 *
 * 产物链路由「每次构建 sdk/embed」改为「工作区构建并提交 git」：
 *   - 改 SDK 源码后在 sdk/embed 跑 `npm run build`，产物复制进
 *     desktop/public/embed/（mao-chat.js + mao-chat.v{version}.js）并提交；
 *   - CI 的 embed-sdk job 会重新构建并比对 sha256，防止源码与产物漂移；
 *   - desktop build / 部署只消费 git 里的产物，本脚本负责把它同步进
 *     desktop/dist/embed/，随 vite build 打包、由 /embed/ 路径上线。
 *
 * 同步源（优先级从高到低）：
 *   1. desktop/public/embed/mao-chat.js —— git 里的产物，正常路径；
 *   2. sdk/embed/dist/mao-chat.js       —— 未提交但本地已构建，兜底。
 * 两者都缺失即报错退出：缺产物 = 嵌入功能不可用，不应静默出一个坏包。
 */
const { existsSync, mkdirSync, copyFileSync, readFileSync, readdirSync } = require('node:fs');
const { join, resolve } = require('node:path');

const root = resolve(__dirname, '..', '..');
const sdkDir = join(root, 'sdk', 'embed');
const publicDir = join(root, 'desktop', 'public', 'embed');
const distDir = join(root, 'desktop', 'dist', 'embed');

if (!existsSync(join(sdkDir, 'package.json'))) {
  console.warn('[sync-embed-sdk] sdk/embed not found, skip');
  process.exit(0);
}

const pkg = JSON.parse(readFileSync(join(sdkDir, 'package.json'), 'utf8'));
const version = pkg.version;

// 产物文件清单：latest 副本 + 版本锁定副本（nginx 对版本副本长缓存）
const artifacts = [`mao-chat.js`, `mao-chat.v${version}.js`];

let source = null;
if (existsSync(join(publicDir, 'mao-chat.js'))) {
  source = publicDir;
} else if (existsSync(join(sdkDir, 'dist', 'mao-chat.js'))) {
  source = join(sdkDir, 'dist');
  console.warn(
    `[sync-embed-sdk] desktop/public/embed/mao-chat.js 缺失，回退到 sdk/embed/dist（未提交产物）；` +
      `请提交 desktop/public/embed/*.js`
  );
} else {
  console.error(
    '[sync-embed-sdk] 未找到 Embed SDK 产物：desktop/public/embed/ 与 sdk/embed/dist/ 均无 mao-chat.js\n' +
      '改 SDK 源码后需在 sdk/embed 跑 npm run build 并提交产物，' +
      '详见 skills/mao-cli/reference/embed-sdk.md'
  );
  process.exit(1);
}

mkdirSync(distDir, { recursive: true });

for (const name of artifacts) {
  const from = join(source, name);
  if (!existsSync(from)) {
    console.error(`[sync-embed-sdk] 同步源缺少产物 ${name}（version=${version}）`);
    process.exit(1);
  }
  copyFileSync(from, join(distDir, name));
}

// 图标与历史版本副本：保持随版本长期可引用，一并同步（缺失不阻断）
if (existsSync(publicDir)) {
  for (const name of readdirSync(publicDir)) {
    if (artifacts.includes(name)) continue;
    const from = join(publicDir, name);
    if (existsSync(join(distDir, name))) continue;
    copyFileSync(from, join(distDir, name));
  }
}

console.info(
  `[sync-embed-sdk] 同步 ${artifacts.join(' + ')}（v${version}）-> desktop/dist/embed/（源：${source}）`
);
