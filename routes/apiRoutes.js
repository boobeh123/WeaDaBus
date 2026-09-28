const express = require('express');
const apiController = require('../controller/apiController');
const { apiLimiter } = require('../middleware/rateLimiters');
const { validateStopId } = require('../middleware/validators');

const router = express.Router();

router.get('/stops/:stopId/arrivals', apiLimiter, validateStopId, apiController.getStopArrivals);

module.exports = router;
