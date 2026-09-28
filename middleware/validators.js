const { param, query } = require('express-validator');

// Stop numbers are the digits printed on the bus stop sign
const stopNumberRule = (field) =>
  field
    .isString()
    .trim()
    .isInt({ min: 1, max: 99999 })
    .withMessage('Enter the stop number from the bus stop sign.')
    .toInt();

exports.validateStopSearch = [stopNumberRule(query('stop'))];

exports.validateStopId = [stopNumberRule(param('stopId'))];
