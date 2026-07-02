const EXT_LANG_MAP: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  py: 'python', rb: 'ruby', java: 'java', kt: 'kotlin', kts: 'kotlin',
  go: 'go', rs: 'rust', c: 'cpp', h: 'cpp', hpp: 'cpp', cpp: 'cpp', cc: 'cpp', cxx: 'cpp',
  cs: 'csharp', swift: 'swift', dart: 'dart', scala: 'scala', clj: 'clojure',
  php: 'php', lua: 'lua', r: 'r', m: 'objective-c', mm: 'objective-c',
  sql: 'sql', sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  ps1: 'powershell', bat: 'bat', batch: 'bat', cmd: 'bat',
  html: 'html', htm: 'html', vue: 'html', xml: 'xml', svg: 'xml',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini',
  md: 'markdown', markdown: 'markdown',
  graphql: 'graphql', gql: 'graphql',
  dockerfile: 'dockerfile',
  ini: 'ini', cfg: 'ini',
  txt: 'plaintext', log: 'plaintext', csv: 'plaintext',
}

export function monacoLangFromExtension(filePath: string): string {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('dockerfile')) return 'dockerfile'
  if (lower.endsWith('makefile')) return 'plaintext'
  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  return EXT_LANG_MAP[ext] || 'plaintext'
}

const FENCE_ALIASES: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  py: 'python', rb: 'ruby', sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  yml: 'yaml', md: 'markdown', cs: 'csharp', 'c++': 'cpp', cc: 'cpp', h: 'cpp',
  objc: 'objective-c', objectivec: 'objective-c', gql: 'graphql',
  vue: 'html', text: 'plaintext', txt: 'plaintext',
}

export function monacoLangFromFence(lang?: string): string {
  if (!lang) return 'plaintext'
  const lower = lang.toLowerCase().trim()
  return FENCE_ALIASES[lower] ?? EXT_LANG_MAP[lower] ?? lower
}
