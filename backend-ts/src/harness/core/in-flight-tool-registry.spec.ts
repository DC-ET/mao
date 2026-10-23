import { describe, expect, it } from 'vitest';
import { InFlightToolRegistry } from './in-flight-tool-registry.js';

describe('InFlightToolRegistry', () => {
  it('registers running tools per session and drops them on finish', () => {
    const registry = new InFlightToolRegistry();
    registry.start(1, { id: 'a', name: 'shell', arguments: '{"command":"ls"}' });
    registry.start(1, { id: 'b', name: 'read_file', arguments: '{"path":"a.ts"}' });
    registry.start(2, { id: 'c', name: 'shell', arguments: '{}' });

    expect(registry.listForSession(1).map((c) => c.id)).toEqual(['a', 'b']);
    expect(registry.listForSession(2).map((c) => c.id)).toEqual(['c']);

    registry.finish(1, 'a');
    expect(registry.listForSession(1).map((c) => c.id)).toEqual(['b']);

    registry.finish(1, 'b');
    expect(registry.listForSession(1)).toEqual([]);
    expect(registry.listForSession(2)).toHaveLength(1);
  });

  it('ignores blank tool call ids and clears a whole session', () => {
    const registry = new InFlightToolRegistry();
    registry.start(1, { id: '', name: 'shell', arguments: '' });
    expect(registry.listForSession(1)).toEqual([]);

    registry.start(1, { id: 'a', name: 'shell', arguments: '' });
    registry.clear(1);
    expect(registry.listForSession(1)).toEqual([]);
  });
});
