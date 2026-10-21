/**
 * 后台 API 客户端。
 * 统一处理：JSON 序列化、错误对象转中文提示、401 跳登录。
 */

export class ApiError extends Error {
  constructor(message, { code = 'UNKNOWN', issues = [], status = 0 } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.issues = issues;
    this.status = status;
  }
}

async function request(path, options = {}) {
  const init = {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    headers: { ...(options.headers ?? {}) },
  };

  if (options.body !== undefined && !(options.body instanceof FormData)) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  } else if (options.body instanceof FormData) {
    init.body = options.body;
  }

  let response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    throw new ApiError('无法连接服务器，请确认服务是否仍在运行', { code: 'NETWORK' });
  }

  if (response.status === 204) return null;

  const contentType = response.headers.get('content-type') ?? '';
  const isJson = contentType.includes('application/json');
  const payload = isJson ? await response.json().catch(() => null) : await response.text();

  if (!response.ok) {
    const error = isJson && payload && payload.error ? payload.error : null;
    throw new ApiError(error?.message ?? `请求失败（HTTP ${response.status}）`, {
      code: error?.code ?? 'HTTP_ERROR',
      issues: error?.issues ?? [],
      status: response.status,
    });
  }

  return payload;
}

export const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: 'POST', body }),
  patch: (path, body) => request(path, { method: 'PATCH', body }),
  put: (path, body) => request(path, { method: 'PUT', body }),
  del: (path) => request(path, { method: 'DELETE' }),
  upload: (path, formData) => request(path, { method: 'POST', body: formData }),
};