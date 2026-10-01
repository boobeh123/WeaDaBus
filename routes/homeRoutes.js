const express = require('express');
const homeController = require('../controller/homeController');
const { pageLimiter } = require('../middleware/rateLimiters');

const router = express.Router();

// Home can cost a TheBus call per recent stop, so it shares the stop pages' limit
router.get('/', pageLimiter, homeController.getHome);
router.post('/recent-stops/clear', homeController.postClearRecentStops);
router.get('/nearby', homeController.getMap);
router.get('/search', homeController.getSearch);

module.exports = router;
