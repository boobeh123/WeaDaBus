const { param, query } = require('express-validator');

// Stop numbers are the digits printed on the bus stop sign
const stopNumberRule = (field) =>
  field
    .isString()
    .trim()
    .isInt({ min: 1, max: 99999 })
    .withMessage('Enter the stop number from the bus stop sign.')
    .toInt();

// A box around Oʻahu with an ocean margin. Map and "near me" requests must fall inside it.
const OAHU_LATITUDE = { min: 21.0, max: 22.0 };
const OAHU_LONGITUDE = { min: -158.6, max: -157.4 };

const coordinateRule = (field, range) =>
  field.isString().isFloat(range).withMessage('Location must be on Oʻahu.').toFloat();

// Route URLs like /routes/42 or /routes/a-line. Lowercased first so /routes/W1 works too.
exports.validateRouteSlug = [
  param('slug').isString().trim().toLowerCase().isLength({ max: 20 }).isSlug(),
];

exports.validateStopSearch = [stopNumberRule(query('stop'))];

exports.validateStopId = [stopNumberRule(param('stopId'))];

// GET /api/stops?west=&south=&east=&north=: the map's visible area
exports.validateMapArea = [
  coordinateRule(query('west'), OAHU_LONGITUDE),
  coordinateRule(query('south'), OAHU_LATITUDE),
  coordinateRule(query('east'), OAHU_LONGITUDE)
    .custom((east, { req }) => east > Number(req.query.west))
    .withMessage('East must be east of west.'),
  coordinateRule(query('north'), OAHU_LATITUDE)
    .custom((north, { req }) => north > Number(req.query.south))
    .withMessage('North must be north of south.'),
];

// GET /api/stops/nearby?lat=&lon=: the rider's location
exports.validateLocation = [
  coordinateRule(query('lat'), OAHU_LATITUDE),
  coordinateRule(query('lon'), OAHU_LONGITUDE),
];
