import { describe, expect, it } from 'vitest';
import { BusinessException } from '../../common/business-exception.js';
import { TitleGenerator } from './title-generator.js';
import { SessionGroupKey } from './session-group-key.js';
import { GitUrlParser } from './git-url-parser.js';
import { GitCloneErrorFormatter } from './git-clone-error-formatter.js';
import { ToolResultSummarizer } from './tool-result-summarizer.js';
import { fromString } from '../permission-level.js';
import type { Session } from '../types.js';

describe('TitleGenerator', () => {
  it('generateReturnsNullForBlankMessages', () => {
    expect(TitleGenerator.generate(null)).toBeNull();
    expect(TitleGenerator.generate('   ')).toBeNull();
  });

  it('generateTrimsAndTruncatesLongMessages', () => {
    expect(TitleGenerator.generate('  hello world  ')).toBe('hello world');
    const title = TitleGenerator.generate('a'.repeat(60));
    expect(title).toHaveLength(53);
    expect(title!.endsWith('...')).toBe(true);
  });

  it('preprocessConvertsSoleSkillMarkerToSlashCommand', () => {
    expect(TitleGenerator.preprocessForTitle('  ${java}$  ', new Map())).toBe('/java');
  });

  it('preprocessStripsMixedSkillMarkersAndExpandsCommands', () => {
    const result = TitleGenerator.preprocessForTitle('请 ${review}$ #{fix}# 然后总结', { fix: '修复编译错误' });
    expect(result).toBe('请  修复编译错误 然后总结');
  });

  it('preprocessKeepsUnknownCommandMarker', () => {
    expect(TitleGenerator.preprocessForTitle('执行 #{missing}#', { known: 'value' })).toBe('执行 #{missing}#');
  });
});

describe('PermissionLevel', () => {
  it('fromStringDefaultsInvalidValuesToReadOnly', () => {
    expect(fromString('FULL')).toBe('FULL');
    expect(fromString(null)).toBe('READ_ONLY');
    expect(fromString('bad')).toBe('READ_ONLY');
  });
});

describe('SessionGroupKey', () => {
  it('of_matchesDesktopCloudGroupKey', () => {
    expect(SessionGroupKey.of('LOCAL', null)).toBe('LOCAL:未设置');
    expect(SessionGroupKey.of('LOCAL', '')).toBe('LOCAL:未设置');
    expect(SessionGroupKey.of('LOCAL', '/home/u/proj')).toBe('LOCAL:/home/u/proj');
    expect(SessionGroupKey.of('CLOUD', null)).toBe('CLOUD:临时工作区');
    expect(SessionGroupKey.of('CLOUD', '/opt/mao/data/1/42')).toBe('CLOUD:临时工作区');
    expect(SessionGroupKey.of('CLOUD', '/opt/mao/data/1/projects/demo')).toBe('CLOUD:/opt/mao/data/1/projects/demo');
  });

  it('formatLabel_extractsProjectSlugAndBasename', () => {
    expect(SessionGroupKey.formatLabel('CLOUD:临时工作区')).toBe('临时工作区');
    expect(SessionGroupKey.formatLabel('CLOUD:/opt/mao/data/1/projects/demo')).toBe('demo');
    expect(SessionGroupKey.formatLabel('LOCAL:/home/u/proj')).toBe('proj');
    expect(SessionGroupKey.formatLabel('LOCAL:未设置')).toBe('未设置');
  });

  it('applyFilter_localAndCloud', () => {
    expect(() => SessionGroupKey.applyFilter('LOCAL:/ws')).not.toThrow();
    expect(() => SessionGroupKey.applyFilter('LOCAL:未设置')).not.toThrow();
    expect(() => SessionGroupKey.applyFilter('CLOUD:临时工作区')).not.toThrow();
    expect(() => SessionGroupKey.applyFilter('CLOUD:/opt/mao/data/1/projects/demo')).not.toThrow();
    expect(() => SessionGroupKey.applyFilter('OTHER:x')).toThrow();
    expect(() => SessionGroupKey.applyFilter('')).toThrow();
  });

  it('compareSessions_activeFirst', () => {
    const running: Session = { id: 1, userId: 1, phase: 'RUNNING', isPinned: 0 };
    const idle: Session = { id: 2, userId: 1, phase: 'IDLE', isPinned: 1 };
    expect(SessionGroupKey.compareSessions(running, idle)).toBeLessThan(0);
  });

  it('compareSessions_sameUpdatedAt_newerIdFirst', () => {
    const older: Session = { id: 10, userId: 1, phase: 'IDLE', updatedAt: '2026-07-20T14:11:23' };
    const newer: Session = { id: 90, userId: 1, phase: 'IDLE', updatedAt: '2026-07-20T14:11:23' };
    expect(SessionGroupKey.compareSessions(newer, older)).toBeLessThan(0);
    expect(SessionGroupKey.compareSessions(older, newer)).toBeGreaterThan(0);
  });

  it('compareSessions_archivedIgnoresPhaseAndPin', () => {
    const failedNewest: Session = { id: 1, userId: 1, status: 'ARCHIVED', phase: 'FAILED', isPinned: 0, updatedAt: '2026-08-09T10:00' };
    const pinnedCompleted: Session = { id: 2, userId: 1, status: 'ARCHIVED', phase: 'COMPLETED', isPinned: 1, updatedAt: '2026-08-07T10:00' };
    const runningMid: Session = { id: 3, userId: 1, status: 'ARCHIVED', phase: 'RUNNING', isPinned: 0, updatedAt: '2026-08-08T10:00' };
    const list = [pinnedCompleted, runningMid, failedNewest].sort(SessionGroupKey.compareSessions);
    expect(list.map((s) => s.id)).toEqual([1, 3, 2]);
  });

  it('compareSessions_archivedVsActiveUsesActivePhaseRule', () => {
    const active: Session = { id: 1, userId: 1, status: 'ACTIVE', phase: 'RUNNING', updatedAt: '2026-08-08T10:00' };
    const archived: Session = { id: 2, userId: 1, status: 'ARCHIVED', phase: 'COMPLETED', updatedAt: '2026-08-09T10:00' };
    expect(SessionGroupKey.compareSessions(active, archived)).toBeLessThan(0);
  });
});

describe('GitUrlParser', () => {
  it('validateAcceptsHttpsRepositoryUrls', () => {
    GitUrlParser.validate(' https://github.com/org/repo.git ');
    GitUrlParser.validate('https://git.example.com/group/subgroup/repo');
  });

  it('validateRejectsBlankSshHttpAndUnknownProtocols', () => {
    expect(() => GitUrlParser.validate(null)).toThrow(BusinessException);
    expect(() => GitUrlParser.validate('git@github.com:org/repo.git')).toThrow(BusinessException);
    expect(() => GitUrlParser.validate('http://github.com/org/repo.git')).toThrow(BusinessException);
    expect(() => GitUrlParser.validate('ftp://github.com/org/repo.git')).toThrow(BusinessException);
    expect(() => GitUrlParser.validate('https://github.com')).toThrow(BusinessException);
  });

  it('extractSlugNormalizesRepositoryName', () => {
    expect(GitUrlParser.extractSlug('https://github.com/org/my-repo.git')).toBe('my-repo');
    expect(GitUrlParser.extractSlug('https://github.com/org/agent_workbench')).toBe('agent_workbench');
  });

  it('extractSlugRejectsInvalidWorkspaceNames', () => {
    expect(() => GitUrlParser.extractSlug('https://github.com/org/projects.git')).toThrow(BusinessException);
  });

  it('extractHostReturnsUriHost', () => {
    expect(GitUrlParser.extractHost('https://git.example.com/org/repo.git')).toBe('git.example.com');
  });
});

describe('GitCloneErrorFormatter', () => {
  it('repositoryNotFound', () => {
    const raw = "Git clone failed: Cloning into '/opt/mao/data/workspace/2/projects/sms-unify'... remote: Repository not found. fatal: repository 'https://github.com/DC-ET/sms-unify.git/' not found";
    const message = GitCloneErrorFormatter.toUserMessage(raw);
    expect(message).toContain('仓库不存在或无权访问');
    expect(message).toContain('Git 凭证');
  });

  it('authenticationFailed', () => {
    expect(GitCloneErrorFormatter.toUserMessage("fatal: Authentication failed for 'https://github.com/user/repo.git/'")).toContain('认证失败');
  });

  it('timeout', () => {
    expect(GitCloneErrorFormatter.toUserMessage('Git clone timeout (>120s)')).toBe('克隆仓库超时，请检查网络连接或稍后重试');
  });

  it('branchNotFound', () => {
    expect(GitCloneErrorFormatter.toUserMessage('fatal: Remote branch nonexistent not found in upstream origin')).toContain('分支不存在');
  });
});

describe('ToolResultSummarizer', () => {
  it('summarizesShellResultsByActionAndExitState', () => {
    expect(ToolResultSummarizer.summarize('shell', '{"action":"write_stdin","input":"hello world"}', '{}')).toBe('写入 stdin: hello world');
    expect(ToolResultSummarizer.summarize('shell', '{"command":"mvn test"}', '{"exit_code":1,"output":"boom"}')).toBe('执行 mvn test (exit 1)');
    expect(ToolResultSummarizer.summarize('shell', '{"command":"printf"}', '{"exit_code":0,"output":"a\\nb"}')).toBe('执行 printf (2 行输出)');
    expect(ToolResultSummarizer.summarize('shell', '{"command":"sleep 1"}', '{"async":true}')).toBe('执行 sleep 1 (后台)');
  });

  it('summarizesFileTools', () => {
    expect(ToolResultSummarizer.summarize('read_file', '{"file_path":"src/App.vue"}', '{"total_lines":42}')).toBe('读取 src/App.vue (42 行)');
    expect(ToolResultSummarizer.summarize('write_file', '{"path":"docs/a.md"}', '{"bytes_written":2048}')).toBe('写入 docs/a.md (2KB)');
    expect(ToolResultSummarizer.summarize('edit_file', '{"path":"src/main.java"}', '{"replacements":3,"file_change":{"lines_added":6,"lines_deleted":3}}')).toBe('编辑 src/main.java (+6行 -3行)');
  });

  it('summarizesReadFileWithRange', () => {
    expect(ToolResultSummarizer.summarize('read_file', '{"path":"chat/QuestionPanel.vue","offset":350,"limit":50}', '{"total_lines":615}')).toBe('读取 chat/QuestionPanel.vue (350~400行)');
    expect(ToolResultSummarizer.summarize('read_file', '{"path":"src/App.vue","offset":100}', '{"total_lines":200}')).toBe('读取 src/App.vue (100~200行)');
    expect(ToolResultSummarizer.summarize('read_file', '{"path":"src/App.vue","limit":50}', '{"total_lines":615}')).toBe('读取 src/App.vue (0~50行)');
    expect(ToolResultSummarizer.summarize('read_file', '{"path":"src/App.vue"}', '{"total_lines":42}')).toBe('读取 src/App.vue (42 行)');
  });

  it('summarizesSearchAndTaskTools', () => {
    expect(ToolResultSummarizer.summarize('glob_search', '{}', '{"files":["a","b"],"truncated":true}')).toBe('搜索文件 (2 个文件, 已截断)');
    expect(ToolResultSummarizer.summarize('grep_search', '{}', '{"total_matches":5,"truncated":false}')).toBe('搜索内容 (5 处匹配)');
    expect(ToolResultSummarizer.summarize('task_create', '{}', '{"message":"已创建任务"}')).toBe('已创建任务');
    expect(ToolResultSummarizer.summarize('task_update', '{}', '{"todos":[{},{}]}')).toBe('更新任务 (2 项)');
    expect(ToolResultSummarizer.summarize('task_list', '{}', '{"progress":"1/3"}')).toBe('任务列表: 1/3');
    expect(ToolResultSummarizer.summarize('task_delete', '{}', '{"message":"已删除"}')).toBe('已删除');
  });

  it('summarizesScheduledTaskTools', () => {
    expect(ToolResultSummarizer.summarize('create_scheduled_task', '{"name":"新股申购检查"}', '{"message":"定时任务 \'新股申购检查\' 已创建，下次执行时间: 2026-07-28T09:00:00"}')).toBe("定时任务 '新股申购检查' 已创建，下次执行时间: 2026-07-28T09:00:00");
    expect(ToolResultSummarizer.summarize('update_scheduled_task', '{}', '{"name":"新股申购检查","status":"PAUSED","message":"定时任务已更新"}')).toBe('定时任务已更新');
    expect(ToolResultSummarizer.summarize('delete_scheduled_task', '{}', '{"message":"定时任务 \'新股申购检查\' 已删除"}')).toBe("定时任务 '新股申购检查' 已删除");
    expect(ToolResultSummarizer.summarize('list_scheduled_tasks', '{}', '{"tasks":[{},{}],"total":2,"message":"共 2 个定时任务"}')).toBe('共 2 个定时任务');
  });

  it('summarizesQuestionAndWebTools', () => {
    expect(ToolResultSummarizer.summarize('ask_user_questions', '{}', '{"answers":[{},{}]}')).toBe('向用户提问 (2 个问题已回答)');
    expect(ToolResultSummarizer.summarize('ask_user_questions', '{}', '{"error":"timeout"}')).toBe('向用户提问 (超时或取消)');
    expect(ToolResultSummarizer.summarize('web_search', '{"query":"OpenAI Codex testing"}', '{"total_results":8}')).toBe('搜索 OpenAI Codex testing (8 条结果)');
    expect(ToolResultSummarizer.summarize('open_web_page', '{"url":"https://example.com/a/b"}', '{"title":"Example","truncated":true}')).toBe('打开网页 Example (内容已截断)');
  });

  it('summarizesWechatMediaTools', () => {
    expect(ToolResultSummarizer.summarize('send_wechat_image', '{"image":"/tmp/sunset.png"}', '{"success":true,"media_type":"image","sent_to":"wx-1"}')).toBe('发送微信图片: tmp/sunset.png (成功)');
    expect(ToolResultSummarizer.summarize('send_wechat_image', '{"image":"https://a.com/pic.jpg"}', '{"error":"图片上传微信 CDN 失败"}')).toBe('发送微信图片 (失败)');
    expect(ToolResultSummarizer.summarize('send_wechat_file', '{"file":"/tmp/report.pdf"}', '{"success":true,"file_name":"report.pdf","sent_to":"wx-1"}')).toBe('发送微信文件: report.pdf (成功)');
    expect(ToolResultSummarizer.summarize('send_wechat_file', '{"file":"/tmp/report.pdf","file_name":"季度报告.pdf"}', '{"success":true,"file_name":"季度报告.pdf"}')).toBe('发送微信文件: 季度报告.pdf (成功)');
    expect(ToolResultSummarizer.summarize('send_wechat_file', '{"file":"/tmp/report.pdf"}', '{"error":"文件发送失败"}')).toBe('发送微信文件 (失败)');
  });

  it('summarizesGenericToolsAndInvalidJsonGracefully', () => {
    expect(ToolResultSummarizer.summarize(null, '{}', '{}')).toBeNull();
    expect(ToolResultSummarizer.summarize('custom', '{}', '{"success":true}')).toBe('custom (成功)');
    expect(ToolResultSummarizer.summarize('custom', '{}', '{"error":"bad"}')).toBe('custom (错误)');
    expect(ToolResultSummarizer.summarize('custom', '{}', 'not json')).toBe('custom');
  });
});
