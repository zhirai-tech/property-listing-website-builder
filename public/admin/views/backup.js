/**
 * 备份与恢复（方案第 8 阶段验收：备份能够恢复）。
 */

import { api } from '../api.js';
import { errorBlock, esc, fmtBytes, fmtDateTime, toast } from '../ui.js';

export async function render(container) {
  let view;
  try {
    view = await api.get('/api/admin/backups');
  } catch (error) {
    container.innerHTML = errorBlock(error);
    return;
  }

  const items = view.items ?? [];

  container.innerHTML = `
    <div class="page-head">
      <h2>备份与恢复</h2>
      <p class="muted small">
        备份包内含 SQLite 一致性快照（VACUUM INTO）与全部上传素材。
        恢复演练会解包到独立目录并逐表校验行数，不影响正在运行的数据。
      </p>
    </div>

    <div id="backup-error"></div>

    <div class="card tight">
      <div class="row spread">
        <span class="muted small">备份目录：<span class="mono">${esc(view.backupDir)}</span> · 保留 ${view.retentionDays} 天</span>
        <div class="row">
          <button class="btn primary" id="btn-create">立即备份</button>
          <button class="btn" id="btn-prune">清理过期备份</button>
        </div>
      </div>
    </div>

    <div class="card flush">
      <table class="list-table">
        <thead><tr><th>备份文件</th><th>大小</th><th>创建时间</th><th></th></tr></thead>
        <tbody>
          ${
            items.length === 0
              ? '<tr><td colspan="4" class="muted">还没有备份。</td></tr>'
              : items
                  .map(
                    (item) => `<tr>
                      <td data-label="备份文件" class="mono small">${esc(item.file.split(/[\\/]/).pop())}</td>
                      <td data-label="大小">${esc(fmtBytes(item.bytes))}</td>
                      <td data-label="创建时间" class="muted small">${esc(fmtDateTime(item.createdAt))}</td>
                      <td class="actions">
                        <button class="btn small" data-backup="verify" data-file="${esc(item.file)}">校验</button>
                        <button class="btn small" data-backup="restore" data-file="${esc(item.file)}">恢复演练</button>
                      </td>
                    </tr>`,
                  )
                  .join('')
          }
        </tbody>
      </table>
    </div>

    <div id="backup-result"></div>
  `;

  container.querySelector('#btn-create').addEventListener('click', async (event) => {
    event.target.disabled = true;
    event.target.textContent = '备份中…';
    try {
      const result = await api.post('/api/admin/backups');
      toast(`备份完成：${fmtBytes(result.bytes)}`);
      await render(container);
    } catch (error) {
      container.querySelector('#backup-error').innerHTML = errorBlock(error);
      event.target.disabled = false;
      event.target.textContent = '立即备份';
    }
  });

  container.querySelector('#btn-prune').addEventListener('click', async () => {
    try {
      const result = await api.post('/api/admin/backups/prune');
      toast(`已删除 ${result.removed.length} 个过期备份，保留 ${result.kept} 个`);
      await render(container);
    } catch (error) {
      toast(error?.message ?? '清理失败', 'error');
    }
  });

  container.querySelector('tbody').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-backup]');
    if (!button) return;

    const file = button.dataset.file;
    const box = container.querySelector('#backup-result');
    box.innerHTML = '<p class="muted">处理中…</p>';

    try {
      if (button.dataset.backup === 'verify') {
        const result = await api.post('/api/admin/backups/verify', { file });
        box.innerHTML = result.ok
          ? `<div class="alert ok"><strong>校验通过。</strong>表行数：<span class="mono">${esc(
              JSON.stringify(result.tables),
            )}</span></div>`
          : `<div class="alert error"><strong>校验未通过：</strong><ul class="issues">${result.problems
              .map((p) => `<li>${esc(p)}</li>`)
              .join('')}</ul></div>`;
      } else {
        const result = await api.post('/api/admin/backups/restore-drill', { file });
        box.innerHTML = `<div class="alert ok">
          <strong>恢复演练成功。</strong><br>
          恢复目录：<span class="mono">${esc(result.targetDir)}</span><br>
          数据文件：<span class="mono">${esc(result.databaseFile)}</span><br>
          素材文件：${result.restoredMediaFiles} 个<br>
          表行数：<span class="mono">${esc(JSON.stringify(result.restoredTables))}</span>
        </div>`;
      }
    } catch (error) {
      box.innerHTML = errorBlock(error);
    }
  });
}