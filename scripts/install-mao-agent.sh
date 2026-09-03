#!/usr/bin/env bash
# 一键安装 mao-agent（Node.js ≥ 20、git、npm）。
#   curl -fsSL https://raw.githubusercontent.com/DC-ET/mao/main/scripts/install-mao-agent.sh | bash
# 指定版本 / 源码：
#   curl -fsSL ... | MAO_AGENT_REF=v0.0.38 bash
#   MAO_AGENT_SRC=/path/to/mao bash scripts/install-mao-agent.sh
set -euo pipefail

REPO="${MAO_AGENT_REPO:-https://github.com/DC-ET/mao.git}"
REF="${MAO_AGENT_REF:-main}"
WORKDIR="${MAO_AGENT_WORKDIR:-${HOME}/.mao/agent-cli/src}"
SRC="${MAO_AGENT_SRC:-}"

die() {
  echo "mao-agent 安装失败: $*" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || die "未找到 node，请先安装 Node.js ≥ 20：https://nodejs.org/"
command -v npm >/dev/null 2>&1 || die "未找到 npm"
NODE_MAJOR="$(node -p 'parseInt(process.versions.node, 10)')"
if [[ "${NODE_MAJOR}" -lt 20 ]]; then
  die "需要 Node.js ≥ 20，当前 $(node -v)"
fi

resolve_pkg() {
  if [[ -n "${SRC}" ]]; then
    if [[ -f "${SRC}/package.json" && -f "${SRC}/bin/mao-agent.js" ]]; then
      echo "${SRC}"
      return
    fi
    if [[ -f "${SRC}/agent-cli/package.json" ]]; then
      echo "${SRC}/agent-cli"
      return
    fi
    die "MAO_AGENT_SRC=${SRC} 下找不到 agent-cli"
  fi

  command -v git >/dev/null 2>&1 || die "未找到 git"
  mkdir -p "$(dirname "${WORKDIR}")"
  if [[ -d "${WORKDIR}/.git" ]]; then
    echo "更新 ${WORKDIR} (${REF}) ..." >&2
    git -C "${WORKDIR}" fetch --depth 1 origin "${REF}"
    git -C "${WORKDIR}" checkout --force FETCH_HEAD
    git -C "${WORKDIR}" sparse-checkout set agent-cli >/dev/null 2>&1 || true
  else
    rm -rf "${WORKDIR}" >/dev/null
    echo "克隆 ${REPO} (${REF}) → ${WORKDIR} ..." >&2
    git clone --depth 1 --filter=blob:none --sparse --branch "${REF}" "${REPO}" "${WORKDIR}"
    git -C "${WORKDIR}" sparse-checkout set agent-cli
  fi
  echo "${WORKDIR}/agent-cli"
}

PKG="$(resolve_pkg)"
[[ -f "${PKG}/package.json" ]] || die "未找到 ${PKG}/package.json"

echo "安装 ${PKG} ..." >&2
cd "${PKG}"
if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi
npm run build
# 覆盖旧的 npm link / 上次全局安装，方便重复执行升级
npm install -g . --force

BIN="$(command -v mao-agent || true)"
[[ -n "${BIN}" ]] || die "npm install -g 成功，但 PATH 里没有 mao-agent。若使用 nvm，请新开一个终端或检查 npm prefix。"

echo
echo "已安装: ${BIN}"
"${BIN}" --version
echo "下一步: mao-agent login   # 然后 mao-agent 或 mao-agent --local"
