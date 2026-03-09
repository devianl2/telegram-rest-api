export class TelegramUtils {
	static isUnauthorized(error: unknown): boolean {
		return (
			error instanceof Error &&
			"code" in error &&
			(error as Error & { code: unknown }).code === 401
		);
	}
}
