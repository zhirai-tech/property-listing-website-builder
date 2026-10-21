/**
 * 后台单页应用入口：会话检查、hash 路由、导航状态。
 * 刻意不引入任何前端框架与构建步骤，保持「轻量化」与可审计。
 */

import { api, ApiError } from './api.js';
import { mountHelpSlots } from './help.js';
import { toast } from './ui.js';
import { icon } from './icons.js';
import * as properties from './views/properties.js';
import * as propertyEdit from './views/property-edit.js';
import * as pages from './views/pages.js';
import * as reminders from './views/reminders.js';
import * as settings from './views/settings.js';
import * as backup from './views/backup.js';

import { setLocale, t } from './i18n.js';
import { applyI18n } from './ui.js';

const routes = [
  { pattern: /^#\/properties$/, view: properties, nav: 'properties' },
  { pattern: /^#\/properties\/new$/, view: propertyEdit, nav: 'properties', params: () => ({ id: 'new' }) },
  { pattern: /^#\/properties\/([^/]+)$/, view: propertyEdit, nav: 'properties', params: (m) => ({ id: m[1] }) },
  { pattern: /^#\/pages$/, view: pages, nav: 'pages' },
  { pattern: /^#\/reminders$/, view: reminders, nav: 'reminders' },
  { pattern: /^#\/settings$/, view: settings, nav: 'settings' },
  { pattern: /^#\/backup$/, view: backup, nav: 'backup' },
];

const viewNode = document.getElementById('view');
const loginView = document.getElementById('login-view');
const appView = document.getElementById('app');

function showLogin() {
  loginView.classList.remove('hidden');
  appView.classList.add('hidden');
}

function showApp() {
  loginView.classList.add('hidden');
  appView.classList.remove('hidden');
  paintNavIcons();
  applyI18n(document);
}

/**
 * 界面语言在登录后初始化：优先取上次的选择，否则跟随浏览器语言。
 * 注意这只影响**界面文字**；用户登记的房源标题、描述、地址等一律原样显示。
 */
function initLocale() {
  let saved = null;
  try {
    saved = localStorage.getItem('adminLocale');
  } catch {
    /* 隐私模式下忽略 */
  }
  if (!saved) {
    saved = (navigator.language ?? '').toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
  }
  setLocale(saved);
}

/** 把底部标签栏的 data-icon 渲染成内联 SVG（替代原先的表情符号） */
function paintNavIcons() {
  document.querySelectorAll('[data-icon]').forEach((el) => {
    if (el.querySelector('svg')) return;
    const name = el.dataset.icon;
    if (!name) return;
    el.insertAdjacentHTML('afterbegin', icon(name, { size: 22 }));
  });
}

function setNav(name) {
  // 手机底部标签栏与桌面左侧栏都带 data-nav，需要同时高亮
  document.querySelectorAll('[data-nav]').forEach((link) => {
    link.classList.toggle('active', link.dataset.nav === name);
  });
}

async function renderRoute() {
  const hash = window.location.hash || '#/properties';

  for (const route of routes) {
    const match = hash.match(route.pattern);
    if (!match) continue;

    setNav(route.nav);
    viewNode.innerHTML = '<div class="card"><p class="muted">加载中…</p></div>';

    try {
      const params = route.params ? route.params(match) : {};
      await route.view.render(viewNode, params);
      // 视图重绘后统一套一次界面语言，各视图不必自己关心翻译
      applyI18n(document);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        showLogin();
        return;
      }
      viewNode.innerHTML = `<div class="alert error">${error?.message ?? t('页面加载失败')}</div>`;
    }
    return;
  }

  window.location.hash = '#/properties';
}

/** 供各视图在数据变更后刷新当前页 */
export function reload() {
  return renderRoute();
}

window.addEventListener('hashchange', () => void renderRoute());

// 尽早确定界面语言，避免首屏先闪一下中文再变英文
initLocale();

// ---- 登录 ----
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginError.classList.add('hidden');

  const password = document.getElementById('login-password').value;
  const button = loginForm.querySelector('button[type=submit]');
  button.disabled = true;

  try {
    await api.post('/api/admin/login', { password });
    document.getElementById('login-password').value = '';
    showApp();
    await boot();
  } catch (error) {
    loginError.textContent = error?.message ?? '登录失败';
    loginError.classList.remove('hidden');
  } finally {
    button.disabled = false;
  }
});

/** 顶部栏（手机）与侧栏（桌面）各有一个退出按钮，都要绑定 */
async function handleLogout() {
  try {
    await api.post('/api/admin/logout');
  } catch {
    // 忽略退出失败
  }
  showLogin();
}

for (const id of ['logout', 'logout-side']) {
  document.getElementById(id)?.addEventListener('click', () => void handleLogout());
}

async function boot() {
  try {
    const overview = await api.get('/api/admin/overview');
    const name = overview.workspace?.name ?? '';
    for (const id of ['brand-workspace', 'brand-workspace-side']) {
      const node = document.getElementById(id);
      if (node) node.textContent = name;
    }
  } catch {
    // 概览失败不阻塞主流程
  }
  await renderRoute();
}

async function start() {
  try {
    const session = await api.get('/api/admin/session');
    if (session?.authenticated) {
      showApp();
      await boot();
      return;
    }
  } catch {
    // 未登录或服务不可用
  }
  showLogin();
}

mountHelpSlots();
void start();

export { toast };