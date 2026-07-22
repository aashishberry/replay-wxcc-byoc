export type RealtimeTask = {
  id: string;
  origin_id: string;
  origin_name: string;
  destination_id: string;
  channel: string;
  status: string;
  last_event: string;
  initial_text: string;
  created_at: number;
  updated_at: number;
};

export type RealtimeTaskPatch = Pick<
  RealtimeTask,
  "id" | "status" | "last_event" | "updated_at"
>;

export type RealtimeMessage = {
  id: string;
  task_id: string;
  direction: string;
  sender_type?: string;
  text: string;
  attachments_json: string;
  delivery_status: string;
  created_at: number;
};

export type RealtimeEvent = {
  id: string;
  task_id?: string;
  type: string;
  direction?: string;
  reason?: string;
  error_message?: string;
  created_at: number;
};

export type RealtimeUpdate = {
  kind: "task" | "message" | "webhook";
  taskId?: string;
  eventType: string;
  at: number;
  task?: RealtimeTask;
  taskPatch?: RealtimeTaskPatch;
  message?: RealtimeMessage;
  event?: RealtimeEvent;
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
