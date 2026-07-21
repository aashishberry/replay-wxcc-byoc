import { ensureSchema, getDb } from "../../../db";

export async function GET() {
  try {
    await ensureSchema();
    await getDb().prepare("SELECT 1 AS healthy").first();
    return Response.json({ status: "ok" });
  } catch (error) {
    return Response.json(
      {
        status: "error",
        error: error instanceof Error ? error.message : "Database unavailable",
      },
      { status: 503 },
    );
  }
}
