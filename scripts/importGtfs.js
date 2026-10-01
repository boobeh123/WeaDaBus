// Imports TheBus's GTFS schedule into MongoDB: stops, routes, and route patterns.
// Railway runs it every day at 3 AM Hawaii time (`npm run import:gtfs`, the gtfs-job service).
// Most days TheBus answers that the file hasn't changed, and the run ends without downloading.
// A new schedule is imported on the day it starts; `npm run import:gtfs -- --force` imports
// right away. Everything is parsed before the database is touched, and each collection's new
// data replaces the old in a single rename, so a bad download leaves the existing data in place
// and pages never see an empty collection.
require('dotenv').config();

const { Readable } = require('stream');
const mongoose = require('mongoose');
const { unzipSync } = require('fflate');
const { parse } = require('csv-parse');
const connectDB = require('../config/database');
const Stop = require('../model/Stop');
const Route = require('../model/Route');
const RoutePattern = require('../model/RoutePattern');
const FeedImport = require('../model/FeedImport');

const GTFS_URL = 'https://www.thebus.org/transitdata/production/google_transit.zip';
const GTFS_FILES = ['feed_info.txt', 'routes.txt', 'stops.txt', 'trips.txt', 'stop_times.txt', 'shapes.txt'];
const ROUTE_MODES = { 1: 'rail', 3: 'bus' }; // GTFS route_type codes
const CHUNK_SIZE = 64 * 1024;
// A stuck download would hold up every later run, since Railway skips a run while one is going
const DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000;
const isForced = process.argv.includes('--force'); // npm run import:gtfs -- --force

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

// Today's date in Hawaii as "20261001", to compare with the dates in feed_info.txt. Railway's
// clock runs on UTC, which is already tomorrow from 2 PM in Hawaii. en-CA writes 2026-10-01.
function getHawaiiDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Honolulu' }).format(new Date()).replaceAll('-', '');
}

// "A LINE" -> "a-line", "42" -> "42", "SKYLINE" -> "skyline"
function toSlug(name) {
  return name.trim().toLowerCase().split(' ').join('-');
}

// Downloads the schedule file, unless it hasn't changed since the last import. Sent the version
// tag and date saved from that import, TheBus answers 304 Not Modified, and this returns null.
async function downloadFeed(lastImport) {
  const headers = {};
  if (lastImport && !isForced) {
    if (lastImport.etag) headers['If-None-Match'] = lastImport.etag;
    if (lastImport.lastModified) headers['If-Modified-Since'] = lastImport.lastModified;
  }

  console.log(`Checking ${GTFS_URL}`);
  const res = await fetch(GTFS_URL, { headers, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  const etag = res.headers.get('etag') || '';

  // A server that ignores those headers sends the whole file, but the same version tag still means unchanged
  if (res.status === 304 || (!isForced && etag && etag === lastImport?.etag)) {
    await res.body?.cancel();
    return null;
  }
  if (!res.ok) throw new Error(`GTFS download failed with HTTP ${res.status}`);

  console.log('Downloading the schedule');
  const zip = new Uint8Array(await res.arrayBuffer());
  const files = unzipSync(zip, { filter: (file) => GTFS_FILES.includes(file.name) });

  const missing = GTFS_FILES.filter((name) => !files[name]);
  if (missing.length) throw new Error(`GTFS feed is missing ${missing.join(', ')}`);

  return { files, etag, lastModified: res.headers.get('last-modified') || '' };
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
Saving
***************************************************************/
// Builds a collection's new data in a copy ("stops_import") with the same schema and indexes.
// The live collection stays untouched until swapIn renames the copy over it.
async function buildCopy(Model, docs) {
  const { db } = mongoose.connection;
  const liveName = Model.collection.collectionName;
  const copyName = `${liveName}_import`;

  // A copy left behind by a run that crashed
  if ((await db.listCollections({ name: copyName }).toArray()).length) await db.dropCollection(copyName);

  // syncIndexes builds the indexes once the data is in, instead of Mongoose building them on load
  const schema = Model.schema.clone();
  schema.set('autoIndex', false);
  schema.set('autoCreate', false);
  const Copy = mongoose.model(`${Model.modelName}Import`, schema, copyName);

  await Copy.insertMany(docs);
  await Copy.syncIndexes();
  console.log(`  ${Model.modelName}: ${docs.length} ready`);

  return { copyName, liveName };
}

// Renames each copy over its live collection. A rename is a single step, so pages read the
// old data right up to the swap and never see an empty collection.
async function swapIn(copies) {
  for (const { copyName, liveName } of copies) {
    await mongoose.connection.db.renameCollection(copyName, liveName, { dropTarget: true });
  }
  console.log('  Swapped in the new schedule');
}

/**************************************************************
Main
***************************************************************/
async function importGtfs() {
  // Connect first so a bad DB_STRING fails before the download
  await connectDB();
  const lastImport = await FeedImport.findOne({ url: GTFS_URL }).lean();

  const download = await downloadFeed(lastImport);
  if (!download) {
    console.log(`Schedule unchanged: feed ${lastImport?.feedVersion}, valid to ${lastImport?.endDate}`);
    await mongoose.disconnect();
    return;
  }
  const { files } = download;

  const feedInfo = await readFeedInfo(files['feed_info.txt']);
  console.log(
    `Feed ${feedInfo.feed_version}: valid ${formatGtfsDate(feedInfo.feed_start_date)} to ${formatGtfsDate(feedInfo.feed_end_date)}`
  );

  // TheBus posts a new schedule about two weeks before it starts. Importing it early would
  // replace the trip IDs that buses on the current schedule still report, and they'd lose their
  // direction on route maps. So it waits for the schedule's first day, in Hawaii time.
  if (!isForced && feedInfo.feed_start_date > getHawaiiDate()) {
    console.log(
      `The new schedule starts on ${formatGtfsDate(feedInfo.feed_start_date)}. Keeping the current one until then.`
    );
    await mongoose.disconnect();
    return;
  }

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
  const copies = [
    await buildCopy(Route, routeDocs),
    await buildCopy(Stop, stopDocs),
    await buildCopy(RoutePattern, patternDocs),
  ];
  await swapIn(copies);

  // Saved so the next run can ask TheBus whether the file has changed
  await FeedImport.updateOne(
    { url: GTFS_URL },
    {
      $set: {
        etag: download.etag,
        lastModified: download.lastModified,
        feedVersion: feedInfo.feed_version,
        startDate: formatGtfsDate(feedInfo.feed_start_date),
        endDate: formatGtfsDate(feedInfo.feed_end_date),
        importedAt: new Date(),
      },
    },
    { upsert: true }
  );

  await mongoose.disconnect();
  console.log('GTFS import finished');
}

importGtfs().catch(async (err) => {
  console.error('GTFS import failed:', err);
  await mongoose.disconnect();
  process.exit(1);
});
