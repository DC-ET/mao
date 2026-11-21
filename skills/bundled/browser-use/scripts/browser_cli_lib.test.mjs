/**
 * browser_cli_lib 纯函数回归（方案 2026-11-21 §5.1）：argv 解析 / config 组装 / 平台判定。
 * 本地跑 `node --test browser_cli_lib.test.mjs`；是否进 CI 随 M2 一并评估。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOpenConfigJson,
  chromiumBinRelPath,
  chromiumCacheRoot,
  cliBinFromPackageJson,
  parseArgs,
  safeSessionName,
  systemChromeCandidates,
} from './browser_cli_lib.mjs';

describe('parseArgs（与 bash case 分支等价）', () => {
  it('子命令取首个位置参数', () => {
    assert.deepEqual(parseArgs(['open', 'https://example.com']), { subcommand: 'open', cliSession: 'default', userConfig: false });
    assert.deepEqual(parseArgs(['--raw', 'snapshot']), { subcommand: 'snapshot', cliSession: 'default', userConfig: false });
    assert.deepEqual(parseArgs([]), { subcommand: '', cliSession: 'default', userConfig: false });
  });

  it('-s=NAME / -s NAME / 环境变量三种会话来源', () => {
    assert.equal(parseArgs(['open', '-s=auth', 'https://x.com']).cliSession, 'auth');
    assert.equal(parseArgs(['-s', 'auth', 'open']).cliSession, 'auth');
    assert.equal(parseArgs(['open'], 'from-env').cliSession, 'from-env');
    // 环境变量为空串时回落 default（bash :- 语义）
    assert.equal(parseArgs(['open'], '').cliSession, 'default');
  });

  it('-s 后跟位置参数吞掉作会话名，且不再当子命令', () => {
    const parsed = parseArgs(['-s', 'auth', 'open']);
    assert.equal(parsed.cliSession, 'auth');
    assert.equal(parsed.subcommand, 'open');
  });

  it('-s 后跟 --config：prevS 保留，下一位置参数仍被吞作会话名（与 bash case 分支一致）', () => {
    const parsed = parseArgs(['-s', '--config=/x.json', 'open']);
    assert.deepEqual(parsed, { subcommand: '', cliSession: 'open', userConfig: true });
  });

  it('--config 两种形态置 userConfig；旗标重置 -s 吞参状态', () => {
    assert.equal(parseArgs(['open', '--config']).userConfig, true);
    assert.equal(parseArgs(['open', '--config=/x/y.json']).userConfig, true);
    // -s 后跟旗标：旗标清 prevS，后续位置参数回到子命令
    assert.deepEqual(parseArgs(['-s', '--headed', 'open']), { subcommand: 'open', cliSession: 'default', userConfig: false });
  });

  it('-s=NAME 优先于环境变量', () => {
    assert.equal(parseArgs(['-s=cli', 'open'], 'env').cliSession, 'cli');
  });
});

describe('safeSessionName', () => {
  it('合法字符保留，非法替换为 _，空回落 default', () => {
    assert.equal(safeSessionName('auth.1-x'), 'auth.1-x');
    assert.equal(safeSessionName('会话 1'), '___1');
    assert.equal(safeSessionName(''), 'default');
    // 全部为非法字符：替换后非空（与 bash tr 一致），仅空输入才回落 default
    assert.equal(safeSessionName('///'), '___');
  });
});

describe('chromiumCacheRoot（平台判定）', () => {
  it('win32 尊重 PLAYWRIGHT_BROWSERS_PATH', () => {
    assert.equal(chromiumCacheRoot('win32', { PLAYWRIGHT_BROWSERS_PATH: 'D:\\pw' }, 'C:\\Users\\u'), 'D:\\pw');
  });

  it('win32 回落 %LOCALAPPDATA%\\ms-playwright，无环境变量回退 homedir', () => {
    assert.equal(chromiumCacheRoot('win32', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, ''), 'C:\\Users\\u\\AppData\\Local/ms-playwright');
    assert.equal(chromiumCacheRoot('win32', {}, 'C:\\Users\\u'), 'C:\\Users\\u/AppData/Local/ms-playwright');
    // 两者皆缺：无法定位（空串，调用方按不可用处理）
    assert.equal(chromiumCacheRoot('win32', {}, ''), '');
  });

  it('darwin/Linux 维持现 bash 行为 ~/.cache/ms-playwright', () => {
    assert.equal(chromiumCacheRoot('linux', {}, '/root'), '/root/.cache/ms-playwright');
    assert.equal(chromiumCacheRoot('darwin', {}, '/Users/u'), '/Users/u/.cache/ms-playwright');
  });
});

describe('systemChromeCandidates', () => {
  it('darwin 应用包路径', () => {
    assert.deepEqual(systemChromeCandidates('darwin'), ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']);
  });

  it('win32 三候选：env 命中 / 缺省回退', () => {
    assert.deepEqual(
      systemChromeCandidates('win32', { ProgramFiles: 'D:\\PF', 'ProgramFiles(x86)': 'D:\\PF86', LOCALAPPDATA: 'D:\\LAD' }, ''),
      ['D:\\PF\\Google\\Chrome\\Application\\chrome.exe', 'D:\\PF86\\Google\\Chrome\\Application\\chrome.exe', 'D:\\LAD\\Google\\Chrome\\Application\\chrome.exe'],
    );
    const fallback = systemChromeCandidates('win32', {}, 'C:\\Users\\u');
    assert.deepEqual(fallback, [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Users\\u/AppData/Local\\Google\\Chrome\\Application\\chrome.exe',
    ]);
  });

  it('linux 命令名 + 绝对路径（bash 原样）', () => {
    assert.deepEqual(systemChromeCandidates('linux'), ['google-chrome', 'google-chrome-stable', '/opt/google/chrome/chrome', '/usr/bin/google-chrome']);
  });
});

describe('chromiumBinRelPath', () => {
  it('win32 glob chrome-win*（chrome-win / chrome-win64 都命中）', () => {
    assert.equal(chromiumBinRelPath('win32', ['chrome-win', 'resources']), 'chrome-win/chrome.exe');
    assert.equal(chromiumBinRelPath('win32', ['chrome-win64']), 'chrome-win64/chrome.exe');
    assert.equal(chromiumBinRelPath('win32', ['other']), null);
  });

  it('darwin/Linux 固定 chrome-linux 布局', () => {
    assert.equal(chromiumBinRelPath('linux', ['chrome-linux', 'deps']), 'chrome-linux/chrome');
    assert.equal(chromiumBinRelPath('darwin', ['chrome-linux']), 'chrome-linux/chrome');
    assert.equal(chromiumBinRelPath('linux', []), null);
  });
});

describe('cliBinFromPackageJson', () => {
  it('bin 为字符串 / 对象（playwright-cli 键或首个值）', () => {
    assert.equal(cliBinFromPackageJson('{"bin":"bin/cli.js"}'), 'bin/cli.js');
    assert.equal(cliBinFromPackageJson('{"bin":{"playwright-cli":"bin/cli.js","other":"bin/o.js"}}'), 'bin/cli.js');
    assert.equal(cliBinFromPackageJson('{"bin":{"foo":"bin/foo.js"}}'), 'bin/foo.js');
  });

  it('缺 bin / 非 JSON / bin 非法 → null', () => {
    assert.equal(cliBinFromPackageJson('{}'), null);
    assert.equal(cliBinFromPackageJson('not-json'), null);
    assert.equal(cliBinFromPackageJson('{"bin":42}'), null);
    assert.equal(cliBinFromPackageJson('{"bin":{}}'), null);
  });
});

describe('buildOpenConfigJson', () => {
  const template = JSON.stringify({ browser: { launchOptions: { channel: 'chrome', args: ['--disable-dev-shm-usage', '--disable-gpu'] } } });

  it('注入调试端口，保留模板既有参数与 channel', () => {
    const cfg = JSON.parse(buildOpenConfigJson(template, 9222, '', true, false));
    assert.deepEqual(cfg.browser.launchOptions.args, ['--disable-dev-shm-usage', '--disable-gpu', '--remote-debugging-port=9222']);
    assert.equal(cfg.browser.launchOptions.channel, 'chrome');
  });

  it('root 参数按空格拆开追加；无 root 参数时为空串不追加', () => {
    const cfg = JSON.parse(buildOpenConfigJson(template, 9222, '--no-sandbox', true, false));
    assert.deepEqual(cfg.browser.launchOptions.args.slice(-2), ['--remote-debugging-port=9222', '--no-sandbox']);
    const cfg2 = JSON.parse(buildOpenConfigJson(template, 9222, '', true, false));
    assert.equal(cfg2.browser.launchOptions.args.filter((a) => a === '--no-sandbox').length, 0);
  });

  it('系统 Chrome 缺失且 chromium 就位 → 去掉 channel；chrome 在时不删', () => {
    const withoutChrome = JSON.parse(buildOpenConfigJson(template, 9222, '', false, true));
    assert.equal(withoutChrome.browser.launchOptions.channel, undefined);
    assert.deepEqual(withoutChrome.browser.launchOptions.args.slice(-1), ['--remote-debugging-port=9222']);
    const withChrome = JSON.parse(buildOpenConfigJson(template, 9222, '', true, true));
    assert.equal(withChrome.browser.launchOptions.channel, 'chrome');
  });

  it('模板无 launchOptions/args 时也能组装', () => {
    const cfg = JSON.parse(buildOpenConfigJson('{}', 9222, '--no-sandbox', false, true));
    assert.deepEqual(cfg.browser.launchOptions.args, ['--remote-debugging-port=9222', '--no-sandbox']);
    assert.equal(cfg.browser.launchOptions.channel, undefined);
  });

  it('模板非法 JSON 抛错（入口按 config 写失败处理）', () => {
    assert.throws(() => buildOpenConfigJson('not-json', 9222, '', true, false));
  });
});
