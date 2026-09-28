const rateLimit = require('express-rate-limit');

// Stop lookups can cost a TheBus call, and the API key allows 250,000 a day.
// A rider's page refreshes once a minute, so 60 a minute leaves lots of headroom
// while stopping one visitor from scanning through every stop number.
const WINDOW_MS = 60 * 1000;
const LIMIT = 60;

exports.pageLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: LIMIT,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    res.status(options.statusCode).render('error', {
      title: 'Too many requests',
      message: 'Too many stop lookups. Wait a minute and try again.',
    });
  },
});

exports.apiLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: LIMIT,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    res.status(options.statusCode).json({ error: 'Too many requests. Wait a minute and try again.' });
  },
});
