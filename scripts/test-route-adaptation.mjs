/**
 * 跨路由适配单元测试：换路由时的控制字段剥离 + 历史 thinking 适配。
 *
 * 背景（真实故障，2026-11-11）：
 *  1) DeepSeek 会话（P1 默认 maxTokens=256000，reasoningEffort=max）在 P1 失败后
 *     切到 zai/glm-5.3，子请求仍带 maxTokens=256000，z.ai 直接
 *     400 code 1210「The max_tokens parameter is illegal.：限制数值范围[1,131072]」。
 *  2) GLM 会话（P1=zai）在 P1 失败后切到 deepseek-official：历史 assistant 消息的
 *     thinking 带不过去（跨适配器），而 DeepSeek 的 Anthropic 兼容端点要求
 *     「text + tool_use」的 assistant 消息必须带 thinking 块，否则
 *     400「The `content[].thinking` in the thinking mode must be passed back to the API.」。
 *
 * 做法与 test-queue-order.mjs 一致：从 index.js 源码里按大括号配平截出纯函数，
 * 在 node 里直接跑同一份实现（不是复制实现、不是正则断言源码）。
 *
 * 用法：node scripts/test-route-adaptation.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const indexSrc = readFileSync(join(root, 'index.js'), 'utf8');

let pass = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    return;
  }
  failures.push(`${name}${extra ? ` — ${extra}` : ''}`);
}
function eq(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  check(name, g === w, `got ${g} want ${w}`);
}

/** 按大括号配平截出一个函数声明（先跳过参数列表，避免默认值 {} 提前收尾）。 */
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  let i = src.indexOf('(', start);
  let depth = 0;
  for (; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  let j = src.indexOf('{', i);
  depth = 0;
  for (; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  throw new Error(`unbalanced braces for ${name}`);
}

// routeCallOptions → adaptMessagesForRoute → messageReplayIsNative / nativeReplayKindMap / providerList
const names = [
  'providerList',
  'nativeReplayKindMap',
  'messageReplayIsNative',
  'adaptMessagesForRoute',
  'routeCallOptions',
];
const bundle = names.map((name) => extractFunction(indexSrc, name)).join('\n');
const build = new Function(`${bundle}\nreturn { adaptMessagesForRoute, routeCallOptions };`);
const { adaptMessagesForRoute, routeCallOptions } = build();

const CONFIG = {
  strictThinkingProviders: ['deepseek-official'],
  nativeReplayKinds: ['deepseek-official=deepseek-messages'],
};

const text = (value) => Object.freeze({ type: 'text', text: value });
const reasoning = (value) => Object.freeze({ type: 'reasoning', text: value });
const toolCall = (id) => Object.freeze({ type: 'tool-call', id, name: 'bash', arguments: '{}' });

function assistantFixture({ provider, model, replayKind, blocks }) {
  const message = {
    role: 'assistant',
    content: Object.freeze(blocks),
    source: {
      kind: 'model',
      provider,
      model,
      ...(replayKind === undefined ? {} : { replayState: Object.freeze({ response: Object.freeze({ kind: replayKind }) }) }),
    },
  };
  return Object.freeze(message);
}

const zaiForeign = assistantFixture({
  provider: 'zai',
  model: 'glm-5.3',
  replayKind: 'pi-ai',
  blocks: [reasoning('думаю'), text('сейчас вызову тул'), toolCall('c1')],
});
const deepseekNative = assistantFixture({
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  replayKind: 'deepseek-messages',
  blocks: [reasoning('думаю'), text('сейчас вызову тул'), toolCall('c2')],
});
const deepseekMisattributed = assistantFixture({
  // source 写着 deepseek（fallback 时宿主按 P1 记录），但 replay 是 pi-ai 的——thinking 不可重放
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  replayKind: 'pi-ai',
  blocks: [text('комментарий'), toolCall('c3')],
});
const textOnly = {
  role: 'assistant',
  content: Object.freeze([text('готово')]),
  source: { kind: 'model', provider: 'zai', model: 'glm-5.3' },
};
const toolOnly = assistantFixture({
  provider: 'zai',
  model: 'glm-5.3',
  replayKind: 'pi-ai',
  blocks: [toolCall('c4')],
});
const userMessage = { role: 'user', content: Object.freeze([text('привет')]) };

const messages = Object.freeze([
  userMessage,
  zaiForeign,
  deepseekNative,
  deepseekMisattributed,
  textOnly,
  toolOnly,
]);

// ---- 1) 历史适配：只动“严格 provider + text+tool_use + 非原生 replay”的消息 ----
const adapted = adaptMessagesForRoute(messages, { provider: 'deepseek-official', model: 'deepseek-flash' }, CONFIG);
check('адаптация вернула новый массив', adapted !== messages);
check('входной массив не изменён', messages[1].content.length === 3, 'foreign message mutated');
eq(
  'foreign (zai/pi-ai): text снят, tool-call и reasoning на месте',
  adapted[1].content.map((b) => b.type),
  ['reasoning', 'tool-call'],
);
eq(
  'native (deepseek-messages): не тронут',
  adapted[2],
  deepseekNative,
);
eq(
  'misattributed (pi-ai под deepseek): text снят',
  adapted[3].content.map((b) => b.type),
  ['tool-call'],
);
eq('text-only assistant не тронут', adapted[4], textOnly);
eq('tool-only assistant не тронут', adapted[5], toolOnly);
eq('user message не тронут', adapted[0], userMessage);
check('адаптированные сообщения заморожены', Object.isFrozen(adapted[1]) && Object.isFrozen(adapted[1].content));

// ---- 2) 没有需要改的消息 → 原数组（引用相同，省内存） ----
const untouched = adaptMessagesForRoute(Object.freeze([userMessage, deepseekNative]), { provider: 'deepseek-official', model: 'deepseek-flash' }, CONFIG);
check('нечего менять → исходный массив', untouched === Object.freeze(untouched) && untouched.length === 2 && untouched[1] === deepseekNative);

// ---- 3) 非严格目标 / 未配置严格 provider → 不碰历史 ----
const zaiAdapted = adaptMessagesForRoute(messages, { provider: 'zai', model: 'glm-5.3' }, CONFIG);
check('zai (не strict) → история не тронута', zaiAdapted === messages);
const noStrict = adaptMessagesForRoute(messages, { provider: 'deepseek-official', model: 'deepseek-flash' }, {});
check('strictThinkingProviders пуст → история не тронута', noStrict === messages);

// ---- 4) onAdapted 计数 ----
let adaptedCount = -1;
adaptMessagesForRoute(messages, { provider: 'deepseek-official', model: 'deepseek-flash' }, CONFIG, { onAdapted: (n) => { adaptedCount = n; } });
eq('onAdapted 计数（foreign + misattributed）', adaptedCount, 2);

// ---- 5) 换路由：剥离 P1 适配器物化的控制字段 ----
const request = Object.freeze({
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  reasoningEffort: 'max',
  maxTokens: 256000,
  messages,
  sessionId: 's1',
  signal: undefined,
});
const toZai = routeCallOptions(request, { provider: 'zai', model: 'glm-5.3' }, CONFIG);
eq('换路由：provider/model 已替换', [toZai.provider, toZai.model], ['zai', 'glm-5.3']);
check('换路由：maxTokens 已剥离（否则 z.ai 400 code 1210）', !('maxTokens' in toZai), `maxTokens=${toZai.maxTokens}`);
check('换路由：reasoningEffort 已剥离', !('reasoningEffort' in toZai));
eq('换路由：sessionId 保留', toZai.sessionId, 's1');
check('换路由：请求对象原样保留，不被改写', request.maxTokens === 256000 && request.reasoningEffort === 'max');

const toDeepseek = routeCallOptions({ ...request, provider: 'zai', model: 'glm-5.3' }, { provider: 'deepseek-official', model: 'deepseek-flash' }, CONFIG);
check('换到 deepseek：历史已适配', toDeepseek.messages !== messages && toDeepseek.messages[1].content.length === 2);

// ---- 6) 路由不变 → 控制字段原样保留 ----
const sameRoute = routeCallOptions(request, { provider: 'deepseek-official', model: 'deepseek-flash' }, CONFIG);
eq('同路由：maxTokens 保留', sameRoute.maxTokens, 256000);
eq('同路由：reasoningEffort 保留', sameRoute.reasoningEffort, 'max');
check('同路由：历史原地不动', sameRoute.messages === messages);

// ---- 7) 空/异常输入不炸 ----
check('adaptMessagesForRoute(undefined)', adaptMessagesForRoute(undefined, { provider: 'deepseek-official' }, CONFIG) === undefined);
check('adaptMessagesForRoute 无 source 的消息', adaptMessagesForRoute([{ role: 'assistant', content: [text('x'), toolCall('c9')] }], { provider: 'deepseek-official', model: 'm' }, CONFIG)[0].content.length === 1);

if (failures.length > 0) {
  console.error(`✗ route adaptation: ${failures.length} failure(s), ${pass} passed`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`✓ route adaptation: ${pass} checks passed`);
