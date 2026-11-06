import { describe, expect, it } from 'vitest';
import { ToolResultSummarizer } from './tool-result-summarizer.js';

/**
 * 工具失败摘要统一（0.0.468）：15 个函数的失败摘要接上 error 原因。
 * A 类（补 error 检查）：shell（exec/write_stdin 两段）、web_search、open_web_page、定时任务 4 个；
 * B 类（裸 (失败) → (失败: 原因)）：图片×2、微信×2、钉钉、飞书、MCP×2。
 * 成功路径输出逐字节不变，失败兜底保留裸 (失败)（success===false 且无 error 键的形态）。
 */
describe('tool-result-summarizer failure suffix (A 类: 补 error 检查)', () => {
  it('shell exec 失败显示原因，且不再回落 (exit -1)', () => {
    const out = ToolResultSummarizer.summarize(
      'shell',
      JSON.stringify({ command: 'npm test' }),
      JSON.stringify({ error: '命令被拒绝执行策略' }),
    );
    expect(out).toBe('执行 npm test (失败: 命令被拒绝执行策略)');
    expect(out).not.toContain('(exit -1)');
    expect(out).not.toContain('(0 条结果)');
  });

  it('shell exec 特例: error 无 exit_code 时 error 优先, completed=false 与 exit_code≠0 维持不变', () => {
    // {error} 失败（无 exit_code/async/completed 键）→ 失败原因，绝不显示 (exit -1)
    expect(ToolResultSummarizer.summarize('shell', JSON.stringify({ command: 'ls' }), JSON.stringify({ error: 'boom' })))
      .toBe('执行 ls (失败: boom)');
    // 超时未完成维持既有口径
    expect(ToolResultSummarizer.summarize('shell', JSON.stringify({ command: 'ls' }), JSON.stringify({ completed: false })))
      .toBe('执行 ls (未完成/超时)');
    // 非零退出码维持既有口径
    expect(ToolResultSummarizer.summarize('shell', JSON.stringify({ command: 'ls' }), JSON.stringify({ exit_code: 2, output: '' })))
      .toBe('执行 ls (exit 2)');
  });

  it('shell write_stdin 失败显示原因（此前无任何失败标识）', () => {
    expect(ToolResultSummarizer.summarize(
      'shell',
      JSON.stringify({ action: 'write_stdin', input: 'y' }),
      JSON.stringify({ error: '会话不存在' }),
    )).toBe('写入 stdin: y (失败: 会话不存在)');
    // 超时口径不受影响
    expect(ToolResultSummarizer.summarize(
      'shell',
      JSON.stringify({ action: 'write_stdin', input: 'y' }),
      JSON.stringify({ completed: false }),
    )).toBe('写入 stdin: y (未完成/超时)');
    expect(ToolResultSummarizer.summarize(
      'shell',
      JSON.stringify({ action: 'write_stdin', input: 'y' }),
      JSON.stringify({ completed: true }),
    )).toBe('写入 stdin: y');
  });

  it('web_search 失败显示原因，不再误报 (0 条结果)', () => {
    const out = ToolResultSummarizer.summarize('web_search', JSON.stringify({ query: '今天天气' }), JSON.stringify({ error: '无可用搜索凭据' }));
    expect(out).toBe('搜索 今天天气 (失败: 无可用搜索凭据)');
    expect(out).not.toContain('(0 条结果)');
  });

  it('open_web_page 失败带 url 与原因（此前只剩光秃秃「打开网页」）', () => {
    expect(ToolResultSummarizer.summarize('open_web_page', JSON.stringify({ url: 'https://example.com/xx' }), JSON.stringify({ error: '页面加载超时' })))
      .toBe('打开网页 example.com/xx (失败: 页面加载超时)');
  });

  it('create_scheduled_task 失败带 name 与原因', () => {
    expect(ToolResultSummarizer.summarize(
      'create_scheduled_task',
      JSON.stringify({ name: '日报生成', cron: 'bad' }),
      JSON.stringify({ error: 'cron 表达式无法解析' }),
    )).toBe('创建定时任务 日报生成 (失败: cron 表达式无法解析)');
  });

  it('update_scheduled_task 失败显示原因', () => {
    expect(ToolResultSummarizer.summarize('update_scheduled_task', null, JSON.stringify({ error: '任务不存在' })))
      .toBe('更新定时任务 (失败: 任务不存在)');
  });

  it('delete_scheduled_task 失败显示原因', () => {
    expect(ToolResultSummarizer.summarize('delete_scheduled_task', null, JSON.stringify({ error: '任务不存在' })))
      .toBe('删除定时任务 (失败: 任务不存在)');
  });

  it('list_scheduled_tasks 失败显示原因', () => {
    expect(ToolResultSummarizer.summarize('list_scheduled_tasks', null, JSON.stringify({ error: '无法获取当前用户信息' })))
      .toBe('查询定时任务 (失败: 无法获取当前用户信息)');
  });
});

describe('tool-result-summarizer failure suffix (B 类: 裸 (失败) → 带原因)', () => {
  it('generate_image 失败带 prompt 与原因（此前是丢 prompt 的裸 (失败)）', () => {
    expect(ToolResultSummarizer.summarize('generate_image', JSON.stringify({ prompt: '一只猫' }), JSON.stringify({ error: '模型未配置' })))
      .toBe('生成图片: 一只猫 (失败: 模型未配置)');
  });

  it('edit_image 失败带 prompt 与原因', () => {
    expect(ToolResultSummarizer.summarize('edit_image', JSON.stringify({ prompt: '改成蓝色' }), JSON.stringify({ error: '图片加载失败' })))
      .toBe('编辑图片: 改成蓝色 (失败: 图片加载失败)');
  });

  it('send_wechat_image 失败带文件名与原因', () => {
    expect(ToolResultSummarizer.summarize('send_wechat_image', JSON.stringify({ image: 'images/photo.png' }), JSON.stringify({ error: '客户端未连接' })))
      .toBe('发送微信图片: images/photo.png (失败: 客户端未连接)');
  });

  it('send_wechat_file 失败带文件名与原因；success=false 无 error 维持既有无标识口径', () => {
    expect(ToolResultSummarizer.summarize('send_wechat_file', JSON.stringify({ file_name: '报告.pdf' }), JSON.stringify({ error: '文件不存在' })))
      .toBe('发送微信文件: 报告.pdf (失败: 文件不存在)');
    // 既有行为：该函数从不读 success 键，success=false 且无 error 时与改造前一致（仅文件名）
    expect(ToolResultSummarizer.summarize('send_wechat_file', JSON.stringify({ file_name: '报告.pdf' }), JSON.stringify({ success: false })))
      .toBe('发送微信文件: 报告.pdf');
  });

  it('dingtalk_send_image / dingtalk_send_file 失败带原因；success=false 无 error 兜底裸 (失败)', () => {
    expect(ToolResultSummarizer.summarize('dingtalk_send_image', JSON.stringify({ image: 'images/photo.png' }), JSON.stringify({ error: 'token 失效' })))
      .toBe('发送钉钉图片 (失败: token 失效)');
    expect(ToolResultSummarizer.summarize('dingtalk_send_file', JSON.stringify({ file: '/tmp/a.pdf' }), JSON.stringify({ error: 'token 失效' })))
      .toBe('发送钉钉文件 (失败: token 失效)');
    expect(ToolResultSummarizer.summarize('dingtalk_send_image', JSON.stringify({ image: 'images/photo.png' }), JSON.stringify({ success: false })))
      .toBe('发送钉钉图片 (失败)');
  });

  it('feishu 三工具失败带原因；success=false 无 error 兜底裸 (失败)', () => {
    for (const toolName of ['feishu_download_file', 'feishu_send_image', 'feishu_send_file'] as const) {
      const labels: Record<string, string> = {
        feishu_download_file: '下载飞书文件',
        feishu_send_image: '发送飞书图片',
        feishu_send_file: '发送飞书文件',
      };
      expect(ToolResultSummarizer.summarize(toolName, '{}', JSON.stringify({ error: 'token 失效' })))
        .toBe(`${labels[toolName]} (失败: token 失效)`);
      expect(ToolResultSummarizer.summarize(toolName, '{}', JSON.stringify({ success: false })))
        .toBe(`${labels[toolName]} (失败)`);
    }
  });

  it('mcp_call / mcp_describe 失败带原因', () => {
    const args = JSON.stringify({ server: 'github', tool: 'search' });
    expect(ToolResultSummarizer.summarize('mcp_call', args, JSON.stringify({ error: 'MCP server 未连接' })))
      .toBe('调用 MCP 工具 github.search (失败: MCP server 未连接)');
    expect(ToolResultSummarizer.summarize('mcp_describe', args, JSON.stringify({ error: '工具不存在' })))
      .toBe('查询 MCP 工具 github.search (失败: 工具不存在)');
  });
});

describe('tool-result-summarizer failure reason truncation', () => {
  it('error 超过 40 字符截断并补省略号', () => {
    const longError = 'x'.repeat(50);
    expect(ToolResultSummarizer.summarize('web_search', JSON.stringify({ query: 'q' }), JSON.stringify({ error: longError })))
      .toBe(`搜索 q (失败: ${'x'.repeat(40)}...)`);
  });
});

/**
 * 成功路径逐字节不变：15 个函数在无 error 的结果上输出与改造前完全一致。
 */
describe('tool-result-summarizer success paths unchanged', () => {
  it('shell: 行数/后台/无结果', () => {
    const args = JSON.stringify({ command: 'npm test' });
    expect(ToolResultSummarizer.summarize('shell', args, JSON.stringify({ exit_code: 0, output: 'a\nb\n' }))).toBe('执行 npm test (2 行输出)');
    expect(ToolResultSummarizer.summarize('shell', args, JSON.stringify({ exit_code: 0, output: 'hello\n' }))).toBe('执行 npm test');
    expect(ToolResultSummarizer.summarize('shell', args, JSON.stringify({ async: true }))).toBe('执行 npm test (后台)');
    expect(ToolResultSummarizer.summarize('shell', args, null)).toBe('执行 npm test');
  });

  it('web_search: 结果数与流式期回落', () => {
    const args = JSON.stringify({ query: '今天天气' });
    expect(ToolResultSummarizer.summarize('web_search', args, JSON.stringify({ total_results: 5 }))).toBe('搜索 今天天气 (5 条结果)');
    expect(ToolResultSummarizer.summarize('web_search', args, null)).toBe('搜索 今天天气');
  });

  it('open_web_page: 标题/截断/流式期回落', () => {
    const args = JSON.stringify({ url: 'https://example.com/xx' });
    expect(ToolResultSummarizer.summarize('open_web_page', args, JSON.stringify({ title: 'Example Domain' }))).toBe('打开网页 Example Domain');
    expect(ToolResultSummarizer.summarize('open_web_page', args, JSON.stringify({ title: 'Example', truncated: true }))).toBe('打开网页 Example (内容已截断)');
    expect(ToolResultSummarizer.summarize('open_web_page', args, JSON.stringify({ content: '正文' }))).toBe('打开网页');
    expect(ToolResultSummarizer.summarize('open_web_page', args, null)).toBe('打开网页 example.com/xx');
  });

  it('定时任务四兄弟: message 直通/name/status/total 既有口径', () => {
    const createArgs = JSON.stringify({ name: '日报生成' });
    expect(ToolResultSummarizer.summarize('create_scheduled_task', createArgs, JSON.stringify({ message: '已创建定时任务 日报生成' }))).toBe('已创建定时任务 日报生成');
    expect(ToolResultSummarizer.summarize('create_scheduled_task', createArgs, JSON.stringify({ name: '日报' }))).toBe('创建定时任务 日报');
    expect(ToolResultSummarizer.summarize('create_scheduled_task', createArgs, null)).toBe('创建定时任务 日报生成');
    expect(ToolResultSummarizer.summarize('update_scheduled_task', null, JSON.stringify({ name: '日报', status: 'ACTIVE' }))).toBe('更新定时任务 日报 (启用)');
    expect(ToolResultSummarizer.summarize('update_scheduled_task', null, JSON.stringify({ message: '已暂停' }))).toBe('已暂停');
    expect(ToolResultSummarizer.summarize('update_scheduled_task', null, null)).toBe('更新定时任务');
    expect(ToolResultSummarizer.summarize('delete_scheduled_task', null, JSON.stringify({ message: '已删除' }))).toBe('已删除');
    expect(ToolResultSummarizer.summarize('delete_scheduled_task', null, null)).toBe('删除定时任务');
    expect(ToolResultSummarizer.summarize('list_scheduled_tasks', null, JSON.stringify({ total: 3 }))).toBe('定时任务列表 (3 个)');
    expect(ToolResultSummarizer.summarize('list_scheduled_tasks', null, JSON.stringify({ tasks: [{}, {}] }))).toBe('定时任务列表 (2 个)');
    expect(ToolResultSummarizer.summarize('list_scheduled_tasks', null, null)).toBe('查询定时任务');
  });

  it('图片两工具: N 张/空 images/无 prompt', () => {
    const args = JSON.stringify({ prompt: '一只猫' });
    expect(ToolResultSummarizer.summarize('generate_image', args, JSON.stringify({ images: [{}, {}] }))).toBe('生成图片: 一只猫 (2 张)');
    expect(ToolResultSummarizer.summarize('generate_image', args, JSON.stringify({ images: [] }))).toBe('生成图片: 一只猫');
    expect(ToolResultSummarizer.summarize('generate_image', args, null)).toBe('生成图片: 一只猫');
    expect(ToolResultSummarizer.summarize('generate_image', null, JSON.stringify({ images: [{}] }))).toBe('生成图片 (1 张)');
    expect(ToolResultSummarizer.summarize('edit_image', args, JSON.stringify({ images: [{}, {}] }))).toBe('编辑图片: 一只猫 (2 张)');
  });

  it('微信两工具: 成功口径', () => {
    expect(ToolResultSummarizer.summarize('send_wechat_image', JSON.stringify({ image: 'images/photo.png' }), JSON.stringify({ success: true })))
      .toBe('发送微信图片: images/photo.png (成功)');
    expect(ToolResultSummarizer.summarize('send_wechat_file', JSON.stringify({ file_name: '报告.pdf' }), JSON.stringify({ success: true, file_name: '发送后名字.pdf' })))
      .toBe('发送微信文件: 发送后名字.pdf (成功)');
    expect(ToolResultSummarizer.summarize('send_wechat_file', JSON.stringify({ file_name: '报告.pdf' }), JSON.stringify({ success: true })))
      .toBe('发送微信文件: 报告.pdf (成功)');
  });

  it('钉钉/飞书: 成功带文件名口径', () => {
    expect(ToolResultSummarizer.summarize('dingtalk_send_image', JSON.stringify({ image: 'images/photo.png' }), JSON.stringify({ success: true })))
      .toBe('发送钉钉图片: images/photo.png (成功)');
    expect(ToolResultSummarizer.summarize('feishu_download_file', null, JSON.stringify({ success: true, path: '/tmp/a.pdf' })))
      .toBe('下载飞书文件: tmp/a.pdf (成功)');
    expect(ToolResultSummarizer.summarize('feishu_send_image', JSON.stringify({ image: 'https://example.com/a.png' }), JSON.stringify({ success: true })))
      .toBe('发送飞书图片: example.com/a.png (成功)');
  });

  it('MCP 两工具: 目标直通与流式期回落', () => {
    const args = JSON.stringify({ server: 'github', tool: 'search' });
    expect(ToolResultSummarizer.summarize('mcp_call', args, JSON.stringify({ ok: true }))).toBe('调用 MCP 工具 github.search');
    expect(ToolResultSummarizer.summarize('mcp_call', null, JSON.stringify({}))).toBe('调用 MCP 工具');
    expect(ToolResultSummarizer.summarize('mcp_describe', args, JSON.stringify({ ok: true }))).toBe('查询 MCP 工具 github.search');
    expect(ToolResultSummarizer.summarize('mcp_describe', null, JSON.stringify({}))).toBe('查询 MCP 工具');
  });
});
