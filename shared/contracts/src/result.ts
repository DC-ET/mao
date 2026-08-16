/**
 * 统一响应结构 Result<T>。
 * 全后端 REST API 与前端请求封装共同遵循的契约：
 * code=0 表示成功；data 承载业务数据。
 *
 * 注意：此文件只放类型。运行时工厂函数（ok/fail 等）保留在后端
 * backend-ts/src/common/result.ts，前端不应依赖任何运行时实现。
 */
export interface Result<T> {
  code: number;
  message: string;
  data?: T;
  timestamp: number;
}
