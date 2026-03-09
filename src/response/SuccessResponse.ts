import { ApiResponse, ApiResponseBody } from "./ApiResponse";

export interface SuccessResponseBody<T> extends ApiResponseBody {
	success: true;
	data: T;
}

export class SuccessResponse<T = unknown> extends ApiResponse {
	readonly statusCode: number;
	readonly success = true as const;
	readonly message: string;
	readonly data: T;

	constructor(data: T, message = "Success", statusCode = 200) {
		super();
		this.data = data;
		this.message = message;
		this.statusCode = statusCode;
	}

	toJSON(): SuccessResponseBody<T> {
		return {
			success: this.success,
			message: this.message,
			data: this.data,
		};
	}
}
