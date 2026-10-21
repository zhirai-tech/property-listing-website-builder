/**
 * 插件契约。
 *
 * 平台不做「每种网页一个后台」，而是让插件声明：
 *   - 它是哪一类网页（pageType）
 *   - 它需要哪些字段（fields，驱动通用管理界面）
 *   - 它的页面由什么规格生成（specSchema）
 *   - 它需要平台提供哪些能力（capabilities）
 *
 * 【本阶段的边界】
 * 只落实**安全、可测试的基础契约**：
 *   - 插件以「清单 + 内置实现」注册，清单经过严格校验；
 *   - **不在主服务进程中执行任意上传的服务端代码**（见 registry.ts 的说明）。
 * 支持「上传即可运行任意服务端逻辑」的插件包属于后续阶段，
 * 现在不为了演示而做一个能执行任意代码的假接口。
 */

/** 网页类型标识，如 listing / profile / blog / minigame */
export type PageType = string;

/** 字段控件类型 —— 驱动通用管理界面渲染 */
export type FieldKind = 'text' | 'textarea' | 'number' | 'money' | 'select' | 'image' | 'images' | 'date';

/** 插件声明的可编辑字段 */
export interface PluginField {
  /** 字段键（在 spec 里的路径，支持 a.b 形式） */
  key: string;
  /** 显示名 */
  label: string;
  kind: FieldKind;
  required?: boolean;
  /** select 的选项 */
  options?: readonly string[];
  /** 上限（文本长度 / 数字最大值 / 图片张数） */
  max?: number;
  /** 提示文案 */
  hint?: string;
}

/** 平台能提供给插件的能力 —— 插件必须在清单里显式声明，未声明即不可用 */
export type PlatformCapability =
  | 'storage.read'
  | 'storage.write'
  | 'render.server'
  | 'ai.generate'
  | 'ai.revise'
  | 'hosting.publish'
  | 'media.upload';

/** 插件清单 */
export interface PluginManifest {
  /** 唯一标识，小写字母数字与连字符 */
  id: string;
  /** 显示名 */
  name: string;
  /** 语义化版本 */
  version: string;
  /** 它生成哪一类网页 */
  pageType: PageType;
  /** 一句话说明 */
  description: string;
  /** 可编辑字段（驱动通用管理界面） */
  fields: readonly PluginField[];
  /** 声明需要的能力 */
  capabilities: readonly PlatformCapability[];
  /** 依赖的平台能力契约版本 */
  apiVersion: number;
  /** 是否是平台内置插件（内置插件随代码走，不经过上传校验） */
  builtin: boolean;
  /**
   * 结构性键：**不可编辑但必须保留**的规格字段。
   *
   * 例如房源插件的 `propertyId` —— 用户不该在管理界面里改它，
   * 但规格净化时必须留下，否则项目就丢了「指向哪套房源」这个关键信息。
   * 不列在这里的键一律在保存时丢弃。
   */
  structuralKeys: readonly string[];
}

/**
 * 发布前内容校验的结果。
 *
 * 【为什么要有这个契约】
 * 「能不能发布」是**每个插件自己**的事：自定义页面要有一份可渲染的 HTML，
 * 房源项目要关联到一套真实房源。用一条通用规则去卡所有插件，
 * 要么放行空页面，要么误伤合法页面。
 *
 * 所以每个插件声明自己的发布校验，平台只负责在写版本之前调用它。
 */
export type PublishCheck = { ok: true } | { ok: false; message: string };

/** 当前平台契约版本。插件 apiVersion 不匹配则拒绝加载。 */
export const PLUGIN_API_VERSION = 1;

/** 允许的 id 形态：小写字母开头，只含小写字母/数字/连字符，2-40 字符 */
export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;

/** 语义化版本：major.minor.patch */
export const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

/** 清单校验失败时的具体原因 */
export interface ManifestIssue {
  field: string;
  message: string;
}

const ALLOWED_CAPABILITIES = new Set<PlatformCapability>([
  'storage.read',
  'storage.write',
  'render.server',
  'ai.generate',
  'ai.revise',
  'hosting.publish',
  'media.upload',
]);

const ALLOWED_FIELD_KINDS = new Set<FieldKind>([
  'text',
  'textarea',
  'number',
  'money',
  'select',
  'image',
  'images',
  'date',
]);

/**
 * 校验插件清单。
 *
 * 【安全要点】这是把「上传的东西」变成「可信东西」的唯一关口，
 * 因此宁可拒绝也不放行：未知能力、未知控件、非法 id / 版本、重名键一律拒绝。
 */
export function validateManifest(input: unknown): { ok: true; manifest: PluginManifest } | { ok: false; issues: ManifestIssue[] } {
  const issues: ManifestIssue[] = [];
  const push = (field: string, message: string) => issues.push({ field, message });

  if (typeof input !== 'object' || input === null) {
    return { ok: false, issues: [{ field: '(root)', message: '清单必须是一个对象' }] };
  }
  const raw = input as Record<string, unknown>;

  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!PLUGIN_ID_PATTERN.test(id)) {
    push('id', '插件 id 必须以小写字母开头，只含小写字母、数字与连字符，长度 2-40');
  }

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (name === '' || name.length > 60) push('name', '插件名称必填且不超过 60 字符');

  const version = typeof raw.version === 'string' ? raw.version : '';
  if (!SEMVER_PATTERN.test(version)) push('version', '版本必须是 major.minor.patch 形式');

  const pageType = typeof raw.pageType === 'string' ? raw.pageType.trim() : '';
  if (pageType === '' || pageType.length > 40) push('pageType', 'pageType 必填且不超过 40 字符');

  const apiVersion = raw.apiVersion;
  if (apiVersion !== PLUGIN_API_VERSION) {
    push('apiVersion', `契约版本不匹配：平台为 ${PLUGIN_API_VERSION}，插件声明 ${String(apiVersion)}`);
  }

  // 能力白名单
  const caps = Array.isArray(raw.capabilities) ? raw.capabilities : [];
  const capabilities: PlatformCapability[] = [];
  for (const c of caps) {
    if (typeof c !== 'string' || !ALLOWED_CAPABILITIES.has(c as PlatformCapability)) {
      push('capabilities', `未知能力：${String(c)}`);
      continue;
    }
    capabilities.push(c as PlatformCapability);
  }

  // 字段定义
  const rawFields = Array.isArray(raw.fields) ? raw.fields : [];
  const fields: PluginField[] = [];
  const seenKeys = new Set<string>();
  for (const [index, f] of rawFields.entries()) {
    if (typeof f !== 'object' || f === null) {
      push(`fields[${index}]`, '字段必须是对象');
      continue;
    }
    const fo = f as Record<string, unknown>;
    const key = typeof fo.key === 'string' ? fo.key.trim() : '';
    if (key === '' || key.length > 80) {
      push(`fields[${index}].key`, '字段 key 必填且不超过 80 字符');
      continue;
    }
    // 键不得重复 —— 否则通用管理界面会渲染出两个绑定同一数据的控件
    if (seenKeys.has(key)) {
      push(`fields[${index}].key`, `字段 key 重复：${key}`);
      continue;
    }
    // 拒绝可疑键：不允许原型污染式的路径
    if (key.includes('__proto__') || key.includes('prototype') || key.includes('constructor')) {
      push(`fields[${index}].key`, `字段 key 含非法片段：${key}`);
      continue;
    }
    seenKeys.add(key);

    const kind = fo.kind;
    if (typeof kind !== 'string' || !ALLOWED_FIELD_KINDS.has(kind as FieldKind)) {
      push(`fields[${index}].kind`, `未知控件类型：${String(kind)}`);
      continue;
    }

    const label = typeof fo.label === 'string' ? fo.label.trim() : '';
    if (label === '') push(`fields[${index}].label`, '字段 label 必填');

    const field: PluginField = {
      key,
      label: label || key,
      kind: kind as FieldKind,
      required: fo.required === true,
    };
    if (Array.isArray(fo.options)) {
      field.options = fo.options.filter((o): o is string => typeof o === 'string');
    }
    if (typeof fo.max === 'number' && Number.isFinite(fo.max) && fo.max >= 0) field.max = fo.max;
    if (typeof fo.hint === 'string') field.hint = fo.hint.slice(0, 200);
    fields.push(field);
  }

  const description = typeof raw.description === 'string' ? raw.description.trim() : '';

  const rawStructural = Array.isArray(raw.structuralKeys) ? raw.structuralKeys : [];
  const structuralKeys: string[] = [];
  for (const k of rawStructural) {
    if (typeof k !== 'string' || k.trim() === '') {
      push('structuralKeys', `结构性键必须是字符串：${String(k)}`);
      continue;
    }
    const key = k.trim();
    if (key.includes('__proto__') || key.includes('prototype') || key.includes('constructor')) {
      push('structuralKeys', `结构性键含非法片段：${key}`);
      continue;
    }
    if (seenKeys.has(key)) {
      push('structuralKeys', `结构性键与可编辑字段重名：${key}`);
      continue;
    }
    structuralKeys.push(key);
  }

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    manifest: {
      id,
      name,
      version,
      pageType,
      description: description.slice(0, 200),
      fields,
      capabilities,
      apiVersion: PLUGIN_API_VERSION,
      builtin: raw.builtin === true,
      structuralKeys,
    },
  };
}