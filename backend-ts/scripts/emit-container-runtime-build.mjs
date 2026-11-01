#!/usr/bin/env node
/**
 * 生成容器运行时闭包指纹 manifest（技术方案 docs/plan/2026-10-31-container-runtime-build-drift-auto-restart-technical-design.md）。
 *
 * 由 `npm run build`（tsc 之后）调用，输出 `dist/harness/container/runtime-build.json`。
 * 消费方：
 * - 容器内 runtime-agent 启动时读取，hello 帧上报 buildId；
 * - 宿主机 ContainerRegistry 读取同一份 manifest，作为「本实例加载的代码版本」比对基准。
 *
 * 闭包遍历与哈希实现在编译产物 `dist/harness/container/runtime-build.js` 里（与单测共享）。
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(scriptDir, '..');
const distDir = path.join(backendDir, 'dist');
const manifestPath = path.join(distDir, 'harness', 'container', 'runtime-build.json');

try {
  const helperUrl = pathToFileURL(path.join(distDir, 'harness', 'container', 'runtime-build.js')).href;
  const { computeContainerClosureBuild } = await import(helperUrl);
  const build = computeContainerClosureBuild(distDir);
  const manifest = {
    schema: build.schema,
    buildId: build.buildId,
    fileCount: build.fileCount,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`[container-runtime-build] ${manifest.buildId} (${manifest.fileCount} files) -> ${manifestPath}`);
} catch (e) {
  // 构建期失败优于产出缺失 manifest 的部署：宿主机将无法判断容器内代码版本
  console.error(`[container-runtime-build] failed: ${(e && e.message) || e}`);
  process.exit(1);
}
