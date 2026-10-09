# Pit Wall

Live Formula 1 data, and a plain-English guide to how the sport works.

Designed and built by **Najmi Zulhusni** · najmisapuan02@gmail.com

Two pages, no framework, no build step, no API keys:

- **Live dashboard** (`index.html`): standings, title maths, every race lap by lap, tyre strategy and telemetry replays for the current season, or any season since 2023.
- **Learn F1** (`learn.html`): nine short chapters, each explaining one idea with an animation and then showing it in this season's real data.

Data comes from two public APIs that know nothing about each other. The page pulls them, joins them in the browser, and shows the pipeline doing it.

- **OpenF1** (`api.openf1.org/v1`): sessions, laps and sectors, stints, pit stops, race control, weather, 4 Hz position and car telemetry
- **Jolpica F1** (`api.jolpi.ca/ergast/f1`): schedule, race, sprint and qualifying results, standings

## Live dashboard

| Section | What it shows |
|---|---|
| Hero | Latest race podium and notes, the title situation, your driver, countdown to the next session, and the fastest lap replayed from raw x/y coloured by speed |
| Standings | Drivers and constructors, last-five form, points still available and who can still win; any season since 2023 from the season picker |
| Title analytics | When the leader can win it: earliest possible round and the margin needed over each rival, a round-by-round clinch table, a projection on current form, and where your driver stands |
| Calendar | Every round with its winner, the next weekend's sessions in your time zone, one-click calendar export; finished rounds open their race data |
| Head to head | Points by round, season duel, mini-sector dominance from two laps resampled to lap distance |
| Race | Session facts, running order and gap to the winner by lap, lap times with safety car periods shaded, pace table with sectors, ideal lap and speed trap, pit lane times, tyre strategy |
| Data feed | Live request counters, how the pipeline works, the full request log on demand |

### For fans

- **Your driver.** Pick one in the hero. It's highlighted in the standings, becomes driver A in the head to head (against the driver just ahead), is pre-selected on every race chart, and the title analytics say exactly what they need to win.
- **Your calendar.** "Add this weekend" or "Add the rest of the season" downloads an `.ics` file with every session and a 15-minute reminder. Importing again updates events instead of duplicating them.
- **Your time zone.** Every session time is shown in local time.
- **Past seasons.** The season picker loads any season since 2023, with full telemetry.
- **The off-season.** Between December and March, the page shows how the last season finished and counts down to the next one, instead of showing empty tables.
- **Light and dark.** The sun/moon button switches themes; the first visit follows the system setting.

## Learn F1

| Chapter | The moving picture | The real data |
|---|---|---|
| 01 The season | Every round on a timeline, done and to come | This season's calendar; the top teams split into their two drivers' points |
| 02 The race weekend | A Friday to Sunday timeline that walks through each session; standard and sprint formats | The next weekend's format and its session times in your time zone |
| 03 Qualifying | Q1, Q2 and Q3 replayed as a knockout, cars re-ordering and dropping out | The latest real qualifying session |
| 04 Lights out | A reaction game on the five start lights, with jump-start detection | |
| 05 Tyres | Spinning compounds, grip against life, and a degradation chart with the cliff | How the top five ran their tyres in the latest race |
| 06 Pit stops and strategy | Race three strategies yourself: change tyre wear and the pit lap, watch the gaps | Real pit lane times from the latest race |
| 07 Safety car and flags | Cars on a track bunching behind a safety car, or holding gaps under a VSC | The real safety car periods of the latest race |
| 08 Points and the title | Points ladders; a "what if the next race finished like this" calculator | The live title fight |
| 09 Reading timing data | A lap being timed sector by sector in purple, green and yellow; a searchable glossary | |

Each chapter ends with a one-question quick check, and links to the dashboard section where the idea shows up for real. The strategy chapter uses a deliberately simple tyre model, and says so on the page.

## How the data flows

```
OpenF1 ─┐                ┌─ Ingest (pipeline.js) ────┐    ┌─ Transform (sources.js) ────┐    ┌─ Views
        ├─ fetch ───────►│ per-source queue + gap    │───►│ merge pages by round        │───►│ app.js    dashboard
Jolpica ┘                │ retry 429/5xx, backoff    │    │ join code ↔ car number      │    │ learn.js  Learn F1
                         │ memory + Cache API cache  │    │ running order from crossings│    │ charts.js SVG charts
nightly snapshot ───────►│ fallback on failure       │    │ align position + car clocks │    │
(GitHub Action)          └───────────────────────────┘    │ resample lap to distance    │    │ analytics.js title maths
                                                          └─────────────────────────────┘    │ ics.js       calendar files
```

Failure order for any request: network → retry up to 4 times → older cached copy → `data/snapshot.json` → visible error message in the panel.

## How the derived numbers work

- **Running order.** OpenF1's lap rows carry the time each car started a lap, so the next row's start is when it crossed the line. Ordering the crossings of each lap gives the order on track. A car on its in-lap crosses the timing line in the pit lane, which under a safety car can be well before the field; such a car is held at its previous gap, or left out of lap 1 if it has none, so it never appears to lead. The official result can still differ after penalties.
- **Gap to the winner.** Each car's crossing minus the eventual winner's crossing of the same lap. One fixed reference, so a lead change during pit stops doesn't make every line jump.
- **Neutralised laps.** Safety car, VSC and red flag periods come from race control messages.
- **Ideal lap.** The sum of a driver's best three sectors. Sector values below 60% of the field median are treated as timing glitches.
- **Title maths** (`js/analytics.js`). The leader is champion once their lead over every rival is bigger than the points left: 25 per Grand Prix and 8 per sprint. For each remaining round the page works out how much the leader must outscore each rival by, and whether that is achievable at all. The projection replays each contender's last-five race average and season sprint average over the rounds left. It's a trend line, not a prediction.

## Performance

| | Before the performance pass | After |
|---|---|---|
| Paint while the replay runs, per 3 s | 152 ms | 63 ms |
| Paint while hovering a chart | 189 ms | 92 ms |
| Time to the hero replay, first visit | 3.8 s | 2.8 s |
| Repeat visit | 24 network requests | 0, all served from the device cache |

- The replay car lives in its own SVG layer; the track is ~24 paths, one per speed band, instead of ~400 segments.
- Readout text is only written when the value changes; telemetry is 4 Hz, screens are 60 to 120 Hz.
- Chart crosshairs live in an overlay layer and update at most once per frame.
- No `backdrop-filter` on sticky bars; every looping animation uses transform or opacity only.
- Responses are cached with the Cache API, asynchronously, never stringified on the main thread.
- Charts redraw only when the viewport width changes, so the iOS toolbar sliding while scrolling doesn't rebuild them.
- Every animation on the Learn page runs only while it's on screen, and all of them respect `prefers-reduced-motion`.
- Scripts are deferred, the web font doesn't block rendering, and the 1 MB snapshot is only downloaded when a request has failed.

## Run it locally

```bash
python3 -m http.server 8080      # or: npx serve .
```

Open http://localhost:8080. Opening `index.html` from disk works for live data, but the browser blocks the cache and the snapshot fallback on `file://`.

## Tests

```bash
npm test                          # same as: node --test tests/*.test.mjs
```

No dependencies. The tests load the browser scripts into Node and cover the running order (including pit-lane crossings), safety car periods, the pace table, the title maths and projections, calendar files, and the pipeline's retry, dedupe, cache and 404 handling. `.github/workflows/test.yml` runs them on every push.

## Deploy

Any static host works: point it at the repo root with no build command. On GitHub Pages: Settings → Pages → deploy from branch `main`, folder `/`. The `.nojekyll` file skips Jekyll so the site publishes as is.

## The nightly snapshot

`.github/workflows/snapshot.yml` runs `scripts/snapshot.mjs` every day at 02:30 UTC and commits `data/snapshot.json` and `data/snapshot.meta.json` when anything changed. The script loads the page's own `pipeline.js` and `sources.js` in Node and records every response, so the request paths it saves are exactly the ones the browser asks for, including the off-season ones. Run it by hand with `npm run snapshot` (Node 18+). Trigger the first run from the Actions tab.

## Things to know

- **OpenF1 during live sessions.** The free tier restricts data while a session is running. The page uses the last completed session, falls back to the snapshot if requests fail, and says so.
- **Rate limits.** Jolpica allows about 4 requests a second; OpenF1's free tier 3 a second and a per-minute cap. The page runs OpenF1 two at a time, 360 ms apart, and backs off on 429. Switching sessions very quickly can still hit the cap; the data feed shows the retries.
- **Cancelled sessions and testing days** are skipped.
- **Pit times** are pit lane times, entry to exit. Stationary time is shown when OpenF1 provides it.
- **Team colours** come from OpenF1, with a fallback map in `sources.js` for drivers not in the session. Update it if teams rebrand.

## Files

```
index.html             live dashboard
learn.html             Learn F1
css/style.css          tokens (light and dark), layout, dashboard components
css/learn.css          Learn F1 layout and figures
js/pipeline.js         ingest: queues, retries, cache, fallback, request log
js/sources.js          adapters and transforms for both APIs, season selection
js/analytics.js        title maths and projections (pure, tested)
js/ics.js              calendar export (pure, tested)
js/charts.js           hand-written SVG charts and track map
js/shell.js            shared chrome: theme, reveal, progress, section spy
js/app.js              dashboard loading and rendering
js/learn.js            Learn F1 chapters and animations
tests/                 node:test unit tests
scripts/snapshot.mjs   nightly fallback writer
.github/workflows/     tests on push, nightly snapshot
data/                  snapshot.json and snapshot.meta.json land here
```

Designed and built by Najmi Zulhusni (najmisapuan02@gmail.com). Unofficial; not associated with Formula 1, the FIA or any team. Data from OpenF1 and Jolpica F1.
