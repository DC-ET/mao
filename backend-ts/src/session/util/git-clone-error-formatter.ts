export function toUserMessage(rawError: string | null | undefined): string {
  if (rawError == null || rawError.trim().length === 0) {
    return 'Git 仓库克隆失败，请稍后重试';
  }

  const normalized = rawError.replace(/\r\n/g, '\n').trim();
  const lower = normalized.toLowerCase();

  if (lower.startsWith('git clone timeout') || lower.includes('clone timeout')) {
    return '克隆仓库超时，请检查网络连接或稍后重试';
  }
  if (lower.includes('repository not found') || lower.includes('project not found')) {
    return '仓库不存在或无权访问。请确认 HTTPS 地址正确；私有仓库需在「设置 → Git 凭证」配置对应域名的 Token。';
  }
  if (
    lower.includes('authentication failed')
    || lower.includes('invalid username or password')
    || lower.includes('could not read username')
    || lower.includes('access rights')
    || lower.includes('permission denied (publickey)')
    || lower.includes('permission denied (password')
    || lower.includes('http basic: access denied')
  ) {
    return 'Git 认证失败。请在「设置 → Git 凭证」配置对应域名的 Access Token。';
  }
  if (lower.includes('could not resolve host') || lower.includes('name or service not known')) {
    return '无法解析 Git 服务器地址，请检查仓库 URL 是否正确';
  }
  if ((lower.includes('remote branch') && lower.includes('not found')) || lower.includes('could not find remote branch')) {
    return '指定的分支不存在，请检查分支名称或留空使用默认分支';
  }
  if (lower.includes('unable to access') || lower.includes('the requested url returned error: 403')) {
    return '无法访问该仓库，请确认地址正确且已配置访问凭证';
  }
  if (lower.includes('already exists and is not an empty directory')) {
    return '目标工作区目录已存在且非空，请更换仓库名或清理已有工作区后重试';
  }
  if (lower.includes('git clone interrupted')) {
    return '仓库克隆已中断，请重试';
  }
  if (lower.startsWith('git clone error:')) {
    return '克隆仓库时发生错误，请稍后重试';
  }

  const hint = extractHint(normalized);
  if (hint.trim().length > 0) {
    return `Git 仓库克隆失败：${hint}`;
  }
  return 'Git 仓库克隆失败，请检查仓库地址与访问凭证后重试';
}

function extractHint(output: string): string {
  const lines = output.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = sanitizeLine(lines[i].trim());
    if (line.length === 0) {
      continue;
    }
    const lower = line.toLowerCase();
    if (lower.startsWith('fatal:') || lower.startsWith('error:') || lower.includes('remote:') || lower.startsWith('warning:')) {
      return line;
    }
  }
  return sanitizeLine(output);
}

function sanitizeLine(line: string): string {
  if (line.trim().length === 0) {
    return '';
  }
  let cleaned = line
    .replace(/^git clone failed:\s*/i, '')
    .replace(/^Cloning into '[^']*'\.\.\.\s*/i, '')
    .replace(/https:\/\/oauth2:[^@]+@/g, 'https://oauth2:***@');
  if (cleaned.length > 160) {
    cleaned = `${cleaned.slice(0, 157)}...`;
  }
  return cleaned.trim();
}

export const GitCloneErrorFormatter = { toUserMessage };
