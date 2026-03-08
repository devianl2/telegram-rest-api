import { FastifyReply } from 'fastify';
import { ApiResponseBody } from './interface/ApiResponseBody';

export abstract class ApiResponse {
  abstract readonly statusCode: number;
  abstract readonly success: boolean;
  abstract readonly message: string;
  abstract toJSON(): ApiResponseBody;

  send(reply: FastifyReply): void {
    reply.status(this.statusCode).send(this.toJSON());
  }
}

export class SuccessResponse extends ApiResponse {
  readonly statusCode: number;
  readonly success = true as const;
  readonly message: string;
  readonly data: unknown[];

  constructor(data: unknown[] = [], message = 'Success', statusCode = 200) {
    super();
    this.data = data;
    this.message = message;
    this.statusCode = statusCode;
  }

  toJSON(): ApiResponseBody {
    return {
      success: this.success,
      message: this.message,
      data: this.data,
    };
  }
}

export class ErrorResponse extends ApiResponse {
  readonly statusCode: number;
  readonly success = false as const;
  readonly message: string;

  constructor(message: string, statusCode = 400) {
    super();
    this.message = message;
    this.statusCode = statusCode;
  }

  toJSON(): ApiResponseBody {
    return {
      success: this.success,
      message: this.message,
      data: [],
    };
  }
}
