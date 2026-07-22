import { subscribeRealtime } from "../../../lib/realtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const encoder = new TextEncoder();
  let cleanup: () => void = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (event: string, value: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(
              `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`,
            ),
          );
        } catch {
          close();
        }
      };
      const unsubscribe = subscribeRealtime((update) => send("update", update));
      const heartbeat = setInterval(
        () => send("heartbeat", { at: Date.now() }),
        15_000,
      );
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        request.signal.removeEventListener("abort", abort);
      };
      const abort = () => {
        close();
        try {
          controller.close();
        } catch {
          // The client may already have closed the stream.
        }
      };
      cleanup = close;
      request.signal.addEventListener("abort", abort, { once: true });
      send("ready", { at: Date.now() });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
