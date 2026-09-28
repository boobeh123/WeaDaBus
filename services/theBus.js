// Client for TheBus (Oahu Transit Services) Web API.
// This is the only code that talks to TheBus, so the API key never leaves the server.
const { XMLParser } = require('fast-xml-parser');

const BASE_URL = 'https://api.thebus.org';
const REQUEST_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 30 * 1000; // TheBus data only changes about once a minute
const WINDOW_MINUTES = 120; // TheBus returns its next 25 trips, which can run into tomorrow

const STATUS_LABELS = {
  live: 'Live',
  scheduled: 'Scheduled',
  canceled: 'Canceled',
};

const parser = new XMLParser({
  parseTagValue: false, // Keep every value a string: routes like "A", vehicles like "???"
  isArray: (name) => name === 'arrival', // A single arrival still parses as an array
});

// stopId -> { promise, expiresAt }. Caching the promise, not the result, means
// requests for the same stop share one TheBus call even while it's in flight.
const arrivalsCache = new Map();

// TheBus sends Hawaii local time with no time zone, e.g. "9/27/2026" and "8:36 PM".
// Reading the arrival and the response timestamp both as UTC keeps the difference
// between them correct on any server clock. Hawaii has no daylight saving time.
function parseHawaiiTime(date, time) {
  if (!date || !time) return NaN;

  const [month, day, year] = date.split('/').map(Number);
  const [clock, meridiem] = time.split(' ');
  const [hour, minute, second = 0] = clock.split(':').map(Number);
  const hour24 = (hour % 12) + (meridiem === 'PM' ? 12 : 0);

  return Date.UTC(year, month - 1, day, hour24, minute, second);
}

// "8:16:56 PM" -> "8:16 PM"
function formatClock(time) {
  const [clock, meridiem] = time.split(' ');
  const [hour, minute] = clock.split(':');
  return `${hour}:${minute} ${meridiem}`;
}

function getStatus(raw) {
  if (raw.canceled === '1') return 'canceled';
  // 1 is a GPS estimate. 0 and the undocumented 2 (no bus assigned yet) are schedule only
  return raw.estimated === '1' ? 'live' : 'scheduled';
}

function toArrival(raw, nowMs) {
  const status = getStatus(raw);

  return {
    id: raw.id,
    route: raw.route,
    headsign: raw.headsign,
    direction: raw.direction,
    time: raw.stopTime,
    minutesAway: Math.floor((parseHawaiiTime(raw.date, raw.stopTime) - nowMs) / 60000),
    status,
    statusLabel: STATUS_LABELS[status],
  };
}

async function fetchArrivals(stopId) {
  const url = new URL('/arrivals/', BASE_URL);
  url.search = new URLSearchParams({ key: process.env.WEBSERVICESKEY, stop: stopId });

  const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`TheBus responded with HTTP ${res.status}`);

  // TheBus declares ISO-8859-1, so don't let fetch decode it as UTF-8
  const xml = new TextDecoder('latin1').decode(await res.arrayBuffer());
  const { stopTimes } = parser.parse(xml);

  if (!stopTimes?.timestamp) throw new Error('TheBus sent an unexpected response');
  // TheBus reports problems like a bad key inside a normal 200 response
  if (stopTimes.errorMessage) throw new Error(`TheBus error: ${stopTimes.errorMessage}`);

  const [date, ...timeParts] = stopTimes.timestamp.split(' ');
  const time = timeParts.join(' ');
  const nowMs = parseHawaiiTime(date, time);

  // A stop with nothing coming (or a stop number that doesn't exist) has no <arrival> at all
  const arrivals = (stopTimes.arrival ?? [])
    .map((raw) => toArrival(raw, nowMs))
    .filter((arrival) => arrival.minutesAway >= 0 && arrival.minutesAway <= WINDOW_MINUTES)
    .sort((a, b) => a.minutesAway - b.minutesAway);

  return { stopId, updatedAt: formatClock(time), arrivals };
}

function pruneCache() {
  const now = Date.now();
  arrivalsCache.forEach((entry, stopId) => {
    if (entry.expiresAt <= now) arrivalsCache.delete(stopId);
  });
}

function getArrivals(stopId) {
  const cached = arrivalsCache.get(stopId);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  pruneCache();
  const promise = fetchArrivals(stopId);
  arrivalsCache.set(stopId, { promise, expiresAt: Date.now() + CACHE_TTL_MS });

  // Don't cache failures: the next request should try TheBus again
  promise.catch(() => {
    if (arrivalsCache.get(stopId)?.promise === promise) arrivalsCache.delete(stopId);
  });

  return promise;
}

module.exports = { getArrivals };
