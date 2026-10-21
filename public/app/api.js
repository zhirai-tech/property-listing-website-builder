/**
 * 平台 API 封装。
 *
 * 统一处理三件事：
 *  - 带上 Cookie（同源请求，浏览器自动带，这里不额外处理）
 *  - 把服务端的错误结构翻译成可展示的中文
 *  - **任务幂等键**：每次 AI 调用生成一个 taskId 并复用，
 *    这样用户重复点按钮 / 刷新重放都会被服务端识别为同一任务，
 *    不会重复扣额度（服务端 ai_usage.task_id 有唯一约束）。
 */

export class ApiError extends Error {
  constructor(status, payload) {
    const message =
      payload?.error?.message ??
      payload?.message ??
      (status === 401 ? '登录状态已失效，请重新登录' : `请求失败（HTTP ${status}）`);
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.issues = payload?.error?.issues ?? [];
  }
}

async function request(method, url, body, extraHeaders = {}) {
  let response;
  try {
    // 只有真的有 body 时才声明 Content-Type。
    // 否则 DELETE 这类无 body 的请求会带一个 `Content-Type: application/json` 的空请求体，
    // 服务端的 JSON 解析器会因此报错 —— 实测中它一度表现为 500。
    // （服务端也已修正为对这类请求返回 400，但前端本来就不该这么发。）
    const headers = body === undefined
      ? { ...extraHeaders }
      : { 'Content-Type': 'application/json', ...extraHeaders };
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, { message: '无法连接服务器，请确认服务是否仍在运行' });
  }

  // 204 与空响应
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text.slice(0, 200) };
    }
  }

  if (!response.ok) throw new ApiError(response.status, payload);
  return payload;
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body, headers) => request('POST', url, body, headers),
  patch: (url, body) => request('PATCH', url, body),
  del: (url) => request('DELETE', url),
};

/** 生成一个任务幂等键 */
export function newTaskId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}