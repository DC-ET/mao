# 运行时镜像预装 Chrome 与 lark-cli 二进制：可行性评估

> 状态：评估完成；落地方案已定并已上线（2026-10-31）：**宿主机 overlay 定制层**——仅本部署生效、不改仓库、不影响开源用户（文件与操作见 §4.5）。镜像已含 Chrome 156 / lark-cli 1.0.98 / 中文字体 / playwright-cli 0.1.22 / Java 17 + Maven；容器 HOME 与 Java `user.home` 对齐（0.0.392，见 §4.5）随部署 + 容器重建生效
> 日期：2026-10-31
> 关联：[2026-10-30-runtime-image-dependency-alignment-technical-design.md](2026-10-30-runtime-image-dependency-alignment-technical-design.md)（镜像依赖对齐 D1–D7；本方案是其「镜像内容扩充」的具体落点）、[2026-10-14-user-runtime-container-isolation-design.md](2026-10-14-user-runtime-container-isolation-design.md)
> 一句话：Chrome（无头浏览器）与 lark-cli 官方二进制都不该由每个会话现下，应固化进 `mao-runtime` 镜像；实测可行，增量约 650 MB，技能侧零改动。落地形态选 overlay：上游镜像定义升级可自动继承，无需合并 diff。

---

## 1. 问题

docker 模式下用户容器以 `mao-runtime:latest` 启动，容器内 `/usr/local` 全部来自镜像层。容器一旦重建（宿主机重启、`docker run` 重建、运维回收后重建），容器内临时安装的东西全部丢失：

- playwright 依赖的系统 Chrome（`/opt/google/chrome/chrome`）消失 → 浏览器自动化不可用；
- lark-cli 官方二进制（`/usr/local/lib/lark-cli/lark-cli`）消失 → PATH 上的 shim 报 `BIN_MISSING: spawn /usr/local/lib/lark-cli/lark-cli ENOENT`。

**2026-10-31 实测复现**：本会话容器在 05:23 重建（hostname `9d4f1519f2d2` → `49599ff5d1f6`），上述两项均丢失；而用户 `deps` 持久目录里的 lark-cli shim 仍在（`/opt/mao-data/deps/{userId}/npm/bin/lark-cli`），说明「shim 持久、官方二进制易失」的错配就是根因。

每次新会话首用都要现下：Chrome deb 139 MB、lark-cli tar 14.7 MB，叠加外网依赖与等待。

---

## 2. 结论

| 方案 | 结论 |
|---|---|
| **A. 镜像预装** | **推荐**。实测可构建、可运行、技能零改动。落地形态二选一：**A1（本部署已定）宿主机 overlay 定制层**——不改仓库、不影响开源用户，见 §4.5；**A2 改仓库 `Dockerfile.runtime`**——惠及所有部署者，见 §4.1–4.4。 |
| B. 容器启动脚本幂等安装 | **否决**。与容器启动超时约束冲突，异步则首用竞态；每容器重复下载 140 MB+，依赖运行时外网。 |
| C. 持久目录（`deps/{userId}`） | **仅作兜底**。lark-cli 可放持久目录（shim 支持 `LARK_CLI_BIN` 覆盖）；Chrome 因系统库依赖无法干净持久化。 |

---

## 3. 实测数据（2026-10-31，在 `node:22-bookworm-slim` 派生容器内实测）

### 3.1 Chrome

| 项 | 实测值 |
|---|---|
| deb 下载 | `google-chrome-stable_current_amd64.deb` 139 MB，约 3 s（`dl.google.com` HTTP 200） |
| 依赖规模 | `--no-install-recommends` 仍需 **103 个包**（deb 的 Depends 含 `xdg-utils`→x11/perl 一族、`libgtk-3-0`→gtk 体系、`wget`、`systemd` 等） |
| 磁盘增量 | **+600 MB**（其中 `/opt/google/chrome` 447 MB，其余为依赖库） |
| 安装后版本 | `Google Chrome 156.0.8078.79` |
| 运行冒烟 | `--headless=new --no-sandbox --dump-dom about:blank` 正常输出 DOM（仅 dbus 告警，无影响） |
| 固定版本 URL | `https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_156.0.8078.79-1_amd64.deb` → HTTP 200，可按版本钉死 |

> 首次运行前无需再装依赖：`dist` 里的 playwright 技能配置为 `channel: "chrome"`（`skills/playwright/scripts/cli.config.json`），直接命中 `/opt/google/chrome/chrome`。

### 3.2 lark-cli

| 项 | 实测值 |
|---|---|
| 镜像源 | `registry.npmmirror.com/-/binary/lark-cli/v{版本}/` 完整镜像（v1.0.0 → **v1.0.98** 最新） |
| 资产 | `lark-cli-1.0.98-linux-amd64.tar.gz` 14.7 MB + 同目录 `checksums.txt`（SHA-256 校验通过） |
| 安装体积 | 解压后二进制 49 MB，`/usr/local/lib/lark-cli` 目录 **47 MB** |
| 运行 | `/usr/local/lib/lark-cli/lark-cli --version` → `lark-cli version 1.0.98` |
| **shim 链路** | 预装后 `lark-cli --version`（走 deps 持久目录的 shim → ECP→UAT 注入 → 镜像内真实二进制）→ **`lark-cli version 1.0.98`，零改动打通** |
| 技能安装脚本 | `skills/lark-cli-skill/scripts/install-lark-cli.sh` 已有「目标路径已存在且版本一致 → 跳过」逻辑，镜像预装后第 1 步自动短路 |

### 3.3 可选：中文字体

`fonts-noto-cjk`：deb 56.5 MB / 安装后 **91 MB**。不加则 playwright 截图/PDF 中文全是豆腐块（当前镜像 `fc-list` 为空、`/usr/share/fonts` 无内容）。

### 3.4 体积与耗时汇总

| 项 | 增量 |
|---|---|
| Chrome（含依赖） | ~600 MB |
| lark-cli 二进制 | ~47 MB |
| fonts-noto-cjk（可选） | ~91 MB |
| 构建耗时 | 预估 +1–2 分钟（一次性） |
| 每容器额外占用 | **0**（镜像层由所有容器共享，不按容器复制） |

---

## 4. 方案 A：具体做法（A2 改仓库形态）

> 本部署不采用本节形态（改用 §4.5 overlay 定制层）；本节保留给「希望所有部署者都带上」以及上游正式升级的场景。

### 4.1 `Dockerfile.runtime` 改动

```dockerfile
# ── 新增 build args ──
ARG CHROME_DEB_URL=https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_156.0.8078.79-1_amd64.deb
ARG LARK_CLI_VERSION=1.0.98
ARG INSTALL_CJK_FONTS=true

# ── Chrome（playwright channel:chrome 直接命中 /opt/google/chrome/chrome）──
RUN curl -fsSL -o /tmp/google-chrome.deb "${CHROME_DEB_URL}" \
  && apt-get install -y --no-install-recommends /tmp/google-chrome.deb \
  && rm -f /tmp/google-chrome.deb \
  && rm -rf /var/lib/apt/lists/*

# ── 中文字体（可选，截图/PDF 中文渲染）──
RUN if [ "${INSTALL_CJK_FONTS}" = "true" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends fonts-noto-cjk \
      && rm -rf /var/lib/apt/lists/*; \
    fi

# ── lark-cli 官方二进制（sha256 校验；PATH 入口由技能 shim 提供）──
RUN mkdir -p /tmp/lark && cd /tmp/lark \
  && ARCHIVE="lark-cli-${LARK_CLI_VERSION}-linux-amd64.tar.gz" \
  && BASE="https://registry.npmmirror.com/-/binary/lark-cli/v${LARK_CLI_VERSION}" \
  && curl -fsSL -o "${ARCHIVE}" "${BASE}/${ARCHIVE}" \
  && curl -fsSL -o checksums.txt "${BASE}/checksums.txt" \
  && grep -F "${ARCHIVE}" checksums.txt | sha256sum -c \
  && tar -xzf "${ARCHIVE}" \
  && mkdir -p /usr/local/lib/lark-cli \
  && install -m 0755 lark-cli /usr/local/lib/lark-cli/lark-cli \
  && rm -rf /tmp/lark \
  && /usr/local/lib/lark-cli/lark-cli --version
```

要点：

1. **Chrome 用固定版本 deb URL**（可复现；升级时改 ARG 或 build-runtime-image.sh 传参），不用 `_current` 滚动包。
2. **`--no-install-recommends`**：默认安装会额外拉 `zutty`、`x11-utils`、perl LWP 等，必须显式关闭。
3. **`sha256sum -c` 依赖文件名匹配**：下载时保留原始 `ARCHIVE` 名，不要重命名。
4. **不写 `/usr/local/bin/lark-cli` wrapper**：PATH 入口继续由技能 shim 负责（现有安装流程 `npm install . -g` 装到 deps 持久目录）；镜像只提供「易失的官方二进制」，避免两套入口打架。
5. Dockerfile 顶部注释的「依赖清单」说明同步更新，明确镜像现在还包含 Chrome 与 lark-cli。

### 4.2 `scripts/build-runtime-image.sh` 改动

- 新增可覆盖环境变量：`CHROME_DEB_URL`、`LARK_CLI_VERSION`、`INSTALL_CJK_FONTS`，透传 `--build-arg`；
- 构建日志打印这三个值（便于回溯「某次镜像里是什么版本」）；
- 构建成功后提示：「镜像已更新，**已存在容器需重建才会生效**（容器管理 → 重建全部）」。

### 4.3 生效链路（关键）

```
改 Dockerfile → bash scripts/build-runtime-image.sh → 重建用户容器 → 生效
```

**镜像更新不会自动应用到已运行容器**：`docker start` 复用旧容器（旧镜像层）。当前 `reapExpired()` 只做 stop/start，不做镜像比对。可选增强见 §7。

### 4.4 技能侧影响：零改动（已验证）

| 技能 | 依赖点 | 预装后 |
|---|---|---|
| playwright | `cli.config.json` → `channel: "chrome"` | 直接命中 `/opt/google/chrome/chrome` |
| lark-cli | shim → `LARK_CLI_BIN \|\| /usr/local/lib/lark-cli/lark-cli` | 直接命中，无需 `npm install`（二进制层） |

### 4.5 本部署落地形态（A1，2026-10-31 定）：宿主机 overlay 定制层

> 决策：**不改仓库**（开源用户构建出的镜像保持官方原样），在宿主机 `/data/runtime-image-ext/` 维护 overlay 定制层 + 一键重建脚本。文件不进 git；上游对 `Dockerfile.runtime` 的任何升级在「重建基础镜像」一步自动继承，overlay **不需要合并任何 diff**。

```
官方基础层：bash /opt/mao/scripts/build-runtime-image.sh                    → mao-runtime:latest
定制层    ：docker build -f /data/runtime-image-ext/Dockerfile.runtime.ext    → mao-runtime:latest（覆盖 tag）
生效      ：管理后台「容器管理 → 重建全部」
```

#### 文件 1：`/data/runtime-image-ext/Dockerfile.runtime.ext`

```dockerfile
# Mao 运行时镜像 · 本部署定制层（overlay）
#
# 基于官方构建产物 mao-runtime:latest 叠加两类「易失二进制」：
#   1) Google Chrome —— playwright 技能 channel:chrome 依赖（/opt/google/chrome/chrome）
#   2) lark-cli 官方二进制 —— lark-cli 技能 shim 依赖（/usr/local/lib/lark-cli/lark-cli）
# 两者原先装在容器内 /usr/local，容器重建即丢；本层把它们固化到镜像，随容器恢复。
#
# 由 /data/runtime-image-ext/rebuild-runtime-image.sh 调用；本文件不进入 git 仓库（仅本部署生效）。
# 评估与操作说明：docs/plan/2026-10-31-runtime-image-preinstall-chrome-lark-cli.md
FROM mao-runtime:latest

# Chrome 固定版本 deb（升级：改默认值，或构建时传 CHROME_DEB_URL）
ARG CHROME_DEB_URL=https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_156.0.8078.79-1_amd64.deb
# lark-cli 版本（镜像源 registry.npmmirror.com，sha256 校验）
ARG LARK_CLI_VERSION=1.0.98
# 中文字体（playwright 截图/PDF 中文渲染；false 可跳过）
ARG INSTALL_CJK_FONTS=true

LABEL org.mao.runtime.ext="chrome+lark-cli"

# ── 1. Chrome（--no-install-recommends 必加：默认会多拉 zutty/x11-utils 等）──
RUN curl -fsSL -o /tmp/google-chrome.deb "${CHROME_DEB_URL}" \
  && apt-get update \
  && apt-get install -y --no-install-recommends /tmp/google-chrome.deb \
  && rm -f /tmp/google-chrome.deb \
  && rm -rf /var/lib/apt/lists/*

# ── 2. 中文字体（可选）──
RUN if [ "${INSTALL_CJK_FONTS}" = "true" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends fonts-noto-cjk \
      && rm -rf /var/lib/apt/lists/*; \
    fi

# ── 3. lark-cli 官方二进制（sha256 校验；PATH 入口由技能 shim 提供，此处不写 wrapper）──
RUN mkdir -p /tmp/lark && cd /tmp/lark \
  && ARCHIVE="lark-cli-${LARK_CLI_VERSION}-linux-amd64.tar.gz" \
  && BASE="https://registry.npmmirror.com/-/binary/lark-cli/v${LARK_CLI_VERSION}" \
  && curl -fsSL -o "${ARCHIVE}" "${BASE}/${ARCHIVE}" \
  && curl -fsSL -o checksums.txt "${BASE}/checksums.txt" \
  && grep -F "${ARCHIVE}" checksums.txt | sha256sum -c - \
  && tar -xzf "${ARCHIVE}" \
  && mkdir -p /usr/local/lib/lark-cli \
  && install -m 0755 lark-cli /usr/local/lib/lark-cli/lark-cli \
  && rm -rf /tmp/lark \
  && /usr/local/lib/lark-cli/lark-cli --version

# ── 4. playwright-cli（全局安装：技能 wrapper 优先使用它，避免容器重建后 npx 现拉）──
# 系统 Chrome 已装，不需要 playwright 自带浏览器：跳过 postinstall 的浏览器下载。
# 装包走 npmmirror（官方源实测慢 6 倍）；实测 2s / 19MB。
ARG PLAYWRIGHT_CLI_VERSION=0.1.22
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install -g --no-audit --no-fund --registry=https://registry.npmmirror.com "@playwright/cli@${PLAYWRIGHT_CLI_VERSION}" \
  && npm cache clean --force \
  && playwright-cli --version

# ── 5. pip 国内源（默认 pypi.org：docker 网络实测 ReadTimeout 52s；aliyun 源 0-1s）──
RUN printf '[global]\nindex-url = https://mirrors.aliyun.com/pypi/simple/\ntrusted-host = mirrors.aliyun.com\n' > /etc/pip.conf

# ── 6. npm 国内源（默认 registry.npmjs.org 装小包 12s，npmmirror 1s）──
# 写 npm 的 builtin npmrc（npm 安装目录内）：穿透 NPM_CONFIG_PREFIX（deps 持久化把 globalconfig
# 挪走后 user/global 两处都不生效）与 HOME 对齐；用户自己的 .npmrc / 项目配置仍优先。
RUN printf 'registry=https://registry.npmmirror.com\n' > /usr/local/lib/node_modules/npm/npmrc \
  && npm config get registry \
  && HOME=/tmp/npm-probe-home NPM_CONFIG_PREFIX=/tmp/npm-probe npm config get registry

# ── 7. Java 17 + Maven（容器内 Java 项目构建；.m2 配置与本地仓库在用户目录，走容器 HOME 对齐）──
RUN apt-get update \
  && apt-get install -y --no-install-recommends openjdk-17-jdk-headless maven \
  && rm -rf /var/lib/apt/lists/* \
  && java -version \
  && mvn -version
```

#### 文件 2：`/data/runtime-image-ext/rebuild-runtime-image.sh`

```bash
#!/usr/bin/env bash
# 重建 mao-runtime 镜像 = 官方基础层 + 本部署定制层（Chrome / lark-cli / 中文字体）
#
# 用法（宿主机执行）：
#   bash /data/runtime-image-ext/rebuild-runtime-image.sh
#   CHROME_DEB_URL=<新版本 deb URL> bash .../rebuild-runtime-image.sh   # 升级 Chrome
#   LARK_CLI_VERSION=1.0.99 bash .../rebuild-runtime-image.sh           # 升级 lark-cli
#   PLAYWRIGHT_CLI_VERSION=0.1.23 bash .../rebuild-runtime-image.sh     # 升级 playwright-cli
#   INSTALL_CJK_FONTS=false bash .../rebuild-runtime-image.sh           # 跳过中文字体
#   APT_MIRROR=deb.debian.org bash .../rebuild-runtime-image.sh         # 需要时覆盖（默认 mirrors.aliyun.com：本机实测 deb.debian.org 过慢）
#
# 完整链路：代码升级（deploy-mao.sh）→ 本脚本（重建镜像）→ 管理后台「容器管理 → 重建全部」
# 失败语义：定制层构建失败时 mao-runtime:latest 停在新基础版（无定制），失败显性、不静默；修好后重跑即可。
set -euo pipefail

MAO_DIR="${MAO_DIR:-/opt/mao}"
EXT_DIR="${EXT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
EXT_DOCKERFILE="${EXT_DIR}/Dockerfile.runtime.ext"

# 本部署构建机实测 deb.debian.org 过慢（apt 阶段超过 15 分钟），默认走阿里云源；
# 需要时以 APT_MIRROR=... 覆盖（透传给官方 build-runtime-image.sh）。
export APT_MIRROR="${APT_MIRROR:-mirrors.aliyun.com}"

[ -f "${EXT_DOCKERFILE}" ] || { echo "缺少 ${EXT_DOCKERFILE}" >&2; exit 1; }
[ -d "${MAO_DIR}/.git" ] || { echo "${MAO_DIR} 不是 git 检出，请检查 MAO_DIR" >&2; exit 1; }

echo "==> [1/3] 官方基础层：重建 mao-runtime:latest（继承仓库最新镜像定义）"
(cd "${MAO_DIR}" && bash scripts/build-runtime-image.sh)

echo "==> [2/3] 定制层：叠加 Chrome + lark-cli + 中文字体"
build_args=()
if [ -n "${CHROME_DEB_URL:-}" ]; then build_args+=(--build-arg "CHROME_DEB_URL=${CHROME_DEB_URL}"); fi
if [ -n "${LARK_CLI_VERSION:-}" ]; then build_args+=(--build-arg "LARK_CLI_VERSION=${LARK_CLI_VERSION}"); fi
if [ -n "${INSTALL_CJK_FONTS:-}" ]; then build_args+=(--build-arg "INSTALL_CJK_FONTS=${INSTALL_CJK_FONTS}"); fi
if [ -n "${PLAYWRIGHT_CLI_VERSION:-}" ]; then build_args+=(--build-arg "PLAYWRIGHT_CLI_VERSION=${PLAYWRIGHT_CLI_VERSION}"); fi
docker build "${build_args[@]}" -f "${EXT_DOCKERFILE}" -t mao-runtime:latest "${EXT_DIR}"
docker tag mao-runtime:latest "mao-runtime:ext-$(date +%Y%m%d-%H%M%S)"

echo "==> [3/3] 冒烟：验证定制层内容"
docker run --rm mao-runtime:latest sh -c '/opt/google/chrome/chrome --version && /usr/local/lib/lark-cli/lark-cli --version'

echo
echo "完成。存量容器不会自动换用新镜像，请到管理后台「容器管理 → 重建全部」。"
echo "（查看在册用户容器：docker ps --filter name=mao-user- --format '{{.Names}}'）"
```

#### 首次部署（宿主机）

```bash
# 两个文件就位后（本会话工作区 docs/runtime-image-ext/ 有副本，源路径见 §8）
bash /data/runtime-image-ext/rebuild-runtime-image.sh
# 然后：管理后台 → 容器管理 → 重建全部（存量容器不会自动换镜像）
```

#### 升级与日常维护

| 场景 | 操作 |
|---|---|
| 上游升级镜像定义（新依赖 / Node 升级 / 新增系统包） | 正常部署（`deploy-mao.sh`）后跑一次 `rebuild-runtime-image.sh`，定制层自动继承；再「重建全部」 |
| 升级 Chrome | `CHROME_DEB_URL=<新版本 deb URL> bash .../rebuild-runtime-image.sh`（或改 Dockerfile.ext 默认 ARG） |
| 升级 lark-cli | `LARK_CLI_VERSION=1.0.99 bash .../rebuild-runtime-image.sh`（建议同步改技能脚本 `install-lark-cli.sh` 的默认版本） |
| 升级 playwright-cli | `PLAYWRIGHT_CLI_VERSION=0.1.23 bash .../rebuild-runtime-image.sh`（或改 Dockerfile.ext 默认 ARG） |
| 跳过中文字体 | `INSTALL_CJK_FONTS=false bash .../rebuild-runtime-image.sh` |
| apt 源 | 默认 `mirrors.aliyun.com`（本机实测 deb.debian.org 过慢）；`APT_MIRROR=deb.debian.org bash ...` 可切回 |

#### 容器内安装软件的网络（2026-10-31 实测）

| 渠道 | 源 | 实测速度 |
|---|---|---|
| apt | `mirrors.aliyun.com`（镜像内 sources） | `apt-get update` 2s、装小包 1s |
| pip | `mirrors.aliyun.com`（镜像内 `/etc/pip.conf`） | 装 six 0–1s（**默认 pypi.org 会 ReadTimeout 52s**，故固化国内源） |
| npm | `registry.npmmirror.com`（镜像内 npm **builtin npmrc**，穿透 `NPM_CONFIG_PREFIX` / HOME 变更，用户级 `.npmrc` 仍优先） | 装小包 1s（默认 npmjs 12s） |
| playwright-cli | 镜像内全局预装（0.1.22），`command -v playwright-cli` 直接命中，不再 npx 现拉 | — |

#### 配套：容器 HOME 与 Java `user.home` 对齐（0.0.392）

`~/.npmrc`、`.gitconfig` 这类直接读 `$HOME` 的工具，容器内 agent shell 原本就由 `ShellSessionManager.configureUserHome` 对齐到 `/opt/mao-data/users/{userId}`；但 **Java 在 Linux 上经 getpwuid 取 `user.home`（不认 `$HOME`）**，Maven / Gradle 的 `~/.m2`、`~/.gradle` 会落到容器内 `/root`（容器重建即丢，且读不到用户目录里挂载的 `settings.xml`）。0.0.392 做了两处对齐（见 CHANGELOG）：

1. 容器创建注入 `HOME=/opt/mao-data/users/{userId}`（覆盖容器级进程、MCP 子进程等非 shell 场景）；
2. `runtime-agent` 启动入口把 `/etc/passwd` 中 root 的 home 幂等对齐到同一路径（Java 生效；失败仅告警不阻塞启动）。

效果：容器内 `mvn` 的 `settings.xml`（私服 mirror）与 `~/.m2/repository` 本地仓库、npm 凭据、`.cache` 全部落在持久挂载的用户目录，与宿主机模式语义一致。

#### 注意事项

1. **每次重建镜像后必须「重建全部」**：镜像更新不会自动应用到已存在容器（`docker start` 复用旧容器）。
2. **唯一的人工适配点**：若上游把「镜像重建/依赖对齐」自动化进部署流程（依赖对齐方案 D5：构建到临时 tag → 冒烟 → re-tag `latest`），会用基础版覆盖 `latest`，届时需把本 overlay 挂进该链路。
3. **失败语义**：overlay 构建失败（如 Chrome deb URL 失效）时，`latest` 停在新基础版（无定制），失败显性、不静默；修好重跑即可。
4. **docker build 上下文**：定制层构建上下文就是 `/data/runtime-image-ext/`（只有 Dockerfile），不会打包 `/data` 或仓库，构建快。
5. **历史 tag**：每次构建留一个 `mao-runtime:ext-<时间戳>` 便于回溯/回滚；确认新镜像稳定后可 `docker rmi` 清理旧 tag（不影响运行中容器）。

---

## 5. 方案 B：容器启动脚本幂等安装（否决）

| 问题 | 说明 |
|---|---|
| 启动超时 | 容器启动需同步等待下载+安装（Chrome 139 MB + 103 个包，30–60 s+），与现有 `startTimeoutMs=15000` 冲突 |
| 首用竞态 | 改异步后台安装则首用可能撞上「还没装完」，且错误表现不稳定（偶发失败比确定性失败更难排查） |
| 重复开销 | 每容器 × 每次重建都重复下载 140 MB+，N 个用户在线即 N 倍外网带宽 |
| 复杂度 | 需幂等锁、失败重试、版本标记、日志可观测，且每次容器启动都增加风险面 |
| 前提 | 仅当镜像构建机无法访问 `dl.google.com` 时才值得考虑；实测可达（HTTP 200） |

---

## 6. 方案 C：持久目录（兜底，仅 lark-cli）

- lark 二进制可放 `/opt/mao-data/deps/{userId}/lark-cli/`，shim 已支持 `LARK_CLI_BIN` 覆盖；需在 session envelope 注入 env 或改技能脚本。
- Chrome 依赖 103 个系统包（gtk/x11/systemd 等），无法干净放入持久目录，必须来自镜像层。
- 定位：若镜像重建链路长期不可用（如构建机网络受限）时的降级方案，不作为主路径。

---

## 7. 决策点与 overlay 默认值

> 下表「overlay 默认」列为 §4.5 两个文件当前采用的默认值；调整时改文件默认值，或按 §4.5 表用环境变量覆盖。

| # | 决策点 | 建议 | overlay 默认 |
|---|---|---|---|
| Q1 | Chrome 版本策略 | 固定版本 deb URL，升级时显式更新；不建议 `_current` 滚动 | `CHROME_DEB_URL` = 156.0.8078.79-1 ✔ |
| Q2 | 中文字体 | **建议加** `fonts-noto-cjk`（+91 MB）：否则截图/PDF 中文豆腐块 | `INSTALL_CJK_FONTS=true` ✔ |
| Q3 | lark-cli 版本 | 镜像与技能脚本默认版本对齐到最新（1.0.98） | `LARK_CLI_VERSION=1.0.98`；技能脚本仍锁 1.0.96，建议同步（待办） |
| Q4 | 容器重建触发 | 短期：手动「重建全部」；中期：镜像 ID/标签纳入容器漂移检测（与依赖对齐方案 D3/D5 合并） | 手动；脚本末尾提示 ✔ |
| Q5 | 是否加 precheck 冒烟 | 可选（官方 precheck 增强） | 暂不做（overlay 不涉及官方 precheck）；脚本自带构建后冒烟 ✔ |

---

## 8. 部署与验证清单（2026-10-31 已完成 ✔）

本部署走 §4.5 overlay 形态（不改仓库，无需 CHANGELOG）：

1. 把本会话工作区 `docs/runtime-image-ext/` 下两个文件复制到宿主机 `/data/runtime-image-ext/`（宿主机路径：`/opt/mao-data/workspace/feishu-chat/2/<会话>/docs/runtime-image-ext/`）；
2. `bash /data/runtime-image-ext/rebuild-runtime-image.sh`（脚本自带构建后冒烟：`chrome --version` / `lark-cli --version`）；
3. 管理后台「容器管理 → 重建全部」；
4. 重建后验证：
   - `/opt/google/chrome/chrome --version`；
   - playwright 技能跑一次 `playwright-cli open` + 中文截图；
   - `lark-cli --version`（走 shim）与 `lark-cli skills list`。

> 备选：若将来决定惠及所有部署者，改走 §4.1–4.4 的仓库形态（A2），届时补 CHANGELOG。
