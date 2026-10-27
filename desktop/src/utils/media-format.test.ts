// media-format 纯函数回归（技术方案 §5.7 / 决策 5）：video / audio 分支
// （按扩展名）、Blob MIME 映射、50MB 播放上限常量。白名单外扩展名回落 video。
// MEDIA_EXTENSIONS 是 dispatch 判定的唯一来源：这里顺带守住「白名单内每个扩展名
// 都有明确 MIME 与元素分支」，漏一个就是进了 MediaPlayer 却拿到裸 octet-stream。
import { describe, expect, it } from 'vitest'
import { MEDIA_EXTENSIONS, MEDIA_MAX_BYTES, isCodecDependent, mediaKindOf, mediaMimeOf } from './media-format'

describe('mediaKindOf 元素分支', () => {
  it('视频扩展名走 video：mp4 / webm / mov', () => {
    expect(mediaKindOf('a.mp4')).toBe('video')
    expect(mediaKindOf('a.webm')).toBe('video')
    expect(mediaKindOf('a.mov')).toBe('video')
  })

  it('音频扩展名走 audio：m4a / mp3 / wav / flac / ogg', () => {
    expect(mediaKindOf('a.m4a')).toBe('audio')
    expect(mediaKindOf('a.mp3')).toBe('audio')
    expect(mediaKindOf('a.wav')).toBe('audio')
    expect(mediaKindOf('a.flac')).toBe('audio')
    expect(mediaKindOf('a.ogg')).toBe('audio')
  })

  it('大小写不敏感；带目录 / 双扩展名取末段', () => {
    expect(mediaKindOf('dir/SUB/MOVIE.MP4')).toBe('video')
    expect(mediaKindOf('song-final.WAV')).toBe('audio')
    expect(mediaKindOf('data.csv.mp3')).toBe('audio')
  })

  it('白名单外 / 无扩展名回落 video（video 元素可播纯音频）', () => {
    expect(mediaKindOf('clip.avi')).toBe('video')
    expect(mediaKindOf('noext')).toBe('video')
    expect(mediaKindOf('.gitignore')).toBe('video')
  })
})

describe('mediaMimeOf Blob MIME', () => {
  it('八个白名单扩展名各有标准 MIME', () => {
    expect(mediaMimeOf('a.mp4')).toBe('video/mp4')
    expect(mediaMimeOf('a.webm')).toBe('video/webm')
    expect(mediaMimeOf('a.mov')).toBe('video/quicktime')
    expect(mediaMimeOf('a.m4a')).toBe('audio/mp4')
    expect(mediaMimeOf('a.mp3')).toBe('audio/mpeg')
    expect(mediaMimeOf('a.wav')).toBe('audio/wav')
    expect(mediaMimeOf('a.flac')).toBe('audio/flac')
    expect(mediaMimeOf('a.ogg')).toBe('audio/ogg')
  })

  it('未知扩展名回落 application/octet-stream', () => {
    expect(mediaMimeOf('a.avi')).toBe('application/octet-stream')
    expect(mediaMimeOf('noext')).toBe('application/octet-stream')
  })
})

describe('isCodecDependent 编解码依赖（§6-G2 ★）', () => {
  it('mp4 / mov 需要标注（Electron 官方构建无 H.264 / AAC）', () => {
    expect(isCodecDependent('a.mp4')).toBe(true)
    expect(isCodecDependent('a.mov')).toBe(true)
    expect(isCodecDependent('dir/SUB/MOVIE.MOV')).toBe(true)
  })

  it('白名单优先格式（webm / ogg / wav 等）不需要标注', () => {
    for (const ext of ['webm', 'm4a', 'mp3', 'wav', 'flac', 'ogg']) {
      expect(isCodecDependent(`a.${ext}`), ext).toBe(false)
    }
    expect(isCodecDependent('clip.avi')).toBe(false)
    expect(isCodecDependent('noext')).toBe(false)
  })
})

describe('MEDIA_MAX_BYTES 阈值（决策 5）', () => {
  it('50MB', () => {
    expect(MEDIA_MAX_BYTES).toBe(50 * 1024 * 1024)
  })
})

describe('MEDIA_EXTENSIONS 白名单一致性', () => {
  it('八个扩展名无重复，且各自有明确 MIME 与 video / audio 分支', () => {
    expect(MEDIA_EXTENSIONS).toHaveLength(8)
    expect(new Set(MEDIA_EXTENSIONS).size).toBe(8)
    for (const ext of MEDIA_EXTENSIONS) {
      expect(mediaKindOf(`a.${ext}`), ext).toMatch(/^(video|audio)$/)
      expect(mediaMimeOf(`a.${ext}`), ext).not.toBe('application/octet-stream')
    }
  })
})
