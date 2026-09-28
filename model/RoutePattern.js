const mongoose = require('mongoose');

// One path a bus drives: a route, in one direction, along one shape. A route can have
// several per direction (short trips, school runs); tripCount shows which runs most.
// Imported from TheBus's GTFS feed by scripts/importGtfs.js.
const RoutePatternSchema = new mongoose.Schema({
  routeId: { type: String, required: true, index: true },
  direction: { type: Number, enum: [0, 1], required: true }, // GTFS direction_id
  headsign: { type: String, required: true },
  shapeId: { type: String, required: true, index: true }, // Matches <shape> in TheBus arrivals
  // The line drawn on the map
  path: {
    type: { type: String, enum: ['LineString'], required: true },
    coordinates: { type: [[Number]], required: true }, // [[longitude, latitude], ...]
  },
  stopIds: { type: [Number], default: [] }, // Stops in the order the bus reaches them
  tripCount: { type: Number, required: true },
});

module.exports = mongoose.model('RoutePattern', RoutePatternSchema);
