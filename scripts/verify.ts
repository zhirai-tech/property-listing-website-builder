/**
 * 一键验收：起一个**临时环境**的服务，跑走查，然后关掉。
 *
 * 【解决什么问题】
 * 直接跑 `pnpm walkthrough` 要求你已经开了 `pnpm start` ——
 * 对不熟悉的人这是门槛，也没法放进 CI。这个脚本自己把环境准备好。
 *
 * 【为什么用临时目录与临时端口】
 * 走查会造账号、传图片、建备份。跑在**真实数据目录**上虽然会自清理，
 * 但一旦中途出问题就可能留下痕迹。用临时目录可以做到：
 * **无论成败，真实数据一行都不会被碰到。**
 *
 * 【关于 stdio】
 * 子进程的输出用 `ignore`（不通过管道捕获）。在受限环境下，
 * 用管道捕获子进程输出会直接失败；而且这里的服务日志对验收结论没有影响 ——
 * 真正需要看的输出（走查的检查清单）由子进程自己打到当前终端。
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const workDir = mkdtempSync(join(tmpdir(), 'walkthrough-verify-'));
const port = 3400 + Math.floor(Math.random() * 500);
const baseUrl = `http://127.0.0.1:${port}`;

let server: ReturnType<typeof spawn> | null = null;

/**
 * 关掉服务并删掉临时目录 —— 无论成败都要跑。
 *
 * 【为什么要等子进程退出】Windows 上如果服务进程还占着 SQLite 文件，
 * 删目录会失败。早先版本 kill 之后立刻删，结果是
 * **打印了「临时环境已清理」但目录其实还在**（6.8 MB），
 * 而失败被一个空 catch 吞掉了 —— 这正是「静默失效的清理」，
 * 用几次之后磁盘上就会堆一片临时目录。
 *
 * 【为什么清理失败要说话】清理失败不影响验收结论，但**必须让人知道** ——
 * 静默成功比明确失败更难查。
 */
async function cleanup(): Promise<void> {
  if (server && server.pid !== undefined) {
    const exited = new Promise<void>((resolve) => {
      server?.once('exit', () => resolve());
    });
    try {
      server.kill();
    } catch {
      // 已经退出
    }
    // 最多等 5 秒；超时也要往下走，不能把脚本卡住
    await Promise.race([exited, sleep(5000)]);
  }

  // 再给文件系统一点时间释放句柄
  await sleep(200);

  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch (error) {
    console.warn(
      `  ⚠ 临时目录未能删除：${workDir}`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function waitForHealth(timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.status === 200) return true;
    } catch {
      // 还没起来
    }
    await sleep(300);
  }
  return false;
}

async function main(): Promise<void> {
  console.log(`\n  一键验收：临时环境 ${workDir}`);
  console.log(`  服务端口 ${port}（与正在运行的实例互不干扰）\n`);

  // 【先播种】临时库是空的，而走查里有一组检查是针对**既有功能**的
  // （既有房源、展示页、提醒、多语言展示页）。没有数据它们必然失败，
  // 而那种失败是环境问题、不是缺陷 —— 会让走查的结论变得不可信。
  const tempEnv = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    DATA_DIR: workDir,
    DATABASE_FILE: join(workDir, 'app.sqlite'),
    UPLOAD_DIR: join(workDir, 'uploads'),
    BACKUP_DIR: join(workDir, 'backups'),
    PUBLIC_BASE_URL: baseUrl,
    NODE_ENV: 'test',
    ADMIN_PASSWORD: process.env.WALKTHROUGH_ADMIN_PASSWORD ?? 'walkthrough-temp-admin-pass',
  };

  const seeded = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/seed.ts'], {
      cwd: process.cwd(),
      stdio: 'ignore',
      env: tempEnv,
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
  if (seeded !== 0) {
    console.error(`✖ 临时环境播种失败（退出码 ${seeded}）。`);
    await cleanup();
    process.exit(1);
  }

  server = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', 'src/server.ts'],
    {
      cwd: process.cwd(),
      stdio: 'ignore',
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        DATA_DIR: workDir,
        DATABASE_FILE: join(workDir, 'app.sqlite'),
        UPLOAD_DIR: join(workDir, 'uploads'),
        BACKUP_DIR: join(workDir, 'backups'),
        PUBLIC_BASE_URL: baseUrl,
        NODE_ENV: 'test',
        // 临时环境里用固定口令，避免依赖调用方 shell 里的变量
        ADMIN_PASSWORD: process.env.WALKTHROUGH_ADMIN_PASSWORD ?? 'walkthrough-temp-admin-pass',
      },
    },
  );

  if (!(await waitForHealth())) {
    console.error(`✖ 临时服务未能在 20 秒内就绪（端口 ${port}）。\n`);
    await cleanup();
    process.exit(1);
  }

  // 跑走查 —— 子进程直接继承当前终端，输出原样可见
  const result = await new Promise<number>((resolve) => {
    const child = spawn(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', 'scripts/walkthrough.ts'],
      {
        cwd: process.cwd(),
        stdio: 'inherit',
        env: {
          ...process.env,
          WALKTHROUGH_BASE_URL: baseUrl,
          // 关键：让走查连**同一个临时库**。
          // 不传的话它会读 .env 连到真实库 —— 那样既不准确，
          // 也会往真实数据里写测试账号（违背这个脚本「不碰真实数据」的承诺）。
          WALKTHROUGH_DATABASE_FILE: join(workDir, 'app.sqlite'),
          WALKTHROUGH_BACKUP_DIR: join(workDir, 'backups'),
          ADMIN_PASSWORD: process.env.WALKTHROUGH_ADMIN_PASSWORD ?? 'walkthrough-temp-admin-pass',
        },
      },
    );
    child.on('exit', (code) => resolve(code ?? 1));
  });

  await cleanup();
  console.log(`  临时环境已清理（${workDir}）\n`);
  process.exit(result);
}

process.on('SIGINT', () => {
  void cleanup().finally(() => process.exit(130));
});

main().catch((error) => {
  console.error('\n一键验收脚本自身出错：', error);
  void cleanup().finally(() => process.exit(2));
});