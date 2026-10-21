/**
 * AI 就绪自检测试。
 *
 * 【为什么这个模块值得专门测】
 * 默认配置是 mock —— 不花钱，但**生成不出页面**。
 * 如果系统不把这件事说出来，部署者会以为「AI 功能坏了」，
 * 而且会去查错地方（查网络、查密钥、查模型名），因为没人告诉他真正的原因是「没配」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAiReadiness } from '../../src/platform/ai/readiness.ts';

test('默认 mock 配置被判定为降级，并明确说出「生成不出页面」', () => {
  const r = checkAiReadiness({ provider: 'mock', baseUrl: '', apiKey: '', model: '' });
  assert.equal(r.status, 'degraded');
  assert.equal(r.provider, 'mock');
  // 必须说清代价，而不只是说「用的是 mock」
  assert.match(r.summary, /无法真正生成网页/);
  assert.match(r.summary, /不产生费用|不会发出任何网络请求/, '也要说清好处，否则用户不敢开');
  // 必须给出可执行的动作
  assert.ok(r.actions.length >= 1);
  assert.ok(r.actions.some((a) => a.includes('AI_PROVIDER')), '要指明该设哪个变量');
  // 能力表要如实：自由页面不可用
  assert.equal(r.capabilities.freeFormPage, false);
});

test('声明了 openai 但缺配置：判定为降级，并逐项列出缺哪个变量', () => {
  const r = checkAiReadiness({ provider: 'openai', baseUrl: '', apiKey: '', model: '' });
  assert.equal(r.status, 'degraded');
  assert.equal(r.provider, 'mock', '配置不全时实际生效的仍是 mock');
  assert.match(r.summary, /AI_BASE_URL/);
  assert.match(r.summary, /AI_API_KEY/);
  assert.match(r.summary, /AI_MODEL/);
  assert.equal(r.actions.length, 3);
  assert.match(r.summary, /不会发出任何真实请求/, '要说清不会误花钱');
});

test('配置齐全时判定为就绪，且两种模式都标记为可用', () => {
  const r = checkAiReadiness({
    provider: 'openai',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'k',
    model: 'some-model',
  });
  assert.equal(r.status, 'ready');
  assert.equal(r.provider, 'openai');
  assert.deepEqual(r.actions, [], '就绪时不该还需要用户做什么');
  assert.match(r.summary, /some-model/);
  assert.equal(r.capabilities.freeFormPage, true);
  assert.equal(r.capabilities.fieldEdit, true);
});

test('就绪判定与供应商工厂保持一致（不能一个说就绪、一个退回 mock）', async () => {
  const { createProviderFromConfig } = await import('../../src/platform/ai/provider-factory.ts');

  const cases = [
    { provider: 'mock', baseUrl: '', apiKey: '', model: '' },
    { provider: 'openai', baseUrl: '', apiKey: '', model: '' },
    { provider: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: '', model: 'm' },
    { provider: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'm' },
  ];

  for (const ai of cases) {
    const readiness = checkAiReadiness(ai);
    const selection = createProviderFromConfig({ ...ai, timeoutMs: 1000, requireUsage: true });
    // 两处判断必须一致：就绪 ⟺ 真的创建了真实 provider
    assert.equal(
      readiness.status === 'ready',
      selection.kind === 'openai',
      `就绪判定与工厂不一致：${JSON.stringify(ai)} → readiness=${readiness.status}, factory=${selection.kind}`,
    );
  }
});