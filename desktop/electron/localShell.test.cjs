'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const childProcess = require('child_process')
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

test('wait_for returns early while the command keeps running, await_async collects the rest', async (t) => {
  const { runtime, dir } = createRuntime(t)
  const startedAt = Date.now()
  const early = await runtime.handle(
    {
      command: "printf 'Listening on 3000\\n'; sleep 1; printf 'done\\n'",
      wait_for: 'Listening on',
      keep_session: true,
      session_id: 'sh-wait',
    },
    { conversationId: 23, workspace: dir, needApproval: false },
  )
  assert.ok(Date.now() - startedAt < 900, 'wait_for should return before the command finishes')
  assert.equal(early.completed, false)
  assert.equal(early.matched, 'Listening on')
  assert.match(early.output, /Listening on 3000/)
  assert.match(early.message, /await_async/)
  const alive = await runtime.handle({ action: 'list' }, { conversationId: 23 })
  assert.equal(alive.sessions.length, 1)
  const rest = await runtime.handle(
    { action: 'await_async', session_id: 'sh-wait', yield_time_ms: 5000 },
    { conversationId: 23 },
  )
  assert.equal(rest.completed, true)
  assert.equal(rest.exit_code, 0)
  // 提前放行后的输出不会丢，且不会重复交付已返回的部分
  assert.match(rest.output, /done/)
  assert.equal(/Listening on/.test(rest.output), false)
})

test('await_async resumes a timed-out command without losing output', async (t) => {
  const { runtime, dir } = createRuntime(t)
  const first = await runtime.handle(
    { command: "sleep 1; printf 'late-line\\n'", yield_time_ms: 200, session_id: 'sh-resume' },
    { conversationId: 24, workspace: dir, needApproval: false },
  )
  assert.equal(first.completed, false)
  const second = await runtime.handle(
    { action: 'await_async', session_id: 'sh-resume', yield_time_ms: 5000 },
    { conversationId: 24 },
  )
  assert.equal(second.completed, true)
  assert.equal(second.exit_code, 0)
  assert.match(second.output, /late-line/)
  // keep_session 未开启且命令已结束，此时才回收会话
  const listed = await runtime.handle({ action: 'list' }, { conversationId: 24 })
  assert.equal(listed.sessions.length, 0)
})

test('write_stdin feeds a running command instead of queueing a new marker', async (t) => {
  const { runtime, dir } = createRuntime(t)
  // 只回显长度：避免命令把 stdin 里排队的 marker 回显行原样打出来，被误判为命令结束
  const started = await runtime.handle(
    {
      command: 'while read -r line; do printf \'len:%s\\n\' "${#line}"; done',
      yield_time_ms: 300,
      keep_session: true,
      session_id: 'sh-stdin',
    },
    { conversationId: 25, workspace: dir, needApproval: false },
  )
  assert.equal(started.completed, false)
  const answered = await runtime.handle(
    { action: 'write_stdin', session_id: 'sh-stdin', input: 'hello', yield_time_ms: 800 },
    { conversationId: 25, workspace: dir, needApproval: false },
  )
  // 输入交给了正在运行的循环，而不是排在它后面等一个新 marker
  assert.equal(answered.completed, false)
  assert.match(answered.output, /len:5/)
  const listed = await runtime.handle({ action: 'list' }, { conversationId: 25 })
  assert.equal(listed.sessions.length, 1)
})

test('exec refuses to start while the session still has an unfinished command', async (t) => {
  const { runtime, dir } = createRuntime(t)
  const pending = await runtime.handle(
    { command: 'sleep 2', yield_time_ms: 150, keep_session: true, session_id: 'sh-busy' },
    { conversationId: 26, workspace: dir, needApproval: false },
  )
  assert.equal(pending.completed, false)
  const rejected = await runtime.handle(
    { command: 'echo nope', keep_session: true, session_id: 'sh-busy' },
    { conversationId: 26, workspace: dir, needApproval: false },
  )
  assert.match(rejected.error, /未结束的命令/)
})

test('rejects an invalid or over-long wait_for pattern', async (t) => {
  const { runtime, dir } = createRuntime(t)
  const invalid = await runtime.handle(
    { command: 'true', wait_for: '([' },
    { conversationId: 27, workspace: dir, needApproval: false },
  )
  assert.match(invalid.error, /wait_for 不是合法正则/)
  const tooLong = await runtime.handle(
    { command: 'true', wait_for: 'x'.repeat(201) },
    { conversationId: 27, workspace: dir, needApproval: false },
  )
  assert.match(tooLong.error, /wait_for 过长/)
})

test('does not leak a marker that arrives split across two chunks', async (t) => {
  const spawned = []
  const { runtime, dir } = createRuntime(t, {
    spawn: (command, args, options) => {
      const child = childProcess.spawn(command, args, options)
      spawned.push(child)
      return child
    },
  })
  const pending = runtime.handle(
    { command: 'sleep 5', yield_time_ms: 300, keep_session: true, session_id: 'sh-split' },
    { conversationId: 28, workspace: dir, needApproval: false },
  )
  // spawn 发生在 handle 内部的 await 之后，先等到子进程创建
  while (spawned.length === 0) await new Promise((resolve) => setImmediate(resolve))
  // 结束标记被拆成两个 chunk 到达：前半段不能作为正文交给模型，也不能落盘
  spawned[0].stdout.emit('data', 'partial-output\n__CMD')
  const early = await pending
  assert.equal(early.completed, false)
  assert.equal(early.output, 'partial-output\n')
  assert.equal(fs.readFileSync(early.output_file, 'utf8'), 'partial-output\n')
  await runtime.handle({ action: 'close', session_id: 'sh-split' }, { conversationId: 28 })
})

test('write_stdin on a finished-but-unconsumed command is rejected instead of mis-answered', async (t) => {
  const { runtime, dir } = createRuntime(t)
  const early = await runtime.handle(
    { command: 'sleep 0.4; echo finished', yield_time_ms: 150, keep_session: true, session_id: 'sh-stale' },
    { conversationId: 29, workspace: dir, needApproval: false },
  )
  assert.equal(early.completed, false)
  // 命令自然结束后 marker 已在缓冲区但无人消费：输入若被直喂会被 bash 当作新命令，
  // 而续读会立刻命中旧 marker，把旧输出误当成输入的应答
  await new Promise((resolve) => setTimeout(resolve, 700))
  const stale = await runtime.handle(
    { action: 'write_stdin', session_id: 'sh-stale', input: 'echo next', yield_time_ms: 2000 },
    { conversationId: 29, workspace: dir, needApproval: false },
  )
  assert.match(stale.error, /已结束但结果尚未收取/)
  // 输入不能被执行：结果仍可正常收取，且后续输出里没有 next 的痕迹
  const collected = await runtime.handle(
    { action: 'await_async', session_id: 'sh-stale', yield_time_ms: 2000 },
    { conversationId: 29, workspace: dir },
  )
  assert.equal(collected.completed, true)
  assert.match(collected.output, /finished/)
  const probe = await runtime.handle(
    { command: 'echo probe', keep_session: true, session_id: 'sh-stale', yield_time_ms: 2000 },
    { conversationId: 29, workspace: dir, needApproval: false },
  )
  assert.equal(probe.output.includes('next'), false)
})

test('double await_async cannot fake success or lose the session', async (t) => {
  const { runtime, dir } = createRuntime(t)
  const early = await runtime.handle(
    { command: 'sleep 0.4; echo done', yield_time_ms: 150, keep_session: true, session_id: 'sh-race' },
    { conversationId: 30, workspace: dir, needApproval: false },
  )
  assert.equal(early.completed, false)
  await new Promise((resolve) => setTimeout(resolve, 700))
  const [first, second] = await Promise.all([
    runtime.handle({ action: 'await_async', session_id: 'sh-race', yield_time_ms: 3000 }, { conversationId: 30, workspace: dir }),
    runtime.handle({ action: 'await_async', session_id: 'sh-race', yield_time_ms: 3000 }, { conversationId: 30, workspace: dir }),
  ])
  const got = [first, second].find((r) => !r.error)
  const other = [first, second].find((r) => r !== got)
  assert.equal(got.completed, true)
  assert.match(got.output, /done/)
  assert.match(other.error, /(没有未结束的命令|已被并行调用收取)/)
  // 会话必须仍然可用，不能被假 pending 卡死
  const probe = await runtime.handle(
    { command: 'echo alive', keep_session: true, session_id: 'sh-race', yield_time_ms: 2000 },
    { conversationId: 30, workspace: dir, needApproval: false },
  )
  assert.equal(probe.error, undefined)
  assert.match(probe.output, /alive/)
})
