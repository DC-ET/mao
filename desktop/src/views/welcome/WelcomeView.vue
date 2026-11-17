<template>
  <div class="welcome-page">
    <header class="wl-nav" :class="{ 'wl-nav--scrolled': scrolled }">
      <div class="wl-nav__inner">
        <a class="wl-brand" href="#top" @click.prevent="scrollToSection('top')">
          <img :src="appIcon" alt="" class="wl-brand__logo" />
          <span class="wl-brand__name">Mao</span>
        </a>
        <nav class="wl-nav__links" aria-label="页面导航">
          <a href="#why" @click.prevent="scrollToSection('why')">团队价值</a>
          <a href="#how" @click.prevent="scrollToSection('how')">如何工作</a>
          <a href="#start" @click.prevent="scrollToSection('start')">开始部署</a>
        </nav>
        <div class="wl-nav__actions">
          <a
            class="wl-nav__github"
            href="https://github.com/DC-ET/mao"
            target="_blank"
            rel="noopener noreferrer"
          ><GitHubMark />GitHub</a>
        </div>
      </div>
    </header>

    <section id="top" class="wl-hero">
      <div class="wl-hero__glow" aria-hidden="true" />
      <div class="wl-hero__inner">
        <p class="wl-hero__eyebrow reveal">MIT 开源 · 私有化部署 · 数据自持</p>
        <h1 class="wl-hero__title reveal">让团队的 AI，不止停在对话里</h1>
        <p class="wl-hero__lead reveal">
          在自托管环境中统一管理团队智能体、权限与岗位经验。
          成员可以从 Web、桌面端、飞书、钉钉、微信等已接入渠道发起任务；
          会话、操作与成本可追溯。上述能力均可在项目文档与源码中查阅。
        </p>
        <div class="wl-hero__cta reveal">
          <button class="wl-btn wl-btn--primary" type="button" @click="goDocs('deploy')">
            开始部署
          </button>
          <button class="wl-btn wl-btn--ghost" type="button" @click="scrollToSection('how')">
            了解工作方式
          </button>
        </div>
      </div>

      <div class="wl-hero__visual reveal">
        <figure class="wl-shot">
          <div class="wl-shot__frame">
            <img :src="heroShot" alt="Mao 工作台界面：左侧任务列表，中间会话，右侧任务与工作区信息" class="wl-shot__img" />
          </div>
          <figcaption class="wl-shot__cap">Mao 工作台</figcaption>
        </figure>
      </div>
    </section>

    <section id="why" class="wl-section">
      <div class="wl-section__inner">
        <h2 class="wl-section__title reveal">把 Agent 做成团队的基础设施</h2>
        <p class="wl-section__subtitle reveal">
          多数 Agent 工具是为个人电脑设计的。Mao 从一开始就按团队合作来建：先部署一次，再让全员在同一套规则下使用。
        </p>
        <div class="wl-pillars reveal">
          <article class="wl-pillar">
            <span class="wl-pillar__index">01</span>
            <h3>团队共用</h3>
            <p>统一管理模型 API Key、账号与 RBAC 权限。成员开箱即用，对本地电脑没有额外运行环境要求。</p>
          </article>
          <article class="wl-pillar">
            <span class="wl-pillar__index">02</span>
            <h3>执行任务</h3>
            <p>不只是对话。日常任务可在云端执行；需要读写本机代码库时，可切换到 LOCAL 模式。支持容器隔离、定时任务、信号哨兵与 Open API。</p>
          </article>
          <article class="wl-pillar">
            <span class="wl-pillar__index">03</span>
            <h3>经验沉淀</h3>
            <p>内置团队经验库。智能体在解决复杂问题后，可归档排障路径与领域知识，后续任务先检索再执行。</p>
          </article>
        </div>
      </div>
    </section>

    <section id="how" class="wl-section wl-section--tint">
      <div class="wl-section__inner">
        <h2 class="wl-section__title reveal">同一套智能体，从常用渠道发起</h2>
        <p class="wl-section__subtitle reveal">
          一次配置，可按场景选择入口。工作台供团队内部使用，不作为本页对外入口。
        </p>
        <ul class="wl-channels reveal">
          <li v-for="c in channels" :key="c.name" class="wl-channel">
            <span class="wl-channel__icon" aria-hidden="true">
              <img v-if="c.logo" :src="c.logo" alt="" />
              <span v-else-if="c.glyph" class="wl-channel__glyph">{{ c.glyph }}</span>
              <el-icon v-else :size="16"><component :is="c.icon" /></el-icon>
            </span>
            <span class="wl-channel__name">{{ c.name }}</span>
          </li>
        </ul>
        <p class="wl-channels__more reveal">
          也可通过 Embed SDK 嵌入内部后台，或用 mao-agent CLI 接入终端与流水线。
          <button class="wl-text-btn" type="button" @click="goDocs()">查阅官方文档</button>
        </p>
      </div>
    </section>

    <section id="start" class="wl-section">
      <div class="wl-section__inner wl-start">
        <div class="wl-start__intro reveal">
          <h2 class="wl-section__title">从生产部署开始</h2>
          <p class="wl-section__subtitle">
            准备 Linux、Node.js 22+、Nginx 与 MySQL 8。如需容器隔离，另需安装 Docker 并构建运行时镜像。详细步骤见部署手册。
          </p>
          <div class="wl-start__actions">
            <button class="wl-btn wl-btn--primary" type="button" @click="goDocs('deploy')">
              阅读部署手册
            </button>
            <button class="wl-text-btn" type="button" @click="goDocs('install')">
              本地开发请看安装指南
            </button>
          </div>
        </div>
        <ol class="wl-steps reveal">
          <li>准备服务器与依赖环境，需要隔离运行时再安装 Docker。</li>
          <li>构建 <code>backend-ts</code>、<code>admin</code>、<code>desktop</code>，并配置后端环境变量。</li>
          <li>启动后端服务，配置 Nginx 反向代理与 HTTPS。</li>
          <li>打开 <code>/admin/</code>，完成管理员密码与模型 API Key 的初始配置。</li>
        </ol>
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
import { onMounted, onUnmounted, ref } from 'vue'
import type { Component } from 'vue'
import { useRouter } from 'vue-router'
import { Iphone, Link, Monitor, Platform } from '@element-plus/icons-vue'
import appIcon from '../../assets/app-icon-small.png'
import heroShot from '../../assets/welcome-hero.jpg'
import GitHubMark from '../../components/common/GitHubMark.vue'
import feishuLogo from '../../assets/feishu-logo.svg'
import dingtalkLogo from '../../assets/dingtalk-logo.svg'
import weixinLogo from '../../assets/weixin-logo.png'

const router = useRouter()

type Channel = {
  name: string
  icon: Component | null
  logo: string
  glyph?: string
}

const channels: Channel[] = [
  { name: 'Web 工作台', icon: Monitor, logo: '' },
  { name: '飞书', icon: null, logo: feishuLogo },
  { name: '钉钉', icon: null, logo: dingtalkLogo },
  { name: '微信', icon: null, logo: weixinLogo },
  { name: 'Embed SDK', icon: Link, logo: '' },
  { name: 'CLI', icon: null, logo: '', glyph: '>_' },
  { name: 'Android', icon: Iphone, logo: '' },
  { name: 'Electron', icon: Platform, logo: '' }
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
    desc.setAttribute(
      'content',
      'Mao 是团队级 AI Agent 自托管平台：统一管理团队智能体、权限与岗位经验，从已接入渠道发起任务。'
    )
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
.wl-nav__actions {
  display: flex;
  align-items: center;
  gap: 16px;
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
  padding: 72px 24px 24px;
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
  max-width: 820px;
  margin: 0 auto 48px;
  text-align: center;
}
.wl-hero__eyebrow {
  display: inline-block;
  margin: 0 0 20px;
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
  font-size: clamp(36px, 5.6vw, 64px);
  font-weight: 700;
  line-height: 1.18;
  letter-spacing: -0.02em;
  color: var(--aw-ink);
}
.wl-hero__lead {
  margin: 20px auto 0;
  max-width: 640px;
  font-size: 17px;
  line-height: 1.7;
  color: var(--aw-ink-muted-64);
}
.wl-hero__cta {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 32px;
}
.wl-hero__visual {
  position: relative;
  max-width: 1160px;
  margin: 0 auto;
}

/* ---------- 产品截图 ---------- */
.wl-shot {
  margin: 0;
}
.wl-shot__frame {
  border-radius: var(--aw-radius-lg);
  background: var(--aw-surface);
  border: 1px solid var(--aw-divider);
  box-shadow: var(--aw-shadow-product);
  overflow: hidden;
}
.wl-shot__img {
  display: block;
  width: 100%;
  height: auto;
}
.wl-shot__cap {
  margin: 10px 2px 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--aw-ink-muted);
}

/* ---------- 通用 Section ---------- */
.wl-section {
  padding: 88px 24px;
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
  font-family: var(--aw-font-display);
  font-size: clamp(28px, 3.4vw, 40px);
  font-weight: 650;
  letter-spacing: -0.02em;
  line-height: 1.25;
  color: var(--aw-ink);
}
.wl-section__subtitle {
  margin: 14px 0 0;
  max-width: 640px;
  font-size: 16.5px;
  line-height: 1.7;
  color: var(--aw-ink-muted-64);
}

/* ---------- 三条主线 ---------- */
.wl-pillars {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 20px;
  margin-top: 40px;
}
.wl-pillar {
  padding: 24px 24px 22px;
  border-radius: var(--aw-radius-lg);
  background: var(--aw-surface);
  border: 1px solid var(--aw-divider);
}
.wl-pillar__index {
  display: block;
  margin-bottom: 16px;
  font-family: var(--aw-font-display);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.06em;
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

/* ---------- 渠道标签 ---------- */
.wl-channels {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 32px 0 0;
  padding: 0;
  list-style: none;
}
.wl-channel {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 14px 0 10px;
  border-radius: var(--aw-radius-pill);
  background: var(--aw-surface);
  border: 1px solid var(--aw-divider);
}
.wl-channel__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
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
  font-weight: 600;
}
.wl-channel__name {
  font-size: 13.5px;
  font-weight: 500;
  color: var(--aw-ink);
}
.wl-channels__more {
  margin: 18px 0 0;
  font-size: 14px;
  line-height: 1.7;
  color: var(--aw-ink-muted-64);
}

/* ---------- 开始部署 ---------- */
.wl-start {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(0, 0.9fr);
  gap: 48px;
  align-items: start;
}
.wl-start .wl-section__title,
.wl-start .wl-section__subtitle {
  max-width: none;
}
.wl-start__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px 20px;
  margin-top: 28px;
}
.wl-steps {
  margin: 0;
  padding: 8px 0 0 22px;
  color: var(--aw-ink);
}
.wl-steps li {
  margin: 0 0 14px;
  padding-left: 6px;
  font-size: 15px;
  line-height: 1.7;
  color: var(--aw-ink-muted-64);
}
.wl-steps li:last-child {
  margin-bottom: 0;
}
.wl-steps code {
  font-family: var(--aw-font-mono);
  font-size: 13px;
  padding: 1px 6px;
  border-radius: var(--aw-radius-xs);
  background: var(--aw-surface-code);
  color: var(--aw-text-code);
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
  .wl-btn:hover {
    transform: none;
  }
}

/* ---------- 响应式 ---------- */
@media (max-width: 1024px) {
  .wl-pillars,
  .wl-start {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 760px) {
  .wl-nav__links {
    display: none;
  }
  .wl-hero {
    padding-top: 48px;
  }
  .wl-hero__lead {
    font-size: 16px;
  }
  .wl-hero__cta .wl-btn {
    width: 100%;
  }
  .wl-section {
    padding: 64px 20px;
  }
  .wl-footer__links {
    margin-left: 0;
  }
}
</style>
