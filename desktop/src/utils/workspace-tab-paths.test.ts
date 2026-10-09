import { describe, expect, it } from 'vitest'
import { retargetTabPath } from './workspace-tab-paths'

describe('retargetTabPath', () => {
  it('closes a file tab and everything under a deleted directory', () => {
    expect(retargetTabPath('src/a.ts', { kind: 'delete', paths: ['src'] })).toEqual({ action: 'close' })
    expect(retargetTabPath('src', { kind: 'delete', paths: ['src'] })).toEqual({ action: 'close' })
    expect(retargetTabPath('src2/a.ts', { kind: 'delete', paths: ['src'] })).toEqual({ action: 'keep' })
  })

  it('rewrites a renamed file and its descendants', () => {
    expect(retargetTabPath('src/a.ts', { kind: 'move', from: 'src/a.ts', to: 'lib/a.ts' })).toEqual({
      action: 'retarget',
      path: 'lib/a.ts',
    })
    expect(retargetTabPath('src/inner/b.ts', { kind: 'move', from: 'src', to: 'lib' })).toEqual({
      action: 'retarget',
      path: 'lib/inner/b.ts',
    })
    expect(retargetTabPath('other.ts', { kind: 'move', from: 'src', to: 'lib' })).toEqual({ action: 'keep' })
  })
})
