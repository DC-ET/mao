import { describe, expect, it } from 'vitest';
import {
  formatChannelRelativeTime,
  parseChannelCommand,
  renderChannelSessionList,
  truncateChannelTitle,
} from './channel-command.js';

describe('parseChannelCommand', () => {
  it('命中五个命令（trim 后全等）', () => {
    expect(parseChannelCommand('/new')).toEqual({ kind: 'NEW' });
    expect(parseChannelCommand('/stop')).toEqual({ kind: 'STOP' });
    expect(parseChannelCommand('/tasks')).toEqual({ kind: 'TASKS' });
    expect(parseChannelCommand('/help')).toEqual({ kind: 'HELP' });
    expect(parseChannelCommand('  /stop  ')).toEqual({ kind: 'STOP' });
    // 全角空格：trim 后等值即命中
    expect(parseChannelCommand('　/stop　')).toEqual({ kind: 'STOP' });
  });

  it('命中 /tasks <n>（命令与序号间空白不限个数）', () => {
    expect(parseChannelCommand('/tasks 2')).toEqual({ kind: 'TASKS_SELECT', index: 2 });
    expect(parseChannelCommand('/tasks  2')).toEqual({ kind: 'TASKS_SELECT', index: 2 });
    expect(parseChannelCommand('/tasks\t2')).toEqual({ kind: 'TASKS_SELECT', index: 2 });
    expect(parseChannelCommand('/tasks　2')).toEqual({ kind: 'TASKS_SELECT', index: 2 });
  });

  it('NONE 兜底：普通消息、带其他文字、空输入', () => {
    expect(parseChannelCommand('帮我查天气')).toEqual({ kind: 'NONE' });
    expect(parseChannelCommand('/tasks 帮我查天气')).toEqual({ kind: 'NONE' });
    expect(parseChannelCommand('/stop 现在立刻')).toEqual({ kind: 'NONE' });
    expect(parseChannelCommand('/new 帮我')).toEqual({ kind: 'NONE' });
    expect(parseChannelCommand('')).toEqual({ kind: 'NONE' });
    expect(parseChannelCommand(null)).toEqual({ kind: 'NONE' });
    expect(parseChannelCommand(undefined)).toEqual({ kind: 'NONE' });
  });

  it('序号越界形态不命中（0 / 10 / 非数字）', () => {
    expect(parseChannelCommand('/tasks 0')).toEqual({ kind: 'NONE' });
    expect(parseChannelCommand('/tasks 10')).toEqual({ kind: 'NONE' });
    expect(parseChannelCommand('/tasks abc')).toEqual({ kind: 'NONE' });
    expect(parseChannelCommand('/tasks 2 3')).toEqual({ kind: 'NONE' });
  });

  it('大小写敏感（与群 /new 口径一致）', () => {
    expect(parseChannelCommand('/TASKS')).toEqual({ kind: 'NONE' });
    expect(parseChannelCommand('/Stop')).toEqual({ kind: 'NONE' });
    expect(parseChannelCommand('/NEW')).toEqual({ kind: 'NONE' });
  });

  it('`---` 与 `/new` 是不同指令，互不侵占', () => {
    // `---` 由各渠道既有 isNewSessionCommand 识别，本解析器不识别
    expect(parseChannelCommand('---')).toEqual({ kind: 'NONE' });
  });
});

describe('truncateChannelTitle（码点截断）', () => {
  it('按码点截断，不切半个 emoji', () => {
    expect(truncateChannelTitle('一二三四五', 3)).toBe('一二三');
    // 👍 是双码点 emoji：按 UTF-16 slice 会切出孤立代理项，码点截断必须完整保留或整体丢弃
    const emoji = '👍👍👍👍👍';
    expect(Array.from(truncateChannelTitle(emoji, 3))).toHaveLength(3);
    expect(truncateChannelTitle('短标题', 20)).toBe('短标题');
  });
});

describe('formatChannelRelativeTime', () => {
  const now = new Date('2026-11-22T12:00:00+08:00');
  it('分级：刚刚 / 分钟 / 小时 / 天 / 日期', () => {
    expect(formatChannelRelativeTime('2026-11-22 11:59:40', now)).toBe('刚刚');
    expect(formatChannelRelativeTime('2026-11-22 11:30:00', now)).toBe('30 分钟前');
    expect(formatChannelRelativeTime('2026-11-22 06:00:00', now)).toBe('6 小时前');
    expect(formatChannelRelativeTime('2026-11-20 12:00:00', now)).toBe('2 天前');
    expect(formatChannelRelativeTime('2026-11-01 12:00:00', now)).toBe('2026-11-01');
  });
  it('空值与非法值兜底；未来时间（时钟偏差）不产生负数', () => {
    expect(formatChannelRelativeTime(null, now)).toBe('时间未知');
    expect(formatChannelRelativeTime('', now)).toBe('时间未知');
    expect(formatChannelRelativeTime('not-a-date', now)).toBe('时间未知');
    expect(formatChannelRelativeTime('2026-11-22 12:00:10', now)).toBe('刚刚');
  });
});

describe('renderChannelSessionList', () => {
  const isActive = (phase: string | null | undefined) => phase === 'RUNNING';
  it('多行渲染 + 进行中徽标 + 尾行切换提示；空标题兜底', () => {
    const text = renderChannelSessionList(
      [
        { title: '查天气', phase: 'RUNNING', updatedAt: '2026-11-22 11:30:00' },
        { title: null, phase: 'IDLE', updatedAt: '2026-11-22 10:00:00' },
      ],
      isActive,
      new Date('2026-11-22T12:00:00+08:00'),
    );
    expect(text).toContain('1. 查天气（进行中） · 30 分钟前');
    expect(text).toContain('2. 未命名会话 · 2 小时前');
    expect(text.endsWith('回复 /tasks <序号> 切换，如 /tasks 2')).toBe(true);
  });
  it('空列表只有切换提示行（空列表场景由调用方用专门文案）', () => {
    const text = renderChannelSessionList([], isActive, new Date('2026-11-22T12:00:00+08:00'));
    expect(text).toBe('回复 /tasks <序号> 切换，如 /tasks 2');
  });
});
