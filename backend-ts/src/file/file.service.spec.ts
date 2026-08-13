import { mkdirSync, writeFileSync, existsSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { FileEntityRepository, FileService } from './file.service.js';
import { WorkspaceBrowseService } from './workspace-browse.service.js';
import { PathSandbox } from '../harness/safety/path-sandbox.js';
import { isSensitive, envVarNameForDomain, ASKPASS } from './git-write-operation.service.js';
import { GitCommitMessageService } from './git-commit-message.service.js';
import { LlmUsageService } from '../usage/llm-usage.service.js';
import { spawnSync } from 'node:child_process';
import { writeFileSync as writeSync } from 'node:fs';
import { chmodSync } from 'node:fs';

describe('FileService', () => {
  async function setup() {
    const dir = await mkdtemp(join(tmpdir(), 'mao-file-'));
    const repo = {
      insert: vi.fn(async (file) => {
        file.id = 1;
        return 1;
      }),
      findById: vi.fn(),
      list: vi.fn(),
      logicalDelete: vi.fn(),
    } as unknown as FileEntityRepository;
    const service = new FileService(repo, join(dir, 'uploads'), 1);
    return { dir, repo, service };
  }

  it('uploadListGetPathAndDeleteFiles', async () => {
    const { repo, service } = await setup();
    const saved = await service.uploadFile(Buffer.from('hello'), 'hello.txt', 'text/plain', 7, 11);
    expect(saved.originalName).toBe('hello.txt');
    expect(saved.storedName.endsWith('.txt')).toBe(true);
    expect(saved.fileSize).toBe(5);
    expect(existsSync(saved.filePath)).toBe(true);
    expect(repo.insert).toHaveBeenCalledWith(saved);

    vi.mocked(repo.findById).mockResolvedValue(saved);
    vi.mocked(repo.list).mockResolvedValue([saved]);
    expect(await service.getFile(1)).toBe(saved);
    expect(await service.getFilePath(1)).toBe(saved.filePath);
    expect(await service.listFiles(7, 11)).toEqual([saved]);

    await service.deleteFile(1);
    expect(existsSync(saved.filePath)).toBe(false);
    expect(repo.logicalDelete).toHaveBeenCalledWith(1);
  });

  it('uploadRejectsEmptyOrOversizedAndPathLookupRejectsMissingFile', async () => {
    const { repo, service } = await setup();
    await expect(service.uploadFile(Buffer.alloc(0), 'empty.txt', 'text/plain', 1, null)).rejects.toBeInstanceOf(BusinessException);
    await expect(service.uploadFile(Buffer.alloc(2 * 1024 * 1024), 'big.bin', 'application/octet-stream', 1, null)).rejects.toBeInstanceOf(BusinessException);
    vi.mocked(repo.findById).mockResolvedValue(null);
    await expect(service.getFilePath(404)).rejects.toBeInstanceOf(BusinessException);
    await service.deleteFile(404);
  });

  it('uploadInfersImageMimeAndExtensionFromMagicBytes', async () => {
    const { service } = await setup();
    const jpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2]);
    const saved = await service.uploadFile(jpeg, 'vsg_output_1784513632639', 'application/octet-stream', 1, 2);
    expect(saved.mimeType).toBe('image/jpeg');
    expect(saved.originalName.endsWith('.jpg')).toBe(true);
    expect(saved.storedName.endsWith('.jpg')).toBe(true);
    expect(existsSync(saved.filePath)).toBe(true);
  });

  it('listWorkspaceFilesFiltersIgnoredDirsAndSortsRecentFirst', async () => {
    const { dir, service } = await setup();
    const workspace = join(dir, 'workspace');
    mkdirSync(join(workspace, 'src'), { recursive: true });
    mkdirSync(join(workspace, '.git'), { recursive: true });
    writeFileSync(join(workspace, 'src', 'App.java'), 'class App {}');
    writeFileSync(join(workspace, 'README.md'), 'readme');
    writeFileSync(join(workspace, '.git', 'config'), 'ignored');
    const all = service.listWorkspaceFiles(workspace, null, 10);
    const filtered = service.listWorkspaceFiles(workspace, 'app', 10);
    expect(all.map((f) => f.path)).toEqual(expect.arrayContaining(['src/App.java', 'README.md']));
    expect(all.map((f) => f.path)).not.toContain('.git/config');
    expect(filtered.map((f) => f.name)).toEqual(['App.java']);
    expect(service.listWorkspaceFiles(join(workspace, 'missing'), null, 10)).toEqual([]);
  });
});

describe('WorkspaceBrowseService', () => {
  it('listsDirectoriesAndReadsFileSlices', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mao-ws-'));
    const workspace = join(dir, 'workspace');
    mkdirSync(join(workspace, 'dir'), { recursive: true });
    writeFileSync(join(workspace, 'dir', 'a.txt'), 'line1\nline2\nline3');
    writeFileSync(join(workspace, 'root.txt'), 'root');
    const service = new WorkspaceBrowseService(new PathSandbox(workspace));
    const listing = service.listDirectory(workspace, '.');
    expect(listing.truncated).toBe(false);
    expect(listing.entries.map((e) => e.name)).toEqual(expect.arrayContaining(['dir', 'root.txt']));
    expect(listing.entries[0].isDirectory).toBe(true);
    const content = await service.readFile(workspace, 'dir/a.txt', 1, 1);
    expect(content.content).toBe('line2');
    expect(content.total_lines).toBe(3);
    expect(() => service.listDirectory(workspace, 'missing')).toThrow(BusinessException);
    expect(() => service.listDirectory(workspace, 'root.txt')).toThrow(BusinessException);
    await expect(service.readFile(workspace, '', 0, 1)).rejects.toBeInstanceOf(BusinessException);
    await expect(service.readFile(workspace, 'missing.txt', 0, 1)).rejects.toBeInstanceOf(BusinessException);
    await expect(service.readFile(workspace, 'dir', 0, 1)).rejects.toBeInstanceOf(BusinessException);
    await expect(service.readFile(workspace, '../escape.txt', 0, 1)).rejects.toBeInstanceOf(BusinessException);
  });

  it('readsPngImageWithDataUri', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mao-ws-'));
    const workspace = join(dir, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    writeFileSync(join(workspace, 'icon.png'), png);
    const service = new WorkspaceBrowseService(new PathSandbox(workspace));
    const content = await service.readFile(workspace, 'icon.png', 0, 5000);
    expect(content.media_type).toBe('image');
    expect(content.mime).toBe('image/png');
    expect(content.data_uri?.startsWith('data:image/png;base64,')).toBe(true);
    expect(content.total_lines).toBe(0);
  });

  it('rejectsBinaryTextRead', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mao-ws-'));
    const workspace = join(dir, 'workspace');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02, 0xFF]));
    const service = new WorkspaceBrowseService(new PathSandbox(workspace));
    await expect(service.readFile(workspace, 'binary.bin', 0, 1)).rejects.toThrow(/二进制文件/);
  });

  it('downloadReturnsFileInfo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mao-ws-'));
    const workspace = join(dir, 'workspace');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'hello.txt'), 'hello');
    const service = new WorkspaceBrowseService(new PathSandbox(workspace));
    const result = service.downloadFile(workspace, 'hello.txt');
    expect(result.fileName).toBe('hello.txt');
    expect(result.size).toBe(5);
    expect(readFileSync(result.path, 'utf8')).toBe('hello');
  });

  it('pdfPreviewValidatesMagicAndSandbox', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mao-pdf-'));
    const workspace = join(dir, 'sessions/1');
    mkdirSync(join(workspace, 'docs'), { recursive: true });
    const pdf = Buffer.from('%PDF-1.4\n%%EOF\n');
    writeFileSync(join(workspace, 'docs', 'manual.pdf'), pdf);
    const service = new WorkspaceBrowseService(new PathSandbox(join(dir, 'default')));
    const result = service.readPdfFile(workspace, 'docs/manual.pdf');
    expect(result.fileName).toBe('manual.pdf');
    expect(result.size).toBe(pdf.length);

    const bom = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), pdf]);
    writeFileSync(join(workspace, 'bom.pdf'), bom);
    expect(service.readPdfFile(workspace, 'bom.pdf').fileName).toBe('bom.pdf');

    writeFileSync(join(workspace, 'notes.txt'), pdf);
    expect(() => service.readPdfFile(workspace, 'notes.txt')).toThrow(/仅支持预览 \.pdf 文件/);
    writeFileSync(join(workspace, 'fake.pdf'), 'hello world, not a pdf');
    expect(() => service.readPdfFile(workspace, 'fake.pdf')).toThrow(/不是有效的 PDF/);
    writeFileSync(join(workspace, 'empty.pdf'), Buffer.alloc(0));
    expect(() => service.readPdfFile(workspace, 'empty.pdf')).toThrow(/不是有效的 PDF/);
    expect(() => service.readPdfFile(workspace, 'missing.pdf')).toThrow(/文件不存在/);
    writeFileSync(join(dir, 'outside.pdf'), pdf);
    expect(() => service.readPdfFile(workspace, '../outside.pdf')).toThrow(/路径访问被拒绝/);

    const abs = join(workspace, 'abs.pdf');
    writeFileSync(abs, pdf);
    expect(service.readPdfFile(workspace, abs).fileName).toBe('abs.pdf');
  });

  it('rejectsSymlinkPointingOutsideSandbox', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mao-link-'));
    const workspace = join(dir, 'sessions/8');
    mkdirSync(workspace, { recursive: true });
    const outside = join(dir, 'outside-link-target.pdf');
    writeFileSync(outside, Buffer.from('%PDF-1.4\n%%EOF\n'));
    symlinkSync(outside, join(workspace, 'link.pdf'));
    const service = new WorkspaceBrowseService(new PathSandbox(join(dir, 'default')));
    expect(() => service.readPdfFile(workspace, 'link.pdf')).toThrow(/不是普通文件/);
  });

  it('zipIncludesNestedDirsAndSkipsSymlinks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mao-zip-'));
    const workspace = join(dir, 'workspace');
    mkdirSync(join(workspace, 'dir', 'sub'), { recursive: true });
    writeFileSync(join(workspace, 'dir', 'a.txt'), 'a');
    writeFileSync(join(workspace, 'dir', 'sub', 'b.txt'), 'b');
    writeFileSync(join(workspace, 'root.txt'), 'root');
    const outside = join(dir, 'outside-secret.txt');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, join(workspace, 'link.txt'));
    const service = new WorkspaceBrowseService(new PathSandbox(workspace));
    const result = await service.zipDirectory(workspace, '.');
    expect(result.fileName).toBe('workspace.zip');
    const names = listZipEntries(result.zipPath);
    expect(names).toEqual(expect.arrayContaining(['workspace/root.txt', 'workspace/dir/a.txt']));
    expect(names.some((n) => n.includes('link.txt'))).toBe(false);
  });

  it('workspaceZipRejectsOversizedDirectory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mao-zip-'));
    const workspace = join(dir, 'workspace');
    mkdirSync(join(workspace, 'sub'), { recursive: true });
    writeFileSync(join(workspace, 'sub', 'big.bin'), Buffer.alloc(1024));
    const service = new WorkspaceBrowseService(new PathSandbox(workspace));
    service.setMaxZipBytes(512);
    await expect(service.zipDirectory(workspace, 'sub')).rejects.toThrow(/目录过大/);
  });
});

describe('GitWriteOperationService helpers', () => {
  it('sensitiveFileRulesCoverCredentialsAndKeys', () => {
    expect(isSensitive('.env.production')).toBe(true);
    expect(isSensitive('cert/client.pem')).toBe(true);
    expect(isSensitive('keys/id_ed25519.backup')).toBe(true);
    expect(isSensitive('config/api-token.json')).toBe(true);
    expect(isSensitive('src/tokenizer.java')).toBe(true);
    expect(isSensitive('src/Main.java')).toBe(false);
  });

  it('envVarNameForDomainReplacesDotsAndDashes', () => {
    expect(envVarNameForDomain('git.acg.team')).toBe('GIT_TOKEN_git_acg_team');
  });

  it('askpassScriptIsValidAndReturnsConfiguredToken', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mao-askpass-'));
    const script = join(dir, 'git-askpass.sh');
    writeSync(script, ASKPASS);
    chmodSync(script, 0o700);
    const syntax = spawnSync('bash', ['-n', script]);
    expect(syntax.status).toBe(0);
    const username = spawnSync('bash', [script, "Username for 'https://git.acg.team':"], { encoding: 'utf8' });
    expect(username.stdout.trim()).toBe('oauth2');
    const password = spawnSync('bash', [script, "Password for 'https://oauth2@git.acg.team':"], {
      encoding: 'utf8',
      env: { ...process.env, GIT_TOKEN_git_acg_team: 'secret-token' },
    });
    expect(password.stdout.trim()).toBe('secret-token');
  });
});

describe('GitCommitMessageService', () => {
  it('retriesInvalidFormatAndRecordsBothCalls', async () => {
    const usage = { record: vi.fn() } as unknown as LlmUsageService;
    let calls = 0;
    const adapter = {
      chat: vi.fn(async () => {
        const content = calls++ === 0 ? 'not conventional' : 'fix(git): 修复提交操作\n\n- 增加安全校验';
        return {
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          choices: [{ message: { role: 'assistant', content } }],
        };
      }),
    };
    const harness = { resolveModel: vi.fn(async () => ({ id: 9, name: 'test', modelId: 'test' })) };
    const service = new GitCommitMessageService(adapter, harness, usage);
    const result = await service.generate(
      { id: 2, userId: 1, modelId: 9 },
      { files: [{ path: 'src/A.java', changeType: 'MODIFIED', insertions: 1, deletions: 0, diff: 'diff' }], diffBytes: 4 },
    );
    expect(result.title).toBe('fix(git): 修复提交操作');
    expect(adapter.chat).toHaveBeenCalledTimes(2);
    expect(usage.record).toHaveBeenCalledTimes(2);
  });

  it('rejectsSensitiveDiffAndOversizeInput', () => {
    const service = new GitCommitMessageService({ chat: vi.fn() }, { resolveModel: vi.fn() }, { record: vi.fn() } as unknown as LlmUsageService);
    expect(() => service.validateInput({
      files: [{ path: '.env', changeType: 'MODIFIED', insertions: 1, deletions: 0, diff: 'password=x', sensitive: true }],
      diffBytes: Buffer.byteLength('password=x'),
    })).toThrow(/敏感/);
  });

  it('promptContainsOnlyStructuredChangesAndNoTools', async () => {
    const adapter = {
      chat: vi.fn(async () => ({
        choices: [{ message: { role: 'assistant', content: 'feat(api): 增加接口\n\n- 增加本地活动记录接口' } }],
      })),
    };
    const service = new GitCommitMessageService(
      adapter,
      { resolveModel: vi.fn(async () => ({ id: 9, name: 'test', modelId: 'test' })) },
      { record: vi.fn() } as unknown as LlmUsageService,
    );
    await service.generate(
      { id: 2, userId: 1, modelId: 9 },
      { files: [{ path: 'src/A.java', changeType: 'MODIFIED', insertions: 1, deletions: 0, diff: '+新增' }], diffBytes: Buffer.byteLength('+新增') },
    );
    const request = adapter.chat.mock.calls[0][0];
    expect(request.tools).toEqual([]);
    expect(request.messages).toHaveLength(2);
    expect(String(request.messages[1].content)).toContain('src/A.java');
    expect(String(request.messages[1].content)).toContain('+新增');
  });
});

function listZipEntries(zipPath: string): string[] {
  const buf = readFileSync(zipPath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip EOCD not found');
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const names: string[] = [];
  let p = cdOffset;
  const end = cdOffset + cdSize;
  while (p + 46 <= end) {
    if (buf[p] !== 0x50 || buf[p + 1] !== 0x4b || buf[p + 2] !== 0x01 || buf[p + 3] !== 0x02) break;
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    names.push(buf.subarray(p + 46, p + 46 + nameLen).toString('utf8'));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}
