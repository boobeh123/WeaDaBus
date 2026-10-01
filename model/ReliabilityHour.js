const mongoose = require('mongoose');

// How on time one route's buses ran in one hour, built by scripts/trackReliability.js from
// TheBus's vehicle feed for the on-time tracker. Each reading is one bus at one moment, so the
// counts say how often the route's buses were running on time, not how many trips arrived on
// time. The readings themselves aren't kept, only these totals.
const ReliabilityHourSchema = new mongoose.Schema({
  routeName: { type: String, required: true }, // The vehicle feed's name, the same as Route.shortName: '42', 'A LINE'
  direction: { type: Number, default: null }, // 0 or 1 from the bus's trip; null when the trip isn't in our GTFS copy
  hourStart: { type: Date, required: true }, // Hawaii is UTC-10 all year, so UTC hours are Hawaii hours too
  readings: { type: Number, default: 0 },
  onTime: { type: Number, default: 0 }, // From 1 minute early to 5 minutes late
  early: { type: Number, default: 0 }, // More than 1 minute early
  late: { type: Number, default: 0 }, // More than 5 minutes late
  totalMinutesLate: { type: Number, default: 0 }, // Minutes late summed over every reading (0 for early ones), for the average
  maxMinutesLate: { type: Number, default: 0 },
});

// One document per route, direction, and hour; each run of the job adds to it
ReliabilityHourSchema.index({ routeName: 1, direction: 1, hourStart: 1 }, { unique: true });

module.exports = mongoose.model('ReliabilityHour', ReliabilityHourSchema);
