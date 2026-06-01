/**
 * Tiny string KV with TTL, used to back the OAuth provider's state
 * (clients, pending authorizations, codes, access/refresh tokens).
 *
 * Two backends:
 *   - memory: a Map with lazy expiry. Fine for a single instance, but state is
 *     lost on restart and not shared across instances.
 *   - redis (when MCP_REDIS_URL is set): survives restarts and works across
 *     multiple instances.
 *
 * Values are JSON strings; callers (de)serialize. `take` is get-then-delete
 * (single-use semantics for codes and refresh tokens).
 */
export interface KV {
	get(key: string): Promise<string | null>;
	set(key: string, value: string, ttlSeconds?: number): Promise<void>;
	del(key: string): Promise<void>;
	take(key: string): Promise<string | null>;
}

export function createMemoryKV(): KV {
	const m = new Map<string, { value: string; expiresAt: number }>();
	const read = (key: string): string | null => {
		const e = m.get(key);
		if (!e) return null;
		if (e.expiresAt && e.expiresAt < Date.now()) {
			m.delete(key);
			return null;
		}
		return e.value;
	};
	return {
		async get(key) {
			return read(key);
		},
		async set(key, value, ttlSeconds) {
			m.set(key, { value, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : 0 });
		},
		async del(key) {
			m.delete(key);
		},
		async take(key) {
			const v = read(key);
			m.delete(key);
			return v;
		},
	};
}

export async function createRedisKV(url: string, prefix: string): Promise<KV> {
	const { default: Redis } = await import("ioredis");
	const client = new Redis(url);
	const k = (key: string) => `${prefix}${key}`;
	return {
		async get(key) {
			return client.get(k(key));
		},
		async set(key, value, ttlSeconds) {
			if (ttlSeconds) await client.set(k(key), value, "EX", ttlSeconds);
			else await client.set(k(key), value);
		},
		async del(key) {
			await client.del(k(key));
		},
		async take(key) {
			const kk = k(key);
			const v = await client.get(kk);
			if (v !== null) await client.del(kk);
			return v;
		},
	};
}
