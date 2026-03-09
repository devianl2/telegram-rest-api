export interface DatabaseClientInterface {
  execute<T>(operation: (client: unknown) => Promise<T>): Promise<T>;
}
