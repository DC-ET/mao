import { describe, expect, it } from 'vitest';
import type { ChatRequest } from '../llm/chat-request.js';
import { SYNTHETIC_ATTACHMENT_PROMPT } from './tool-media-injector.js';
import { OMITTED_IMAGE_PLACEHOLDER, stripImagesForCompaction } from './compaction-image-stripper.js';

function requestWith(images: string[]): ChatRequest {
  return {
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'look at these' },
      ...images.map((url) => ({
        role: 'user' as const,
        content: [
          { type: 'text', text: SYNTHETIC_ATTACHMENT_PROMPT },
          { type: 'image_url', imageUrl: { url } },
        ],
      })),
      { role: 'tool', toolCallId: 'c1', content: '{"ok":true}' },
    ],
    promptCacheKey: 'mao-session-9',
    stream: true,
  };
}

describe('stripImagesForCompaction', () => {
  it('removes synthetic attachment messages and keeps the rest of the history', () => {
    const request = requestWith(['data:image/png;base64,AAA', 'data:image/png;base64,BBB']);
    const stripped = stripImagesForCompaction(request);
    expect(stripped.messages).toHaveLength(3);
    expect(stripped.messages?.map((m) => m.role)).toEqual(['system', 'user', 'tool']);
    expect(stripped.messages?.[1].content).toBe('look at these');
    expect(stripped.promptCacheKey).toBe('mao-session-9');
    expect(stripped.stream).toBe(true);
  });

  it('replaces inline image parts with a text placeholder', () => {
    const request: ChatRequest = {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'see' },
          { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAA' } },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,BBB' } },
        ],
      }],
    };
    const stripped = stripImagesForCompaction(request);
    const content = stripped.messages?.[0].content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(3);
    expect(content[1]).toEqual({ type: 'text', text: OMITTED_IMAGE_PLACEHOLDER });
    expect(content[2]).toEqual({ type: 'text', text: OMITTED_IMAGE_PLACEHOLDER });
  });

  it('does not mutate the source request', () => {
    const request = requestWith(['data:image/png;base64,AAA']);
    const originalMessages = request.messages;
    const originalContent = JSON.stringify(request.messages);
    stripImagesForCompaction(request);
    expect(request.messages).toBe(originalMessages);
    expect(JSON.stringify(request.messages)).toBe(originalContent);
  });

  it('keeps text-only messages untouched', () => {
    const request: ChatRequest = { messages: [{ role: 'user', content: 'plain' }] };
    expect(stripImagesForCompaction(request).messages).toEqual(request.messages);
  });
});
