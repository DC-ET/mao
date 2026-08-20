'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createLocalShellRuntime, MAX_COMMAND_LENGTH, shellSingleQuote } = require('./localShell.cjs')

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-local-shell-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function createRuntime(t, extra = {}) {
  const dir = tempDir(t)
  const runtime = createLocalShellRuntime({
    autoCleanup: false,
    buildEnv: async () => ({ ...process.env, TERM: 'dumb', PS1: '' }),
    refreshToken: (session) => {
      session.writeStdin("export MAO_TOKEN='tok'\n")
    },
    resolveOutput: (_cid, shellId) => ({
      absPath: path.join(dir, `${shellId}.out`),
      displayPath: path.join(dir, `${shellId}.out`),
    }),
    ...extra,
  })
  t.after(() => {
    runtime.closeAll()
    runtime.stopCleanup()
  })
  return { runtime, dir }
}

test('shellSingleQuote escapes embedded quotes', () => {
  assert.equal(shellSingleQuote("a'b"), `'a'\\''b'`)
})

test('exec captures stdout, stderr and the real exit code', async (t) => {
  const { runtime, dir } = createRuntime(t)
  const result = await runtime.handle(
    { command: "printf 'validation failed\\n' >&2; false" },
    { conversationId: 11, workspace: dir, needApproval: false },
  )
  assert.equal(result.exit_code, 1)
  assert.equal(result.completed, true)
  assert.match(result.output, /validation failed/)
  assert.equal(fs.readFileSync(result.output_file, 'utf8').includes('validation failed'), true)
  const listed = await runtime.handle({ action: 'list' }, { conversationId: 11 })
  assert.equal(listed.sessions.length, 0)
})

test('keep_session reuses cwd after cd and refreshes current_workdir', async (t) => {
  const { runtime, dir } = createRuntime(t)
  const sub = path.join(dir, 'sub')
  fs.mkdirSync(sub)
  const first = await runtime.handle(
    { command: 'cd sub', keep_session: true, session_id: 'sh-keep' },
    { conversationId: 12, workspace: dir, needApproval: false },
  )
  assert.equal(first.exit_code, 0)
  assert.equal(first.current_workdir, sub)
  const second = await runtime.handle(
    { command: 'pwd', keep_session: true, session_id: 'sh-keep' },
    { conversationId: 12, workspace: dir, needApproval: false },
  )
  assert.equal(second.output.trim().split('\n').pop(), sub)
  const listed = await runtime.handle({ action: 'list' }, { conversationId: 12 })
  assert.equal(listed.sessions.length, 1)
  assert.equal(listed.sessions[0].session_id, 'sh-keep')
})

test('reused session honors workdir by cd-ing before the command', async (t) => {
  const { runtime, dir } = createRuntime(t)
  const sub = path.join(dir, 'nested')
  fs.mkdirSync(sub)
  await runtime.handle(
    { command: 'true', keep_session: true, session_id: 'sh-cd' },
    { conversationId: 13, workspace: dir, needApproval: false },
  )
  const moved = await runtime.handle(
    { command: 'pwd', keep_session: true, session_id: 'sh-cd', workdir: sub },
    { conversationId: 13, workspace: dir, needApproval: false },
  )
  assert.equal(moved.current_workdir, sub)
})

test('write_stdin returns immediately with a marker and refreshes token first', async (t) => {
  const { runtime, dir } = createRuntime(t)
  const writes = []
  const withSpy = createLocalShellRuntime({
    autoCleanup: false,
    buildEnv: async () => ({ ...process.env, TERM: 'dumb', PS1: '' }),
    refreshToken: (session) => {
      writes.push('token')
      session.writeStdin("export MAO_TOKEN='tok'\n")
    },
    resolveOutput: (_cid, shellId) => ({
      absPath: path.join(dir, `${shellId}.out`),
      displayPath: path.join(dir, `${shellId}.out`),
    }),
  })
  t.after(() => {
    withSpy.closeAll()
    withSpy.stopCleanup()
  })
  await withSpy.handle(
    { command: 'true', keep_session: true, session_id: 'sh-in' },
    { conversationId: 14, workspace: dir, needApproval: false },
  )
  writes.length = 0
  const started = Date.now()
  const result = await withSpy.handle(
    { action: 'write_stdin', session_id: 'sh-in', input: 'echo hi' },
    { conversationId: 14, workspace: dir, needApproval: false },
  )
  assert.ok(Date.now() - started < 4000)
  assert.equal(result.completed, true)
  assert.match(result.output, /hi/)
  assert.equal(writes[0], 'token')
})

test('kills the whole process group when a session closes', async (t) => {
  const { runtime, dir } = createRuntime(t)
  const started = await runtime.handle(
    { command: 'sleep 300 & echo $!', keep_session: true, session_id: 'sh-tree' },
    { conversationId: 15, workspace: dir, needApproval: false },
  )
  const childPid = Number(started.output.trim().split('\n').pop())
  assert.ok(childPid > 0)
  assert.doesNotThrow(() => process.kill(childPid, 0))
  await runtime.handle({ action: 'close', session_id: 'sh-tree' }, { conversationId: 15 })
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.throws(() => process.kill(childPid, 0))
})

test('enforces per-conversation session limits and command length', async (t) => {
  const { runtime, dir } = createRuntime(t, { maxSessionsPerConversation: 1 })
  await runtime.handle(
    { command: 'true', keep_session: true, session_id: 'one' },
    { conversationId: 16, workspace: dir, needApproval: false },
  )
  const tooMany = await runtime.handle(
    { command: 'true', keep_session: true, session_id: 'two' },
    { conversationId: 16, workspace: dir, needApproval: false },
  )
  assert.match(tooMany.error, /Maximum number of shell sessions/)
  const tooLong = await runtime.handle(
    { command: 'x'.repeat(MAX_COMMAND_LENGTH + 1) },
    { conversationId: 17, workspace: dir, needApproval: false },
  )
  assert.match(tooLong.error, /命令过长/)
})

test('defaults missing action to exec and reports unknown actions', async (t) => {
  const { runtime, dir } = createRuntime(t)
  const execed = await runtime.handle(
    { command: 'printf ok' },
    { conversationId: 18, workspace: dir, needApproval: false },
  )
  assert.equal(execed.exit_code, 0)
  assert.match(execed.output, /ok/)
  const unknown = await runtime.handle({ action: 'nope' }, { conversationId: 18 })
  assert.match(unknown.error, /未知动作/)
})

test('denies exec when approval callback returns false', async (t) => {
  const { runtime, dir } = createRuntime(t)
  const result = await runtime.handle(
    { command: 'echo hi' },
    { conversationId: 19, workspace: dir, needApproval: true, approve: async () => false },
  )
  assert.equal(result.exit_code, -1)
  assert.match(result.output, /User denied/)
})

test('exit code from the previous command does not leak into the next output', async (t) => {
  const { runtime, dir } = createRuntime(t)
  const failed = await runtime.handle(
    { command: 'bash -c "exit 3"', keep_session: true, session_id: 'sh-exit' },
    { conversationId: 20, workspace: dir, needApproval: false },
  )
  assert.equal(failed.exit_code, 3)
  const ok = await runtime.handle(
    { command: 'echo second', keep_session: true, session_id: 'sh-exit' },
    { conversationId: 20, workspace: dir, needApproval: false },
  )
  assert.equal(ok.exit_code, 0)
  assert.equal(ok.output.trim(), 'second')
})

test('async starts the command before returning session_id and await_async collects output', async (t) => {
  const { runtime, dir } = createRuntime(t)
  const startedAt = Date.now()
  const started = await runtime.handle(
    { command: 'sleep 1; printf async-ok', async: true, keep_session: true, session_id: 'sh-async' },
    { conversationId: 21, workspace: dir, needApproval: false },
  )
  assert.ok(Date.now() - startedAt < 800)
  assert.equal(started.async, true)
  assert.equal(started.session_id, 'sh-async')
  const listed = await runtime.handle({ action: 'list' }, { conversationId: 21 })
  assert.equal(listed.sessions.length, 1)
  const blocked = await runtime.handle(
    { action: 'write_stdin', session_id: 'sh-async', input: 'echo no' },
    { conversationId: 21, workspace: dir, needApproval: false },
  )
  assert.match(blocked.error, /未完成的异步命令/)
  const awaited = await runtime.handle(
    { action: 'await_async', session_id: 'sh-async' },
    { conversationId: 21 },
  )
  assert.equal(awaited.exit_code, 0)
  assert.match(awaited.output, /async-ok/)
})

test('timeout seconds maps to yield_time_ms when yield_time_ms is omitted', async (t) => {
  const { runtime, dir } = createRuntime(t)
  const startedAt = Date.now()
  const result = await runtime.handle(
    { command: 'sleep 2; echo late', timeout: 1 },
    { conversationId: 22, workspace: dir, needApproval: false },
  )
  const elapsed = Date.now() - startedAt
  assert.ok(elapsed < 1800, `expected timeout around 1s, took ${elapsed}ms`)
  assert.equal(result.completed, false)
  assert.equal(result.exit_code, -1)
})
