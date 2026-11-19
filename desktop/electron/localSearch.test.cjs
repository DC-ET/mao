'use strict'

// localSearch：rg 行解析与 Node 回退下的 glob/grep 行为（技术方案 2026-11-19 §8）。
// 不要求运行环境安装 rg：注入必然失败的 execFile，强制走 Node 回退；rg 探测缓存随工厂实例隔离。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createLocalSearch, parseRgLine } = require('./localSearch.cjs')

function withTmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-search-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 必然失败的 execFile：等价于环境里没有 rg，探测结果缓存在工厂闭包内不外泄 */
function failingExecFile(cmd, args, optsOrCb, maybeCb) {
  const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb
  process.nextTick(() => cb(new Error('rg not installed')))
}

function makeSearch(t, overrides = {}) {
  return createLocalSearch({
    resolveWorkspacePath: (filePath, workspace) =>
      path.isAbsolute(filePath) ? filePath : (workspace ? path.join(workspace, filePath) : filePath),
    getCurrentWorkspace: () => overrides.currentWorkspace || '',
    execFileImpl: overrides.execFileImpl || failingExecFile,
  })
}

// ---- parseRgLine ----

test('parseRgLine：冒号分隔的匹配行', () => {
  const scope = { cwd: '/w', rgTarget: '.', singleFile: null }
  const parsed = parseRgLine('src/a.js:12:const x = 1', scope, '/w')
  assert.deepEqual(parsed, { file: 'src/a.js', line: 12, content: 'const x = 1' })
})

test('parseRgLine：dash 分支（原实现先找双冒号，纯 path-num-ctx 上下文行返回 null）', () => {
  const scope = { cwd: '/w', rgTarget: '.', singleFile: null }
  // rg --context 的上下文行（path-num-ctx，无冒号）在原实现中不可解析
  assert.equal(parseRgLine('src/a.js-13-let y = 2', scope, '/w'), null)
  // 双冒号且中间段非数字时走 dash 分支：file 段取第一个 dash 前、行号取两个 dash 之间的数字
  assert.deepEqual(
    parseRgLine('src:x-1-2:12:content', scope, '/w'),
    { file: 'src:x', line: 1, content: '2:12:content' }
  )
})

test('parseRgLine：非法行返回 null', () => {
  const scope = { cwd: '/w', rgTarget: '.', singleFile: null }
  assert.equal(parseRgLine('no separators here', scope, '/w'), null)
  assert.equal(parseRgLine('a:b', scope, '/w'), null)
})

test('parseRgLine：单文件行解析（file 取相对 workspaceRoot 的路径）', () => {
  const scope = { cwd: '/w', rgTarget: 'a.js', singleFile: '/w/a.js' }
  assert.deepEqual(parseRgLine('12:const x = 1', scope, '/w'), { file: 'a.js', line: 12, content: 'const x = 1' })
  assert.deepEqual(parseRgLine('13-ctx', scope, '/w'), { file: 'a.js', line: 13, content: 'ctx' })
  assert.equal(parseRgLine('not-a-number:ctx', scope, '/w'), null)
})

// ---- Node 回退：glob ----

test('Node 回退 glob：命中（含 basename 兜底）、跳过 node_modules/.git', (t) => {
  const dir = withTmpdir(t)
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x')
  fs.mkdirSync(path.join(dir, 'sub'))
  fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'x')
  fs.mkdirSync(path.join(dir, 'sub', 'deep'))
  fs.writeFileSync(path.join(dir, 'sub', 'deep', 'c.txt'), 'x')
  fs.mkdirSync(path.join(dir, 'node_modules'))
  fs.writeFileSync(path.join(dir, 'node_modules', 'd.txt'), 'x')
  fs.mkdirSync(path.join(dir, '.git'))
  fs.writeFileSync(path.join(dir, '.git', 'e.txt'), 'x')

  const search = makeSearch(t)

  return search.handleGlobSearch({ pattern: '*.txt' }, dir, 42).then((r) => {
    // 原实现兜底用 entry.name 匹配：子目录下的同名后缀文件也命中；node_modules/.git 始终跳过
    assert.deepEqual([...r.files].sort(), ['a.txt', 'sub/b.txt', 'sub/deep/c.txt'])
    assert.equal(r.truncated, false)
    assert.equal(r.total_matched, 3)
    assert.equal(r.search_root, dir)

    // 目录限定的 pattern 不吃 basename 兜底（相对路径与文件名都不匹配）
    return search.handleGlobSearch({ pattern: 'deep/*.txt' }, dir, 42)
  }).then((r) => {
    assert.deepEqual(r.files, [])

    // path 参数指向子目录：scope.cwd 为 sub，命中文件相对 sub 自身（basename 兜底同样生效）
    return search.handleGlobSearch({ pattern: '*.txt', path: 'sub' }, dir, 42)
  }).then((r) => {
    assert.deepEqual([...r.files].sort(), ['b.txt', 'deep/c.txt'])
    assert.equal(r.search_root, path.join(dir, 'sub'))
  })
})

test('Node 回退 glob：head_limit 截断 truncated=true', (t) => {
  const dir = withTmpdir(t)
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), 'x')
  const search = makeSearch(t)
  return search.handleGlobSearch({ pattern: '*.txt', head_limit: 2 }, dir, 42).then((r) => {
    assert.equal(r.files.length, 2)
    assert.equal(r.truncated, true)
    assert.equal(r.total_matched, 2)
  })
})

// ---- Node 回退：grep ----

function writeGrepFixture(t) {
  const dir = withTmpdir(t)
  fs.writeFileSync(path.join(dir, 'a.txt'), 'Hello world\nfoo bar\nhello again\n')
  fs.mkdirSync(path.join(dir, 'sub'))
  fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'HELLO\n')
  return dir
}

test('Node 回退 grep：大小写敏感默认，ignore_case 展开', (t) => {
  const dir = writeGrepFixture(t)
  const search = makeSearch(t)

  return search.handleGrepSearch({ pattern: 'hello' }, dir, 42).then((r) => {
    assert.equal(r.matches.length, 1)
    assert.deepEqual(r.matches[0], { file: 'a.txt', line: 3, content: 'hello again' })
    assert.equal(r.truncated, false)

    return search.handleGrepSearch({ pattern: 'hello', ignore_case: true }, dir, 42)
  }).then((r) => {
    assert.equal(r.matches.length, 3)
  })
})

test('Node 回退 grep：上下文行', (t) => {
  const dir = writeGrepFixture(t)
  const search = makeSearch(t)
  return search.handleGrepSearch({ pattern: 'bar', context_lines: 1 }, dir, 42).then((r) => {
    assert.equal(r.matches.length, 1)
    assert.deepEqual(r.matches[0].context_before, ['Hello world'])
    assert.deepEqual(r.matches[0].context_after, ['hello again'])
  })
})

test('Node 回退 grep：max_output_chars 截断 truncated=true', (t) => {
  const dir = writeGrepFixture(t)
  const search = makeSearch(t)
  return search.handleGrepSearch({ pattern: 'hello', ignore_case: true, max_output_chars: 10 }, dir, 42).then((r) => {
    assert.equal(r.truncated, true)
  })
})

test('Node 回退 grep：非法正则返回 error 不抛出', (t) => {
  const dir = writeGrepFixture(t)
  const search = makeSearch(t)
  return search.handleGrepSearch({ pattern: '(' }, dir, 42).then((r) => {
    assert.deepEqual(r.matches, [])
    assert.ok(r.error.includes('Invalid regex pattern'))
  })
})

test('Node 回退 grep：glob 过滤文件名', (t) => {
  const dir = writeGrepFixture(t)
  const search = makeSearch(t)
  return search.handleGrepSearch({ pattern: 'hello', ignore_case: true, glob: '*.txt' }, dir, 42).then((r) => {
    // 只扫根目录 a.txt；sub/b.txt 命名匹配 *.txt 但在子目录同样扫到 —— 以 minimatch(basename) 为准
    assert.ok(r.matches.every((m) => m.file.endsWith('.txt')))
    assert.ok(r.matches.some((m) => m.file === 'sub/b.txt'))
  })
})

// ---- 错误路径与 currentWorkspace 注入 ----

test('路径不存在返回 error，不抛出', (t) => {
  const search = makeSearch(t)
  return search.handleGlobSearch({ pattern: '*.txt', path: '/nonexistent-mao-test-xyz' }, '', 42).then((r) => {
    assert.deepEqual(r.files, [])
    assert.ok(r.error.includes('does not exist'))
  })
})

test('workspace 省略时回退注入的 getCurrentWorkspace（D3）', (t) => {
  const dir = withTmpdir(t)
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x')
  const search = makeSearch(t, { currentWorkspace: dir })
  return search.handleGlobSearch({ pattern: '*.txt' }, '', 42).then((r) => {
    assert.deepEqual(r.files, ['a.txt'])
  })
})

test('缺少 pattern 返回错误', () => {
  const search = makeSearch()
  return Promise.all([
    search.handleGlobSearch({}, '/tmp', 42),
    search.handleGrepSearch({}, '/tmp', 42),
  ]).then(([globR, grepR]) => {
    assert.ok(globR.error.includes('pattern is required'))
    assert.ok(grepR.error.includes('pattern is required'))
  })
})

test('rg 可用时走 rg 分支（execFile 注入成功路径）', (t) => {
  const dir = withTmpdir(t)
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x')
  const calls = []
  const fakeExecFile = (cmd, args, optsOrCb, maybeCb) => {
    calls.push({ cmd, args })
    const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb
    if (args[0] === '--version') {
      process.nextTick(() => cb(null, 'ripgrep 14.0.0', ''))
    } else {
      process.nextTick(() => cb(null, `${dir}/a.txt\n`, ''))
    }
  }
  const search = makeSearch(t, { execFileImpl: fakeExecFile })
  return search.handleGlobSearch({ pattern: '*.txt' }, dir, 42).then((r) => {
    assert.deepEqual(r.files, ['a.txt'])
    assert.ok(calls.length >= 2)
    assert.equal(calls[0].cmd, 'rg')
  })
})
