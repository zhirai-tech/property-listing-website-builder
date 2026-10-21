/**
 * 发布提醒（方案第 7 阶段）：规则展示、手工投递、可控时间演示。
 */

import { api } from '../api.js';
import { errorBlock, esc, fmtDateTime, fmtDateTimeInZone, statusLabel, tag, toast } from '../ui.js';

function travelPanel(view, enabled) {
  const next = view.nextPending;

  const jumpBlock = next
    ? `<div class="alert info">
        下一条待处理提醒：<strong>${esc(next.label)}</strong>（${esc(next.propertyTitle)}），
        计划时间 ${esc(fmtDateTimeInZone(next.dueAt, next.timezone))}（${esc(next.timezone)}）。
      </div>
      <div class="row">
        <button class="btn primary" data-travel-to="${esc(next.dispatchAt)}">跳到该提醒时间并保持当地上午</button>
      </div>`
    : '<p class="muted small">当前没有待处理的提醒。</p>';

  if (!enabled) {
    return `<div class="alert info">「时间旅行」未启用。它用于在浏览器中直接验证第 7/15 天提醒规则，
      无需真实等待。启用方式：在 <span class="mono">.env</span> 中设置
      <span class="mono">DEV_TIME_TRAVEL=true</span> 后重启服务（生产环境自动禁用）。</div>`;
  }

  return `<div class="card">
    <h3>时间旅行（演示与验收专用）</h3>
    <p class="muted small">
      当前业务时间：<span class="mono" id="clock-now">${esc(fmtDateTime(view.now))}</span>（浏览器本地时区）。
      推进时间后再点击「立即投递」，即可观察提醒是否按规则发出。
    </p>
    ${jumpBlock}
    <div class="row mt">
      <button class="btn" data-travel="1">+1 天</button>
      <button class="btn" data-travel="7">+7 天</button>
      <button class="btn" data-travel="8">+8 天</button>
      <button class="btn" data-travel="15">+15 天</button>
      <button class="btn ghost" data-travel="reset">重置为真实时间</button>
    </div>
  </div>`;
}

export async function render(container) {
  let view;
  try {
    view = await api.get('/api/admin/reminders');
  } catch (error) {
    container.innerHTML = errorBlock(error);
    return;
  }

  const items = view.items ?? [];
  const cfg = view.config;

  container.innerHTML = `
    <div class="page-head">
      <h2>发布提醒</h2>
      <p class="muted small">发布后第 ${cfg.day1} 天提醒检查房源，第 ${cfg.day2} 天提醒确认或更新。</p>
    </div>

    <div id="reminder-error"></div>

    <div class="stats">
      <div class="stat"><span class="k">提醒规则</span><span class="v sm">第 ${cfg.day1} / ${cfg.day2} 天</span></div>
      <div class="stat"><span class="k">时区</span><span class="v sm">${esc(cfg.timezone)}</span></div>
      <div class="stat"><span class="k">收件人</span><span class="v xs">${esc(cfg.recipient || '未配置')}</span></div>
    </div>

    ${
      cfg.recipient
        ? ''
        : `<div class="alert warn">未配置提醒收件邮箱。请在 <span class="mono">.env</span> 中设置
            <span class="mono">REMINDER_RECIPIENT</span> 或 <span class="mono">OWNER_EMAIL</span>，
            否则提醒会被记录为「发送失败」。</div>`
    }

    <div id="travel-slot">${travelPanel(view, view.timeTravel?.enabled)}</div>

    <div class="card">
      <div class="spread">
        <h3>提醒列表（${items.length}）</h3>
        <button class="btn primary" id="btn-dispatch">立即投递</button>
      </div>
      <div id="dispatch-result"></div>
      <table class="mt list-table">
        <thead>
          <tr><th>房源</th><th>提醒类型</th><th>计划时间</th><th>状态</th><th>尝试</th><th>最后错误</th><th></th></tr>
        </thead>
        <tbody>
          ${
            items.length === 0
              ? '<tr><td colspan="7" class="muted">暂无提醒。发布房源后会自动生成。</td></tr>'
              : items
                  .map(
                    (row) => `<tr>
                      <td data-label="房源"><a href="#/properties/${esc(row.reminder.propertyId)}">${esc(row.propertyTitle)}</a></td>
                      <td data-label="提醒类型">${esc(row.label)}</td>
                      <td data-label="计划时间" class="small">${esc(fmtDateTimeInZone(row.reminder.dueAt, row.reminder.timezone))}<div class="muted">${esc(row.reminder.timezone)}</div></td>
                      <td data-label="状态">${tag(row.reminder.status)}</td>
                      <td data-label="尝试次数">${row.reminder.attempts}</td>
                      <td data-label="最后错误" class="muted small">${esc(row.reminder.lastError ?? '-')}</td>
                      <td class="actions">
                        ${
                          row.reminder.status === 'pending'
                            ? `<button class="btn small" data-rem-action="complete" data-id="${esc(row.reminder.id)}">标记完成</button>
                               <button class="btn small" data-rem-action="skip" data-id="${esc(row.reminder.id)}">关闭提醒</button>`
                            : `<button class="btn small" data-rem-action="reopen" data-id="${esc(row.reminder.id)}">重新启用</button>`
                        }
                      </td>
                    </tr>`,
                  )
                  .join('')
          }
        </tbody>
      </table>
    </div>

    <div class="card">
      <h3>规则说明</h3>
      <p class="muted small">${esc(cfg.editableNote)}</p>
      <p class="muted small">最大重试次数：${cfg.maxAttempts}；发送时段为当地 09:00–20:00，避免深夜打扰；
      展示页撤下后，未发送的提醒会自动关闭。</p>
    </div>
  `;

  container.querySelector('#btn-dispatch').addEventListener('click', async () => {
    const box = container.querySelector('#dispatch-result');
    box.innerHTML = '<p class="muted">投递中…</p>';

    try {
      const report = await api.post('/api/admin/reminders/dispatch');

      // 先刷新列表，再把结果写回新渲染出来的容器，否则提示会被立刻覆盖掉
      await render(container);

      const freshBox = container.querySelector('#dispatch-result');
      if (freshBox) {
        const detail = report.details
          .map((d) => `<li>${esc(d.propertyTitle)} · ${esc(d.kind)} → ${esc(d.message)}</li>`)
          .join('');

        freshBox.innerHTML = `<div class="alert ${report.sent > 0 ? 'ok' : 'info'}">
          <strong>本次扫描 ${report.considered} 条</strong>：发送 ${report.sent}、失败 ${report.failed}、
          停止重试 ${report.gaveUp}、跳过 ${report.skipped}、稍后重试 ${report.retryLater}。
          ${report.recipientWarning ? `<br>${esc(report.recipientWarning)}` : ''}
          ${detail ? `<ul class="issues">${detail}</ul>` : ''}
        </div>`;
      }
    } catch (error) {
      box.innerHTML = errorBlock(error);
    }
  });

  container.querySelector('#travel-slot').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-travel], button[data-travel-to]');
    if (!button) return;

    const value = button.dataset.travel;
    const target = button.dataset.travelTo;
    try {
      const result =
        target
          ? await api.post('/api/admin/dev/advance-time', { to: target })
          : value === 'reset'
            ? await api.post('/api/admin/dev/advance-time', { reset: true })
            : await api.post('/api/admin/dev/advance-time', { days: Number(value) });
      toast(`业务时间已更新为 ${fmtDateTime(result.now)}`);
      await render(container);
    } catch (error) {
      toast(error?.message ?? '时间调整失败', 'error');
    }
  });

  container.querySelector('tbody').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-rem-action]');
    if (!button) return;

    const { remAction, id } = button.dataset;
    try {
      await api.post(`/api/admin/reminders/${id}/${remAction}`);
      toast(`已${statusLabel(remAction === 'complete' ? 'completed' : remAction === 'skip' ? 'skipped' : 'pending')}`);
      await render(container);
    } catch (error) {
      toast(error?.message ?? '操作失败', 'error');
    }
  });
}