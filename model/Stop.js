const mongoose = require('mongoose');

// Imported from TheBus's GTFS feed by scripts/importGtfs.js. Live arrivals are never stored.
const StopSchema = new mongoose.Schema({
  // The number on the bus stop sign, which is also what TheBus's arrivals endpoint takes
  stopId: { type: Number, required: true, unique: true },
  name: { type: String, required: true },
  location: {
    type: { type: String, enum: ['Point'], required: true },
    coordinates: { type: [Number], required: true }, // [longitude, latitude]
  },
  // Every route that serves this stop, e.g. ['1', '2', '32', 'A LINE']
  routes: { type: [String], default: [] },
});

StopSchema.index({ location: '2dsphere' });

module.exports = mongoose.model('Stop', StopSchema);
