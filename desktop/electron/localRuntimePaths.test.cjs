'use strict'

// localRuntimePaths：runtime 目录拼接、~ 展示形式、路径解析（技术方案 2026-11-19 §8）。
// 锁定「不新增沙箱」：绝对路径原样返回，包括 workspace 之外的路径。
const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('os')
const path = require('path')
const { createLocalRuntimePaths, LOCAL_RUNTIME_ROOT } = require('./localRuntimePaths.cjs')

const HOST = 'mao.example.com'

function makePaths(getCurrentWorkspace = () => '') {
  return createLocalRuntimePaths({
    getServerHostKey: () => HOST,
    getCurrentWorkspace,
  })
}

test('resolveLocalRuntimeDir：hostKey 与 sessionId 进入 ~/.mao/runtime', () => {
  const paths = makePaths()
  assert.equal(LOCAL_RUNTIME_ROOT, path.join(os.homedir(), '.mao', 'runtime'))
  assert.equal(paths.resolveLocalRuntimeDir(42), path.join(os.homedir(), '.mao', 'runtime', HOST, '42'))
  assert.equal(paths.resolveLocalSkillsDir(42), path.join(os.homedir(), '.mao', 'runtime', HOST, '42', 'skills'))
  assert.equal(paths.resolveLocalShellOutputDir(42), path.join(os.homedir(), '.mao', 'runtime', HOST, '42', 'shellOutput'))
  // sessionId 强制字符串化
  assert.ok(paths.resolveLocalRuntimeDir('7').endsWith(path.join(HOST, '7')))
})

test('formatLocalRuntimePath：以 ~/.mao/runtime 开头，不展开 home', () => {
  const paths = makePaths()
  const display = paths.formatLocalRuntimePath(42, 'shellOutput', 'abc.out')
  assert.equal(display, `~/.mao/runtime/${HOST}/42/shellOutput/abc.out`)
  assert.ok(display.startsWith('~/.mao/runtime'))
  assert.ok(!display.includes(os.homedir()))
})

test('expandHomePath：~ 与 ~/ 展开，其它原样', () => {
  const paths = makePaths()
  assert.equal(paths.expandHomePath('~'), os.homedir())
  assert.equal(paths.expandHomePath('~/a/b'), path.join(os.homedir(), 'a', 'b'))
  assert.equal(paths.expandHomePath('/abs/path'), '/abs/path')
  assert.equal(paths.expandHomePath(''), '')
  assert.equal(paths.expandHomePath(undefined), undefined)
})

test('resolveWorkspacePath：相对路径拼 workspace / currentWorkspace', () => {
  const paths = makePaths(() => '/fallback/ws')
  assert.equal(paths.resolveWorkspacePath('a.txt', '/tmp/ws', 42), path.join('/tmp/ws', 'a.txt'))
  // workspace 缺省回退注入的 getCurrentWorkspace（D3）
  assert.equal(paths.resolveWorkspacePath('a.txt', '', 42), path.join('/fallback/ws', 'a.txt'))
  assert.equal(paths.resolveWorkspacePath('~/x.txt', '/tmp/ws', 42), path.join(os.homedir(), 'x.txt'))
})

test('resolveWorkspacePath：绝对路径原样返回（锁定不新增沙箱）', () => {
  const paths = makePaths(() => '/fallback/ws')
  assert.equal(paths.resolveWorkspacePath('/etc/hosts', '/tmp/ws', 42), '/etc/hosts')
  // workspace 之外、runtime 之外的绝对路径同样原样返回
  assert.equal(paths.resolveWorkspacePath('/Users/someone/outside.txt', '/tmp/ws', 42), '/Users/someone/outside.txt')
  // 空 path 原样返回
  assert.equal(paths.resolveWorkspacePath('', '/tmp/ws', 42), '')
})

test('isUnderLocalRuntime：仅本会话 runtime 目录及其子路径为真', () => {
  const paths = makePaths()
  const runtime42 = paths.resolveLocalRuntimeDir(42)
  assert.equal(paths.isUnderLocalRuntime(runtime42, 42), true)
  assert.equal(paths.isUnderLocalRuntime(path.join(runtime42, 'skills', 'x'), 42), true)
  assert.equal(paths.isUnderLocalRuntime(paths.resolveLocalRuntimeDir(43), 42), false)
  assert.equal(paths.isUnderLocalRuntime(path.join(runtime42 + '_sibling', 'x'), 42), false)
  assert.equal(paths.isUnderLocalRuntime('/tmp/elsewhere', 42), false)
  // 无 sessionId 直接为假
  assert.equal(paths.isUnderLocalRuntime(runtime42, undefined), false)
  assert.equal(paths.isUnderLocalRuntime(runtime42, 0), false)
})
