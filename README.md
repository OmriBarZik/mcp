# Reversim Summit 2026 MCP server

An [MCP](https://modelcontextprotocol.io) server that helps
[Reversim Summit 2026](https://summit2026.reversim.com) attendees (Nov 30 – Dec 1, 2026)
find the talks that fit them best and plan a clash-free schedule, right from Claude
or any other MCP client.

> "I'm a backend engineer into LLM agents and observability. What should I see on day 1?"

## Tools

| Tool | What it does |
| --- | --- |
| `get_conference_info` | Dates, tracks (with talk counts), rooms, registration link |
| `search_sessions` | Free text search and filters: day, track, room, speaker, time window |
| `get_sessions` | Full details for session ids: abstract, link, speaker bios |
| `find_speakers` | Find speakers by name or by words in their bio/tagline (e.g. a company) |
| `recommend_sessions` | Ranked candidates for the attendee's interests/role, with abstracts, for the AI to reason over |
| `build_schedule` | Clash-free personal schedule: must-sees first, gaps filled by interests, alternatives and clashes listed |
| `whats_on` | What's on now and what's next (venue time), or at any given time |
| `export_calendar` | `.ics` file for the chosen sessions (works with Google Calendar, Outlook and Apple Calendar) |

Also available: the resource `reversim://agenda` (the full agenda as Markdown)
and the prompt `plan_my_reversim`.

Recommendations work without any API key. The server does fast keyword/synonym
ranking, and the attendee's own AI client reads the abstracts and makes the final call.

## Data

The agenda comes live from the event's public Sessionize API (the same source
[the website](https://github.com/reversim/rs26) uses), cached for 10 minutes. If
Sessionize is unreachable, the server falls back to a bundled snapshot
(`src/data/snapshot.ts`).

To refresh the snapshot:

```bash
npm run update-snapshot
```

## Connect

Once deployed (e.g. `https://<your-app>.vercel.app/mcp`):

- **Claude (claude.ai / Desktop):** Settings → Connectors → *Add custom connector* → paste the URL.
- **Claude Code:** `claude mcp add --transport http reversim https://<your-app>.vercel.app/mcp`
- **With a token** (if `MCP_AUTH_TOKEN` is set): add the header `Authorization: Bearer <token>`.

## Develop

```bash
npm install
npm run dev          # http://127.0.0.1:3000/mcp (loopback only)
npm test             # offline tests, including the security tests
npm run typecheck
npx @modelcontextprotocol/inspector   # point it at http://127.0.0.1:3000/mcp
```

Requires Node 20+.

## Deploy (Vercel)

1. Import the repo into Vercel. No framework preset needed: `vercel.json` handles everything.
2. Optional env vars: `MCP_AUTH_TOKEN`, `ALLOWED_ORIGINS`, `RATE_LIMIT_PER_MINUTE`,
   `GA_MEASUREMENT_ID` + `GA_API_SECRET` (see [Metrics](#metrics-and-analytics)).
3. Add a Vercel Firewall rate-limit rule for `/mcp`.

The build step runs the typecheck and tests, so a broken build never ships.

## Metrics and analytics

There are two outputs, both from `src/metrics.ts`.

**Health (always on):** one JSON line per HTTP request in the Vercel logs, for example:

```json
{"type":"request","rid":"…","session":"0e20…","session_tracked":true,"status":200,"duration_ms":41,
 "method":"tools/call","tool":"search_sessions","outcome":"ok","data_source":"live","result_count":4}
```

There is also an `agenda_fetch` line for each Sessionize fetch (`outcome: "ok"` or `"fallback"`).
In Vercel → Logs, filter on `"type":"request"` to see latency and errors by tool, or on
`"outcome":"fallback"` to see when the live agenda was unavailable. Set `METRICS_LOG=off` to disable.

**Usage (Google Analytics 4, off by default):** events are sent with the
[Measurement Protocol](https://developers.google.com/analytics/devguides/collection/protocol/ga4)
after the response (Vercel `waitUntil`), so they never slow a reply.

| Event | Parameters |
| --- | --- |
| `client_connected` | `client_name`, `client_version`, `protocol_version` |
| `tool_call` | `tool`, `outcome` (`ok`/`user_error`/`internal_error`), `duration_ms`, `result_count`, `data_source`, tool filters (`day`, `track`, `has_query`, `query_length`…) |
| `search_no_results` | `tool` and the filters used |
| `session_selected` | `talk_id`, `source` (`get_sessions`/`must_see`/`export_calendar`), `rank` |
| `schedule_built` | `session_count`, `must_see_count`, `conflicts`, `days` |
| `calendar_exported` | `session_count` |
| `agenda_viewed`, `prompt_used` | — |

Every event also carries `session_tracked` (`true`/`false`).

**Sessions and flows.** On `initialize` the server returns a random `Mcp-Session-Id`, and MCP
clients send it back on every later request. That id is the GA `client_id`, and a number
derived from it is the GA `session_id`, so one conversation is one GA user and one GA session.
This lets you build funnels such as
`client_connected → recommend_sessions → build_schedule → calendar_exported`.
The server stores nothing: it never validates or rejects session ids. The id identifies a
conversation, not a person, so a new chat counts as a new user.
Requests without the header get a one-off id and `session_tracked=false`.

**Privacy.** Free text the attendee types (interests, queries, names, "about me") is never
sent, only its length or whether it was given. No IPs or user agents are sent. Track, day and
talk values are sent only when they match the agenda, otherwise `unknown`. Tests in
`test/metrics.test.ts` enforce this.

### Setting up GA

1. In GA4, go to Admin → Data streams and pick (or create) a stream. Copy its **Measurement ID** (`G-…`).
2. In the same stream, open **Measurement Protocol API secrets** → *Create* and copy the secret.
3. In Vercel, add `GA_MEASUREMENT_ID` and `GA_API_SECRET` (mark the secret as *Sensitive*) and redeploy.
4. In GA, go to Admin → Custom definitions and create **event-scoped custom dimensions** for
   `tool`, `outcome`, `talk_id`, `source`, `track`, `day`, `client_name` and `session_tracked`,
   and **custom metrics** for `result_count`, `duration_ms` and `session_count`.
5. Optionally, mark `schedule_built` and `calendar_exported` as **key events**.
6. To check payloads, set `GA_DEBUG=1`. Events then go to GA's validation endpoint, which stores
   nothing, and its response appears in the logs as `ga_debug` lines.

Custom dimensions only apply to events received after you create them.

## Layout

```
api/mcp.ts             Vercel function → src/http/handler.ts
src/server.ts          MCP tools, resource and prompt
src/http/              Hardened HTTP handler and rate limiter
src/metrics.ts         Health log lines and Google Analytics events
src/data/              Sessionize fetch, allowlist validation, normalisation, snapshot
src/logic/             Search/ranking, schedule builder, time zone and ICS helpers
scripts/               Snapshot updater
test/                  Logic, security and metrics tests
```

## Security

See **[SECURITY.md](SECURITY.md)** for the threat model, every control and the deployment checklist.
