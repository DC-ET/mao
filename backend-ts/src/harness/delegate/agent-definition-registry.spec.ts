import { describe, expect, it } from 'vitest';
import {
  AgentDefinitionRegistry,
  BUILTIN_AGENT_TYPES,
  LEGACY_AGENT_TYPE_ALIASES,
  normalizeAgentType,
} from './agent-definition-registry.js';

describe('normalizeAgentType', () => {
  it('maps legacy names', () => {
    expect(normalizeAgentType('researcher')).toBe('explorer');
    expect(normalizeAgentType('coder')).toBe('worker');
    expect(normalizeAgentType('reviewer')).toBe('reviewer');
    expect(normalizeAgentType('default')).toBe('default');
    expect(normalizeAgentType(' explorer ')).toBe('explorer');
    expect(normalizeAgentType('ghost')).toBe('ghost');
  });
});

describe('AgentDefinitionRegistry', () => {
  const registry = new AgentDefinitionRegistry();

  it('registers four builtin roles only', () => {
    expect(registry.getAllDefinitions().map((d) => d.name).sort())
      .toEqual(['default', 'explorer', 'reviewer', 'worker']);
    expect(BUILTIN_AGENT_TYPES).toEqual(['default', 'explorer', 'worker', 'reviewer']);
    expect(LEGACY_AGENT_TYPE_ALIASES).toEqual({ researcher: 'explorer', coder: 'worker' });
  });

  it('default has no override and no tool exclusions', () => {
    const def = registry.getDefinition('default')!;
    expect(def.systemPromptOverride).toBeUndefined();
    expect(def.excludedToolNames).toBeUndefined();
  });

  it('explorer and worker and reviewer are thin roles without tool exclusions', () => {
    for (const name of ['explorer', 'worker', 'reviewer'] as const) {
      const def = registry.getDefinition(name)!;
      expect(def.systemPromptOverride).toBeTruthy();
      expect(def.excludedToolNames ?? []).toEqual([]);
    }
  });

  it('normalizes legacy names on get/has', () => {
    expect(registry.getDefinition('researcher')?.name).toBe('explorer');
    expect(registry.getDefinition('coder')?.name).toBe('worker');
    expect(registry.hasDefinition('researcher')).toBe(true);
    expect(registry.hasDefinition('coder')).toBe(true);
    expect(registry.getDefinition('ghost')).toBeUndefined();
  });

  it('reviewer is not an alias of explorer', () => {
    expect(registry.getDefinition('reviewer')?.name).toBe('reviewer');
    expect(registry.getDefinition('reviewer')?.name).not.toBe('explorer');
  });
});
