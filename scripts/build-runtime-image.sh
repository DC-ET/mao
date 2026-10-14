#!/usr/bin/env bash
# 构建 Mao 用户运行时容器镜像 mao-runtime:<tag>（技术方案 §6 部署）。
#
# 前置：宿主机已安装 Docker；在仓库根目录执行。
# sharp / node-pty 版本自动取自 backend-ts/package.json，保证与后端依赖一致；
# 镜像内 Node 版本由 FROM 固定（node:22），宿主机 Node 升级后必须同步重建镜像。
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${MAO_RUNTIME_IMAGE:-mao-runtime}"
TAG="${1:-latest}"

if ! command -v docker >/dev/null 2>&1; then
  echo "错误：未检测到 docker 命令，请先安装 Docker" >&2
  exit 1
fi

SHARP_VERSION="$(node -e "console.log(require('${ROOT_DIR}/backend-ts/package.json').dependencies.sharp || 'latest')")"
NODE_PTY_VERSION="$(node -e "console.log(require('${ROOT_DIR}/backend-ts/package.json').dependencies['node-pty'] || 'latest')")"
echo "构建 ${IMAGE}:${TAG}（sharp=${SHARP_VERSION}, node-pty=${NODE_PTY_VERSION}）"

docker build \
  --build-arg SHARP_VERSION="${SHARP_VERSION}" \
  --build-arg NODE_PTY_VERSION="${NODE_PTY_VERSION}" \
  -f "${ROOT_DIR}/Dockerfile.runtime" \
  -t "${IMAGE}:${TAG}" \
  "${ROOT_DIR}"

# 默认 tag 与 MAO_CONTAINER_IMAGE（mao-runtime:latest）对齐
docker tag "${IMAGE}:${TAG}" "${IMAGE}:latest"
echo "完成：${IMAGE}:${TAG}（已同步 tag ${IMAGE}:latest）"
