# Ops Screen: Screen Specification (draft)

## 0. Status

OS-0. This file specifies the browser page in `web/`. The service that feeds it is specified in
`docs/spec-service.md`. The page works today as a preview on sample data; the network data source
does not exist yet.

OS-P1. In preview mode the page MUST NOT send any network request. It reads its data only from
`web/src/preview/`. `bun run build:single` produces one self-contained HTML file that runs from
disk.

OS-P2. The sample data of the preview is synthetic. It is generated in the browser from a fixed
seed by `web/src/preview/sample.ts`, and its time axis ends at the current hour. The repository
MUST NOT contain data, names, addresses, or locations of a real gateway.

## 1. Data contract

OS-D1. The screen reads two sources, declared in `web/src/core/model.ts`:

- `LiveSource.poll(now)` returns, in time order, every `LiveEvent` with `t <= now` not returned
  before. The first call also returns the events of the 30 minutes before the screen opened.
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
4. Totals, the model ranking, the origin ranking, and the arcs are identical in both views.
5. The header shows the role as a label (`管理员`, `用户`, `访客`) that is not a control.

OS-D3b. The preview has no gateway and sends no request, so it cannot identify anyone:
`?as=admin|user|guest` names the visitor to simulate and the default is `admin`. The preview holds
all data in the page and only changes what it draws. The service MUST instead apply OS-D3a before
it sends data (`docs/spec-service.md` OS-B6).

OS-D4. `ReplayData` has `stepMs` and one bucket per step: 5 minutes for `24h` (288 buckets), 30
minutes for `7d` (336 buckets), 2 hours for `30d` (360 buckets). A bucket holds the request count,
the error count, the TTFB median, the request and error count per route, the request count per
origin, and the request count per model.

## 2. Scene

OS-M1. The scene has three node kinds: one gateway, upstream sites, and origins (user regions).
Land is drawn from the Natural Earth 1:50m coastline as a filled shape with a coastline stroke.
The scene MUST NOT draw a country or province border. A graticule every 15 degrees is drawn as a
dashed line (2.5 degrees on, 2.5 off) in both views.

OS-M2. Two views show the same scene in WebGL: `3d`, a globe, and `2d`, a flat Miller map centred
on 187°E seen from above at an angle. The surface, every node, arc, and comet has a position in
both views. A view switch blends the positions for 1500 ms; arcs, comets, and labels fade out
during the first half and in during the second. The flat map continues 78 degrees past its east
and west edges, so no edge of the map is visible. A pointer drag turns the globe or swings the
camera over the map.

OS-M2a. Zoom changes the camera distance by a factor from 0.6 to 1.7. A wheel event over the
scene, a wheel event with the control key anywhere on the page (a trackpad pinch), and a WebKit
gesture event all zoom the scene and have their default action prevented, so the page itself is
never zoomed and the panels keep their size. Node markers are scaled by the zoom factor, so they
keep their size on screen.

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
replay of that window.

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
`window.__opsScreen.advance(ms)` advances the screen clock and draws one frame.

OS-U4. All copy is Simplified Chinese.

OS-U5. Brand. The page shows the title `数据大屏` and no mark by default. A deployment supplies a
`ScreenConfig` (`web/src/core/config.ts`) with a title, a logo for the day theme, a logo for the
night theme, and an attribution line; each is optional. The logo is drawn left of the title at a
height of 24 design pixels. The attribution is one line at the bottom right of the scene with an
optional link. In preview mode the config is read from `window.__OPS_CONFIG__`, which
`scripts/inline.ts --config <file>` writes into the single-file build; without it the defaults
apply. The repository MUST NOT contain the mark of a real organisation.
