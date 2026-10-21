/**
 * 手动执行一次提醒投递扫描（pnpm reminders）。
 *
 * 用途：
 *  - 在没有常驻服务或需要立即补投时使用；
 *  - 验收提醒规则时可配合 DEV_TIME_TRAVEL 把业务时间拨到第 7/15 天后再执行本脚本。
 */

import { loadConfig, ensureRuntimeDirs } from '../src/config.ts';
import { closeContext, createAppContext } from '../src/app-context.ts';
import { dispatchDueReminders, resolveRecipient } from '../src/services/reminder-service.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  ensureRuntimeDirs(config);

  const ctx = createAppContext({ config });

  try {
    const recipient = resolveRecipient(ctx);

    process.stdout.write(`工作区：${ctx.workspace.name}\n`);
    process.stdout.write(`当前业务时间：${ctx.adapters.clock.now().toISOString()}\n`);
    process.stdout.write(`提醒时区：${ctx.workspace.defaultTimezone}\n`);
    process.stdout.write(`收件人：${recipient.email || '（未配置）'}（来源：${recipient.source}）\n`);
    process.stdout.write(`邮件适配器：${ctx.adapters.mail.name}\n\n`);

    if (recipient.email === '') {
      process.stdout.write(
        '提示：未配置提醒收件邮箱。请在 .env 中设置 REMINDER_RECIPIENT 或 OWNER_EMAIL，\n' +
          '否则提醒会被记录为「发送失败」。\n\n',
      );
    }

    const report = await dispatchDueReminders(ctx);

    process.stdout.write(
      `扫描 ${report.considered} 条：发送 ${report.sent}、失败 ${report.failed}、` +
        `停止重试 ${report.gaveUp}、跳过 ${report.skipped}、稍后重试 ${report.retryLater}\n`,
    );

    if (report.recipientWarning) {
      process.stdout.write(`警告：${report.recipientWarning}\n`);
    }

    for (const detail of report.details) {
      process.stdout.write(`  - [${detail.outcome}] ${detail.propertyTitle} / ${detail.kind}：${detail.message}\n`);
    }

    if (report.considered === 0) {
      process.stdout.write(
        '\n当前没有到期的提醒。若要在验收时直接观察第 7/15 天规则，\n' +
          '可设置 DEV_TIME_TRAVEL=true 后启动服务，在后台「发布提醒」中把业务时间拨到计划时刻。\n',
      );
    }
  } finally {
    closeContext(ctx);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`提醒投递失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
