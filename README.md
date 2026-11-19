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
2. Optional env vars: `MCP_AUTH_TOKEN`, `ALLOWED_ORIGINS`, `RATE_LIMIT_PER_MINUTE`.
3. Add a Vercel Firewall rate-limit rule for `/mcp`.

The build step runs the typecheck and tests, so a broken build never ships.

## Layout

```
api/mcp.ts             Vercel function → src/http/handler.ts
src/server.ts          MCP tools, resource and prompt
src/http/              Hardened HTTP handler and rate limiter
src/data/              Sessionize fetch, allowlist validation, normalisation, snapshot
src/logic/             Search/ranking, schedule builder, time zone and ICS helpers
scripts/               Snapshot updater
test/                  Logic and security tests
```

## Security

See **[SECURITY.md](SECURITY.md)** for the threat model, every control and the deployment checklist.
