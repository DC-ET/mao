import readline from 'node:readline';

/** TTY 下无回显输入；非 TTY 退化为普通 readline。 */
export function promptHidden(query: string): Promise<string> {
  const stdin = process.stdin as NodeJS.ReadStream;
  const stderr = process.stderr;
  if (!stdin.isTTY) {
    const rl = readline.createInterface({ input: stdin, output: stderr });
    return new Promise((resolve) => {
      rl.question(query, (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }

  return new Promise((resolve, reject) => {
    stderr.write(query);
    const wasRaw = stdin.isRaw;
    let buf = '';
    const onData = (chunk: Buffer | string) => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const ch of s) {
        if (ch === '\n' || ch === '\r') {
          cleanup();
          stderr.write('\n');
          resolve(buf);
          return;
        }
        if (ch === '\u0003') {
          cleanup();
          stderr.write('\n');
          reject(new Error('已取消'));
          return;
        }
        if (ch === '\u0004') {
          cleanup();
          stderr.write('\n');
          resolve(buf);
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          buf = buf.slice(0, -1);
          continue;
        }
        if (ch >= ' ') buf += ch;
      }
    };
    function cleanup() {
      stdin.off('data', onData);
      try {
        stdin.setRawMode(Boolean(wasRaw));
      } catch {
        // ignore
      }
    }
    try {
      stdin.setRawMode(true);
    } catch {
      cleanup();
      reject(new Error('无法切换到无回显输入'));
      return;
    }
    stdin.resume();
    stdin.on('data', onData);
  });
}

export function promptVisible(query: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
