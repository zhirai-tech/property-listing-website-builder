/**
 * 备份与恢复接口（方案第 8 阶段验收：备份能够恢复）。
 */

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app-context.ts';
import { validationFailed } from '../../domain/errors.ts';
import {
  createBackup,
  listBackups,
  pruneBackups,
  restoreBackupToDirectory,
  verifyBackupFile,
} from '../../services/backup-service.ts';

export function registerAdminBackupRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/admin/backups', async () => ({
    items: await listBackups(ctx),
    retentionDays: ctx.config.backupRetentionDays,
    backupDir: ctx.config.backupDir,
  }));

  app.post('/api/admin/backups', async (_request, reply) => {
    const result = await createBackup(ctx);
    return reply.code(201).send(result);
  });

  app.post('/api/admin/backups/verify', async (request) => {
    const body = (request.body ?? {}) as { file?: unknown };
    const file = typeof body.file === 'string' ? body.file : '';

    if (file === '') throw validationFailed([{ field: 'file', message: '请提供备份文件路径' }]);

    return verifyBackupFile(ctx, file);
  });

  /** 恢复演练：解包到独立目录并逐表校验行数，不影响正在运行的数据 */
  app.post('/api/admin/backups/restore-drill', async (request) => {
    const body = (request.body ?? {}) as { file?: unknown; targetDir?: unknown };
    const file = typeof body.file === 'string' ? body.file : '';

    if (file === '') throw validationFailed([{ field: 'file', message: '请提供备份文件路径' }]);

    const targetDir =
      typeof body.targetDir === 'string' && body.targetDir.trim() !== ''
        ? body.targetDir
        : `${ctx.config.dataDir}/restore-drill`;

    return restoreBackupToDirectory(ctx, file, targetDir);
  });

  app.post('/api/admin/backups/prune', async () => pruneBackups(ctx));
}