/**
 * Demo 宿主页逻辑：模拟"内部业务系统"接入 Mao Embed SDK。
 * 模拟宿主后端 /embed-token：直接向 Mao 的 /auth/login 换取 access token。
 * 真实宿主应在其后端持有凭据并只下发短期 access token。
 */
import '../src/index';

interface DemoConfig {
  serverUrl: string;
  agentId: number;
  username: string;
  password: string;
  /** 页面操作总开关：false 时 Agent 无 page_* 工具、浮窗无授权/确认/日志 UI；缺省 true */
  pageEnabled?: boolean;
}

const CFG_KEY = 'mao_embed_demo_cfg';

function loadConfig(): DemoConfig {
  try {
    const raw = window.localStorage.getItem(CFG_KEY);
    if (raw) return JSON.parse(raw) as DemoConfig;
  } catch {
    /* ignore */
  }
  return {
    serverUrl: window.localStorage.getItem('mao_embed_demo_server') || 'http://localhost:9080',
    agentId: 1,
    username: 'admin',
    password: 'admin123',
    pageEnabled: true,
  };
}

function saveConfig(cfg: DemoConfig) {
  try {
    window.localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  } catch {
    /* ignore */
  }
}

let config = loadConfig();

/** 模拟宿主后端的 token 供给：登录换 token（access token 仅存内存） */
async function fetchEmbedToken(): Promise<string> {
  const resp = await fetch(`${config.serverUrl.replace(/\/+$/, '')}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: config.username, password: config.password }),
  });
  const payload = (await resp.json()) as { code: number; data?: { accessToken: string }; message?: string };
  if (payload.code !== 0 || !payload.data?.accessToken) {
    throw new Error(payload.message || '宿主获取 embed token 失败');
  }
  return payload.data.accessToken;
}

// 模拟页面路由：切换后 context() 返回值变化
let currentPage: 'order' | 'user' = 'order';

function pageContext(): Record<string, unknown> {
  if (currentPage === 'order') {
    const orderEl = document.getElementById('order-id');
    const statusEl = document.getElementById('order-status') as HTMLSelectElement | null;
    return {
      page: 'order-detail',
      orderId: orderEl?.textContent ?? '',
      status: statusEl?.value ?? '',
    };
  }
  return { page: 'user-list', totalRows: 128, filter: 'active' };
}

function boot(): void {
  const mao = window.MaoChat;
  if (!mao) return;
  mao.init({
    serverUrl: config.serverUrl,
    agentId: config.agentId,
    getToken: fetchEmbedToken,
    context: pageContext,
    theme: { primary: '#4f6ef7' },
    position: 'right',
    // 页面操作总开关演示：勾选框切换后写回配置并刷新，验证两态行为。
    page: { enabled: config.pageEnabled !== false },
    onEvent: (e: unknown) => console.info('[mao-embed event]', e),
  });
}

/** 页面开关勾选框：写入 demo 配置后刷新，init 以新声明重建浮窗 */
function bindPageToggle(): void {
  const toggle = document.getElementById('page-enabled') as HTMLInputElement | null;
  if (!toggle) return;
  toggle.checked = config.pageEnabled !== false;
  toggle.addEventListener('change', () => {
    saveConfig({ ...config, pageEnabled: toggle.checked });
    window.location.reload();
  });
}

// demo 侧配置输出：修改 localStorage 的 CFG_KEY 后刷新生效
console.info('[mao-embed demo] config =', config, '— 修改 localStorage 的', CFG_KEY, '后刷新生效');

// 页面导航
document.querySelectorAll<HTMLAnchorElement>('.nav a').forEach((a) => {
  a.addEventListener('click', () => {
    document.querySelectorAll('.nav a').forEach((x) => x.classList.remove('active'));
    a.classList.add('active');
    currentPage = a.dataset.page as 'order' | 'user';
    (document.getElementById('page-title') as HTMLElement).textContent =
      currentPage === 'order' ? '订单详情' : '用户列表';
    const orderRow = document.getElementById('order-id')?.parentElement;
    if (orderRow) orderRow.style.display = currentPage === 'order' ? '' : 'none';
  });
});

bindPageToggle();
boot();
