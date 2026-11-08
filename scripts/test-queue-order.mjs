/**
 * 队列顺序单元测试：候选序（nextPositions）的边界行为。
 *
 * 方案A：队列采用纯物理顺序 = 尝试顺序，不再有「大保底(pinned)」参与排序。
 * 本文件锁定 nextPositions 的圈序/边界不变量（绕满一圈、不重不漏、跟随模式排除自身等）。
 *
 * 做法：从 index.js 的源码里按大括号配平截出 nextPositions，在 node 里用真实的队列
 * 结构直接跑（执行同一份实现，而不是正则匹配源码）。
 *
 * 用法：node scripts/test-queue-order.mjs
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
  if (cond) { pass += 1; return; }
  failures.push(`${name}${extra ? ` — ${extra}` : ''}`);
}
function eq(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  check(name, g === w, `got ${g} want ${w}`);
}

/** 按大括号配平截出一个函数声明（与 verify-health-colors.mjs 同一套做法）。 */
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces for ${name}`);
}

// nextPositions 依赖 config（闭包变量）。
const fnNext = extractFunction(indexSrc, 'nextPositions');
const makeNext = new Function('config', `${fnNext}\nreturn nextPositions;`);

const R = (provider) => ({ provider, model: `${provider}-m` });

// ---------- 1. 非跟随模式（p1Follow=false）：环 = 队列物理序，绕满一圈（含自身重试） ----------
// 语义：静态模式下 P1 就是 queue[0]，把其余都试完后还允许回头重试起点，
// 所以 step 走 1..n 是**含自身**的完整一圈。这不是 bug，是「全试一遍」。
{
  const q = [R('A'), R('B'), R('C')];
  const next = makeNext({ queue: q, p1Follow: false });
  eq('非跟随从 A 出发 → 绕满一圈', next(0), [1, 2, 0]);
  eq('非跟随从 B 出发 → 绕满一圈', next(1), [2, 0, 1]);
}

// ---------- 2. 跟随模式（p1Follow=true）：环 = [P1(-1), 队列0, 队列1, ...] ----------
{
  const q = [R('A'), R('B'), R('C')];
  const next = makeNext({ queue: q, p1Follow: true });
  eq('跟随模式从 P1 出发 → 依次队列', next(-1), [0, 1, 2]);
  eq('跟随模式从 A 出发 → 剩余队列 + P1 槽', next(0), [1, 2, -1]);
}

// ---------- 3. 单条队列：边界不越界 ----------
{
  const q = [R('A')];
  const next = makeNext({ queue: q, p1Follow: false });
  eq('单条队列从自己出发 → 只有自身重试', next(0), [0]);
  const next2 = makeNext({ queue: q, p1Follow: true });
  eq('单条队列跟随模式从 P1 → 只有队列0', next2(-1), [0]);
}

// ---------- 4. 空队列：不崩、返回空 ----------
{
  eq('空队列不崩', makeNext({ queue: [], p1Follow: false })(0), []);
  eq('空队列跟随模式不崩', makeNext({ queue: [], p1Follow: true })(-1), []);
}

// ---------- 5. 核心不变量：候选恰好覆盖整圈、不重不漏、跟随模式排除自身 ----------
{
  const qs = [
    [R('A'), R('B'), R('C')],
    [R('A'), R('B'), R('C'), R('D'), R('E')],
    [R('A'), R('B')],
  ];
  for (const p1Follow of [false, true]) {
    for (const q of qs) {
      const next = makeNext({ queue: q, p1Follow });
      const starts = p1Follow ? [-1, ...q.map((_, i) => i)] : q.map((_, i) => i);
      for (const s of starts) {
        const seq = next(s);
        check(`不变量：候选恰好覆盖整圈 ${q.length} 项 (p1Follow=${p1Follow}, start=${s})`,
          seq.length === q.length, `seq=${JSON.stringify(seq)} len=${seq.length}`);
        check(`不变量：候选无重复 (p1Follow=${p1Follow}, start=${s})`,
          new Set(seq).size === seq.length, `seq=${JSON.stringify(seq)}`);
        if (p1Follow) {
          check(`不变量：跟随模式候选不含自身起点 (start=${s})`,
            !seq.includes(s), `seq=${JSON.stringify(seq)}`);
        } else {
          check(`不变量：静态模式起点作为重试项保留且只在末尾 (start=${s})`,
            seq.filter((p) => p === s).length <= 1, `seq=${JSON.stringify(seq)}`);
        }
      }
    }
  }
}

if (failures.length) {
  console.error(`✗ ${failures.length} 项失败 / ${pass + failures.length} 项`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ 队列顺序 ${pass} 项断言全部通过`);
