/**
 * 外部服务配置仓储（方案第四章第 7 条）。
 *
 * 安全约束：本表只保存非敏感配置与「密钥的环境变量名」，
 * 密钥本身永远不落库、不进前端、不进仓库。
 */

import type { Database } from '../database.ts';
import { asText, fromBool, nowIso, toBool } from '../database.ts';
import { newId } from '../../util/ids.ts';
import type { AdapterKind, ExternalServiceConfig } from '../../domain/types.ts';

const SELECT_COLUMNS = `
  id, workspace_id, adapter_kind, provider, config_json, secret_refs_json,
  enabled, free_tier_note, updated_at
`;

function parseJsonObject(raw: unknown): Record<string, string> {
  const text = asText(raw);
  if (text === '') return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        out[key] = typeof value === 'string' ? value : JSON.stringify(value);
      }
      return out;
    }
  } catch {
    // 配置损坏时返回空对象，避免整个后台打不开
  }
  return {};
}

function parseStringArray(raw: unknown): string[] {
  const text = asText(raw);
  if (text === '') return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    // 同上
  }
  return [];
}

export function mapExternalService(row: Record<string, unknown>): ExternalServiceConfig {
  return {
    id: asText(row['id']),
    workspaceId: asText(row['workspace_id']),
    adapterKind: asText(row['adapter_kind']) as AdapterKind,
    provider: asText(row['provider']),
    config: parseJsonObject(row['config_json']),
    secretRefs: parseStringArray(row['secret_refs_json']),
    enabled: toBool(row['enabled']),
    freeTierNote: asText(row['free_tier_note']),
    updatedAt: asText(row['updated_at']),
  };
}

export function listExternalServices(db: Database, workspaceId: string): ExternalServiceConfig[] {
  const rows = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM external_service_configs WHERE workspace_id = ? ORDER BY adapter_kind`)
    .all(workspaceId);
  return rows.map((row) => mapExternalService(row as Record<string, unknown>));
}

export function getExternalService(
  db: Database,
  workspaceId: string,
  adapterKind: AdapterKind,
): ExternalServiceConfig | null {
  const row = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM external_service_configs WHERE workspace_id = ? AND adapter_kind = ?`)
    .get(workspaceId, adapterKind);
  return row ? mapExternalService(row as Record<string, unknown>) : null;
}

export interface ExternalServiceInput {
  adapterKind: AdapterKind;
  provider: string;
  config: Record<string, string>;
  secretRefs: string[];
  enabled: boolean;
  freeTierNote: string;
}

export function upsertExternalService(
  db: Database,
  workspaceId: string,
  input: ExternalServiceInput,
): ExternalServiceConfig {
  const now = nowIso();
  const existing = getExternalService(db, workspaceId, input.adapterKind);

  if (existing) {
    db.prepare(
      `UPDATE external_service_configs
       SET provider = ?, config_json = ?, secret_refs_json = ?, enabled = ?, free_tier_note = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      input.provider,
      JSON.stringify(input.config),
      JSON.stringify(input.secretRefs),
      fromBool(input.enabled),
      input.freeTierNote,
      now,
      existing.id,
    );
  } else {
    db.prepare(
      `INSERT INTO external_service_configs (id, workspace_id, adapter_kind, provider, config_json,
                                             secret_refs_json, enabled, free_tier_note, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId('externalService'),
      workspaceId,
      input.adapterKind,
      input.provider,
      JSON.stringify(input.config),
      JSON.stringify(input.secretRefs),
      fromBool(input.enabled),
      input.freeTierNote,
      now,
    );
  }

  const result = getExternalService(db, workspaceId, input.adapterKind);
  if (!result) throw new Error('外部服务配置写入后读取失败');
  return result;
}
