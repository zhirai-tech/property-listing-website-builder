/**
 * 端到端冒烟验证（方案第六章第 4 条：必须验证真实用户路径）。
 *
 * 这里使用 Fastify 的 inject 在进程内跑完整链路的 HTTP 请求，覆盖：
 * 登录鉴权 -> 房源录入 -> 照片上传 -> 发布 -> 公开访问 -> 撤下 ->
 * 时间旅行触发第 7/15 天提醒 -> 导出 ZIP -> 备份与恢复演练。
 *
 * 运行：pnpm smoke
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { closeContext, createAppContext } from '../src/app-context.ts';
import { buildApp } from '../src/http/app.ts';
import { readZip } from '../src/util/unzip.ts';
import { toZonedParts } from '../src/util/time.ts';

const results: { name: string; ok: boolean; detail: string }[] = [];

function record(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? '  [OK]  ' : '  [FAIL]'} ${name}${detail ? ` — ${detail}` : ''}\n`);
}

function assert(name: string, condition: boolean, detail = ''): void {
  record(name, condition, detail);
  if (!condition) throw new Error(`断言失败：${name} ${detail}`);
}

/**
 * 按指定时区的**日历**计算两个瞬间相隔几天。
 *
 * 【为什么不直接算毫秒差】提醒规则是「发布日 + 7 个日历日，落在那天的当地 09:00」，
 * 不是「经过 7×24 小时」。用毫秒差断言会把两者混为一谈：
 * 只要发布发生在当地 09:00 之后，到「第 7 天 09:00」的毫秒差就必然**小于** 168 小时
 * （16:00 发布 → 相差 6 天 17 小时），断言就会在一天中的大部分时间失败。
 *
 * 这里复用产品自身的 toZonedParts，避免另写一套时区换算。
 */
function zonedCalendarDaysBetween(from: Date, to: Date, timeZone: string): number {
  const a = toZonedParts(from, timeZone);
  const b = toZonedParts(to, timeZone);
  const aDay = Date.UTC(a.year, a.month - 1, a.day);
  const bDay = Date.UTC(b.year, b.month - 1, b.day);
  return Math.round((bDay - aDay) / 86_400_000);
}

/** 把当地时刻格式化成 HH:MM:SS，用于断言失败时的可读输出 */
function formatLocalTime(instant: Date, timeZone: string): string {
  const p = toZonedParts(instant, timeZone);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/** 1x1 透明 PNG，用于验证上传链路（含真实文件头） */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function multipartBody(filename: string, contentType: string, data: Buffer): { body: Buffer; contentType: string } {
  const boundary = `----smoke${Date.now()}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');

  return {
    body: Buffer.concat([head, data, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function main(): Promise<void> {
  const workDir = mkdtempSync(join(tmpdir(), 'pl-smoke-'));
  process.stdout.write(`临时工作目录：${workDir}\n\n`);

  const config = loadConfig({
    rootDir: workDir,
    readEnvFile: false,
  });

  // 覆盖到临时目录，避免污染真实数据
  const patched = {
    ...config,
    env: 'test' as const,
    databaseFile: join(workDir, 'db', 'app.sqlite'),
    uploadDir: join(workDir, 'uploads'),
    backupDir: join(workDir, 'backups'),
    dataDir: workDir,
    adminPassword: 'smoke-test-password',
    sessionSecret: 'smoke-test-session-secret-at-least-32-chars',
    devTimeTravel: true,
  };

  const ctx = createAppContext({ config: patched });
  const app = await buildApp(ctx);

  try {
    // ---- 1. 健康检查 ----
    process.stdout.write('【1】健康检查与鉴权\n');
    const health = await app.inject({ method: 'GET', url: '/healthz' });
    assert('健康检查返回 200', health.statusCode === 200, `status=${health.statusCode}`);
    assert('迁移已应用', JSON.parse(health.body).migrations.includes(1));

    const guarded = await app.inject({ method: 'GET', url: '/api/admin/overview' });
    assert('未登录访问后台接口返回 401', guarded.statusCode === 401, `status=${guarded.statusCode}`);

    const wrongLogin = await app.inject({
      method: 'POST',
      url: '/api/admin/login',
      payload: { password: 'wrong-password' },
    });
    assert('错误口令被拒绝', wrongLogin.statusCode === 401);

    const login = await app.inject({
      method: 'POST',
      url: '/api/admin/login',
      payload: { password: patched.adminPassword },
    });
    assert('正确口令登录成功', login.statusCode === 200, `status=${login.statusCode}`);

    const setCookie = login.headers['set-cookie'];
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0]!.split(';')[0]! : String(setCookie).split(';')[0]!;
    assert('返回会话 Cookie', cookieHeader.startsWith('admin_session='));

    const auth = { cookie: cookieHeader };

    // ---- 2. 房源录入 ----
    process.stdout.write('\n【2】房源录入与校验\n');
    const badCreate = await app.inject({
      method: 'POST',
      url: '/api/admin/properties',
      headers: auth,
      payload: { title: '', priceAmount: 'abc' },
    });
    assert('空标题被拒绝', badCreate.statusCode === 400, `status=${badCreate.statusCode}`);
    const badIssues = JSON.parse(badCreate.body).error.issues as { field: string }[];
    assert('返回字段级中文提示', badIssues.some((i) => i.field === 'title'), JSON.stringify(badIssues.map((i) => i.field)));

    const create = await app.inject({
      method: 'POST',
      url: '/api/admin/properties',
      headers: auth,
      payload: {
        title: '浦东新区精装两居室',
        description: '近地铁 2 号线，采光良好。\n\n配套齐全，可拎包入住。',
        addressLine: '世纪大道 100 号 3 号楼 1502',
        district: '浦东新区',
        city: '上海',
        region: '上海市',
        countryCode: 'CN',
        postalCode: '200120',
        latitude: 31.2304,
        longitude: 121.4737,
        propertyType: 'apartment',
        bedrooms: 2,
        bathrooms: 1,
        areaValue: 89.5,
        areaUnit: 'square_meter',
        priceAmount: 8500,
        priceCurrency: 'CNY',
        pricePeriod: 'per_month',
        depositAmount: 17000,
        depositCurrency: 'CNY',
        extraFeesNote: '物业费由租客承担，水电燃气按实际用量结算。',
        availableFrom: '2026-11-01',
        status: 'active',
      },
    });
    assert('创建房源成功', create.statusCode === 201, `status=${create.statusCode} body=${create.body.slice(0, 200)}`);

    const property = JSON.parse(create.body).property as { id: string; title: string };
    const propertyId = property.id;

    const list = await app.inject({ method: 'GET', url: '/api/admin/properties', headers: auth });
    assert('列表包含新建房源', JSON.parse(list.body).total === 1);

    const search = await app.inject({
      method: 'GET',
      url: `/api/admin/properties?search=${encodeURIComponent('浦东')}`,
      headers: auth,
    });
    assert('中文关键词搜索命中', JSON.parse(search.body).total === 1);

    const notFound = await app.inject({ method: 'GET', url: '/api/admin/properties/prp_missing', headers: auth });
    assert('读取不存在房源返回 404', notFound.statusCode === 404);

    // ---- 3. 照片上传 ----
    process.stdout.write('\n【3】照片上传与安全校验\n');
    const upload = multipartBody('cover.png', 'image/png', PNG_1X1);
    const mediaRes = await app.inject({
      method: 'POST',
      url: `/api/admin/properties/${propertyId}/media`,
      headers: { ...auth, 'content-type': upload.contentType },
      payload: upload.body,
    });
    assert('上传 PNG 成功', mediaRes.statusCode === 201, `status=${mediaRes.statusCode} ${mediaRes.body.slice(0, 160)}`);
    const media = JSON.parse(mediaRes.body) as { id: string; isCover: boolean; storageKey: string };
    assert('第一张照片自动成为封面', media.isCover === true);

    const fakeUpload = multipartBody('evil.png', 'image/png', Buffer.from('not really an image'));
    const fakeRes = await app.inject({
      method: 'POST',
      url: `/api/admin/properties/${propertyId}/media`,
      headers: { ...auth, 'content-type': fakeUpload.contentType },
      payload: fakeUpload.body,
    });
    assert('伪装成 PNG 的文本被拒绝', fakeRes.statusCode === 400, `status=${fakeRes.statusCode}`);

    // ---- 4. 发布与公开访问 ----
    process.stdout.write('\n【4】一键生成展示页\n');
    const listing = await app.inject({
      method: 'GET',
      url: `/api/admin/properties/${propertyId}/listing`,
      headers: auth,
    });
    const listingBody = JSON.parse(listing.body) as { page: { slug: string }; readiness: { ready: boolean }; qrSvg: string };
    assert('自动生成分享链接', listingBody.page.slug.length > 0, `slug=${listingBody.page.slug}`);
    assert('发布就绪检查通过', listingBody.readiness.ready === true);
    assert('返回二维码 SVG', typeof listingBody.qrSvg === 'string' && listingBody.qrSvg.includes('<svg'));

    const beforePublish = await app.inject({ method: 'GET', url: `/p/${listingBody.page.slug}` });
    assert('未发布时公开访问返回 404', beforePublish.statusCode === 404, `status=${beforePublish.statusCode}`);

    const publish = await app.inject({
      method: 'POST',
      url: `/api/admin/properties/${propertyId}/publish`,
      headers: auth,
    });
    assert('发布成功', publish.statusCode === 200, publish.body.slice(0, 200));

    const publicPage = await app.inject({ method: 'GET', url: `/p/${listingBody.page.slug}` });
    assert('发布后公开访问返回 200', publicPage.statusCode === 200);
    assert('页面包含房源标题', publicPage.body.includes('浦东新区精装两居室'));
    assert('页面包含价格', publicPage.body.includes('8,500'));
    assert('页面内联二维码', publicPage.body.includes('<svg'));
    assert('页面包含公开联系方式提示', publicPage.body.includes('联系方式'));
    assert('CSP 使用 nonce 而非 unsafe-inline', /nonce-/.test(publicPage.headers['content-security-policy'] as string ?? ''));

    // 修改房源后页面应立即同步（同一个数据源）
    await app.inject({
      method: 'PATCH',
      url: `/api/admin/properties/${propertyId}`,
      headers: auth,
      payload: { priceAmount: 9200 },
    });
    const updatedPage = await app.inject({ method: 'GET', url: `/p/${listingBody.page.slug}` });
    assert('修改房源后展示页同步更新', updatedPage.body.includes('9,200'));

    // ---- 5. 多语言 ----
    process.stdout.write('\n【5】多语言与原文保护\n');
    const translation = await app.inject({
      method: 'PUT',
      url: `/api/admin/properties/${propertyId}/translations`,
      headers: auth,
      payload: { locale: 'en', title: 'Bright 2-Bedroom in Pudong', description: 'Near Metro Line 2.' },
    });
    assert('保存英文译文成功', translation.statusCode === 201, translation.body.slice(0, 160));

    const enPage = await app.inject({ method: 'GET', url: `/p/${listingBody.page.slug}?lang=en` });
    assert('英文页面显示译文', enPage.body.includes('Bright 2-Bedroom in Pudong'));

    const detail = await app.inject({
      method: 'GET',
      url: `/api/admin/properties/${propertyId}`,
      headers: auth,
    });
    const detailBody = JSON.parse(detail.body) as { property: { description: string }; translations: unknown[] };
    assert('原文未被译文覆盖', detailBody.property.description.includes('近地铁 2 号线'));
    assert('译文独立保存', detailBody.translations.length === 1);

    const sameLocale = await app.inject({
      method: 'PUT',
      url: `/api/admin/properties/${propertyId}/translations`,
      headers: auth,
      payload: { locale: 'zh-CN', title: '试图覆盖原文', description: 'x' },
    });
    assert('拒绝用同语言译文覆盖原文', sameLocale.statusCode === 400);

    // ---- 6. 提醒（时间旅行） ----
    process.stdout.write('\n【6】第 7/15 天提醒（可控时间）\n');
    const reminders1 = await app.inject({ method: 'GET', url: '/api/admin/reminders', headers: auth });
    const remBody = JSON.parse(reminders1.body) as {
      items: { reminder: { id: string; kind: string; dueAt: string; timezone: string; status: string } }[];
    };
    assert('发布后生成两条提醒', remBody.items.length === 2, 'count=' + remBody.items.length);

    const d7 = remBody.items.find((i) => i.reminder.kind === 'check_day_7')?.reminder;
    const d15 = remBody.items.find((i) => i.reminder.kind === 'confirm_day_15')?.reminder;
    assert('包含第 7 天提醒', d7 !== undefined);
    assert('包含第 15 天提醒', d15 !== undefined);

    // 断言产品真正承诺的规则：**发布当地日历日 + N 天，时刻为该时区的当地 09:00**。
    //
    // 这里按「日历日 + 当地时刻」断言，而不是毫秒差 —— 后者会把
    // 「第 7 个日历日」错误地等同于「经过 168 小时」，从而在发布时刻晚于当地 09:00 时
    // 必然失败（一天中的大部分时间都如此）。规则本身没有变，是断言此前写错了。
    const publishedAt = new Date((JSON.parse(publish.body) as { page: { publishedAt: string } }).page.publishedAt);
    const tz = d7!.timezone;

    assert('提醒时区取自工作区配置', tz === 'Asia/Shanghai', tz);

    for (const [label, reminder, expectedDays] of [
      ['第 7 天', d7!, 7],
      ['第 15 天', d15!, 15],
    ] as const) {
      const due = new Date(reminder.dueAt);
      const local = toZonedParts(due, tz);
      const calendarDays = zonedCalendarDaysBetween(publishedAt, due, tz);

      assert(
        `${label}提醒的日期是发布后的第 ${expectedDays} 个日历日`,
        calendarDays === expectedDays,
        `实际相隔 ${calendarDays} 个日历日（当地 ${local.year}-${local.month}-${local.day}）`,
      );
      assert(
        `${label}提醒的时刻是该时区的当地 09:00`,
        local.hour === 9 && local.minute === 0 && local.second === 0,
        `当地 ${formatLocalTime(due, tz)}`,
      );
    }

    const day0Dispatch = await app.inject({ method: 'POST', url: '/api/admin/reminders/dispatch', headers: auth });
    assert('发布当天不发送提醒', JSON.parse(day0Dispatch.body).sent === 0, day0Dispatch.body.slice(0, 240));

    const advance6 = await app.inject({
      method: 'POST',
      url: '/api/admin/dev/advance-time',
      headers: auth,
      payload: { days: 6 },
    });
    assert('时间推进 6 天成功', advance6.statusCode === 200, advance6.body.slice(0, 160));

    const day6Dispatch = await app.inject({ method: 'POST', url: '/api/admin/reminders/dispatch', headers: auth });
    assert('第 6 天仍不发送', JSON.parse(day6Dispatch.body).sent === 0, 'body=' + day6Dispatch.body.slice(0, 240));

    // 把时钟拨到第 7 天提醒到期前 1 小时
    const beforeD7 = await app.inject({
      method: 'POST',
      url: '/api/admin/dev/advance-time',
      headers: auth,
      payload: { to: new Date(new Date(d7!.dueAt).getTime() - 3600000).toISOString() },
    });
    assert('时钟拨到第 7 天提醒到期前', beforeD7.statusCode === 200);
    const beforeD7Dispatch = await app.inject({ method: 'POST', url: '/api/admin/reminders/dispatch', headers: auth });
    assert('到期前不发送', JSON.parse(beforeD7Dispatch.body).sent === 0, 'body=' + beforeD7Dispatch.body.slice(0, 240));

    // 到达第 7 天计划时间之后 1 小时（当地 10:00，处于允许发送时段）
    await app.inject({
      method: 'POST',
      url: '/api/admin/dev/advance-time',
      headers: auth,
      payload: { to: new Date(new Date(d7!.dueAt).getTime() + 3600000).toISOString() },
    });
    const day7Dispatch = await app.inject({ method: 'POST', url: '/api/admin/reminders/dispatch', headers: auth });
    const day7Body = JSON.parse(day7Dispatch.body) as { sent: number; details: { kind: string }[] };
    assert('第 7 天发送第一次提醒', day7Body.sent === 1, day7Dispatch.body.slice(0, 320));
    assert('发送的是 D7 提醒', day7Body.details[0]?.kind === 'check_day_7');

    const repeatDispatch = await app.inject({ method: 'POST', url: '/api/admin/reminders/dispatch', headers: auth });
    assert(
      '重复扫描不会重复发送',
      JSON.parse(repeatDispatch.body).sent === 0,
      'body=' + repeatDispatch.body.slice(0, 240),
    );

    await app.inject({
      method: 'POST',
      url: '/api/admin/dev/advance-time',
      headers: auth,
      payload: { to: new Date(new Date(d15!.dueAt).getTime() + 3600000).toISOString() },
    });
    const day15Dispatch = await app.inject({ method: 'POST', url: '/api/admin/reminders/dispatch', headers: auth });
    const day15Body = JSON.parse(day15Dispatch.body) as { sent: number; details: { kind: string }[] };
    assert('第 15 天发送第二次提醒', day15Body.sent === 1, day15Dispatch.body.slice(0, 320));
    assert('发送的是 D15 提醒', day15Body.details[0]?.kind === 'confirm_day_15');

    // 关闭提醒后不再发送
    const d15Row = (JSON.parse(reminders1.body).items as { reminder: { id: string; kind: string } }[]).find(
      (i) => i.reminder.kind === 'confirm_day_15',
    );
    assert('D15 提醒已记录为完成', d15Row !== undefined);

    await app.inject({ method: 'POST', url: '/api/admin/dev/advance-time', headers: auth, payload: { reset: true } });


    // ---- 7. 导出 ----
    process.stdout.write('\n【7】静态 HTML 导出\n');
    const zipRes = await app.inject({
      method: 'GET',
      url: `/api/admin/properties/${propertyId}/export.zip`,
      headers: auth,
    });
    assert('导出 ZIP 成功', zipRes.statusCode === 200, `status=${zipRes.statusCode}`);
    assert('ZIP 为 application/zip', (zipRes.headers['content-type'] as string).includes('zip'));

    const entries = readZip(new Uint8Array(zipRes.rawPayload));
    const paths = entries.map((e) => e.path);
    assert('导出包含 index.html', paths.includes('index.html'));
    assert('导出包含说明文件', paths.includes('README.txt'));
    assert('导出包含媒体资源', paths.some((p) => p.startsWith('assets/')), paths.join(','));

    const exportedHtml = new TextDecoder().decode(entries.find((e) => e.path === 'index.html')!.data);
    assert('导出页面使用相对路径', exportedHtml.includes('assets/') && !exportedHtml.includes('/media/'));
    assert('导出页面不依赖管理后台', !exportedHtml.includes('/api/admin/'));

    // ---- 8. 备份与恢复 ----
    process.stdout.write('\n【8】备份与恢复演练\n');
    const backup = await app.inject({ method: 'POST', url: '/api/admin/backups', headers: auth });
    assert('创建备份成功', backup.statusCode === 201, backup.body.slice(0, 200));
    const backupFile = JSON.parse(backup.body).file as string;

    const verify = await app.inject({
      method: 'POST',
      url: '/api/admin/backups/verify',
      headers: auth,
      payload: { file: backupFile },
    });
    assert('备份校验通过', JSON.parse(verify.body).ok === true, verify.body.slice(0, 300));

    const restore = await app.inject({
      method: 'POST',
      url: '/api/admin/backups/restore-drill',
      headers: auth,
      payload: { file: backupFile },
    });
    assert('恢复演练成功', restore.statusCode === 200, restore.body.slice(0, 200));

    const restoreBody = JSON.parse(restore.body) as {
      restoredTables: Record<string, number>;
      restoredMediaFiles: number;
    };
    assert('恢复后房源行数一致', restoreBody.restoredTables['properties'] === 1, JSON.stringify(restoreBody.restoredTables));
    assert('恢复后媒体文件存在', restoreBody.restoredMediaFiles >= 1, `files=${restoreBody.restoredMediaFiles}`);
    assert('恢复后提醒行数一致', restoreBody.restoredTables['reminders'] === 2);

    // ---- 9. 撤下 ----
    process.stdout.write('\n【9】撤下与重复操作\n');
    const withdraw = await app.inject({
      method: 'POST',
      url: `/api/admin/properties/${propertyId}/withdraw`,
      headers: auth,
    });
    assert('撤下成功', withdraw.statusCode === 200);

    const afterWithdraw = await app.inject({ method: 'GET', url: `/p/${listingBody.page.slug}` });
    assert('撤下后公开访问返回 404', afterWithdraw.statusCode === 404);

    const republish = await app.inject({
      method: 'POST',
      url: `/api/admin/properties/${propertyId}/publish`,
      headers: auth,
    });
    assert('可以重复发布', republish.statusCode === 200);

    const withdrawAgain = await app.inject({
      method: 'POST',
      url: `/api/admin/properties/${propertyId}/withdraw`,
      headers: auth,
    });
    assert('可以重复撤下', withdrawAgain.statusCode === 200);

    // ---- 10. 归档与删除 ----
    process.stdout.write('\n【10】归档与级联删除\n');
    const archive = await app.inject({
      method: 'POST',
      url: `/api/admin/properties/${propertyId}/status`,
      headers: auth,
      payload: { status: 'archived' },
    });
    assert('归档成功', archive.statusCode === 200 && JSON.parse(archive.body).status === 'archived');

    const defaultList = await app.inject({ method: 'GET', url: '/api/admin/properties', headers: auth });
    assert('归档房源默认不出现在列表', JSON.parse(defaultList.body).total === 0);

    const withArchived = await app.inject({
      method: 'GET',
      url: '/api/admin/properties?includeArchived=true',
      headers: auth,
    });
    assert('可显式查询归档房源', JSON.parse(withArchived.body).total === 1);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/admin/properties/${propertyId}`,
      headers: auth,
    });
    assert('删除房源成功', del.statusCode === 200);

    const afterDelete = await app.inject({
      method: 'GET',
      url: `/api/admin/properties/${propertyId}`,
      headers: auth,
    });
    assert('删除后读取返回 404', afterDelete.statusCode === 404);

    const reminderAfterDelete = await app.inject({ method: 'GET', url: '/api/admin/reminders', headers: auth });
    assert('删除房源后提醒级联清理', JSON.parse(reminderAfterDelete.body).items.length === 0);

    // ---- 汇总 ----
    const failed = results.filter((r) => !r.ok);
    process.stdout.write(`\n========================================\n`);
    process.stdout.write(`共 ${results.length} 项检查，通过 ${results.length - failed.length} 项，失败 ${failed.length} 项\n`);

    if (failed.length > 0) {
      process.stdout.write(`失败项：\n${failed.map((f) => `  - ${f.name} ${f.detail}`).join('\n')}\n`);
      process.exitCode = 1;
    }
  } finally {
    await app.close();
    closeContext(ctx);
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // 清理失败不影响结论
    }
  }
}

main().catch((error: unknown) => {
  process.stdout.write(`\n冒烟测试中断：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});