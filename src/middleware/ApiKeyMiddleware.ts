import { FastifyReply, FastifyRequest } from 'fastify';
import { ErrorResponse } from '../http/ApiResponse';

export abstract class BaseMiddleware {
  abstract handle(request: FastifyRequest, reply: FastifyReply): Promise<void>;
}

export class ApiKeyMiddleware extends BaseMiddleware {
  private readonly expectedApiKey: string;

  constructor(expectedApiKey: string) {
    super();
    this.expectedApiKey = expectedApiKey;
  }

  handle = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const providedApiKey = request.headers['api-key'] as string | undefined;
    const acceptHeader = request.headers['accept'];

    if (!providedApiKey) {
      return new ErrorResponse('Unauthorized', 401).send(reply);
    }

    if (acceptHeader !== 'application/json') {
      return new ErrorResponse('Accept header must be application/json', 400).send(reply);
    }

    if (providedApiKey !== this.expectedApiKey) {
      return new ErrorResponse('The provided API key is invalid', 403).send(reply);
    }
  };
}
