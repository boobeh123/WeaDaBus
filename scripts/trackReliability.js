// Collects how on time TheBus's buses are running, for the on-time tracker (Feature 4).
// Railway runs it every 5 minutes (`npm run track:reliability`, the reliability-job service).
// Each run makes one call to TheBus's vehicle feed and adds every bus's early/late reading to
// its route's totals for the current hour (model/ReliabilityHour.js). Readings aren't stored.
require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../config/database');
const theBus = require('../services/theBus');
const RoutePattern = require('../model/RoutePattern');
const ReliabilityHour = require('../model/ReliabilityHour');

// On time is from 1 minute early to 5 minutes late, the usual transit standard. TheBus reports
// adherence in whole minutes, and positive means early.
const MAX_MINUTES_EARLY = 1;
const MAX_MINUTES_LATE = 5;
const MAX_PLAUSIBLE_MINUTES = 60; // Readings further off than this are glitches, not buses
const HOUR_MS = 60 * 60 * 1000;

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

// Each running bus's direction, found by its GTFS trip ID. The database sends back only the
// trip IDs that match, so the 10 MB of trip IDs across all patterns never leaves Atlas.
async function getDirectionsByTrip(tripIds) {
  const patterns = await RoutePattern.aggregate([
    { $match: { tripIds: { $in: tripIds } } },
    {
      $project: {
        _id: 0,
        direction: 1,
        tripIds: { $filter: { input: '$tripIds', cond: { $in: ['$$this', tripIds] } } },
      },
    },
  ]);

  return new Map(patterns.flatMap((pattern) => pattern.tripIds.map((tripId) => [tripId, pattern.direction])));
}

// Adds up this run's readings, one total per route and direction
function totalReadings(readings, directionByTrip) {
  const totals = new Map();

  readings.forEach((bus) => {
    const direction = directionByTrip.get(bus.trip) ?? null;
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
  const hourStart = getHourStart();
  const { vehicles } = await theBus.getVehicles();
  const readings = vehicles.filter(
    (bus) => bus.routeName && Number.isFinite(bus.adherenceMinutes) && Math.abs(bus.adherenceMinutes) <= MAX_PLAUSIBLE_MINUTES
  );

  if (!readings.length) {
    console.log('Reliability: no buses reporting right now');
    return;
  }

  await connectDB();
  const totals = totalReadings(readings, await getDirectionsByTrip(readings.map((bus) => bus.trip)));
  await ReliabilityHour.bulkWrite(
    totals.map(({ routeName, direction, maxMinutesLate, ...counts }) => ({
      updateOne: {
        filter: { routeName, direction, hourStart },
        update: { $inc: counts, $max: { maxMinutesLate } },
        upsert: true,
      },
    }))
  );

  const late = readings.filter((bus) => classify(bus.adherenceMinutes) === 'late').length;
  console.log(`Reliability: ${readings.length} buses on ${new Set(readings.map((bus) => bus.routeName)).size} routes, ${late} running late`);

  // Railway skips the next run while this one is still going, so close the connection and exit
  await mongoose.disconnect();
}

trackReliability().catch(async (err) => {
  console.error('Reliability tracking failed:', err);
  await mongoose.disconnect();
  process.exit(1);
});
