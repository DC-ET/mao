/**
 * Spring {@code @Lazy} equivalent: read the real instance on first property access
 * so circular construction (tools ↔ HarnessService / AgentLoop) can wire later.
 */
export function lazyRef<T extends object>(resolve: () => T): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      const real = resolve();
      if (real == null) {
        throw new Error(`Lazy dependency '${String(prop)}' is not initialized`);
      }
      const value = Reflect.get(real as object, prop, real);
      if (typeof value === 'function') {
        return (value as (...args: unknown[]) => unknown).bind(real);
      }
      return value;
    },
  });
}
