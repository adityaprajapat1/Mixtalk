/**
 * Redis client for session state and matching queues.
 * Uses REDIS_URL from environment. Falls back to in-memory store when Redis is unavailable
 * so the platform still runs honestly (no fake users) in local/dev without Redis.
 */

import Redis from "ioredis";

type MemoryEntry = { value: string; expiresAt?: number };

class MemoryStore {
  private data = new Map<string, MemoryEntry>();
  private sets = new Map<string, Set<string>>();

  async get(key: string): Promise<string | null> {
    const e = this.data.get(key);
    if (!e) return null;
    if (e.expiresAt && Date.now() > e.expiresAt) {
      this.data.delete(key);
      return null;
    }
    return e.value;
  }

  async set(key: string, value: string, mode?: string, ttl?: number): Promise<"OK"> {
    const expiresAt = mode === "EX" && ttl ? Date.now() + ttl * 1000 : undefined;
    this.data.set(key, { value, expiresAt });
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) {
      if (this.data.delete(k)) n++;
      if (this.sets.delete(k)) n++;
    }
    return n;
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    if (!this.sets.has(key)) this.sets.set(key, new Set());
    const s = this.sets.get(key)!;
    let n = 0;
    for (const m of members) {
      if (!s.has(m)) {
        s.add(m);
        n++;
      }
    }
    return n;
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const s = this.sets.get(key);
    if (!s) return 0;
    let n = 0;
    for (const m of members) {
      if (s.delete(m)) n++;
    }
    return n;
  }

  async smembers(key: string): Promise<string[]> {
    return Array.from(this.sets.get(key) || []);
  }

  async sismember(key: string, member: string): Promise<number> {
    return this.sets.get(key)?.has(member) ? 1 : 0;
  }

  async scard(key: string): Promise<number> {
    return this.sets.get(key)?.size || 0;
  }

  async expire(key: string, seconds: number): Promise<number> {
    const e = this.data.get(key);
    if (e) {
      e.expiresAt = Date.now() + seconds * 1000;
      return 1;
    }
    return 0;
  }

  async keys(pattern: string): Promise<string[]> {
    const prefix = pattern.replace("*", "");
    const out: string[] = [];
    for (const k of this.data.keys()) {
      if (k.startsWith(prefix)) out.push(k);
    }
    for (const k of this.sets.keys()) {
      if (k.startsWith(prefix)) out.push(k);
    }
    return out;
  }

  async incr(key: string): Promise<number> {
    const cur = parseInt((await this.get(key)) || "0", 10);
    const next = cur + 1;
    await this.set(key, String(next));
    return next;
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    const raw = (await this.get(key)) || "{}";
    const obj = JSON.parse(raw);
    const isNew = !(field in obj);
    obj[field] = value;
    await this.set(key, JSON.stringify(obj));
    return isNew ? 1 : 0;
  }

  async hget(key: string, field: string): Promise<string | null> {
    const raw = await this.get(key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj[field] ?? null;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const raw = await this.get(key);
    if (!raw) return {};
    return JSON.parse(raw);
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    const raw = await this.get(key);
    if (!raw) return 0;
    const obj = JSON.parse(raw);
    let n = 0;
    for (const f of fields) {
      if (f in obj) {
        delete obj[f];
        n++;
      }
    }
    await this.set(key, JSON.stringify(obj));
    return n;
  }
}

let redis: Redis | MemoryStore | null = null;
let usingMemory = false;

export function isRedisConfigured(): boolean {
  return Boolean(process.env.REDIS_URL && process.env.REDIS_URL.trim());
}

export function getRedis(): Redis | MemoryStore {
  if (redis) return redis;

  if (isRedisConfigured()) {
    try {
      redis = new Redis(process.env.REDIS_URL!, {
        maxRetriesPerRequest: 3,
        lazyConnect: true,
        enableReadyCheck: true,
        retryStrategy(times) {
          if (times > 5) return null;
          return Math.min(times * 200, 2000);
        },
      });
      usingMemory = false;
      return redis;
    } catch {
      // fall through to memory
    }
  }

  redis = new MemoryStore();
  usingMemory = true;
  return redis;
}

export function isUsingMemoryStore(): boolean {
  return usingMemory;
}

// Key helpers
export const Keys = {
  activeSessions: "mt:active_sessions",
  queue: (mode: string) => `mt:queue:${mode}`,
  session: (id: string) => `mt:session:${id}`,
  match: (id: string) => `mt:match:${id}`,
  recentSkips: (id: string) => `mt:skips:${id}`,
  blocks: (id: string) => `mt:blocks:${id}`,
  onlineCount: "mt:online_count",
  suspended: (id: string) => `mt:suspended:${id}`,
  banned: (id: string) => `mt:banned:${id}`,
};
