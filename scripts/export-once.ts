/** 直接调用导出服务重新生成导出目录（用于复核离线导出结果） */
import { loadConfig, ensureRuntimeDirs } from '../src/config.ts';
import { closeContext, createAppContext } from '../src/app-context.ts';
import { exportListingToDirectory } from '../src/services/export-service.ts';

const config = loadConfig();
ensureRuntimeDirs(config);

const ctx = createAppContext({ config });
try {
  const propertyId = process.argv[2];
  if (!propertyId) throw new Error('用法：node scripts/export-once.ts <房源ID>');
  const result = await exportListingToDirectory(ctx, propertyId, {
    outDir: `${config.dataDir}/exports/${propertyId}`,
  });
  console.log(`导出 ${result.files.length} 个文件到 ${result.outDir}`);
  for (const file of result.files) console.log('  ' + file);
} finally {
  closeContext(ctx);
}