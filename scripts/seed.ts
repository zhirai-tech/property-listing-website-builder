/**
 * 演示数据初始化（pnpm seed）。
 *
 * 照片来自 `demo/photos/`，全部为 **CC0 / 公共领域** 授权的真实照片
 * （经 Wikimedia Commons 的 Unsplash 导入集合取得），
 * 每张照片都会把完整署名与来源写入素材的「来源/授权说明」字段，
 * 便于在任何时候核对素材授权（方案第三章第 2 条、第八章第 1 条）。
 *
 * 不使用任何自动生成的占位图，也不用无授权的网络图片。
 */

import { readFileSync, existsSync } from 'node:fs';
import { loadConfig, ensureRuntimeDirs } from '../src/config.ts';
import { closeContext, createAppContext } from '../src/app-context.ts';
import { createPropertyFromInput } from '../src/services/property-service.ts';
import { addUploadedMedia } from '../src/services/media-service.ts';
import { insertContact } from '../src/db/repositories/contact-repo.ts';
import { ensureListingPage, publishListing } from '../src/services/publish-service.ts';
import { saveTranslation } from '../src/services/i18n-service.ts';
import { listProperties } from '../src/db/repositories/property-repo.ts';

interface Attribution {
  file: string;
  room: string;
  title: string;
  license: string;
  artist: string;
  sourcePage: string;
}

const PHOTO_DIR = 'demo/photos';

function loadAttribution(): Map<string, Attribution> {
  const path = `${PHOTO_DIR}/ATTRIBUTION.json`;
  if (!existsSync(path)) return new Map();

  const list = JSON.parse(readFileSync(path, 'utf8')) as Attribution[];
  return new Map(list.map((item) => [item.file, item]));
}

/** 生成可核对的素材来源说明 */
function sourceNoteFor(meta: Attribution | undefined, room: string): string {
  if (!meta) return `类别：${room}（未找到署名信息）`;
  const artist = meta.artist && meta.artist !== '' ? `，作者：${meta.artist}` : '';
  return `${room} · ${meta.license} · 来源：Wikimedia Commons${artist} · ${meta.title} · ${meta.sourcePage}`;
}

const DEMO = [
  {
    photos: ['p1-01-living.jpg', 'p1-02-dining.jpg', 'p1-03-bedroom.jpg', 'p1-04-bathroom.jpg', 'p1-05-building.jpg'],
    form: {
      title: '浦东新区精装两居室 · 近地铁 2 号线',
      description:
        '世纪大道核心地段，步行 6 分钟到 2 号线地铁站。\n\n全屋精装，家电齐全，南向客厅带落地窗，采光极佳。小区 24 小时安保，配套健身房与地下车库。\n\n拎包入住，适合上班族与小家庭。',
      addressLine: '世纪大道 100 号 3 号楼 1502 室',
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
      floorNote: '15/28 层有电梯',
      priceAmount: 8500,
      priceCurrency: 'CNY',
      pricePeriod: 'per_month',
      depositAmount: 17000,
      depositCurrency: 'CNY',
      extraFeesNote: '物业费 380 元/月由租客承担；水电燃气按实际用量结算。',
      availableFrom: '2026-11-01',
      status: 'active',
    },
    contacts: [
      { displayName: '张女士', channelKind: 'phone', channelValue: '+86 138 0000 1234', isPublic: true },
      { displayName: '张女士', channelKind: 'wechat', channelValue: 'zhang_rent_sh', isPublic: true },
    ],
    publish: true,
    /** 0 = 保持最新；>0 表示把「最后更新时间」往前推，用于演示「未确认」状态 */
    staleDays: 0,
    availabilityStatus: 'available' as const,
    translation: {
      locale: 'en',
      title: 'Bright 2-Bedroom near Metro Line 2, Pudong',
      description:
        'Prime location on Century Avenue, a 6-minute walk to Metro Line 2.\n\nFully furnished with south-facing floor-to-ceiling windows. 24h security, gym and underground parking.\n\nMove-in ready; ideal for professionals and small families.',
    },
  },
  {
    photos: ['p2-01-living.jpg', 'p2-02-dining.jpg', 'p2-03-balcony.jpg', 'p2-04-detail.jpg', 'p2-05-street.jpg'],
    form: {
      title: '目黒区 静かな住宅街の 1LDK',
      description:
        '目黒駅から徒歩 8 分、閑静な住宅街の 1LDK。\n\n南向きバルコニー付きで日当たり良好。独立洗面台・浴室乾燥機完備。\n\nコンビニとスーパーが徒歩 2 分圏内。',
      addressLine: '目黒区目黒 2-10-5 メゾン目黒 302',
      district: '目黒区',
      city: '東京都',
      region: '東京都',
      countryCode: 'JP',
      postalCode: '153-0063',
      latitude: 35.6330,
      longitude: 139.6987,
      propertyType: 'apartment',
      bedrooms: 1,
      bathrooms: 1,
      areaValue: 42.3,
      areaUnit: 'square_meter',
      floorNote: '3/5 階',
      priceAmount: 168000,
      priceCurrency: 'JPY',
      pricePeriod: 'per_month',
      depositAmount: 168000,
      depositCurrency: 'JPY',
      extraFeesNote: '共益費 8,000 円/月、敷金 1 ヶ月、礼金 1 ヶ月。仲介手数料は別途。',
      availableFrom: '2026-12-01',
      status: 'active',
    },
    contacts: [{ displayName: '佐藤', channelKind: 'email', channelValue: 'sato@example.jp', isPublic: true }],
    publish: true,
    staleDays: 45,
    availabilityStatus: 'available' as const,
    translation: null,
  },
  {
    photos: ['p3-01-exterior.jpg', 'p3-02-terrace.jpg', 'p3-03-living.jpg', 'p3-04-balcony.jpg', 'p3-05-street.jpg'],
    form: {
      title: '里斯本 Alfama 老城区三居室联排（带露台）',
      description:
        '位于里斯本历史城区 Alfama 的传统联排住宅，2024 年整体翻新。\n\n三间卧室、两间卫浴，私人露台可看特茹河景。步行 2 分钟到电车车站。\n\n可长租，条件合适也接受短租。',
      addressLine: 'Rua dos Remédios 88, Alfama',
      district: 'Alfama',
      city: 'Lisboa',
      region: 'Lisboa',
      countryCode: 'PT',
      postalCode: '1100-585',
      latitude: 38.7139,
      longitude: -9.1269,
      propertyType: 'townhouse',
      bedrooms: 3,
      bathrooms: 2,
      areaValue: 1450,
      areaUnit: 'square_foot',
      floorNote: '两层 + 屋顶露台',
      priceAmount: 2400,
      priceCurrency: 'EUR',
      pricePeriod: 'per_month',
      depositAmount: 4800,
      depositCurrency: 'EUR',
      extraFeesNote: '水电费不含在内；IMI 与物业费由房东承担。',
      availableFrom: '2026-11-15',
      // 这套演示数据是会发布的，内部状态就不要停留在「草稿」，否则与发布页自相矛盾
      status: 'active',
    },
    contacts: [
      { displayName: 'Maria', channelKind: 'whatsapp', channelValue: '+351 910 000 000', isPublic: true },
      { displayName: 'Maria', channelKind: 'email', channelValue: 'maria@example.pt', isPublic: false },
    ],
    publish: true,
    staleDays: 0,
    availabilityStatus: 'rented' as const,
    translation: {
      locale: 'en',
      title: 'Charming 3-Bedroom Townhouse in Alfama, Lisbon',
      description:
        'Traditional Lisbon townhouse in the historic Alfama district, fully renovated in 2024.\n\nThree bedrooms, two bathrooms, private terrace with river views. Tram stop 2 minutes away.\n\nAvailable for long-term rent; short-term lets considered.',
    },
  },
];

async function main(): Promise<void> {
  const config = loadConfig();
  ensureRuntimeDirs(config);

  const ctx = createAppContext({ config });

  try {
    const existing = listProperties(ctx.db, { workspaceId: ctx.workspace.id, limit: 1 });
    if (existing.total > 0 && process.env['SEED_FORCE'] !== 'true') {
      process.stdout.write(
        `数据库中已有 ${existing.total} 条房源，跳过初始化以避免重复数据。\n` +
          '如需重新初始化，请先删除 var/db/app.sqlite，或设置 SEED_FORCE=true。\n',
      );
      return;
    }

    const attribution = loadAttribution();
    if (attribution.size === 0) {
      process.stdout.write(`警告：未找到 ${PHOTO_DIR}/ATTRIBUTION.json，照片将不带署名信息。\n`);
    }

    process.stdout.write(`工作区：${ctx.workspace.name}\n数据库：${config.databaseFile}\n\n`);

    for (const demo of DEMO) {
      const created = createPropertyFromInput(ctx, {
        ...demo.form,
        availabilityStatus: demo.availabilityStatus,
      });
      const propertyId = created.property.id;
      let uploaded = 0;

      for (const file of demo.photos) {
        const path = `${PHOTO_DIR}/${file}`;
        if (!existsSync(path)) {
          process.stdout.write(`  [警告] 缺少照片文件：${path}\n`);
          continue;
        }
        const meta = attribution.get(file);
        await addUploadedMedia(ctx, propertyId, {
          filename: file,
          declaredMime: 'image/jpeg',
          data: new Uint8Array(readFileSync(path)),
          sourceNote: sourceNoteFor(meta, meta?.room ?? '房源照片'),
        });
        uploaded++;
      }

      for (const contact of demo.contacts) {
        insertContact(ctx.db, ctx.workspace.id, propertyId, {
          displayName: contact.displayName,
          channelKind: contact.channelKind as 'phone' | 'email' | 'chat' | 'wechat' | 'whatsapp' | 'telegram' | 'other',
          channelValue: contact.channelValue,
          isPublic: contact.isPublic,
          sortOrder: 0,
        });
      }

      if (demo.translation) {
        saveTranslation(ctx, propertyId, {
          locale: demo.translation.locale,
          title: demo.translation.title,
          description: demo.translation.description,
        });
      }

      // 演示用：把最后更新时间往前推，使该房源在展示页显示为「未确认」。
      // 必须放在所有写操作之后，否则会被后续更新覆盖。
      if (demo.staleDays > 0) {
        const past = new Date(
          ctx.adapters.clock.now().getTime() - demo.staleDays * 86_400_000,
        ).toISOString();
        ctx.db.prepare('UPDATE properties SET updated_at = ? WHERE id = ?').run(past, propertyId);
      }

      const page = ensureListingPage(ctx, propertyId);

      if (demo.publish) {
        const result = publishListing(ctx, propertyId);
        process.stdout.write(
          `[完成] 已发布：${demo.form.title}\n   照片 ${uploaded} 张 · 可租状态：${demo.availabilityStatus}` +
            `${demo.staleDays > 0 ? `（已 ${demo.staleDays} 天未更新 → 展示为「未确认」）` : ''}\n   分享链接：${result.publicUrl}\n`,
        );
        if (result.warnings.length > 0) process.stdout.write(`   提示：${result.warnings.join('；')}\n`);
      } else {
        process.stdout.write(`[完成] 已创建（未发布）：${demo.form.title}\n   照片 ${uploaded} 张 · 待发布标识：${page.slug}\n`);
      }
    }

    process.stdout.write(`\n演示数据初始化完成（照片全部为 CC0 授权的真实照片）。\n`);
    process.stdout.write(`后台入口：${config.publicBaseUrl}/admin/\n`);
  } finally {
    closeContext(ctx);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`初始化失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});