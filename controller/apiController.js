const mongoose = require('mongoose');
const { validationResult, matchedData } = require('express-validator');
const Stop = require('../model/Stop');
const Route = require('../model/Route');
const RoutePattern = require('../model/RoutePattern');
const theBus = require('../services/theBus');
const { rememberStop } = require('../middleware/recentStops');

const MAX_STOPS_IN_AREA = 400;
const NEARBY_LIMIT = 8;
const NEARBY_RADIUS_METERS = 1000;
const STOP_LIST_CACHE_SECONDS = 300; // Stops only change when the GTFS import runs

// A few GTFS stops are garages that no route serves; riders never need them
const SERVED_STOPS = { routes: mongoose.trusted({ $ne: [] }) };

function toStopSummary(stop) {
  const [lon, lat] = stop.location.coordinates;
  return {
    stopId: stop.stopId,
    name: stop.name,
    lat,
    lon,
    routes: stop.routes,
    isRailStation: stop.isRailStation,
  };
}

// GET /api/stops/:stopId/arrivals: polled by public/js/arrivals.js
exports.getStopArrivals = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Invalid stop number.' });
  }

  const { stopId } = matchedData(req);

  // Don't spend TheBus quota on stops that don't exist
  if (!(await Stop.exists({ stopId }))) {
    return res.status(404).json({ error: 'Stop not found.' });
  }

  // Opening a stop on the map counts too: it's listed under "Your recent stops" on the Home tab
  rememberStop(req, res, stopId);

  try {
    const stop = await theBus.getArrivals(stopId);
    res.json(stop);
  } catch (err) {
    console.error(`TheBus arrivals failed for stop ${stopId}:`, err);
    res.status(502).json({ error: "TheBus isn't responding right now." });
  }
};

// GET /api/stops?west=&south=&east=&north=: pins for the map's visible area
exports.getStopsInArea = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Invalid map area.' });
  }

  const { west, south, east, north } = matchedData(req);
  const area = {
    type: 'Polygon',
    coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
  };

  const stops = await Stop.find({
    ...SERVED_STOPS,
    location: mongoose.trusted({ $geoWithin: { $geometry: area } }),
  })
    .limit(MAX_STOPS_IN_AREA)
    .lean();

  res.set('Cache-Control', `public, max-age=${STOP_LIST_CACHE_SECONDS}`);
  res.json({ stops: stops.map(toStopSummary) });
};

// GET /api/routes/:slug: one line per direction, with that direction's stops in order.
// Each direction uses its pattern with the most trips; short-trip variants aren't drawn.
exports.getRouteDetails = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Invalid route.' });
  }

  const route = await Route.findOne({ slug: matchedData(req).slug }).lean();
  if (!route) {
    return res.status(404).json({ error: 'Route not found.' });
  }

  const patterns = await RoutePattern.find({ routeId: route.routeId })
    .select('-tripIds') // Thousands of IDs the map doesn't need
    .sort({ tripCount: -1 })
    .lean();
  const mainPatterns = [0, 1]
    .map((direction) => patterns.find((pattern) => pattern.direction === direction))
    .filter(Boolean);

  const stopIds = [...new Set(mainPatterns.flatMap((pattern) => pattern.stopIds))];
  const stops = await Stop.find({ stopId: mongoose.trusted({ $in: stopIds }) }).lean();
  const stopsById = new Map(stops.map((stop) => [stop.stopId, toStopSummary(stop)]));

  res.set('Cache-Control', `public, max-age=${STOP_LIST_CACHE_SECONDS}`);
  res.json({
    route: {
      slug: route.slug,
      name: Route.getDisplayName(route),
      longName: route.longName,
      apiName: route.apiName,
      color: route.color,
      textColor: route.textColor,
      mode: route.mode,
    },
    directions: mainPatterns.map((pattern) => ({
      direction: pattern.direction,
      headsign: pattern.headsign,
      path: pattern.path.coordinates, // [[longitude, latitude], ...]
      stops: pattern.stopIds.map((stopId) => stopsById.get(stopId)).filter(Boolean),
    })),
  });
};

// GET /api/routes/:slug/vehicles: live buses on one route, polled by mapView.js every 30 seconds.
// A bus's trip ID names its route and direction. If the trip isn't in our GTFS copy (say TheBus
// published a new feed we haven't imported), fall back to the route name with direction unknown.
exports.getRouteVehicles = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Invalid route.' });
  }

  const route = await Route.findOne({ slug: matchedData(req).slug }).lean();
  if (!route) {
    return res.status(404).json({ error: 'Route not found.' });
  }

  const patterns = await RoutePattern.find({ routeId: route.routeId }).select('direction tripIds').lean();
  const directionByTrip = new Map(
    patterns.flatMap((pattern) => pattern.tripIds.map((tripId) => [tripId, pattern.direction]))
  );

  let live;
  try {
    live = await theBus.getVehicles();
  } catch (err) {
    console.error('TheBus vehicles failed:', err);
    return res.status(502).json({ error: "TheBus isn't responding right now." });
  }

  const vehicles = live.vehicles
    .filter((vehicle) => directionByTrip.has(vehicle.trip) || vehicle.routeName === route.shortName)
    .map((vehicle) => ({
      number: vehicle.number,
      lat: vehicle.lat,
      lon: vehicle.lon,
      direction: directionByTrip.get(vehicle.trip) ?? null,
      headsign: vehicle.headsign,
      adherenceMinutes: vehicle.adherenceMinutes,
      reportedSecondsAgo: vehicle.reportedSecondsAgo,
    }));

  res.set('Cache-Control', 'no-store'); // Live positions; the server already caches for 30 seconds
  res.json({ updatedAt: live.updatedAt, vehicles });
};

// GET /api/stops/nearby?lat=&lon=: the closest stops to the rider, with walking-line distance
exports.getNearbyStops = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Location must be on Oʻahu.' });
  }

  const { lat, lon } = matchedData(req);

  // $geoNear must be the first stage; it sorts by distance and adds distanceMeters
  const stops = await Stop.aggregate([
    {
      $geoNear: {
        near: { type: 'Point', coordinates: [lon, lat] },
        distanceField: 'distanceMeters',
        maxDistance: NEARBY_RADIUS_METERS,
        spherical: true,
        query: { routes: { $ne: [] } },
      },
    },
    { $limit: NEARBY_LIMIT },
  ]);

  res.set('Cache-Control', `public, max-age=${STOP_LIST_CACHE_SECONDS}`);
  res.json({
    stops: stops.map((stop) => ({
      ...toStopSummary(stop),
      distanceMeters: Math.round(stop.distanceMeters),
    })),
  });
};
