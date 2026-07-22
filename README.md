# Relay — Render edition

A standard Next.js and PostgreSQL version of the Webex Contact Center custom
messaging middleware. It does not depend on Cloudflare Workers, Vinext, or D1.

The original Cloudflare edition remains in the sibling directory
`relay-webex-messaging`.

## Deploy on Render

The included `render.yaml` Blueprint creates both resources on their free plans:

- A public Node.js web service.
- A PostgreSQL database wired to the app through `DATABASE_URL`.

Render deploys from a Git repository, so first put this directory in a GitHub,
GitLab, or Bitbucket repository. Then:

1. Sign in to [Render](https://dashboard.render.com/).
2. Choose **New > Blueprint**.
3. Connect the repository containing this project.
4. Confirm the resources from `render.yaml` and choose **Apply**.
5. Wait for both resources to show as available.

No Webex values are required for the first deployment. The UI starts in sandbox
mode, and **Advance demo event** simulates the task lifecycle.

Render assigns a public address similar to:

```text
https://relay-webex-messaging.onrender.com
```

The public Webex webhook endpoint is:

```text
https://relay-webex-messaging.onrender.com/api/webhooks/webex
```

The database schema is created automatically by the app's health check. You do
not need to run a migration command for this prototype.

## Connect Webex

In the Render Dashboard, open the web service and add the following under
**Environment**:

```text
WEBEX_TASKS_URL=<region-specific Create Task v2 URL>
WEBEX_ACCESS_TOKEN=<token with cjp:task_write>
WEBEX_WEBHOOK_SECRET=<secret shared with the Webex asset/subscriptions>
```

Alternatively, replace `WEBEX_ACCESS_TOKEN` with these Service App values:

```text
WEBEX_CLIENT_ID=
WEBEX_CLIENT_SECRET=
WEBEX_REFRESH_TOKEN=
```

Optional values:

```text
WEBEX_OAUTH_URL=https://webexapis.com/v1/access_token
PARTNER_DELIVERY_URL=<external-channel delivery adapter URL>
```

Save the variables and let Render redeploy. Point the Webex asset webhook and
subscriptions to the `/api/webhooks/webex` URL shown above.

The asset-level webhook delivers outbound Custom Messaging content, but task
lifecycle changes require Subscriptions API registrations. Subscribe this same
endpoint to `task:new`, `task:connect`, `task:connected`, `task:ended`, and
`task:failed`, plus `task-message:appended` and
`task-message:append-failed`. Without the `task:ended` subscription, ending a
task in Contact Center cannot close its local console record.

Webhook delivery is not guaranteed, so production deployments should also
reconcile task state periodically with the Webex Search API.

## Run locally

Node.js 22+ is required. PostgreSQL is optional for UI testing: when
`DATABASE_URL` is absent in development, the app uses an in-memory database that
is cleared when the process restarts.

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). To test persistence, create
`.env.local` from `.env.example`, set `DATABASE_URL`, and set
`DATABASE_SSL=false` for a typical local PostgreSQL server.

## Rich messages and attachments

Message text accepts Markdown and a safe subset of HTML. Scripts, event
handlers, inline styles, and unsafe URLs are removed before rendering. Images in
message content and attachment metadata are rendered inline when they use HTTPS.

Custom Messaging attachments are URL based; this console does not upload local
files. Paste a public HTTPS `fileUrl`; the console derives `fileName` and
`mimeType` from known extensions, or offers the configured MIME types when the
extension is unknown. Webex performs the authoritative remote-size and
channel-policy validation using metadata such as `Content-Length`.

```text
ATTACHMENTS_ENABLED=true
MAX_ATTACHMENT_COUNT=5
MAX_ATTACHMENT_BYTES=10485760
MAX_TOTAL_ATTACHMENT_BYTES=26214400
ALLOWED_ATTACHMENT_MIME_TYPES=image/*,application/pdf,text/plain,text/csv
```

Configure the corresponding attachment policy and size limits in Webex Control
Hub. These middleware values mirror that policy for UI guidance; Webex remains
authoritative. Set `ATTACHMENTS_ENABLED=false` to disable the attachment controls
and make the API reject attachment payloads. The UI intentionally does not ask
end users to estimate a file size.

## Free-tier limitations

Render's free web service spins down after 15 minutes without inbound traffic,
so the first request or webhook after an idle period can take about a minute.
Free Render PostgreSQL databases currently expire 30 days after creation and do
not include backups. This setup is therefore intended for learning and testing,
not production.
