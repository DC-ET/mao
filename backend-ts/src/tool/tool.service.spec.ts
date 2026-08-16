import { describe, expect, it } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { ToolService } from './tool.service.js';
import type { ToolInfo, ToolRegistry } from './types.js';

describe('ToolService', () => {
  const tools: ToolInfo[] = [
    { name: 'read_file', description: 'Read a file' },
    { name: 'write_file', description: 'Write a file' },
  ];
  const registry: ToolRegistry = {
    getAllTools: () => tools,
    getTool: (name) => tools.find((t) => t.name === name) ?? null,
  };
  const service = new ToolService(registry);

  it('listToolsReturnsRegistryTools', () => {
    expect(service.listTools()).toEqual(tools);
  });

  it('getToolThrowsWhenMissing', () => {
    expect(() => service.getTool('missing')).toThrow(BusinessException);
    try {
      service.getTool('missing');
    } catch (e) {
      expect((e as BusinessException).code).toBe(ErrorCode.SKILL_NOT_FOUND.code);
    }
  });

  it('getToolReturnsMatch', () => {
    expect(service.getTool('read_file').description).toBe('Read a file');
  });
});
