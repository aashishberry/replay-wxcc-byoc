import { ensureSchema, getDb } from "../../../../db";
import { publishRealtime } from "../../../../lib/realtime";
import { integrationMode } from "../../../../lib/webex";
const nextState: Record<string, { type: string; status: string }> = {
  accepted: { type: "task:new", status: "created" },
  created: { type: "task:connect", status: "routing" },
  routing: { type: "task:connected", status: "connected" },
  connected: { type: "task:ended", status: "ended" },
};

export async function POST(request: Request) {
  if (integrationMode() !== "sandbox")
    return Response.json(
      { error: "Demo events are disabled in live mode." },
      { status: 409 },
    );
  await ensureSchema();
  const { taskId } = (await request.json()) as { taskId?: string };
  const task = taskId
    ? await getDb()
        .prepare("SELECT status FROM tasks WHERE id = ?")
        .bind(taskId)
        .first<{ status: string }>()
    : null;
  if (!taskId || !task)
    return Response.json({ error: "Task not found." }, { status: 404 });
  const next = nextState[task.status];
  if (!next)
    return Response.json(
      { error: "Task is already complete." },
      { status: 409 },
    );
  const now = Date.now();
  const eventId = crypto.randomUUID();
  await getDb().batch([
    getDb()
      .prepare(
        "UPDATE tasks SET status = ?, last_event = ?, updated_at = ? WHERE id = ?",
      )
      .bind(next.status, next.type, now, taskId),
    getDb()
      .prepare(
        `INSERT INTO events (id, task_id, type, direction, payload_json, created_at) VALUES (?, ?, ?, 'INBOUND', ?, ?)`,
      )
      .bind(
        eventId,
        taskId,
        next.type,
        JSON.stringify({ demo: true, type: next.type, data: { taskId } }),
        now,
      ),
  ]);
  const update = {
    kind: "task",
    taskId,
    eventType: next.type,
    at: now,
    taskPatch: {
      id: taskId,
      status: next.status,
      last_event: next.type,
      updated_at: now,
    },
    event: {
      id: eventId,
      task_id: taskId,
      type: next.type,
      direction: "INBOUND",
      created_at: now,
    },
  } as const;
  publishRealtime(update);
  return Response.json({ ...next, update });
}
