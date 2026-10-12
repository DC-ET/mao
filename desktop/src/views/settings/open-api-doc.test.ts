import { describe, expect, it } from 'vitest'
import doc from './open-api-doc.md?raw'

// ?raw 导入路径写错或被 tree-shake 掉时得到空串，界面会渲染出空文档，
// 这里守住内容本身：三条通道的端点、鉴权与签名契约、错误码必须都在。
describe('开放接口内嵌文档', () => {
  it('非空且标题正确', () => {
    expect(doc.length).toBeGreaterThan(1000)
    expect(doc.startsWith('# Mao 开放接口文档')).toBe(true)
  })

  it('覆盖两条入站端点', () => {
    expect(doc).toContain('POST /open/agents/:agentId/run')
    expect(doc).toContain('POST /open/hooks/:pathToken')
  })

  it('覆盖鉴权与 HMAC 签名契约', () => {
    expect(doc).toContain('Authorization: Bearer mao_xxx')
    expect(doc).toContain('X-Mao-Timestamp')
    expect(doc).toContain('X-Mao-Signature')
    expect(doc).toContain('sha256=<hex(HMAC-SHA256(secret, "<timestamp>.<原始请求体>"))>')
    expect(doc).toContain('±300 秒')
  })

  it('覆盖限流与三种出站事件', () => {
    expect(doc).toContain('60 次/分钟')
    expect(doc).toContain('task.completed')
    expect(doc).toContain('task.failed')
    expect(doc).toContain('question.pending')
  })

  it('错误码与后端 error-code 对齐', () => {
    expect(doc).toContain('3040')
    expect(doc).toContain('3043')
    expect(doc).toContain('1007')
  })
})
