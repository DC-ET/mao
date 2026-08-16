import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage<string>();

export const ToolCallContext = {
  setToolCallId(toolCallId: string | null | undefined): void {
    if (toolCallId == null || toolCallId.trim() === '') {
      storage.enterWith('');
    } else {
      storage.enterWith(toolCallId);
    }
  },

  getToolCallId(): string | undefined {
    const v = storage.getStore();
    return v ? v : undefined;
  },

  clear(): void {
    storage.enterWith('');
  },

  run<T>(toolCallId: string | undefined, fn: () => T): T {
    return storage.run(toolCallId ?? '', fn);
  },
};
