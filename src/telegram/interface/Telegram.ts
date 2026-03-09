import { TelegramClient } from 'telegram';

export interface TelegramClientInterface {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getClient(): TelegramClient;
  getSession(): string;
}
