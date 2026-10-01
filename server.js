require('dotenv').config(); // First: load .env before anything reads process.env

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const connectDB = require('./config/database');

// Every stop lookup needs the TheBus API key, so fail fast if it's missing
if (!process.env.WEBSERVICESKEY) {
  console.error('WEBSERVICESKEY is not set. Add it to .env locally or to the Railway variables.');
  process.exit(1);
}

// Connect once; start listening only after it succeeds (see the bottom of this file)
const clientPromise = connectDB();

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';

// 1. Trust Railway's proxy: required for req.ip and rate limiting
app.set('trust proxy', 1);
app.set('view engine', 'ejs');

// The site's public address, for canonical links and link previews (views/partials/head.ejs).
// Set SITE_URL when the site gets a custom domain. It is never read from the request's Host
// header, which callers can fake.
const siteUrl = process.env.SITE_URL || 'https://weadabus.com';
app.locals.siteUrl = siteUrl.endsWith('/') ? siteUrl.slice(0, -1) : siteUrl;

// 2. Security headers: must come before everything else
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        // OpenStreetMap map tiles, and the X profile picture on the home page's posts
        imgSrc: ["'self'", 'data:', 'https://tile.openstreetmap.org', 'https://pbs.twimg.com'],
        upgradeInsecureRequests: isProduction ? [] : null, // Local dev runs on plain HTTP
      },
    },
  })
);

// 3. Logging
app.use(morgan(isProduction ? 'combined' : 'dev'));

// 4. Body parsing
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// 5. Static files. Leaflet is served from our own origin, so the CSP needs no script CDN
app.use(express.static('public'));
app.use('/vendor/leaflet', express.static(path.join(__dirname, 'node_modules/leaflet/dist')));

// 6. Routes
app.use('/', require('./routes/homeRoutes'));
app.use('/stops', require('./routes/stopRoutes'));
app.use('/routes', require('./routes/routeRoutes'));
app.use('/api', require('./routes/apiRoutes'));

// 7. 404: after all routes
app.use((req, res) => {
  res.status(404).render('error', {
    title: 'Page not found',
    message: "We couldn't find that page.",
  });
});

// 8. Centralized error handler: must be last
app.use((err, req, res, next) => {
  console.error(err); // Full details go to the logs, never to the user
  if (res.headersSent) return next(err);

  const status = err.status >= 400 && err.status < 600 ? err.status : 500;
  res.status(status).render('error', {
    title: 'Something went wrong',
    message: 'Something went wrong. Please try again.',
  });
});

clientPromise
  .then(() => {
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Database connection failed:', err);
    process.exit(1);
  });
