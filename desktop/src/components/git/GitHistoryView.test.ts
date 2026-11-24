// GitHistoryView 提交图谱：无筛选时每行画图谱、展开区画穿行竖线；路径 / 关键词筛选时退回扁平列表并提示；
// 「全部分支」开关 emit；合并提交标题简化为「A → B」，title 保留原文。
// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue'
import { beforeEach, describe, expect, it } from 'vitest'
import GitHistoryView from './GitHistoryView.vue'
import type { GitLogEntry } from '../../types/git'

function c(hash: string, title: string, ...parents: string[]): GitLogEntry {
  return { hash, shortHash: hash.slice(0, 7), title, author: 'T', date: '2026-11-24T10:00:00+08:00', parents }
}

const entries: GitLogEntry[] = [
  c('m000000', "Merge branch 'feature/x' into 'master'", 'b000000', 'f000000'),
  c('f000000', 'feature work', 'a000000'),
  c('b000000', 'main work', 'a000000'),
  c('a000000', 'init'),
]

function mount(props: Record<string, unknown> = {}) {
  const emitted: Array<{ event: string; args: unknown[] }> = []
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({
    render: () => h(GitHistoryView as any, {
      entries,
      ...props,
      'onUpdate:allBranches': (...args: unknown[]) => emitted.push({ event: 'update:allBranches', args }),
    }),
  })
  app.mount(host)
  return { host, app, emitted }
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('GitHistoryView 图谱', () => {
  it('无筛选时每行一个图谱单元，合并提交圆点为空心', () => {
    const { host, app } = mount()
    const cells = host.querySelectorAll('.git-log-main .git-graph-cell')
    expect(cells.length).toBe(4)
    expect(host.querySelector('.git-graph-hint')).toBeNull()
    const nodes = host.querySelectorAll('.git-graph-node')
    expect(nodes[0].classList.contains('is-merge')).toBe(true)
    expect(nodes[1].classList.contains('is-merge')).toBe(false)
    // 两列宽：每列 14px
    expect((cells[0] as HTMLElement).style.width).toBe('28px')
    app.unmount()
  })

  it('展开某行时文件清单左侧画该行的穿行竖线', async () => {
    const { host, app } = mount({ expandedCommit: 'f000000', commitFiles: new Map([['f000000', []]]) })
    await nextTick()
    const gutter = host.querySelector('.git-commit-expand .git-graph-cell')
    expect(gutter).not.toBeNull()
    // f 之后第 0 列（等 b）与第 1 列（等 a）都在等待
    expect(gutter!.querySelectorAll('path').length).toBe(2)
    app.unmount()
  })

  it.each([
    [{ pathFilter: 'src/a.ts' }],
    [{ keyword: 'fix' }],
  ])('筛选 %o 时不画图谱并提示', (props) => {
    const { host, app } = mount(props)
    expect(host.querySelectorAll('.git-graph-cell').length).toBe(0)
    expect(host.querySelector('.git-graph-hint')?.textContent).toContain('筛选中不显示图谱')
    app.unmount()
  })

  it('勾选「全部分支」emit update:allBranches', async () => {
    const { host, app, emitted } = mount()
    const box = host.querySelector('.git-filter-toggle input') as HTMLInputElement
    expect(box.checked).toBe(false)
    box.checked = true
    box.dispatchEvent(new Event('change'))
    await nextTick()
    expect(emitted).toEqual([{ event: 'update:allBranches', args: [true] }])
    app.unmount()
  })

  it('合并提交标题简化为「A → B」，title 保留原文；普通提交原样', () => {
    const { host, app } = mount()
    const titles = host.querySelectorAll('.git-log-title')
    expect(titles[0].classList.contains('is-merge')).toBe(true)
    expect(titles[0].textContent?.trim()).toBe('feature/x → master')
    expect(titles[0].getAttribute('title')).toBe("Merge branch 'feature/x' into 'master'")
    expect(titles[1].textContent?.trim()).toBe('feature work')
    app.unmount()
  })
})
