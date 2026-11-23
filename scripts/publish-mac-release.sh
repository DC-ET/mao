#!/usr/bin/env bash
# 把 desktop/release 里的 macOS 更新包放到站点更新目录。
# 安装包和 blockmap 先传，远端大小与本地一致后，最后才传 latest-mac.yml。
# 清单先于安装包出现时，客户端会下到半截文件，报 sha512 checksum mismatch。
#
# 用法：
#   MAO_RELEASE_HOST=root@120.26.109.221 \
#   MAO_RELEASE_SSH_KEY=~/.ssh/id_rsa \
#   bash scripts/publish-mac-release.sh desktop/release
set -euo pipefail

RELEASE_DIR="${1:-desktop/release}"
HOST="${MAO_RELEASE_HOST:-root@120.26.109.221}"
SSH_KEY="${MAO_RELEASE_SSH_KEY:-$HOME/.ssh/id_rsa}"
REMOTE_DIR="${MAO_RELEASE_DIR:-/opt/mao-data/uploads/releases}"

if [ ! -d "$RELEASE_DIR" ]; then
  echo "错误：找不到目录 $RELEASE_DIR" >&2
  exit 2
fi
if [ ! -f "$RELEASE_DIR/latest-mac.yml" ]; then
  echo "错误：$RELEASE_DIR/latest-mac.yml 不存在" >&2
  exit 2
fi

SSH=(ssh -F /dev/null -i "$SSH_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new)
SCP=(scp -F /dev/null -i "$SSH_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new)

payload=()
while IFS= read -r url; do
  [ -n "$url" ] || continue
  file="$RELEASE_DIR/$url"
  if [ ! -f "$file" ]; then
    echo "错误：清单引用了 $url，但本地没有这个文件" >&2
    exit 2
  fi
  payload+=("$file")
  blockmap="$file.blockmap"
  if [ -f "$blockmap" ]; then
    payload+=("$blockmap")
  fi
done < <(awk '/^[[:space:]]*- url:/{print $3}' "$RELEASE_DIR/latest-mac.yml")

if [ "${#payload[@]}" -eq 0 ]; then
  echo "错误：$RELEASE_DIR 里没有 Mao 安装包" >&2
  exit 2
fi

echo "==> 上传 ${#payload[@]} 个安装包（不含 latest-mac.yml）"
"${SCP[@]}" "${payload[@]}" "$HOST:$REMOTE_DIR/"

echo "==> 核对远端文件大小"
names=()
for file in "${payload[@]}"; do
  names+=("$(basename "$file")")
done
remote_sizes="$("${SSH[@]}" "$HOST" python3 - "$REMOTE_DIR" "${names[@]}" <<'PY'
import os, sys
remote_dir = sys.argv[1]
for name in sys.argv[2:]:
    path = os.path.join(remote_dir, os.path.basename(name))
    print(f"{os.path.basename(name)} {os.path.getsize(path)}")
PY
)"
failed=0
for file in "${payload[@]}"; do
  name="$(basename "$file")"
  local_size="$(wc -c < "$file" | tr -d ' ')"
  remote_size="$(printf '%s\n' "$remote_sizes" | awk -v name="$name" '$1 == name { print $2 }')"
  if [ "$remote_size" != "$local_size" ]; then
    echo "大小不一致 $name: local=$local_size remote=${remote_size:-缺失}" >&2
    failed=1
  else
    echo "ok $name $local_size"
  fi
done
if [ "$failed" -ne 0 ]; then
  echo "错误：安装包未到齐，不上传 latest-mac.yml" >&2
  exit 1
fi

echo "==> 安装包已到齐，上传 latest-mac.yml"
"${SCP[@]}" "$RELEASE_DIR/latest-mac.yml" "$HOST:$REMOTE_DIR/latest-mac.yml"
echo "完成。更新清单最后发布。"
