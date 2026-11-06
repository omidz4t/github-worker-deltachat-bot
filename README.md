# github-worker-deltachat-bot

Cloudflare Worker using Bun, WebIMAP/WebSMTP, and OpenPGP.js to send signed, encrypted Delta Chat messages to one configured contact.

[Project website](https://omidz4t.github.io/github-worker-deltachat-bot/) · [Source code](https://github.com/omidz4t/github-worker-deltachat-bot)

## Development

```sh
bun install
bun run dev
bun run typecheck
bun run test --run
```

`GET /` returns the hello JSON. `POST /send` submits an encrypted message to the configured contact, using `Authorization: Bearer <API_TOKEN>`. An optional JSON body sets the message: `{"text":"Hello!"}`. Empty bodies use the default hello message. A successful response means the mail server accepted submission; it does not confirm the recipient read it. GET requests never send messages.

## Account and handshake

Before the first setup, set `CHATMAIL_CONTACT_INVITE` locally to your contact invitation and optionally set `WEBIMAP_HOSTNAME`. Put these in an ignored `.env` file or your shell environment. Never commit invitation URLs, account credentials, signing secrets, or private keys.

```sh
bun run chatmail:setup
```

The setup script creates a server-generated random account and a persistent OpenPGP identity. It implements SecureJoin v3: symmetric public-key request, fingerprint and signature verification, signed encrypted authentication, then signed encrypted contact confirmation. The `--legacy` option uses the compatible `vc-request`/`vc-auth-required` key exchange if the v3 request receives no response; it still pins the invitation fingerprint and verifies signatures before sending authentication. This account completed that compatible handshake. Keep the recipient's Delta Chat client online. If it times out, rerun the command to resume the saved handshake.

The account, keys, invite, API token, and handshake state are saved in the ignored file `.env.chatmail-setup.json` with mode 0600. Keep it private and backed up. The sender's OpenPGP user ID uses a display name because OpenPGP.js rejects IP-literal email addresses in structured user IDs; Autocrypt headers carry the actual account address.

## Secrets and deployment

```sh
bun run scripts/create-channel.ts
bun run scripts/push-secrets.ts
bun run deploy
```

The Worker uses a verified TLS socket for IP-literal HTTPS destinations because Cloudflare fetch cannot call IP addresses directly. DNS hostnames use standard fetch.

The upload script sets nine Cloudflare secrets: `WEBIMAP_HOSTNAME`, `EMAIL_USERNAME`, `EMAIL_PASSWORD`, `BOT_PRIVATE_KEY`, `BOT_PUBLIC_KEY`, `CONTACT`, `API_TOKEN`, `GITHUB_WEBHOOK_SECRET`, and `CHANNEL_CONFIG`. The contact secret includes the expected fingerprint, invitation credentials, pinned public key, and verification status. Temporary upload data is deleted after upload. Rerun the upload after the handshake completes to persist the verified contact.

Send a message through the deployed API without printing the API token:

```sh
bun run send "Hello from the Worker!"
```

For another client, retrieve `API_TOKEN` from your local ignored setup file and send it as a bearer token to `https://github-worker-deltachat-bot.omid-zamani-4t.workers.dev/send` with a JSON body.

After changing Worker bindings, run `bun run cf-typegen`.

Protocol references: [WebIMAP/WebSMTP](https://madmail.chat/docs/TDD/10-webimap), [Delta Chat SecureJoin implementation](https://github.com/deltachat/deltachat-core-rust/blob/main/src/securejoin.rs), [OpenPGP.js](https://github.com/openpgpjs/openpgpjs).

## GitHub → Delta Chat channel

The notification channel is **Madmail GitHub**. A SQLite Durable Object stores subscribers, inbox position, the last five channel messages, pending notifications, and processed GitHub delivery IDs. A one-minute alarm and cron trigger process SecureJoin subscription requests and retry queued deliveries. Requests using v3 or compatible legacy SecureJoin are supported. Subscribers receive signed, encrypted broadcast messages without seeing other subscriber addresses. Signed leave requests remove the sender's own subscription.

The original verified contact is enrolled by `bun run channel bootstrap`; other people join through the channel invitation. To inspect or process the channel:

```sh
bun run channel info
bun run channel poll
```

Create configuration once with `bun run scripts/create-channel.ts`, upload it with `bun run scripts/push-secrets.ts`, and deploy with `bun run deploy`. Those commands preserve the existing channel identity and webhook secret.

In **themadorg/madmail → Settings → Webhooks → Add webhook**, use:

- **Payload URL:** `https://github-worker-deltachat-bot.omid-zamani-4t.workers.dev/github/webhook`
- **Content type:** `application/json`
- **Secret:** the contents of the ignored local `.env.github-webhook-secret` file (also stored as the Cloudflare secret `GITHUB_WEBHOOK_SECRET`). This is separate from `API_TOKEN`.
- **SSL verification:** enabled.
- **Events:** select the events you want, or “Send me everything.” Pushes, issues/comments, pull requests/reviews, releases, workflow runs, stars, and forks have detailed summaries; other events receive a compact generic summary.
- **Active:** enabled.

The endpoint verifies `X-Hub-Signature-256` against the exact request bytes using HMAC-SHA256 and rejects other repositories. Change `GITHUB_REPOSITORY` in `wrangler.jsonc` to target a different repository. Valid ping requests receive HTTP 200; notifications are persisted before returning HTTP 202. Payloads over 1 MiB are rejected. Delivery IDs are deduplicated for seven days. Mail submission is retried after failures; a crash after mail acceptance but before recording progress can still cause a duplicate notification. HTTP 202 confirms queue acceptance, not recipient delivery.

`bun run webhook:test` checks a signed ping, signature rejection, queue acceptance, and duplicate delivery handling against the deployed endpoint. It sends a clearly labelled integration test notification to the channel.

## GitHub Pages

The public project site is plain HTML/CSS in `docs/`. GitHub Pages publishes `main` → `/docs`; `.nojekyll` keeps it build-free. The page contains no account credentials, invitation links, or API tokens.
