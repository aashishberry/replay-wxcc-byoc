import { ensureSchema, getDb } from "../../../../db";
import { normalizeMessageTimestamp } from "../../../../lib/messages";
import {
  publishRealtime,
  type RealtimeMessage,
  type RealtimeTaskPatch,
} from "../../../../lib/realtime";
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
    console.warn(
      "[webex-webhook] rejected",
      JSON.stringify({ reason: "invalid-json", receivedAt: Date.now() }),
    );
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const receipt = {
    eventId: event.id ?? null,
    type: event.type ?? null,
    taskId: event.data?.taskId ?? null,
    receivedAt: Date.now(),
    webhookVersion: request.headers.get("x-webexcc-webhook-version") ?? null,
    hasSignature: request.headers.has("x-webexcc-signature"),
    bodyTimestamp: event.comciscotimestamp ?? null,
  };
  console.info("[webex-webhook] received", JSON.stringify(receipt));
  const verification = await verifyWebhook(
    rawBody,
    request,
    event.comciscotimestamp,
  );
  if (!verification.valid) {
    console.warn(
      "[webex-webhook] rejected",
      JSON.stringify({
        ...receipt,
        reason: "verification-failed",
        signatureMatches: verification.signatureMatches,
        timestampMatches: verification.timestampMatches,
        fresh: verification.fresh,
      }),
    );
    return Response.json(
      { error: "Invalid webhook signature or timestamp" },
      { status: 401 },
    );
  }
  if (!event.id || !event.type)
    return Response.json(
      { error: "Webhook id and type are required" },
      { status: 400 },
    );
  await ensureSchema();
  const db = getDb();
  // The webhook envelope timestamp is UTC epoch milliseconds generated when
  // Webex constructs the request. Prefer it for receipt order and display.
  // Some outbound payloads contain a nested message timestamp whose clock or
  // timezone does not agree with the envelope, which otherwise moves a newly
  // received message earlier in the conversation.
  const now = normalizeMessageTimestamp(
    event.comciscotimestamp,
    normalizeMessageTimestamp(event.data?.createdTime),
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
  ) {
    console.info(
      "[webex-webhook] duplicate",
      JSON.stringify({ ...receipt, taskId: taskId ?? null }),
    );
    return Response.json({ received: true, duplicate: true });
  }
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
  let realtimeMessage: RealtimeMessage | undefined;
  if (
    event.type === "task-message:appended" &&
    event.data?.messageDirection === "OUTBOUND" &&
    taskId
  ) {
    const message = event.data.channelParams?.message;
    const messageCreatedAt = normalizeMessageTimestamp(
      event.comciscotimestamp,
      normalizeMessageTimestamp(
        event.data.createdTime,
        normalizeMessageTimestamp(message?.timestamp),
      ),
    );
    const deliveryStatus = await relayOutbound(event);
    realtimeMessage = {
      id: message?.aliasId ?? event.id,
      task_id: taskId,
      direction: "OUTBOUND",
      sender_type: event.data.senderType ?? "system",
      text: message?.text ?? "",
      attachments_json: JSON.stringify(message?.attachments ?? []),
      delivery_status: deliveryStatus,
      created_at: messageCreatedAt,
    };
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
        messageCreatedAt,
      )
      .run();
  }
  const taskPatch = taskId
    ? await db
        .prepare(
          "SELECT id, status, last_event, updated_at FROM tasks WHERE id = ?",
        )
        .bind(taskId)
        .first<RealtimeTaskPatch>()
    : null;
  const eventItem = {
    id: storedEventId,
    task_id: taskId,
    type: event.type,
    direction:
      event.data?.messageDirection ?? event.data?.direction ?? undefined,
    reason: event.data?.reason,
    error_message: event.data?.errorMessage,
    created_at: now,
  };
  console.info(
    "[webex-webhook] accepted",
    JSON.stringify({ ...receipt, status: status ?? null }),
  );
  publishRealtime({
    kind: "webhook",
    taskId,
    eventType: event.type,
    at: now,
    taskPatch: taskPatch ?? undefined,
    message: realtimeMessage,
    event: eventItem,
  });
  return Response.json({
    received: true,
    verified: verification.configured,
    type: event.type,
    taskId: taskId ?? null,
  });
}
