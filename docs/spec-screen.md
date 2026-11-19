# Request Monitor: Screen Specification (draft)

## 0. Status

OS-0. This file specifies the browser page in `web/`. The service that feeds it is specified in
`docs/spec-service.md`. The page has two data sources: the preview (built-in sample data) and the
network source, which reads the service. The network source reads replay data, the visitor's role,
and the service's live events (OS-N9).

OS-P1. In preview mode the page MUST NOT send any network request. It reads its data only from
`web/src/preview/`. `bun run build:single` produces one self-contained HTML file that runs from
disk.

OS-P1a. The build decides the data source (`web/src/sources.ts`):

| Command | Source |
| --- | --- |
| `bun run build:single` | preview |
| `bun run dev` | preview |
| `REQUEST_MONITOR_API=<service URL> bun run dev` | network; the dev server forwards `/api` to that URL (`OPS_API` is read when it is unset, `docs/spec-service.md` OS-B9) |
| `bun run build` | network. This is the build that the service embeds and serves |

In a network build, `?source=preview` shows the built-in sample instead and sends no request to
the service.

OS-P2. The sample data of the preview is synthetic. It is generated in the browser from a fixed
seed by `web/src/preview/sample.ts`, and its time axis ends at the current hour. The repository
MUST NOT contain data, names, addresses, or locations of a real gateway. `scripts/inline.ts
--sample <file>` writes another sample into one single-file build; such a file stays outside the
repository.

## 1. Data contract

OS-D1. The screen reads two sources, declared in `web/src/core/model.ts`:

- `LiveSource.poll(now)` returns, in time order, every `LiveEvent` with `t <= now` not returned
  before. The first call that returns events also returns those of the 30 minutes before the
  screen opened. A source may say that it has delivered nothing yet (`ready`, OS-N9.5) or that
  its last read failed (`stale`, OS-N9.6), and it calls `onReset` before it returns events that
  replace all it returned before (OS-N9.3).
- `ReplaySource.load(window)` returns `ReplayData` for `window` in {`24h`, `7d`, `30d`}.

OS-D2. A request lifecycle is the event sequence `start`, zero or more `route`, at most one `ttfb`,
exactly one `end`, all with the same `id`.

- `start` carries `origin` (a region ID) and `model`.
- `route` carries the index of the selected Group · Channel pair. A second `route` for one `id`
  means that the attempt of the previous `route` failed (fail-forward).
- `ttfb` carries `ttfbMs`.
- `end` carries `status` in {`success`, `error`, `client_gone`}, `ttfbMs`, `durationMs`, and
  `errorCode` when `status = error`. An `end` with no preceding `route` is a request that the
  gateway rejected before it selected a Channel.

OS-D3. A route is shown by its user-facing Group name and Channel name, joined as
`Group · Channel`. An upstream site is the city of the address that the Channel base URL host
resolves to. A route whose host has no known city has `upstream = null` and draws no dispatch arc.

OS-D3a. Roles. The role of a visitor is `admin`, `user`, or `guest`, and it is decided by the
identity source (`web/src/core/identity.ts`), never by a control on the page. `admin` sees the
admin view; `user` and `guest` see the same restricted view. Each route has a flag `restricted`,
set by the data source. In the sample, the routes of the Groups `合作方` and `内部` are restricted.

1. The admin view shows every route as `Group · Channel` with its upstream site.
2. The restricted view shows a restricted route as the Group name alone. All restricted routes of
   one Group are one row whose count, success rate, and TTFB median cover them together. The row,
   a feed row, and the text at an upstream site show no Channel name and no upstream site for them.
3. A route that is not restricted is identical in both views.
4. Totals, the model ranking, and the origin ranking are identical in both views. In the restricted
   view a request on a restricted route draws no gateway → upstream arc and counts toward no
   upstream site, because the page does not know its site.
5. The header shows the role as a label (`管理员`, `用户`, `访客`) that is not a control.

OS-D3b. The preview has no gateway and sends no request, so it cannot identify anyone:
`?as=admin|user|guest` names the visitor to simulate and the default is `admin`. The preview holds
all data in the page and only changes what it draws. The service MUST instead apply OS-D3a before
it sends data (`docs/spec-service.md` OS-B6).

OS-D4. `ReplayData` has `stepMs` and one bucket per step: 5 minutes for `24h` (288 buckets), 30
minutes for `7d` (336 buckets), 2 hours for `30d` (360 buckets). A bucket holds the request count,
the error count, the TTFB median, the request and error count per route, the request count per
origin, and the request count per model.

OS-D5. Capabilities. A source states what its gateway records (`Capabilities` in
`web/src/core/model.ts`), and the page labels what is missing instead of showing a value:

| Capability | Value | The page |
| --- | --- | --- |
| `live` | `none` | disables `实时` (tooltip `这个数据服务还没有实时模式`) and opens on the `24 小时` replay |
| `live` | `replayed` | labels the control `准实时`; its tooltip says that a request appears after it ended; opens on it |
| `live` | `realtime` | labels the control `实时`; opens on it |
| `errors` | `false` | shows `未记录` in place of the success rate and of the failure count; shows no success rate on a route row, in the timeline, in the tooltip, or in the detail card; omits `失败` from the legend; draws every upstream site in the dispatch colour instead of a status colour (OS-M6) |
| `origin` | `false` | shows `这个网关没有记录请求的来源地区。` in place of the origin ranking |

OS-D5a. Opening view. `?range=24h|7d|30d` opens that replay. Otherwise the page opens on live mode
when `capabilities.live` is `replayed` or `realtime`, and on the `24 小时` replay when it is `none`.
When the source turns live mode off while the page runs (OS-N9.7), the page disables the live
control and, if it showed live mode, switches to the `24 小时` replay.

OS-D6. The origin counts of a bucket can sum to less than its request count: the service does not
place a request whose client address has no known region. When the difference is at least 0.5
requests and at least 0.1 % of the bucket set, the origin ranking has a row `未归入地区` with it.
In live mode a request whose `start.origin` is `""` (`docs/spec-service.md` OS-SR4) draws no
inbound arc and counts toward the row `未归入地区`.

## 1a. Network source

OS-N1. The network source (`web/src/net/source.ts`) reads the endpoints of
`docs/spec-service.md` OS-SH2 with `GET`. A path is relative to the page URL, so the service works
under any path of a reverse proxy. A request sends same-origin credentials, bypasses the HTTP
cache, and fails after 15 s.

OS-N2. Start. The page asks `api/identity` and `api/config`, and then, unless OS-N8 applies,
`api/meta` and `api/topology`. A failed `api/identity` means the role `guest`. A failed
`api/config` means the default config (OS-U5). When `api/meta` or `api/topology` fails, the page
shows `连不上数据服务，10 秒后自动重试。` with a button `现在重试`, and tries again every 10 s. The
map stays on screen behind the message, in the view that the address names.

OS-N2a. Until a source has delivered data, the page shows no figure: a panel shows its loading
state, a headline figure shows `—`, and no value of the range control is selected or enabled. In
particular the success rate MUST NOT read 100 %.

OS-N3. Topology version (`docs/spec-service.md` OS-SH4). The indices of a replay answer refer to
the topology of the same `version`. When a replay answer has another version than the topology in
the page, the page fetches `api/topology` and `api/identity`, takes the role of that answer (a
visitor who signed in, or whose session ended, has another role and therefore another version),
replaces its topology and its nodes, and, if the replay answer does not have the new version,
fetches the replay again. After 3 such rounds without a match the load counts as failed. The page
never changes the role by itself: the label of OS-D3a.5 and the view follow what `api/identity`
answers.

OS-N4. A replay window is fetched when it is selected and again each time the playhead restarts
(OS-R2), so a screen that runs unattended shows new buckets. A refresh keeps the playhead.

OS-N5. Failure of a replay request. The page tries again after 15 s. If it has data of that
window, it keeps showing them with the line `数据服务暂时连不上，显示的是上一次取到的数据。`;
otherwise the panels show their loading state, the scene shows no flow, and the line is
`数据服务暂时连不上，正在自动重试。`.

OS-N6. While `backfilling` of `api/meta` is true, the page shows
`服务还在读取更早的历史，较早的时间段可能还是空的。` and asks `api/meta` again every 15 s; the line
goes away when the answer is false. The buckets that were empty appear with the next fetch of the
window (OS-N4).

OS-N7. With the network source the hint of the origin ranking is
`不足 N 个客户端的城市并入省份`, where N is `minClients` of `api/meta`.

OS-N8. Sign-in (`docs/spec-service.md` OS-SN5). A deployment can let no guest in. The page then
shows a message in place of the data and no figure (OS-N2a applies):

1. When. At the start, `api/identity` answers `allowed: false`, or `api/meta` or `api/topology`
   answers `401` with `error: "login_required"`. Later, a replay or live request gets that answer:
   the page drops the data it shows and starts again, which leads to the message.
2. What. The line `这块大屏要先登录网关才能看。`; a link `去登录` to `loginUrl` of `api/identity`,
   opened in a new tab without an opener; a button `我已登录，重新打开`; and a line that says that
   the screen opens by itself after the sign-in. The map stays on screen behind the message.
3. `loginUrl` becomes a link only when it is an `http:` or `https:` URL. Otherwise, and when the
   service names none, the message has no link and says to sign in at the gateway's console.
4. While the message is shown the page asks `api/identity` every 15 s and whenever the tab
   becomes visible again, and starts again as soon as the answer says `allowed: true`. It does
   not ask the data endpoints in between.

OS-N9. Live events (`docs/spec-service.md` section 13, OS-SR6). When `capabilities.live` of
`api/meta` is not `none`, the network source reads `api/live` from the start on and in every mode,
so that live mode has its history whenever it is selected. Its reader is `web/src/net/live.ts`.

1. Cadence. The first request has no `after`. Each later request passes the `cursor` of the last
   answer as `after`, and is sent `pollMs` after that answer arrived (at least 0.5 s and at most
   60 s; 2 s when the answer has no usable value).
2. Clock. The page runs its live clock `delayMs` behind the service: it takes the offset between
   its own clock, at the first poll after an answer, and `now - delayMs` of that answer. It keeps
   the offset of the first answer and of each answer with `reset: true`, and takes the offset of
   another answer only when it differs from the kept one by more than 1 s. An event is applied
   when the page's clock minus the offset reaches its `t`, and it is applied with `t` shifted by
   the offset, so the figures and the timeline are on the page's clock. Events are applied in the
   order of `t`; events with the same `t` keep the order of the answer.
3. Reset. An answer with `reset: true` replaces the live events. The page drops the events it has
   not applied yet and everything it built from the events it applied (requests in flight, the
   feed, the live figures, and the 30-minute timeline), and then applies the events of the answer,
   which hold the last 30 minutes.
4. Topology version. When an answer has another `version` than the topology the page holds, the
   page fetches `api/topology` and `api/identity` as in OS-N3, drops its live events, and asks
   again without `after`; that answer is a reset. After 3 such rounds without a match the request
   counts as failed (item 6). A topology change that a replay answer brings (OS-N3) also drops the
   live events, and the next request has no `after`.
5. Until the first answer has been applied, live mode shows no figure (OS-N2a).
6. Failure. A request fails when no answer comes within 15 s, on a network error, on a status other
   than those of items 7 and 8, or when the body is not a live answer. The page then tries again
   after 5 s with the same `after`. While the last request failed, live mode shows the line
   `实时数据暂时连不上，正在自动重试。` and keeps applying the events it already has; the line goes
   away with the next answer.
7. `404` with `error: "live_unavailable"`: the service has turned live mode off. The page stops
   asking and treats `capabilities.live` as `none` from then on (OS-D5, OS-D5a).
8. `401` with `error: "login_required"`: the page stops asking and handles it as OS-N8.1.
9. The page stops asking when it starts again (OS-N2, OS-N8) or is closed.

## 2. Scene

OS-M1. The scene has three node kinds: one gateway, upstream sites, and origins (user regions).
Land is drawn from the Natural Earth 1:50m coastline as a filled shape with a coastline stroke.
Antarctica is filled up to the South Pole, which the globe shows when it is tilted south (OS-M2c).
The scene MUST NOT draw a country or province border. A graticule every 15 degrees is drawn as a
dashed line (2.5 degrees on, 2.5 off) in both views.

OS-M2. Two views show the same scene in WebGL: `3d`, a globe, and `2d`, a flat Miller map seen
from above at an angle. The surface, every node, arc, and comet has a position in both views. A
view switch blends the positions for 1500 ms; arcs, comets, and labels fade out during the first
half and in during the second. The flat map continues 90 degrees past its east and west edges and
fades out over the last 30 degrees of that, so no edge of the map is visible from any side. A
pointer drag turns the globe or swings the camera over the map (OS-M2c).

OS-M2a. Zoom changes the camera distance by a factor from 0.6 to 1.7. A wheel event over the
scene, a wheel event with the control key anywhere on the page (a trackpad pinch), and a WebKit
gesture event all zoom the scene and have their default action prevented, so the page itself is
never zoomed and the panels keep their size. Node markers are scaled by the zoom factor, so they
keep their size on screen. In the flat view the largest factor is lower when the canvas would
otherwise show more than the width of the map (540 degrees less 12). The zoom goes back to 1 when
the page is left alone (OS-M2c.6).

OS-M2b. Framing. Where the views look is computed from the nodes (`web/src/scene/frame.ts`), so a
gateway anywhere on Earth is in the picture without a setting. The key points are the gateway,
the upstream sites, and the first 12 origins of the topology. The frame is computed again when the
topology changes, and the fit of rule 4 also when the page is resized.

1. Centre. C is the point on the sphere whose largest angular distance to a key point is smallest.
   C is then moved toward the gateway in longitude and in latitude by the largest share of
   {0.25, 0.2, 0.15, 0.1, 0.05, 0} at which the gateway and every upstream site are within 66
   degrees of the moved point, or by 0.25 when none of them does that.
2. Globe. The camera stands above the moved point. If the gateway is not well in view from there,
   the camera moves along the great circle toward the gateway, in steps of one fiftieth, until it
   is. Well in view means: within 60 degrees of the point under the camera; no more than 0.66 of
   the globe's radius east or west of the centre of the disc; no more than 0.35 of the radius
   below it (the timeline covers the south of the globe) and no more than 0.8 above. The camera
   latitude is limited to the range from −55 to 60 degrees.
3. Flat map, centre. The map is cut in a gap between the longitudes of two neighbouring key points,
   and its centre meridian is the middle of the remaining span. The gap is the one that contains
   the meridian opposite the globe's camera, so both views face the same side of the Earth; if the
   remaining span is then wider than 294 degrees, it is the widest gap. The latitude at the centre
   line of the map is the camera latitude less 12 degrees, limited to the range from −40 to 50.
4. Flat map, distance. The camera stands back as far as needed for every key point to be inside
   the scene area (the space between the side columns, above the timeline) at zoom factor 1 and
   the default tilt. Room is kept at the edges, in design pixels at the sides, above, and below:
   0, 12, and 8 for an origin; 16, 40, and 56 for an upstream site; 16, 130, and 56 for the gateway,
   whose label stands above its marker. The distance is limited so that the scene area shows no
   less than 80 and no more than 300 degrees of longitude at the depth the camera looks at, and no
   more than rule OS-M2a allows.

A node that is not a key point can lie outside the scene area or on the far side of the globe; the
viewer turns or zooms the scene to see it.

OS-M2c. Turning (`web/src/scene/orbit.ts`). The frame of OS-M2b is where a drag starts from.

1. A horizontal drag turns the globe about its axis by 0.2 degrees per pixel, or swings the flat
   camera around the point it looks at by 0.16 degrees per pixel. Neither has a limit: both go all
   the way round, as often as the viewer drags. The angle is kept from −180 to 180 degrees, so it
   does not grow, and a whole turn brings the view back to where it was.
2. A vertical drag tilts. On the globe it moves the camera latitude by 0.16 degrees per pixel, and
   the camera latitude (the frame's plus the drag) stays from −75 to 75 degrees, so the camera never
   passes over a pole; a drag past the limit is not stored. Over the flat map the camera's tilt
   stays from 26 to 80 degrees above the map.
3. The scene drifts slowly by itself and the drift adds to the drag: on the globe by up to 7 degrees
   of longitude and 2.2 degrees of latitude, over the map by up to 5 degrees of turn.
4. The horizontal turn turns the camera about the vertical axis through the point it looks at.
   Each view keeps its own turn while the other is shown. During a view switch the camera takes the
   path of the switch between the default views, turned by an angle that goes evenly the short way
   (at most half a turn) from the turn of the view being left to that of the view being entered.
   So a switch between turned views is the default switch seen from another side: the camera
   comes no nearer to the axis than there and does not jump over the scene. A turn stays until the
   viewer drags it back, the page is left alone (rule 6), or the page is opened again.
5. From any side, only what faces the camera is drawn: on the globe a node, its label, its rings,
   and pulses fade out over the limb, arcs pass behind the Earth, and a comet head hides there; over
   the map a node behind the camera is not shown. Only a node that is shown is a pointer target
   (OS-I1), and the hover tooltip and focus rings follow the same rule. Labels are placed on
   screen, beside their node, from any side. The globe's shading on the `day` theme comes from the
   upper left of the screen, not from a place on Earth, so the far side is lit the same way.
6. Return. When nobody has used the page for 3 minutes, the turns and tilts of both views and the
   zoom factor (OS-M2a) go back to where they start, over 5 seconds, starting and stopping gently
   (at most 1.5 times the mean pace). A use is a pointer press or move anywhere on the page, a
   wheel or gesture event, or a key; a pointer resting on the screen is none. The angles go
   straight back to 0, which is the short way round because they are kept from −180 to 180
   degrees; the zoom goes evenly in scale. A use on the way stops the return where it is, and the
   3 minutes start again. The view (`3d` or `2d`), the time range, and a selected node are kept.

OS-M3. An upstream site within 1.5 degrees of the gateway is co-located: it is drawn as a ring
around the gateway, labelled `同机房上游`, and has no arc. Any other upstream site closer than 7.5
degrees to the gateway, 6.5 degrees to another upstream site, or 3.2 degrees to an origin is
displaced until it is not, and a line joins it to its real position.

OS-M4. Live animation of one request, with all durations in screen time:

1. `start`: a pulse at the origin and a comet origin → gateway (1500 ms, request colour).
2. `route`: a comet gateway → upstream site (1050 ms, dispatch colour) that starts when the
   inbound comet has arrived; on arrival the site label shows `Group · Channel` for 3.4 s.
3. A second `route`: an error pulse and the text `Group · Channel · 失败，换渠道` at the failed
   site, then step 2 for the new route.
4. `ttfb`: a comet upstream site → gateway (620 ms, success colour).
5. `end`: a pulse at the site in the status colour, the text `Group · Channel · outcome` (the
   duration, `客户端断开`, or the error code), a comet site → gateway (640 ms), then a comet
   gateway → origin (900 ms).

OS-M5. While a request is between `start` and `end`, its origin → gateway arc and, after `route`,
its gateway → site arc carry dashes that travel in the request direction; brightness and width
grow with the number of requests in flight on the arc. Request arcs rise higher than dispatch arcs.

OS-M6. A node is a filled circle. The gateway and each upstream site also have a thin ring, and
the ring grows with the square root of the site's relative volume. An upstream site takes the
success colour when its success rate is at least 95 %, the warning colour from 80 % to below
95 %, and the error colour below. The scene draws no beam, star, glow sprite, or ground grid.

OS-M7. In replay the scene shows one aggregate: for each origin an arc to the gateway, and for each
upstream site an arc from the gateway, with width proportional to the square root of the volume
relative to the busiest bucket of the window. The error share of a site blends its arc toward the
error colour. Comets are emitted on each arc at a rate that grows with its volume, with no floor.

## 2a. Inspecting a place

OS-I1. Every node is a pointer target. The pointer is on a node when it is within 13 design
pixels of an origin, or within 20 design pixels of the gateway or an upstream site; the nearest
node wins. The labels of the gateway and of upstream sites are targets too, which is the only way
to reach a co-located upstream site (OS-M3).

OS-I2. Hover. While the pointer is on a node, a tooltip beside the node shows its name, its kind
(`网关`, `上游所在地`, `来源地区`), the request count and success rate of the range on screen, and
the requests in flight. The node gets a ring, and an origin shows its label.

OS-I3. Click. A press that moves less than 4 pixels selects the node under it and opens its detail
card, which takes the place of the lower card of the right column, so the card never covers the
map. A click on the selected node, the Escape key, or the card's close button closes it. A press
that moves 4 pixels or more turns the scene and selects nothing.

OS-I4. In live mode the detail card shows, for the finished requests of the last 15 minutes that
involve the node: their count, their share of all requests, the success rate, and the TTFB median;
the requests in flight now; the finished requests per minute of the last 30 minutes; the 5 largest
models; the 5 largest routes (OS-D3a applies); for the gateway and an upstream site the 5 largest
origins; for the gateway and an origin the 5 largest upstream sites; and the 6 newest finished
requests with time, route, model, and outcome.

OS-I5. In replay the card shows the bucket set of OS-R4. The gateway has all figures of OS-I4
except requests in flight and newest requests. An upstream site has its count, share, success
rate, and routes. An origin has its count and share only. The card states which breakdown does not
exist; it MUST NOT estimate one. The data source holds no cross product of origin, route, and
model for past buckets (`docs/spec-service.md` OS-B4).

## 3. Live metrics

OS-L1. Requests per second = `start` events of the last 10 s divided by 10. The peak is the
largest 10-second bar of the last 30 minutes, divided by 10.

OS-L2. Success rate = 1 − errors / ended requests over the last 5 minutes. `client_gone` is not an
error.

OS-L3. TTFB median and 95th percentile are taken over requests that ended in the last 5 minutes
and have a `ttfbMs`.

OS-L4. Requests in flight = lifecycles with a `start` and no `end`.

OS-L5. The model, Group · Channel, and origin rankings count requests that ended in the last 15
minutes. The Group · Channel list shows the 9 largest, each with its share, success rate, and TTFB
median. A row is highlighted for 1200 ms after a `route` event selects it.

OS-L6. The feed lists the 11 requests with the newest state change, newest first. A row shows
`Group · Channel`, origin → upstream site, model, time, and state: `调度中` before `ttfb`, `输出中`
after it, then the duration, `客户端断开`, or the error code.

OS-L7. The timeline shows the last 30 minutes in 10-second bars: `start` count, with the count of
requests that ended in `error` during the bar drawn in the error colour. Hovering a bar shows its
time range, request count, and error count.

## 4. Replay

OS-R1. The range control has four values: `实时`, `24 小时`, `7 天`, `30 天`. The last three open the
replay of that window. OS-D5 says when the first one is disabled or relabelled.

OS-R2. At speed 1 the playhead crosses the window in 60 s; speeds 2 and 4 divide that time. At the
end the playhead rests for 1.8 s and restarts. Space toggles play and pause.

OS-R3. A pointer press or drag on the timeline moves the playhead to that position.

OS-R4. `按时间回放` shows the bucket under the playhead. `整窗聚合` pauses and shows the sum of all
buckets. Metrics, rankings, and the scene all use the same bucket set.

## 5. Layout and themes

OS-U1. The page fills the viewport and is drawn 1920 design pixels wide. One design pixel equals
`clamp(0.62px, min(100vw / 1920, 100vh / 860), 2.4px)`. A list shows whole rows only: when the
viewport is short, a card shows fewer rows and no row is cut.

OS-U2. There are two themes, `night` and `day`, in `web/src/scene/theme.ts`: a neutral ground, one
blue accent, a teal for dispatch, and green, amber, and red for status. On `night` arcs,
comets, and the atmosphere blend additively; on `day` they blend normally, keep their colour, draw
arcs at 2.3 times and comets at 1.7 times the alpha, and the globe is shaded from the upper left.

OS-U2a. Appearance mode is `auto`, `day`, or `night`; the default is `auto`. In `auto` the theme
is `day` while the viewer's local time is from 07:00 to before 18:00 and `night` otherwise, and it
is re-evaluated every 20 s without a reload. `?day=<start>-<end>` (hours) changes the range. The
appearance button cycles `auto`, `day`, `night`; a fixed choice is stored in `localStorage` under
`ops-theme-mode`; `?theme=auto|day|night` overrides it.

OS-U2b. The request colour and the dispatch colour of each theme MUST pass
`dataviz/scripts/validate_palette.js` on that theme's surface (lightness band, chroma floor,
colour-vision separation, normal-vision floor, contrast). Night: `#3b82f6`, `#14a89a`. Day:
`#1a6ef4`, `#0d9488`.

OS-U2c. Text is drawn in the text colours only. A state (success rate, request outcome) is shown
by a dot in the status colour beside the text. The page has one headline figure (requests per
second); the panels carry no decorative frame, index number, or uppercase label.

OS-U3. With `?clock=manual` the page does not start its animation loop;
`window.__requestMonitor.advance(ms)` advances the screen clock and draws one frame.

OS-U4. All copy is Simplified Chinese. The default title is the product name `Request Monitor`
(OS-U5).

OS-U5. Brand. The page shows the title `Request Monitor` and no mark by default, in the header
and as the title of the browser tab (`docs/spec-service.md` OS-B9). A deployment supplies a
`ScreenConfig` (`web/src/core/config.ts`) with a title, a logo for the day theme, a logo for the
night theme, and an attribution line; each is optional. The logo is drawn left of the title at a
height of 24 design pixels. The attribution is one line at the bottom right of the scene with an
optional link. In preview mode the config is read from `window.__OPS_CONFIG__`, which
`scripts/inline.ts --config <file>` writes into the single-file build; without it the defaults
apply; with `--config`, the title of the file's browser tab is the configured title too. The page
MUST NOT ship the mark of a real organisation by default. The only marks in the repository are the
LynShen icon and logo in `docs/images/`, which the README shows (`docs/spec-service.md` OS-B8);
the page never loads them.
