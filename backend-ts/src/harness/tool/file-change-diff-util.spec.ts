import { describe, expect, it, vi } from 'vitest';
import { FileChangeDiffUtil, PRIVATE_DIFF_FIELD, SNAPSHOT_LIMIT_BYTES } from './file-change-diff-util.js';
import { DangerAssessor } from './danger-assessor.js';
import { AskUserQuestionsRegistry } from './ask-user-questions-registry.js';
import type { LlmAdapter } from '../llm/chat-request.js';
import { CloudWorkspaceResolver } from '../safety/cloud-workspace-resolver.js';
import { PathSandbox } from '../safety/path-sandbox.js';
import { BusinessException } from '../../common/business-exception.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('FileChangeDiffUtil', () => {
  it('buildsSnapshotForSmallTextFiles', () => {
    const diff = FileChangeDiffUtil.buildDiff('a.txt', 'old\n', 'new\n');
    expect(diff.diff_mode).toBe('SNAPSHOT');
    expect(diff.before_content).toBe('old\n');
    expect(diff.after_content).toBe('new\n');
  });

  it('degradesBinaryContentToUnsupported', () => {
    const diff = FileChangeDiffUtil.buildDiff('a.bin', 'abc\u0000def', 'xyz');
    expect(diff.diff_mode).toBe('UNSUPPORTED');
    expect(diff.diff_unavailable_reason).toBeTruthy();
  });

  it('storesPatchForLargeTextFiles', () => {
    const largeBefore = 'a\n'.repeat((SNAPSHOT_LIMIT_BYTES / 2) + 1);
    const largeAfter = largeBefore + 'tail\n';
    const diff = FileChangeDiffUtil.buildDiff('large.txt', largeBefore, largeAfter);
    expect(diff.diff_mode).toBe('PATCH');
    expect(String(diff.patch_content)).toContain('--- a/large.txt');
    expect(String(diff.patch_content)).toContain('+++ b/large.txt');
    expect(String(diff.patch_content)).toContain('+tail');
  });

  it('stripsPrivateDiffPayloadFromToolResult', () => {
    const raw = '{"success":true,"file_change":{"path":"a.txt"},"file_change_diff":{"diff_mode":"SNAPSHOT","before_content":"a","after_content":"b"}}';
    const stripped = FileChangeDiffUtil.stripPrivateDiff(raw)!;
    const node = JSON.parse(stripped) as Record<string, unknown>;
    expect(node[PRIVATE_DIFF_FIELD]).toBeUndefined();
    expect((node.file_change as { path: string }).path).toBe('a.txt');
  });

  it('computesLineDeltaForAppendAndReplacement', () => {
    const append = FileChangeDiffUtil.computeLineDelta('a\nb\nc', 'a\nb\nc\nd\ne');
    const replace = FileChangeDiffUtil.computeLineDelta('a\nold\nc', 'a\nnew\nc');
    expect(append.linesAdded).toBe(2);
    expect(append.linesDeleted).toBe(0);
    expect(replace.linesAdded).toBe(1);
    expect(replace.linesDeleted).toBe(1);
  });
});

describe('DangerAssessor', () => {
  const llmAdapter = { chat: vi.fn(), stream: vi.fn() } as unknown as LlmAdapter & { chat: ReturnType<typeof vi.fn> };
  const assessor = new DangerAssessor(llmAdapter);
  const modelConfig = { modelId: 'test' };

  function response(verdict: string) {
    return { choices: [{ message: { content: verdict } }] };
  }

  it('returnsSafeWhenClassifierSaysSafe', async () => {
    llmAdapter.chat.mockResolvedValue(response('SAFE'));
    const result = await assessor.assess('{"command":"ls -la"}', modelConfig);
    expect(result.dangerous).toBe(false);
    expect(result.reason).toBeNull();
  });

  it('returnsDangerousWithReasonWhenClassifierFlagsCommand', async () => {
    llmAdapter.chat.mockResolvedValue(response('DANGEROUS: 删除文件'));
    const result = await assessor.assess('{"command":"rm -rf target"}', modelConfig);
    expect(result.dangerous).toBe(true);
    expect(result.reason).toBe('删除文件');
  });

  it('defaultsToDangerousWhenClassifierFails', async () => {
    llmAdapter.chat.mockRejectedValue(new Error('down'));
    const result = await assessor.assess('not json', modelConfig);
    expect(result.dangerous).toBe(true);
    expect(result.reason).toContain('安全评估服务异常');
  });
});

describe('AskUserQuestionsRegistry', () => {
  const questions = [
    { question: '如何处理?', header: '方案', multiSelect: false },
    { question: '是否需要?', header: '范围', multiSelect: true },
  ];
  const metadata = { source: 'test' };

  it('registerKeepsQuestionContentForPendingLookup', () => {
    const registry = new AskUserQuestionsRegistry();
    const requestId = registry.register(7, questions, metadata);
    const pending = registry.getPendingForSession(7);
    expect(pending).toHaveLength(1);
    expect(pending[0].requestId).toBe(requestId);
    expect(pending[0].questions).toEqual(questions);
    expect(pending[0].metadata).toEqual(metadata);
  });

  it('getPendingForSessionIsEmptyWhenNothingRegistered', () => {
    const registry = new AskUserQuestionsRegistry();
    expect(registry.getPendingForSession(7)).toEqual([]);
    expect(registry.getPendingForSession(null)).toEqual([]);
  });
});

describe('CloudWorkspaceResolver', () => {
  it('normalizeAndValidate_acceptsValidSlug', () => {
    expect(CloudWorkspaceResolver.normalizeAndValidate('my-app')).toBe('my-app');
    expect(CloudWorkspaceResolver.normalizeAndValidate('  agent_workbench  ')).toBe('agent_workbench');
  });

  it('normalizeAndValidate_rejectsInvalidSlug', () => {
    expect(() => CloudWorkspaceResolver.normalizeAndValidate('../etc')).toThrow(BusinessException);
    expect(() => CloudWorkspaceResolver.normalizeAndValidate('a/b')).toThrow(BusinessException);
    expect(() => CloudWorkspaceResolver.normalizeAndValidate('projects')).toThrow(BusinessException);
    expect(() => CloudWorkspaceResolver.normalizeAndValidate('')).toThrow(BusinessException);
    expect(() => CloudWorkspaceResolver.normalizeAndValidate('a'.repeat(65))).toThrow(BusinessException);
  });

  it('resolveProjectWorkspace_staysUnderUserSandbox', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mao-ws-'));
    const sandbox = new PathSandbox(dir);
    const p = CloudWorkspaceResolver.resolveProjectWorkspace(sandbox, 42, 'demo');
    expect(p.replaceAll('\\', '/')).toMatch(/\/42\/projects\/demo$/);
  });

  it('assertUnderUserSandbox_rejectsEscape', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mao-ws-'));
    const sandbox = new PathSandbox(dir);
    expect(() => CloudWorkspaceResolver.assertUnderUserSandbox(sandbox, 1, join(dir, '2'))).toThrow(BusinessException);
  });
});
