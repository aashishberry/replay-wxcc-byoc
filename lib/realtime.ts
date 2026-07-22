export type RealtimeUpdate = {
  kind: "task" | "message" | "webhook";
  taskId?: string;
  eventType: string;
  at: number;
};

type Listener = (update: RealtimeUpdate) => void;
type RealtimeState = { listeners: Set<Listener> };

const shared = globalThis as typeof globalThis & {
  __relayRealtimeState?: RealtimeState;
};

const state =
  shared.__relayRealtimeState ??
  (shared.__relayRealtimeState = { listeners: new Set<Listener>() });

export function subscribeRealtime(listener: Listener) {
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}

export function publishRealtime(update: RealtimeUpdate) {
  for (const listener of state.listeners) {
    try {
      listener(update);
    } catch {
      state.listeners.delete(listener);
    }
  }
}
