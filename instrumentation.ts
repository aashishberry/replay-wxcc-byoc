export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { reconcileSubscriptionsAtStartup } =
    await import("./lib/subscriptions");
  await reconcileSubscriptionsAtStartup();
}
