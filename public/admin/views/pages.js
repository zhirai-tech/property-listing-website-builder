/**
 * 发布页面总览（方案第 2 阶段）。
 */

import { api } from '../api.js';
import { errorBlock, esc, fmtDateTime, tag, toast } from '../ui.js';

export async function render(container) {
  let data;
  try {
    data = await api.get('/api/admin/pages');
  } catch (error) {
    container.innerHTML = errorBlock(error);
    return;
  }

  const items = data.items ?? [];

  container.innerHTML = `
    <div class="page-head">
      <h2>发布页面</h2>
      <p class="muted small">每个房源最多一个展示页；页面内容始终从房源数据实时生成，不存在缓存副本。</p>
    </div>

    <div id="page-error"></div>

    <div class="card flush">
      <table class="list-table">
        <thead>
          <tr><th>房源</th><th>链接标识</th><th>状态</th><th>公开地址</th><th>浏览量</th><th>更新时间</th><th></th></tr>
        </thead>
        <tbody>
          ${
            items.length === 0
              ? '<tr><td colspan="7" class="muted">还没有发布页。请在房源详情中点击「发布页面」。</td></tr>'
              : items
                  .map(
                    (row) => `<tr>
                      <td data-label="房源">
                        <a href="#/properties/${esc(row.page.propertyId)}"><strong>${esc(row.propertyTitle)}</strong></a>
                        ${
                          row.readiness.blockers.length
                            ? `<div class="muted small text-warn">${esc(row.readiness.blockers[0])}</div>`
                            : ''
                        }
                      </td>
                      <td data-label="链接标识" class="mono">${esc(row.page.slug)}</td>
                      <td data-label="状态">${tag(row.page.status)}</td>
                      <td data-label="公开地址" class="mono small">${esc(row.publicUrl)}</td>
                      <td data-label="浏览量">${row.page.viewCount}</td>
                      <td data-label="更新时间" class="muted small">${esc(fmtDateTime(row.page.updatedAt))}</td>
                      <td class="actions">
                        <a class="btn small" href="${esc(row.publicUrl)}" target="_blank" rel="noopener">打开</a>
                        ${
                          row.page.status === 'published'
                            ? `<button class="btn small" data-action="withdraw" data-id="${esc(row.page.propertyId)}">撤下</button>`
                            : `<button class="btn small primary" data-action="publish" data-id="${esc(row.page.propertyId)}"${row.readiness.ready ? '' : ' disabled'}>发布</button>`
                        }
                      </td>
                    </tr>`,
                  )
                  .join('')
          }
        </tbody>
      </table>
    </div>
  `;

  container.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;

    const { action, id } = button.dataset;
    button.disabled = true;

    try {
      if (action === 'publish') {
        const result = await api.post(`/api/admin/properties/${id}/publish`);
        toast(`已发布：${result.publicUrl}`);
      } else {
        await api.post(`/api/admin/properties/${id}/withdraw`);
        toast('已撤下，公开访问返回 404');
      }
      await render(container);
    } catch (error) {
      container.querySelector('#page-error').innerHTML = errorBlock(error);
      button.disabled = false;
    }
  });
}