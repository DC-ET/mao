import { describe, expect, it } from 'vitest';
import { matchShellDenyList } from './command-deny-list.js';

describe('matchShellDenyList', () => {
  it('blocks pkill targeting node', () => {
    expect(matchShellDenyList('pkill node')).toEqual({
      id: 'pkill-node',
      reason: '禁止 pkill 终止 Node 进程（会影响 Mao 后端）',
    });
    expect(matchShellDenyList('pkill -9 -f "node dist/main.js"')).toMatchObject({ id: 'pkill-node' });
    expect(matchShellDenyList('sudo pkill -f node')).toMatchObject({ id: 'pkill-node' });
  });

  it('blocks killall', () => {
    expect(matchShellDenyList('killall node')).toEqual({
      id: 'killall',
      reason: '禁止 killall',
    });
    expect(matchShellDenyList('killall -9 node')).toMatchObject({ id: 'killall' });
  });

  it('allows other shell commands', () => {
    expect(matchShellDenyList('pkill bash')).toBeNull();
    expect(matchShellDenyList('kill 12345')).toBeNull();
    expect(matchShellDenyList('lsof -ti :9080 | xargs kill')).toBeNull();
    expect(matchShellDenyList('echo hello')).toBeNull();
  });
});
