type RuntimeEnv = { WEBEX_TASKS_URL?: string; WEBEX_ACCESS_TOKEN?: string; WEBEX_CLIENT_ID?: string; WEBEX_CLIENT_SECRET?: string; WEBEX_REFRESH_TOKEN?: string; WEBEX_OAUTH_URL?: string; WEBEX_WEBHOOK_SECRET?: string; PARTNER_DELIVERY_URL?: string };
let tokenCache: { value: string; expiresAt: number } | null = null;

export function runtimeEnv() { return process.env as RuntimeEnv; }
export function integrationMode() {
  const config = runtimeEnv();
  const canAuthenticate = config.WEBEX_ACCESS_TOKEN || (config.WEBEX_CLIENT_ID && config.WEBEX_CLIENT_SECRET && config.WEBEX_REFRESH_TOKEN);
  return config.WEBEX_TASKS_URL && canAuthenticate ? "live" : "sandbox";
}

async function accessToken() {
  const config = runtimeEnv();
  if (config.WEBEX_ACCESS_TOKEN) return config.WEBEX_ACCESS_TOKEN;
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.value;
  if (!config.WEBEX_CLIENT_ID || !config.WEBEX_CLIENT_SECRET || !config.WEBEX_REFRESH_TOKEN) return null;
  const response = await fetch(config.WEBEX_OAUTH_URL ?? "https://webexapis.com/v1/access_token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: config.WEBEX_CLIENT_ID, client_secret: config.WEBEX_CLIENT_SECRET, refresh_token: config.WEBEX_REFRESH_TOKEN }),
  });
  const body = await response.json() as { access_token?: string; expires_in?: number; message?: string };
  if (!response.ok || !body.access_token) throw new Error(body.message ?? "Webex Service App token refresh failed");
  tokenCache = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return tokenCache.value;
}

export async function webexRequest(path: string, payload: unknown) {
  const config = runtimeEnv();
  if (integrationMode() === "sandbox") return { data: { id: crypto.randomUUID() }, sandbox: true };
  const token = await accessToken();
  if (!config.WEBEX_TASKS_URL || !token) throw new Error("Webex Tasks URL or Service App credentials are missing");
  const response = await fetch(`${config.WEBEX_TASKS_URL.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof body.message === "string" ? body.message : `Webex returned HTTP ${response.status}`);
  return body;
}

function hex(bytes: ArrayBuffer) { return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }

export async function verifyWebhook(rawBody: string, request: Request, bodyTimestamp?: number) {
  const secret = runtimeEnv().WEBEX_WEBHOOK_SECRET;
  if (!secret) return { valid: integrationMode() === "sandbox", configured: false };
  const signature = request.headers.get("x-webexcc-signature") ?? "";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const computed = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody)));
  const version = request.headers.get("x-webexcc-webhook-version");
  const timestampHeader = Number(request.headers.get("x-webexcc-timestamp"));
  const timestampMatches = !version || (!!timestampHeader && !!bodyTimestamp && timestampHeader === bodyTimestamp);
  const fresh = !version || (!!timestampHeader && Math.abs(Date.now() - timestampHeader) <= 5 * 60 * 1000);
  let mismatch = signature.length ^ computed.length;
  for (let index = 0; index < computed.length; index++) mismatch |= (signature.charCodeAt(index) || 0) ^ computed.charCodeAt(index);
  const signatureMatches = mismatch === 0;
  return { valid: signatureMatches && timestampMatches && fresh, configured: true };
}

export async function relayOutbound(payload: unknown) {
  const url = runtimeEnv().PARTNER_DELIVERY_URL;
  if (!url) return "not-configured";
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  return response.ok ? "delivered" : `failed:${response.status}`;
}
