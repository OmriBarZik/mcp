# Security report — Reversim Summit 2026 MCP server

This server is **public by design**: it answers questions about the public
RS26 agenda. "Secure" here means four things:

1. It exposes **only** the data we chose to expose.
2. Clients can **only** call the read-only tools we define.
3. It can't be used to reach anything else (no SSRF, no files, no secrets).
4. It's hard to abuse or knock over.

Every control below is enforced in code, and most have a test in
[`test/security.test.ts`](test/security.test.ts).

---

## 1. Attack surface

| Surface | What is exposed | Everything else |
| --- | --- | --- |
| HTTP | `POST /mcp` only (JSON-RPC, one message per request) | `404` for other paths, `405` for other methods, `415` for non-JSON |
| MCP tools | 8 read-only tools, all with `readOnlyHint: true` | No tool writes, deletes, sends, or reads files/env |
| MCP resources | `reversim://agenda` (public agenda as Markdown) | No resource templates and no file:// access |
| Static files | `public/robots.txt` (`Disallow: /`) | Source, `package.json`, tests etc. are **not** served (`outputDirectory: public`) |
| Outbound network | 2 hard-coded Sessionize URLs (`src/config.ts`) | No URL is ever built from user input, so there is no SSRF |

The server is **stateless**: no sessions, no SSE streams, no database, no cookies.
Nothing is stored between requests except a 10-minute in-memory cache of the
public agenda.

## 2. Data exposure: allowlist only

Data comes from Sessionize's public API for the event (`1saptwag`), the same
feeds the official website uses.

- **Schema allowlist** (`src/data/validate.ts`): the feeds are parsed with zod
  schemas that **drop unknown fields**. If Sessionize ever adds private data
  (Q&A answers, emails, phone numbers), it is discarded before it reaches the
  server. A test feeds an email and a phone number in and checks they never come out.
- **Malformed data is rejected** as a whole, and the server falls back to the
  reviewed, committed snapshot (`src/data/snapshot.ts`, also trimmed to the allowlist).
- **Size limits** on every upstream field, and on the whole payload (3 MB, streamed
  and cut off).
- **Links**: only `http(s)` speaker links pass (`javascript:` and `data:` are dropped).
  Photos are accepted only from `https://cdn.sessionize.com`.
- **Text sanitising**: control characters and Unicode bidi-override characters
  (spoofing / "Trojan Source") are removed from all third-party text.
- **Upstream fetch** (`src/data/agenda.ts`): 4 s timeout, `redirect: "error"` (never
  follows a redirect to another host), content-type must be JSON, no credentials sent.

Fields exposed per session: id, title, abstract, time, room, track, speaker
names, website link. Fields exposed per speaker: name, tagline, bio, public
links, Sessionize photo URL, talks. All of this is already public on
summit2026.reversim.com.

## 3. Request handling (`src/http/handler.ts`)

Checks run in this order and fail closed:

1. **Path**: must be `/mcp`, otherwise `404`.
2. **Origin**: if a browser `Origin` header is present, it must be in
   `ALLOWED_ORIGINS`, otherwise `403`. This blocks DNS-rebinding and cross-site
   requests. No CORS headers are sent unless the origin is allowlisted.
3. **Method**: only `POST` (and `OPTIONS` preflight for allowlisted origins), otherwise `405`.
4. **Rate limit**: per client IP, default 60 requests/min (`RATE_LIMIT_PER_MINUTE`), otherwise `429` with `Retry-After`.
5. **Auth** (optional): if `MCP_AUTH_TOKEN` is set, `Authorization: Bearer <token>`
   is required, otherwise `401`. The comparison is constant-time (SHA-256 + `timingSafeEqual`).
6. **Content-Type**: must be `application/json`, otherwise `415`.
7. **Body size**: max 32 KB, read from the raw stream before parsing, otherwise `413`.
8. **Shape**: a single JSON-RPC object. Batches and arrays get `400`.
9. **Tool arguments**: strict zod schemas. Every string is length-bounded (≤ 500 chars),
   arrays have max sizes, session ids must match `^[A-Za-z0-9-]{1,64}$`, times
   must be `HH:MM`. Invalid input is rejected before any logic runs.

**Response headers** on every response: `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`,
`Referrer-Policy: no-referrer`, `Cache-Control: no-store`, `Strict-Transport-Security`.

**Errors never leak internals.** Only deliberate `UserError` messages (e.g.
"Unknown day") reach clients. Everything else becomes a generic
"Internal error", and only the message (no request bodies, no IPs) is logged.

**No ReDoS risk.** No user input is ever compiled into a regular expression.
All regexes are fixed and linear.

## 4. Prompt-injection hygiene

Abstracts and bios are written by speakers, so they are third-party text that
flows into the attendee's LLM. The server instructions tell the client to treat
them as **data, never instructions**. Tools return them inside JSON fields, never
as instructions. The server has no tools capable of side effects, so even a
successful injection can't make it *do* anything.

## 5. Calendar export

`.ics` output escapes `\ ; , newline` per RFC 5545, folds lines at 75 octets and
uses only CRLF, so a malicious title can't inject extra calendar properties
(tested).

## 6. Supply chain

- 3 runtime dependencies, all pinned to exact versions (`.npmrc save-exact`):
  `@modelcontextprotocol/sdk` (official), `zod`, `slug`. A lockfile is committed.
- `npm audit`: **0 vulnerabilities** at the time of writing.
- CI (`.github/workflows/ci.yml`) runs typecheck, tests and `npm audit` on every
  push and PR, with `permissions: contents: read`.
- Dependabot opens weekly update PRs for npm and GitHub Actions.

## 7. Deployment checklist (Vercel)

- [ ] Deploy only from the main branch, and require PR review + green CI before merging.
- [ ] **Vercel Firewall → Rate limiting rule** on `/mcp` (e.g. 120 req/min per IP).
      The in-code limiter is per instance, so this is the authoritative limit.
- [ ] Optional: set `MCP_AUTH_TOKEN` (as a Vercel *Sensitive* env var) if you want
      to restrict use to people you give the token to.
- [ ] Optional: set `ALLOWED_ORIGINS` only if a browser-based client must call the server.
- [ ] Keep Vercel *Deployment Protection* on preview deployments.
- [ ] Never add secrets to the repo. The server needs none to run.

## 8. Configuration reference

| Variable | Default | Effect |
| --- | --- | --- |
| `MCP_AUTH_TOKEN` | unset (public) | When set, requires `Authorization: Bearer <token>` |
| `ALLOWED_ORIGINS` | empty | Comma-separated browser origins allowed to call `/mcp` |
| `RATE_LIMIT_PER_MINUTE` | `60` | Per-IP, per-instance request limit |
| `REVERSIM_OFFLINE` | unset | `1` = use only the bundled snapshot, never call Sessionize |

## 9. Known limitations / accepted risks

- **Public by default.** Anyone with the URL can query the (public) agenda. Set
  `MCP_AUTH_TOKEN` if that is not acceptable.
- **The in-memory rate limiter is per serverless instance.** Use the Vercel Firewall rule above.
- **Upstream trust.** If the Sessionize event itself were compromised, attackers could
  change agenda text (still schema-checked, size-limited and sanitised). They could
  not make the server do anything other than return that text.

## Reporting a vulnerability

Please report security issues privately to the repository owner (GitHub
**Security → Report a vulnerability**) rather than in a public issue.
