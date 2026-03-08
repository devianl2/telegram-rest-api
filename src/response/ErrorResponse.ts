import { ApiResponse, ApiResponseBody } from './ApiResponse';

export interface ErrorResponseBody extends ApiResponseBody {
  success: false;
  code?: string;
  errors?: unknown;
}

export class ErrorResponse extends ApiResponse {
  readonly statusCode: number;
  readonly success = false as const;
  readonly message: string;
  readonly code?: string;
  readonly errors?: unknown;

  constructor(message: string, statusCode = 400, errors?: unknown, code?: string) {
    super();
    this.message = message;
    this.statusCode = statusCode;
    this.errors = errors;
    this.code = code;
  }

  toJSON(): ErrorResponseBody {
    return {
      success: this.success,
      message: this.message,
      ...(this.code !== undefined ? { code: this.code } : {}),
      ...(this.errors !== undefined ? { errors: this.errors } : {}),
    };
  }
}
