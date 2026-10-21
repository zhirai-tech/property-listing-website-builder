/**
 * OpenAI 兼容 Provider 的测试。
 *
 * 【测试方式】起一个**本地假上游**（真实的 node:http 服务），
 * 让 provider 真的发 HTTP 请求过去。这样验证的是真实的网络链路：
 * 请求体、认证头、超时、非 2xx、响应解析。
 *
 * **全程不向任何真实供应商发请求，不花一分钱。**
 * 假上游返回的用量是我们写死的数字，因此可以精确断言台账记了多少。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import {
  AiProviderError,
  createOpenAiCompatibleProvider,
  parsePatch,
  readUsage,
} from '../../src/platform/ai/openai-provider.ts';
import { createProviderFromConfig } from '../../src/platform/ai/provider-factory.ts';
import { createListingProject, createTestApp, registerUser } from '../helpers/test-app.ts';
import { runAiTask } from '../../src/platform/projects.ts';

interface FakeUpstream {
  url: string;
  /** 收到的请求体 */
  requests: { path: string; auth: string | undefined; body: Record<string, unknown> }[];
  close: () => Promise<void>;
}

/**
 * 起一个假上游。
 * @param handler 决定这一次返回什么（状态码 + 响应体 + 可选延迟）
 */
async function startFakeUpstream(
  handler: (callIndex: number) => {
    status?: number;
    body?: unknown;
    rawBody?: string;
    delayMs?: number;
    contentType?: string;
  },
): Promise<FakeUpstream> {
  const requests: FakeUpstream['requests'] = [];
  let callIndex = 0;

  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      try {
        requests.push({
          path: req.url ?? '',
          auth: req.headers['authorization'] as string | undefined,
          body: raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>),
        });
      } catch {
        requests.push({ path: req.url ?? '', auth: req.headers['authorization'] as string | undefined, body: {} });
      }

      const plan = handler(callIndex);
      callIndex += 1;

      const send = (): void => {
        res.statusCode = plan.status ?? 200;
        res.setHeader('Content-Type', plan.contentType ?? 'application/json');
        if (plan.rawBody !== undefined) res.end(plan.rawBody);
        else res.end(JSON.stringify(plan.body ?? {}));
      };

      if (plan.delayMs && plan.delayMs > 0) setTimeout(send, plan.delayMs);
      else send();
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** 一份标准的成功响应 */
function okBody(content: string, usage: Record<string, number> | null = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 }) {
  return {
    choices: [{ message: { content } }],
    ...(usage === null ? {} : { usage }),
  };
}

const baseInput = {
  taskId: 'task-1',
  kind: 'generate' as const,
  prompt: 'title: 阳光两居',
  fields: [{ key: 'title', label: '标题', kind: 'text' }],
  maxOutputTokens: 1000,
};

// ---------------------------------------------------------------------------

test('成功调用：补丁被解析，用量与上游返回的数字完全一致', async () => {
  const upstream = await startFakeUpstream(() => ({ body: okBody('{"title":"阳光两居"}') }));
  try {
    const provider = createOpenAiCompatibleProvider({
      baseUrl: upstream.url,
      apiKey: 'test-key-not-real',
      model: 'test-model',
      timeoutMs: 3000,
    });

    const result = await provider.call(baseInput);

    assert.equal(result.patch['title'], '阳光两居');
    // 用量必须**逐字段等于**上游返回的数字，不能是估算
    assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 30, totalTokens: 150, costMicros: 0 });
    assert.equal(result.provider, 'openai-compatible');
    assert.equal(result.model, 'test-model');

    // 请求确实打到了正确的路径，且带了认证头
    assert.equal(upstream.requests.length, 1);
    assert.equal(upstream.requests[0]?.path, '/v1/chat/completions');
    assert.equal(upstream.requests[0]?.auth, 'Bearer test-key-not-real');
    assert.equal(upstream.requests[0]?.body['model'], 'test-model');
  } finally {
    await upstream.close();
  }
});

test('非 2xx 响应：抛出 http 类错误并带上状态码，不产出任何用量', async () => {
  const upstream = await startFakeUpstream(() => ({
    status: 429,
    body: { error: { message: 'rate limited' } },
  }));
  try {
    const provider = createOpenAiCompatibleProvider({
      baseUrl: upstream.url, apiKey: 'k', model: 'm', timeoutMs: 3000,
    });

    await assert.rejects(
      () => provider.call(baseInput),
      (error: unknown) => {
        assert.ok(error instanceof AiProviderError);
        assert.equal(error.kind, 'http');
        assert.equal(error.status, 429);
        return true;
      },
    );
  } finally {
    await upstream.close();
  }
});

test('上游超时：抛出 timeout 类错误（不会挂住）', async () => {
  const upstream = await startFakeUpstream(() => ({ body: okBody('{}'), delayMs: 2000 }));
  try {
    const provider = createOpenAiCompatibleProvider({
      baseUrl: upstream.url, apiKey: 'k', model: 'm', timeoutMs: 300,
    });

    const started = Date.now();
    await assert.rejects(
      () => provider.call(baseInput),
      (error: unknown) => {
        assert.ok(error instanceof AiProviderError);
        assert.equal(error.kind, 'timeout');
        return true;
      },
    );
    // 确实是被超时打断的，而不是等到上游返回
    assert.ok(Date.now() - started < 1500, '应在超时时间内返回');
  } finally {
    await upstream.close();
  }
});

test('上游不返回 usage：默认视为失败（不放行无法计费的调用）', async () => {
  const upstream = await startFakeUpstream(() => ({ body: okBody('{"title":"x"}', null) }));
  try {
    const provider = createOpenAiCompatibleProvider({
      baseUrl: upstream.url, apiKey: 'k', model: 'm', timeoutMs: 3000,
      // requireUsage 缺省即 true
    });

    await assert.rejects(
      () => provider.call(baseInput),
      (error: unknown) => {
        assert.ok(error instanceof AiProviderError);
        assert.equal(error.kind, 'usage_missing');
        return true;
      },
    );
  } finally {
    await upstream.close();
  }
});

test('上游不返回 usage 且显式关掉 requireUsage：记 0 而不是编一个数字', async () => {
  const upstream = await startFakeUpstream(() => ({ body: okBody('{"title":"x"}', null) }));
  try {
    const provider = createOpenAiCompatibleProvider({
      baseUrl: upstream.url, apiKey: 'k', model: 'm', timeoutMs: 3000,
      requireUsage: false,
    });

    const result = await provider.call(baseInput);
    assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: 0 });
  } finally {
    await upstream.close();
  }
});

test('模型输出不是 JSON：抛 protocol 错误，不产出补丁', async () => {
  const upstream = await startFakeUpstream(() => ({ body: okBody('好的，我已经帮你改好了。') }));
  try {
    const provider = createOpenAiCompatibleProvider({
      baseUrl: upstream.url, apiKey: 'k', model: 'm', timeoutMs: 3000,
    });

    await assert.rejects(
      () => provider.call(baseInput),
      (error: unknown) => {
        assert.ok(error instanceof AiProviderError);
        assert.equal(error.kind, 'protocol');
        return true;
      },
    );
  } finally {
    await upstream.close();
  }
});

test('响应体不是 JSON：抛 protocol 错误而不是崩在解析上', async () => {
  const upstream = await startFakeUpstream(() => ({ rawBody: '<html>502 Bad Gateway</html>', contentType: 'text/html' }));
  try {
    const provider = createOpenAiCompatibleProvider({
      baseUrl: upstream.url, apiKey: 'k', model: 'm', timeoutMs: 3000,
    });

    await assert.rejects(
      () => provider.call(baseInput),
      (error: unknown) => {
        assert.ok(error instanceof AiProviderError);
        assert.equal(error.kind, 'protocol');
        return true;
      },
    );
  } finally {
    await upstream.close();
  }
});

test('超长输出被 max_tokens 约束（请求体里带上限）', async () => {
  const upstream = await startFakeUpstream(() => ({ body: okBody('{}') }));
  try {
    const provider = createOpenAiCompatibleProvider({
      baseUrl: upstream.url, apiKey: 'k', model: 'm', timeoutMs: 3000,
    });
    await provider.call({ ...baseInput, maxOutputTokens: 777 });
    assert.equal(upstream.requests[0]?.body['max_tokens'], 777);
  } finally {
    await upstream.close();
  }
});

// ---- 纯函数 ----

test('readUsage：各家字段差异都能处理，全缺则返回 null', () => {
  assert.deepEqual(readUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }), {
    inputTokens: 10, outputTokens: 5, totalTokens: 15, costMicros: 0,
  });
  // 只有 total 也能用
  assert.deepEqual(readUsage({ total_tokens: 42 }), {
    inputTokens: 0, outputTokens: 0, totalTokens: 42, costMicros: 0,
  });
  // total 缺失时用 prompt+completion 补齐
  assert.deepEqual(readUsage({ prompt_tokens: 7, completion_tokens: 3 }), {
    inputTokens: 7, outputTokens: 3, totalTokens: 10, costMicros: 0,
  });
  // 全缺 → null（调用方据此决定失败）
  assert.equal(readUsage({}), null);
  assert.equal(readUsage(undefined), null);
  // 负数与 NaN 视为无效
  assert.equal(readUsage({ prompt_tokens: -5 }), null);
  assert.equal(readUsage({ total_tokens: Number.NaN }), null);
});

test('parsePatch：能取出被代码块包裹的 JSON，取不到返回 null', () => {
  assert.deepEqual(parsePatch('{"a":1}'), { a: 1 });
  assert.deepEqual(parsePatch('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parsePatch('```\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parsePatch('前置说明 {"a":1} 后置说明'), { a: 1 });
  // 数组不是合法的「补丁对象」
  assert.equal(parsePatch('[1,2,3]'), null);
  assert.equal(parsePatch('随便一段话'), null);
  assert.equal(parsePatch(null), null);
  assert.equal(parsePatch(123), null);
});

test('端到端：真实 HTTP 上游返回的用量被原样记进台账并扣减额度', async () => {
  // 起一个本地假上游 —— **不向任何真实供应商发请求**
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        choices: [{ message: { content: '{"title":"来自假上游的标题","priceAmount":7654}' } }],
        // 这三个数字必须原样出现在台账里
        usage: { prompt_tokens: 234, completion_tokens: 56, total_tokens: 290 },
      }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;

  const t = await createTestApp();
  try {
    const u = await registerUser(t, 'real-provider@example.com');
    const made = await createListingProject(t, u.cookie, '真实上游项目');

    // 用真实 provider 覆盖默认的 mock
    const provider = createOpenAiCompatibleProvider({
      name: 'openai',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'not-a-real-key',
      model: 'fake-model',
      timeoutMs: 3000,
    });

    const result = await runAiTask(t.harness.ctx, provider, (
      t.harness.ctx.db.prepare('SELECT id FROM users WHERE email = ?').get('real-provider@example.com') as { id: string }
    ).id, {
      projectId: made.project.id,
      kind: 'generate',
      prompt: 'title: 随便写点什么',
      taskId: 'e2e-real-provider-1',
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.deepEqual(result.usage, { inputTokens: 234, outputTokens: 56, totalTokens: 290 });
    assert.equal(result.provider, 'openai', '台账应记录真实供应商名，而不是 mock');

    // 台账里必须是与上游完全一致的数字
    const row = t.harness.ctx.db
      .prepare('SELECT * FROM ai_usage WHERE task_id = ?')
      .get('e2e-real-provider-1') as Record<string, unknown>;
    assert.equal(row['status'], 'succeeded');
    assert.equal(row['provider'], 'openai');
    assert.equal(row['model'], 'fake-model');
    assert.equal(row['input_tokens'], 234);
    assert.equal(row['output_tokens'], 56);
    assert.equal(row['total_tokens'], 290, '台账里的用量必须等于上游返回的数字，不能是估算');

    // 额度按 290 扣
    const quota = JSON.parse((await t.app.inject({
      method: 'GET', url: '/api/platform/quota', headers: { cookie: u.cookie },
    })).body);
    assert.equal(quota.tokens.used, 290);

    // 补丁被应用到了项目规格
    const project = t.harness.ctx.db
      .prepare('SELECT spec_json FROM projects WHERE id = ?')
      .get(made.project.id) as { spec_json: string };
    assert.equal(JSON.parse(project.spec_json).title, '来自假上游的标题');
  } finally {
    await t.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('端到端：上游报错时任务记 failed 且**不扣额度**', async () => {
  const server = createServer((_req, res) => {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: { message: 'upstream exploded' } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;

  const t = await createTestApp();
  try {
    const u = await registerUser(t, 'fail-provider@example.com');
    const made = await createListingProject(t, u.cookie, '失败项目');
    const userId = (t.harness.ctx.db.prepare('SELECT id FROM users WHERE email = ?')
      .get('fail-provider@example.com') as { id: string }).id;

    const provider = createOpenAiCompatibleProvider({
      name: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'not-a-real-key', model: 'fake-model', timeoutMs: 3000,
    });

    const result = await runAiTask(t.harness.ctx, provider, userId, {
      projectId: made.project.id, kind: 'generate', prompt: 'x', taskId: 'e2e-fail-1',
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'provider_error');
      // 错误信息必须是给用户看的可读文案，不能把上游细节透出去
      assert.doesNotMatch(result.message, /upstream exploded/, '不应把上游错误原文透给用户');
    }

    const row = t.harness.ctx.db
      .prepare('SELECT * FROM ai_usage WHERE task_id = ?')
      .get('e2e-fail-1') as Record<string, unknown>;
    assert.equal(row['status'], 'failed');
    assert.equal(row['total_tokens'], 0, '失败的调用不应扣额度');
    assert.ok(String(row['failure_reason'] ?? '').length > 0, '应记录失败原因');

    // 额度完全没动
    const quota = JSON.parse((await t.app.inject({
      method: 'GET', url: '/api/platform/quota', headers: { cookie: u.cookie },
    })).body);
    assert.equal(quota.tokens.used, 0, '上游报错不扣额度');
    assert.equal(quota.generations.used, 0, '上游报错不扣生成次数');
  } finally {
    await t.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('供应商工厂：配置不全时退回 mock，并给出原因', () => {
  // 缺省就是 mock
  const none = createProviderFromConfig({
    provider: 'mock', baseUrl: '', apiKey: '', model: '', timeoutMs: 1000, requireUsage: true,
  });
  assert.equal(none.kind, 'mock');
  assert.equal(none.provider.live, false, 'mock 必须标记为非真实供应商');
  assert.equal(none.fallbackReason, null);

  // 声明了 openai 但缺配置 → 退回 mock，并且**明确说明原因**
  const partial = createProviderFromConfig({
    provider: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: '', model: '', timeoutMs: 1000, requireUsage: true,
  });
  assert.equal(partial.kind, 'mock');
  assert.match(String(partial.fallbackReason), /AI_API_KEY/);
  assert.match(String(partial.fallbackReason), /AI_MODEL/);
  assert.equal(partial.provider.live, false, '配置不全时绝不能创建真实 provider');

  // 配置齐全才创建真实 provider
  const full = createProviderFromConfig({
    provider: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'm', timeoutMs: 1000, requireUsage: true,
  });
  assert.equal(full.kind, 'openai');
  assert.equal(full.provider.live, true);
  assert.equal(full.fallbackReason, null);
});