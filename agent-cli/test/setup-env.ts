/**
 * Ink 3 通过 ci-info 在 CI=true 时跳过 live 区的增量写屏（只 flush <Static>）。
 * GitHub Actions 会注入 CI=true，导致 ink-renderer 对弹窗/工具/提示的断言只看到欢迎卡。
 * 本文件在每个测试文件加载前清掉 CI 标记，让 TUI 按 TTY 路径渲染。
 */
delete process.env.CI;
delete process.env.CONTINUOUS_INTEGRATION;
