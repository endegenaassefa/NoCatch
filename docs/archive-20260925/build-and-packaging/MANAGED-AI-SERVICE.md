# Managed AI service

This is the operator-funded backend for the desktop app. End users sign in through your OIDC provider and send access tokens to this API; Gemini and DeepSeek credentials stay on this server. There is no production fake-provider or authentication-bypass mode. An operator must provision the identity tenant, provider billing and HTTPS service before this is usable outside local tests.

## Run and deploy

Requires Node **22.14 or newer** (the built-in `node:sqlite` API is experimental in 22.14). From the repository root:

```sh
npm --prefix server ci
node --env-file=server/.env server/index.js
node --test scripts/test-managed-server.js
```

Copy `server/.env.example` to `server/.env` and set every identity and provider credential. `node --env-file` loads it; the application does not auto-load arbitrary `.env` files. Keep this file out of source control and desktop packages. Use an API audience dedicated to this service and configure a public/native OIDC client with Authorization Code + PKCE for the desktop application. Access tokens must be RS256 or ES256 signed JWTs with `sub`, `iat`, `exp`, the configured issuer and configured audience. Do not send ID tokens as API credentials. Configure HTTPS JWKS explicitly from the issuer's trusted metadata; token claims never select a JWKS URL.

Both AI providers must be configured for readiness. `OIDC_ALLOWED_SUBJECTS` optionally limits access to exact, comma-separated OIDC subjects for an invitation-only pilot. Empty means any valid account in the configured tenant/audience. Set provider spending alerts and billing limits as available. Daily dispatch caps bound requests, not a guaranteed currency amount; accepted, failed, interrupted and cancelled requests all consume quota. Upstream work may be billed after local cancellation. Client retries never automatically redispatch accepted jobs.

Build the container from the **repository root**:

```sh
docker build -f server/Dockerfile -t opencluely-managed .
docker run --env-file server/.env -p 8080:8080 -v managed-data:/data opencluely-managed
```

Terminate public HTTPS at a trusted ingress; forward SSE without buffering with a timeout over 105 seconds. Port 8080 is plain HTTP behind that ingress. One process and one replica own each SQLite database; exclusive database locking deliberately prevents a second process from sharing it. Attach a persistent volume (at least 1 GB for default caps, monitor free space); an ephemeral filesystem loses request deduplication and quota records after replacement. A small persistent-volume Fly.io deployment is one possible pilot host. This design does not provide high availability or horizontal scaling. Do not share the volume over a network filesystem. Restrict volume and backup access to the service operator.

`GET /health/live` reports process liveness. `GET /health/ready` returns 200 only after configuration, prompt loading and writable database startup have succeeded, and returns 503 after a detected persistent-store fault or during shutdown. Readiness does not claim that billing, provider credentials or external identity infrastructure are operational; verify these with a real invited-account smoke test before release. Startup exits on missing operator keys, invalid OIDC configuration, zero/negative quotas or unavailable storage.

## HTTP contract

All `/v1/*` routes require `Authorization: Bearer ACCESS_TOKEN`. JSON errors are `{ "error": { "code": "...", "message": "..." } }`. No CORS access is enabled; the desktop main process owns authenticated network operations.

* `GET /v1/me` → `{subject,providers:["gemini","deepseek"],limits,usage:{requestsToday,dailyLimit}}`.
* `POST /v1/answers`, `Content-Type: application/json`, `Idempotency-Key: <8–128 characters A-Z a-z 0-9 _ . : ->` → 202 `{id,requestId,status:"accepted",text:"",provider,createdAt,updatedAt,eventsUrl,requestUrl}`. A replay of the same normalized input/key returns the same record with status 200. Different normalized input with that key returns 409. Deduplication lasts for retained records (24 hours by default), scoped to the authenticated owner. Unknown input properties are ignored and do not alter the normalized fingerprint.
* `GET /v1/requests/:id` → `{id,requestId,status,text,provider,createdAt,updatedAt,error?}`. Status is `accepted`, `completed`, `failed` or `cancelled`.
* `POST /v1/requests/:id/cancel` → that record. Repeated cancel is harmless; a terminal state is never replaced.
* `GET /v1/requests/:id/events`, optional `Last-Event-ID: N` → SSE replay followed by live events. IDs are positive integers, monotonically increasing per request. An invalid/out-of-range cursor returns 400. The connection closes at the terminal event, access-token expiration or the bounded stream lifetime. Reconnect with a refreshed access token and last delivered event ID, or query the request record. Disconnecting SSE does not cancel the underlying job.

Request body:

```json
{
  "text": "Explain this code",
  "provider": "gemini",
  "skill": "programming",
  "language": "python",
  "history": [{"role":"user","content":"Earlier question"},{"role":"assistant","content":"Earlier answer"}],
  "image": {"mimeType":"image/png","data":"BASE64_WITHOUT_DATA_URL_PREFIX"}
}
```

Only `provider` is required when a nonempty image exists; otherwise text must be nonempty. Default skill is `general`; other skills exactly match bundled prompt filenames (`behavioral`, `dsa`, `mcq`, `ood`, `programming`, `system-design`). Skill prompts use the existing prompt loader, including programming-language injection. Language is a bounded identifier. History accepts only `user` and `assistant` turns; the server constructs its own system instruction. Gemini accepts PNG, JPEG and WebP images. DeepSeek is text-only and rejects images with 422 `image_not_supported`; the client should offer Gemini for image questions.

SSE data shapes:

```text
id: 1
event: accepted
data: {"id":"...","status":"accepted"}

id: 2
event: delta
data: {"text":"answer fragment"}

id: 3
event: completed
data: {"id":"...","status":"completed","text":"full answer"}
```

`failed` carries `{id,status:"failed",error:{code,message}}`; `cancelled` carries `{id,status:"cancelled"}`. Deltas arrive from real upstream streaming but are buffered to approximately 128 characters before durable publication. The complete text in `completed` is authoritative. SSE writes are bounded; slow consumers can be disconnected and must resume by cursor. Event IDs and terminal states are transactionally durable before publication. Request inputs/images/history are not persisted; output, opaque ownership hashes, input fingerprint, event records and quotas are persisted. Provider error bodies and credentials are not echoed to clients or logged.

## Default bounds and recovery

| Bound | Default |
| --- | --- |
| Dispatches per account / UTC day | 50 |
| Dispatches globally / UTC day | 1,000 |
| Concurrent requests per account / globally | 2 / 20 |
| Total stored requests | 2,000 |
| JSON body / decoded image | 4 MiB / 2 MiB |
| Text plus history / history turns | 32,000 characters / 20 |
| Output characters / provider output token request | 32,768 / 4,096 |
| Upstream wire response | 2 MiB |
| Request duration | 90 seconds |
| Event rows per request | 512 |
| Event subscribers per request / globally | 3 / 100 |
| HTTP connections | 128 |
| Request retention | 24 hours |

Quota, active-request, timeout, retention and record limits may be reduced through the documented environment variables. Caps cannot be disabled with zero; invalid configuration fails startup. Capacity exhaustion fails closed and does not evict recent idempotency records. Retention sweeps run once a minute and before new submissions; expired terminal requests/events disappear together. Daily counters persist independently from output retention and reset at UTC midnight. SQLite reuses freed pages; deleting a record is not a secure wipe, and backups have their own operator-controlled retention.

On restart every formerly accepted record receives a terminal `failed` event with code `interrupted`. The service never redispatches it: the upstream may already have billed/completed that request before the crash. The same key therefore returns that interrupted record. A consciously new request needs a new idempotency key and consumes a new allowance. SIGTERM/SIGINT marks running work interrupted and aborts provider requests before shutdown.

Ownership is the hash of fixed issuer + `sub` + `sid` when a session ID exists. Account quotas use issuer + `sub` across sessions. Tokens without `sid` use an account-level owner; standard OIDC does not universally expose login-session identity. Thus signing back into the same account can access that account's retained request IDs. The server does not promise per-login isolation or instant identity-provider logout revocation for already-issued JWTs; short access-token lifetimes and client cancellation/credential clearing are needed. Streams stop at access-token expiry. Unknown or foreign request IDs return the same 404 for status, replay and cancellation.

## Validation and upstream references

`node --test scripts/test-managed-server.js` exercises real local HTTP, actual RSA JWT signing/verification, both provider adapters against an HTTP upstream fixture, account/session ownership, deduplication, replay, conflicting retries, cancellation races, quotas, input/output/time bounds, and restart recovery. Test dependency injection is exposed only through constructors; no environment setting enables fake auth or AI in the production entrypoint. These tests do not establish production OIDC/provider interoperability or real provider billing.

Implementation follows [jose JWT verification](https://github.com/panva/jose), [Gemini generate-content and streaming API](https://ai.google.dev/api/generate-content), and [DeepSeek chat completions](https://api-docs.deepseek.com/api/create-chat-completion/). Operators can change model names in the server configuration as their accounts and provider availability require.
