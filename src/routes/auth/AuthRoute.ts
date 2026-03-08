import { Api } from 'telegram';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { BaseRoute } from '../BaseRoute';
import { SuccessResponse, ErrorResponse } from '../../http/ApiResponse';
import { TelegramClientService } from '../../telegram/TelegramClientService';

interface SendCodeBody {
  phoneNumber: string;
}

interface ResendCodeBody {
  phoneNumber: string;
  phoneCodeHash: string;
  sessionCode: string;
}

interface SignInBody {
  phoneNumber: string;
  phoneCode: string;
  phoneCodeHash: string;
  sessionCode: string;
}

export class AuthRoute extends BaseRoute {
  async register(fastify: FastifyInstance): Promise<void> {
    fastify.post('/auth/send-code', async (request: FastifyRequest, reply: FastifyReply) => {
      const { phoneNumber } = request.body as SendCodeBody;

      if (!phoneNumber) {
        return new ErrorResponse('phoneNumber is required', 400).send(reply);
      }

      const telegram = TelegramClientService.initialize();
      await telegram.connect();

      try {
        const result = await telegram.getClient().invoke(
          new Api.auth.SendCode({
            phoneNumber,
            apiId: process.env.TELEGRAM_API_ID ?? '',
            apiHash: process.env.TELEGRAM_API_HASH ?? '',
            settings: new Api.CodeSettings({}),
          }),
        );
  
        new SuccessResponse(
          [{ phoneCodeHash: result.phoneCodeHash, session: telegram.getSessionString() }],
          'Verification code sent',
        ).send(reply);

      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        new ErrorResponse(message, 400).send(reply);
      }
    });

    fastify.post('/auth/resend-code', async (request: FastifyRequest, reply: FastifyReply) => {
      const { phoneNumber, phoneCodeHash, sessionCode } = request.body as ResendCodeBody;
    
      if (!phoneNumber) {
        return new ErrorResponse('phoneNumber is required', 400).send(reply);
      }
      
      // Initialize the Telegram client with the session code that was sent in send-code route
      const telegram = TelegramClientService.initialize(sessionCode);
      await telegram.connect();

      try {
        const result = await telegram.getClient().invoke(
          new Api.auth.ResendCode({ 
            phoneNumber: phoneNumber,
            phoneCodeHash: phoneCodeHash,
          }),
        );

      new SuccessResponse([result], 'Verification code resent').send(reply);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        
        new ErrorResponse(message, 400).send(reply);
      }
    });

    fastify.post('/auth/sign-in', async (request: FastifyRequest, reply: FastifyReply) => {
      const { phoneNumber, phoneCodeHash, phoneCode, sessionCode } = request.body as SignInBody;
    
      if (!phoneNumber || !phoneCodeHash || !phoneCode || !sessionCode) {
        return new ErrorResponse('phoneNumber, phoneCode, and session code are required', 400).send(reply);
      }
    
      // Initialize the Telegram client with the session code that was sent in send-code route
      const telegram = TelegramClientService.initialize(sessionCode);
      await telegram.connect();

      try {
        const result = await telegram.getClient().invoke(
          new Api.auth.SignIn({
            phoneNumber: phoneNumber,
            phoneCode: phoneCode,
            phoneCodeHash: phoneCodeHash,
          }),
        );
    
        new SuccessResponse([result], 'Signed in successfully').send(reply);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        new ErrorResponse(message, 400).send(reply);
      }
    });
  }
}
