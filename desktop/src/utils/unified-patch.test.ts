/**
 * unified patch 解析与模型重建。
 *
 * 覆盖：单 hunk 修改 / 纯插入 / 多 hunk 行号摆放 / 多次编辑合并的多段 patch /
 * 删除行内容长得像段头 / 256KB 截断的半截 hunk / 空 patch。
 * 核心断言是「模型行号即真实行号」——行号、引用、首处变更跳转都依赖它。
 */
import { describe, expect, it } from 'vitest'
import { buildPatchDiffModels, parseUnifiedPatch } from './unified-patch'

/** 贴近 buildUnifiedPatch 的真实产出：CHANGELOG 顶部插入一行（后端不插空格，`+` 后直接跟行内容） */
const CHANGELOG_PATCH = [
  '--- a/opt/mao-data/workspace/2/projects/mao/CHANGELOG.md',
  '+++ b/opt/mao-data/workspace/2/projects/mao/CHANGELOG.md',
  '@@ -27,6 +27,7 @@',
  ' - 运行中会话（`RUNNING`）每 5 秒静默刷新会话信息与最新消息',
  ' - 工具卡片摘要统一走中文工具名（执行命令 / 读取文件 / 编辑文件）',
  ' - **前端（桌面 / Web / 安卓）**',
  '+- **修复带图消息发送后「多出一行 URL」**：图片 URL 注入行',
  ' - **修复记录详情抽屉遮罩铺满整个视口**',
  ' - **修复时间条带 key 与行锚点重复导致定位错行**',
  ' - **修复切换色条时 tooltip 短暂显示旧节点内容**',
  '',
].join('\n')

describe('parseUnifiedPatch', () => {
  it('解析单 hunk 的上下文与增删行', () => {
    const { segments } = parseUnifiedPatch(CHANGELOG_PATCH)
    expect(segments).toHaveLength(1)
    // 段头是 `--- a/${filePath}`：绝对路径会带出 `a//opt/...`，剥掉 6 字符后还原
    expect(segments[0].filePath).toBe('opt/mao-data/workspace/2/projects/mao/CHANGELOG.md')
    const [hunk] = segments[0].hunks
    expect(hunk.oldStart).toBe(27)
    expect(hunk.newStart).toBe(27)
    expect(hunk.oldLines).toHaveLength(6)
    expect(hunk.newLines).toHaveLength(7)
    expect(hunk.newLines[3]).toBe('- **修复带图消息发送后「多出一行 URL」**：图片 URL 注入行')
  })

  it('多次编辑合并的多段 patch 全解析，行号不串段', () => {
    const patch = [
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,3 @@',
      ' one',
      '-two',
      '+TWO',
      ' three',
      '',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -10,2 +10,3 @@',
      ' ten',
      '+ten-and-half',
      ' eleven',
      '',
    ].join('\n')
    const { segments } = parseUnifiedPatch(patch)
    expect(segments).toHaveLength(2)
    expect(segments[0].hunks[0].newLines).toContain('TWO')
    expect(segments[1].hunks[0].newStart).toBe(10)
    expect(segments[1].hunks[0].newLines).toEqual(['ten', 'ten-and-half', 'eleven'])
  })

  it('删除行内容以 -- 开头时不被误判成段头', () => {
    const patch = [
      '--- a/x',
      '+++ b/x',
      '@@ -1,3 +1,1 @@',
      ' keep',
      '--- a/y',
      '-gone',
      '',
    ].join('\n')
    const { segments } = parseUnifiedPatch(patch)
    expect(segments).toHaveLength(1)
    expect(segments[0].hunks[0].oldLines).toEqual(['keep', '-- a/y', 'gone'])
    expect(segments[0].hunks[0].newLines).toEqual(['keep'])
  })

  it('截断的半截 hunk 保留已解析部分，不抛错', () => {
    const patch = [
      '--- a/x',
      '+++ b/x',
      '@@ -1,5 +1,5 @@',
      ' a',
      '-b',
      '+B',
      ' c',
      '...[diff truncated]',
      '',
    ].join('\n')
    const { segments } = parseUnifiedPatch(patch)
    expect(segments[0].hunks[0].oldLines).toEqual(['a', 'b', 'c'])
    expect(segments[0].hunks[0].newLines).toEqual(['a', 'B', 'c'])
  })

  it('没有段头的 patch 也能解析（防御非法输入）', () => {
    const { segments } = parseUnifiedPatch('@@ -1,1 +1,1 @@\n-a\n+b\n')
    expect(segments).toHaveLength(1)
    expect(segments[0].filePath).toBeNull()
    expect(segments[0].hunks[0].newLines).toEqual(['b'])
  })
})

describe('buildPatchDiffModels', () => {
  it('模型行号即真实行号：插入行落在 30 行，前后是上下文', () => {
    const { original, modified } = buildPatchDiffModels(CHANGELOG_PATCH)
    const origLines = original.split('\n')
    const modLines = modified.split('\n')

    expect(origLines).toHaveLength(32)
    expect(modLines).toHaveLength(33)

    // 27 行起是上下文（markdown 列表行，内容自带「- 」），之前是填充空行
    expect(origLines[26]).toBe('- 运行中会话（`RUNNING`）每 5 秒静默刷新会话信息与最新消息')
    expect(origLines[25]).toBe('')
    // 第 30 行（下标 29）是新增行，原文该位置是上下文「修复记录详情」
    expect(modLines[29]).toBe('- **修复带图消息发送后「多出一行 URL」**：图片 URL 注入行')
    expect(origLines[29]).toBe('- **修复记录详情抽屉遮罩铺满整个视口**')
    expect(modLines[30]).toBe('- **修复记录详情抽屉遮罩铺满整个视口**')
  })

  it('纯插入 hunk（oldCount=0）：旧侧不出行，新侧落在 newStart', () => {
    const patch = [
      '--- a/x',
      '+++ b/x',
      '@@ -1,0 +2,1 @@',
      '+new line',
      '',
    ].join('\n')
    const { original, modified } = buildPatchDiffModels(patch)
    expect(original).toBe('')
    expect(modified.split('\n')).toEqual(['', 'new line'])
  })

  it('多个 hunk 之间用空行填充，各自摆在自己的行号上', () => {
    const patch = [
      '--- a/x',
      '+++ b/x',
      '@@ -2,2 +2,2 @@',
      ' two',
      '-TWO',
      '+two-fixed',
      '@@ -8,2 +8,2 @@',
      ' eight',
      '-EIGHT',
      '+eight-fixed',
      '',
    ].join('\n')
    const { original, modified } = buildPatchDiffModels(patch)
    const origLines = original.split('\n')
    const modLines = modified.split('\n')

    expect(origLines).toHaveLength(9)
    expect(origLines[1]).toBe('two')
    expect(origLines[2]).toBe('TWO')
    expect(origLines[3]).toBe('')
    expect(origLines[7]).toBe('eight')
    expect(origLines[8]).toBe('EIGHT')
    expect(modLines[2]).toBe('two-fixed')
    expect(modLines[8]).toBe('eight-fixed')
  })

  it('空 patch 产出空模型', () => {
    expect(buildPatchDiffModels('')).toEqual({ original: '', modified: '' })
  })

  it('超过 512KB 的大文件改一行：模型只承载 hunk，与文件大小无关', () => {
    // 伪造一个 60 万行的巨型文件顶部插入：patch 仍然只有几行
    const patch = [
      '--- a/big.log',
      '+++ b/big.log',
      '@@ -1,2 +1,3 @@',
      ' first',
      '+inserted',
      ' second',
      '',
    ].join('\n')
    const { modified } = buildPatchDiffModels(patch)
    expect(modified.split('\n')).toEqual(['first', 'inserted', 'second'])
  })
})
