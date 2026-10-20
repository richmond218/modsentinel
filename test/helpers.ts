import type { KVStore } from "../src/moderation/audit.js";
import type { CounterStore } from "../src/moderation/budget.js";

/** In-memory KV store that mimics Devvit's `context.redis` hash API. */
export function memStore(): KVStore {
  const store = new Map<string, Map<string, string>>();
  return {
    async hSet(key, fields) {
      let h = store.get(key);
      if (!h) {
        h = new Map();
        store.set(key, h);
      }
      let added = 0;
      for (const [f, v] of Object.entries(fields)) {
        if (!h.has(f)) added++;
        h.set(f, v);
      }
      return added;
    },
    async hGet(key, field) {
      return store.get(key)?.get(field);
    },
    async hGetAll(key) {
      const h = store.get(key);
      return h ? Object.fromEntries(h) : {};
    },
    async hKeys(key) {
      return Array.from(store.get(key)?.keys() ?? []);
    },
    async hDel(key, fields) {
      const h = store.get(key);
      if (!h) return 0;
      let removed = 0;
      for (const f of fields) {
        if (h.delete(f)) removed++;
      }
      return removed;
    },
    async expire() {
      return true;
    },
  };
}

/** In-memory counter store that mimics Devvit's `context.redis` incrBy/get. */
export function memCounters(): CounterStore & { values: Map<string, number> } {
  const values = new Map<string, number>();
  return {
    values,
    async incrBy(key, n) {
      const v = (values.get(key) ?? 0) + n;
      values.set(key, v);
      return v;
    },
    async get(key) {
      const v = values.get(key);
      return v === undefined ? undefined : String(v);
    },
    async expire() {
      return true;
    },
  };
}
