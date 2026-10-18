import { AsyncLocalStorage } from 'node:async_hooks';
export const databaseContext = new AsyncLocalStorage<any>();
