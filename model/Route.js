const mongoose = require('mongoose');

// Imported from TheBus's GTFS feed by scripts/importGtfs.js
const RouteSchema = new mongoose.Schema({
  routeId: { type: String, required: true, unique: true }, // GTFS route_id, e.g. '28'
  slug: { type: String, required: true, unique: true }, // URL name: '42', 'a-line', 'skyline'
  shortName: { type: String, default: '' }, // What riders see: '42', 'A LINE'. Empty for Skyline
  longName: { type: String, default: '' }, // 'Ewa Beach-Waikiki'
  // How TheBus arrivals name it: 'A LINE' is 'A', Skyline is 'SKYLINE'.
  // Live vehicles use shortName instead.
  apiName: { type: String, default: '' },
  color: { type: String, default: null }, // '#00FF00', or null when TheBus doesn't set one
  textColor: { type: String, default: null },
  agency: { type: String, enum: ['TheBus', 'Skyline'], required: true },
  mode: { type: String, enum: ['bus', 'rail'], required: true },
});

// What riders call the route: '42', 'A LINE', or 'SKYLINE' (Skyline has no short name)
RouteSchema.statics.getDisplayName = (route) => route.shortName || route.longName;

// Sorts route names the way riders expect: 2 before 10, and 84 before 84A
RouteSchema.statics.compareNames = (a, b) => a.localeCompare(b, 'en', { numeric: true });

module.exports = mongoose.model('Route', RouteSchema);
