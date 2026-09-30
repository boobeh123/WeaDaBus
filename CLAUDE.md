# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Wea Da Bus is a mobile-first web app that shows live arrival times from TheBus (Oahu Transit Services). It is an Express 5 + EJS + MongoDB (Mongoose) app deployed on Railway.

- `npm run dev` runs the server with `node --watch` on http://localhost:3000. `npm start` runs it without watching.
- `npm run import:gtfs` downloads TheBus's GTFS schedule and replaces the `stops`, `routes`, and `routepatterns` collections. Re-run it when TheBus publishes a new feed. The script prints the current feed's end date.
- `.env` needs `WEBSERVICESKEY` (the TheBus API key) and `DB_STRING` (MongoDB). The server exits at startup if either is missing or the database connection fails. `.env.example` lists every variable.
- There is no build step, linter, or test suite.

### Build order

Features are built one at a time, in this order:

1. Stop arrivals page (`/stops/:stopId`). Done.
2. The map, in four steps:
   - 2a. GTFS import and models, plus stop names on the stop page. Done.
   - 2b. A full-screen Leaflet map of Oʻahu with a bottom tab bar (Nearby · Search), stop pins for the visible area, "Show stops near me", and a sheet of live arrivals when a pin is tapped. Done.
   - 2c-1. Routes: the Routes tab (`/routes`, with a filter box) and route maps (`/routes/:slug`). A route map has a solid line for the selected direction, a dotted, faded line for the return, a direction toggle labeled by headsign, the stops in order, and arrivals filtered to that route. Done.
   - 2c-2. Live buses on the route map that glide to each new position. Done.
   - 2d. Search by stop name, route, or stop number.
3. Accounts and saved stops ("My Stops"), using Passport. The map, route browsing, and search must keep working without login.
4. On-time reliability tracker. Poll a chosen set of stops and store the results in MongoDB.

Email and push alerts are out of scope. Sessions and Passport aren't installed until Feature 3.

### Design

The app is mobile-first, because most riders check it on a phone while waiting at a stop. Base CSS targets phones, and `min-width` media queries add the desktop layout. Key actions sit within thumb reach: the fixed bottom tab bar, the sticky refresh bar just above it, and the map's "Show stops near me" button. Tap targets are at least 44px. Map pins are the exception at 32px, which still meets WCAG AA's 24px, because pins crowd at street level. The first view of content pages is rendered on the server, so arrivals appear on slow connections before any JS runs.

Colors, type sizes, and spacing are custom properties on `:root` in `public/css/styles.css`. Dark mode only redefines those properties, and it also inverts the OpenStreetMap tiles.

At 48rem and wider, the tab bar becomes the top navigation and replaces the site header, and the map sheet docks as a side panel.

## Architecture

- **Two data sources.** GTFS is the static map: stops, routes, and route lines. It is imported into MongoDB. The TheBus API is the live layer: arrivals and vehicle positions. Live data is never stored, except for the Feature 4 snapshots.
- **Models** (`model/`), all written only by `scripts/importGtfs.js`:
  - `Stop`: keyed by `stopId`, the number on the sign. It has a GeoJSON `location` with a 2dsphere index, the display names of the routes that serve it, and `isRailStation` for Skyline stations.
  - `Route`:
    - `slug` is the URL name (`42`, `a-line`, `skyline`).
    - `shortName` is what riders see, and it is also how live vehicles name the route (`A LINE`).
    - `apiName` is how the arrivals endpoint names it (`A`).
    - The statics `Route.getDisplayName` and `Route.compareNames` give the display name and sort route names in rider order.
  - `RoutePattern`: one per route + direction + shape. It holds the `path` LineString drawn on the map, the ordered `stopIds`, a `tripCount`, and every GTFS `tripIds` on it. A live bus's `<trip>` matches one of those IDs, which gives its direction.
- **The import** parses everything in memory (two streaming passes over the 74 MB `stop_times.txt`) before touching the database. It then deletes and re-inserts each collection and syncs its indexes. `scripts/` is an addition to the standard MVC layout.
- **`services/theBus.js` is the only code that calls TheBus.** Its XML parser forces arrays by path (`stopTimes.arrival`, `vehicles.vehicle`), because each `<arrival>` also has a `<vehicle>` tag that must stay a plain value. It fetches and parses the XML and turns each arrival into `{ id, route, headsign, direction, time, minutesAway, status, statusLabel }`. It keeps only arrivals in the next 2 hours and caches each stop for 30 seconds. The cache stores the promise, so simultaneous requests for one stop share one TheBus call. `services/` is an addition to the standard MVC layout, for external API clients.
- **Stops are checked in MongoDB before TheBus is called.** The stop page, the stop-number form, and the arrivals API all do this. The API can't tell a nonexistent stop from one with no buses coming, and the check saves quota.
- **Arrival cards come from one partial, rendered in three places.** `views/partials/arrivalCard.ejs` renders them on the server for `GET /stops/:stopId`, and also renders an empty copy inside a `<template>` on the stop page and the map. `public/js/arrivals.js` fills clones of that template and provides `createArrivalsPoller`. The poller calls `GET /api/stops/:stopId/arrivals` every 60 seconds; each page pauses it while the tab is hidden and stops it when the stop is left. If you change the card markup, keep the class names in `buildArrivalCard` in sync. Route names over 4 characters (only `SKYLINE` today) get `isLongName` on the badge in both places, for a smaller font, so the badge doesn't squeeze the headsign on phones.
- **Icons.** `public/favicon.svg` is the source icon: the bus glyph on the primary teal. `public/favicon.ico` (32 px) and `public/apple-touch-icon.png` (180 px, full-bleed, because iOS rounds the corners) are PNGs rendered from it. If you change the SVG, regenerate both. Keep XML comments in the SVG free of `--`, or the file won't parse.
- **Next bus.** Every arrival list puts the first bus that isn't canceled at the top, under "Next bus arriving to this stop:" (`.nextBusLabel`), with a divider below that card. `services/theBus.js` orders the list that way, and `putNextBusFirst` in `arrivals.js` does it again after a route page filters by route. The label hides when every bus is canceled.
- **Client scripts are plain deferred scripts, not modules**, listed per page through `head.ejs`'s `scripts` local. They share one global scope: `arrivals.js` defines globals used by `stopArrivals.js` and `mapView.js`, so top-level names must not collide across the scripts a page loads.
- **The map** (`GET /`, `views/map.ejs`, `public/js/mapView.js`):
  - Leaflet 1.9.4 is served from `node_modules` at `/vendor/leaflet`, so the CSP needs no script CDN. Only `img-src` allows `https://tile.openstreetmap.org`.
  - **The map is created only after the page loads.** `mapView.js` builds the map in `start()`, which runs on the window `load` event, or at once if the page has already loaded. Don't move map creation back to the top level, for this reason:
    - WebKit (Safari, and every browser on an iPhone) can run deferred scripts before the stylesheets finish loading.
    - If Leaflet creates the map then, it finds the container unstyled and stamps an inline `position: relative` on it.
    - That inline style overrides `.map`'s absolute positioning, and the map collapses to zero height. The whole map area then shows nothing, not even the zoom buttons.
  - The tile layer sets `referrerPolicy: 'strict-origin-when-cross-origin'`. OpenStreetMap blocks browser tile requests that have no Referer and serves a "403 Access blocked" image instead. Helmet's site-wide `no-referrer` would strip the Referer, so keep this setting and don't loosen helmet's policy instead.
  - Stop pins load from `GET /api/stops?west=&south=&east=&north=` once the map reaches zoom 16. The client diffs pins by `stopId`, so they don't flicker while panning.
  - "Show stops near me" asks for location only when tapped, then calls `GET /api/stops/nearby?lat=&lon=` (`$geoNear`, 8 stops within 1 km).
  - Both endpoints read only MongoDB and skip stops with no routes. Their validators reject coordinates outside a box around Oʻahu.
  - Pins are Leaflet markers with `keyboard: true`, which makes them focusable buttons. Leaflet only turns Enter into a click for popups, so `mapView.js` handles Enter and Space itself.
  - The OTS data credit is in the map's attribution and in the sheet, since the footer isn't shown on the map page.
  - **Pin sizes.** Pins come in three sizes, set by classes `mapView.js` puts on `.map`:
    - Below zoom 14 (`isZoomedOut`), small dots, so they don't hide a route's line. The selected stop keeps its full size.
    - From 14 to 16, plain dots.
    - At 16 and up (`isStreetLevel`), 28 px stop markers with an icon: a stop sign, or a train for Skyline. The icons come from templates in `views/map.ejs`.
  - **Tap and hover feedback.** Pins, direction buttons, and stop rows have a pressed (`:active`) state. iPhone Safari only applies `:active` when the page listens for touches, so `mapView.js` adds an empty passive `touchstart` listener. Hover effects sit in `@media (hover: hover)`, so they don't stay stuck after a tap on phones.
- **Routes** (`controller/routeController.js`, `views/routes.ejs`, `public/js/routesList.js`):
  - `GET /routes` server-renders every route, with a client-side filter box. The order is Skyline, then letter routes (A LINE, C, E, PH1 … W3), then number routes, each group in natural order. The sort is `compareForList` in `routeController.js`.
  - **Direction colors.** Every route has exactly two directions. The first uses the route's color (`--routeColor`, falling back to the primary color). The second is orange (`--colorDirectionB`).
    - `mapView.js` adds `isDirectionB` to the second direction's line, to its buses, and to `.sheetRoute` while it's selected.
    - The direction buttons, the stop timeline, and the line legend all read their colors from variables on `.sheetRoute`.
    - The selected direction is always solid, filled, and checked, and the other is dotted and faded, so color is never the only cue.
  - `GET /routes/:slug` renders `views/map.ejs` in route mode. `data-route-slug` on `.mapPage` switches `mapView.js` into route mode, which loads `GET /api/routes/:slug`. That endpoint returns one line and stop list per direction, from the pattern with the highest `tripCount`.
  - In route mode there are no area pins and no "near me". The sheet has a route view (direction toggle and stop timeline), and stop arrivals are filtered to the route's `apiName`.
  - TheBus's route colors go on `.mapPage`, and on list badges, as `--routeColor` and `--routeTextColor`. They're set from JS, since pages can't use inline styles, and the CSS falls back to the primary colors.
  - **Live buses:**
    - `services/theBus.js` `getVehicles()` makes one all-vehicles call, cached for 30 seconds and shared by every rider on every route (about 2,900 TheBus calls a day). It drops parked buses (`null_trip`) and buses silent for over 5 minutes, and it never reads `driver`.
    - `GET /api/routes/:slug/vehicles` matches buses to the route by trip ID against `RoutePattern.tripIds`, which also gives each bus its direction. A bus whose trip isn't in our GTFS copy falls back to a `Route.shortName` match with `direction: null`.
    - `mapView.js` polls that endpoint every 30 seconds, pausing while the tab is hidden. It glides each bus to its new report over 1.5 seconds, or jumps with reduced motion. It never animates guessed positions between reports.
    - Buses heading the other way fade. Below zoom 14 they show only the bus glyph.
    - Bus details open as a Leaflet popup built with DOM methods, since the text comes from TheBus.
    - Skyline isn't polled, because the vehicle feed has no trains.
  - **Animations:**
    - **The flow.** `addFlow` in `mapView.js` draws a `.routeFlow` layer: light dashes that slide along the selected line 4 times, about 6 seconds in all, whenever a route opens or the direction changes. The dashes follow the direction of travel because paths are stored in driving order. On `animationend` the layer removes itself, so nothing keeps redrawing afterward. Never make it loop forever.
    - **The bus ping.** `pingBus` gives each bus one sonar ring (`.isPinging`) when it first appears and again whenever it reports a new position.
    - **Cost.** The flow animates `stroke-dashoffset` on one thin line, and the ping animates only `transform` and `opacity`.
    - **Reduced motion.** The global reduced-motion rule turns both off.
    - **Measured.** With the processor slowed 4×, frame rate was about 140 fps while they ran and about 144 fps afterward.
  - Route pages have no `maxBounds`. On phones the sheet covers the bottom 60% of the map, so fitting a south-shore route above it puts the map's center out over the ocean, and a pan limit would push the route under the sheet. Nearby keeps its limit, which its coordinate validators rely on.
- **Failed TheBus calls don't reach the error handler.** The stop page shows a "TheBus isn't responding" message, and the API route returns a 502 with JSON.
- **There are no sessions yet**, so an invalid or unknown stop number re-renders the Search page (`/search`) with the message instead of flashing and redirecting.

## TheBus API

`WebServicesAPI.md` is the OTS API reference (v1.11), taken from https://hea.thebus.org/api_info.asp. It is gitignored, so it only exists in local copies. It is text extracted from a PDF, so the repeated "Web API" and page-number lines are noise. The points below come from the doc and from live responses:

- **Endpoints.** There are three read-only GET endpoints: `arrivals/?key=&stop=`, `vehicle/?key=&num=`, and `route/?key=&route=` or `route/?key=&headsign=`. The doc only shows `http://` URLs, but `https://api.thebus.org` works, so use HTTPS.
- **Format and errors.** Responses are XML encoded as ISO-8859-1, not UTF-8. Errors such as a bad key come back as HTTP 200 with an `<errorMessage>` element.
- **The key stays on the server** even though the API allows cross-origin requests (`Access-Control-Allow-Origin: *`), because anyone who has it can use up its quota.
- **Times are Hawaii local time with no time zone.** The response timestamp looks like `9/27/2026 8:16:56 PM`. Each arrival has `<stopTime>8:36 PM</stopTime>` and `<date>9/27/2026</date>`. The tag is lowercase `date`, not `Date` as documented. Calculate minutes against the response timestamp, never the server clock, because Railway runs on UTC.
- **Arrivals always returns the next 25 trips.** At a busy stop they cover about 90 minutes, but at a single-route stop late at night they reach into the next morning. Skyline stations are covered too, with route `SKYLINE`, and every rail arrival is scheduled only.
- **`estimated`** is `1` for a GPS estimate. `0`, and the undocumented `2`, mean the time is scheduled only. With `2`, `vehicle` is `???` and the latitude and longitude are `0`.
- **Empty arrivals are ambiguous.** A stop with nothing coming and a stop number that doesn't exist look the same: only `stop` and `timestamp`, with no `<arrival>` elements and no error.
- **Vehicles.** `vehicle/` with no `num` returns every vehicle, about 1,187 of them (344 KB). That includes parked buses, which have `trip` of `null_trip`, `route_short_name` of `null`, and an old `last_message`. `driver` changes between calls for the same bus, so never use or show it.
- **The route endpoint is of little use.** It returns only each variant's first stop, with no coordinates. `headsign=` searches return an HTML 500 page, `route=A` returns nothing, and there is no "list all" option. Use the GTFS data instead.
- **Names.** Route names are strings made of letters, numbers, or both (`A`, `2`, `307`, `W1`). Headsigns and stop names are all caps and are displayed as-is, because converting them to mixed case would mangle abbreviations like `U.H.` and `HNL`.
- **Limits.** Each key is limited to 250,000 requests a day and is deleted after 6 months of inactivity. Bus positions update about once a minute and can be 2 or more minutes stale.
- **Attribution.** The Terms of Use require the legend "Route and arrival data provided by permission of Oahu Transit Services, Inc" to be displayed prominently wherever the data appears. It is in the site footer. Using the marks "OTS" or "HEA" also requires the asterisk trademark notice quoted in the doc.
- **Vehicle fields.** `route_short_name` uses GTFS short names (`A LINE`), not the arrivals names (`A`). The vehicle feed has no Skyline trains.
- **Easy to misread.** In `vehicle:adherence`, positive means early and negative means late. It's in whole minutes: live values center on 0 and mostly run from 15 late to 2 early. `arrival:canceled` is `0` for active, `1` for canceled, and `-1` for canceled and then reinstated.
- **The doc's DTD schemas disagree with its field lists.** For example, the arrivals DTD lists `scheduled` and omits `stopTime`, and the routes DTD uses `routeId` and `shapeDescription` where the field list says `routeID` and `firstStop`. Trust live responses first, then the field lists.

## GTFS feed

The feed is https://www.thebus.org/transitdata/production/google_transit.zip: about 12 MB zipped, covering bus and Skyline rail. Its CSV files have no quoted fields.

- **Stop IDs.** `stop_code` is the number on the sign and the number the arrivals endpoint takes. Nine stops appear twice, once as `151` and once as `151_merge`, a few meters apart. The import merges each pair into one `Stop`, and the plain ID's location wins.
- **Route names.** Arrivals call `A LINE`, `U LINE`, and `W LINE` just `A`, `U`, and `W`. Skyline has no short name, and arrivals call it `SKYLINE`. `Route.apiName` holds the arrivals name.
- **Live data links to GTFS.** An arrival's `<shape>` matches `RoutePattern.shapeId`, and a vehicle's `<trip>` matches a GTFS `trip_id`.
- **Directions and patterns.** All 118 routes have two directions. A direction can have several patterns, some nearly identical, like route 2's `20423_merge` and `20441`. When showing one line per direction, use the pattern with the highest `tripCount`.
- **Unserved stops.** Three stops have no routes, such as `32003 KALIHI FACILITY GARAGE`. Leave them out of rider-facing lists.
