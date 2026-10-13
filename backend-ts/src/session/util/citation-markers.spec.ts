import { describe, expect, it } from 'vitest';
import {
  channelAssistantReply,
  extractCitationMarkers,
  stripCitationDefinitions,
  stripCitationMarkers,
} from './citation-markers.js';

describe('citation markers', () => {
  describe('stripCitationMarkers', () => {
    it('剥掉全部标记，其余文本原样保留', () => {
      expect(stripCitationMarkers('截止时间是 11 月 30 日[^1^]，详见通知[^2^]。')).toBe('截止时间是 11 月 30 日，详见通知。');
    });

    it('无标记时原样返回', () => {
      expect(stripCitationMarkers('没有任何引用的普通回复')).toBe('没有任何引用的普通回复');
    });

    it('空串与空值安全', () => {
      expect(stripCitationMarkers('')).toBe('');
    });

    it('不匹配标准 markdown 脚注语法 [^1]', () => {
      expect(stripCitationMarkers('脚注写法[^1]不受影响')).toBe('脚注写法[^1]不受影响');
    });

    it('不匹配非数字标记 [^a^]', () => {
      expect(stripCitationMarkers('非法标记[^a^]保留')).toBe('非法标记[^a^]保留');
    });

    it('代码块内的标记同样剥掉（渠道侧行文按纯文本处理，可接受）', () => {
      expect(stripCitationMarkers('示例 `[^1^]` 写法')).toBe('示例 `` 写法');
    });

    it('连续多次调用结果一致（模块级正则无 lastindex 残留）', () => {
      const text = '第一处[^1^]第二处[^2^]';
      expect(stripCitationMarkers(text)).toBe('第一处第二处');
      expect(stripCitationMarkers(text)).toBe('第一处第二处');
    });
  });

  describe('stripCitationDefinitions（模型混用脚注语法写的定义行）', () => {
    it('整行删掉 `[^n^]: 链接` 定义行，不剩 `: 链接` 残行', () => {
      const text = '结论如上[^1^]\n\n[^1^]: https://a.example.com\n[^2^]: https://b.example.com "标题"';
      expect(stripCitationDefinitions(text)).toBe('结论如上[^1^]\n\n');
    });

    it('标记本身保留（定义行剥离与标记转上标是两层，互不替代）', () => {
      expect(stripCitationDefinitions('结论[^1^]\n[^1^]: https://a.example.com')).toBe('结论[^1^]\n');
    });

    it('冒号后无内容的裸定义行不匹配（避免误伤以标记开头的罕见行文）', () => {
      expect(stripCitationDefinitions('[^1^]:')).toBe('[^1^]:');
    });

    it('句内写法不受影响：标记不在行首就还不是定义行', () => {
      expect(stripCitationDefinitions('说明[^1^]: 这是结论')).toBe('说明[^1^]: 这是结论');
      expect(stripCitationDefinitions('说明[^1^]：这是结论')).toBe('说明[^1^]：这是结论');
    });

    it('标准脚注 [^1]: 链接 不是本标记语法的定义行，不匹配', () => {
      expect(stripCitationDefinitions('[^1]: https://a.example.com')).toBe('[^1]: https://a.example.com');
    });

    it('行首允许空白缩进；无空串与空值安全', () => {
      expect(stripCitationDefinitions('  [^1^]: https://a.example.com')).toBe('');
      expect(stripCitationDefinitions('')).toBe('');
    });

    it('stripCitationMarkers 组合出口：标记与定义行一并清掉', () => {
      const text = '结论如上[^1^]\n\n[^1^]: https://a.example.com\n[^2^]: https://b.example.com';
      expect(stripCitationMarkers(text)).toBe('结论如上\n\n');
    });

    it('渠道出口不再出现 `: https://…` 残行（飞书卡片反馈的显示问题）', () => {
      const messages = [
        { role: 'ASSISTANT', content: '约束如上[^1^][^2^]\n\n[^1^]: https://a.example.com\n[^2^]: https://b.example.com' },
      ];
      expect(channelAssistantReply(messages, '')).toBe('约束如上\n\n');
    });
  });

  describe('extractCitationMarkers', () => {
    it('按出现顺序提取，含越界值', () => {
      expect(extractCitationMarkers('甲[^1^]乙[^3^]丙[^2^]')).toEqual([1, 3, 2]);
    });

    it('重复引用如实返回（去重由调用方负责）', () => {
      expect(extractCitationMarkers('甲[^1^]乙[^1^]')).toEqual([1, 1]);
    });

    it('非数字不进结果；n=0 过滤；越界值如实返回（过滤由调用方按 registry 长度负责）', () => {
      expect(extractCitationMarkers('甲[^a^]丙[^0^]')).toEqual([]);
      expect(extractCitationMarkers('甲[^9^]')).toEqual([9]);
    });

    it('无标记与空串返回空数组', () => {
      expect(extractCitationMarkers('普通文本')).toEqual([]);
      expect(extractCitationMarkers('')).toEqual([]);
    });

    it('连续多次调用结果一致', () => {
      const text = '甲[^1^]乙[^2^]';
      expect(extractCitationMarkers(text)).toEqual([1, 2]);
      expect(extractCitationMarkers(text)).toEqual([1, 2]);
    });
  });
  describe('channelAssistantReply（飞书 / 钉钉 / 微信渠道最终回复出口）', () => {
    const fallback = '抱歉，暂时无法生成回复。';

    it('取最后一条 ASSISTANT 正文并剥掉 [^n^] 标记', () => {
      const messages = [
        { role: 'USER', content: '截止时间是几号' },
        { role: 'ASSISTANT', content: '让我查一下' },
        { role: 'TOOL', content: '{"results":[]}' },
        { role: 'ASSISTANT', content: '截止时间是 11 月 30 日[^1^]，详见通知[^2^]。' },
      ];
      expect(channelAssistantReply(messages, fallback)).toBe('截止时间是 11 月 30 日，详见通知。');
    });

    it('无标记的回复原样返回', () => {
      expect(channelAssistantReply([{ role: 'ASSISTANT', content: '没有引用的回复' }], fallback)).toBe('没有引用的回复');
    });

    it('content 为 null 时按空串处理（剥标记后返回空串）', () => {
      expect(channelAssistantReply([{ role: 'ASSISTANT', content: null }], fallback)).toBe('');
    });

    it('没有 ASSISTANT 消息时走兜底文案', () => {
      expect(channelAssistantReply([{ role: 'USER', content: 'hi' }], fallback)).toBe(fallback);
    });

    it('消息列表为 null / undefined 时走兜底文案', () => {
      expect(channelAssistantReply(null, fallback)).toBe(fallback);
      expect(channelAssistantReply(undefined, fallback)).toBe(fallback);
    });

    it('更晚的 TOOL / USER 消息不抢走出镜：只认 ASSISTANT', () => {
      const messages = [
        { role: 'ASSISTANT', content: '结论[^1^]' },
        { role: 'TOOL', content: 'x' },
        { role: 'USER', content: '追问' },
      ];
      expect(channelAssistantReply(messages, fallback)).toBe('结论');
    });
  });
});
