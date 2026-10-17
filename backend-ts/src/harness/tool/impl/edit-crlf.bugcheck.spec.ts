import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTmpDir } from '../../../testing/tmp-dir.js';
import { PathSandbox } from '../../safety/path-sandbox.js';
import { ReadFileTool } from './read-file-tool.js';
import { EditFileTool } from './edit-file-tool.js';

describe('read_file → edit_file 行尾契约', () => {
  it('对照：LF 文件按 read_file 看到的文本做多行替换成功', async () => {
    const dir = useTmpDir('mao-edit-lf-');
    writeFileSync(join(dir, 'a.txt'), 'alpha\nbeta\ngamma\n');
    const read = JSON.parse(await new ReadFileTool(new PathSandbox(dir)).execute(JSON.stringify({ path: 'a.txt' })));
    expect(read.content).toBe('alpha\nbeta\ngamma');
    const edit = JSON.parse(await new EditFileTool(new PathSandbox(dir)).execute(JSON.stringify({
      path: 'a.txt', old_string: 'alpha\nbeta', new_string: 'alpha\nBETA',
    })));
    expect(edit.success).toBe(true);
  });

  it('回归：CRLF 文件按 read_file 展示的 LF 文本做多行替换应成功', async () => {
    const dir = useTmpDir('mao-edit-crlf-');
    writeFileSync(join(dir, 'a.txt'), 'alpha\r\nbeta\r\ngamma\r\n');
    const read = JSON.parse(await new ReadFileTool(new PathSandbox(dir)).execute(JSON.stringify({ path: 'a.txt' })));
    // read_file 已把 CRLF 归一成 LF，模型只能看到/复制这份文本
    expect(read.content).toBe('alpha\nbeta\ngamma');
    const edit = JSON.parse(await new EditFileTool(new PathSandbox(dir)).execute(JSON.stringify({
      path: 'a.txt', old_string: 'alpha\nbeta', new_string: 'alpha\nBETA',
    })));
    expect(edit.success, `edit failed: ${edit.error}`).toBe(true);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('alpha\r\nBETA\r\ngamma\r\n');
  });
});
