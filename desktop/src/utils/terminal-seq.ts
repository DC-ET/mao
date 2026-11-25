/**
 * 终端增量回放的序号校验。
 *
 * 服务端 output 帧带原始字节序号 [seq, endSeq]，attached 帧带当前累计序号 seq。
 * 客户端必须连续地把每帧写到 xterm 上；一旦发现帧首 seq 与预期不一致，说明中间
 * 有帧被背压丢掉（服务端显式丢弃，不补发），只能下次 attach 请求全量回放。
 *
 * 难点在「刚 attach 完、还没写过任何回放帧」的窗口：`attached(seq=B)` 之后，
 * 全量回放帧可能为空（缓冲已清 / sanitize 后为空），也可能还没到达。此时不能把
 * `expectedSeq` 先设成 B，否则回放帧的 seq < B 会被误判成缺口；也不能保持 null
 * 不管，否则第一帧实时输出被丢后，下一帧会把缺口当成正常续接。因此把 attached.seq
 * 记为基线：首帧 seq <= 基线视为回放（接受），> 基线说明回放帧与首帧之间已丢数据。
 */
export interface SeqMetaLike {
  seq: number
  endSeq: number
}

export type SeqVerdict = 'accept' | 'gap'

/**
 * @param expectedSeq 正常续接时应出现的帧首序号；null 表示尚未建立（刚 attach / 全量回放中）
 * @param attachBaseline attached 帧给出的当前累计序号；null 表示服务端未提供（旧版本）
 * @param meta 本帧的序号
 */
export function evaluateOutputSeq(
  expectedSeq: number | null,
  attachBaseline: number | null,
  meta: SeqMetaLike,
): SeqVerdict {
  if (expectedSeq != null) {
    return meta.seq === expectedSeq ? 'accept' : 'gap'
  }
  if (attachBaseline != null && meta.seq > attachBaseline) {
    return 'gap'
  }
  return 'accept'
}