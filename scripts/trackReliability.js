// Collects how on time TheBus's buses are running, for the on-time tracker (Feature 4).
// Railway runs it every 5 minutes (`npm run track:reliability`, the reliability-job service).
// Each run looks at TheBus's vehicle feed twice, 90 seconds apart, and counts only buses that are
// clearly driving the trip they report: on their route's line, away from both ends, and moving
// forward. TheBus's early/late number is right for those buses, but a bus that's parked,
// deadheading, waiting at the end of the line, or driving back under its old trip ID reports a
// frozen 0 or a stale number. Counts are added to each route's totals for the current hour
// (model/ReliabilityHour.js); readings aren't stored.
// `npm run track:reliability -- --dry-run` prints what it would count and saves nothing.
require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../config/database');
const theBus = require('../services/theBus');
const RoutePattern = require('../model/RoutePattern');
const Stop = require('../model/Stop');
const ReliabilityHour = require('../model/ReliabilityHour');

// On time is from 1 minute early to 5 minutes late, the usual transit standard. TheBus reports
// adherence in whole minutes, and positive means early.
const MAX_MINUTES_EARLY = 1;
const MAX_MINUTES_LATE = 5;
const MAX_PLAUSIBLE_MINUTES = 60; // Readings further off than this are glitches, not buses
const HOUR_MS = 60 * 60 * 1000;

// Position checks
const LOOK_GAP_MS = 90 * 1000; // Buses report about once a minute, and theBus.js caches for 30 seconds
const MAX_METERS_FROM_LINE = 250; // Further than this, the bus isn't on its trip's route
const END_OF_LINE_METERS = 150; // This close to a pattern's first or last stop, a bus is usually waiting
const MAX_METERS_BACKWARD = 50; // GPS wobble; more than this, the bus is driving the other way
const PASS_MARGIN_METERS = 40; // Where a line passes the same street twice, both passes are candidates
const METERS_PER_DEGREE = 111320;
const COS_LATITUDE = Math.cos((21.4 * Math.PI) / 180); // Oʻahu's latitude
const isDryRun = process.argv.includes('--dry-run'); // npm run track:reliability -- --dry-run

const SKIP_LABELS = {
  notSeenTwice: 'not on the same trip in both looks',
  unknownTrip: "on a trip our schedule copy can't check",
  noNewReport: 'with no new report',
  offRoute: 'off route',
  endOfLine: 'at the end of the line',
  backward: 'going backward',
};

/**************************************************************
Helpers
***************************************************************/
// +2 or more is early, +1 to -5 is on time, -6 or less is late
function classify(adherenceMinutes) {
  if (adherenceMinutes > MAX_MINUTES_EARLY) return 'early';
  if (adherenceMinutes < -MAX_MINUTES_LATE) return 'late';
  return 'onTime';
}

// The start of the current hour. Hawaii is UTC-10 all year, so UTC hours line up with Hawaii's.
function getHourStart(now = new Date()) {
  return new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
}

// [longitude, latitude] to flat meters, accurate to well under a meter across Oʻahu
function toMeters([lon, lat]) {
  return [lon * METERS_PER_DEGREE * COS_LATITUDE, lat * METERS_PER_DEGREE];
}

// A route line in meters, with how far along the line each point is
function buildLine(checkPath) {
  const points = checkPath.map(toMeters);
  const distances = [0];
  for (let i = 1; i < points.length; i += 1) {
    distances.push(distances[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  }
  return { points, distances };
}

// The closest spot to point p on segment k of a line: how far away it is, and how far along the line
function hitSegment(line, k, [px, py]) {
  const [ax, ay] = line.points[k];
  const [bx, by] = line.points[k + 1];
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared)) : 0;
  return {
    meters: Math.hypot(px - (ax + t * dx), py - (ay + t * dy)),
    along: line.distances[k] + t * Math.sqrt(lengthSquared),
  };
}

// Where a bus is on its line. A line that passes the same street twice (out and back) gives two
// candidates: nearAlong, the bus's earlier spot on the line, picks the closer one, and without it
// the nearest wins.
function locateOnLine(line, point, nearAlong = null) {
  const hits = line.points.slice(1).map((next, k) => hitSegment(line, k, point));
  const nearest = Math.min(...hits.map((hit) => hit.meters));
  const candidates = hits.filter((hit) => hit.meters <= nearest + PASS_MARGIN_METERS);
  const score = (hit) => (nearAlong === null ? hit.meters : Math.abs(hit.along - nearAlong));
  return candidates.reduce((best, hit) => (score(hit) < score(best) ? hit : best));
}

// What each running trip's checks need: its direction, its line, and its first and last stops.
// The database sends back only the trip IDs that match, so the 10 MB of trip IDs never leaves Atlas.
async function getPatternsByTrip(tripIds) {
  const patterns = await RoutePattern.aggregate([
    { $match: { tripIds: { $in: tripIds } } },
    {
      $project: {
        _id: 0,
        direction: 1,
        checkPath: 1,
        firstStopId: { $first: '$stopIds' },
        lastStopId: { $last: '$stopIds' },
        tripIds: { $filter: { input: '$tripIds', cond: { $in: ['$$this', tripIds] } } },
      },
    },
  ]);

  // sanitizeFilter (config/database.js) would neutralize $in unless it's marked as trusted
  const endStopIds = [...new Set(patterns.flatMap((pattern) => [pattern.firstStopId, pattern.lastStopId]))];
  const endStops = await Stop.find({ stopId: mongoose.trusted({ $in: endStopIds }) }).select('stopId location').lean();
  const endById = new Map(endStops.map((stop) => [stop.stopId, toMeters(stop.location.coordinates)]));

  const patternByTrip = new Map();
  patterns
    .filter((pattern) => (pattern.checkPath ?? []).length >= 2) // Patterns imported before checkPath can't be checked
    .forEach((pattern) => {
      const checks = {
        direction: pattern.direction,
        line: buildLine(pattern.checkPath),
        ends: [endById.get(pattern.firstStopId), endById.get(pattern.lastStopId)].filter(Boolean),
      };
      pattern.tripIds.forEach((tripId) => patternByTrip.set(tripId, checks));
    });
  return patternByTrip;
}

// Why a bus can't be counted, or null when it's clearly driving its trip. first and second are the
// same bus at the two looks.
function getSkipReason(first, second, pattern) {
  if (!first || first.trip !== second.trip) return 'notSeenTwice';
  if (!pattern) return 'unknownTrip';
  // Without a report since the first look, there's no way to tell which way it's going
  if (second.reportedSecondsAgo * 1000 >= LOOK_GAP_MS) return 'noNewReport';

  const point = toMeters([second.lon, second.lat]);
  const before = locateOnLine(pattern.line, toMeters([first.lon, first.lat]));
  const after = locateOnLine(pattern.line, point, before.along);
  if (after.meters > MAX_METERS_FROM_LINE) return 'offRoute';
  if (pattern.ends.some(([x, y]) => Math.hypot(point[0] - x, point[1] - y) < END_OF_LINE_METERS)) return 'endOfLine';
  if (after.along < before.along - MAX_METERS_BACKWARD) return 'backward';
  return null;
}

// Adds up this run's counted buses, one total per route and direction
function totalReadings(readings, patternByTrip) {
  const totals = new Map();

  readings.forEach((bus) => {
    const { direction } = patternByTrip.get(bus.trip);
    const key = `${bus.routeName}|${direction}`;
    if (!totals.has(key)) {
      totals.set(key, { routeName: bus.routeName, direction, readings: 0, onTime: 0, early: 0, late: 0, totalMinutesLate: 0, maxMinutesLate: 0 });
    }

    const total = totals.get(key);
    const minutesLate = Math.max(0, -bus.adherenceMinutes);
    total.readings += 1;
    total[classify(bus.adherenceMinutes)] += 1;
    total.totalMinutesLate += minutesLate;
    total.maxMinutesLate = Math.max(total.maxMinutesLate, minutesLate);
  });

  return [...totals.values()];
}

/**************************************************************
Main
***************************************************************/
async function trackReliability() {
  if (!process.env.DB_STRING || !process.env.WEBSERVICESKEY) {
    throw new Error('DB_STRING and WEBSERVICESKEY must be set. Add them to .env locally or to this service in Railway.');
  }

  // TheBus first: if it's down, nothing is written
  const firstLook = await theBus.getVehicles();
  await new Promise((resolve) => setTimeout(resolve, LOOK_GAP_MS));
  const hourStart = getHourStart();
  const secondLook = await theBus.getVehicles();

  const readings = secondLook.vehicles.filter(
    (bus) => bus.routeName && Number.isFinite(bus.adherenceMinutes) && Math.abs(bus.adherenceMinutes) <= MAX_PLAUSIBLE_MINUTES
  );
  if (!readings.length) {
    console.log('Reliability: no buses reporting right now');
    return;
  }

  await connectDB();
  const patternByTrip = await getPatternsByTrip(readings.map((bus) => bus.trip));
  const firstByBus = new Map(firstLook.vehicles.map((bus) => [bus.number, bus]));

  const counted = [];
  const skipped = {};
  readings.forEach((bus) => {
    const reason = getSkipReason(firstByBus.get(bus.number), bus, patternByTrip.get(bus.trip));
    if (reason) skipped[reason] = (skipped[reason] ?? 0) + 1;
    else counted.push(bus);
  });

  const totals = totalReadings(counted, patternByTrip);
  if (isDryRun) {
    totals
      .sort((a, b) => a.routeName.localeCompare(b.routeName, 'en', { numeric: true }) || a.direction - b.direction)
      .forEach((total) => {
        console.log(`  ${total.routeName} (direction ${total.direction}): ${total.readings} counted, ${total.onTime} on time, ${total.early} early, ${total.late} late`);
      });
  } else if (totals.length) {
    await ReliabilityHour.bulkWrite(
      totals.map(({ routeName, direction, maxMinutesLate, ...counts }) => ({
        updateOne: {
          filter: { routeName, direction, hourStart },
          update: { $inc: counts, $max: { maxMinutesLate } },
          upsert: true,
        },
      }))
    );
  }

  const late = counted.filter((bus) => classify(bus.adherenceMinutes) === 'late').length;
  const skips = Object.entries(skipped).map(([reason, count]) => `${count} ${SKIP_LABELS[reason]}`).join(', ') || 'none';
  console.log(
    `Reliability${isDryRun ? ' (dry run, nothing saved)' : ''}: ${counted.length} buses counted on ${new Set(counted.map((bus) => bus.routeName)).size} routes, ${late} running late; skipped ${skips}`
  );

  // Railway skips the next run while this one is still going, so close the connection and exit
  await mongoose.disconnect();
}

trackReliability().catch(async (err) => {
  console.error('Reliability tracking failed:', err);
  await mongoose.disconnect();
  process.exit(1);
});
