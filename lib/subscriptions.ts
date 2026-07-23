import { runtimeEnv, webexJsonRequest } from "./webex";

type WebexSubscription = {
  id?: string;
  subscriptionId?: string;
  name?: string;
  description?: string;
  eventTypes?: string[];
  destinationUrl?: string;
  resourceVersion?: string;
  status?: string;
  active?: boolean;
};

type DesiredSubscription = {
  name: string;
  description: string;
  eventTypes: string[];
  resourceVersion: string;
};

export type SubscriptionState = {
  name: string;
  id?: string;
  resourceVersion: string;
  eventTypes: string[];
  status: "active" | "missing" | "needs-update";
  providerStatus?: string;
};

const desiredSubscriptions: DesiredSubscription[] = [
  {
    name: "relay-custom-messaging-task-lifecycle",
    description: "Task lifecycle events for Relay custom messaging middleware",
    eventTypes: [
      "task:new",
      "task:connect",
      "task:connected",
      "task:ended",
      "task:failed",
    ],
    resourceVersion: "task:1.0.0",
  },
  {
    name: "relay-custom-messaging-task-messages",
    description: "Inbound task-message events for Relay middleware",
    eventTypes: ["task-message:appended", "task-message:append-failed"],
    resourceVersion: "task-message:1.0.0",
  },
];

function subscriptionConfig() {
  const config = runtimeEnv();
  const subscriptionsUrl = config.WEBEX_SUBSCRIPTIONS_URL?.trim();
  const orgId = config.WEBEX_ORG_ID?.trim();
  const secret = config.WEBEX_WEBHOOK_SECRET?.trim();
  const destinationUrl = config.WEBEX_WEBHOOK_URL?.trim() ?? "";
  const missing = [
    !subscriptionsUrl && "WEBEX_SUBSCRIPTIONS_URL",
    !orgId && "WEBEX_ORG_ID",
    !destinationUrl && "WEBEX_WEBHOOK_URL",
    !secret && "WEBEX_WEBHOOK_SECRET",
  ].filter(Boolean) as string[];
  let destinationError = "";
  if (destinationUrl) {
    try {
      const destination = new URL(destinationUrl);
      if (destination.protocol !== "https:")
        destinationError = "WEBEX_WEBHOOK_URL must use HTTPS.";
      if (destination.search)
        destinationError = "WEBEX_WEBHOOK_URL cannot contain query parameters.";
    } catch {
      destinationError = "WEBEX_WEBHOOK_URL is invalid.";
    }
  }
  return {
    subscriptionsUrl,
    orgId,
    secret,
    destinationUrl,
    missing,
    destinationError,
  };
}

function subscriptionArray(body: unknown): WebexSubscription[] {
  if (Array.isArray(body)) return body as WebexSubscription[];
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  if (Array.isArray(record.data)) return record.data as WebexSubscription[];
  if (record.data && typeof record.data === "object") {
    const data = record.data as Record<string, unknown>;
    if (Array.isArray(data.items)) return data.items as WebexSubscription[];
    if (Array.isArray(data.subscriptions))
      return data.subscriptions as WebexSubscription[];
  }
  if (Array.isArray(record.items)) return record.items as WebexSubscription[];
  if (Array.isArray(record.subscriptions))
    return record.subscriptions as WebexSubscription[];
  return [];
}

function sameEvents(left: string[] = [], right: string[] = []) {
  return [...left].sort().join("\n") === [...right].sort().join("\n");
}

function evaluate(
  existing: WebexSubscription[],
  destinationUrl: string,
): SubscriptionState[] {
  return desiredSubscriptions.map((desired) => {
    const matches = existing.filter((item) => item.name === desired.name);
    const exact = matches.find(
      (item) =>
        item.destinationUrl === destinationUrl &&
        item.resourceVersion === desired.resourceVersion &&
        sameEvents(item.eventTypes, desired.eventTypes) &&
        item.active !== false &&
        !["disabled", "inactive"].includes(item.status?.toLowerCase() ?? ""),
    );
    const subscription = exact ?? matches[0];
    return {
      name: desired.name,
      id: subscription?.id ?? subscription?.subscriptionId,
      resourceVersion: desired.resourceVersion,
      eventTypes: desired.eventTypes,
      status: exact ? "active" : subscription ? "needs-update" : "missing",
      providerStatus:
        subscription?.status ??
        (typeof subscription?.active === "boolean"
          ? subscription.active
            ? "active"
            : "inactive"
          : undefined),
    };
  });
}

async function listSubscriptions() {
  const config = subscriptionConfig();
  if (config.missing.length || config.destinationError) return { config };
  const url = new URL(config.subscriptionsUrl!);
  url.searchParams.set("orgId", config.orgId!);
  const body = await webexJsonRequest(url.toString());
  return { config, existing: subscriptionArray(body) };
}

export async function subscriptionStatus() {
  const { config, existing } = await listSubscriptions();
  if (config.missing.length || config.destinationError) {
    return {
      configured: false,
      destinationUrl: config.destinationUrl,
      missing: config.missing,
      error: config.destinationError || undefined,
      subscriptions: desiredSubscriptions.map((item) => ({
        name: item.name,
        resourceVersion: item.resourceVersion,
        eventTypes: item.eventTypes,
        status: "missing" as const,
      })),
    };
  }
  const subscriptions = evaluate(existing ?? [], config.destinationUrl);
  return {
    configured: true,
    destinationUrl: config.destinationUrl,
    synced: subscriptions.every((item) => item.status === "active"),
    subscriptions,
  };
}

export async function syncSubscriptions() {
  const { config, existing = [] } = await listSubscriptions();
  if (config.missing.length)
    throw new Error(`Missing configuration: ${config.missing.join(", ")}`);
  if (config.destinationError) throw new Error(config.destinationError);
  const before = evaluate(existing, config.destinationUrl);
  const created: string[] = [];
  for (const desired of desiredSubscriptions) {
    const state = before.find((item) => item.name === desired.name)!;
    if (state.status !== "missing") continue;
    await webexJsonRequest(config.subscriptionsUrl!, {
      method: "POST",
      body: JSON.stringify({
        ...desired,
        destinationUrl: config.destinationUrl,
        secret: config.secret,
        orgId: config.orgId,
      }),
    });
    created.push(desired.name);
  }
  const status = await subscriptionStatus();
  return { ...status, created };
}

export async function reconcileSubscriptionsAtStartup() {
  const config = subscriptionConfig();
  const hasAnyConfiguration = Boolean(
    config.subscriptionsUrl ||
    config.orgId ||
    config.secret ||
    config.destinationUrl,
  );
  if (!hasAnyConfiguration) return;

  try {
    const result = await syncSubscriptions();
    console.info(
      "[webex-subscriptions] startup reconciliation",
      JSON.stringify({
        created: result.created,
        subscriptions: result.subscriptions.map((subscription) => ({
          name: subscription.name,
          status: subscription.status,
          providerStatus:
            "providerStatus" in subscription
              ? subscription.providerStatus
              : undefined,
        })),
      }),
    );
  } catch (error) {
    console.error(
      "[webex-subscriptions] startup reconciliation failed",
      JSON.stringify({
        error:
          error instanceof Error
            ? error.message
            : "Unknown subscription reconciliation error",
      }),
    );
  }
}
