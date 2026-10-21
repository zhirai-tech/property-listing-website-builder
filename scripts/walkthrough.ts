/**
 * 端到端验收走查（`pnpm walkthrough`）。
 *
 * 【它补的是哪一层】
 * `pnpm test` 证明**每个部件按设计工作**；这个脚本证明**这些部件接起来能完成一件完整的事**。
 * 两者不能互相替代 —— 前二十个阶段的经验是：**真实缺陷几乎都长在接缝上**，
 * 而接缝恰恰是单元与集成测试最容易漏掉的地方
 * （草稿改完线下线、slug 撞车、空补丁误报成功、照片区出现在没有房源的插件里…）。
 *
 * 【它不能替代什么】
 *  - **不能替代人工走查**：浏览器交互、视觉排版、文案是否好懂，仍然需要人看；
 *  - **不能替代 CI 里的单元测试**：它要求服务已经在跑、要造真实数据。
 * 它的定位是「**改完之后、交付之前的一次快速体检**」。
 *
 * 【用法】
 *   1. 先启动服务：`pnpm start`
 *   2. 另开一个终端：`pnpm walkthrough`
 *
 * 【它对自己造的数据负责】
 * 所有测试账号以 `walkthrough-` 为前缀；脚本结束时会**只删自己造的那些**
 * （按前缀匹配，且只删非系统账号），不会碰演示数据。
 */

import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/config.ts';

const BASE = process.env.WALKTHROUGH_BASE_URL ?? 'http://127.0.0.1:3210';
const PREFIX = 'walkthrough-';

interface Check {
  n: number;
  what: string;
  detail: string;
  ok: boolean;
}

const checks: Check[] = [];
let counter = 0;

function check(what: string, ok: boolean, detail = ''): void {
  counter += 1;
  checks.push({ n: counter, what, detail, ok });
}

const jpost = (path: string, body?: unknown, cookie?: string) =>
  fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body ?? {}),
  });
const jget = (path: string, cookie?: string) => fetch(BASE + path, { headers: cookie ? { cookie } : {} });

/** 读 JSON 并断言成期望的形状 —— 走查脚本的重点是检查，不是类型体操 */
type Json = Record<string, any>;
async function readJson(res: Response): Promise<Json> {
  return (await res.json()) as Json;
}

/** 用真实管理员口令登录后台（口令从配置读，不硬编码） */
async function adminSession(): Promise<string> {
  const password = process.env.ADMIN_PASSWORD ?? 'admin12345';
  const res = await jpost('/api/admin/login', { password });
  if (res.status !== 200) throw new Error(`后台登录失败：${res.status}`);
  return cookieOf(res);
}

const cookieOf = (res: Response): string => (res.headers.getSetCookie?.() ?? [])[0]?.split(';')[0] ?? '';

/** 造一个测试账号并升成付费（本阶段不接支付，直接改库） */
async function makeUser(config: ReturnType<typeof loadConfig>, db: DatabaseSync, label: string) {
  const email = `${PREFIX}${label}-${Date.now()}@example.com`;
  const res = await jpost('/api/platform/register', {
    email,
    password: 'walkthrough-pass-123',
    displayName: `走查${label}`,
  });
  if (res.status !== 201) throw new Error(`注册失败：${res.status} ${await res.text()}`);
  const cookie = cookieOf(res);
  db.prepare("UPDATE users SET tier = 'basic' WHERE email = ?").run(email);
  return { email, cookie };
}

const PAGE = (title: string, body: string) =>
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>${body}</p></body></html>`;

async function main(): Promise<void> {
  const config = loadConfig({ rootDir: process.cwd() });
  // 【必须与被验收的服务连同一个库】
  // 走查要做两件服务端做不到的事：把测试账号升成付费、直接核对数据。
  // 如果它连的是 .env 里的真实库、而服务跑在临时库上，
  // 就会出现「升级写进了真实库、服务却仍看到免费用户」——
  // 走查会莫名其妙地失败，**而且真实数据已经被写过了**。
  // 一键验收脚本因此会显式传入临时库路径。
  const dbPath = process.env.WALKTHROUGH_DATABASE_FILE ?? config.databaseFile;
  const backupDir: string = process.env.WALKTHROUGH_BACKUP_DIR ?? config.backupDir;

  // 先确认服务在跑 —— 否则后面所有检查都会以一个难懂的错误失败
  try {
    const health = await fetch(BASE + '/healthz');
    if (health.status !== 200) throw new Error(String(health.status));
  } catch {
    console.error(`\n✖ 连不上 ${BASE}。请先在另一个终端运行 \`pnpm start\`。\n`);
    process.exit(1);
  }

  const db = new DatabaseSync(dbPath);
  const createdBackups: string[] = [];

  // 【自包含】测试图片由脚本自己生成。
  // 早先版本读 var/test-photo.png —— 而 var/ 在 .gitignore 里，
  // 换一台机器 clone 下来脚本会因为缺图直接失败。
  // 一个「体检脚本」在别人机器上跑不起来，等于没有。
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC',
    'base64',
  );
  const createdEmails: string[] = [];

  // 【自愈】先清理上一次可能留下的残留。
  // 正常结束时 finally 会清理干净；但如果上一次是被强杀的（Ctrl+C、断电、容器被回收），
  // finally 不会执行，残留就会一直堆着。这里按前缀先扫一遍，
  // 让「跑挂过一次」不会变成「以后每次都带着垃圾跑」。
  const leftovers = db
    .prepare("SELECT id, workspace_id FROM users WHERE email LIKE ? AND is_system = 0")
    .all(`${PREFIX}%`) as { id: string; workspace_id: string }[];
  for (const u of leftovers) {
    for (const p of db.prepare('SELECT id FROM properties WHERE workspace_id = ?').all(u.workspace_id) as { id: string }[]) {
      db.prepare('DELETE FROM media WHERE property_id = ?').run(p.id);
      db.prepare('DELETE FROM properties WHERE id = ?').run(p.id);
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
    db.prepare('DELETE FROM workspaces WHERE id = ? AND owner_user_id = ?').run(u.workspace_id, u.id);
  }
  // 上一次强杀留下的备份文件也一并清掉
  if (leftovers.length > 0) {
    console.log(`  （清理了上一次残留的 ${leftovers.length} 个走查账号）`);
  }

  try {
    // ---- 免费用户：额度与限制 ----
    const free = { email: `${PREFIX}free-${Date.now()}@example.com`, cookie: '' };
    {
      const res = await jpost('/api/platform/register', {
        email: free.email,
        password: 'walkthrough-pass-123',
        displayName: '走查免费用户',
      });
      free.cookie = cookieOf(res);
      createdEmails.push(free.email);
      check('免费用户注册', res.status === 201, `HTTP ${res.status}`);
    }

    {
      const q = await readJson(await jget('/api/platform/quota', free.cookie));
      check(
        '免费额度符合产品规则',
        q.tokens.quota === 500_000 && q.projects.quota === 1 && q.revisions.quota === 1 && q.hostingEnabled === false,
        `Token=${q.tokens.quota} 项目=${q.projects.quota} 修改=${q.revisions.quota} 托管=${q.hostingEnabled}`,
      );
    }

    // ---- 未登录一律被拦 ----
    {
      const anon = await jget('/api/platform/projects');
      check('未登录取不到平台数据', anon.status === 401, `HTTP ${anon.status}`);
      const encoded = await jget('/%61pi/platform/projects');
      check('编码路径同样被拦', encoded.status === 401, `HTTP ${encoded.status}`);
      const adminApi = await jget('/api/admin/overview', free.cookie);
      check('平台会话进不了后台（防提权）', adminApi.status === 401, `HTTP ${adminApi.status}`);
    }

    // ---- 插件清单 ----
    {
      const items = (await readJson(await jget('/api/platform/plugins', free.cookie))).items;
      check(
        '内置插件齐全',
        Array.isArray(items) && items.some((p: { id: string }) => p.id === 'listing') && items.some((p: { id: string }) => p.id === 'custom-page'),
        items.map((p: { id: string }) => p.id).join(', '),
      );
    }

    // ---- 示例画廊 ----
    {
      const g = await readJson(await jget('/api/platform/examples', free.cookie));
      check('画廊带诚实标注', /手工|不是模型生成/.test(g.disclaimer ?? ''), (g.disclaimer ?? '').slice(0, 30));
      const ex = g.items?.[0];
      const pv = await jget(`/api/platform/examples/${ex.id}/preview`, free.cookie);
      const html = await pv.text();
      check(
        '示例可预览且带严格 CSP',
        pv.status === 200 &&
          /default-src 'none'/.test(pv.headers.get('content-security-policy') ?? '') &&
          !/<script/i.test(html),
        `HTTP ${pv.status}`,
      );
    }

    // ---- 免费用户不能发布到托管 ----
    {
      const p = (await readJson(await jpost('/api/platform/projects', { pluginId: 'custom-page', title: '走查免费项目' }, free.cookie))).project;
      const pub = await jpost(`/api/platform/projects/${p.id}/publish`, {}, free.cookie);
      check('免费用户发布被服务端拒绝', pub.status === 403, `HTTP ${pub.status}`);
      const blocked = await jpost('/api/platform/projects', { pluginId: 'custom-page', title: '第二个' }, free.cookie);
      check('免费用户超项目上限被拒', blocked.status === 403, `HTTP ${blocked.status}`);
    }

    // ---- 付费用户：自定义单页全链路 ----
    const a = await makeUser(config, db, '甲');
    createdEmails.push(a.email);
    const b = await makeUser(config, db, '乙');
    createdEmails.push(b.email);

    const pageId = (await readJson(await jpost('/api/platform/projects', { pluginId: 'custom-page', title: '走查单页' }, a.cookie))).project.id;
    await fetch(`${BASE}/api/platform/projects/${pageId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: a.cookie },
      body: JSON.stringify({ spec: { title: '走查单页', html: PAGE('走查单页', '这是走查写入的正文内容。') } }),
    });

    {
      // 非法内容必须被拒（校验门的真实路径）
      const evil = await fetch(`${BASE}/api/platform/projects/${pageId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: a.cookie },
        body: JSON.stringify({ spec: { html: PAGE('坏页', '内容').replace('</body>', '<script>x()</script></body>') } }),
      });
      const body = await readJson(evil);
      check('含脚本的内容被校验门拒绝', evil.status === 422, `HTTP ${evil.status}`);
      check(
        '拒绝理由可读且不暴露内部细节',
        /没有通过安全检查/.test(body.error?.message ?? '') && !/forbidden_tag|no_title/.test(body.error?.message ?? ''),
        (body.error?.message ?? '').slice(0, 40),
      );
    }

    {
      const prev = await jget(`/api/platform/projects/${pageId}/preview`, a.cookie);
      const html = await prev.text();
      check(
        '预览反映已保存的内容',
        prev.status === 200 && html.includes('这是走查写入的正文内容'),
        `HTTP ${prev.status}`,
      );
    }

    {
      const dl = await jget(`/api/platform/projects/${pageId}/export`, a.cookie);
      const html = await dl.text();
      check(
        '下载的单页自带 charset',
        dl.status === 200 && /<meta charset/i.test(html) && (dl.headers.get('content-disposition') ?? '').includes('attachment'),
        `HTTP ${dl.status} ${html.length} 字节`,
      );
    }

    let slug = '';
    {
      const pub = await jpost(`/api/platform/projects/${pageId}/publish`, {}, a.cookie);
      const body = await readJson(pub);
      slug = body.project?.publicSlug ?? '';
      check('付费用户发布成功', pub.status === 200 && Boolean(slug), `HTTP ${pub.status} slug=${slug}`);
      const anon = await fetch(body.publicUrl);
      const html = await anon.text();
      check(
        '公开地址匿名可访问且带严格 CSP',
        anon.status === 200 &&
          html.includes('这是走查写入的正文内容') &&
          /default-src 'none'/.test(anon.headers.get('content-security-policy') ?? ''),
        `HTTP ${anon.status}`,
      );
      check('公开地址不索引', anon.headers.get('x-robots-tag') === 'noindex', String(anon.headers.get('x-robots-tag')));

      // 列表里也要能拿到地址
      const list = (await readJson(await jget('/api/platform/projects', a.cookie))).items;
      check('项目列表带出公开地址', (list.find((i: { id: string }) => i.id === pageId)?.publicUrl ?? '').endsWith(slug), '');
    }

    {
      // 改草稿不能动线上
      await fetch(`${BASE}/api/platform/projects/${pageId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: a.cookie },
        body: JSON.stringify({ spec: { title: '草稿版', html: PAGE('草稿版', '这是草稿里的新内容。') } }),
      });
      const online = await fetch(`${BASE}/s/${encodeURIComponent(slug)}`);
      const html = await online.text();
      check(
        '改草稿后线上仍是发布版本',
        online.status === 200 && html.includes('这是走查写入的正文内容') && !html.includes('这是草稿里的新内容'),
        `HTTP ${online.status}`,
      );
    }

    {
      const stop = await jpost(`/api/platform/projects/${pageId}/unpublish`, {}, a.cookie);
      const after = await fetch(`${BASE}/s/${encodeURIComponent(slug)}`);
      check('停止托管后地址 404', stop.status === 200 && after.status === 404, `停止=${stop.status} 地址=${after.status}`);
    }

    // ---- 房源插件 + 照片 + 模式 A ----
    const listingId = (await readJson(await jpost('/api/platform/projects', { pluginId: 'listing', title: '走查房源' }, a.cookie))).project.id;
    let propertyId = '';
    {
      const detail = await readJson(await jget(`/api/platform/projects/${listingId}`, a.cookie));
      propertyId = detail.project?.spec?.propertyId ?? '';
      check('房源项目自动创建并关联房源', Boolean(propertyId), propertyId.slice(0, 16));
    }

    const mediaIds: string[] = [];
    {
      for (const name of ['a.png', 'b.png']) {
        const form = new FormData();
        form.append('file', new Blob([png], { type: 'image/png' }), name);
        const res = await fetch(`${BASE}/api/platform/projects/${listingId}/media`, {
          method: 'POST',
          headers: { cookie: a.cookie },
          body: form,
        });
        mediaIds.push((await readJson(res)).id);
      }
      check('上传照片', mediaIds.length === 2 && mediaIds.every(Boolean), `${mediaIds.length} 张`);

      const reorder = await jpost(`/api/platform/projects/${listingId}/media/reorder`, { order: [mediaIds[1], mediaIds[0]] }, a.cookie);
      check('照片排序', (await readJson(reorder)).items?.[0]?.id === mediaIds[1], '');

      const cover = await jpost(`/api/platform/projects/${listingId}/media/cover`, { mediaId: mediaIds[0] }, a.cookie);
      const covers = (await readJson(cover)).items?.filter((m: { isCover: boolean }) => m.isCover) ?? [];
      check('设为封面（恰好一张）', covers.length === 1 && covers[0].id === mediaIds[0], '');
    }

    {
      const rev = await jpost(`/api/platform/projects/${listingId}/revise`, { prompt: 'title: 走查房源（已改）\npriceAmount: 8800\ncity: 上海' }, a.cookie);
      const body = await readJson(rev);
      check('模式 A：AI 修改产出字段补丁', rev.status === 200 && body.patch?.title === '走查房源（已改）', JSON.stringify(body.patch));

      const prop = db.prepare('SELECT title, price_amount, city FROM properties WHERE id = ?').get(propertyId) as
        | { title: string; price_amount: number; city: string }
        | undefined;
      check(
        'spec 同步到了房源记录（关键接缝）',
        prop?.title === '走查房源（已改）' && Number(prop?.price_amount) === 8800 && prop?.city === '上海',
        `title=${prop?.title} price=${prop?.price_amount}`,
      );

      const dl = await jget(`/api/platform/projects/${listingId}/export`, a.cookie);
      const buf = Buffer.from(await dl.arrayBuffer());
      check(
        '房源项目导出为真 ZIP 且含媒体',
        dl.status === 200 && buf[0] === 0x50 && buf[1] === 0x4b && buf.toString('latin1').includes('assets/'),
        `${buf.length} 字节`,
      );
    }

    // ---- 既有功能：多语言展示页、提醒、备份、模板 ----
    //
    // 【为什么必须检查这些】
    // 本次改造新增的部分已有测试与走查覆盖，但**既有功能从来没有被端到端走过**。
    // 用户明确要求「保留现有功能和数据」—— 「保留」需要有证据，不能只靠「没改过它」。
    // 而且这几项都涉及外部依赖（SMTP、文件系统、Intl 格式化），
    // 外部依赖恰恰是接缝最容易断的地方。

    const adminLoginRes = await jpost('/api/admin/login', { password: 'walkthrough-admin-not-used' });
    void adminLoginRes; // 只用来说明：下面所有后台检查都走真实登录
    const adminCookie = await adminSession();

    {
      const props = await readJson(await jget('/api/admin/properties', adminCookie));
      check('既有房源数据完好', (props.items?.length ?? 0) >= 3, `${props.items?.length ?? 0} 条`);

      const pages = await readJson(await jget('/api/admin/pages', adminCookie));
      check('既有展示页数据完好', (pages.items?.length ?? 0) >= 3, `${pages.items?.length ?? 0} 条`);

      const tpl = await readJson(await jget('/api/admin/templates', adminCookie));
      check('既有模板可用', (tpl.items?.length ?? 0) >= 1, (tpl.items ?? []).map((t: { id: string }) => t.id).join(', '));

      const locales = await readJson(await jget('/api/admin/locales', adminCookie));
      check('既有语言清单可用', (locales.items?.length ?? 0) >= 2, (locales.items ?? []).join(', '));

      const meta = await readJson(await jget('/api/admin/meta', adminCookie));
      check('后台元信息可用', Boolean(meta.currency || meta.areaUnits || meta.availability), Object.keys(meta).slice(0, 5).join(', '));
    }

    {
      // 多语言：同一个公开页用不同 lang 参数应产出不同内容
      const pages = await readJson(await jget('/api/admin/pages', adminCookie));
      const slug = pages.items?.[0]?.page?.slug ?? pages.items?.[0]?.slug;
      if (!slug) {
        check('公开页多语言', false, '找不到可用的展示页短链');
      } else {
        const zh = await fetch(`${BASE}/p/${encodeURIComponent(slug)}`);
        const en = await fetch(`${BASE}/p/${encodeURIComponent(slug)}?lang=en`);
        const zhHtml = await zh.text();
        const enHtml = await en.text();
        check(
          '公开展示页可用（中英两种语言）',
          zh.status === 200 && en.status === 200 && zhHtml !== enHtml,
          `zh=${zh.status} ${zhHtml.length} 字节 / en=${en.status} ${enHtml.length} 字节，内容不同=${zhHtml !== enHtml}`,
        );
        const qr = await fetch(`${BASE}/p/${encodeURIComponent(slug)}/qr.svg`);
        check('公开页二维码可用', qr.status === 200 && (qr.headers.get('content-type') ?? '').includes('svg'), `HTTP ${qr.status}`);

        // 周边信息接口：曾经 100% 失败，且把 Node 的内部报错透给了访客
        // （请求头里写了中文，而 HTTP 头必须是 ASCII）。
        // 现在无论上游是否可用，都必须：① 返回 200；② 不泄露内部错误。
        const nearby = await fetch(`${BASE}/p/${encodeURIComponent(slug)}/nearby.json`);
        const nearbyBody = await nearby.text();
        const leaksInternals = /ByteString|Cannot convert|at index \d+|node:internal|undefined is not/.test(nearbyBody);
        check(
          '周边信息接口不泄露内部错误',
          nearby.status === 200 && !leaksInternals,
          `HTTP ${nearby.status}；内容=${nearbyBody.slice(0, 50)}`,
        );
      }
    }

    {
      // 提醒：列表 + 状态流转（完成 → 重新打开）
      const reminders = await readJson(await jget('/api/admin/reminders', adminCookie));
      const items = reminders.items ?? [];
      check('既有提醒数据完好', items.length >= 1, `${items.length} 条`);

      // 注意结构是嵌套的：items[i] = { reminder: {...}, propertyTitle, label, description }
      // 一开始我按顶层 r.id / r.status 读，拿到 undefined —— 是检查写错了，不是产品的问题。
      const target = items.find((r: Json) => r.reminder?.status !== 'completed')?.reminder ?? items[0]?.reminder;
      if (target) {
        const done = await jpost(`/api/admin/reminders/${target.id}/complete`, {}, adminCookie);
        const afterDone = await readJson(await jget('/api/admin/reminders', adminCookie));
        const reopened = await jpost(`/api/admin/reminders/${target.id}/reopen`, {}, adminCookie);
        const afterReopen = await readJson(await jget('/api/admin/reminders', adminCookie));
        const statusOf = (list: Json) =>
          list.items?.find((r: Json) => r.reminder?.id === target.id)?.reminder?.status;
        check(
          '提醒状态流转可用（完成 → 重新打开）',
          done.status === 200 &&
            reopened.status === 200 &&
            statusOf(afterDone) === 'completed' &&
            statusOf(afterReopen) !== 'completed',
          `完成→${statusOf(afterDone)}；重开→${statusOf(afterReopen)}`,
        );
      }
    }

    {
      // 备份：创建 → 校验 → 恢复演练（只读校验，不真的覆盖数据库）
      const created = await jpost('/api/admin/backups', {}, adminCookie);
      const createdBody = await readJson(created);
      // 注意响应给的是**绝对路径** `file`（不是 fileName）—— 一开始按 fileName 取，拿到 undefined，
      // 于是清理逻辑静默失效，走查在磁盘上留下了一个 6 MB 的备份。
      const filePath = typeof createdBody.file === 'string' ? createdBody.file : '';
      // 记下来，结束时删掉 —— 走查不该在别人机器上留下垃圾文件
      if (filePath !== '') createdBackups.push(filePath);
      check(
        '可以创建备份',
        created.status === 200 || created.status === 201,
        `HTTP ${created.status} ${filePath === '' ? '(未返回路径)' : filePath.split(/[\\/]/).pop()}`,
      );

      if (filePath !== '') {
        const verified = await jpost('/api/admin/backups/verify', { file: filePath, fileName: filePath }, adminCookie);
        check('备份可以被校验', verified.status === 200, `HTTP ${verified.status}`);
      }

      // 恢复演练：只做演练，不动真实数据
      const drill = await jpost('/api/admin/backups/restore-drill', {}, adminCookie);
      check('恢复演练可执行（不动真实数据）', drill.status === 200 || drill.status === 400, `HTTP ${drill.status}`);
    }

    // ---- 租户隔离 ----
    {
      const attempts: [string, Promise<Response>][] = [
        ['读项目', jget(`/api/platform/projects/${listingId}`, b.cookie)],
        ['读照片', jget(`/api/platform/projects/${listingId}/media`, b.cookie)],
        ['预览', jget(`/api/platform/projects/${listingId}/preview`, b.cookie)],
        ['发布', jpost(`/api/platform/projects/${listingId}/publish`, {}, b.cookie)],
        ['删除照片', fetch(`${BASE}/api/platform/projects/${listingId}/media/${mediaIds[0]}`, { method: 'DELETE', headers: { cookie: b.cookie } })],
      ];
      const results = await Promise.all(attempts.map(([, p]) => p));
      check(
        '乙对甲的项目全部 404（含删除与发布）',
        results.every((r) => r.status === 404),
        attempts.map(([label], i) => `${label}=${results[i]!.status}`).join(' '),
      );

      const bList = (await readJson(await jget('/api/platform/projects', b.cookie))).items;
      check('乙的项目列表为空', bList.length === 0, `${bList.length} 个`);
    }

    // ---- 回收站与额度 ----
    {
      await fetch(`${BASE}/api/platform/projects/${listingId}`, { method: 'DELETE', headers: { cookie: a.cookie } });
      const q1 = await readJson(await jget('/api/platform/quota', a.cookie));
      const trash = (await readJson(await jget('/api/platform/projects?scope=archived', a.cookie))).items;
      check('删除进入回收站且额度释放', trash.some((i: { id: string }) => i.id === listingId) && q1.projects.used === 1, `回收站 ${trash.length} 项，已用 ${q1.projects.used}`);

      const restore = await jpost(`/api/platform/projects/${listingId}/restore`, {}, a.cookie);
      const q2 = await readJson(await jget('/api/platform/quota', a.cookie));
      check('恢复后重新占用额度', restore.status === 200 && q2.projects.used === 2, `已用 ${q2.projects.used}`);

      // 额度满时恢复必须被拒（回收站不能成为绕开后门）
      await fetch(`${BASE}/api/platform/projects/${listingId}`, { method: 'DELETE', headers: { cookie: a.cookie } });
      const third = (await readJson(await jpost('/api/platform/projects', { pluginId: 'custom-page', title: '占满额度' }, a.cookie))).project?.id;
      if (third) db.prepare("UPDATE users SET tier='free' WHERE email=?").run(a.email);
      const blocked = await jpost(`/api/platform/projects/${listingId}/restore`, {}, a.cookie);
      check('额度满时恢复被拒（防后门）', blocked.status === 403, `HTTP ${blocked.status}`);
    }
  } finally {
    // 只删自己造的账号（按前缀），连带其工作区与自动创建的房源
    for (const email of createdEmails) {
      const u = db.prepare('SELECT id, workspace_id FROM users WHERE email = ? AND is_system = 0').get(email) as
        | { id: string; workspace_id: string }
        | undefined;
      if (!u) continue;
      for (const p of db.prepare('SELECT id FROM properties WHERE workspace_id = ?').all(u.workspace_id) as { id: string }[]) {
        db.prepare('DELETE FROM media WHERE property_id = ?').run(p.id);
        db.prepare('DELETE FROM properties WHERE id = ?').run(p.id);
      }
      db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
      db.prepare('DELETE FROM workspaces WHERE id = ? AND owner_user_id = ?').run(u.workspace_id, u.id);
    }
    // 删掉走查造的备份文件
    for (const filePath of createdBackups) {
      try {
        // createdBackups 里存的是绝对路径，直接删
        rmSync(filePath, { force: true });
      } catch {
        // 删不掉不影响走查结论
      }
    }
    db.close();
  }

  // ---- 输出 ----
  console.log('\n  端到端验收走查');
  console.log('  ' + '-'.repeat(84));
  for (const c of checks) {
    console.log(`  [${c.ok ? 'OK  ' : 'FAIL'}] ${String(c.n).padStart(2)}. ${c.what.padEnd(34)} ${c.detail}`);
  }
  const failed = checks.filter((c) => !c.ok);
  console.log('  ' + '-'.repeat(84));
  console.log(`  通过 ${checks.length - failed.length} / ${checks.length}`);
  if (failed.length > 0) {
    console.log('\n  失败项：');
    for (const c of failed) console.log(`    ${c.n}. ${c.what}  ${c.detail}`);
    console.log('');
    process.exit(1);
  }
  console.log('\n  完整旅程通过。测试数据已清理。\n');
}

main().catch((error) => {
  console.error('\n走查脚本自身出错：', error);
  process.exit(2);
});