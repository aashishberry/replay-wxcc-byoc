import { ensureSchema, getDb } from "../../../db";
import {
  attachmentPolicy,
  validateAttachments,
  webexAttachments,
} from "../../../lib/messages";
import { publishRealtime } from "../../../lib/realtime";
import { integrationMode, webexRequest } from "../../../lib/webex";

export async function GET() {
  await ensureSchema();
  const tasks = await getDb()
    .prepare("SELECT * FROM tasks ORDER BY updated_at DESC LIMIT 100")
    .all();
  const events = await getDb()
    .prepare("SELECT * FROM events ORDER BY created_at DESC LIMIT 80")
    .all();
  return Response.json({
    tasks: tasks.results,
    events: events.results,
    mode: integrationMode(),
    attachmentPolicy: attachmentPolicy(),
  });
}

export async function POST(request: Request) {
  await ensureSchema();
  const input = (await request.json()) as {
    originId?: string;
    originName?: string;
    destinationId?: string;
    channel?: string;
    text?: string;
    customerTier?: string;
    attachments?: unknown;
  };
  if (
    [input.originId, input.destinationId, input.channel, input.text].some(
      (value) => !value?.trim(),
    )
  ) {
    return Response.json(
      { error: "Origin, destination, channel, and message are required." },
      { status: 400 },
    );
  }
  let attachments;
  try {
    attachments = validateAttachments(input.attachments);
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Invalid attachments.",
      },
      { status: 400 },
    );
  }
  const aliasId = crypto.randomUUID();
  const timestamp = Date.now();
  const payload = {
    origin: {
      id: input.originId!.trim(),
      name: input.originName?.trim() || undefined,
    },
    destination: { id: input.destinationId!.trim(), type: "businessAddress" },
    channelType: "customMessaging",
    channel: input.channel!.trim(),
    ...(input.customerTier?.trim()
      ? { globalVariables: { customerTier: input.customerTier.trim() } }
      : {}),
    channelParams: {
      type: attachments.length ? "text-with-attachments" : "text",
      message: {
        aliasId,
        text: input.text!.trim(),
        ...(attachments.length
          ? { attachments: webexAttachments(attachments) }
          : {}),
        timestamp,
      },
    },
  };
  try {
    const response = (await webexRequest("", payload)) as {
      data?: { id?: string };
    };
    const taskId = response.data?.id ?? crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const task = {
      id: taskId,
      origin_id: input.originId!.trim(),
      origin_name: input.originName?.trim() ?? "",
      destination_id: input.destinationId!.trim(),
      channel: input.channel!.trim(),
      status: "accepted",
      last_event: "middleware:task-submitted",
      initial_text: input.text!.trim(),
      created_at: timestamp,
      updated_at: timestamp,
    };
    const message = {
      id: aliasId,
      task_id: taskId,
      direction: "INBOUND",
      sender_type: "customer",
      text: input.text!.trim(),
      attachments_json: JSON.stringify(attachments),
      delivery_status: "accepted",
      created_at: timestamp,
    };
    const event = {
      id: eventId,
      task_id: taskId,
      type: "middleware:task-submitted",
      direction: "INBOUND",
      created_at: timestamp,
    };
    const db = getDb();
    await db.batch([
      db
        .prepare(
          `INSERT INTO tasks (id, origin_id, origin_name, destination_id, channel, status, last_event, initial_text, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'accepted', 'middleware:task-submitted', ?, ?, ?)`,
        )
        .bind(
          taskId,
          input.originId!.trim(),
          input.originName?.trim() ?? "",
          input.destinationId!.trim(),
          input.channel!.trim(),
          input.text!.trim(),
          timestamp,
          timestamp,
        ),
      db
        .prepare(
          `INSERT OR IGNORE INTO messages (id, task_id, direction, sender_type, text, attachments_json, delivery_status, created_at)
        VALUES (?, ?, 'INBOUND', 'customer', ?, ?, 'accepted', ?)`,
        )
        .bind(
          aliasId,
          taskId,
          input.text!.trim(),
          JSON.stringify(attachments),
          timestamp,
        ),
      db
        .prepare(
          `INSERT INTO events (id, task_id, type, direction, payload_json, created_at) VALUES (?, ?, 'middleware:task-submitted', 'INBOUND', ?, ?)`,
        )
        .bind(eventId, taskId, JSON.stringify(payload), timestamp),
    ]);
    const persistedMessage =
      (await db
        .prepare("SELECT * FROM messages WHERE id = ? AND task_id = ?")
        .bind(aliasId, taskId)
        .first<typeof message>()) ?? message;
    const update = {
      kind: "task",
      taskId,
      eventType: "middleware:task-submitted",
      at: timestamp,
      task,
      message: persistedMessage,
      event,
    } as const;
    publishRealtime(update);
    return Response.json(
      { taskId, aliasId, mode: integrationMode(), update },
      { status: 201 },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Create task failed" },
      { status: 502 },
    );
  }
}
