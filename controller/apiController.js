const { validationResult, matchedData } = require('express-validator');
const Stop = require('../model/Stop');
const theBus = require('../services/theBus');

// GET /api/stops/:stopId/arrivals: polled by public/js/stopArrivals.js
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
