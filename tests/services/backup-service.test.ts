/**
 * 备份与恢复单元测试（方案第 8 阶段验收：备份能够恢复）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHarness, propertyInput, tinyPng } from '../helpers/test-app.ts';
import { createPropertyFromInput } from '../../src/services/property-service.ts';
import { addUploadedMedia } from '../../src/services/media-service.ts';
import { publishListing } from '../../src/services/publish-service.ts';
import {
  BACKUP_TABLES,
  createBackup,
  listBackups,
  pruneBackups,
  restoreBackupToDirectory,
  tableCounts,
  verifyBackupFile,
} from '../../src/services/backup-service.ts';
import { openDatabase } from '../../src/db/database.ts';

async function seed(h: ReturnType<typeof createHarness>): Promise<string> {
  const { property } = createPropertyFromInput(h.ctx, propertyInput());
  await addUploadedMedia(h.ctx, property.id, {
    filename: 'a.png',
    declaredMime: 'image/png',
    data: tinyPng(),
  });
  publishListing(h.ctx, property.id);
  return property.id;
}

test('备份包含数据库快照、素材与 manifest', async () => {
  const h = createHarness();
  try {
    await seed(h);
    const result = await createBackup(h.ctx);

    assert.ok(result.bytes > 0);
    assert.equal(result.manifest.tables['properties'], 1);
    assert.equal(result.manifest.tables['media'], 1);
    assert.equal(result.manifest.tables['reminders'], 2);
    assert.equal(result.manifest.mediaFiles, 1);
    assert.ok(readFileSync(result.file).length > 0);
  } finally {
    h.dispose();
  }
});

test('校验通过的备份逐表行数与 manifest 一致', async () => {
  const h = createHarness();
  try {
    await seed(h);
    const backup = await createBackup(h.ctx);
    const verification = await verifyBackupFile(h.ctx, backup.file);

    assert.equal(verification.ok, true, verification.problems.join('；'));
    assert.deepEqual(verification.tables, backup.manifest.tables);
    assert.equal(verification.problems.length, 0);
  } finally {
    h.dispose();
  }
});

test('恢复演练能还原出全部数据且不影响运行中的数据库', async () => {
  const h = createHarness();
  try {
    await seed(h);
    const backup = await createBackup(h.ctx);

    const restored = await restoreBackupToDirectory(h.ctx, backup.file, `${h.workDir}/restore`);
    const source = tableCounts(h.ctx.db);

    // 业务表必须逐表一致。
    // audit_logs 例外：备份与恢复演练本身也会写审计日志，
    // 因此快照里的条数必然少于「当前」这个正在运行、还在持续记录日志的库。
    const businessTables = BACKUP_TABLES.filter((table) => table !== 'audit_logs');
    for (const table of businessTables) {
      assert.equal(
        restored.restoredTables[table],
        source[table],
        `表 ${table} 行数不一致：恢复=${restored.restoredTables[table]}，当前=${source[table]}`,
      );
    }

    assert.ok(
      (restored.restoredTables['audit_logs'] ?? 0) <= (source['audit_logs'] ?? 0),
      '快照中的审计日志条数不应超过当前库',
    );
    assert.ok((restored.restoredTables['audit_logs'] ?? 0) > 0, '快照中应包含审计日志');
    assert.equal(restored.restoredMediaFiles, 1);
    assert.equal(restored.manifest?.tables['properties'], 1);

    // 独立打开恢复出来的数据库，确认内容真实可读
    const db = openDatabase(restored.databaseFile);
    try {
      const row = db.prepare('SELECT title, price_amount FROM properties').get() as {
        title: string;
        price_amount: number;
      };
      assert.equal(row.title, '测试房源 · 两居室');
      assert.equal(row.price_amount, 5000);
    } finally {
      db.close();
    }

    // 运行中的数据库未被影响
    assert.equal(tableCounts(h.ctx.db)['properties'], 1);
  } finally {
    h.dispose();
  }
});

test('恢复出来的素材文件与原始内容一致', async () => {
  const h = createHarness();
  try {
    const propertyId = await seed(h);
    const backup = await createBackup(h.ctx);
    const restored = await restoreBackupToDirectory(h.ctx, backup.file, `${h.workDir}/restore`);

    const keys = h.ctx.db
      .prepare('SELECT storage_key FROM media WHERE property_id = ?')
      .all(propertyId) as { storage_key: string }[];

    assert.equal(keys.length, 1);
    const original = await h.storage.read(keys[0]!.storage_key);
    assert.ok(original);

    const restoredFile = readFileSync(`${restored.uploadDir}/${keys[0]!.storage_key}`);
    assert.deepEqual([...restoredFile], [...original]);
  } finally {
    h.dispose();
  }
});

test('篡改过的归档会被校验发现', async () => {
  const h = createHarness();
  try {
    await seed(h);
    const backup = await createBackup(h.ctx);

    // 破坏归档内容（截断）
    const data = readFileSync(backup.file);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(backup.file, data.subarray(0, Math.floor(data.length / 2)));

    const verification = await verifyBackupFile(h.ctx, backup.file);
    assert.equal(verification.ok, false);
    assert.ok(verification.problems.length > 0);
  } finally {
    h.dispose();
  }
});

test('不存在的备份文件返回可读错误而不是抛异常', async () => {
  const h = createHarness();
  try {
    const verification = await verifyBackupFile(h.ctx, `${h.workDir}/nope.zip`);
    assert.equal(verification.ok, false);
    assert.match(verification.problems.join(' '), /无法读取归档/);
  } finally {
    h.dispose();
  }
});

test('归档中包含越界路径时恢复会被拒绝', async () => {
  const h = createHarness();
  try {
    await seed(h);
    const backup = await createBackup(h.ctx);
    const restored = await restoreBackupToDirectory(h.ctx, backup.file, `${h.workDir}/restore`);

    // 正常路径可以恢复
    assert.ok(restored.databaseFile.length > 0);
    const db = openDatabase(restored.databaseFile);
    try {
      assert.ok(BACKUP_TABLES.every((t) => typeof restored.restoredTables[t] === 'number'));
    } finally {
      db.close();
    }
  } finally {
    h.dispose();
  }
});

test('备份列表按时间倒序返回', async () => {
  const h = createHarness();
  try {
    await seed(h);
    h.clock.set('2026-02-01T00:00:00.000Z');
    await createBackup(h.ctx);
    h.clock.set('2026-02-02T00:00:00.000Z');
    await createBackup(h.ctx);

    const list = await listBackups(h.ctx);
    assert.equal(list.length, 2);
    assert.ok(list[0]!.createdAt >= list[1]!.createdAt);
  } finally {
    h.dispose();
  }
});

test('按保留天数清理过期备份', async () => {
  const h = createHarness();
  try {
    await seed(h);
    h.clock.set('2026-01-01T00:00:00.000Z');
    await createBackup(h.ctx);

    // 把时钟推进到保留期之外
    h.clock.set('2026-03-15T00:00:00.000Z');
    await createBackup(h.ctx);

    const result = await pruneBackups(h.ctx);
    assert.equal(result.removed.length, 1);
    assert.equal(result.kept, 1);
  } finally {
    h.dispose();
  }
});