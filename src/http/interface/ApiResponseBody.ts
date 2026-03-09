export interface ApiResponseBody<T = unknown> {
	success: boolean;
	message: string;
	data?: unknown;
}
