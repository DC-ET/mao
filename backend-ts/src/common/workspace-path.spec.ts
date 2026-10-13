import { describe, expect, it } from 'vitest';
import { toWorkspaceRelative } from './workspace-path.js';

describe('toWorkspaceRelative', () => {
  const workspace = '/opt/mao-data/workspace/feishu-chat/2/oc_group';

  it('converts path under workspace to relative', () => {
    expect(toWorkspaceRelative(workspace, `${workspace}/chat-files/2026-10-13/feishu-image-om_1.jpg`))
      .toBe('chat-files/2026-10-13/feishu-image-om_1.jpg');
  });

  it('keeps path outside workspace as absolute', () => {
    expect(toWorkspaceRelative(workspace, '/tmp/other/a.png')).toBe('/tmp/other/a.png');
  });

  it('keeps path escaping workspace via .. as absolute', () => {
    expect(toWorkspaceRelative('/ws/a', '/ws/ab/a.png')).toBe('/ws/ab/a.png');
  });

  it('keeps original path when workspace unknown', () => {
    expect(toWorkspaceRelative(null, '/ws/chat-files/a.png')).toBe('/ws/chat-files/a.png');
    expect(toWorkspaceRelative('', '/ws/chat-files/a.png')).toBe('/ws/chat-files/a.png');
    expect(toWorkspaceRelative(undefined, '/ws/chat-files/a.png')).toBe('/ws/chat-files/a.png');
  });

  it('keeps workspace root itself as absolute', () => {
    expect(toWorkspaceRelative(workspace, workspace)).toBe(workspace);
  });
});
