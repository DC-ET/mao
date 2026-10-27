import { describe, expect, it } from 'vitest'
import { createMessageRuntimeModule } from './messages'
import type { FileChange } from '../../types/chat'

function change(path: string): FileChange {
  return { path, type: 'MODIFIED', linesAdded: 1, linesDeleted: 0 }
}

describe('file quote revision', () => {
  it('同一路径合并后修订号继续加，历史灌入和别的工作区不加', () => {
    const runtime = createMessageRuntimeModule({
      getActiveSessionId: () => '1',
      syncSideTaskPendingCount: () => {},
    })
    runtime.appendFileChange('1', change('src/a.py'), '/ws')
    runtime.appendFileChange('1', change('src/a.py'), '/ws')
    expect(runtime.getFileChanges('1')).toHaveLength(1)
    expect(runtime.fileQuoteRevision('/ws', 'src/a.py')).toBe(2)

    runtime.appendFileChange('1', change('/ws/src/a.py'), '/ws')
    expect(runtime.getFileChanges('1')).toHaveLength(2)
    expect(runtime.fileQuoteRevision('/ws', '/ws/src/a.py')).toBe(3)

    runtime.setFileChanges('1', [change('src/a.py'), change('src/b.py'), change('src/a.py')])
    expect(runtime.fileQuoteRevision('/ws', 'src/a.py')).toBe(3)

    runtime.appendFileChange('9', change('src/a.py'))
    expect(runtime.fileQuoteRevision('/ws', 'src/a.py')).toBe(3)

    runtime.appendFileChange('9', change('src/a.py'), '/other')
    expect(runtime.fileQuoteRevision('/ws', 'src/a.py')).toBe(3)
    expect(runtime.fileQuoteRevision('/other', 'src/a.py')).toBe(1)
  })
})
