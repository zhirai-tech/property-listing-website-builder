/**
 * 多语言服务（方案第三章第 7 条、第 5 阶段验收）。
 *
 * 验收要点：
 *  - 切换语言不丢失数据；
 *  - 原始描述不被翻译覆盖 —— 译文写入独立表，原文永远只存在于 properties；
 *  - 货币/日期/面积格式按配置显示（由 domain/i18n 统一实现）。
 */

import type { AppContext } from '../app-context.ts';
import { validationFailed } from '../domain/errors.ts';
import type { PropertyTranslation } from '../domain/types.ts';
import { SUPPORTED_LOCALES } from '../domain/i18n.ts';
import { Validator } from '../domain/validate.ts';
import {
  deleteTranslation,
  listTranslations,
  upsertTranslation,
} from '../db/repositories/translation-repo.ts';
import { recordAudit } from './audit-service.ts';
import { requireProperty } from './property-service.ts';
import type { LocaleLink } from '../render/page-renderer.ts';

export function listPropertyTranslations(ctx: AppContext, propertyId: string): PropertyTranslation[] {
  requireProperty(ctx, propertyId);
  return listTranslations(ctx.db, propertyId);
}

/** 保存（新增或覆盖）某语言的译文；原文完全不受影响 */
export function saveTranslation(
  ctx: AppContext,
  propertyId: string,
  raw: Record<string, unknown>,
): PropertyTranslation {
  requireProperty(ctx, propertyId);

  const v = new Validator();
  const locale = v.locale(raw['locale'], 'locale', '语言', ctx.workspace.defaultLocale);
  const title = v.str(raw['title'], 'title', '译文标题', { required: true, max: 200 });
  const description = v.text(raw['description'], 'description', '译文描述', { max: 20000 });
  v.done();

  if (locale.toLowerCase() === ctx.workspace.defaultLocale.toLowerCase()) {
    throw validationFailed([
      {
        field: 'locale',
        message: `原文语言为 ${ctx.workspace.defaultLocale}，请通过编辑房源修改原文，而不是添加同语言译文`,
      },
    ]);
  }

  const saved = upsertTranslation(ctx.db, propertyId, locale, title, description);

  recordAudit(ctx, {
    action: 'translation.save',
    entityType: 'property',
    entityId: propertyId,
    detail: { locale, titleLength: title.length, descriptionLength: description.length },
  });

  return saved;
}

export function removeTranslation(ctx: AppContext, propertyId: string, locale: string): boolean {
  requireProperty(ctx, propertyId);
  const removed = deleteTranslation(ctx.db, propertyId, locale);

  if (removed) {
    recordAudit(ctx, {
      action: 'translation.delete',
      entityType: 'property',
      entityId: propertyId,
      detail: { locale },
    });
  }
  return removed;
}

/** 展示页语言切换链接：原文语言 + 已有译文语言 */
export function buildLocaleLinks(
  ctx: AppContext,
  propertyId: string,
  current: string,
): LocaleLink[] {
  const origin = ctx.workspace.defaultLocale;
  const translationLocales = listTranslations(ctx.db, propertyId).map((t) => t.locale);

  const tags = new Set<string>([origin, ...translationLocales, current]);
  const labelOf = (tag: string): string =>
    SUPPORTED_LOCALES.find((l) => l.tag.toLowerCase() === tag.toLowerCase())?.label ?? tag;

  return [...tags]
    .filter((tag) => tag !== '')
    .map((tag) => ({
      tag,
      label: labelOf(tag),
      current: tag.toLowerCase() === current.toLowerCase(),
    }));
}
