# Ops Screen: Service Specification

The page that the service feeds is specified in `docs/spec-screen.md`, and the data contract in
`web/src/core/model.ts`, `web/src/core/identity.ts`, and `web/src/core/config.ts`. This repository
is meant to be published: this file MUST NOT contain figures, names, domains, or addresses of a
real deployment.

## 0. Status

OS-S0. Implemented in `server/`: the store (section 4), the ingest of history (section 5), the
LynShen adapter for history (section 3), regions and the distinct-client rule (section 6), upstream
places (section 7), the views with the restricted merge (section 8), the HTTP API (section 9),
identification with the guest setting (section 12), and live mode by replay for LynShen
(section 13).

OS-S0a. Not implemented: the gateway's live event outlet (OS-B2b), the sub2api and new-api
adapters, and the deployment rule OS-B7.

OS-S0b. The LynShen adapter has been run against a local PostgreSQL with synthetic rows only. It
has not been run against a real gateway database. Identification has been run against a stand-in
for the gateway's `GET /api/dashboard/auth/me`, not against a real gateway.

## 1. Decided rules

Rules marked "decided" are owner decisions of 2026-11-18. Statements about new-api and sub2api
come from reading their source and were not checked on a running instance.

OS-B1. The service is one process with its own store. It reads a gateway through an adapter and
serves the screen. It never writes to the gateway's database. Decided: it is written in Go and
built as one executable that contains the front end.

OS-B2. An adapter turns one gateway's request log into OS-D2 events and OS-D4 buckets, and its
channel list into the topology. Decided: adapters are built in the order LynShen, sub2api, new-api.

OS-B2a. Decided: a gateway that writes one log row per finished request and has no event stream
(sub2api, new-api) is shown in live mode by replay after the end: the service reads each new row
and emits its lifecycle with the recorded timings, so the screen is later than reality by the
duration of the request and shows no request in flight. The screen labels this mode `准实时`.

OS-B2b. Decided: LynShen uses the replay of OS-B2a until a read-only live event outlet of the
gateway has passed its own review. That outlet is a change to the gateway, not to this project.

OS-B2c. Decided: a value that a gateway does not record is shown as `未记录`. The service MUST NOT
fill it with synthetic data. The deployment notes name the gateway setting that records it.

OS-B3. The service resolves a client IP to a region with a local city-level database and keeps
only the region. An event sent to a browser MUST NOT carry a client IP, a user, a key, an error
message, or a payload, and it applies OS-D3a for the viewer's role. Decided: a city is shown as a
city when at least 3 distinct clients sent requests from it in the last 24 hours; otherwise its
requests count toward its province, and a province below 3 distinct clients toward its country.
Section 6 states how the service counts.

OS-B3a. Decided: the default database is the free DB-IP city database, and an operator may supply
a MaxMind database instead. While the service uses the DB-IP database, the page shows one line at
the bottom right that links to DB-IP. The preview does not show this line, because it shows no
DB-IP data.

OS-B4. The service keeps 5-minute rollups per dimension (route and status, region, model) and a
TTFB histogram per bucket; replay reads the rollups only and never scans the gateway's log table
on a page request.

OS-B5. The upstream city of a Channel is resolved from its base URL host at most once per day, and
an operator can override it per Channel (an anycast CDN address has no meaningful city).

OS-B6. Identification is automatic and happens in the service, on every request and on the event
stream.

1. LynShen: the gateway sets the session cookie `monoize_session` for the parent domain of its
   public origin (`dashboard-session-authentication.spec.md` DSA1), so a screen served from a
   subdomain of the same domain receives it. The service takes the token from that cookie, or from
   an `Authorization: Bearer` header, and asks the gateway `GET /api/dashboard/auth/me` (DSA6,
   DSA10). Role `admin` or `super_admin` is `admin`; any other signed-in role is `user`.
2. No token, an expired token, a `401`, or a gateway that does not answer within 3 s is `guest`.
   The service MUST NOT fall back to `admin` or `user`.
3. The service caches the answer per token for at most 60 s and MUST NOT accept a role from a
   query parameter, a header set by the browser, or the page.
4. For a `user` or `guest` the service merges restricted routes per Group and sends no Channel
   name, Channel ID, or upstream site for them (`docs/spec-screen.md` OS-D3a).
5. Other gateways (new-api, sub2api) identify through their own session or token in their
   adapter; the three roles and rules 2 to 4 are the same.
6. Guest access is a setting of the service. Decided: on the LynShen deployment a `guest` cannot
   open the screen during the first 14 days after launch; guest access is turned on after a check
   that no restricted name reaches a `guest`.

OS-B7. Decided: the LynShen deployment is served from a subdomain of the gateway's domain (the
owner chooses the name). The console has one entry that opens the screen in a new browser tab.
Embedding the screen in the console is a later step.

OS-B8. Decided: the project is published as one public repository that holds the front end and
the service, under the Apache-2.0 licence, with a name that does not contain `LynShen`. It shows
no brand mark by default; a deployment adds its mark by configuration. The README states that the
project comes from LynShen. Publication requires `docs/spec-screen.md` OS-P2 and OS-U5 first.

## 2. Adapter contract

OS-SA1. An adapter (`server/internal/gateway`) gives the service four things: its name, its
capabilities (OS-SA4), the current list of Group · Channel pairs, and every finished request whose
start time lies in a given half-open range.

OS-SA2. A request carries: start time, client address (may be empty), model, the Group and Channel
keys of the route that served it (none when the gateway rejected the request before it selected a
Channel), terminal status (`success`, `error`, `client_gone`), TTFB when recorded, duration, and
error code. An adapter MUST NOT read a user, a key, an error message, a request or response body,
or request headers.

OS-SA2a. For live mode by replay (section 13) an adapter also gives, for the requests of a recent
range: an identity of the request's row, and the failed attempts that preceded the serving
Channel, each with its Channel key and its duration. The row identity is kept in memory only, to
tell a new request from one already seen; it is not stored and not sent to a browser.

OS-SA3. A Group · Channel pair carries: the gateway's stable keys of the Group and the Channel,
both display names, the Channel base URL, and the flag `restricted` (OS-D3a).

OS-SA4. Capabilities say what the gateway records, so that the page can label what is missing
(OS-B2c): `live` is `none`, `replayed`, or `realtime`; `origin` is false when the gateway does not
record the client address of every request, or when the service has no geo database; `errors` is
false when the gateway does not log failed requests; `durationPrecisionMs` is 1 or 1000.

OS-SA5. An adapter MUST issue read statements only.

## 3. LynShen adapter

OS-SL1. The adapter reads three tables of the gateway's PostgreSQL database: `request_logs`,
`monoize_providers`, and `monoize_groups`. Every statement runs inside a transaction opened with
`READ ONLY` and with `statement_timeout` set to 60 s, so the database refuses a write whatever the
privileges of the account.

OS-SL2. A Provider row embeds its Channel (`request-logs.spec.md` RL-MIG-2), so one Provider is
one Group · Channel pair. The Group name is `monoize_groups.name`. The Channel name is
`monoize_providers.public_name`, or `channel_public_name` when that is empty. A pair is restricted
when `monoize_groups.account_class` is neither `standard` nor `enterprise`; a missing Group or an
unknown class is restricted.

OS-SL3. A request is one row of `request_logs` whose `created_at_unix_ms` lies in the range and
whose `request_kind` is not `active_probe_connectivity`. `created_at_unix_ms` is the start of the
request (RL1c-1), although the row is written when the request ends. The adapter selects exactly
these columns: `created_at_unix_ms`, `request_ip`, `model`, `provider_id`, `status`, `ttfb_ms`,
`duration_ms`, `error_code`. A row without `created_at_unix_ms` (a legacy row) is not read.

OS-SL3a. The live read (OS-SA2a) selects the same columns and `id`, and from
`tried_providers_json` only the `provider_id` and `duration_ms` of the entries whose `outcome` is
not `served`. That list is extracted by the database inside the statement, so the `error` text of
an attempt never leaves the database. If the database refuses that statement (for example a row
whose text is not JSON), the adapter reads without the failed attempts until its next start, and
the service logs it once.

OS-SL4. The capabilities are `live = replayed` (OS-B2b: until the gateway has a live outlet),
`origin = true`, `errors = true`, `durationPrecisionMs = 1`.

OS-SL5. A DSN that starts with `sqlite://` opens a file with the same three tables. It exists for
tests and for the demo of OS-ST3. LynShen itself runs on PostgreSQL only.

## 4. Store

OS-SS1. The store is one SQLite file, `opsscreen.db` in the data directory. It holds counts and
the dictionaries they refer to. It MUST NOT hold a client address, a user, a key, a payload, an
error message, or an upstream host name.

OS-SS2. A bucket is 5 minutes: bucket number = Unix seconds / 300. The rollup tables are:

| Table | Key | Value |
| --- | --- | --- |
| `rollup_route` | bucket, route, status | request count |
| `rollup_origin` | bucket, region | request count |
| `rollup_model` | bucket, model | request count |
| `rollup_ttfb` | bucket, route | TTFB histogram of successful requests |

Route 0 is "rejected before a Channel was selected". A request whose Channel is no longer listed
by the gateway counts toward one route named `其他 · 已下线的渠道`, which is restricted.

OS-SS3. A TTFB histogram has 48 bins; bin `i` covers `[10 × 1.28^i, 10 × 1.28^(i+1))` ms, the first
bin also takes smaller values and the last bin larger ones. A median read from it is within one
bin width (28 %) of the true median. Histograms are added to answer a longer step.

OS-SS4. The dictionaries are `route` (Group key, Channel key, both names, `restricted`, upstream
site), `site` (an upstream place: name, region, coordinates, `anycast`), `region` (a country, a
province, or a city, with its parent and coordinates), and `model`.

OS-SS5. Rollups are kept for the backfill window plus 5 days.

## 5. Ingest

OS-SI1. The one operation of the ingest is: compute the rollups of a time range from the gateway
again and replace the stored rollups of that range, in one transaction. A range can be computed
any number of times and never counts a request twice. A forward-only cursor is not used, because
a gateway may write a row long after the start time it is stamped with (OS-SL3).

OS-SI2. Backfill: on start the service computes each of the past `backfill_days` days (default
30) that it has not completed yet, oldest first, then today so far.

OS-SI3. Follow: every `interval_seconds` (default 30) the service computes the last
`lookback_minutes` (default 90) again. A request that runs longer than the lookback is counted
only if its row appears before its start time leaves that window.

OS-SI4. A request belongs to the bucket of its start time. `total` of a replay bucket is every
terminal request; `errors` is those with status `error`; `client_gone` is not an error
(`docs/spec-screen.md` OS-L2). In the per-route counts a request counts for the route that served
it last; failed attempts on other Channels are not counted in replay.

OS-SI5. The service reads the gateway's Group · Channel list at start and every 5 minutes.

OS-SI6. `opsscreen reconcile` compares, for every bucket, Channel, and status of the chosen days
up to the start of the lookback window, the gateway's own `COUNT(*)` with the stored count, and
fails when any cell differs.

## 6. Regions and the distinct-client rule

OS-SG1. A client address is looked up in a local database: an optional network table (CSV:
`cidr,country_code,country,province,city,lat,lon`), then a MaxMind-format city database. The
address is used in memory for that lookup and for OS-SG3 and is then dropped. An address that
cannot be parsed or is in neither database has no region.

OS-SG2. A region is a city, a province, or a country; a city's parent is its province, or its
country when the database names no province.

OS-SG3. To count distinct clients the service stores, per day and finest region, a fingerprint of
each client address: the first 8 bytes of HMAC-SHA-256 of the address under a key that is random
per day. When a day is final, the service stores the distinct-client count of that day for every
region at every level, and deletes the fingerprints and the key of that day. A fingerprint
therefore cannot be turned back into an address, and cannot be matched across days.

OS-SG4. A day is a calendar day in the configured time zone. A day is final once it ended more
than the lookback plus 10 minutes ago.

OS-SG5. This is how the service applies the decided rule of OS-B3. The region shown for a request
is the finest of its city, its province, and its country that had at least `min_clients` (default
3) distinct clients on the day of the request; when none had, the request is shown under no
region. While a day is not final, a region also passes when it passed on the day before, so that
regions do not vanish at midnight. A client counts once for its city, once for the province of
that city, and once for the country.

OS-SG6. A province or a country is drawn at the mean position of all its requests of the replay
range, weighted by count. It is not drawn at the position of the cities that were folded into it.

OS-SG7. Place names are taken in the configured language (default `zh-CN`), or in English when
the database has no name in that language.

## 7. Upstream places

OS-SP1. The place of a Channel is found from the host of its base URL: a matching `[[upstream]]`
entry of the configuration wins; otherwise the host is resolved (a literal address is used as it
is) and the first address the geo database knows gives the city. A host is resolved at most once
in 24 hours.

OS-SP2. An `[[upstream]]` entry matches an exact host or a suffix that starts with a dot. It can
give a fixed place, mark the place `anycast`, or hide the upstream of those Channels.

OS-SP3. A Channel whose place is unknown has no upstream site.

## 8. Views

OS-SV1. The service builds two views from the same rollups: the admin view and the restricted
view. A visitor with role `admin` receives the admin view; every other visitor receives the
restricted view. A visitor that could not be identified is never given the admin view.

OS-SV2. Admin view: every route is one entry `Group · Channel` with its upstream site.

OS-SV3. Restricted view: all restricted routes of one Group are one entry
`{ group, channel: "", upstream: null, restricted: true }`, and their counts are added. An upstream
site that only restricted routes use is not in the view. No Channel name, Channel key, or upstream
site of a restricted route is in any answer to such a visitor.

OS-SV4. Origins, models, and totals are the same in both views.

OS-SV5. `Topology.origins` lists the regions that OS-SG5 shows for any day of the last 30 days,
in the order in which the service first saw them, so that an origin keeps its place while others
come and go. `ReplayBucket.origins` is indexed like it. Requests that OS-SG5 shows under no
region are in `total` and in no origin, so the origin counts of a bucket may add up to less than
`total`.

OS-SV6. `ReplayData.models` lists the 14 busiest models of the last 30 days, then `其他模型` for
all the others when there are more.

OS-SV7. A replay window ends at the last complete step: the bucket that contains the present is
left out, and the window is aligned to its step (5 minutes, 30 minutes, 2 hours).

OS-SV8. A view is built at most once per 20 s while the rollups change.

## 9. HTTP API

OS-SH1. The service answers `GET` and `HEAD` only. Every JSON answer has
`Cache-Control: no-store`. A failed request answers `{ "error": "<code>" }`.

OS-SH2. Endpoints:

| Path | Answer |
| --- | --- |
| `/api/identity` | `{ "role": "admin" \| "user" \| "guest", "allowed": boolean, "loginUrl"?: string }` (OS-SN5; `role` as in `web/src/core/identity.ts`) |
| `/api/config` | a `ScreenConfig` (`web/src/core/config.ts`): `title`, and when set `logo`, `note`, `attribution` |
| `/api/meta` | `{ "gateway": string, "capabilities": Capabilities, "minClients": number, "backfilling": boolean }` |
| `/api/topology` | `{ "version": string, "topology": Topology, "baseline24h": { "total", "errors" } }` |
| `/api/replay?window=24h\|7d\|30d` | `{ "version": string, "data": ReplayData }`; `400 invalid_window` otherwise |
| `/api/live`, `/api/live?after=<cursor>` | live events, OS-SR6 |
| `/healthz` | `ok` |

`Capabilities` is `{ "live": "none" | "replayed" | "realtime", "origin": boolean, "errors": boolean,
"durationPrecisionMs": number }` (OS-SA4). `backfilling` is true while OS-SI2 has not finished, so
older parts of a replay may still be empty.

OS-SH3. Every `/api/` answer is made for the role that section 12 gives the visitor. The setting
`dev.viewer = "admin"` skips identification and makes every visitor an admin who may open the
screen; the service refuses to start with it unless it listens on a loopback address.

OS-SH4. `version` names the topology that the indices and ids of an answer refer to. It is a hash
of what they mean for this visitor: the routes in order (Group name, Channel name, upstream id,
`restricted`), the ids of the upstream sites, and the ids of the origins in order. It does not
change when only a coordinate, a channel count, or the baseline changes. The admin view and the
restricted view carry different versions whenever their routes differ, and a visitor whose role
changes (signs in, or the session ends) receives another `version` with the next answer.
`/api/topology`, `/api/replay`, and `/api/live` of the same moment and the same role carry the
same `version`. When a replay answer carries another
`version` than the topology the page holds, the page MUST fetch the topology again before it uses
the answer.

OS-SH5. Site ids, region ids, and the gateway id are opaque strings. A region id or a site id
says nothing about the gateway's own keys.

OS-SH6. `attribution` of `/api/config` is the credit that the licence of the geo database in use
requires (OS-B3a): for the DB-IP database `{ "text": "IP Geolocation by DB-IP", "url":
"https://db-ip.com" }`. It is absent for a network table.

OS-SH7. Every answer carries `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
and a `Content-Security-Policy` that allows the page's own origin only and sets
`frame-ancestors 'none'` (OS-B7: embedding is a later step).

OS-SH8. Any other path serves the front end; a path that is not a file serves `index.html`.

## 10. Configuration

OS-SC1. The configuration is one TOML file; `server/config.example.toml` lists every key. An
unknown key is an error. The gateway DSN may be given in the environment variable
`OPSSCREEN_GATEWAY_DSN` instead of the file.

OS-SC2. The service listens on `127.0.0.1:8787` unless configured otherwise.

OS-SC2a. `[live]` has `enabled` (default `true`), `interval_seconds` (default 2), and
`window_minutes` (default 15), see section 13.

OS-SC3. `gateway.api_url` is the base URL of the gateway's own HTTP API, used for identification
only. `access.guests` (default `true`) and `access.login_url` are the guest setting of OS-SN5.
`access.guests = false` without `gateway.api_url` is an error, because nobody could open the
screen.

## 11. Verification

OS-ST1. `go test ./...` in `server/` covers: the histogram; the store's replace-range and
distinct-client rules; the ingest end to end on synthetic data, including that a second pass
changes nothing and that the rollups equal the gateway's own counts; the restricted view (no
restricted Channel name, no upstream of a restricted route, in any answer); OS-SG5 (a city below
the threshold is shown as its province, a province below it as its country, a country below it
not at all); that the store file and the answers contain no client address and none of the marker
strings that the synthetic data writes into the columns of OS-SA2 that must not be read; and the
HTTP API.

OS-ST2. The tests of the LynShen adapter run on a SQLite file by default, and on PostgreSQL when
`OPSSCREEN_TEST_PG_DSN` names an empty database that the test may fill.

OS-ST3. `opsscreen devseed` writes a demo: a file with the three tables of OS-SL1 filled with
invented requests, a network table that places the invented client addresses, and a
configuration. Every name and number in it is invented.

## 12. Identification and access

OS-SN1. The service identifies the visitor on every `/api/` request: it takes the gateway
credential from the request, asks the gateway whose it is, and maps the answer to `admin`, `user`,
or `guest` (OS-B6). Nothing else of the request is read for this: no query parameter, no other
header, no body. The page cannot state its own role.

OS-SN2. LynShen. The credential is the value of the cookie `monoize_session`, or else the token of
an `Authorization: Bearer` header. A value that is empty, longer than 512 bytes, or has a byte
outside `A-Z a-z 0-9 . _ ~ + / = -` is no credential. The service asks
`GET <gateway.api_url>/api/dashboard/auth/me` with the header `Authorization: Bearer <credential>`.
The answer `200` with a JSON object whose `role` is `admin` or `super_admin` is `admin`; `200` with
any other non-empty `role` is `user`; everything else is `guest`: no credential, `401`, `403`, any
other status, a redirect (it is not followed), a body that is not such an object, a network
error, or no answer within 3 s. The service MUST NOT fall back to `admin` or `user`.

OS-SN3. Without `gateway.api_url` the service asks no gateway and every visitor is `guest`.

OS-SN4. The answer for a credential is kept for at most 60 s when the gateway gave one (`200`,
`401`, `403`), and for 5 s when it gave none, so that a gateway that is down is not asked on every
request. The key of the cache is the SHA-256 of the credential. Requests that arrive with the same
credential at the same time share one question to the gateway. The cache holds at most 10 000
entries.

OS-SN5. Guest setting (OS-B6.6). With `access.guests = false` a `guest` cannot open the screen:
`/api/identity` answers `{ "role": "guest", "allowed": false, "loginUrl": "<access.login_url>" }`
(`loginUrl` is left out when it is not configured), and every other `/api/` endpoint except
`/api/config` answers `401 { "error": "login_required" }`. For every visitor who may open the
screen `/api/identity` carries `"allowed": true`. The page files and `/api/config` are served to
everyone; they hold no data of the gateway.

OS-SN6. A `user` may open the screen whatever the guest setting, and receives the restricted view.

OS-SN7. The service sends a credential to `gateway.api_url` only, which comes from the
configuration and never from a request. It uses no HTTP proxy for that request and follows no
redirect. It keeps a credential in memory for the duration of the request only, and writes it to
no log and no store.

OS-SN8. Every `/api/` answer carries `Vary: Cookie, Authorization` and
`Cross-Origin-Resource-Policy: same-origin`. The service sends no CORS header, so a page of
another origin cannot read an answer.

OS-SN9. Because the service receives the session credentials of its visitors, administrators
included, it MUST run on infrastructure that is trusted like the gateway itself.

## 13. Live mode by replay

This is the decided rule OS-B2a for a gateway that writes one log row per finished request, and
OS-B2b for LynShen. The page labels the mode `准实时` because `capabilities.live` is `replayed`.

OS-SR1. Every `interval_seconds` the service reads the requests whose start lies in the last
`window_minutes` and takes those it has not seen before. It tells them apart by the row identity
of OS-SA2a, which it keeps in memory for that window only. A request that runs longer than the
window is not shown in live mode; the ingest still counts it (OS-SI3). Reading starts as soon as
the service has stored the gateway's Channels (OS-SI5).

OS-SR2. Each new request becomes one lifecycle (`docs/spec-screen.md` OS-D2) that is replayed
with its recorded durations from a replay start `T`:
`T = max(end of the request + 6 s, the time the service saw it)`. For the requests that the first
read after a start of the service finds, `T = end of the request + 6 s`. The 6 s cover the
gateway's write delay and one read interval, so lifecycles normally keep the spacing of the real
ends. The events are `start` at `T`, the `route` events of OS-SR3, `ttfb` at `T + ttfbMs` when a
TTFB was recorded, and `end` at `T + durationMs`. The screen therefore shows the end of a request
later than it happened by the duration of the request, plus 6 s, plus `delayMs`. It never shows a
request that is still running at the gateway.

OS-SR3. Routes. For each failed attempt the gateway recorded for the request, in order, there is
one `route` event of that attempt's Channel: the first at `T`, each next one later by the recorded
duration of the attempt before it. Then follows one `route` event of the Channel that served the
request, except when the request ended in `error` and that Channel is the one of the last failed
attempt. A request that the gateway rejected before it selected a Channel has no `route` event. No
`route` event is later than the `ttfb` event, and no `route` or `ttfb` event is later than the
`end` event, whatever the recorded durations add up to.

OS-SR4. `start.origin` is the id of the region that OS-SG5 shows for the request, when that region
is in the topology of the answer, and `""` otherwise: the request has no shown region, or the
region is new and enters the topology with its next version. A page draws no inbound arc for `""`
and still counts the request.

OS-SR5. The service keeps the lifecycles whose `end` event is at most 35 minutes old, and at most
50 000 of them. The first read after a start covers the last 45 minutes, so the history of
OS-SR6.2 is available at once.

OS-SR6. `GET /api/live` answers
`{ "version": string, "now": number, "pollMs": number, "delayMs": number, "cursor": string,
"reset": boolean, "events": LiveEvent[] }`.

1. `events` are objects of `LiveEvent` (`web/src/core/model.ts`). The events of one lifecycle are
   always in the same answer, in lifecycle order. Lifecycles are in the order in which the service
   created them, which is not the order of `t`: the page sorts by `t` and applies an event when
   its live clock reaches it. An event may lie in the future of `now`.
2. Without `after`, or with a cursor that the service cannot continue from (it was issued by
   another run of the service, or it is older than the buffer), `reset` is `true` and `events` holds
   every lifecycle whose `end` event is not older than 30 minutes: the history the page needs for
   its 30-minute timeline. The page MUST drop the live events it holds before it applies them.
3. With a cursor that the service can continue from, `reset` is `false` and `events` holds the
   lifecycles created after that cursor.
4. `cursor` is opaque; the page passes it as `after` with its next request. `pollMs` is how long
   the page waits before that request.
5. `now` is the service's clock in Unix milliseconds. The page runs its live clock `delayMs`
   behind it (`now - delayMs` at the moment of the answer, advancing with the page's own clock), so
   that every event arrives before the live clock reaches it. The page does not guess this value.
6. `version` is the topology version (OS-SH4) that the `route` indices and the `origin` ids of the
   answer refer to. When it differs from the topology the page holds, the page MUST fetch the
   topology, drop the live events it holds, and ask again without `after`.
7. An event `id` is a number of the service; it says nothing about the gateway's own keys, and it
   is unique within one run of the service only.
8. The endpoint is refused like the other data endpoints (`401 login_required`, OS-SN5). It answers
   `404 { "error": "live_unavailable" }` when `capabilities.live` is `none`.

OS-SR7. `route` indices are those of the visitor's view (section 8). In the restricted view the
route of a restricted Channel is the index of its Group entry, so a failed attempt and the serving
Channel of one restricted Group carry the same index. An event carries no name and no site.

OS-SR8. Live events are not counted: every figure of a replay comes from the ingest alone.

