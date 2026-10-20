import { createHash } from 'node:crypto';

export class StoreUnavailable extends Error {
  constructor() { super('The sign-in service is temporarily unavailable. Please try again shortly.'); this.status = 503; }
}
export class SessionConflict extends Error {
  constructor() { super('Your session changed. Please try again or reload the page.'); this.status = 409; }
}

// Snapshots and compare-and-swap give local preview the same concurrency rules as Redis.
export function createMemorySessionStore({ now = Date.now } = {}) {
  const sessions = new Map(); const counters = new Map();
  return {
    async get(id) {
      const value = sessions.get(id);
      if (!value || value.expires <= now()) { sessions.delete(id); return null; }
      return structuredClone(value);
    },
    async save(value, expectedVersion) {
      const current = sessions.get(value.id);
      if (!current || current.expires <= now() || current.version !== expectedVersion) return false;
      sessions.set(value.id, structuredClone(value)); return true;
    },
    async rotate(previous, value) {
      for (const [id, item] of sessions) if (item.expires <= now()) sessions.delete(id);
      if (previous && sessions.get(previous.id)?.version !== previous.version) return false;
      if (!previous && sessions.size >= 2000) throw new StoreUnavailable();
      sessions.set(value.id, structuredClone(value));
      if (previous) sessions.delete(previous.id);
      return true;
    },
    async delete(id) { sessions.delete(id); },
    async increment(key, windowMs) {
      for (const [id, item] of counters) if (item.until <= now()) counters.delete(id);
      const item = counters.get(key) ?? { count: 0, until: now() + windowMs };
      counters.set(key, item); return ++item.count;
    },
  };
}

const SAVE = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local item = cjson.decode(current)
if item.version ~= tonumber(ARGV[1]) or item.expires <= tonumber(ARGV[2]) then return 0 end
redis.call('SET', KEYS[1], ARGV[3], 'PX', ARGV[4])
return 1`;
const ROTATE = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if ARGV[2] ~= '' then
  local current = redis.call('GET', KEYS[2])
  if not current then return 0 end
  local item = cjson.decode(current)
  if item.version ~= tonumber(ARGV[3]) or item.expires <= tonumber(ARGV[1]) then return 0 end
elseif redis.call('ZCARD', KEYS[1]) >= 2000 then return -1 end
redis.call('SET', KEYS[3], ARGV[4], 'PX', ARGV[5])
redis.call('ZADD', KEYS[1], ARGV[6], ARGV[7])
redis.call('PEXPIRE', KEYS[1], 28800000)
if ARGV[2] ~= '' then
  redis.call('DEL', KEYS[2])
  redis.call('ZREM', KEYS[1], ARGV[2])
end
return 1`;
const REMOVE = `redis.call('DEL', KEYS[1]); redis.call('ZREM', KEYS[2], ARGV[1]); return 1`;
const INCREMENT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return count`;

/** Upstash REST: HTTPS only, no secret-bearing errors, atomic session transitions, bounded TTLs. */
export function createRedisSessionStore(config, { fetcher = fetch, now = Date.now } = {}) {
  const endpoint = new URL(config.redisUrl);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
    throw new Error('Use an HTTPS Redis REST origin without a path or credentials.');
  }
  if (!config.redisToken) throw new Error('Set the Redis REST token in the server environment.');
  // Different origins (including previews) cannot read each other's sessions.
  const namespace = createHash('sha256').update(config.origin).digest('hex').slice(0, 24);
  const prefix = `gitgallery:{${namespace}}:`;
  const key = id => `${prefix}session:${id}`;
  const index = `${prefix}sessions`;
  async function command(...args) {
    try {
      const response = await fetcher(endpoint.origin, { method: 'POST', redirect: 'error',
        signal: AbortSignal.timeout(8000), headers: { Authorization: `Bearer ${config.redisToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args) });
      if (!response.ok) throw new StoreUnavailable();
      const result = await response.json();
      if (result.error || !Object.hasOwn(result, 'result')) throw new StoreUnavailable();
      return result.result;
    } catch { throw new StoreUnavailable(); }
  }
  return {
    async get(id) {
      const raw = await command('GET', key(id));
      if (raw === null) return null;
      let value;
      try { value = JSON.parse(raw); } catch { throw new StoreUnavailable(); }
      if (value.id !== id || !Number.isInteger(value.version) || !Number.isFinite(value.expires)) throw new StoreUnavailable();
      return value.expires > now() ? value : null;
    },
    async save(value, expectedVersion) {
      const ttl = value.expires - now();
      if (ttl <= 0) return false;
      return await command('EVAL', SAVE, 1, key(value.id), expectedVersion, now(), JSON.stringify(value), ttl) === 1;
    },
    async rotate(previous, value) {
      const result = await command('EVAL', ROTATE, 3, index, key(previous?.id ?? 'none'), key(value.id),
        now(), previous?.id ?? '', previous?.version ?? 0, JSON.stringify(value), value.expires - now(), value.expires, value.id);
      if (result === -1) throw new StoreUnavailable();
      return result === 1;
    },
    async delete(id) { await command('EVAL', REMOVE, 2, key(id), index, id); },
    async increment(id, windowMs) {
      const digest = createHash('sha256').update(id).digest('hex');
      return command('EVAL', INCREMENT, 1, `${prefix}rate:${digest}`, windowMs);
    },
  };
}

export function createSessionStore(config, options) {
  if (config.redisUrl && config.redisToken) return createRedisSessionStore(config, options);
  if (config.vercel) throw new Error('Vercel requires shared sessions: connect Upstash Redis and set its REST URL and token.');
  return createMemorySessionStore(options);
}
