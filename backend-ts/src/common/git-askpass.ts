/**
 * git askpass 脚本模板与 GIT_TOKEN_* 变量名规则（多注入通道共用）。
 *
 * 独立 leaf 模块的原因：容器模块不得 import git 域 / file 域服务
 * （container-import-constraints.spec.ts 强制），而脚本探针容器侧需要同样的
 * askpass 内容与域名→变量名映射；此处零依赖，宿主与容器两侧均可安全引用。
 * 变量名权威口径仍是 GitCredentialService.envVarNameForDomain，两者必须同式。
 */

/** askpass 脚本内容：从 GIT_TOKEN_{host} 反查 token，用户名固定回 oauth2。 */
export const ASKPASS = `#!/bin/bash
PROMPT="$1"
if echo "$PROMPT" | grep -qi 'username'; then
  echo "oauth2"
  exit 0
fi
URL=$(echo "$PROMPT" | sed -n "s/.*'https:\\/\\/\\([^']*\\)'.*/\\1/p")
if [ -z "$URL" ]; then
  URL=$(echo "$PROMPT" | sed -n "s/.*'http:\\/\\/\\([^']*\\)'.*/\\1/p")
fi
if [ -z "$URL" ]; then
  exit 1
fi
HOST="\${URL##*@}"
HOST="\${HOST%%/*}"
VARNAME="GIT_TOKEN_$(echo "$HOST" | tr '.-' '__')"
VALUE="\${!VARNAME}"
if [ -n "$VALUE" ]; then
  echo "$VALUE"
fi
`;

/** git 域名 → GIT_TOKEN_* 环境变量名（`.`/`-` 归一为 `_`）。 */
export function gitTokenEnvKey(domain: string): string {
  return `GIT_TOKEN_${domain.replace(/[.-]/g, '_')}`;
}
