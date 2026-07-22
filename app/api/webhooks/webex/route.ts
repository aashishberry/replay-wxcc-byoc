import { ensureSchema, getDb } from "../../../../db";
import { normalizeMessageTimestamp } from "../../../../lib/messages";
import { relayOutbound, verifyWebhook } from "../../../../lib/webex";

type WebexEvent = {
  id?: string;
  type?: string;
  comciscotimestamp?: number | string;
  data?: {
    taskId?: string;
    messageDirection?: string;
    direction?: string;
    senderType?: string;
    reason?: string;
    errorMessage?: string;
    createdTime?: number | string;
    channelParams?: {
      message?: {
        aliasId?: string;
        text?: string;
        attachments?: unknown[];
        timestamp?: number | string;
      };
    };
  };
};
const taskStatuses: Record<string, string> = {
  "task:new": "created",
  "task:connect": "routing",
  "task:connected": "connected",
  "task:ended": "ended",
  "task:failed": "failed",
};

export async function POST(request: Request) {
  const rawBody = await request.text();
  let event: WebexEvent;
  try {
    event = JSON.parse(rawBody) as WebexEvent;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const verification = await verifyWebhook(
    rawBody,
    request,
    event.comciscotimestamp,
  );
  if (!verification.valid)
    return Response.json(
      { error: "Invalid webhook signature or timestamp" },
      { status: 401 },
    );
  if (!event.id || !event.type)
    return Response.json(
      { error: "Webhook id and type are required" },
      { status: 400 },
    );
  await ensureSchema();
  const db = getDb();
  const now = normalizeMessageTimestamp(
    event.data?.createdTime ?? event.comciscotimestamp,
  );
  const taskId =
    event.data?.taskId ??
    (event.type.startsWith("task:") ? event.id : undefined);
  // Task lifecycle webhooks document the top-level `id` as the task ID, so it
  // is reused across task:new, task:connect, task:connected, and task:ended.
  // Include the event type and timestamp to deduplicate deliveries without
  // discarding later lifecycle transitions for the same task.
  const storedEventId = [event.id, event.type, taskId ?? "", now].join(":");
  if (
    await db
      .prepare("SELECT id FROM events WHERE id = ?")
      .bind(storedEventId)
      .first()
  )
    return Response.json({ received: true, duplicate: true });
  await db
    .prepare(
      `INSERT INTO events (id, task_id, type, direction, reason, error_message, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      storedEventId,
      taskId ?? null,
      event.type,
      event.data?.messageDirection ?? event.data?.direction ?? null,
      event.data?.reason ?? null,
      event.data?.errorMessage ?? null,
      rawBody,
      now,
    )
    .run();
  const status = taskStatuses[event.type];
  if (taskId)
    await db
      .prepare(
        `UPDATE tasks SET
          status = CASE WHEN status IN ('ended', 'failed') THEN status ELSE COALESCE(?, status) END,
          last_event = CASE WHEN status IN ('ended', 'failed') THEN last_event ELSE ? END,
          updated_at = CASE WHEN status IN ('ended', 'failed') THEN updated_at ELSE ? END
        WHERE id = ?`,
      )
      .bind(status ?? null, event.type, now, taskId)
      .run();
  if (
    event.type === "task-message:appended" &&
    event.data?.messageDirection === "OUTBOUND" &&
    taskId
  ) {
    const message = event.data.channelParams?.message;
    const deliveryStatus = await relayOutbound(event);
    await db
      .prepare(
        `INSERT OR IGNORE INTO messages (id, task_id, direction, sender_type, text, attachments_json, delivery_status, created_at) VALUES (?, ?, 'OUTBOUND', ?, ?, ?, ?, ?)`,
      )
      .bind(
        message?.aliasId ?? event.id,
        taskId,
        event.data.senderType ?? "system",
        message?.text ?? "",
        JSON.stringify(message?.attachments ?? []),
        deliveryStatus,
        normalizeMessageTimestamp(message?.timestamp, now),
      )
      .run();
  }
  return Response.json({ received: true, verified: verification.configured });
}
