import { ensureSchema, getDb } from "../../../../../db";
import {
  validateAttachments,
  webexAttachments,
} from "../../../../../lib/messages";
import { webexRequest } from "../../../../../lib/webex";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  await ensureSchema();
  const { id } = await context.params;
  const result = await getDb()
    .prepare(
      "SELECT * FROM messages WHERE task_id = ? ORDER BY created_at ASC, id ASC",
    )
    .bind(id)
    .all();
  return Response.json({ messages: result.results });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  await ensureSchema();
  const { id } = await context.params;
  const input = (await request.json()) as {
    text?: string;
    attachments?: unknown;
  };
  const text = input.text?.trim() ?? "";
  if (!text)
    return Response.json(
      { error: "Message text is required." },
      { status: 400 },
    );
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
    mediaType: "customMessaging",
    channelParams: {
      type: attachments.length ? "text-with-attachments" : "text",
      message: {
        aliasId,
        text,
        ...(attachments.length
          ? { attachments: webexAttachments(attachments) }
          : {}),
        timestamp,
      },
    },
  };
  try {
    await webexRequest(`/${encodeURIComponent(id)}/messages`, payload);
    const db = getDb();
    await db.batch([
      db
        .prepare(
          `INSERT INTO messages (id, task_id, direction, sender_type, text, attachments_json, delivery_status, created_at)
        VALUES (?, ?, 'INBOUND', 'customer', ?, ?, 'accepted', ?)`,
        )
        .bind(aliasId, id, text, JSON.stringify(attachments), timestamp),
      db
        .prepare(
          `INSERT INTO events (id, task_id, type, direction, payload_json, created_at) VALUES (?, ?, 'middleware:message-submitted', 'INBOUND', ?, ?)`,
        )
        .bind(crypto.randomUUID(), id, JSON.stringify(payload), timestamp),
      db
        .prepare(
          "UPDATE tasks SET updated_at = ?, last_event = 'middleware:message-submitted' WHERE id = ?",
        )
        .bind(timestamp, id),
    ]);
    return Response.json({ id: aliasId }, { status: 201 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Append failed" },
      { status: 502 },
    );
  }
}
