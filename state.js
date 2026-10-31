/**
 * dsh-model-fallback-queue — 队列顺序的独立持久化（B 方案）。
 *
 * 为什么不放 settings：
 *   ui-theme 的 adopt() 订阅了 settings 作用域，settings revision 一变就
 *   publish() → theme/change → ThemePresenter.apply() 全量重跑，整页 token
 *   removeProperty/setProperty 一遍，深色下会闪一帧白。队列排序是高频操作，
 *   放 settings 里每次点箭头都触发一次全页主题重刷。
 *   把 queue 单独存成 JSON 文件即可绕开 settings revision。
 *
 * 文件位置：$DSH_HOME/fallback-queue-state.json（默认 ~/.dsh/）
 * 写入方式：@deepseek-ai/dsh-atomic-write 的 writeFileAtomic（写临时文件再 rename，
 *   读者只会看到旧内容或新内容，不会读到半截 JSON）。
 *
 * 容错：文件不存在 / 解析失败 / 结构非法 → 返回 null，由调用方决定回退策略。
 */

import { readFile } from 'node:fs/promises';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';

/** 状态文件名（位于 DSH_HOME 下） */
export const STATE_FILENAME = 'fallback-queue-state.json';

/** 状态文件 schema 版本；将来结构变更时据此做迁移 */
const STATE_VERSION = 2;
/** 当前支持读取的版本集合：低于 STATE_VERSION 的旧版本在读时迁移 */
const SUPPORTED_VERSIONS = [1, 2];

let cachedPath = null;

/**
 * 解析状态文件的绝对路径。
 * dshHomePath() 每次都会读 env/兜底规则，这里缓存一次（同一进程内 DSH_HOME 不会变）。
 * @returns {string}
 */
export function statePath() {
  if (!cachedPath) cachedPath = dshHomePath(STATE_FILENAME);
  return cachedPath;
}

/**
 * 把任意输入收敛成合法的队列数组。
 * 只保留 {provider, model} 都是非空字符串的条目；每条补齐 v2 字段：
 *   - pinned: boolean，恒存在（大保底 = 最后兜底），缺省 false
 *   - tier: 可选厂商分组标签（如 "A"/"B" 或厂商 id），仅用于 UI 分组展示
 *   - paid: 'free'|'paid'|'unknown'，默认 'unknown'（不瞎猜免费/付费）
 * 其余字段丢弃。
 * @param {unknown} raw
 * @returns {Array<{provider: string, model: string, pinned: boolean, paid: 'free'|'paid'|'unknown', tier?: string}>}
 */
export function normalizeQueue(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const provider = typeof item.provider === 'string' ? item.provider.trim() : '';
    const model = typeof item.model === 'string' ? item.model.trim() : '';
    if (!(provider && model)) continue;
    out.push({
      provider,
      model,
      pinned: item.pinned === true,
      paid: item.paid === 'free' || item.paid === 'paid' ? item.paid : 'unknown',
      ...(typeof item.tier === 'string' && item.tier ? { tier: item.tier } : {}),
    });
  }
  return out;
}

/**
 * 读队列状态。
 * @returns {Promise<Array<{provider: string, model: string}> | null>}
 *   null 表示「没有可用的状态文件」——调用方应回退到 settings 里的历史 queue 或空队列。
 *   空数组表示「文件存在且明确记录了空队列」，调用方不应回退。
 */
export async function readQueueState() {
  let text;
  try {
    text = await readFile(statePath(), 'utf8');
  } catch (e) {
    // ENOENT 是首次运行，属于正常情况；其他错误也走回退，不阻塞启动
    if (e?.code !== 'ENOENT') {
      console.warn('[fallback-queue] state read failed, falling back: %s', e?.message);
    }
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return null;
    // 版本挂载点：只认受支持的版本（v1 老文件 / v2 新文件，或缺省 version 的早期文件）。
    // v1 条目缺 pinned/paid/tier —— normalizeQueue 负责补默认字段；迁移 = 补完字段后
    // 落盘成 v2 一次（幂等：下次再读就是 v2，不会重复写）。
    const ver = parsed.version === undefined ? 1 : parsed.version;
    if (!SUPPORTED_VERSIONS.includes(ver)) return null;
    const next = normalizeQueue(parsed.queue);
    if (ver < STATE_VERSION) {
      await writeQueueState(next); // 结构迁移 + 升 version 一次；失败仅告警，不阻断读取
    }
    return next;
  } catch (e) {
    console.warn('[fallback-queue] state parse failed, falling back: %s', e?.message);
    return null;
  }
}

/**
 * 写队列状态（原子替换）。
 * @param {Array<{provider: string, model: string}>} queue
 * @returns {Promise<boolean>} 是否写入成功
 */
export async function writeQueueState(queue) {
  const payload = JSON.stringify({ version: STATE_VERSION, queue: normalizeQueue(queue) }, null, 2) + '\n';
  try {
    await writeFileAtomic(statePath(), payload, { mode: 0o600 });
    return true;
  } catch (e) {
    console.warn('[fallback-queue] state write failed: %s', e?.message);
    return false;
  }
}
