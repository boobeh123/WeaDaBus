const mongoose = require('mongoose');

// Imported from TheBus's GTFS feed by scripts/importGtfs.js
const RouteSchema = new mongoose.Schema({
  routeId: { type: String, required: true, unique: true }, // GTFS route_id, e.g. '28'
  shortName: { type: String, default: '' }, // What riders see: '42', 'A LINE'. Empty for Skyline
  longName: { type: String, default: '' }, // 'Ewa Beach-Waikiki'
  apiName: { type: String, default: '' }, // How TheBus arrivals name it: 'A LINE' is 'A', Skyline is 'SKYLINE'
  color: { type: String, default: null }, // '#00FF00', or null when TheBus doesn't set one
  textColor: { type: String, default: null },
  agency: { type: String, enum: ['TheBus', 'Skyline'], required: true },
  mode: { type: String, enum: ['bus', 'rail'], required: true },
});

module.exports = mongoose.model('Route', RouteSchema);
