'use strict'

// 技能同步与本地技能目录（自 main.cjs 抽出，技术方案 2026-11-19 §5.5）。
// 不依赖 Electron：渲染层通知、API 地址、两个技能目录都由入口注入；
// ~/.agents/skills 根目录可注入，单测才能指向临时目录（不摸真实目录）。

const fs = require('fs')
const os = require('os')
const path = require('path')

function preferIpv4Loopback(url) {
  // Electron/undici 解析 localhost 会先走 ::1；TS 后端 listen 0.0.0.0 只收 IPv4。
  return String(url || '').replace('://localhost', '://127.0.0.1')
}

function resolveSkillSyncBaseUrl(apiBase, getDefaultApiBase) {
  const raw = typeof apiBase === 'string' && apiBase.trim() !== ''
    ? apiBase.trim()
    : (getDefaultApiBase ? getDefaultApiBase() : '')
  return preferIpv4Loopback(raw.replace(/\/v1\/?$/, '').replace(/\/$/, ''))
}

function parseSkillMd(content) {
  if (!content || !content.startsWith('---')) return null
  const secondDelimiter = content.indexOf('---', 3)
  if (secondDelimiter === -1) return null

  const frontmatter = content.substring(3, secondDelimiter).trim()
  const body = content.substring(secondDelimiter + 3).trim()

  let name = null
  let description = null
  for (const line of frontmatter.split('\n')) {
    const nameMatch = line.match(/^name:\s*(.+)$/)
    if (nameMatch) {
      name = nameMatch[1].trim().replace(/^["']|["']$/g, '')
    }
    const descMatch = line.match(/^description:\s*(.+)$/)
    if (descMatch) {
      description = descMatch[1].trim().replace(/^["']|["']$/g, '')
    }
  }

  if (!name) return null
  return { name, description: description || '', body }
}

/** 文件夹名拒绝 /、\、以 . 开头，并用 path.resolve + path.sep 前缀判断拒绝逃出根目录 */
function resolveLocalSkillFolder(folderName, skillsDir) {
  if (!folderName || typeof folderName !== 'string') return null
  if (folderName.includes('/') || folderName.includes('\\') || folderName.startsWith('.')) {
    return null
  }
  const skillFolder = path.resolve(skillsDir, folderName)
  const normalizedRoot = path.resolve(skillsDir)
  if (skillFolder !== normalizedRoot && !skillFolder.startsWith(normalizedRoot + path.sep)) {
    return null
  }
  if (!fs.existsSync(skillFolder) || !fs.statSync(skillFolder).isDirectory()) {
    return null
  }
  return skillFolder
}

function collectSkillFiles(dir, baseDir, files = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      collectSkillFiles(fullPath, baseDir, files)
    } else if (entry.isFile()) {
      const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/')
      if (!relativePath || relativePath.includes('/.')) continue
      files.push({ relativePath, fullPath })
    }
  }
  return files
}

/** 解压技能 zip 到技能目录（覆盖）。与下载拆开：单测用本地 buffer，不发 HTTP */
function extractSkillZip(zipBuffer, skillsDir) {
  fs.mkdirSync(skillsDir, { recursive: true })
  const AdmZip = require('adm-zip')
  const zip = new AdmZip(zipBuffer)
  zip.extractAllTo(skillsDir, true)
}

/**
 * deps：
 * - sendToRenderer(channel, data)：skill-sync-complete 通知
 * - getApiBaseUrl()：syncUrl 为相对路径时的默认 origin 来源
 * - resolveLocalSkillsDir(sessionId)：~/.mao/runtime/<host>/<sid>/skills
 * - getLocalAgentsSkillsDir()：~/.agents/skills 根目录（可注入）
 * - fetchImpl：可注入（单测不发 HTTP）
 */
function registerLocalSkillsIpc(ipcMain, deps) {
  const {
    sendToRenderer,
    getApiBaseUrl,
    resolveLocalSkillsDir,
    getLocalAgentsSkillsDir = () => path.join(os.homedir(), '.agents', 'skills'),
    fetchImpl = fetch,
  } = deps || {}

  ipcMain.handle('skill-sync', async (event, { sessionId, syncUrl, token, apiBase }) => {
    if (!sessionId) {
      const err = 'No sessionId provided for skill sync.'
      sendToRenderer('skill-sync-complete', { sessionId, success: false, error: err })
      return { success: false, error: err }
    }
    try {
      const skillsDir = resolveLocalSkillsDir(sessionId)

      const origin = resolveSkillSyncBaseUrl(apiBase, getApiBaseUrl)
      const fullUrl = preferIpv4Loopback(/^https?:\/\//.test(syncUrl) ? syncUrl : `${origin}${syncUrl}`)
      const headers = token ? { 'Authorization': `Bearer ${token}` } : {}
      const response = await fetchImpl(fullUrl, { method: 'POST', headers })
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error(`Skill sync download failed: ${response.status} ${response.statusText} - ${body}`)
      }

      const zipBuffer = Buffer.from(await response.arrayBuffer())
      extractSkillZip(zipBuffer, skillsDir)
      sendToRenderer('skill-sync-complete', { sessionId, success: true })
      return { success: true }
    } catch (e) {
      console.error('Skill sync failed:', e)
      sendToRenderer('skill-sync-complete', { sessionId, success: false, error: e.message })
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('list-local-skills', async () => {
    const skillsDir = getLocalAgentsSkillsDir()
    try {
      if (!fs.existsSync(skillsDir)) {
        return { skills: [], skillsDir }
      }

      const skills = []
      const entries = fs.readdirSync(skillsDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue

        const folderPath = path.join(skillsDir, entry.name)
        const skillMdPath = path.join(folderPath, 'SKILL.md')
        if (!fs.existsSync(skillMdPath)) continue

        try {
          const content = fs.readFileSync(skillMdPath, 'utf-8')
          const parsed = parseSkillMd(content)
          if (!parsed) continue
          skills.push({
            folderName: entry.name,
            name: parsed.name,
            description: parsed.description,
            folderPath,
          })
        } catch (e) {
          console.warn('[local-skills] Failed to parse:', entry.name, e.message)
        }
      }

      skills.sort((a, b) => a.name.localeCompare(b.name))
      return { skills, skillsDir }
    } catch (e) {
      console.error('[local-skills] list failed:', e)
      return { error: e.message, skills: [], skillsDir }
    }
  })

  ipcMain.handle('get-local-skill-detail', async (event, { folderName }) => {
    try {
      const skillFolder = resolveLocalSkillFolder(folderName, getLocalAgentsSkillsDir())
      if (!skillFolder) {
        return { error: 'Skill not found: ' + folderName }
      }

      const skillMdPath = path.join(skillFolder, 'SKILL.md')
      const content = fs.readFileSync(skillMdPath, 'utf-8')
      const parsed = parseSkillMd(content)
      if (!parsed) {
        return { error: 'Invalid SKILL.md in skill: ' + folderName }
      }

      return {
        name: parsed.name,
        description: parsed.description,
        body: parsed.body,
        folderPath: skillFolder,
        filePath: skillMdPath,
        folderName,
      }
    } catch (e) {
      return { error: e.message }
    }
  })

  ipcMain.handle('read-local-skill-files', async (event, { folderName }) => {
    try {
      const skillFolder = resolveLocalSkillFolder(folderName, getLocalAgentsSkillsDir())
      if (!skillFolder) {
        return { error: 'Skill not found: ' + folderName }
      }

      const fileEntries = collectSkillFiles(skillFolder, skillFolder)
      const files = fileEntries.map(({ relativePath, fullPath }) => ({
        relativePath,
        base64: fs.readFileSync(fullPath).toString('base64'),
      }))

      return { folderName, files }
    } catch (e) {
      return { error: e.message }
    }
  })

  ipcMain.handle('read-agents-md', async (event, { workspace }) => {
    try {
      if (!workspace) {
        return { content: null }
      }

      const agentsMdPath = path.join(workspace, 'AGENTS.md')
      if (!fs.existsSync(agentsMdPath)) {
        return { content: null }
      }

      const stat = fs.statSync(agentsMdPath)
      if (!stat.isFile()) {
        return { content: null }
      }

      const content = fs.readFileSync(agentsMdPath, 'utf-8')
      return { content: content || null }
    } catch (e) {
      console.error('[read-agents-md] Failed:', e.message)
      return { error: e.message, content: null }
    }
  })
}

module.exports = {
  registerLocalSkillsIpc,
  preferIpv4Loopback,
  resolveSkillSyncBaseUrl,
  parseSkillMd,
  resolveLocalSkillFolder,
  collectSkillFiles,
  extractSkillZip,
}
