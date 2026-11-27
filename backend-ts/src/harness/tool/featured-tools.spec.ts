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
  const imageLookup = () => vi.fn(async () => ({ id: 1 }));
  const audioLookup = () => vi.fn(async () => ({ id: 2 }));

  it('returns all gated tools when the lookup port is not injected (legacy assembly)', async () => {
    expect(await resolveFeaturedToolNames(['image_generation'], null)).toEqual(new Set(FEATURED_TOOL_NAMES));
  });

  it('returns an empty set without querying when nothing is configured', async () => {
    const findFirstActiveImageModel = imageLookup();
    const findFirstActiveAudioModel = audioLookup();
    expect(await resolveFeaturedToolNames([], { findFirstActiveImageModel, findFirstActiveAudioModel }))
      .toEqual(new Set());
    expect(findFirstActiveImageModel).not.toHaveBeenCalled();
    expect(findFirstActiveAudioModel).not.toHaveBeenCalled();
  });

  it('keeps both image tools when the image model is available', async () => {
    const allowed = await resolveFeaturedToolNames(['image_generation'], {
      findFirstActiveImageModel: imageLookup(),
      findFirstActiveAudioModel: audioLookup(),
    });
    expect(allowed).toEqual(new Set(['generate_image', 'edit_image']));
  });

  it('keeps only text_to_speech when the audio model is available', async () => {
    const allowed = await resolveFeaturedToolNames(['text_to_speech'], {
      findFirstActiveImageModel: imageLookup(),
      findFirstActiveAudioModel: audioLookup(),
    });
    expect(allowed).toEqual(new Set(['text_to_speech']));
  });

  it('drops a capability whose model is unavailable or whose lookup throws (per-capability fail-closed)', async () => {
    const allowed = await resolveFeaturedToolNames(['image_generation', 'text_to_speech'], {
      findFirstActiveImageModel: async () => { throw new Error('db down'); },
      findFirstActiveAudioModel: audioLookup(),
    });
    expect(allowed).toEqual(new Set(['text_to_speech']));

    const none = await resolveFeaturedToolNames(['image_generation', 'text_to_speech'], {
      findFirstActiveImageModel: async () => null,
      findFirstActiveAudioModel: async () => null,
    });
    expect(none).toEqual(new Set());
  });
});