import { Api } from 'telegram';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { BaseRoute } from '../BaseRoute';
import { SuccessResponse, ErrorResponse } from '../../http/ApiResponse';
import { TelegramClientService } from '../../telegram/TelegramClientService';

interface GetFullUserBody {
  sessionCode: string;
  id: string;
}

interface GetUsersBody {
  sessionCode: string;
  id: string[];
}

interface SetSecureValueErrorsBody {
  sessionCode: string;
  id: string;
  errors: Api.TypeSecureValueError[];
}

export class UserRoute extends BaseRoute {
  async register(fastify: FastifyInstance): Promise<void> {
    fastify.post('/users/GetFullUser', async (request: FastifyRequest, reply: FastifyReply) => {
      const { sessionCode, id } = request.body as GetFullUserBody;

      if (!sessionCode || !id) {
        return new ErrorResponse('sessionCode and id are required', 400).send(reply);
      }

      const telegram = TelegramClientService.initialize(sessionCode);
      await telegram.connect();

      try {
        const result = await telegram.getClient().invoke(
          new Api.users.GetFullUser({ id }),
        );

        new SuccessResponse([result], 'User fetched successfully').send(reply);
      } catch (error: unknown) {
        ErrorResponse.fromError(error).send(reply);
      }
    });

    fastify.post('/users/GetUsers', async (request: FastifyRequest, reply: FastifyReply) => {
      const { sessionCode, id } = request.body as GetUsersBody;

      if (!sessionCode || !id?.length) {
        return new ErrorResponse('sessionCode and id are required', 400).send(reply);
      }

      const telegram = TelegramClientService.initialize(sessionCode);
      await telegram.connect();

      try {
        const result = await telegram.getClient().invoke(
          new Api.users.GetUsers({ id }),
        );

        new SuccessResponse(result, 'Users fetched successfully').send(reply);
      } catch (error: unknown) {
        ErrorResponse.fromError(error).send(reply);
      }
    });

    fastify.post('/users/SetSecureValueErrors', async (request: FastifyRequest, reply: FastifyReply) => {
      const { sessionCode, id, errors } = request.body as SetSecureValueErrorsBody;

      if (!sessionCode || !id || !errors?.length) {
        return new ErrorResponse('sessionCode, id and errors are required', 400).send(reply);
      }

      const telegram = TelegramClientService.initialize(sessionCode);
      await telegram.connect();

      try {
        const result = await telegram.getClient().invoke(
          new Api.users.SetSecureValueErrors({ id, errors }),
        );

        new SuccessResponse([{ success: result }], 'Secure value errors set successfully').send(reply);
      } catch (error: unknown) {
        ErrorResponse.fromError(error).send(reply);
      }
    });
  }
}
