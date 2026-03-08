import { FastifyInstance } from 'fastify';

export abstract class BaseRoute {
  abstract register(fastify: FastifyInstance): Promise<void>;
}
