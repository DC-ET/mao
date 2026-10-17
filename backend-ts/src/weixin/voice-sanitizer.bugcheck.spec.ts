import { describe, expect, it } from 'vitest';
import { WeixinVoiceTextSanitizer } from '../weixin/voice-text-sanitizer.js';

const sanitizer = new WeixinVoiceTextSanitizer();

describe('微信语音文本清洗：Markdown 强调符 vs 标识符下划线', () => {
  it('对照：成对强调符应被移除', () => {
    expect(sanitizer.toSpeechText('这是 **重要** 内容')).toBe('这是 重要 内容。');
  });

  it('回归：snake_case 标识符中的单下划线不是 Markdown 强调，必须保留', () => {
    // 用户听到的应是「user_id 字段」，而不是被吞掉下划线的「userid 字段」
    expect(sanitizer.toSpeechText('请修改 user_id 字段')).toContain('user_id');
    expect(sanitizer.toSpeechText('检查 session_id 与 cache_creation_tokens')).toContain('session_id 与 cache_creation_tokens');
    expect(sanitizer.toSpeechText('保留 __init__ 方法')).toContain('__init__');
  });

  it('回归：成对下划线强调仍应移除', () => {
    expect(sanitizer.toSpeechText('这是 _斜体_ 内容')).toBe('这是 斜体 内容。');
    expect(sanitizer.toSpeechText('这是 __强调__ 内容')).toBe('这是 强调 内容。');
  });
});
