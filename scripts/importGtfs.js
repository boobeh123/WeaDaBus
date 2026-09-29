// Imports TheBus's GTFS schedule into MongoDB: stops, routes, and route patterns.
// Run with `npm run import:gtfs` whenever TheBus publishes a new feed (feed_info.txt
// says when the current one ends). Everything is parsed before the database is touched,
// so a bad download leaves the existing data in place.
require('dotenv').config();

const { Readable } = require('stream');
const mongoose = require('mongoose');
const { unzipSync } = require('fflate');
const { parse } = require('csv-parse');
const connectDB = require('../config/database');
const Stop = require('../model/Stop');
const Route = require('../model/Route');
const RoutePattern = require('../model/RoutePattern');

const GTFS_URL = 'https://www.thebus.org/transitdata/production/google_transit.zip';
const GTFS_FILES = ['feed_info.txt', 'routes.txt', 'stops.txt', 'trips.txt', 'stop_times.txt', 'shapes.txt'];
const ROUTE_MODES = { 1: 'rail', 3: 'bus' }; // GTFS route_type codes
const CHUNK_SIZE = 64 * 1024;

/**************************************************************
Helpers
***************************************************************/
// Feeds a file to the CSV parser in small chunks, so the 74 MB stop_times.txt
// is read row by row instead of becoming 1.4 million objects at once
async function forEachRow(bytes, callback) {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = function* () {
    for (let start = 0; start < buffer.length; start += CHUNK_SIZE) {
      yield buffer.subarray(start, start + CHUNK_SIZE);
    }
  };
  const parser = Readable.from(chunks()).pipe(
    parse({ columns: true, bom: true, trim: true, skip_empty_lines: true })
  );

  for await (const row of parser) callback(row);
}

// "20261205" -> "2026-12-05"
function formatGtfsDate(date) {
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
}

// "A LINE" -> "a-line", "42" -> "42", "SKYLINE" -> "skyline"
function toSlug(name) {
  return name.trim().toLowerCase().split(' ').join('-');
}

async function downloadFeed() {
  console.log(`Downloading ${GTFS_URL}`);
  const res = await fetch(GTFS_URL);
  if (!res.ok) throw new Error(`GTFS download failed with HTTP ${res.status}`);

  const zip = new Uint8Array(await res.arrayBuffer());
  const files = unzipSync(zip, { filter: (file) => GTFS_FILES.includes(file.name) });

  const missing = GTFS_FILES.filter((name) => !files[name]);
  if (missing.length) throw new Error(`GTFS feed is missing ${missing.join(', ')}`);

  return files;
}

/**************************************************************
Readers: one per GTFS file
***************************************************************/
async function readFeedInfo(bytes) {
  let info = null;
  await forEachRow(bytes, (row) => {
    info = info || row;
  });
  return info;
}

async function readRoutes(bytes) {
  const routes = new Map(); // routeId -> route document

  await forEachRow(bytes, (row) => {
    const shortName = row.route_short_name;
    routes.set(row.route_id, {
      routeId: row.route_id,
      slug: toSlug(shortName || row.route_long_name),
      shortName,
      longName: row.route_long_name,
      // Arrivals call "A LINE" just "A", and call Skyline (no short name) "SKYLINE"
      apiName: shortName.endsWith(' LINE')
        ? shortName.slice(0, -' LINE'.length)
        : shortName || row.route_long_name,
      color: row.route_color ? `#${row.route_color}` : null,
      textColor: row.route_text_color ? `#${row.route_text_color}` : null,
      agency: row.agency_id,
      mode: ROUTE_MODES[row.route_type],
    });
  });

  return routes;
}

// A few stops appear twice ("151" and "151_merge") with the same sign number, so stops
// are keyed by stop_code, the number on the sign. The plain stop_id's location wins.
async function readStops(bytes) {
  const stopsByCode = new Map(); // sign number -> stop document
  const codeByGtfsId = new Map(); // GTFS stop_id -> sign number, for joining stop_times

  await forEachRow(bytes, (row) => {
    const stopId = Number(row.stop_code);
    const isPlainId = row.stop_id === row.stop_code;
    codeByGtfsId.set(row.stop_id, stopId);

    if (stopsByCode.has(stopId) && !isPlainId) return;
    stopsByCode.set(stopId, {
      stopId,
      name: row.stop_name,
      location: { type: 'Point', coordinates: [Number(row.stop_lon), Number(row.stop_lat)] },
      routeIds: new Set(),
    });
  });

  return { stopsByCode, codeByGtfsId };
}

async function readTrips(bytes) {
  const trips = new Map(); // trip_id -> trip

  await forEachRow(bytes, (row) => {
    trips.set(row.trip_id, {
      routeId: row.route_id,
      direction: Number(row.direction_id),
      shapeId: row.shape_id,
      headsign: row.trip_headsign,
    });
  });

  return trips;
}

async function readShapes(bytes, wantedShapeIds) {
  const pointsByShape = new Map(); // shape_id -> [{ sequence, coordinates }]

  await forEachRow(bytes, (row) => {
    if (!wantedShapeIds.has(row.shape_id)) return;
    if (!pointsByShape.has(row.shape_id)) pointsByShape.set(row.shape_id, []);
    pointsByShape.get(row.shape_id).push({
      sequence: Number(row.shape_pt_sequence),
      coordinates: [Number(row.shape_pt_lon), Number(row.shape_pt_lat)],
    });
  });

  const paths = new Map();
  pointsByShape.forEach((points, shapeId) => {
    paths.set(
      shapeId,
      points.sort((a, b) => a.sequence - b.sequence).map((point) => point.coordinates)
    );
  });
  return paths;
}

/**************************************************************
Builders: combine files into documents
***************************************************************/
// Groups trips into patterns (route + direction + shape). Each pattern's stop list comes
// from its longest trip, so short-turn trips on the same shape don't cut stops off.
function groupPatterns(trips, stopCountByTrip) {
  const patterns = new Map();

  trips.forEach((trip, tripId) => {
    const key = `${trip.routeId}|${trip.direction}|${trip.shapeId}`;
    if (!patterns.has(key)) {
      patterns.set(key, {
        routeId: trip.routeId,
        direction: trip.direction,
        shapeId: trip.shapeId,
        headsignCounts: new Map(),
        tripIds: [],
        longestTripId: null,
        longestStopCount: -1,
      });
    }

    const pattern = patterns.get(key);
    const stopCount = stopCountByTrip.get(tripId) || 0;
    pattern.tripIds.push(tripId);
    pattern.headsignCounts.set(trip.headsign, (pattern.headsignCounts.get(trip.headsign) || 0) + 1);
    if (stopCount > pattern.longestStopCount) {
      pattern.longestTripId = tripId;
      pattern.longestStopCount = stopCount;
    }
  });

  return [...patterns.values()];
}

function getMostCommonHeadsign(headsignCounts) {
  return [...headsignCounts].reduce((best, current) => (current[1] > best[1] ? current : best))[0];
}

/**************************************************************
Main
***************************************************************/
async function saveCollection(Model, docs) {
  await Model.deleteMany({});
  await Model.insertMany(docs);
  await Model.syncIndexes();
  console.log(`  ${Model.modelName}: ${docs.length} saved`);
}

async function importGtfs() {
  // Connect first so a bad DB_STRING fails before the download
  await connectDB();
  const files = await downloadFeed();

  const feedInfo = await readFeedInfo(files['feed_info.txt']);
  console.log(
    `Feed ${feedInfo.feed_version}: valid ${formatGtfsDate(feedInfo.feed_start_date)} to ${formatGtfsDate(feedInfo.feed_end_date)}`
  );

  const routes = await readRoutes(files['routes.txt']);
  const { stopsByCode, codeByGtfsId } = await readStops(files['stops.txt']);
  const trips = await readTrips(files['trips.txt']);

  // stop_times pass 1: how many stops each trip makes, and which routes serve each stop
  console.log('Reading stop_times.txt (pass 1 of 2)');
  const stopCountByTrip = new Map();
  await forEachRow(files['stop_times.txt'], (row) => {
    const trip = trips.get(row.trip_id);
    const stop = stopsByCode.get(codeByGtfsId.get(row.stop_id));
    if (!trip || !stop) return;

    stopCountByTrip.set(row.trip_id, (stopCountByTrip.get(row.trip_id) || 0) + 1);
    stop.routeIds.add(trip.routeId);
  });

  const patterns = groupPatterns(trips, stopCountByTrip);

  // stop_times pass 2: the ordered stops of each pattern's longest trip
  console.log('Reading stop_times.txt (pass 2 of 2)');
  const stopsByLongestTrip = new Map(patterns.map((pattern) => [pattern.longestTripId, []]));
  await forEachRow(files['stop_times.txt'], (row) => {
    const tripStops = stopsByLongestTrip.get(row.trip_id);
    const stopId = codeByGtfsId.get(row.stop_id);
    if (tripStops && stopId !== undefined) {
      tripStops.push({ sequence: Number(row.stop_sequence), stopId });
    }
  });

  console.log('Reading shapes.txt');
  const paths = await readShapes(files['shapes.txt'], new Set(patterns.map((pattern) => pattern.shapeId)));

  // A line needs at least two points; skip any pattern whose shape is missing from the feed
  const drawablePatterns = patterns.filter((pattern) => (paths.get(pattern.shapeId) || []).length >= 2);
  const skipped = patterns.length - drawablePatterns.length;
  if (skipped) console.warn(`Skipping ${skipped} pattern(s) with no shape in shapes.txt`);

  const patternDocs = drawablePatterns.map((pattern) => ({
    routeId: pattern.routeId,
    direction: pattern.direction,
    headsign:
      getMostCommonHeadsign(pattern.headsignCounts) || Route.getDisplayName(routes.get(pattern.routeId)),
    shapeId: pattern.shapeId,
    path: { type: 'LineString', coordinates: paths.get(pattern.shapeId) },
    stopIds: stopsByLongestTrip
      .get(pattern.longestTripId)
      .sort((a, b) => a.sequence - b.sequence)
      .map((tripStop) => tripStop.stopId),
    tripCount: pattern.tripIds.length,
    tripIds: pattern.tripIds,
  }));

  const stopDocs = [...stopsByCode.values()].map(({ routeIds, ...stop }) => ({
    ...stop,
    routes: [...routeIds]
      .map((routeId) => Route.getDisplayName(routes.get(routeId)))
      .sort(Route.compareNames),
    isRailStation: [...routeIds].some((routeId) => routes.get(routeId).mode === 'rail'),
  }));

  const routeDocs = [...routes.values()];

  console.log('Saving to MongoDB');
  await saveCollection(Route, routeDocs);
  await saveCollection(Stop, stopDocs);
  await saveCollection(RoutePattern, patternDocs);

  await mongoose.disconnect();
  console.log('GTFS import finished');
}

importGtfs().catch(async (err) => {
  console.error('GTFS import failed:', err);
  await mongoose.disconnect();
  process.exit(1);
});
