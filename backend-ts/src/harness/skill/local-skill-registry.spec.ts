import { describe, expect, it } from 'vitest';
import { LocalSkillRegistry } from './local-skill-registry.js';

describe('LocalSkillRegistry', () => {
  const registry = new LocalSkillRegistry();

  it('reportAndGetRoundTrips', () => {
    registry.report(11, [{ name: 'my-skill', description: 'desc', folderName: 'my-skill-folder' }]);
    const result = registry.get(11);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('my-skill');
    expect(result[0].folderName).toBe('my-skill-folder');
  });

  it('getReturnsEmptyForUnknownSession', () => {
    expect(registry.get(999)).toEqual([]);
    expect(registry.get(null)).toEqual([]);
  });

  it('reportIgnoresUnsafeFolderNames', () => {
    registry.report(1, [
      { name: 'evil', folderName: '../../etc' },
      { name: 'hidden', folderName: '.git' },
      { name: 'ok', folderName: 'ok-folder' },
    ]);
    expect(registry.get(1).map((r) => r.name)).toEqual(['ok']);
  });

  it('reportEmptyListClearsPreviousReport', () => {
    registry.report(5, [{ name: 'a', folderName: 'a' }]);
    expect(registry.get(5)).toHaveLength(1);
    registry.report(5, []);
    expect(registry.get(5)).toEqual([]);
  });

  it('clearRemovesReportedSkills', () => {
    registry.report(5, [{ name: 'a', folderName: 'a' }]);
    registry.clear(5);
    expect(registry.get(5)).toEqual([]);
  });
});
