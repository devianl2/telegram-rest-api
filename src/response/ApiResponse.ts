export interface ApiResponseBody {
  success: boolean;
  message: string;
}

export abstract class ApiResponse {
  abstract readonly statusCode: number;
  abstract readonly success: boolean;
  abstract readonly message: string;

  abstract toJSON(): ApiResponseBody;
}
