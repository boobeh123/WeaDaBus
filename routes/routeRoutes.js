const express = require('express');
const routeController = require('../controller/routeController');
const { validateRouteSlug } = require('../middleware/validators');

const router = express.Router();

router.get('/', routeController.getRoutes);
router.get('/:slug', validateRouteSlug, routeController.getRoute);

module.exports = router;
