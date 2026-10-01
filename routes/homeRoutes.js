const express = require('express');
const homeController = require('../controller/homeController');

const router = express.Router();

router.get('/', homeController.getHome);
router.get('/nearby', homeController.getMap);
router.get('/search', homeController.getSearch);

module.exports = router;
