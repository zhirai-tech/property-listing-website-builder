/**
 * 设置：工作区默认值、适配器状态、外部服务配置边界、审计日志。
 */

import { api } from '../api.js';
import { errorBlock, esc, field, fmtDateTime, readForm, toast } from '../ui.js';

export async function render(container) {
  let view;
  try {
    view = await api.get('/api/admin/settings');
  } catch (error) {
    container.innerHTML = errorBlock(error);
    return;
  }

  const ws = view.workspace;
  const cfg = view.config;

  container.innerHTML = `
    <div class="page-head">
      <h2>设置</h2>
      <p class="muted small">默认语言、币种、面积单位与时区都作用于新建房源与展示页格式。</p>
    </div>

    <div id="settings-error"></div>

    <div class="card">
      <h3>工作区</h3>
      <form id="workspace-form">
        <div class="grid form">
          ${field({ label: '工作区名称', name: 'name', value: ws.name, required: true })}
          ${field({ label: '默认语言', name: 'defaultLocale', value: ws.defaultLocale, hint: '也是房源「原文」的语言' })}
          ${field({ label: '默认币种', name: 'defaultCurrency', value: ws.defaultCurrency, hint: 'ISO 4217，例如 CNY / USD / EUR' })}
          ${field({ label: '默认面积单位', name: 'defaultAreaUnit', value: ws.defaultAreaUnit, options: view.areaUnits.map((u) => ({ value: u, label: u === 'square_meter' ? '平方米' : '平方英尺' })) })}
          ${field({ label: '默认时区', name: 'defaultTimezone', value: ws.defaultTimezone, hint: 'IANA 时区，例如 Asia/Shanghai；提醒规则按此时区计算' })}
        </div>
        <button class="btn primary mt" type="submit">保存设置</button>
      </form>
    </div>

    <div class="card">
      <h3>外部服务适配层</h3>
      <p class="muted small">
        所有外部服务都通过适配器接入，可替换服务商而不改动业务代码。密钥只允许通过环境变量注入，
        界面上只显示「是否已设置」。
      </p>
      <table class="mt">
        <thead><tr><th>能力</th><th>当前适配器</th><th>配置来源</th></tr></thead>
        <tbody>
          <tr><td>地图</td><td class="mono">${esc(view.adapters.map)}</td><td class="muted small">${esc(cfg.map.tileUrl || '已关闭')}</td></tr>
          <tr><td>存储</td><td class="mono">${esc(view.adapters.storage)}</td><td class="muted small">上传目录 ${esc(cfg.databaseFile ? '' : '')}</td></tr>
          <tr><td>邮件</td><td class="mono">${esc(view.adapters.mail)}</td><td class="muted small">SMTP 主机：${esc(cfg.mail.smtpHost || '未配置（console 模式仅写日志）')}</td></tr>
          <tr><td>托管</td><td class="mono">${esc(view.adapters.hosting)}</td><td class="muted small">CNAME 目标：${esc(cfg.hosting.cnameTarget)}</td></tr>
          <tr><td>DNS 验证</td><td class="mono">${esc(view.adapters.dns)}</td><td class="muted small">TXT 前缀：${esc(cfg.hosting.domainVerifyPrefix)}</td></tr>
        </tbody>
      </table>
      ${
        cfg.map.freeTierNote
          ? `<div class="alert info mt"><strong>地图免费额度提示：</strong>${esc(cfg.map.freeTierNote)}</div>`
          : ''
      }
      ${externalServiceForm(view)}
    </div>

    <div class="card">
      <h3>提醒配置</h3>
      <p class="muted small">${esc(view.reminders.note)}</p>
      <div class="stats mt">
        <div class="stat"><span class="k">第 1 次提醒</span><span class="v">${view.reminders.day1} 天</span></div>
        <div class="stat"><span class="k">第 2 次提醒</span><span class="v">${view.reminders.day2} 天</span></div>
        <div class="stat"><span class="k">最大重试</span><span class="v">${view.reminders.maxAttempts} 次</span></div>
      </div>
    </div>

    <div class="card">
      <div class="spread">
        <h3>审计日志</h3>
        <button class="btn small" id="btn-audit">刷新</button>
      </div>
      <div id="audit-body"><p class="muted">点击刷新以加载最近操作记录。</p></div>
    </div>
  `;

  container.querySelector('#workspace-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = readForm(event.target);
    try {
      await api.patch('/api/admin/settings', values);
      toast('设置已保存');
      await render(container);
    } catch (error) {
      container.querySelector('#settings-error').innerHTML = errorBlock(error);
    }
  });

  container.querySelector('#btn-audit').addEventListener('click', async () => {
    const box = container.querySelector('#audit-body');
    box.innerHTML = '<p class="muted">加载中…</p>';
    try {
      const audit = await api.get('/api/admin/audit?limit=60');
      box.innerHTML = `<table><thead><tr><th>时间</th><th>操作</th><th>对象</th><th>详情</th></tr></thead><tbody>
        ${audit.items
          .map(
            (entry) => `<tr>
              <td class="small">${esc(fmtDateTime(entry.at))}</td>
              <td class="mono small">${esc(entry.action)}</td>
              <td class="mono small">${esc(entry.entityType)}<br>${esc(entry.entityId.slice(0, 18))}</td>
              <td class="muted small mono">${esc(entry.detail.slice(0, 120))}</td>
            </tr>`,
          )
          .join('')}
      </tbody></table>`;
    } catch (error) {
      box.innerHTML = errorBlock(error);
    }
  });

  container.querySelector('#external-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const values = readForm(form);

    const config = {};
    form.querySelectorAll('[data-config-key]').forEach((input) => {
      const key = input.dataset.configKey;
      if (key && input.value) config[key] = input.value;
    });

    const secretRefs = (values.secretRefs ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    try {
      await api.put('/api/admin/external-services', {
        adapterKind: values.adapterKind,
        provider: values.provider,
        config,
        secretRefs,
        freeTierNote: values.freeTierNote,
      });
      toast('外部服务配置已保存');
      await render(container);
    } catch (error) {
      container.querySelector('#settings-error').innerHTML = errorBlock(error);
    }
  });
}

function externalServiceForm(view) {
  const existing = view.externalServices ?? [];

  return `
    <details class="mt">
      <summary>高级：登记外部服务配置（不会保存密钥）</summary>
      <form id="external-form" class="mt">
        <div class="grid form">
          ${field({
            label: '适配器类型',
            name: 'adapterKind',
            value: 'map',
            options: view.adapters
              ? [
                  { value: 'map', label: '地图' },
                  { value: 'storage', label: '存储' },
                  { value: 'mail', label: '邮件' },
                  { value: 'hosting', label: '托管' },
                ]
              : [],
          })}
          ${field({ label: '服务商标识', name: 'provider', value: 'osm', required: true, hint: '例如 osm / mapbox / s3 / console' })}
          ${field({ label: '密钥环境变量名', name: 'secretRefs', value: '', hint: '多个用英文逗号分隔，例如 MAP_API_KEY。这里填变量名，不是密钥本身。' })}
          ${field({ label: '免费额度说明', name: 'freeTierNote', value: '', type: 'textarea' })}
        </div>
        <div class="field">
          <span>非敏感配置</span>
          <input type="text" data-config-key="tileUrl" placeholder="tileUrl = https://…/{z}/{x}/{y}.png">
          <div class="hint">可登记瓦片地址、CNAME 目标等公开配置；任何疑似密钥的字段会被服务端拒绝。</div>
        </div>
        <button class="btn mt" type="submit">保存配置</button>
      </form>
      ${
        existing.length
          ? `<table class="mt"><thead><tr><th>类型</th><th>服务商</th><th>密钥引用</th><th>更新时间</th></tr></thead><tbody>
              ${existing
                .map(
                  (item) => `<tr>
                    <td>${esc(item.adapterKind)}</td>
                    <td class="mono">${esc(item.provider)}</td>
                    <td class="mono small">${esc((item.secretRefs ?? []).join(', ') || '无')}</td>
                    <td class="muted small">${esc(fmtDateTime(item.updatedAt))}</td>
                  </tr>`,
                )
                .join('')}
            </tbody></table>`
          : ''
      }
    </details>
  `;
}