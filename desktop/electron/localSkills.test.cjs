'use strict'

// localSkills：SKILL.md 解析、目录逃逸拒绝、base url 改写、read-agents-md、zip 解压（§8）。
// 不访问网络：fetchImpl 注入本地桩；skills 根目录注入临时目录，不摸真实 ~/.agents/skills。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const AdmZip = require('adm-zip')
const {
  registerLocalSkillsIpc,
  preferIpv4Loopback,
  resolveSkillSyncBaseUrl,
  parseSkillMd,
  resolveLocalSkillFolder,
  extractSkillZip,
} = require('./localSkills.cjs')

function withTmpdir(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mao-skills-${name}-`))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function fakeIpc() {
  const handlers = {}
  return { handlers, handle: (channel, cb) => { handlers[channel] = cb } }
}

test('parseSkillMd：合法 frontmatter 取出 name/description/body', () => {
  const md = '---\nname: my-skill\ndescription: "a demo"\n---\n\nbody text here\n'
  assert.deepEqual(parseSkillMd(md), { name: 'my-skill', description: 'a demo', body: 'body text here' })
  assert.equal(parseSkillMd('no frontmatter'), null)
  assert.equal(parseSkillMd('---\ndescription: no name\n---\nbody'), null)
  assert.equal(parseSkillMd(null), null)
})

test('resolveLocalSkillFolder：拒绝 ../、绝对逃逸、以 . 开头；临时目录内真实文件夹可通过', (t) => {
  const dir = withTmpdir(t, 'root')
  const real = path.join(dir, 'real-skill')
  fs.mkdirSync(real)

  assert.equal(resolveLocalSkillFolder('real-skill', dir), real)
  assert.equal(resolveLocalSkillFolder('../escape', dir), null)
  assert.equal(resolveLocalSkillFolder('sub/../x', dir), null)
  assert.equal(resolveLocalSkillFolder('/etc', dir), null)
  assert.equal(resolveLocalSkillFolder('.hidden', dir), null)
  assert.equal(resolveLocalSkillFolder('missing', dir), null)
  assert.equal(resolveLocalSkillFolder('', dir), null)
  assert.equal(resolveLocalSkillFolder(null, dir), null)
})

test('preferIpv4Loopback 与 resolveSkillSyncBaseUrl', () => {
  assert.equal(preferIpv4Loopback('http://localhost:9080/api/v1'), 'http://127.0.0.1:9080/api/v1')
  assert.equal(preferIpv4Loopback('https://mao.example.com'), 'https://mao.example.com')
  // 去掉末尾 /v1（含或不含斜杠），再走 localhost 改写；apiBase 缺省走注入的 getter
  assert.equal(resolveSkillSyncBaseUrl('https://mao.example.com/v1/'), 'https://mao.example.com')
  assert.equal(resolveSkillSyncBaseUrl('https://mao.example.com/v1'), 'https://mao.example.com')
  assert.equal(resolveSkillSyncBaseUrl('', () => 'http://localhost:9080/api/v1'), 'http://127.0.0.1:9080/api')
})

function makeLocalSkillsIpc(t, { agentsDir, skillsDir, fetchImpl }) {
  const ipc = fakeIpc()
  const notifications = []
  registerLocalSkillsIpc(ipc, {
    sendToRenderer: (channel, data) => notifications.push({ channel, data }),
    getApiBaseUrl: () => 'http://localhost:9080/api',
    resolveLocalSkillsDir: () => skillsDir,
    getLocalAgentsSkillsDir: () => agentsDir,
    fetchImpl: fetchImpl || (async () => { throw new Error('network disabled in tests') }),
  })
  return { ipc, notifications }
}

test('list-local-skills：注入根目录，跳过隐藏与非技能目录，返回 skillsDir 注入值', (t) => {
  const dir = withTmpdir(t, 'list')
  fs.mkdirSync(path.join(dir, 'alpha'))
  fs.writeFileSync(path.join(dir, 'alpha', 'SKILL.md'), '---\nname: Alpha\ndescription: first\n---\nbody')
  fs.mkdirSync(path.join(dir, '.beta'))
  fs.writeFileSync(path.join(dir, '.beta', 'SKILL.md'), '---\nname: Beta\n---\nbody')
  fs.mkdirSync(path.join(dir, 'no-md'))

  const { ipc } = makeLocalSkillsIpc(t, { agentsDir: dir, skillsDir: dir })
  return ipc.handlers['list-local-skills'](null, {}).then((r) => {
    assert.equal(r.skillsDir, dir)
    assert.equal(r.skills.length, 1)
    assert.equal(r.skills[0].folderName, 'alpha')
    assert.equal(r.skills[0].name, 'Alpha')
    assert.equal(r.skills[0].folderPath, path.join(dir, 'alpha'))
  })
})

test('read-agents-md：无文件 / 无 workspace 返回 { content: null }，有文件返回正文', (t) => {
  const dir = withTmpdir(t, 'agents-md')
  const { ipc } = makeLocalSkillsIpc(t, { agentsDir: dir, skillsDir: dir })

  return ipc.handlers['read-agents-md'](null, { workspace: '' }).then((r) => {
    assert.deepEqual(r, { content: null })
    return ipc.handlers['read-agents-md'](null, { workspace: dir })
  }).then((r) => {
    assert.deepEqual(r, { content: null })
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# rules\n')
    return ipc.handlers['read-agents-md'](null, { workspace: dir })
  }).then((r) => {
    assert.equal(r.content, '# rules\n')
  })
})

test('extractSkillZip：本地 buffer 解压到临时目录，不发 HTTP', (t) => {
  const dir = withTmpdir(t, 'zip')
  const zip = new AdmZip()
  zip.addFile('synced/SKILL.md', Buffer.from('---\nname: Synced\n---\ncontent'))
  const buffer = zip.toBuffer()

  extractSkillZip(buffer, path.join(dir, 'skills'))
  const out = path.join(dir, 'skills', 'synced', 'SKILL.md')
  assert.ok(fs.existsSync(out))
  assert.ok(fs.readFileSync(out, 'utf-8').includes('name: Synced'))
})

test('skill-sync：注入 fetchImpl 走全链路（下载 + 解压 + 通知），不发真实 HTTP', (t) => {
  const agentsDir = withTmpdir(t, 'agents')
  const skillsDir = path.join(agentsDir, 'runtime-skills')
  const zip = new AdmZip()
  zip.addFile('dl/SKILL.md', Buffer.from('---\nname: DL\n---\nbody'))
  const zipBuffer = zip.toBuffer()

  const responses = [
    { ok: true, arrayBuffer: async () => zipBuffer, text: async () => '' },
  ]
  const fetchCalls = []
  const { ipc, notifications } = makeLocalSkillsIpc(t, {
    agentsDir,
    skillsDir,
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, init })
      const r = responses.shift()
      if (!r) return { ok: false, status: 500, statusText: 'boom', text: async () => 'err-body' }
      return r
    },
  })

  return ipc.handlers['skill-sync'](null, { sessionId: 42, syncUrl: '/api/v1/skills/sync', token: 'tok' }).then((r) => {
    assert.deepEqual(r, { success: true })
    // localhost 改写为 127.0.0.1；相对 syncUrl 拼在去掉 /v1 的 origin 上
    assert.equal(fetchCalls.length, 1)
    assert.ok(fetchCalls[0].url.startsWith('http://127.0.0.1:9080/api'))
    assert.equal(init_authHeader(fetchCalls[0]), 'Bearer tok')
    assert.ok(fs.existsSync(path.join(skillsDir, 'dl', 'SKILL.md')))

    const done = notifications.find((n) => n.channel === 'skill-sync-complete')
    assert.deepEqual(done.data, { sessionId: 42, success: true })

    // 失败路径：ok:false → { success:false, error }，通知带 error
    return ipc.handlers['skill-sync'](null, { sessionId: 42, syncUrl: '/x' })
  }).then((r) => {
    assert.equal(r.success, false)
    assert.ok(r.error.includes('Skill sync download failed'))
    const last = notifications[notifications.length - 1]
    assert.equal(last.data.success, false)
  })
})

function init_authHeader(call) {
  return call.init?.headers?.Authorization || ''
}

test('skill-sync：缺 sessionId 直接失败并通知', (t) => {
  const dir = withTmpdir(t, 'nosid')
  const { ipc, notifications } = makeLocalSkillsIpc(t, { agentsDir: dir, skillsDir: dir })
  return ipc.handlers['skill-sync'](null, {}).then((r) => {
    assert.equal(r.success, false)
    assert.ok(r.error.includes('No sessionId'))
    assert.equal(notifications[0].channel, 'skill-sync-complete')
    assert.equal(notifications[0].data.success, false)
  })
})
