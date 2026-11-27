<template>
  <div ref="pageRef" class="welcome-page">
    <header class="wl-nav" :class="{ 'wl-nav--scrolled': scrolled }">
      <div class="wl-nav__inner">
        <a class="wl-brand" href="#top" @click.prevent="scrollToSection('top')">
          <img :src="appIcon" alt="" class="wl-brand__logo" />
          <span class="wl-brand__name">Mao</span>
        </a>
        <nav class="wl-nav__links" aria-label="页面导航">
          <a href="#why" @click.prevent="scrollToSection('why')">产品价值</a>
          <a href="#how" @click.prevent="scrollToSection('how')">工作方式</a>
          <a href="#start" @click.prevent="scrollToSection('start')">部署</a>
          <a href="/docs" @click.prevent="goDocs()">文档</a>
        </nav>
        <div class="wl-nav__actions">
          <button
            class="wl-icon-btn"
            type="button"
            :aria-label="themeLabel"
            :title="themeLabel"
            @click="toggleTheme"
          >
            <el-icon :size="16">
              <Sunrise v-if="theme === 'auto'" />
              <Moon v-else-if="theme === 'light'" />
              <Sunny v-else />
            </el-icon>
          </button>
          <a
            class="wl-nav__github"
            href="https://github.com/DC-ET/mao"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="GitHub 仓库"
          ><GitHubMark /><span class="wl-nav__github-text">GitHub</span></a>
          <button class="wl-btn wl-btn--primary wl-btn--sm" type="button" @click="goDocs('deploy')">
            开始部署
          </button>
        </div>
      </div>
    </header>

    <section id="top" class="wl-hero">
      <div class="wl-hero__glow" aria-hidden="true" />
      <div class="wl-hero__inner">
        <p class="wl-hero__eyebrow wl-enter">MIT 开源 · 私有化部署 · 数据自持</p>
        <h1 class="wl-hero__title wl-enter">
          <span class="wl-keep">让团队的 AI，</span><span class="wl-keep wl-hero__accent">不止停在对话里</span>
        </h1>
        <p class="wl-hero__lead wl-enter">
          自托管的团队级 AI Agent 平台。统一管理模型、权限与岗位经验，成员从飞书、钉钉、微信或 Web、桌面端直接发起任务，执行过程、操作与成本全程可追溯。
        </p>
        <div class="wl-hero__cta wl-enter">
          <button class="wl-btn wl-btn--primary" type="button" @click="goDocs('deploy')">
            开始部署
            <el-icon :size="15"><Right /></el-icon>
          </button>
          <a
            class="wl-btn wl-btn--ghost"
            href="https://github.com/DC-ET/mao"
            target="_blank"
            rel="noopener noreferrer"
          ><GitHubMark />查看源码</a>
        </div>
      </div>

      <div class="wl-hero__visual wl-enter">
        <div class="wl-shot">
          <img
            :src="heroShot.src"
            :width="heroShot.width"
            :height="heroShot.height"
            alt="Mao 工作台界面：左侧任务列表，中间会话，右侧任务进度、工作区与子代理信息"
            class="wl-shot__img"
            decoding="async"
          />
        </div>
      </div>
    </section>

    <section id="why" class="wl-section">
      <div class="wl-section__inner">
        <header class="wl-section__head reveal">
          <p class="wl-section__kicker">产品价值</p>
          <h2 class="wl-section__title">把 Agent 做成团队的基础设施</h2>
          <p class="wl-section__subtitle">
            多数 Agent 工具为个人电脑而设计。Mao 从一开始就按团队协作来建：部署一次，全员在同一套规则下使用。
          </p>
        </header>
        <div class="wl-pillars">
          <article v-for="p in pillars" :key="p.key" class="wl-pillar reveal">
            <div class="wl-pillar__visual" aria-hidden="true">
              <div v-if="p.key === 'team'" class="wl-mock">
                <div class="wl-mock__avatars">
                  <span v-for="a in teamAvatars" :key="a.text" :style="{ background: a.color }">{{ a.text }}</span>
                  <span class="wl-mock__avatars-more">+24</span>
                </div>
                <div class="wl-mock__chips">
                  <span class="is-active">管理员</span><span>研发</span><span>运营</span><span>客服</span>
                </div>
                <div class="wl-mock__meter">
                  <div class="wl-mock__meter-row"><span>本月模型预算</span><b>62%</b></div>
                  <div class="wl-mock__meter-bar"><i /></div>
                </div>
              </div>
              <div v-else-if="p.key === 'exec'" class="wl-mock">
                <div class="wl-mock__head">
                  <span class="wl-mock__badge">CLOUD</span>
                  <span class="wl-mock__head-title">排查支付回调超时</span>
                </div>
                <ul class="wl-mock__steps">
                  <li class="is-done"><el-icon :size="12"><Check /></el-icon>拉取代码仓库</li>
                  <li class="is-done"><el-icon :size="12"><Check /></el-icon>定位慢查询</li>
                  <li class="is-run"><el-icon :size="12" class="is-loading"><Loading /></el-icon>运行回归测试</li>
                  <li><i />提交修复并通知群聊</li>
                </ul>
              </div>
              <div v-else class="wl-mock">
                <div class="wl-mock__search">
                  <el-icon :size="13"><Search /></el-icon>支付回调超时怎么排查？
                </div>
                <div class="wl-mock__hit">
                  <span class="wl-mock__hit-tag">团队经验</span>
                  <span class="wl-mock__hit-title">支付回调超时排障路径</span>
                  <span class="wl-mock__hit-meta">已复用 12 次</span>
                </div>
                <div class="wl-mock__hit is-dim">
                  <span class="wl-mock__hit-tag">岗位知识</span>
                  <span class="wl-mock__hit-title">订单库索引规范</span>
                  <span class="wl-mock__hit-meta">已复用 5 次</span>
                </div>
              </div>
            </div>
            <div class="wl-pillar__body">
              <div class="wl-pillar__title">
                <span class="wl-pillar__icon" aria-hidden="true">
                  <el-icon :size="17"><component :is="p.icon" /></el-icon>
                </span>
                <h3>{{ p.title }}</h3>
              </div>
              <p>{{ p.desc }}</p>
              <ul class="wl-pillar__list">
                <li v-for="item in p.points" :key="item">
                  <el-icon :size="14" aria-hidden="true"><Check /></el-icon>{{ item }}
                </li>
              </ul>
            </div>
          </article>
        </div>
      </div>
    </section>

    <section id="how" class="wl-section wl-section--tint">
      <div class="wl-section__inner">
        <header class="wl-section__head reveal">
          <p class="wl-section__kicker">工作方式</p>
          <h2 class="wl-section__title">配置一次，从常用渠道发起</h2>
          <p class="wl-section__subtitle">
            同一套智能体、权限与经验库，按场景选择入口，不用为每个工具重复配置。
          </p>
        </header>

        <ol class="wl-flow">
          <li v-for="(s, i) in flow" :key="s.title" class="wl-flow__step reveal">
            <span class="wl-flow__num">{{ i + 1 }}</span>
            <h3>{{ s.title }}</h3>
            <p>{{ s.desc }}</p>
          </li>
        </ol>

        <div class="wl-hub reveal">
          <div v-for="side in hubSides" :key="side.key" class="wl-hub__side" :class="`wl-hub__side--${side.key}`">
            <h3 class="wl-hub__side-title">{{ side.title }}</h3>
            <ul class="wl-hub__list">
              <li v-for="c in side.items" :key="c.name" class="wl-channel">
                <span class="wl-channel__icon" aria-hidden="true">
                  <img v-if="c.logo" :src="c.logo" alt="" />
                  <span v-else-if="c.glyph" class="wl-channel__glyph">{{ c.glyph }}</span>
                  <el-icon v-else-if="c.icon" :size="16"><component :is="c.icon" /></el-icon>
                </span>
                <span class="wl-channel__text">
                  <span class="wl-channel__name">{{ c.name }}</span>
                  <span class="wl-channel__desc">{{ c.desc }}</span>
                </span>
              </li>
            </ul>
          </div>
          <div class="wl-hub__core">
            <div class="wl-hub__core-card">
              <span class="wl-hub__core-logo"><img :src="appIcon" alt="" /></span>
              <p class="wl-hub__core-name">Mao</p>
              <p class="wl-hub__core-tag">团队智能体中枢</p>
              <ul class="wl-hub__core-list">
                <li v-for="c in hubCore" :key="c.name">
                  <el-icon :size="14" aria-hidden="true"><component :is="c.icon" /></el-icon>{{ c.name }}
                </li>
              </ul>
            </div>
          </div>
        </div>
        <p class="wl-channels__more reveal">
          各渠道的接入步骤见
          <button class="wl-text-btn" type="button" @click="goDocs()">官方文档</button>
        </p>
      </div>
    </section>

    <section id="start" class="wl-section wl-section--grid">
      <div class="wl-section__inner wl-start">
        <div class="wl-start__intro reveal">
          <p class="wl-section__kicker">部署</p>
          <h2 class="wl-section__title">从生产部署开始</h2>
          <p class="wl-section__subtitle">
            一台 Linux 服务器，准备 Node.js 22+、Nginx 与 MySQL 8 即可。需要容器隔离时，另装 Docker 并构建运行时镜像。
          </p>
          <ol class="wl-checklist">
            <li v-for="(s, i) in deploySteps" :key="s.title">
              <span class="wl-checklist__num">{{ i + 1 }}</span>
              <div>
                <strong>{{ s.title }}</strong>
                <span>{{ s.desc }}</span>
              </div>
            </li>
          </ol>
          <div class="wl-start__actions">
            <button class="wl-btn wl-btn--primary" type="button" @click="goDocs('deploy')">
              阅读部署手册
            </button>
            <button class="wl-text-btn" type="button" @click="goDocs('install')">
              本地开发请看安装指南
            </button>
          </div>
        </div>

        <div class="wl-term reveal">
          <div class="wl-term__bar">
            <span class="wl-term__dots" aria-hidden="true"><i /><i /><i /></span>
            <span class="wl-term__title">首次部署</span>
            <button
              class="wl-term__copy"
              type="button"
              :aria-label="copied ? '已复制部署命令' : '复制部署命令'"
              :title="copied ? '已复制' : '复制命令'"
              @click="copyCommands"
            >
              <el-icon :size="14"><Check v-if="copied" /><CopyDocument v-else /></el-icon>
            </button>
          </div>
          <pre class="wl-term__body"><code><span
            v-for="(line, i) in deployCommands"
            :key="i"
            :class="line.startsWith('#') ? 'wl-term__comment' : 'wl-term__cmd'"
          >{{ line }}
</span></code></pre>
        </div>
      </div>
    </section>

    <section class="wl-band">
      <div class="wl-band__inner reveal">
        <div class="wl-band__deco" aria-hidden="true" />
        <img :src="appIcon" alt="" class="wl-band__logo" />
        <h2 class="wl-band__title">部署一次，让全员用上团队 AI</h2>
        <p class="wl-band__lead">MIT 开源，模型密钥、会话与经验都留在你自己的服务器上。</p>
        <div class="wl-band__cta">
          <button class="wl-btn wl-btn--primary" type="button" @click="goDocs('deploy')">
            开始部署
            <el-icon :size="15"><Right /></el-icon>
          </button>
          <a
            class="wl-btn wl-btn--ghost"
            href="https://github.com/DC-ET/mao"
            target="_blank"
            rel="noopener noreferrer"
          ><GitHubMark />查看源码</a>
        </div>
      </div>
    </section>

    <footer class="wl-footer">
      <div class="wl-footer__inner">
        <div class="wl-footer__brand">
          <img :src="appIcon" alt="" class="wl-brand__logo" />
          <div>
            <p class="wl-footer__name">Mao</p>
            <p class="wl-footer__tag">团队级 AI Agent 自托管平台</p>
          </div>
        </div>
        <nav class="wl-footer__links" aria-label="页脚导航">
          <a href="https://github.com/DC-ET/mao" target="_blank" rel="noopener noreferrer"><GitHubMark />GitHub 仓库</a>
          <a href="/docs/deploy" @click.prevent="goDocs('deploy')">部署手册</a>
          <a href="/docs" @click.prevent="goDocs()">官方文档</a>
        </nav>
        <p class="wl-footer__copy">© 2026 Mao · MIT License</p>
      </div>
    </footer>
  </div>
</template>
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { Component } from 'vue'
import { useRouter } from 'vue-router'
import {
  Aim,
  Avatar,
  Check,
  Collection,
  Connection,
  CopyDocument,
  Cpu,
  Iphone,
  Link,
  Loading,
  Lock,
  Monitor,
  Moon,
  Platform,
  Right,
  Search,
  Share,
  Sunny,
  Sunrise,
  Timer,
  User
} from '@element-plus/icons-vue'
import appIcon from '../../assets/app-icon-small.png'
import heroLight from '../../assets/welcome-hero-light.jpg'
import heroDark from '../../assets/welcome-hero-dark.jpg'
import GitHubMark from '../../components/common/GitHubMark.vue'
import feishuLogo from '../../assets/feishu-logo.svg'
import dingtalkLogo from '../../assets/dingtalk-logo.svg'
import weixinLogo from '../../assets/weixin-logo.png'
import { useTheme } from '../../utils/theme'
import { copyText } from '../../utils/clipboard'

const router = useRouter()
const { theme, isDark, toggleTheme } = useTheme()

const themeLabel = computed(() => {
  if (theme.value === 'auto') return '跟随系统（点击切换浅色）'
  if (theme.value === 'light') return '浅色（点击切换深色）'
  return '深色（点击跟随系统）'
})

const heroShot = computed(() =>
  isDark.value
    ? { src: heroDark, width: 2320, height: 1274 }
    : { src: heroLight, width: 2320, height: 1300 }
)

type Pillar = { key: 'team' | 'exec' | 'exp'; icon: Component; title: string; desc: string; points: string[] }

const teamAvatars = [
  { text: '王', color: '#5b8def' },
  { text: '李', color: '#f08a5d' },
  { text: '陈', color: '#46b37b' },
  { text: '赵', color: '#a77bf3' },
  { text: '周', color: '#e5b343' }
]

const pillars: Pillar[] = [
  {
    key: 'team',
    icon: User,
    title: '团队共用',
    desc: '模型 API Key、账号与权限集中管理，成员开箱即用，本地电脑无需额外运行环境。',
    points: ['RBAC 权限与操作审计', '用量成本统计与预算管控', '岗位智能体统一下发']
  },
  {
    key: 'exec',
    icon: Cpu,
    title: '执行任务',
    desc: '不只是对话。日常任务在云端执行，需要读写本机代码库时切换到 LOCAL 模式。',
    points: ['可选容器隔离运行时', '定时任务与信号哨兵', 'Open API 与 Webhook 触发']
  },
  {
    key: 'exp',
    icon: Collection,
    title: '经验沉淀',
    desc: '智能体解决复杂问题后归档排障路径与领域知识，后续任务先检索再执行。',
    points: ['团队经验库按智能体隔离', '技能与岗位知识复用', '会话全程留痕可复盘']
  }
]

const flow = [
  { title: '管理员配置一次', desc: '在管理后台接入模型、创建岗位智能体，分配权限与预算。' },
  { title: '成员随处发起', desc: '在飞书、钉钉、微信或 Web、桌面端，直接把任务交给智能体。' },
  { title: '执行并沉淀经验', desc: '智能体在云端或本机执行，过程与成本留痕，经验归档供下次复用。' }
]

type Channel = { name: string; desc: string; icon?: Component; logo?: string; glyph?: string }

const hubSides: { key: 'in' | 'out'; title: string; items: Channel[] }[] = [
  {
    key: 'in',
    title: '成员入口',
    items: [
      { name: '飞书', desc: '群聊与私聊机器人', logo: feishuLogo },
      { name: '钉钉', desc: '企业内部应用机器人', logo: dingtalkLogo },
      { name: '微信', desc: '扫码绑定个人 Bot', logo: weixinLogo },
      { name: 'Web 工作台', desc: '浏览器直接使用', icon: Monitor },
      { name: '桌面端', desc: 'Electron，支持 LOCAL 模式', icon: Platform },
      { name: 'Android', desc: '移动端随手发起', icon: Iphone }
    ]
  },
  {
    key: 'out',
    title: '集成与自动化',
    items: [
      { name: 'Embed SDK', desc: '嵌入内部系统页面', icon: Link },
      { name: 'mao-agent CLI', desc: '终端与 CI 流水线', glyph: '>_' },
      { name: 'Open API', desc: 'API Token 程序化调用', icon: Connection },
      { name: 'Webhook 触发', desc: '外部事件拉起任务', icon: Share },
      { name: '定时任务', desc: '按计划自动执行', icon: Timer },
      { name: '信号哨兵', desc: '接口变化触发智能体', icon: Aim }
    ]
  }
]

const hubCore = [
  { name: '岗位智能体', icon: Avatar },
  { name: '权限与预算', icon: Lock },
  { name: '团队经验库', icon: Collection }
]

const deploySteps = [
  { title: '准备环境', desc: 'Linux 服务器、Node.js 22+、Nginx、MySQL 8。' },
  { title: '构建与配置', desc: '构建 backend-ts、admin、desktop，写好后端 .env。' },
  { title: '上线访问', desc: '启动后端，配置 Nginx 反向代理与 HTTPS。' },
  { title: '初始化', desc: '打开 /admin/ 修改管理员密码并配置模型 API Key。' }
]

const deployCommands = [
  '# 克隆仓库',
  'git clone https://github.com/DC-ET/mao.git /opt/mao',
  '# 构建（前端同源，无需按域名改 API 地址）',
  'cd /opt/mao/backend-ts && npm ci && npm run build',
  'bash /opt/mao/scripts/deploy-admin.sh',
  'bash /opt/mao/scripts/deploy-desktop.sh',
  '# 写好 backend-ts/.env 后启动',
  '/opt/mao/backend-ts/restart.sh'
]

const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | null = null

async function copyCommands() {
  const ok = await copyText(deployCommands.join('\n'))
  copied.value = ok
  if (copiedTimer) clearTimeout(copiedTimer)
  if (ok) copiedTimer = setTimeout(() => (copied.value = false), 2000)
}

const pageRef = ref<HTMLElement | null>(null)
const scrolled = ref(false)

function onScroll() {
  scrolled.value = window.scrollY > 8
}

function scrollToSection(id: string) {
  const el = document.getElementById(id)
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function goDocs(slug = '') {
  router.push(slug ? `/docs/${slug}` : '/docs')
}

let observer: IntersectionObserver | null = null
let previousTitle = ''

onMounted(() => {
  previousTitle = document.title
  document.title = 'Mao · 团队级 AI Agent 自托管平台'
  const desc = document.querySelector('meta[name="description"]')
  if (desc) {
    desc.setAttribute(
      'content',
      'Mao 是团队级 AI Agent 自托管平台：统一管理模型、权限与岗位经验，成员从飞书、钉钉、微信或 Web、桌面端发起任务，过程与成本可追溯。'
    )
  }

  window.addEventListener('scroll', onScroll, { passive: true })
  onScroll()

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const root = pageRef.value
  if (!root || reduceMotion || !('IntersectionObserver' in window)) return

  root.classList.add('wl-animate')
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('reveal--in')
          observer?.unobserve(entry.target)
        }
      }
    },
    { rootMargin: '0px 0px -6% 0px' }
  )
  root.querySelectorAll('.reveal').forEach((el) => observer?.observe(el))
})

onUnmounted(() => {
  window.removeEventListener('scroll', onScroll)
  observer?.disconnect()
  observer = null
  if (copiedTimer) clearTimeout(copiedTimer)
  document.title = previousTitle
})
</script>
<style scoped>
.welcome-page {
  min-height: 100vh;
  background: var(--aw-canvas);
  color: var(--aw-ink);
  font-family: var(--aw-font-text);
  -webkit-font-smoothing: antialiased;
}

/* ---------- 导航 ---------- */
.wl-nav {
  position: sticky;
  top: 0;
  z-index: 50;
  background: var(--aw-surface-glass);
  backdrop-filter: saturate(180%) blur(18px);
  -webkit-backdrop-filter: saturate(180%) blur(18px);
  border-bottom: 1px solid transparent;
  transition: border-color 0.2s ease;
}
.wl-nav--scrolled {
  border-bottom-color: var(--aw-divider);
}
.wl-nav__inner {
  max-width: 1160px;
  margin: 0 auto;
  padding: 0 24px;
  height: 60px;
  display: flex;
  align-items: center;
  gap: 28px;
}
.wl-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  text-decoration: none;
  color: var(--aw-ink);
}
.wl-brand__logo {
  width: 30px;
  height: 30px;
  border-radius: 8px;
}
.wl-brand__name {
  font-family: var(--aw-font-display);
  font-size: 19px;
  font-weight: 600;
  letter-spacing: 0.01em;
}
.wl-nav__links {
  display: flex;
  gap: 24px;
  margin-left: 8px;
  flex: 1;
}
.wl-nav__links a,
.wl-nav__github {
  color: var(--aw-ink-muted-64);
  font-size: 14px;
  text-decoration: none;
  transition: color 0.15s ease;
}
.wl-nav__links a:hover,
.wl-nav__github:hover {
  color: var(--aw-ink);
}
.wl-nav__github {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.wl-nav__actions {
  display: flex;
  align-items: center;
  gap: 14px;
}
.wl-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: var(--aw-radius-pill);
  background: transparent;
  color: var(--aw-ink-muted-64);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.wl-icon-btn:hover {
  background: rgba(0, 0, 0, 0.06);
  color: var(--aw-ink);
}
[data-theme='dark'] .wl-icon-btn:hover {
  background: rgba(255, 255, 255, 0.08);
}

/* ---------- 按钮 ---------- */
.wl-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 46px;
  padding: 0 26px;
  border-radius: var(--aw-radius-pill);
  border: 1px solid transparent;
  font-size: 15px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  text-decoration: none;
  transition: transform 0.15s ease, background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
}
.wl-btn:hover {
  transform: translateY(-1px);
}
.wl-btn--sm {
  height: 34px;
  padding: 0 16px;
  font-size: 13.5px;
}
.wl-btn--primary {
  background: var(--aw-primary);
  color: var(--aw-on-primary);
  box-shadow: 0 6px 18px -8px rgba(var(--aw-accent-rgb), 0.7);
}
.wl-btn--primary:hover {
  background: var(--aw-primary-focus);
}
.wl-btn--ghost {
  background: var(--aw-surface);
  color: var(--aw-ink);
  border-color: var(--aw-border);
}
.wl-btn--ghost:hover {
  border-color: var(--aw-ink-muted-40);
}
.wl-text-btn {
  display: inline;
  padding: 0;
  border: 0;
  background: none;
  color: var(--aw-primary);
  font: inherit;
  font-weight: 500;
  cursor: pointer;
}
.wl-text-btn:hover {
  text-decoration: underline;
}

/* ---------- Hero ---------- */
.wl-hero {
  position: relative;
  padding: 80px 24px 40px;
  overflow: hidden;
}
.wl-hero__glow {
  position: absolute;
  inset: -240px 0 auto;
  height: 720px;
  pointer-events: none;
  background:
    radial-gradient(520px 320px at 24% 46%, rgba(var(--aw-accent-rgb), 0.14), transparent 70%),
    radial-gradient(560px 320px at 78% 34%, rgba(var(--aw-accent-rgb), 0.1), transparent 70%);
}
.wl-hero__inner {
  position: relative;
  max-width: 860px;
  margin: 0 auto 56px;
  text-align: center;
}
.wl-hero__eyebrow {
  display: inline-block;
  margin: 0 0 22px;
  padding: 6px 14px;
  border-radius: var(--aw-radius-pill);
  background: var(--aw-primary-soft);
  border: 1px solid rgba(var(--aw-accent-rgb), 0.18);
  color: var(--aw-primary);
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.04em;
}
.wl-hero__title {
  margin: 0;
  font-family: var(--aw-font-display);
  font-size: clamp(34px, 5.4vw, 62px);
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: -0.02em;
  color: var(--aw-ink);
}
.wl-keep {
  display: inline-block;
  white-space: nowrap;
}
.wl-hero__accent {
  background: linear-gradient(100deg, var(--aw-primary) 10%, rgba(var(--aw-accent-rgb), 0.62) 90%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.wl-hero__lead {
  margin: 22px auto 0;
  max-width: 620px;
  font-size: 17px;
  line-height: 1.75;
  color: var(--aw-ink-muted-64);
  text-wrap: pretty;
}
.wl-hero__cta {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 34px;
}
.wl-hero__visual {
  position: relative;
  max-width: 1160px;
  margin: 0 auto;
}
.wl-hero__visual::before {
  content: '';
  position: absolute;
  inset: 8% 6% -4%;
  border-radius: 40px;
  background: radial-gradient(60% 60% at 50% 40%, rgba(var(--aw-accent-rgb), 0.22), transparent 75%);
  filter: blur(40px);
  pointer-events: none;
}

/* ---------- 产品截图 ---------- */
.wl-shot {
  position: relative;
  padding: 8px;
  border-radius: calc(var(--aw-radius-lg) + 6px);
  background: linear-gradient(180deg, rgba(var(--aw-accent-rgb), 0.12), rgba(var(--aw-accent-rgb), 0.02));
  border: 1px solid rgba(var(--aw-accent-rgb), 0.14);
}
.wl-shot__img {
  display: block;
  width: 100%;
  height: auto;
  border-radius: var(--aw-radius-lg);
  border: 1px solid var(--aw-divider);
  box-shadow: var(--aw-shadow-product);
  background: var(--aw-surface);
}

/* ---------- 通用 Section ---------- */
.wl-section {
  padding: 104px 24px;
  scroll-margin-top: 60px;
}
.wl-section--tint {
  background: var(--aw-canvas-parchment);
}
.wl-section--grid {
  position: relative;
  overflow: hidden;
}
.wl-section--grid::before {
  content: '';
  position: absolute;
  inset: 0;
  background:
    linear-gradient(rgba(var(--aw-accent-rgb), 0.07) 1px, transparent 1px) 0 0 / 44px 44px,
    linear-gradient(90deg, rgba(var(--aw-accent-rgb), 0.07) 1px, transparent 1px) 0 0 / 44px 44px;
  -webkit-mask-image: radial-gradient(70% 70% at 75% 50%, #000, transparent 80%);
  mask-image: radial-gradient(70% 70% at 75% 50%, #000, transparent 80%);
  pointer-events: none;
}
.wl-section--grid::after {
  content: '';
  position: absolute;
  top: 50%;
  right: 8%;
  width: 520px;
  height: 380px;
  transform: translateY(-50%);
  background: radial-gradient(50% 50% at 50% 50%, rgba(var(--aw-accent-rgb), 0.16), transparent 70%);
  filter: blur(30px);
  pointer-events: none;
}
.wl-section--grid > .wl-section__inner {
  position: relative;
  z-index: 1;
}

/* ---------- 收尾横幅 ---------- */
.wl-band {
  padding: 0 24px 104px;
}
.wl-band__inner {
  position: relative;
  max-width: 1160px;
  margin: 0 auto;
  padding: 64px 32px;
  border-radius: 28px;
  overflow: hidden;
  text-align: center;
  color: var(--aw-ink);
  background:
    radial-gradient(70% 90% at 50% 0%, rgba(var(--aw-accent-rgb), 0.1), transparent 70%),
    var(--aw-canvas-parchment);
  border: 1px solid var(--aw-divider);
}
.wl-band__deco {
  position: absolute;
  inset: 0;
  background: radial-gradient(rgba(var(--aw-accent-rgb), 0.16) 1px, transparent 1.2px) 0 0 / 20px 20px;
  -webkit-mask-image: radial-gradient(55% 90% at 50% 50%, transparent 35%, #000);
  mask-image: radial-gradient(55% 90% at 50% 50%, transparent 35%, #000);
  pointer-events: none;
}
.wl-band__logo {
  position: relative;
  width: 56px;
  height: 56px;
  border-radius: 15px;
  box-shadow: 0 10px 24px -12px rgba(0, 0, 0, 0.35);
}
.wl-band__title {
  position: relative;
  margin: 20px 0 0;
  font-family: var(--aw-font-display);
  font-size: clamp(26px, 3.2vw, 36px);
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--aw-ink);
  text-wrap: balance;
}
.wl-band__lead {
  position: relative;
  margin: 12px auto 0;
  max-width: 520px;
  font-size: 16px;
  line-height: 1.7;
  color: var(--aw-ink-muted-64);
}
.wl-band__cta {
  position: relative;
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 30px;
}
.wl-section__inner {
  max-width: 1160px;
  margin: 0 auto;
}
.wl-section__head {
  max-width: 680px;
}
.wl-section__kicker {
  margin: 0 0 12px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--aw-primary);
}
.wl-section__title {
  margin: 0;
  font-family: var(--aw-font-display);
  font-size: clamp(28px, 3.4vw, 40px);
  font-weight: 650;
  letter-spacing: -0.02em;
  line-height: 1.25;
  color: var(--aw-ink);
  text-wrap: balance;
}
.wl-section__subtitle {
  margin: 14px 0 0;
  font-size: 16.5px;
  line-height: 1.75;
  color: var(--aw-ink-muted-64);
  text-wrap: pretty;
}

/* ---------- 三条主线 ---------- */
.wl-pillars {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 20px;
  margin-top: 48px;
}
.wl-pillar {
  display: flex;
  flex-direction: column;
  padding: 10px;
  border-radius: calc(var(--aw-radius-lg) + 4px);
  background: var(--aw-surface);
  border: 1px solid var(--aw-divider);
  transition: border-color 0.2s ease, box-shadow 0.2s ease, transform 0.2s ease;
}
.wl-pillar:hover {
  border-color: rgba(var(--aw-accent-rgb), 0.28);
  box-shadow: 0 16px 40px -22px rgba(var(--aw-accent-rgb), 0.5);
}
.wl-pillar__visual {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 188px;
  border-radius: var(--aw-radius-lg);
  overflow: hidden;
  background:
    radial-gradient(rgba(var(--aw-accent-rgb), 0.2) 1px, transparent 1.2px) 0 0 / 16px 16px,
    radial-gradient(120% 90% at 50% 0%, rgba(var(--aw-accent-rgb), 0.16), rgba(var(--aw-accent-rgb), 0.03) 70%);
}
.wl-pillar__visual::after {
  content: '';
  position: absolute;
  inset: auto 0 0;
  height: 40px;
  background: linear-gradient(transparent, rgba(var(--aw-accent-rgb), 0.04));
  pointer-events: none;
}
.wl-pillar__body {
  padding: 22px 16px 16px;
}
.wl-pillar__title {
  display: flex;
  align-items: center;
  gap: 10px;
}
.wl-pillar__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 32px;
  height: 32px;
  border-radius: 9px;
  background: rgba(var(--aw-accent-rgb), 0.1);
  color: var(--aw-primary);
}
.wl-pillar h3 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  color: var(--aw-ink);
}
.wl-pillar p {
  margin: 10px 0 0;
  font-size: 15px;
  line-height: 1.7;
  color: var(--aw-ink-muted-64);
}
.wl-pillar__list {
  margin: 20px 0 0;
  padding: 18px 0 0;
  list-style: none;
  border-top: 1px solid var(--aw-divider);
  display: grid;
  gap: 10px;
}
.wl-pillar__list li {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--aw-ink);
}
.wl-pillar__list .el-icon {
  flex: none;
  color: var(--aw-primary);
}

/* ---------- 示意小图 ---------- */
.wl-mock {
  position: relative;
  z-index: 1;
  width: min(84%, 300px);
  padding: 14px;
  border-radius: 14px;
  background: var(--aw-surface);
  border: 1px solid var(--aw-divider);
  box-shadow: 0 18px 40px -20px rgba(0, 0, 0, 0.28);
  font-size: 12px;
  color: var(--aw-ink);
}
.wl-mock__avatars {
  display: flex;
  align-items: center;
}
.wl-mock__avatars span {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  margin-left: -8px;
  border-radius: 50%;
  border: 2px solid var(--aw-surface);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
}
.wl-mock__avatars span:first-child {
  margin-left: 0;
}
.wl-mock__avatars .wl-mock__avatars-more {
  background: var(--aw-canvas-parchment);
  color: var(--aw-ink-muted-64);
  font-size: 11px;
}
.wl-mock__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 12px;
}
.wl-mock__chips span {
  padding: 3px 9px;
  border-radius: var(--aw-radius-pill);
  background: var(--aw-canvas-parchment);
  color: var(--aw-ink-muted-64);
  font-size: 11.5px;
}
.wl-mock__chips .is-active {
  background: rgba(var(--aw-accent-rgb), 0.12);
  color: var(--aw-primary);
  font-weight: 500;
}
.wl-mock__meter {
  margin-top: 14px;
}
.wl-mock__meter-row {
  display: flex;
  justify-content: space-between;
  color: var(--aw-ink-muted-64);
}
.wl-mock__meter-row b {
  color: var(--aw-ink);
  font-weight: 600;
}
.wl-mock__meter-bar {
  height: 6px;
  margin-top: 6px;
  border-radius: 3px;
  background: var(--aw-canvas-parchment);
  overflow: hidden;
}
.wl-mock__meter-bar i {
  display: block;
  width: 62%;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, rgba(var(--aw-accent-rgb), 0.55), var(--aw-primary));
}
.wl-mock__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--aw-divider);
}
.wl-mock__badge {
  padding: 2px 7px;
  border-radius: 6px;
  background: rgba(var(--aw-accent-rgb), 0.12);
  color: var(--aw-primary);
  font-family: var(--aw-font-mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
}
.wl-mock__head-title {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wl-mock__steps {
  display: grid;
  gap: 8px;
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
}
.wl-mock__steps li {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--aw-ink-muted);
}
.wl-mock__steps li > i {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1.5px solid var(--aw-border);
}
.wl-mock__steps .is-done {
  color: var(--aw-ink-muted-64);
  text-decoration: line-through;
  text-decoration-color: var(--aw-ink-muted-40);
}
.wl-mock__steps .is-done .el-icon {
  color: #34c759;
}
.wl-mock__steps .is-run {
  color: var(--aw-ink);
  font-weight: 500;
}
.wl-mock__steps .is-run .el-icon {
  color: var(--aw-primary);
}
.wl-mock__search {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 10px;
  border-radius: 9px;
  border: 1px solid rgba(var(--aw-accent-rgb), 0.35);
  box-shadow: 0 0 0 3px rgba(var(--aw-accent-rgb), 0.08);
  color: var(--aw-ink);
}
.wl-mock__search .el-icon {
  color: var(--aw-primary);
}
.wl-mock__hit {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px 8px;
  margin-top: 10px;
  padding: 8px 10px;
  border-radius: 9px;
  background: var(--aw-canvas-parchment);
}
.wl-mock__hit.is-dim {
  opacity: 0.6;
}
.wl-mock__hit-tag {
  grid-row: span 2;
  align-self: center;
  padding: 2px 6px;
  border-radius: 5px;
  background: rgba(var(--aw-accent-rgb), 0.12);
  color: var(--aw-primary);
  font-size: 10.5px;
  font-weight: 600;
}
.wl-mock__hit-title {
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wl-mock__hit-meta {
  color: var(--aw-ink-muted);
  font-size: 11px;
}

/* ---------- 工作方式 ---------- */
.wl-flow {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 20px;
  margin: 48px 0 0;
  padding: 0;
  list-style: none;
}
.wl-flow__step {
  position: relative;
  padding: 24px 24px 22px;
  border-radius: var(--aw-radius-lg);
  background: var(--aw-surface);
  border: 1px solid var(--aw-divider);
}
.wl-flow__step:not(:last-child)::after {
  content: '';
  position: absolute;
  top: 40px;
  right: -16px;
  width: 12px;
  height: 12px;
  border-top: 2px solid rgba(var(--aw-accent-rgb), 0.45);
  border-right: 2px solid rgba(var(--aw-accent-rgb), 0.45);
  transform: rotate(45deg);
}
.wl-flow__num {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--aw-radius-pill);
  background: var(--aw-primary);
  color: var(--aw-on-primary);
  font-family: var(--aw-font-display);
  font-size: 14px;
  font-weight: 600;
}
.wl-flow__step h3 {
  margin: 16px 0 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--aw-ink);
}
.wl-flow__step p {
  margin: 8px 0 0;
  font-size: 14.5px;
  line-height: 1.7;
  color: var(--aw-ink-muted-64);
}

/* ---------- 渠道枢纽图 ---------- */
.wl-hub {
  --wl-hub-link: 56px;
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(220px, 260px) minmax(0, 1fr);
  grid-template-areas: 'in core out';
  margin-top: 20px;
  padding: 36px 32px;
  border-radius: calc(var(--aw-radius-lg) + 6px);
  background: var(--aw-surface);
  border: 1px solid var(--aw-divider);
  overflow: hidden;
}
.wl-hub::before {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(rgba(var(--aw-accent-rgb), 0.18) 1px, transparent 1.2px) 0 0 / 18px 18px;
  -webkit-mask-image: radial-gradient(60% 80% at 50% 50%, #000, transparent 75%);
  mask-image: radial-gradient(60% 80% at 50% 50%, #000, transparent 75%);
  pointer-events: none;
}
.wl-hub__side {
  position: relative;
  z-index: 1;
}
.wl-hub__side--in {
  grid-area: in;
  padding-right: var(--wl-hub-link);
}
.wl-hub__side--out {
  grid-area: out;
  padding-left: var(--wl-hub-link);
}
.wl-hub__side-title {
  margin: 0 0 12px;
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--aw-ink-muted);
}
.wl-hub__list {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.wl-channel {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 52px;
  padding: 8px 12px 8px 10px;
  border-radius: 13px;
  background: var(--aw-canvas);
  border: 1px solid var(--aw-divider);
  transition: border-color 0.15s ease, transform 0.15s ease;
}
.wl-channel:hover {
  border-color: rgba(var(--aw-accent-rgb), 0.35);
}
.wl-hub__side--in .wl-channel:hover {
  transform: translateX(3px);
}
.wl-hub__side--out .wl-channel:hover {
  transform: translateX(-3px);
}
.wl-hub__side .wl-channel::after {
  content: '';
  position: absolute;
  top: 50%;
  width: var(--wl-hub-link);
  height: 2px;
  margin-top: -1px;
  background: repeating-linear-gradient(90deg, rgba(var(--aw-accent-rgb), 0.5) 0 6px, transparent 6px 12px);
  background-size: 24px 2px;
  animation: wl-dash 1.4s linear infinite;
}
.wl-hub__side--in .wl-channel::after {
  left: 100%;
}
.wl-hub__side--out .wl-channel::after {
  right: 100%;
}
@keyframes wl-dash {
  to {
    background-position: 24px 0;
  }
}
.wl-hub__core {
  grid-area: core;
  position: relative;
  z-index: 1;
  display: flex;
  padding-top: 26px;
}
.wl-hub__core::before {
  content: '';
  position: absolute;
  inset: 10% -20%;
  background: radial-gradient(50% 50% at 50% 50%, rgba(var(--aw-accent-rgb), 0.28), transparent 70%);
  filter: blur(24px);
  pointer-events: none;
}
.wl-hub__core-card {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 28px 22px;
  border-radius: 22px;
  background: var(--aw-surface);
  border: 1px solid rgba(var(--aw-accent-rgb), 0.3);
  box-shadow:
    0 0 0 6px rgba(var(--aw-accent-rgb), 0.06),
    0 24px 50px -24px rgba(var(--aw-accent-rgb), 0.55);
  text-align: center;
}
.wl-hub__core-logo {
  display: inline-flex;
  padding: 6px;
  border-radius: 20px;
  background: linear-gradient(140deg, rgba(var(--aw-accent-rgb), 0.25), rgba(var(--aw-accent-rgb), 0.05));
}
.wl-hub__core-logo img {
  width: 60px;
  height: 60px;
  border-radius: 15px;
}
.wl-hub__core-name {
  margin: 14px 0 0;
  font-family: var(--aw-font-display);
  font-size: 22px;
  font-weight: 700;
  color: var(--aw-ink);
}
.wl-hub__core-tag {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--aw-ink-muted);
}
.wl-hub__core-list {
  display: grid;
  gap: 8px;
  width: 100%;
  margin: 20px 0 0;
  padding: 0;
  list-style: none;
}
.wl-hub__core-list li {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 36px;
  border-radius: 10px;
  background: rgba(var(--aw-accent-rgb), 0.08);
  color: var(--aw-ink);
  font-size: 13.5px;
  font-weight: 500;
}
.wl-hub__core-list .el-icon {
  color: var(--aw-primary);
}
.wl-channel__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 32px;
  height: 32px;
  border-radius: 9px;
  background: var(--aw-canvas-parchment);
  border: 1px solid var(--aw-divider);
  color: var(--aw-ink);
}
.wl-channel__icon img {
  width: 18px;
  height: 18px;
  object-fit: contain;
}
.wl-channel__glyph {
  font-family: var(--aw-font-mono);
  font-size: 11px;
  font-weight: 700;
}
.wl-channel__text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.wl-channel__name {
  font-size: 14px;
  font-weight: 600;
  color: var(--aw-ink);
}
.wl-channel__desc {
  margin-top: 1px;
  font-size: 12.5px;
  color: var(--aw-ink-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wl-channels__more {
  margin: 22px 0 0;
  font-size: 14px;
  line-height: 1.7;
  color: var(--aw-ink-muted-64);
}

/* ---------- 部署 ---------- */
.wl-start {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 56px;
  align-items: center;
}
.wl-checklist {
  display: grid;
  gap: 14px;
  margin: 28px 0 0;
  padding: 0;
  list-style: none;
}
.wl-checklist li {
  display: flex;
  align-items: flex-start;
  gap: 14px;
}
.wl-checklist__num {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 26px;
  height: 26px;
  margin-top: 1px;
  border-radius: var(--aw-radius-pill);
  background: rgba(var(--aw-accent-rgb), 0.1);
  color: var(--aw-primary);
  font-size: 13px;
  font-weight: 600;
}
.wl-checklist strong {
  display: block;
  font-size: 15px;
  font-weight: 600;
  color: var(--aw-ink);
}
.wl-checklist span:not(.wl-checklist__num) {
  display: block;
  margin-top: 2px;
  font-size: 14px;
  line-height: 1.6;
  color: var(--aw-ink-muted-64);
}
.wl-start__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px 20px;
  margin-top: 32px;
}

.wl-term {
  border-radius: var(--aw-radius-lg);
  background: #17171b;
  border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow:
    0 30px 80px -34px rgba(var(--aw-accent-rgb), 0.6),
    0 24px 60px -28px rgba(0, 0, 0, 0.55);
  overflow: hidden;
}
.wl-term__bar {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 42px;
  padding: 0 10px 0 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.wl-term__dots {
  display: inline-flex;
  gap: 7px;
}
.wl-term__dots i {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: #ff5f57;
}
.wl-term__dots i:nth-child(2) {
  background: #febc2e;
}
.wl-term__dots i:nth-child(3) {
  background: #28c840;
}
.wl-term__title {
  flex: 1;
  font-size: 12.5px;
  color: #8e8e93;
}
.wl-term__copy {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: #a1a1a6;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.wl-term__copy:hover {
  background: rgba(255, 255, 255, 0.08);
  color: #f5f5f7;
}
.wl-term__body {
  margin: 0;
  padding: 18px 20px 22px;
  overflow-x: auto;
  font-family: var(--aw-font-mono);
  font-size: 13px;
  line-height: 1.85;
}
.wl-term__body code {
  font: inherit;
}
.wl-term__cmd {
  color: #e5e5ea;
}
.wl-term__comment {
  color: #6e6e76;
}

/* ---------- 页脚 ---------- */
.wl-footer {
  border-top: 1px solid var(--aw-divider);
  padding: 36px 24px 40px;
}
.wl-footer__inner {
  max-width: 1160px;
  margin: 0 auto;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px 24px;
}
.wl-footer__brand {
  display: flex;
  align-items: center;
  gap: 10px;
}
.wl-footer__name {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--aw-ink);
}
.wl-footer__tag {
  margin: 2px 0 0;
  font-size: 12.5px;
  color: var(--aw-ink-muted);
}
.wl-footer__links {
  display: flex;
  flex-wrap: wrap;
  gap: 22px;
  margin-left: auto;
}
.wl-footer__links a {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--aw-ink-muted-64);
  font-size: 13.5px;
  text-decoration: none;
}
.wl-footer__links a:hover {
  color: var(--aw-ink);
}
.wl-footer__copy {
  width: 100%;
  margin: 0;
  font-size: 12.5px;
  color: var(--aw-ink-muted);
}

/* ---------- 动效 ---------- */
.wl-enter {
  animation: wl-fade-up 0.6s ease both;
}
.wl-hero__title.wl-enter {
  animation-delay: 0.05s;
}
.wl-hero__lead.wl-enter {
  animation-delay: 0.1s;
}
.wl-hero__cta.wl-enter {
  animation-delay: 0.15s;
}
.wl-hero__visual.wl-enter {
  animation-delay: 0.22s;
}
@keyframes wl-fade-up {
  from {
    opacity: 0;
    transform: translateY(16px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.wl-animate .reveal {
  opacity: 0;
  transform: translateY(18px);
  transition: opacity 0.55s ease, transform 0.55s ease;
}
.wl-animate .reveal.reveal--in {
  opacity: 1;
  transform: none;
}
@media (prefers-reduced-motion: reduce) {
  .wl-enter,
  .wl-hub__side .wl-channel::after {
    animation: none;
  }
  .wl-btn:hover,
  .wl-hub__side .wl-channel:hover {
    transform: none;
  }
}

/* ---------- 响应式 ---------- */
@media (max-width: 1024px) {
  .wl-pillars,
  .wl-flow,
  .wl-start {
    grid-template-columns: 1fr;
  }
  .wl-hub {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    grid-template-areas:
      'core core'
      'in out';
    gap: 28px 20px;
    padding: 28px 20px;
  }
  .wl-hub__side--in,
  .wl-hub__side--out {
    padding: 0;
  }
  .wl-hub__side .wl-channel::after {
    display: none;
  }
  .wl-hub__core {
    padding-top: 0;
    justify-content: center;
  }
  .wl-hub__core-card {
    flex: 0 1 320px;
  }
  .wl-flow__step:not(:last-child)::after {
    display: none;
  }
  .wl-start {
    gap: 40px;
  }
}
@media (max-width: 760px) {
  .wl-nav__inner {
    gap: 12px;
    padding: 0 16px;
  }
  .wl-nav__links {
    display: none;
  }
  .wl-nav__actions {
    margin-left: auto;
    gap: 8px;
  }
  .wl-nav__github-text {
    display: none;
  }
  .wl-nav__github {
    width: 32px;
    height: 32px;
    justify-content: center;
  }
  .wl-hero {
    padding: 52px 20px 24px;
  }
  .wl-hero__inner {
    margin-bottom: 40px;
  }
  .wl-hero__lead {
    font-size: 16px;
  }
  .wl-hero__cta .wl-btn {
    width: 100%;
  }
  .wl-shot {
    padding: 5px;
  }
  .wl-shot__img {
    aspect-ratio: 4 / 3;
    object-fit: cover;
    object-position: left top;
  }
  .wl-section {
    padding: 72px 20px;
  }
  .wl-term__body {
    font-size: 12px;
  }
  .wl-hub {
    grid-template-columns: 1fr;
    grid-template-areas:
      'core'
      'in'
      'out';
  }
  .wl-band {
    padding: 0 16px 72px;
  }
  .wl-band__inner {
    padding: 48px 20px;
    border-radius: 22px;
  }
  .wl-band__cta .wl-btn {
    width: 100%;
  }
  .wl-footer__links {
    margin-left: 0;
  }
}
</style>
