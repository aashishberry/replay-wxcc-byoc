import { ensureSchema, getDb } from "../../../db";
import { integrationMode, webexRequest } from "../../../lib/webex";

export async function GET() {
  await ensureSchema();
  const tasks = await getDb().prepare("SELECT * FROM tasks ORDER BY updated_at DESC LIMIT 100").all();
  const events = await getDb().prepare("SELECT * FROM events ORDER BY created_at DESC LIMIT 80").all();
  return Response.json({ tasks: tasks.results, events: events.results, mode: integrationMode() });
}

export async function POST(request: Request) {
  await ensureSchema();
  const input = await request.json() as { originId?: string; originName?: string; destinationId?: string; channel?: string; text?: string; customerTier?: string };
  if ([input.originId, input.destinationId, input.channel, input.text].some((value) => !value?.trim())) {
    return Response.json({ error: "Origin, destination, channel, and message are required." }, { status: 400 });
  }
  const aliasId = crypto.randomUUID(); const timestamp = Date.now();
  const payload = {
    origin: { id: input.originId!.trim(), name: input.originName?.trim() || undefined },
    destination: { id: input.destinationId!.trim(), type: "businessAddress" },
    channelType: "customMessaging", channel: input.channel!.trim(),
    ...(input.customerTier?.trim() ? { globalVariables: { customerTier: input.customerTier.trim() } } : {}),
    channelParams: { type: "text", message: { aliasId, text: input.text!.trim(), timestamp } },
  };
  try {
    const response = await webexRequest("", payload) as { data?: { id?: string } };
    const taskId = response.data?.id ?? crypto.randomUUID(); const db = getDb();
    await db.batch([
      db.prepare(`INSERT INTO tasks (id, origin_id, origin_name, destination_id, channel, status, last_event, initial_text, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'accepted', 'middleware:task-submitted', ?, ?, ?)`)
        .bind(taskId, input.originId!.trim(), input.originName?.trim() ?? "", input.destinationId!.trim(), input.channel!.trim(), input.text!.trim(), timestamp, timestamp),
      db.prepare(`INSERT INTO messages (id, task_id, direction, sender_type, text, attachments_json, delivery_status, created_at)
        VALUES (?, ?, 'INBOUND', 'customer', ?, '[]', 'accepted', ?)`)
        .bind(aliasId, taskId, input.text!.trim(), timestamp),
      db.prepare(`INSERT INTO events (id, task_id, type, direction, payload_json, created_at) VALUES (?, ?, 'middleware:task-submitted', 'INBOUND', ?, ?)`)
        .bind(crypto.randomUUID(), taskId, JSON.stringify(payload), timestamp),
    ]);
    return Response.json({ taskId, aliasId, mode: integrationMode() }, { status: 201 });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Create task failed" }, { status: 502 }); }
}
