# Ops Screen: Service Specification (draft)

The service is not implemented. This file starts from the rules agreed on 2026-11-18; rules marked
"decided" are fixed, the others are a proposal. The page that the service feeds is specified in
`docs/spec-screen.md`, and the data contract in `web/src/core/model.ts` and
`web/src/core/identity.ts`. This repository is meant to be published: this file MUST NOT contain
figures, names, domains, or addresses of a real deployment.

## 6. Rules

Statements about new-api and sub2api come from reading their source and were not checked on a
running instance.

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
