type RuntimeEnv = {
  WEBEX_TASKS_URL?: string;
  WEBEX_SUBSCRIPTIONS_URL?: string;
  WEBEX_ORG_ID?: string;
  WEBEX_WEBHOOK_URL?: string;
  WEBEX_ACCESS_TOKEN?: string;
  WEBEX_CLIENT_ID?: string;
  WEBEX_CLIENT_SECRET?: string;
  WEBEX_REFRESH_TOKEN?: string;
  WEBEX_SUBSCRIPTIONS_ACCESS_TOKEN?: string;
  WEBEX_SUBSCRIPTIONS_CLIENT_ID?: string;
  WEBEX_SUBSCRIPTIONS_CLIENT_SECRET?: string;
  WEBEX_SUBSCRIPTIONS_REFRESH_TOKEN?: string;
  WEBEX_OAUTH_URL?: string;
  WEBEX_WEBHOOK_SECRET?: string;
  PARTNER_DELIVERY_URL?: string;
};
type TokenPurpose = "tasks" | "subscriptions";
type TokenCache = { value: string; expiresAt: number };

const tokenCaches: Record<TokenPurpose, TokenCache | null> = {
  tasks: null,
  subscriptions: null,
};

export function runtimeEnv() {
  return process.env as RuntimeEnv;
}
export function integrationMode() {
  const config = runtimeEnv();
  const canAuthenticate =
    config.WEBEX_ACCESS_TOKEN ||
    (config.WEBEX_CLIENT_ID &&
      config.WEBEX_CLIENT_SECRET &&
      config.WEBEX_REFRESH_TOKEN);
  return config.WEBEX_TASKS_URL && canAuthenticate ? "live" : "sandbox";
}

async function accessToken(purpose: TokenPurpose) {
  const config = runtimeEnv();
  const credentials =
    purpose === "tasks"
      ? {
          accessToken: config.WEBEX_ACCESS_TOKEN,
          clientId: config.WEBEX_CLIENT_ID,
          clientSecret: config.WEBEX_CLIENT_SECRET,
          refreshToken: config.WEBEX_REFRESH_TOKEN,
        }
      : {
          accessToken: config.WEBEX_SUBSCRIPTIONS_ACCESS_TOKEN,
          clientId: config.WEBEX_SUBSCRIPTIONS_CLIENT_ID,
          clientSecret: config.WEBEX_SUBSCRIPTIONS_CLIENT_SECRET,
          refreshToken: config.WEBEX_SUBSCRIPTIONS_REFRESH_TOKEN,
        };
  if (credentials.accessToken) return credentials.accessToken;
  const cached = tokenCaches[purpose];
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;
  if (
    !credentials.clientId ||
    !credentials.clientSecret ||
    !credentials.refreshToken
  )
    return null;
  const response = await fetch(
    config.WEBEX_OAUTH_URL ?? "https://webexapis.com/v1/access_token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        refresh_token: credentials.refreshToken,
      }),
    },
  );
  const body = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    message?: string;
  };
  if (!response.ok || !body.access_token)
    throw new Error(body.message ?? `Webex ${purpose} token refresh failed`);
  tokenCaches[purpose] = {
    value: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
  return tokenCaches[purpose]!.value;
}

export async function webexAccessToken() {
  return accessToken("tasks");
}

export async function webexSubscriptionsAccessToken() {
  return accessToken("subscriptions");
}

async function webexJsonRequestWithToken(
  token: string | null,
  url: string,
  init: RequestInit = {},
): Promise<unknown> {
  if (!token) throw new Error("Webex Service App credentials are missing");
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const text = await response.text();
  let body: unknown = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: text };
    }
  }
  if (!response.ok) {
    const record = body as { message?: unknown; error?: unknown };
    const detail =
      typeof record.message === "string"
        ? record.message
        : typeof record.error === "string"
          ? record.error
          : `Webex returned HTTP ${response.status}`;
    throw new Error(detail);
  }
  return body;
}

export async function webexJsonRequest(url: string, init: RequestInit = {}) {
  return webexJsonRequestWithToken(await webexAccessToken(), url, init);
}

export async function webexSubscriptionsJsonRequest(
  url: string,
  init: RequestInit = {},
) {
  const token = await webexSubscriptionsAccessToken();
  if (!token)
    throw new Error("Dedicated Webex subscription credentials are missing");
  return webexJsonRequestWithToken(token, url, init);
}

export async function webexRequest(path: string, payload: unknown) {
  const config = runtimeEnv();
  if (integrationMode() === "sandbox")
    return { data: { id: crypto.randomUUID() }, sandbox: true };
  if (!config.WEBEX_TASKS_URL)
    throw new Error("Webex Tasks URL or Service App credentials are missing");
  return webexJsonRequest(
    `${config.WEBEX_TASKS_URL.replace(/\/$/, "")}${path}`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
}

function hex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function verifyWebhook(
  rawBody: string,
  request: Request,
  bodyTimestamp?: number | string,
) {
  const secret = runtimeEnv().WEBEX_WEBHOOK_SECRET;
  if (!secret)
    return {
      valid: integrationMode() === "sandbox",
      configured: false,
      signatureMatches: null,
      timestampMatches: null,
      fresh: null,
    };
  const signature = request.headers.get("x-webexcc-signature") ?? "";
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const computed = hex(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody)),
  );
  const version = request.headers.get("x-webexcc-webhook-version");
  const timestampHeader = Number(request.headers.get("x-webexcc-timestamp"));
  const timestampMatches =
    !version ||
    (!!timestampHeader &&
      !!bodyTimestamp &&
      timestampHeader === Number(bodyTimestamp));
  const fresh =
    !version ||
    (!!timestampHeader &&
      Math.abs(Date.now() - timestampHeader) <= 5 * 60 * 1000);
  let mismatch = signature.length ^ computed.length;
  for (let index = 0; index < computed.length; index++)
    mismatch |= (signature.charCodeAt(index) || 0) ^ computed.charCodeAt(index);
  const signatureMatches = mismatch === 0;
  return {
    valid: signatureMatches && timestampMatches && fresh,
    configured: true,
    signatureMatches,
    timestampMatches,
    fresh,
  };
}

export async function relayOutbound(payload: unknown) {
  const url = runtimeEnv().PARTNER_DELIVERY_URL;
  if (!url) return "not-configured";
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return response.ok ? "delivered" : `failed:${response.status}`;
}
