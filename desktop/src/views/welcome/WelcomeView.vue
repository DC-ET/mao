<template>
  <div class="welcome-page">
    <!-- 顶部导航 -->
    <header class="wl-nav" :class="{ 'wl-nav--scrolled': scrolled }">
      <div class="wl-nav__inner">
        <a class="wl-brand" href="#top" @click.prevent="scrollToSection('top')">
          <img :src="appIcon" alt="" class="wl-brand__logo" />
          <span class="wl-brand__name">Mao</span>
        </a>
        <nav class="wl-nav__links" aria-label="页面导航">
          <a href="#why" @click.prevent="scrollToSection('why')">为什么选 Mao</a>
          <a href="#features" @click.prevent="scrollToSection('features')">核心能力</a>
          <a href="#channels" @click.prevent="scrollToSection('channels')">多端接入</a>
          <a href="#start" @click.prevent="scrollToSection('start')">快速开始</a>
        </nav>
        <div class="wl-nav__actions">
          <a
            class="wl-nav__github"
            href="https://github.com/DC-ET/mao"
            target="_blank"
            rel="noopener noreferrer"
          ><GitHubMark />GitHub</a>
          <button class="wl-btn wl-btn--primary wl-btn--sm" type="button" @click="goDocs()">
            官方文档
          </button>
        </div>
      </div>
    </header>

    <!-- Hero -->
    <section id="top" class="wl-hero">
      <div class="wl-hero__glow" aria-hidden="true" />
      <div class="wl-hero__inner">
        <p class="wl-hero__eyebrow reveal">MIT 开源 · 私有化部署 · 数据自持</p>
        <h1 class="wl-hero__title reveal">
          团队级 AI Agent<br />自托管平台
        </h1>
        <p class="wl-hero__lead reveal">
          一次部署，全员共用。在服务端集中配置模型、工具与岗位智能体，
          团队成员打开浏览器、手机、终端或办公软件即可直接工作，
          会话、操作与成本全量落库。
        </p>
        <div class="wl-hero__cta reveal">
          <button class="wl-btn wl-btn--primary" type="button" @click="goDocs()">
            浏览官方文档
          </button>
          <a
            class="wl-btn wl-btn--ghost"
            href="https://github.com/DC-ET/mao"
            target="_blank"
            rel="noopener noreferrer"
          >
            <GitHubMark />GitHub 仓库
          </a>
        </div>
        <ul class="wl-hero__badges reveal" aria-label="产品要点">
          <li>一次部署全员共用</li>
          <li>容器级运行隔离</li>
          <li>全量留痕与成本治理</li>
        </ul>
      </div>
      <div class="wl-hero__shot reveal">
        <div class="wl-shot">
          <div class="wl-shot__bar" aria-hidden="true">
            <span /><span /><span />
          </div>
          <img :src="heroShot" alt="Mao 工作台界面" class="wl-shot__img" />
        </div>
      </div>
    </section>

    <!-- 为什么选 Mao -->
    <section id="why" class="wl-section wl-section--tint">
      <div class="wl-section__inner">
        <h2 class="wl-section__title reveal">把 Agent 当作团队基础设施</h2>
        <p class="wl-section__subtitle reveal">
          大多数 Agent 工具是为个人设计的：装在各自电脑上，密钥散落，换台设备就得从头配起。
          Mao 反过来，从第一天就是为团队而建。
        </p>
        <div class="wl-why reveal">
          <article class="wl-why__card">
            <h3>一次部署，全员共用</h3>
            <p>统一管理模型 API Key、账号与 RBAC 权限。成员开箱即用，对本地电脑零配置要求。</p>
          </article>
          <article class="wl-why__card">
            <h3>按岗位定义智能体</h3>
            <p>为研发、运维、客服、数据分析分别构建智能体，独立绑定提示词、Skill 技能包、MCP 与 HTTP 工具。</p>
          </article>
          <article class="wl-why__card">
            <h3>经验随岗位沉淀</h3>
            <p>智能体解决复杂问题后自动归档排障路径与领域知识，人员流动不带走岗位经验。</p>
          </article>
        </div>
      </div>
    </section>

    <!-- 核心能力 -->
    <section id="features" class="wl-section">
      <div class="wl-section__inner">
        <h2 class="wl-section__title reveal">核心能力</h2>
        <p class="wl-section__subtitle reveal">从模型接入到成本治理，覆盖团队落地 Agent 的完整链路。</p>
        <div class="wl-grid reveal">
          <article v-for="f in features" :key="f.title" class="wl-card">
            <span class="wl-card__icon" aria-hidden="true">
              <el-icon :size="22"><component :is="f.icon" /></el-icon>
            </span>
            <h3 class="wl-card__title">{{ f.title }}</h3>
            <p class="wl-card__desc">{{ f.desc }}</p>
          </article>
        </div>
      </div>
    </section>

    <!-- 多端接入 -->
    <section id="channels" class="wl-section wl-section--tint">
      <div class="wl-section__inner">
        <h2 class="wl-section__title reveal">一套服务端，随处触达</h2>
        <p class="wl-section__subtitle reveal">同一批智能体，按场景选择入口，免安装、免配置。</p>
        <div class="wl-channels reveal">
          <article v-for="c in channels" :key="c.name" class="wl-channel">
            <span class="wl-channel__icon">
              <img v-if="c.logo" :src="c.logo" alt="" />
              <span v-else-if="c.glyph" class="wl-channel__glyph">{{ c.glyph }}</span>
              <el-icon v-else :size="20"><component :is="c.icon" /></el-icon>
            </span>
            <h3 class="wl-channel__name">{{ c.name }}</h3>
            <p class="wl-channel__desc">{{ c.desc }}</p>
          </article>
        </div>
      </div>
    </section>

    <!-- 快速开始 -->
    <section id="start" class="wl-section">
      <div class="wl-section__inner">
        <h2 class="wl-section__title reveal">快速开始</h2>
        <p class="wl-section__subtitle reveal">环境要求：Node.js 22+、MySQL 8.x，以及编译 node-pty 所需的 C/C++ 工具链。</p>
        <div class="wl-start reveal">
          <div class="wl-start__col">
            <h3>本地开发</h3>
            <pre class="wl-code"><code>git clone https://github.com/DC-ET/mao.git
cd mao

cd backend-ts &amp;&amp; npm install &amp;&amp; npm run start:dev   # API &amp; WS (:9080)
cd admin &amp;&amp; npm install &amp;&amp; npm run dev              # 管理后台 (:5200/admin/)
cd desktop &amp;&amp; npm install &amp;&amp; npm run dev            # 工作台 (:5201)</code></pre>
          </div>
          <div class="wl-start__col">
            <h3>生产部署</h3>
            <ol class="wl-steps">
              <li>准备 Linux、Node.js 22+、Nginx、MySQL 8（容器隔离另需 Docker）。</li>
              <li>构建 <code>backend-ts</code>、<code>admin</code>、<code>desktop</code>，配置后端环境变量。</li>
              <li>启动后端服务，配置 Nginx 反向代理与 HTTPS。</li>
              <li>访问 <code>/admin/</code> 完成初始管理员密码与模型 API Key 配置。</li>
            </ol>
            <div class="wl-start__links">
              <a href="/docs/deploy" @click.prevent="goDocs('deploy')">部署手册</a>
              <a href="/docs/install" @click.prevent="goDocs('install')">安装指南</a>
              <a href="/docs" @click.prevent="goDocs()">用户手册</a>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 页脚 -->
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
          <a href="/docs/deploy" @click.prevent="goDocs('deploy')">私有化部署</a>
          <a href="/docs" @click.prevent="goDocs()">用户手册</a>
        </nav>
        <p class="wl-footer__copy">© 2026 Mao · MIT License</p>
      </div>
    </footer>
  </div>
</template>
<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import type { Component } from 'vue'
import { useRouter } from 'vue-router'
import {
  Aim, Box, Collection, Cpu, Iphone, Key, Link, Monitor, Money, Platform, Timer
} from '@element-plus/icons-vue'
import appIcon from '../../assets/app-icon-small.png'
import heroShot from '../../assets/welcome-hero.jpg'
import GitHubMark from '../../components/common/GitHubMark.vue'
import feishuLogo from '../../assets/feishu-logo.svg'
import dingtalkLogo from '../../assets/dingtalk-logo.svg'
import weixinLogo from '../../assets/weixin-logo.png'

const router = useRouter()

const features = [
  {
    icon: Key,
    title: '一次部署，全员共用',
    desc: '统一管理模型 API Key、账号与 RBAC 权限，成员开箱即用，对本地电脑零配置要求。'
  },
  {
    icon: Aim,
    title: '按岗位定义智能体',
    desc: '系统提示词支持版本回滚，Skill 技能包、MCP 与 HTTP 工具按岗位独立绑定。'
  },
  {
    icon: Monitor,
    title: '全终端与 IM 原生触达',
    desc: 'Web、桌面端、移动端、CLI、飞书、钉钉、微信及内部网页浮窗，同一批智能体直接工作。'
  },
  {
    icon: Box,
    title: '容器级运行隔离',
    desc: 'Docker 容器运行时将云端 Shell、文件读写与进程隔离在独立容器，严格划分用户与 Agent 的数据边界。'
  },
  {
    icon: Collection,
    title: '岗位级经验沉淀',
    desc: '内置团队经验库，解决复杂问题后自动归档排障路径与领域知识，后续任务先检索再执行。'
  },
  {
    icon: Money,
    title: '全量留痕与成本治理',
    desc: '完整记录会话轨迹、模型调用流水与审计日志，支持多维度成本核算与月度预算拦截。'
  },
  {
    icon: Cpu,
    title: '云端与本机双执行边界',
    desc: '日常任务云端即开即用；需要读写本机代码库时切换 LOCAL 模式，配套五档权限与高危操作审批。'
  },
  {
    icon: Timer,
    title: '主动触发与系统集成',
    desc: 'Cron 定时任务、监听外部接口异动的信号哨兵，以及 Open API 与 Webhook。'
  }
]

type Channel = {
  name: string
  desc: string
  icon: Component | null
  logo: string
  glyph?: string
}

const channels: Channel[] = [
  { name: 'Web 工作台', desc: '日常任务、云端工作区、在线终端与 Git', icon: Monitor, logo: '' },
  { name: '飞书', desc: '群聊 @ 协同或私聊交办，流式进度卡片', icon: null, logo: feishuLogo },
  { name: '钉钉', desc: '群聊 @ 协同或私聊交办，免安装', icon: null, logo: dingtalkLogo },
  { name: '微信', desc: '公众号对话直接交办任务', icon: null, logo: weixinLogo },
  { name: 'Embed SDK', desc: '一行脚本嵌入内部后台的对话浮窗', icon: Link, logo: '' },
  { name: 'mao-agent CLI', desc: '终端 REPL 与 CI/CD 流水线集成', icon: null, logo: '', glyph: '>_' },
  { name: 'Android', desc: '移动办公、审批与任务跟进', icon: Iphone, logo: '' },
  { name: 'Electron 桌面端', desc: '本机文件读写与图形化工具审批', icon: Platform, logo: '' }
]

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
    desc.setAttribute('content', 'Mao 是团队级 AI Agent 自托管平台：一次部署全员共用，按岗位定义智能体，全终端触达，全量留痕与成本治理。')
  }

  window.addEventListener('scroll', onScroll, { passive: true })
  onScroll()

  if ('IntersectionObserver' in window) {
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('reveal--in')
            observer?.unobserve(entry.target)
          }
        }
      },
      { rootMargin: '0px 0px -8% 0px' }
    )
    document.querySelectorAll('.welcome-page .reveal').forEach((el) => observer?.observe(el))
  } else {
    document.querySelectorAll('.welcome-page .reveal').forEach((el) => el.classList.add('reveal--in'))
  }
})

onUnmounted(() => {
  window.removeEventListener('scroll', onScroll)
  observer?.disconnect()
  observer = null
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
  gap: 22px;
  margin-left: 8px;
  flex: 1;
}
.wl-nav__links a {
  color: var(--aw-ink-muted-64);
  font-size: 14px;
  text-decoration: none;
  transition: color 0.15s ease;
}
.wl-nav__links a:hover {
  color: var(--aw-ink);
}
.wl-nav__actions {
  display: flex;
  align-items: center;
  gap: 16px;
}
.wl-nav__github {
  color: var(--aw-ink-muted-64);
  font-size: 14px;
  text-decoration: none;
  transition: color 0.15s ease;
}
.wl-nav__github:hover {
  color: var(--aw-ink);
}

/* ---------- 按钮 ---------- */
.wl-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 44px;
  padding: 0 26px;
  border-radius: var(--aw-radius-pill);
  border: 1px solid transparent;
  font-size: 15px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  text-decoration: none;
  transition: transform 0.15s ease, background 0.15s ease, border-color 0.15s ease;
}
.wl-btn:hover {
  transform: translateY(-1px);
}
.wl-btn--primary {
  background: var(--aw-primary);
  color: var(--aw-on-primary);
}
.wl-btn--primary:hover {
  background: var(--aw-primary-focus);
}
.wl-btn--ghost {
  background: transparent;
  color: var(--aw-ink);
  border-color: var(--aw-border);
}
.wl-btn--ghost:hover {
  border-color: var(--aw-ink-muted-40);
}
.wl-btn--sm {
  height: 34px;
  padding: 0 16px;
  font-size: 13.5px;
}

/* ---------- Hero ---------- */
.wl-hero {
  position: relative;
  padding: 88px 24px 0;
  overflow: hidden;
}
.wl-hero__glow {
  position: absolute;
  inset: -220px 0 auto;
  height: 640px;
  pointer-events: none;
  background:
    radial-gradient(560px 320px at 28% 42%, rgba(var(--aw-accent-rgb), 0.14), transparent 70%),
    radial-gradient(520px 300px at 72% 30%, rgba(var(--aw-accent-rgb), 0.08), transparent 70%);
}
.wl-hero__inner {
  position: relative;
  max-width: 860px;
  margin: 0 auto;
  text-align: center;
}
.wl-hero__eyebrow {
  display: inline-block;
  margin: 0 0 22px;
  padding: 6px 14px;
  border-radius: var(--aw-radius-pill);
  background: var(--aw-primary-soft);
  color: var(--aw-primary);
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.04em;
}
.wl-hero__title {
  margin: 0;
  font-family: var(--aw-font-display);
  font-size: clamp(42px, 6.4vw, 72px);
  font-weight: 700;
  line-height: 1.12;
  letter-spacing: -0.02em;
  color: var(--aw-ink);
}
.wl-hero__lead {
  margin: 26px auto 0;
  max-width: 620px;
  font-size: 19px;
  line-height: 1.75;
  color: var(--aw-ink-muted-64);
}
.wl-hero__cta {
  display: flex;
  justify-content: center;
  gap: 14px;
  margin-top: 36px;
  flex-wrap: wrap;
}
.wl-hero__badges {
  display: flex;
  justify-content: center;
  gap: 10px 26px;
  margin: 26px 0 0;
  padding: 0;
  list-style: none;
  flex-wrap: wrap;
}
.wl-hero__badges li {
  position: relative;
  padding-left: 18px;
  font-size: 13.5px;
  color: var(--aw-ink-muted);
}
.wl-hero__badges li::before {
  content: '';
  position: absolute;
  left: 0;
  top: 7px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--aw-primary);
  opacity: 0.65;
}
.wl-hero__shot {
  position: relative;
  max-width: 1080px;
  margin: 64px auto 0;
}
.wl-shot {
  border-radius: var(--aw-radius-lg);
  background: var(--aw-surface);
  border: 1px solid var(--aw-divider);
  box-shadow: var(--aw-shadow-product);
  overflow: hidden;
}
.wl-shot__bar {
  display: flex;
  gap: 7px;
  align-items: center;
  height: 38px;
  padding: 0 16px;
  background: var(--aw-surface-pearl);
  border-bottom: 1px solid var(--aw-divider);
}
.wl-shot__bar span {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--aw-surface-chip);
}
.wl-shot__img {
  display: block;
  width: 100%;
  height: auto;
}

/* ---------- 通用 Section ---------- */
.wl-section {
  padding: 104px 24px;
  scroll-margin-top: 60px;
}
.wl-section--tint {
  background: var(--aw-canvas-parchment);
}
.wl-section__inner {
  max-width: 1160px;
  margin: 0 auto;
}
.wl-section__title {
  margin: 0;
  text-align: center;
  font-family: var(--aw-font-display);
  font-size: clamp(30px, 3.6vw, 42px);
  font-weight: 700;
  letter-spacing: -0.015em;
  color: var(--aw-ink);
}
.wl-section__subtitle {
  margin: 18px auto 0;
  max-width: 640px;
  text-align: center;
  font-size: 17px;
  line-height: 1.8;
  color: var(--aw-ink-muted-64);
}

/* ---------- 为什么选 Mao ---------- */
.wl-why {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 20px;
  margin-top: 56px;
}
.wl-why__card {
  padding: 32px 28px;
  border-radius: var(--aw-radius-lg);
  background: var(--aw-surface);
  border: 1px solid var(--aw-divider);
}
.wl-why__card h3 {
  margin: 0 0 12px;
  font-family: var(--aw-font-display);
  font-size: 20px;
  font-weight: 600;
  color: var(--aw-ink);
}
.wl-why__card p {
  margin: 0;
  font-size: 15px;
  line-height: 1.8;
  color: var(--aw-ink-muted-64);
}

/* ---------- 核心能力 ---------- */
.wl-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 20px;
  margin-top: 56px;
}
.wl-card {
  padding: 28px 24px;
  border-radius: var(--aw-radius-lg);
  background: var(--aw-surface);
  border: 1px solid var(--aw-divider);
  transition: transform 0.2s ease, border-color 0.2s ease;
}
.wl-card:hover {
  transform: translateY(-3px);
  border-color: var(--aw-primary-line);
}
.wl-card__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: var(--aw-radius-md);
  background: var(--aw-primary-soft);
  color: var(--aw-primary);
}
.wl-card__title {
  margin: 18px 0 10px;
  font-family: var(--aw-font-display);
  font-size: 17px;
  font-weight: 600;
  color: var(--aw-ink);
}
.wl-card__desc {
  margin: 0;
  font-size: 14px;
  line-height: 1.75;
  color: var(--aw-ink-muted-64);
}

/* ---------- 多端接入 ---------- */
.wl-channels {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 20px;
  margin-top: 56px;
}
.wl-channel {
  padding: 26px 24px;
  border-radius: var(--aw-radius-lg);
  background: var(--aw-surface);
  border: 1px solid var(--aw-divider);
}
.wl-channel__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  border-radius: var(--aw-radius-md);
  background: var(--aw-primary-soft);
  color: var(--aw-primary);
}
.wl-channel__icon img {
  width: 24px;
  height: 24px;
  object-fit: contain;
}
.wl-channel__glyph {
  font-family: var(--aw-font-mono);
  font-size: 15px;
  font-weight: 600;
  color: var(--aw-primary);
}
.wl-channel__name {
  margin: 16px 0 8px;
  font-family: var(--aw-font-display);
  font-size: 16px;
  font-weight: 600;
  color: var(--aw-ink);
}
.wl-channel__desc {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--aw-ink-muted-64);
}

/* ---------- 快速开始 ---------- */
.wl-start {
  display: grid;
  grid-template-columns: 1.15fr 1fr;
  gap: 24px;
  margin-top: 56px;
  align-items: start;
}
.wl-start__col h3 {
  margin: 0 0 16px;
  font-family: var(--aw-font-display);
  font-size: 19px;
  font-weight: 600;
  color: var(--aw-ink);
}
.wl-code {
  margin: 0;
  padding: 22px 24px;
  border-radius: var(--aw-radius-lg);
  background: var(--aw-surface-code);
  border: 1px solid var(--aw-divider);
  overflow-x: auto;
}
.wl-code code {
  font-family: var(--aw-font-mono);
  font-size: 13px;
  line-height: 1.9;
  color: var(--aw-text-code);
  white-space: pre;
}
.wl-steps {
  margin: 0;
  padding-left: 20px;
  font-size: 15px;
  line-height: 2;
  color: var(--aw-ink-muted-64);
}
.wl-steps code {
  font-family: var(--aw-font-mono);
  font-size: 12.5px;
  padding: 2px 7px;
  border-radius: var(--aw-radius-xs);
  background: var(--aw-surface-code);
  color: var(--aw-text-code);
}
.wl-start__links {
  display: flex;
  gap: 22px;
  margin-top: 22px;
}
.wl-start__links a {
  color: var(--aw-primary);
  font-size: 14.5px;
  text-decoration: none;
}
.wl-start__links a:hover {
  text-decoration: underline;
}

/* ---------- 页脚 ---------- */
.wl-footer {
  border-top: 1px solid var(--aw-divider);
  background: var(--aw-canvas-parchment);
}
.wl-footer__inner {
  max-width: 1160px;
  margin: 0 auto;
  padding: 44px 24px;
  display: flex;
  align-items: center;
  gap: 24px;
  flex-wrap: wrap;
}
.wl-footer__brand {
  display: flex;
  align-items: center;
  gap: 12px;
}
.wl-footer__name {
  margin: 0;
  font-family: var(--aw-font-display);
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
  gap: 22px;
  margin-left: auto;
}
.wl-footer__links a {
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

/* ---------- 滚动进场 ---------- */
.reveal {
  opacity: 0;
  transform: translateY(18px);
  transition: opacity 0.55s ease, transform 0.55s ease;
}
.reveal--in {
  opacity: 1;
  transform: none;
}
@media (prefers-reduced-motion: reduce) {
  .reveal {
    opacity: 1;
    transform: none;
    transition: none;
  }
}

/* ---------- 响应式 ---------- */
@media (max-width: 1024px) {
  .wl-grid,
  .wl-channels {
    grid-template-columns: repeat(2, 1fr);
  }
  .wl-why {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 760px) {
  .wl-nav__links {
    display: none;
  }
  .wl-hero {
    padding-top: 56px;
  }
  .wl-hero__lead {
    font-size: 16.5px;
  }
  .wl-section {
    padding: 72px 20px;
  }
  .wl-grid,
  .wl-channels {
    grid-template-columns: 1fr;
  }
  .wl-start {
    grid-template-columns: 1fr;
  }
  .wl-footer__links {
    margin-left: 0;
  }
}
</style>



