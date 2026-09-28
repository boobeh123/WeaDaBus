require('dotenv').config(); // First: load .env before anything reads process.env

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

// 2. Security headers: must come before everything else
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
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

// 5. Static files
app.use(express.static('public'));

// 6. Routes
app.use('/', require('./routes/homeRoutes'));
app.use('/stops', require('./routes/stopRoutes'));
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
