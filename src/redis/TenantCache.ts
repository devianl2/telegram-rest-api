import { createHash } from "crypto";
import { RedisClient } from "./RedisClient";

export interface CachedTenant {
	id: number;
	secret_id: string;
	secret_code: string;
	callback_url: string;
}

export class TenantCache {
	private static readonly TTL_SECONDS = 3600; // 1 hour
	private static readonly PREFIX = "tenant:";

	private static buildKey(secretId: string, secretCode: string): string {
		return createHash("md5")
			.update(secretId + secretCode)
			.digest("hex");
	}

	static async get(
		secretId: string,
		secretCode: string,
	): Promise<CachedTenant | null> {
		const redis = RedisClient.getInstance();
		const raw = await redis.get(
			TenantCache.PREFIX + TenantCache.buildKey(secretId, secretCode),
		);
		if (!raw) return null;
		return JSON.parse(raw) as CachedTenant;
	}

	static async set(
		secretId: string,
		secretCode: string,
		tenant: CachedTenant,
	): Promise<void> {
		const redis = RedisClient.getInstance();
		await redis.set(
			TenantCache.PREFIX + TenantCache.buildKey(secretId, secretCode),
			JSON.stringify(tenant),
			TenantCache.TTL_SECONDS,
		);
	}

	static async invalidate(secretId: string, secretCode: string): Promise<void> {
		const redis = RedisClient.getInstance();
		await redis.del(
			TenantCache.PREFIX + TenantCache.buildKey(secretId, secretCode),
		);
	}
}
