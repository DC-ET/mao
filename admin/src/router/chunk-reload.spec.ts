import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CHUNK_RELOAD_STAMP_KEY,
  CHUNK_RELOAD_WINDOW_MS,
  chunkReloadTarget,
  type ChunkReloadStorage,
} from './chunk-reload.ts'

function memoryStorage(initial: Record<string, string> = {}): ChunkReloadStorage & { data: Record<string, string> } {
  const data = { ...initial }
  return {
    data,
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null
    },
    setItem(key, value) {
      data[key] = value
    },
  }
}

const chromeError = new TypeError(
  'Failed to fetch dynamically imported module: https://mao.example.com/admin/assets/AgentList-old.js',
)
const href = '/admin/agents'

describe('chunkReloadTarget', () => {
  it('整页打开尚未加载过的菜单', () => {
    const storage = memoryStorage()
    assert.equal(chunkReloadTarget(chromeError, href, storage, 1_000), href)
    assert.equal(storage.data[CHUNK_RELOAD_STAMP_KEY], '1000')
  })

  it('识别 Firefox、Safari 与 Vite 样式预加载失败', () => {
    const now = 5_000
    for (const message of [
      'error loading dynamically imported module: https://mao.example.com/admin/assets/a.js',
      'Importing a module script failed.',
      'Unable to preload CSS for https://mao.example.com/admin/assets/a.css',
    ]) {
      const storage = memoryStorage()
      assert.equal(chunkReloadTarget(new TypeError(message), href, storage, now), href)
    }
  })

  it('短时间内只跳转一次', () => {
    const storage = memoryStorage()
    assert.equal(chunkReloadTarget(chromeError, href, storage, 1_000), href)
    assert.equal(chunkReloadTarget(chromeError, '/admin/models', storage, 1_000 + CHUNK_RELOAD_WINDOW_MS - 1), null)
    assert.equal(storage.data[CHUNK_RELOAD_STAMP_KEY], '1000')
    assert.equal(chunkReloadTarget(chromeError, '/admin/models', storage, 1_000 + CHUNK_RELOAD_WINDOW_MS), '/admin/models')
  })

  it('其它导航错误不跳转，也不占用跳转窗口', () => {
    const storage = memoryStorage()
    assert.equal(chunkReloadTarget(new Error('网络不可用'), href, storage, 1_000), null)
    assert.equal(storage.data[CHUNK_RELOAD_STAMP_KEY], undefined)
    assert.equal(chunkReloadTarget('not a chunk error', href, storage, 1_000), null)
    assert.equal(chunkReloadTarget(chromeError, '', storage, 1_000), null)
    assert.equal(chunkReloadTarget(chromeError, href, null, 1_000), null)
  })

  it('读写会话存储失败时不跳转，避免无法记下标记后反复刷新', () => {
    const readFails: ChunkReloadStorage = {
      getItem() {
        throw new Error('denied')
      },
      setItem() {
        throw new Error('denied')
      },
    }
    assert.equal(chunkReloadTarget(chromeError, href, readFails, 1_000), null)

    const writeFails: ChunkReloadStorage = {
      getItem() {
        return null
      },
      setItem() {
        throw new Error('denied')
      },
    }
    assert.equal(chunkReloadTarget(chromeError, href, writeFails, 1_000), null)
  })
})
