const pty = require('node-pty')
const os = require('os')

class TerminalManager {
  constructor() {
    /** @type {Map<string, {pty: import('node-pty').IPty, shell: string, cwd: string, createdAt: number}>} */
    this.sessions = new Map()
    this.nextId = 1
    /** @type {(() => Promise<object>)|null} */
    this.envProvider = null
  }

  /**
   * Set environment provider function
   * @param {() => Promise<object>} provider
   */
  setEnvProvider(provider) {
    this.envProvider = provider
  }

  /**
   * 创建新的终端会话
   * @param {object} options
   * @param {string} [options.cwd] - 初始工作目录
   * @param {number} [options.cols] - 列数
   * @param {number} [options.rows] - 行数
   * @param {string} [options.shell] - 指定 shell 路径
   * @returns {Promise<{ id: string, shell: string, cwd: string }>}
   */
  async create(options = {}) {
    const id = `term_${this.nextId++}`
    const shell = options.shell || this._detectShell()
    const cwd = options.cwd || os.homedir()

    const baseEnv = this.envProvider ? await this.envProvider() : process.env
    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: options.cols || 80,
      rows: options.rows || 24,
      cwd,
      env: {
        ...baseEnv,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
    })

    const session = {
      id,
      pty: ptyProcess,
      shell,
      cwd,
      createdAt: Date.now(),
    }

    this.sessions.set(id, session)
    return { id, shell, cwd }
  }

  /**
   * 向终端写入数据（键盘输入）
   * @param {string} id
   * @param {string} data
   */
  write(id, data) {
    const session = this.sessions.get(id)
    if (session) {
      session.pty.write(data)
    }
  }

  /**
   * 调整终端尺寸
   * @param {string} id
   * @param {number} cols
   * @param {number} rows
   */
  resize(id, cols, rows) {
    const session = this.sessions.get(id)
    if (session) {
      session.pty.resize(cols, rows)
    }
  }

  /**
   * 关闭终端会话
   * @param {string} id
   */
  kill(id) {
    const session = this.sessions.get(id)
    if (session) {
      session.pty.kill()
      this.sessions.delete(id)
    }
  }

  /**
   * 关闭所有终端会话（应用退出时调用）
   */
  killAll() {
    for (const [, session] of this.sessions) {
      session.pty.kill()
    }
    this.sessions.clear()
  }

  /**
   * 检测用户默认 shell
   * @returns {string}
   */
  _detectShell() {
    if (process.env.SHELL) {
      return process.env.SHELL
    }
    return process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
  }

  /**
   * 获取终端会话列表
   * @returns {Array<{id: string, shell: string, cwd: string, createdAt: number}>}
   */
  list() {
    return Array.from(this.sessions.values()).map(s => ({
      id: s.id,
      shell: s.shell,
      cwd: s.cwd,
      createdAt: s.createdAt,
    }))
  }
}

module.exports = { TerminalManager }
