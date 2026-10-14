import { describe, expect, it } from 'vitest';
import { mapToolToType } from './activity-type-mapper.js';

/**
 * session_activity.type 映射必须覆盖真实注册的工具名。
 * 文件/内容搜索工具改名成 glob_search / grep_search 后，mapper 的 case 标签
 * 还是老的 glob / list，导致这两类活动全落进默认的 TOOL，概览统计里看不到搜索。
 */
describe('mapToolToType', () => {
  it('glob_search 归 EXPLORE（文件搜索）', () => {
    expect(mapToolToType('glob_search')).toBe('EXPLORE');
  });

  it('grep_search 归 EXPLORE（内容搜索）', () => {
    expect(mapToolToType('grep_search')).toBe('EXPLORE');
  });

  it('大小写不敏感：GLOB_SEARCH / Grep_Search 同样归 EXPLORE', () => {
    expect(mapToolToType('GLOB_SEARCH')).toBe('EXPLORE');
    expect(mapToolToType('Grep_Search')).toBe('EXPLORE');
  });

  it('已登记的其他工具名保持原归类（回归护栏）', () => {
    expect(mapToolToType('read_file')).toBe('READ');
    expect(mapToolToType('write_file')).toBe('EDIT');
    expect(mapToolToType('edit_file')).toBe('EDIT');
    expect(mapToolToType('shell')).toBe('RUN');
    expect(mapToolToType('task_create')).toBe('TASK');
    expect(mapToolToType('unknown_tool')).toBe('TOOL');
    expect(mapToolToType(null)).toBe('TOOL');
  });
});
