const express = require('express');
const apiController = require('../controller/apiController');
const { apiLimiter, mapLimiter } = require('../middleware/rateLimiters');
const { validateStopId, validateMapArea, validateLocation } = require('../middleware/validators');

const router = express.Router();

router.get('/stops', mapLimiter, validateMapArea, apiController.getStopsInArea);
router.get('/stops/nearby', mapLimiter, validateLocation, apiController.getNearbyStops);
router.get('/stops/:stopId/arrivals', apiLimiter, validateStopId, apiController.getStopArrivals);

module.exports = router;
