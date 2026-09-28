const mongoose = require('mongoose');
const { validationResult, matchedData } = require('express-validator');
const Stop = require('../model/Stop');
const theBus = require('../services/theBus');

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
