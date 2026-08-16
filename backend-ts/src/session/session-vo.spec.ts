import { describe, expect, it } from 'vitest';
import { toMessageVO, toStoredContentJson } from './session-vo.js';

describe('toMessageVO multimodal images', () => {
  it('extracts images from Java image_url shape', () => {
    const vo = toMessageVO({
      id: 1,
      role: 'USER',
      content: JSON.stringify([
        { type: 'text', text: '这是啥' },
        { type: 'image_url', image_url: { url: 'https://cdn.example/a.png' } },
      ]),
    });
    expect(vo.content).toBe('这是啥');
    expect(vo.images).toEqual(['https://cdn.example/a.png']);
  });

  it('extracts images from camelCase imageUrl leftover', () => {
    const vo = toMessageVO({
      id: 2,
      role: 'USER',
      content: JSON.stringify([
        { type: 'text', text: '这是啥' },
        { type: 'image_url', imageUrl: { url: 'https://cdn.example/b.png' } },
      ]),
    });
    expect(vo.content).toBe('这是啥');
    expect(vo.images).toEqual(['https://cdn.example/b.png']);
  });
});

describe('toStoredContentJson', () => {
  it('rewrites imageUrl to image_url before persist', () => {
    const json = toStoredContentJson([
      { type: 'text', text: 'hi' },
      { type: 'image_url', imageUrl: { url: 'https://cdn.example/c.png' } },
    ]);
    expect(JSON.parse(json)).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'image_url', image_url: { url: 'https://cdn.example/c.png' } },
    ]);
  });
});
