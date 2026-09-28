const express = require('express');
const stopController = require('../controller/stopController');
const { pageLimiter } = require('../middleware/rateLimiters');
const { validateStopSearch, validateStopId } = require('../middleware/validators');

const router = express.Router();

router.get('/', validateStopSearch, stopController.getStopSearch);
router.get('/:stopId', pageLimiter, validateStopId, stopController.getStop);

module.exports = router;
