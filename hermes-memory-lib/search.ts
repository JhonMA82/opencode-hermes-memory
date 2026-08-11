/**
 * Hermes Memory for OpenCode — memory search.
 *
 * Lightweight lexical scorer over the in-memory entry lists (no external deps).
 * The real Hermes uses SQLite FTS5; for OpenCode v1 we score with token
 * coverage + rarity weighting, which is plenty for small memory stores.
 */
import type { MemoryStore, Target, MemoryCategory } from "./store.ts";

export type SearchHit = {
  target: Target | "project";
  project?: string;
  content: string;
  score: number;
};

export type SearchOptions = {
  query: string;
  target?: Target | "project";
  project?: string;
  category?: MemoryCategory;
  limit?: number;
  /** 命中时更新 last= 元数据（用进废退反馈）。默认 true。 */
  touch?: boolean;
};

const STOP_WORDS = new Set([
  "the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "but", "with",
  "is", "are", "was", "were", "be", "been", "do", "does", "did", "this", "that",
  "it", "its", "at", "by", "from", "as", "we", "you", "your", "i", "my", "me",
  "use", "using", "how", "what", "why", "when", "where", "which", "should", "can",
  "的", "了", "是", "在", "我", "你", "他", "她", "们", "这", "那", "个", "和", "与",
  "也", "都", "要", "会", "能", "把", "被", "就", "很", "有", "不", "没", "吧", "吗",
]);

function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const ascii = lower.match(/[a-z0-9][a-z0-9_+\-./]*/g) ?? [];
  const cjk = lower.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  const cjkBigrams: string[] = [];
  for (const chunk of cjk) {
    for (let i = 0; i + 1 < chunk.length; i++) {
      cjkBigrams.push(chunk.slice(i, i + 2));
    }
  }
  return [...ascii, ...cjkBigrams].filter((t) => t.length > 0 && !STOP_WORDS.has(t));
}

function scoreEntry(entryText: string, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const lower = entryText.toLowerCase();
  let hits = 0;
  for (const token of queryTokens) {
    const idx = lower.indexOf(token);
    if (idx >= 0) {
      hits += 1;
      // Small bonus for earlier position (front-loaded entries).
      hits += Math.max(0, 1 - idx / Math.max(lower.length, 1)) * 0.2;
    }
  }
  if (hits === 0) return 0;
  const coverage = hits / queryTokens.length;
  return coverage * (1 + Math.log1p(hits));
}

function categoryMatches(entryText: string, category?: MemoryCategory): boolean {
  if (!category) return true;
  return entryText.startsWith(`[${category}]`);
}

// ─── 新鲜度加权（参考 Mem0 记忆衰减：只影响排序，不删除）───
// 近期引用过的条目权重更高（1.5x），长期闲置的条目降权（0.5x）。
const FRESH_DAYS = 7;        // 7 天内引用过 → 新鲜
const STALE_DAYS = 30;       // 30 天未引用 → 闲置
const FRESH_BOOST = 1.5;
const STALE_PENALTY = 0.5;

function freshnessMultiplier(meta: { lastReferenced: string } | undefined): number {
  if (!meta || !meta.lastReferenced) return 1;
  const last = Date.parse(meta.lastReferenced);
  if (Number.isNaN(last)) return 1;
  const ageDays = (Date.now() - last) / 86_400_000;
  if (ageDays <= FRESH_DAYS) return FRESH_BOOST;
  if (ageDays >= STALE_DAYS) return STALE_PENALTY;
  // 7–30 天之间线性过渡
  return FRESH_BOOST - ((ageDays - FRESH_DAYS) / (STALE_DAYS - FRESH_DAYS)) * (FRESH_BOOST - STALE_PENALTY);
}

export function searchMemories(
  store: MemoryStore,
  opts: SearchOptions,
): SearchHit[] {
  const queryTokens = tokenize(opts.query);
  if (queryTokens.length === 0) return [];

  const hits: SearchHit[] = [];
  const limit = opts.limit ?? 10;

  // Global + user + failure
  const globalTargets: Array<{ target: Target; entries: string[] }> = [];
  if (!opts.target || opts.target === "memory") {
    globalTargets.push({ target: "memory", entries: store.getRawEntriesFor("memory") });
  }
  if (!opts.target || opts.target === "user") {
    globalTargets.push({ target: "user", entries: store.getRawEntriesFor("user") });
  }
  if (!opts.target || opts.target === "failure") {
    globalTargets.push({ target: "failure", entries: store.getRawEntriesFor("failure") });
  }
  for (const { target, entries } of globalTargets) {
    for (const raw of entries) {
      const entry = store.getEntryMeta(raw).text;
      if (!categoryMatches(entry, opts.category)) continue;
      const score = scoreEntry(entry, queryTokens);
      if (score > 0) {
        hits.push({ target, content: entry, score: score * freshnessMultiplier(store.getEntryMeta(raw)) });
        if (opts.touch !== false) store.touchEntry(target, raw);
      }
    }
  }

  // Project memory
  if ((!opts.target || opts.target === "project") && opts.project) {
    for (const raw of store.getRawProjectEntries(opts.project)) {
      const entry = store.getEntryMeta(raw).text;
      const score = scoreEntry(entry, queryTokens);
      if (score > 0) {
        hits.push({ target: "project", project: opts.project, content: entry, score: score * freshnessMultiplier(store.getEntryMeta(raw)) });
        if (opts.touch !== false) store.touchEntry("project", raw, opts.project);
      }
    }
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}
