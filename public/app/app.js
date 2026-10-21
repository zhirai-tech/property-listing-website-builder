/**
 * AI 单网页生成平台 —— 前端。
 *
 * 设计要点：
 *  - **所有安全与额度判定都在服务端**。这里只负责把结论展示出来，
 *    不隐藏按钮来代替权限检查（用户明确要求）。
 *  - **字段编辑器由插件清单驱动**：`/api/platform/plugins` 返回什么字段，
 *    界面就渲染什么控件。平台不需要为每种网页单独写后台。
 *  - 用户数据一律用 textContent 写入，不用 innerHTML 拼接，避免 XSS。
 */

import { ApiError, api, newTaskId } from './api.js';

const $ = (id) => document.getElementById(id);

const state = {
  user: null,
  quota: null,
  plugins: [],
  projects: [],
  current: null,
  currentVersions: [],
  /** 当前项目的照片列表（来自平台媒体接口） */
  currentMedia: [],
  /** 是否正在看回收站 */
  showTrash: false,
  /** 是否正在看示例画廊 */
  showGallery: false,
  /** 画廊数据 */
  examples: [],
  authMode: 'login',
};

/** 媒体在页面上的访问路径；与渲染器保持一致 */
function mediaSrc(item) {
  if (item.storageKey) {
    return `/media/${String(item.storageKey).split('/').map(encodeURIComponent).join('/')}`;
  }
  return item.externalUrl ?? '';
}

function fmtBytes(n) {
  const v = Number(n ?? 0);
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(0)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

let toastTimer = null;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 2600);
}

/** 建元素的小助手：只设文本，不碰 innerHTML */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN', { hour12: false });
}

function fmtNumber(n) {
  return Number(n ?? 0).toLocaleString('zh-CN');
}

/**
 * 在容器里显示一条错误。
 *
 * 【为什么不是 clear(container)】
 * 原先这里是 `clear(container)` —— 直接清空整个容器。而发布失败时传进来的
 * 容器就是**编辑器本身**（renderEditor 里 `const box = $('editor')`），
 * 于是一条错误信息会把字段、按钮、AI 区全部替换掉：
 * 用户看得到「为什么失败」，却没法改、没法重试，只能退回列表重新打开项目。
 *
 * 现在只移除**上一次由本函数插入的**提示，其余内容原样保留。
 * 错误依然醒目，界面也不再被打断。
 */
/**
 * 问号帮助图标。
 *
 * 【为什么说明类文案一律收进这里】
 * 直接把说明铺在页面上，界面会到处是灰字段落：用户要读的**操作**被埋进
 * 注释里，真正想找的信息反而找不到。收进一个 `?` 图标后：
 *   - 默认界面只剩操作本身，干净；
 *   - 需要解释的时机是**用户主动想看**的时候，那时他才点开；
 *   - 文案仍然在（不丢信息），只是不再抢注意力。
 *
 * 这个约定适用于**所有项目**，不只是本项目。
 *
 * 【为什么用点击而不是纯 hover】
 * 触屏设备没有 hover。点击对鼠标和手指都成立，所以以点击为主，
 * 同时保留 hover / focus 让桌面端更快。
 */
function helpTip(text) {
  const wrap = el('span', 'help');
  const btn = el('button', 'help-btn', '?');
  btn.type = 'button';
  btn.setAttribute('aria-label', '说明');
  const tip = el('span', 'help-tip', text);
  wrap.append(btn, tip);

  btn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    // 一次只开一个：同时展开多个会重新变成「到处是说明」
    for (const other of document.querySelectorAll('.help.open')) {
      if (other !== wrap) other.classList.remove('open');
    }
    wrap.classList.toggle('open');
  });
  return wrap;
}

// 点空白处收起
document.addEventListener('click', () => {
  for (const open of document.querySelectorAll('.help.open')) open.classList.remove('open');
});

/**
 * 把页面里 data-help 的挂载点渲染成问号图标。
 *
 * 静态 HTML 里只写文案（data-help="…"），图标由这里统一生成 ——
 * 这样「说明一律收进问号图标」这条规则在静态标记里也成立，
 * 而不是又写死一批可见的说明元素。
 */
function mountHelpSlots(root = document) {
  for (const slot of root.querySelectorAll('.help-slot[data-help]')) {
    if (slot.dataset.mounted === '1') continue;
    slot.dataset.mounted = '1';
    slot.appendChild(helpTip(slot.dataset.help ?? ''));
  }
}

function showError(container, error) {
  for (const old of container.querySelectorAll('.alert.error')) old.remove();
  for (const old of container.querySelectorAll('.hint.error-issues')) old.remove();

  const message = error instanceof ApiError ? error.message : '操作失败，请重试';
  const box = el('div', 'alert error', message);
  container.appendChild(box);
  if (error instanceof ApiError && error.issues?.length) {
    const list = el('ul', 'hint error-issues');
    for (const issue of error.issues) list.appendChild(el('li', null, issue.message ?? String(issue)));
    container.appendChild(list);
  }
  // 让用户能立刻看到提示 —— 编辑器很长时错误可能落在可视区之外
  box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ---------------------------------------------------------------------------
// 额度
// ---------------------------------------------------------------------------

function renderQuota() {
  const card = $('quota-card');
  clear(card);
  const q = state.quota;
  if (!q) return;

  const grid = el('div', 'quota');
  const items = [
    ['Token 额度', `${fmtNumber(q.tokens.used)} / ${fmtNumber(q.tokens.quota)}`, q.tokens.used / Math.max(1, q.tokens.quota)],
    ['生成次数', `${q.generations.used} / ${q.generations.quota}`, q.generations.used / Math.max(1, q.generations.quota)],
    [
      'AI 修改',
      q.revisions.quota === null ? `${q.revisions.used} / 不限` : `${q.revisions.used} / ${q.revisions.quota}`,
      q.revisions.quota === null ? 0 : q.revisions.used / Math.max(1, q.revisions.quota),
    ],
    ['项目数', `${q.projects.used} / ${q.projects.quota}`, q.projects.used / Math.max(1, q.projects.quota)],
  ];

  for (const [k, v, ratio] of items) {
    const item = el('div', 'item');
    item.appendChild(el('span', 'k', k));
    item.appendChild(el('span', 'v', v));
    const bar = el('div', `bar${ratio >= 0.8 ? ' low' : ''}`);
    const fill = el('i');
    fill.style.width = `${Math.min(100, Math.round(ratio * 100))}%`; // 数值宽高不算内联样式策略下的样式表，CSP 允许
    bar.appendChild(fill);
    item.appendChild(bar);
    grid.appendChild(item);
  }
  card.appendChild(grid);

  const note = el('p', 'hint');
  note.append(
    `${q.tier === 'free' ? '免费用户' : `套餐：${q.tier}`}　·　`,
    el('span', null, q.hostingEnabled ? '包含平台在线托管' : '不含平台在线托管'),
    helpTip(
      '免费套餐不含平台在线托管：可以下载网页自行部署，或升级套餐获得公开地址。',
    ),
  );
  card.appendChild(note);
}

// ---------------------------------------------------------------------------
// 项目列表
// ---------------------------------------------------------------------------

function renderProjects() {
  const box = $('project-list');
  clear(box);

  // ---- 示例画廊 ----
  if (state.showGallery) {
    const back = el('button', 'btn ghost small mb', '← 返回我的项目');
    back.addEventListener('click', () => {
      state.showGallery = false;
      void refreshProjects();
    });
    box.appendChild(back);
    // 诚实标注：这些示例是手工整理的，不是模型生成的。
    // 不说清这一点，用户看完示例去生成、结果更差，落差比没有示例更伤信任。
    box.appendChild(
      helpTip(`${state.galleryDisclaimer || '下面是手工整理的样例。'}查看示例不消耗额度；可以先用它做起点，再改成你自己的内容。`),
    );

    const grid = el('div', 'plist');
    for (const ex of state.examples) {
      const card = el('div', 'pcard');
      const frame = el('iframe', 'ex-frame');
      frame.src = `/api/platform/examples/${encodeURIComponent(ex.id)}/preview`;
      frame.loading = 'lazy';
      frame.setAttribute('sandbox', '');
      frame.setAttribute('title', ex.name);
      card.appendChild(frame);

      card.appendChild(el('h3', null, ex.name));
      card.appendChild(el('div', 'meta', ex.summary));
      card.appendChild(el('div', 'meta', ex.highlight));

      // 两个动作是有区别的：
      //   用这个做起点   —— 只建项目、填好描述，用户自己决定什么时候生成
      //   用这段描述生成  —— 立刻真的生成一次，让用户直接看到真实结果
      // 后者才是把「我们能做到这样」变成「你可以自己试试能做到什么」的那个入口。
      const generate = el('button', 'btn small', '用这段描述生成一次');
      generate.addEventListener('click', async () => {
        generate.disabled = true;
        const original = generate.textContent;
        generate.textContent = '生成中…';
        try {
          const res = await api.post('/api/platform/projects', {
            pluginId: 'custom-page',
            title: ex.name,
          });
          state.showGallery = false;
          await refreshProjects();
          await openProject(res.project.id);

          // 必须先把描述填进输入框，否则生成按钮会因为「没有要求」而被前端拦下。
          // 注意：生成完成后编辑器会重绘，输入框会被清空 —— 那是正常的，
          // 因为描述在那一刻已经被用掉了。不要因为「重绘后看着是空的」就把这行删掉，
          // 那会让整个流程失效（实测中确实这样踩过一次）。
          const box2 = document.getElementById('editor')?.querySelector('.ai-box textarea');
          if (box2) {
            box2.value = ex.prompt;
            box2.dispatchEvent(new Event('input', { bubbles: true }));
          }
          const genBtn = [...document.querySelectorAll('#editor .ai-box button')]
            .find((b) => b.textContent.trim() === 'AI 生成');
          genBtn?.click();
        } catch (error) {
          showError(box, error);
        } finally {
          generate.disabled = false;
          generate.textContent = original;
        }
      });
      const actions2 = el('div', 'actions');
      actions2.appendChild(generate);

      const use = el('button', 'btn small primary', '用这个做起点');
      use.addEventListener('click', async () => {
        use.disabled = true;
        try {
          const res = await api.post('/api/platform/projects', {
            pluginId: 'custom-page',
            title: ex.name,
          });
          // 把示例的描述预填成项目内容，用户可以直接改
          await api.patch(`/api/platform/projects/${res.project.id}`, {
            spec: { title: ex.name },
          });
          state.showGallery = false;
          await refreshProjects();
          await openProject(res.project.id);
          const box2 = document.getElementById('editor')?.querySelector('.ai-box textarea');
          if (box2) {
            box2.value = ex.prompt;
            box2.dispatchEvent(new Event('input', { bubbles: true }));
          }
          toast('已建好项目，描述已填好，可以直接生成');
        } catch (error) {
          showError(box, error);
          use.disabled = false;
        }
      });
      actions2.appendChild(use);
      card.appendChild(actions2);
      grid.appendChild(card);
    }
    box.appendChild(grid);
    return;
  }

  // ---- 回收站 ----
  if (state.showTrash) {
    const back = el('button', 'btn ghost small mb', '← 返回我的项目');
    back.addEventListener('click', () => {
      state.showTrash = false;
      void refreshProjects();
    });
    box.appendChild(back);

    if (state.projects.length === 0) {
      box.appendChild(el('p', 'empty', '回收站是空的。'));
      return;
    }

    box.appendChild(
      helpTip('回收站里的项目不占用额度，但仍占用存储。恢复时会重新占用一个项目额度。'),
    );
    const trash = el('div', 'plist');
    for (const project of state.projects) {
      const card = el('div', 'pcard');
      card.appendChild(el('h3', null, project.title));
      card.appendChild(el('div', 'meta', `已于 ${fmtDate(project.updatedAt)} 删除`));

      const restore = el('button', 'btn small primary', '恢复');
      restore.addEventListener('click', async () => {
        restore.disabled = true;
        try {
          const res = await api.post(`/api/platform/projects/${project.id}/restore`);
          state.quota = res.quota ?? state.quota;
          renderQuota();
          toast('项目已恢复');
          await refreshProjects();
        } catch (error) {
          // 额度已满时服务端会拒绝 —— 把服务端的原话显示出来，不要自己编一句
          showError(box, error);
          restore.disabled = false;
        }
      });
      card.appendChild(restore);
      trash.appendChild(card);
    }
    box.appendChild(trash);
    return;
  }

  if (state.projects.length === 0) {
    box.appendChild(el('p', 'empty', '还没有项目。点右上角「+ 新建项目」开始。'));
    return;
  }

  const grid = el('div', 'plist');
  for (const project of state.projects) {
    const card = el('div', 'pcard');
    card.appendChild(el('h3', null, project.title));

    const tags = el('div', 'row');
    tags.appendChild(el('span', `tag${project.status === 'published' ? '' : ' draft'}`,
      project.status === 'published' ? '已发布' : '草稿'));
    card.appendChild(tags);

    card.appendChild(el('div', 'meta', `更新于 ${fmtDate(project.updatedAt)}`));

    // 托管状态与地址。
    // 「我的链接是什么」是用户最需要一眼看到的信息，不能只藏在发布那一刻的响应里。
    if (project.status === 'published' && project.publicUrl) {
      const live = el('div', 'meta live');
      live.textContent = '● 托管中';
      card.appendChild(live);

      const link = el('a', 'meta url');
      link.href = project.publicUrl;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = project.publicUrl;
      card.appendChild(link);

      const copy = el('button', 'btn ghost small', '复制链接');
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(project.publicUrl);
          toast('链接已复制');
        } catch {
          // 剪贴板权限可能被拒（非 https 或用户拒绝）—— 退化成让用户自己选中
          globalThis.prompt('复制这个地址：', project.publicUrl);
        }
      });
      card.appendChild(copy);
    }

    // 免费用户的保存期限 —— 必须在列表上直接看到，而不是等过期了才发现项目没了
    const retention = project.retention;
    if (retention && retention.expiresAt) {
      const note = el('div', `meta${retention.daysLeft <= 2 ? ' warn' : ''}`);
      note.textContent =
        retention.daysLeft > 0
          ? `保存至 ${fmtDate(retention.expiresAt)}（剩 ${retention.daysLeft} 天）`
          : '已到期，将被归档';
      card.appendChild(note);
    } else if (retention && retention.retentionDays === null) {
      card.appendChild(el('div', 'meta', '不限期保存'));
    }

    const actions = el('div', 'actions');
    const open = el('button', 'btn small primary', '打开');
    open.addEventListener('click', () => void openProject(project.id));
    actions.appendChild(open);

    // 删除（归档）。额度按「未归档项目数」计，所以删掉才能再建 ——
    // 界面上必须给出这个出口，否则免费用户建满 1 个之后就没有任何办法了。
    const del = el('button', 'btn small ghost', '删除');
    del.addEventListener('click', async () => {
      if (!globalThis.confirm(`确定删除「${project.title}」？删除后可以再建新项目，数据不会被物理清除。`)) return;
      del.disabled = true;
      try {
        await api.del(`/api/platform/projects/${project.id}`);
        toast('项目已删除');
        await refreshProjects();
        // 额度是按项目数算的，删完要刷新额度条
        state.quota = await api.get('/api/platform/quota');
        renderQuota();
      } catch (error) {
        showError($('project-list'), error);
        del.disabled = false;
      }
    });
    actions.appendChild(del);
    card.appendChild(actions);

    grid.appendChild(card);
  }
  box.appendChild(grid);
}

// ---------------------------------------------------------------------------
// 字段编辑器（由插件清单驱动）
// ---------------------------------------------------------------------------

function buildFieldControl(field, value, onInput) {
  const wrap = el('label', 'field');
  wrap.appendChild(el('span', null, field.label + (field.required ? ' *' : '')));

  let control;
  if (field.kind === 'textarea') {
    control = el('textarea');
    control.value = value ?? '';
    control.maxLength = field.max ?? 2000;
  } else if (field.kind === 'select' && Array.isArray(field.options)) {
    control = el('select');
    const empty = el('option', null, '（未设置）');
    empty.value = '';
    control.appendChild(empty);
    for (const option of field.options) {
      const o = el('option', null, option);
      o.value = option;
      control.appendChild(o);
    }
    control.value = value ?? '';
  } else if (field.kind === 'number' || field.kind === 'money') {
    control = el('input');
    control.type = 'number';
    if (field.kind === 'money') control.step = '0.01';
    control.value = value ?? '';
  } else if (field.kind === 'date') {
    control = el('input');
    control.type = 'date';
    control.value = value ?? '';
  } else {
    control = el('input');
    control.type = 'text';
    control.value = value ?? '';
    if (field.max) control.maxLength = field.max;
  }

  // 照片由下方的照片管理器处理 —— 它不是 spec 里的一个值，
  // 而是媒体表里的多行记录，不能当成普通文本框渲染。
  if (field.kind === 'image' || field.kind === 'images') {
    wrap.appendChild(helpTip('照片在编辑器下方的「照片」区域上传与管理。'));
    return wrap;
  }

  control.addEventListener('input', () => onInput(field.key, control.value));
  control.addEventListener('change', () => onInput(field.key, control.value));
  if (field.hint) control.placeholder = field.hint;
  wrap.appendChild(control);
  return wrap;
}

/**
 * 照片管理区。
 *
 * 上传走平台媒体接口（服务端会做扩展名与 MIME 嗅探、体积上限、张数上限校验），
 * 界面只负责选文件与展示结论 —— 不在前端假装校验一遍。
 */
function buildPhotoSection(project) {
  const card = el('div', 'card');
  card.appendChild(el('h3', null, '照片'));

  const photos = state.currentMedia.filter((m) => m.kind === 'photo');
  // 提示文案必须与渲染器的真实行为一致：
  // 相册按 sort_order 排列；is_cover 只影响 og:image（分享预览图）。
  // 原先写的「第一张自动作为封面」会让人以为改了封面就能改页面首图，是不准确的。
  card.appendChild(
    helpTip(
      `共 ${photos.length} 张，按下面顺序在页面上展示；标 ★ 的那张用作分享预览图。支持 JPG / PNG / WebP。`,
    ),
  );

  if (photos.length > 0) {
    const grid = el('div', 'photos');
    for (const photo of photos) {
      const cell = el('div', 'photo');
      const src = mediaSrc(photo);
      if (src) {
        const img = el('img');
        img.src = src;
        img.alt = photo.originalName || '房源照片';
        img.loading = 'lazy';
        cell.appendChild(img);
      } else {
        cell.appendChild(el('div', 'photo-missing', '无预览'));
      }
      cell.appendChild(
        el('div', 'meta', `${photo.isCover ? '★ ' : ''}${photo.originalName || '照片'} · ${fmtBytes(photo.byteSize)}`),
      );

      // 封面
      const cover = el('button', `btn small${photo.isCover ? '' : ' ghost'}`, photo.isCover ? '已是封面' : '设为封面');
      cover.disabled = photo.isCover;
      cover.addEventListener('click', async () => {
        cover.disabled = true;
        try {
          const res = await api.post(`/api/platform/projects/${project.id}/media/cover`, { mediaId: photo.id });
          state.currentMedia = res.items ?? state.currentMedia;
          renderEditor();
          toast('已设为封面');
        } catch (error) {
          showError(card, error);
          cover.disabled = false;
        }
      });
      cell.appendChild(cover);

      // 顺序：上移 / 下移
      const moveRow = el('div', 'row');
      const index = photos.indexOf(photo);
      const swap = async (delta) => {
        const next = [...photos];
        const target = index + delta;
        if (target < 0 || target >= next.length) return;
        [next[index], next[target]] = [next[target], next[index]];
        try {
          const res = await api.post(`/api/platform/projects/${project.id}/media/reorder`, {
            order: next.map((m) => m.id),
          });
          state.currentMedia = res.items ?? state.currentMedia;
          renderEditor();
        } catch (error) {
          showError(card, error);
        }
      };
      const up = el('button', 'btn ghost small', '↑');
      up.disabled = index === 0;
      up.addEventListener('click', () => void swap(-1));
      const down = el('button', 'btn ghost small', '↓');
      down.disabled = index === photos.length - 1;
      down.addEventListener('click', () => void swap(1));
      moveRow.appendChild(up);
      moveRow.appendChild(down);
      cell.appendChild(moveRow);

      const del = el('button', 'btn ghost small', '删除');
      del.addEventListener('click', async () => {
        del.disabled = true;
        try {
          await api.del(`/api/platform/projects/${project.id}/media/${photo.id}`);
          toast('照片已删除');
          await reloadMedia(project.id);
        } catch (error) {
          showError(card, error);
          del.disabled = false;
        }
      });
      cell.appendChild(del);
      grid.appendChild(cell);
    }
    card.appendChild(grid);
  } else {
    card.appendChild(el('p', 'empty', '还没有照片。'));
  }

  // 上传
  const row = el('div', 'row');
  const input = el('input');
  input.type = 'file';
  input.accept = 'image/jpeg,image/png,image/webp';
  input.id = 'photo-input';
  row.appendChild(input);

  const upload = el('button', 'btn primary small', '上传');
  upload.addEventListener('click', async () => {
    const file = input.files && input.files[0];
    if (!file) {
      toast('请先选择一张图片');
      return;
    }
    upload.disabled = true;
    upload.textContent = '上传中…';
    try {
      const form = new FormData();
      form.append('file', file);
      // 这里不能用 api 封装：multipart 需要浏览器自己带 boundary，
      // 手动设 Content-Type 反而会让服务端解析失败。
      const res = await fetch(`/api/platform/projects/${project.id}/media`, {
        method: 'POST',
        body: form,
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new ApiError(res.status, payload);
      input.value = '';
      toast('照片已上传');
      await reloadMedia(project.id);
    } catch (error) {
      showError(card, error);
    } finally {
      upload.disabled = false;
      upload.textContent = '上传';
    }
  });
  row.appendChild(upload);
  card.appendChild(row);

  return card;
}

/** 重新拉取照片并重绘编辑器 */
async function reloadMedia(projectId) {
  try {
    const res = await api.get(`/api/platform/projects/${projectId}/media`);
    state.currentMedia = res.items ?? [];
  } catch {
    state.currentMedia = [];
  }
  renderEditor();
}

function renderEditor() {
  const box = $('editor');
  clear(box);
  const project = state.current;
  if (!project) return;

  const plugin = state.plugins.find((p) => p.id === project.pluginId);

  // ---- 基本信息 ----
  const info = el('div', 'card');
  const titleField = el('label', 'field');
  titleField.appendChild(el('span', null, '项目标题'));
  const titleInput = el('input');
  titleInput.type = 'text';
  titleInput.value = project.title;
  titleInput.maxLength = 120;
  titleField.appendChild(titleInput);
  info.appendChild(titleField);

  const spec = { ...project.spec };
  const fields = plugin?.fields ?? [];
  if (fields.length === 0) {
    info.appendChild(el('p', 'hint', '该插件没有声明可编辑字段。'));
  }
  for (const field of fields) {
    info.appendChild(buildFieldControl(field, spec[field.key], (key, value) => {
      if (value === '') delete spec[key];
      else spec[key] = value;
    }));
  }

  const saveRow = el('div', 'row');
  const saveBtn = el('button', 'btn primary', '保存草稿');
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      const res = await api.patch(`/api/platform/projects/${project.id}`, {
        title: titleInput.value,
        spec,
      });
      state.current = res.project;
      toast('草稿已保存');
      await refreshProjects();
      $('editor-status').textContent = `草稿已保存 · ${fmtDate(res.project.updatedAt)}`;
    } catch (error) {
      showError(box, error);
    } finally {
      saveBtn.disabled = false;
    }
  });
  saveRow.appendChild(saveBtn);

  // 发布 / 停止托管：按钮随托管状态变化，而不是永远显示「发布」
  const isHosted = project.status === 'published';

  if (isHosted) {
    const stop = el('button', 'btn', '停止托管');
    stop.addEventListener('click', async () => {
      if (!globalThis.confirm('停止托管后，这个地址会立刻打不开（内容与版本都会保留，可以再次发布）。确定吗？')) return;
      stop.disabled = true;
      try {
        const res = await api.post(`/api/platform/projects/${project.id}/unpublish`);
        state.current = res.project;
        toast('已停止托管');
        renderEditor();
        await refreshProjects();
      } catch (error) {
        showError(box, error);
      } finally {
        stop.disabled = false;
      }
    });
    saveRow.appendChild(stop);
  } else {
    const pubBtn = el('button', 'btn primary', '发布到平台托管');
    pubBtn.addEventListener('click', async () => {
      pubBtn.disabled = true;
      try {
        const res = await api.post(`/api/platform/projects/${project.id}/publish`);
        state.current = res.project;
        toast(`已发布版本 v${res.version.versionNo}`);
        renderEditor();
        await refreshProjects();
      } catch (error) {
        // 免费用户会在这里看到「当前套餐不包含平台在线托管」——
        // 这是服务端的原话，比前端自己编一句更准确
        showError(box, error);
      } finally {
        pubBtn.disabled = false;
      }
    });
    saveRow.appendChild(pubBtn);
  }

  // 托管中：把地址摆在编辑器里，并给一个「去看一眼」的入口
  if (isHosted && project.publicSlug) {
    const url = `${location.origin}/s/${project.publicSlug}`;
    const liveRow = el('div', 'row hosted');
    liveRow.appendChild(el('span', 'meta live', '● 托管中'));
    const a = el('a', 'meta url', url);
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    liveRow.appendChild(a);

    const copy2 = el('button', 'btn ghost small', '复制');
    copy2.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(url);
        toast('链接已复制');
      } catch {
        globalThis.prompt('复制这个地址：', url);
      }
    });
    liveRow.appendChild(copy2);

    const look = el('a', 'btn ghost small', '去看一眼');
    look.href = url;
    look.target = '_blank';
    look.rel = 'noopener';
    liveRow.appendChild(look);

    info.appendChild(liveRow);
  } else if (!isHosted) {
    // 未托管：说明清楚「发布」会做什么，以及免费套餐没有这一项
    info.appendChild(
      helpTip(
        '发布后这个页面会有一个可以分享给别人的公开地址。免费套餐不包含平台托管 —— 可以下载网页自行部署。',
      ),
    );
  }

  // 预览：新开标签打开真实渲染结果。
  // 用的是与发布/导出**同一个渲染函数**，所以看到的就是最终效果。
  const preview = el('a', 'btn', '预览');
  preview.href = `/api/platform/projects/${project.id}/preview`;
  preview.target = '_blank';
  preview.rel = 'noopener';
  saveRow.appendChild(preview);

  const dl = el('a', 'btn', '下载网页');
  dl.href = `/api/platform/projects/${project.id}/export`;
  saveRow.appendChild(dl);

  info.appendChild(saveRow);
  box.appendChild(info);

  // ---- AI 生成 / 修改 ----
  const ai = el('div', 'card ai-box');
  ai.appendChild(el('h3', null, '用 AI 生成 / 修改'));

  // 引导文案按插件区分 —— 房源页填字段，自由页面写描述，两者的写法完全不同。
  // 一个空白输入框加一句通用提示，第一次用的人不知道写什么。
  // 说明收进问号图标：输入框旁边只留一个 ?，不再铺一大段灰字
  const guidance =
    project.pluginId === 'custom-page'
      ? '用一段话描述你想要的页面。写清三件事效果最好：' +
        '① 这是什么页面（例如「我的个人介绍页」）；' +
        '② 页面上要出现哪些内容（标题、几段文字、要不要放联系方式）；' +
        '③ 想要什么风格（例如「简洁、浅色、适合手机看」）。'
      : '按「字段名: 内容」逐行写，例如：title: 阳光两居 / priceAmount: 8500。只会改动你写到的字段，不会整页重写。';
  ai.appendChild(helpTip(guidance));

  // 自由页面给几个可直接点的例子 —— 比让用户对着空白框想措辞有用得多
  if (project.pluginId === 'custom-page') {
    const examples = el('div', 'row');
    examples.appendChild(el('span', 'hint', '试试：'));
    for (const sample of [
      '我的个人介绍页，包含姓名、一段自我介绍和联系方式，风格简洁',
      '一家咖啡店的介绍页，包含店名、招牌饮品和营业时间',
      '一次活动的报名说明页，包含活动时间、地点和注意事项',
    ]) {
      const chip = el('button', 'btn ghost small', sample.slice(0, 12) + '…');
      chip.type = 'button';
      chip.title = sample;
      chip.addEventListener('click', () => {
        const box = document.getElementById('editor')?.querySelector('.ai-box textarea');
        if (box) {
          box.value = sample;
          box.dispatchEvent(new Event('input', { bubbles: true }));
          box.focus();
        }
      });
      examples.appendChild(chip);
    }
    ai.appendChild(examples);
  }

  const prompt = el('textarea');
  // 占位文字也必须按插件区分 —— 自由页面用模式 A 的示例（title: xxx）
  // 会把用户带偏，让他以为要按字段填。这是实测时发现的不一致。
  prompt.placeholder =
    project.pluginId === 'custom-page'
      ? '例如：我的个人介绍页，包含姓名、一段自我介绍和联系方式，风格简洁清爽'
      : 'title: 阳光两居\npriceAmount: 8500';
  ai.appendChild(prompt);

  const aiRow = el('div', 'row');
  const genBtn = el('button', 'btn primary small', 'AI 生成');
  const revBtn = el('button', 'btn small', 'AI 修改');

  const runAi = async (kind, button) => {
    const text = prompt.value.trim();
    if (text === '') {
      toast('请先写点要求');
      return;
    }
    button.disabled = true;
    const original = button.textContent;
    button.textContent = '处理中…';
    try {
      const res = await api.post(
        `/api/platform/projects/${project.id}/${kind}`,
        { prompt: text },
        { 'X-Task-Id': newTaskId() },
      );
      state.quota = res.quota ?? state.quota;
      renderQuota();
      state.current = { ...state.current, spec: res.spec };
      renderEditor();
      toast(
        `已应用 ${Object.keys(res.patch).length} 个字段 · 用量 ${res.usage.totalTokens} Token${
          res.simulated ? '（模拟）' : ''
        }`,
      );
    } catch (error) {
      showError(ai, error);
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  };

  genBtn.addEventListener('click', () => void runAi('generate', genBtn));
  revBtn.addEventListener('click', () => void runAi('revise', revBtn));
  aiRow.appendChild(genBtn);
  aiRow.appendChild(revBtn);

  if (plugin) {
    aiRow.appendChild(el('span', 'hint', `插件：${plugin.name} v${plugin.version}`));
  }
  ai.appendChild(aiRow);
  box.appendChild(ai);

  // ---- 照片 ----
  //
  // 只有当这个插件真的使用媒体时才渲染照片区。
  // 判据用「插件是否声明了 images 字段」而不是「是不是房源插件」——
  // 这样将来新增一个也用图片的插件时，界面会自动跟上。
  // （早期版本无条件渲染，于是自定义页面项目里出现了一个
  //   注定上传失败的区域 —— 那正是「没有真实功能的空白管理页」。）
  const usesMedia = (plugin?.fields ?? []).some(
    (f) => f.kind === 'image' || f.kind === 'images',
  );
  if (usesMedia) box.appendChild(buildPhotoSection(project));

  // ---- 版本历史 ----
  const hist = el('div', 'card');
  hist.appendChild(el('h3', null, '版本历史'));
  if (state.currentVersions.length === 0) {
    hist.appendChild(el('p', 'hint', '还没有版本记录。'));
  } else {
    const list = el('ul', 'hint');
    for (const v of state.currentVersions) {
      list.appendChild(
        el('li', null, `v${v.versionNo} · ${v.kind === 'published' ? '发布版本' : '草稿'} · ${
          v.createdBy === 'ai' ? 'AI 改动' : '手动保存'
        } · ${fmtDate(v.createdAt)}`),
      );
    }
    hist.appendChild(list);
  }
  box.appendChild(hist);

  $('editor-status').textContent = project.publishedVersionId ? '已有发布版本' : '尚未发布';
}

// ---------------------------------------------------------------------------
// 视图切换与数据加载
// ---------------------------------------------------------------------------

/**
 * 加载插件清单。
 *
 * 【为什么必须放在 afterLogin 里而不是只在 boot 里】
 * 插件清单驱动着「新建项目」的类型下拉与字段编辑器。
 * 原先只在 boot 的「会话已存在」分支调用，导致
 * **注册或刚登录进来的用户**拿到的是空清单 ——
 * 新建项目时 pluginId 为空，服务端返回 400。
 * 现在统一在 afterLogin（所有进入主界面的路径都会经过它）里加载。
 */
async function loadPlugins() {
  if (state.plugins.length > 0) return;
  const res = await api.get('/api/platform/plugins');
  state.plugins = res.items ?? [];
}

async function refreshProjects() {
  if (state.showGallery) {
    renderProjects();
    return;
  }
  const url = state.showTrash ? '/api/platform/projects?scope=archived' : '/api/platform/projects';
  const res = await api.get(url);
  state.projects = res.items;
  renderProjects();
}

function showAuth() {
  $('auth-view').hidden = false;
  $('app-view').hidden = true;
}

function showApp() {
  $('auth-view').hidden = true;
  $('app-view').hidden = false;
  $('who').textContent = `${state.user.displayName}（${state.user.tier}）`;
}

async function openProject(id) {
  const res = await api.get(`/api/platform/projects/${id}`);
  state.current = res.project;
  state.currentVersions = res.versions;
  state.quota = res.quota ?? state.quota;
  await reloadMedia(id);
  $('list-section').hidden = true;
  $('editor-section').hidden = false;
  renderQuota();
  renderEditor();
}

function closeEditor() {
  state.current = null;
  $('editor-section').hidden = true;
  $('list-section').hidden = false;
  void refreshProjects();
}

async function afterLogin() {
  showApp();
  // 先加载插件清单：新建项目的表单要用它
  await loadPlugins();
  const quota = await api.get('/api/platform/quota');
  state.quota = quota;
  renderQuota();
  await refreshProjects();
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------

function bindAuth() {
  const tabs = $('auth-tabs');
  const form = $('auth-form');
  const errorBox = $('auth-error');
  const submit = $('auth-submit');
  const nameField = $('name-field');

  tabs.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-mode]');
    if (!btn) return;
    state.authMode = btn.dataset.mode;
    for (const b of tabs.querySelectorAll('button')) b.classList.toggle('on', b === btn);
    nameField.hidden = state.authMode !== 'register';
    submit.textContent = state.authMode === 'register' ? '注册并开始' : '登录';
    errorBox.hidden = true;
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.hidden = true;
    submit.disabled = true;

    const data = new FormData(form);
    const payload = {
      email: String(data.get('email') ?? ''),
      password: String(data.get('password') ?? ''),
    };
    if (state.authMode === 'register') payload.displayName = String(data.get('displayName') ?? '');

    try {
      const res = await api.post(`/api/platform/${state.authMode}`, payload);
      state.user = res.user;
      state.quota = res.quota;
      form.reset();
      await afterLogin();
    } catch (error) {
      errorBox.textContent = error instanceof ApiError ? error.message : '操作失败';
      errorBox.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
}

function bindApp() {
  $('logout').addEventListener('click', async () => {
    try {
      await api.post('/api/platform/logout');
    } catch {
      // 登出失败也把界面切回去，避免卡住
    }
    state.user = null;
    state.quota = null;
    state.projects = [];
    showAuth();
  });

  // 新建项目用内联表单，而不是 window.prompt：
  // 原生弹窗在移动端体验差、无法校验、也无法做自动化测试。
  $('new-project').addEventListener('click', () => {
    const host = $('new-project-form');
    if (!host.hidden) {
      host.hidden = true;
      return;
    }
    clear(host);
    host.hidden = false;

    if (state.plugins.length === 0) {
      host.appendChild(el('p', 'alert error', '没有可用的网页类型，请刷新页面重试。'));
      return;
    }

    const pluginField = el('label', 'field');
    pluginField.appendChild(el('span', null, '网页类型'));
    const pluginSelect = el('select');
    for (const p of state.plugins) {
      const o = el('option', null, `${p.name}（${p.description || p.pageType}）`);
      o.value = p.id;
      pluginSelect.appendChild(o);
    }
    pluginField.appendChild(pluginSelect);
    host.appendChild(pluginField);

    const titleField = el('label', 'field');
    titleField.appendChild(el('span', null, '项目标题'));
    const titleInput = el('input');
    titleInput.type = 'text';
    titleInput.value = '我的展示页';
    titleInput.maxLength = 120;
    titleField.appendChild(titleInput);
    host.appendChild(titleField);

    const errorBox = el('div');
    host.appendChild(errorBox);

    const row = el('div', 'row');
    const create = el('button', 'btn primary small', '创建');
    const cancel = el('button', 'btn ghost small', '取消');
    cancel.addEventListener('click', () => {
      host.hidden = true;
    });
    create.addEventListener('click', async () => {
      create.disabled = true;
      clear(errorBox);
      try {
        const res = await api.post('/api/platform/projects', {
          pluginId: pluginSelect.value,
          title: titleInput.value,
        });
        host.hidden = true;
        await refreshProjects();
        toast('项目已创建');
        await openProject(res.project.id);
      } catch (error) {
        showError(errorBox, error);
        toast(error instanceof ApiError ? error.message : '创建失败');
      } finally {
        create.disabled = false;
      }
    });
    row.appendChild(create);
    row.appendChild(cancel);
    host.appendChild(row);

    titleInput.focus();
  });

  $('back-to-list').addEventListener('click', closeEditor);

  // 回收站入口
  $('open-trash').addEventListener('click', () => {
    state.showTrash = true;
    state.showGallery = false;
    void refreshProjects();
  });

  // 示例画廊：让用户在花额度之前先看到「生成出来长什么样」
  $('open-gallery').addEventListener('click', async () => {
    state.showGallery = true;
    state.showTrash = false;
    if (state.examples.length === 0) {
      try {
        const res = await api.get('/api/platform/examples');
        state.examples = res.items ?? [];
        state.galleryDisclaimer = res.disclaimer ?? '';
      } catch {
        state.examples = [];
      }
    }
    renderProjects();
  });
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

async function boot() {
  bindAuth();
  bindApp();

  try {
    const session = await api.get('/api/platform/session');
    if (session.authenticated) {
      state.user = session.user;
      state.quota = session.quota;
      await loadPlugins();
      await afterLogin();
      return;
    }
  } catch {
    // 会话探测失败按未登录处理
  }

  showAuth();
}

// 说明一律以问号图标呈现：这里把静态标记里的 data-help 挂载点渲染出来
mountHelpSlots();

void boot();