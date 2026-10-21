/**
 * SQL 拼接与取值转换的公共辅助。
 *
 * 所有 SQL 都使用位置参数（?）绑定，绝不把用户输入拼进语句，
 * 避免注入风险（方案第八章安全检查项）。
 */

export type SqlValue = string | number | bigint | null | Uint8Array;

/** 把 JS 值转换为 SQLite 可接受的绑定值 */
export function toSqlValue(value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return value;
  if (value instanceof Date) return value.toISOString();
  // 对象与数组统一序列化为 JSON 字符串
  return JSON.stringify(value);
}

/**
 * 依据「字段名 -> 列名」映射生成 UPDATE 语句。
 * 只接受映射表中存在的字段，未知字段被静默忽略（而不是拼进 SQL）。
 */
export function buildUpdate(
  table: string,
  columns: Record<string, string>,
  patch: object,
  whereClause: string,
): { sql: string; values: SqlValue[] } {
  const source = patch as Record<string, unknown>;
  const sets: string[] = [];
  const values: SqlValue[] = [];

  for (const [field, column] of Object.entries(columns)) {
    if (!Object.hasOwn(source, field)) continue;
    sets.push(`${column} = ?`);
    values.push(toSqlValue(source[field]));
  }

  if (sets.length === 0) {
    return { sql: '', values: [] };
  }

  return {
    sql: `UPDATE ${table} SET ${sets.join(', ')} WHERE ${whereClause}`,
    values,
  };
}

/** 用于 LIKE 查询的转义，配合 ESCAPE '\' 使用 */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** 把用户输入拆成可用于 LIKE 的安全模式 */
export function likePattern(input: string): string {
  return `%${escapeLike(input.trim().toLowerCase())}%`;
}
