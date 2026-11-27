import { describe, expect, it, vi } from 'vitest';
import {
  FEATURED_TOOL_NAMES,
  parseFeaturedTools,
  resolveFeaturedToolNames,
} from './featured-tools.js';

describe('parseFeaturedTools', () => {
  it('parses valid values, dedupes and preserves order', () => {
    expect(parseFeaturedTools('["image_generation","text_to_speech","image_generation"]'))
      .toEqual(['image_generation', 'text_to_speech']);
  });

  it('treats null / empty / malformed JSON / unknown values as disabled', () => {
    expect(parseFeaturedTools(null)).toEqual([]);
    expect(parseFeaturedTools('')).toEqual([]);
    expect(parseFeaturedTools('not-json')).toEqual([]);
    expect(parseFeaturedTools('{"a":1}')).toEqual([]);
    expect(parseFeaturedTools('["foo",1,null,"text_to_speech"]')).toEqual(['text_to_speech']);
  });
});

describe('resolveFeaturedToolNames', () => {
  const imageResolver = () => vi.fn(async () => ({ id: 1 }));
  const audioResolver = () => vi.fn(async () => ({ id: 2 }));

  it('returns all gated tools when the lookup port is not injected (legacy assembly)', async () => {
    expect(await resolveFeaturedToolNames(['image_generation'], null)).toEqual(new Set(FEATURED_TOOL_NAMES));
  });

  it('returns an empty set without querying when nothing is configured', async () => {
    const resolveImageModel = imageResolver();
    const resolveAudioModel = audioResolver();
    expect(await resolveFeaturedToolNames([], { resolveImageModel, resolveAudioModel }))
      .toEqual(new Set());
    expect(resolveImageModel).not.toHaveBeenCalled();
    expect(resolveAudioModel).not.toHaveBeenCalled();
  });

  it('keeps both image tools when the image model is available', async () => {
    const allowed = await resolveFeaturedToolNames(['image_generation'], {
      resolveImageModel: imageResolver(),
      resolveAudioModel: audioResolver(),
    });
    expect(allowed).toEqual(new Set(['generate_image', 'edit_image']));
  });

  it('keeps only text_to_speech when the audio model is available', async () => {
    const allowed = await resolveFeaturedToolNames(['text_to_speech'], {
      resolveImageModel: imageResolver(),
      resolveAudioModel: audioResolver(),
    });
    expect(allowed).toEqual(new Set(['text_to_speech']));
  });

  it('passes the loaded agent through to the resolver (绑定模型参与门控)', async () => {
    const resolveImageModel = imageResolver();
    const agent = { imageModelId: 12, audioModelId: null };
    await resolveFeaturedToolNames(['image_generation'], {
      resolveImageModel,
      resolveAudioModel: audioResolver(),
    }, agent);
    expect(resolveImageModel).toHaveBeenCalledWith(agent);
  });

  it('drops a capability whose model is unavailable or whose lookup throws (per-capability fail-closed)', async () => {
    const allowed = await resolveFeaturedToolNames(['image_generation', 'text_to_speech'], {
      resolveImageModel: async () => { throw new Error('db down'); },
      resolveAudioModel: audioResolver(),
    });
    expect(allowed).toEqual(new Set(['text_to_speech']));

    const none = await resolveFeaturedToolNames(['image_generation', 'text_to_speech'], {
      resolveImageModel: async () => null,
      resolveAudioModel: async () => null,
    });
    expect(none).toEqual(new Set());
  });

  it('hides the capability when the bound model is unusable even if a default exists（绑定失效不回退）', async () => {
    // resolver 内部已 fail-closed（绑定失效返回 null）；门控只看解析结果。
    const allowed = await resolveFeaturedToolNames(['image_generation'], {
      resolveImageModel: async (agent) => (agent as { imageModelId?: number | null } | null)?.imageModelId != null
        ? null
        : { id: 1 },
    }, { imageModelId: 99 });
    expect(allowed).toEqual(new Set());
  });
});
