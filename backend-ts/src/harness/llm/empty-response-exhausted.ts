/**
 * AgentLoop 在连续空响应自动重试耗尽后抛出的终态异常。
 * 适配器必须原样透传：既不能包装成流中断，也不能触发整轮流重试——
 * 空响应已在循环内做过带退避的逐轮重试，再叠加轮次只会重复消耗 token。
 */
export class EmptyResponseExhaustedException extends Error {
  constructor() {
    super('LLM 连续返回空响应，自动重试已耗尽，请重试');
    this.name = 'EmptyResponseExhaustedException';
  }
}
