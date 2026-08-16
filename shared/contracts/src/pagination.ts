/**
 * 通用分页契约。
 * 后端列表类接口的响应统一遵循此结构；前端消费时可通过泛型获得 items 类型。
 */
export interface PageQuery {
  page: number;
  size: number;
}

export interface PageResult<T> {
  records: T[];
  total: number;
  page: number;
  size: number;
}
