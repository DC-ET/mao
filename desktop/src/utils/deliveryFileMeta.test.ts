import { describe, expect, it } from 'vitest'
import { resolveDeliveryFileMeta } from './deliveryFileMeta'

describe('resolveDeliveryFileMeta', () => {
  it('识别复合压缩后缀 .tar.gz / .tar.xz（不误判为裸 GZ / XZ）', () => {
    expect(resolveDeliveryFileMeta({ filename: 'ark-cli-skill-20261119.tar.gz' })).toEqual({
      category: 'archive',
      extBadge: 'TAR.GZ',
      typeLabel: 'TAR.GZ 压缩包',
    })
    expect(resolveDeliveryFileMeta({ filename: 'bundle.TAR.XZ' })).toEqual({
      category: 'archive',
      extBadge: 'TAR.XZ',
      typeLabel: 'TAR.XZ 压缩包',
    })
  })

  it('常见办公、文档、代码、媒体、安装包格式分类与中文标签', () => {
    expect(resolveDeliveryFileMeta({ filename: '季度经营报告.pdf' })).toEqual({
      category: 'pdf',
      extBadge: 'PDF',
      typeLabel: 'PDF 文档',
    })
    expect(resolveDeliveryFileMeta({ filename: 'sales-2026Q3.xlsx' })).toEqual({
      category: 'spreadsheet',
      extBadge: 'XLSX',
      typeLabel: 'XLSX 表格',
    })
    expect(resolveDeliveryFileMeta({ filename: 'export.csv' })).toEqual({
      category: 'spreadsheet',
      extBadge: 'CSV',
      typeLabel: 'CSV 表格',
    })
    expect(resolveDeliveryFileMeta({ filename: 'SKILL.md' })).toEqual({
      category: 'document',
      extBadge: 'MD',
      typeLabel: 'Markdown 文档',
    })
    expect(resolveDeliveryFileMeta({ filename: 'roadmap.pptx' })).toEqual({
      category: 'presentation',
      extBadge: 'PPTX',
      typeLabel: 'PPTX 演示文稿',
    })
    expect(resolveDeliveryFileMeta({ filename: 'schema.sql' })).toEqual({
      category: 'code',
      extBadge: 'SQL',
      typeLabel: 'SQL 脚本',
    })
    expect(resolveDeliveryFileMeta({ filename: 'types.d.ts' })).toEqual({
      category: 'code',
      extBadge: 'D.TS',
      typeLabel: 'D.TS 代码',
    })
    expect(resolveDeliveryFileMeta({ filename: 'fix.patch' })).toEqual({
      category: 'code',
      extBadge: 'PATCH',
      typeLabel: 'PATCH 补丁',
    })
    expect(resolveDeliveryFileMeta({ filename: 'demo.mp4' })).toEqual({
      category: 'media',
      extBadge: 'MP4',
      typeLabel: 'MP4 视频',
    })
    expect(resolveDeliveryFileMeta({ filename: 'mao-release.apk' })).toEqual({
      category: 'package',
      extBadge: 'APK',
      typeLabel: 'APK 安装包',
    })
  })

  it('带目录前缀的文件名先取末段再识别，特殊无后缀文件名友好归类', () => {
    expect(resolveDeliveryFileMeta({ filename: '/tmp/out/archive.zip' })).toEqual({
      category: 'archive',
      extBadge: 'ZIP',
      typeLabel: 'ZIP 压缩包',
    })
    expect(resolveDeliveryFileMeta({ filename: 'Dockerfile' })).toEqual({
      category: 'code',
      extBadge: '',
      typeLabel: 'Docker 配置',
    })
    expect(resolveDeliveryFileMeta({ filename: '.env' })).toEqual({
      category: 'code',
      extBadge: '',
      typeLabel: '环境配置',
    })
  })

  it('无后缀或 .bin 兜底文件名回退到 MIME 推导，未知扩展名保留大写短标', () => {
    expect(resolveDeliveryFileMeta({ filename: 'attachment', mime: 'application/pdf' })).toEqual({
      category: 'pdf',
      extBadge: 'PDF',
      typeLabel: 'PDF 文档',
    })
    expect(resolveDeliveryFileMeta({ filename: 'send-abc.bin', mime: 'text/html; charset=utf-8' })).toEqual({
      category: 'code',
      extBadge: '',
      typeLabel: '代码文件',
    })
    expect(resolveDeliveryFileMeta({ filename: 'send-abc.bin', mime: 'application/octet-stream' })).toEqual({
      category: 'generic',
      extBadge: 'BIN',
      typeLabel: 'BIN 文件',
    })
    expect(resolveDeliveryFileMeta({ filename: 'drawing.dwg' })).toEqual({
      category: 'generic',
      extBadge: 'DWG',
      typeLabel: 'DWG 文件',
    })
    expect(resolveDeliveryFileMeta({ filename: '' })).toEqual({
      category: 'generic',
      extBadge: '',
      typeLabel: '文件',
    })
  })
})
