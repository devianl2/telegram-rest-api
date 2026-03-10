import Redis from "ioredis";

export class RedisClient {
	private static instance: RedisClient;
	private readonly client: Redis;

	private constructor() {
		this.client = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
			lazyConnect: false,
			maxRetriesPerRequest: 3,
		});

		this.client.on("error", (error: Error) => {
			throw new Error("Failed to connect to Redis");
		});
	}

	static getInstance(): RedisClient {
		try {
			if (!RedisClient.instance) {
				RedisClient.instance = new RedisClient();
			}
			return RedisClient.instance;
		} catch (error) {
			throw new Error("Failed to connect to Redis");
		}
	}

	/**
	 * Get a value from Redis
	 * @param key - The key to get
	 * @returns The value of the key
	 */
	async get(key: string): Promise<string | null> {
		return this.client.get(key);
	}

	/**
	 * Set a value in Redis with an optional TTL in seconds
	 * @param key - The key to set
	 * @param value - The value to set
	 * @param ttlSeconds - The TTL in seconds (optional)
	 */
	async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
		if (ttlSeconds) {
			await this.client.set(key, value, "EX", ttlSeconds);
		} else {
			await this.client.set(key, value);
		}
	}

	/**
	 * Delete a value from Redis
	 * @param key - The key to delete
	 */
	async del(key: string): Promise<void> {
		await this.client.del(key);
	}
}
