export interface LivePluginContext {
  emit: (event: string, payload?: unknown) => void;
}

export interface LivePlugin {
  onInit?(context: LivePluginContext): void;
  onDispose?(): void;
}

export class LivePluginHost {
  private readonly plugins: LivePlugin[];
  private readonly listeners = new Map<string, Set<(payload?: unknown) => void>>();

  constructor(plugins: LivePlugin[] = []) {
    this.plugins = plugins;
  }

  init(): void {
    const context: LivePluginContext = {
      emit: (event, payload) => {
        const set = this.listeners.get(event);
        if (!set) return;
        for (const fn of set) fn(payload);
      },
    };
    for (const p of this.plugins) p.onInit?.(context);
  }

  on(event: string, cb: (payload?: unknown) => void): () => void {
    const set = this.listeners.get(event) ?? new Set<(payload?: unknown) => void>();
    set.add(cb);
    this.listeners.set(event, set);
    return () => {
      set.delete(cb);
      if (set.size === 0) this.listeners.delete(event);
    };
  }

  dispose(): void {
    for (const p of this.plugins) p.onDispose?.();
    this.listeners.clear();
  }
}
