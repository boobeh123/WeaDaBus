const { validationResult, matchedData } = require('express-validator');
const Stop = require('../model/Stop');
const theBus = require('../services/theBus');

// GET /stops?stop=983: the Search tab's form submits here
exports.getStopSearch = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    // No sessions yet, so re-render the form with the message instead of flashing and redirecting
    return res
      .status(400)
      .render('search', { title: 'Search', activeTab: 'routes', error: errors.array()[0].msg });
  }

  const { stop } = matchedData(req);

  // Catch a mistyped number here, while the rider is still on the form
  if (!(await Stop.exists({ stopId: stop }))) {
    return res.status(404).render('search', {
      title: 'Search',
      activeTab: 'routes',
      error: `We couldn't find stop ${stop}. Check the number on the bus stop sign.`,
    });
  }

  res.redirect(`/stops/${stop}`);
};

// GET /stops/:stopId: rendered on the server so arrivals show before any JS runs
exports.getStop = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(404).render('error', {
      title: 'Stop not found',
      message: "That isn't a stop number. You'll find the number on the sign at the bus stop.",
    });
  }

  const { stopId } = matchedData(req);

  // Check our copy of the GTFS stops first: TheBus can't tell a fake stop from an empty one
  const stopInfo = await Stop.findOne({ stopId }).lean();
  if (!stopInfo) {
    return res.status(404).render('error', {
      title: 'Stop not found',
      message: `We couldn't find stop ${stopId}. Check the number on the bus stop sign.`,
    });
  }

  // A TheBus outage shouldn't be an error page: show the stop with a "not responding" message
  let stop = null;
  try {
    stop = await theBus.getArrivals(stopId);
  } catch (err) {
    console.error(`TheBus arrivals failed for stop ${stopId}:`, err);
  }

  res.render('stopArrivals', {
    title: `${stopInfo.name} · Stop ${stopId}`,
    stopId,
    stopName: stopInfo.name,
    stop,
    canonicalPath: `/stops/${stopId}`,
    metaDescription: `Live bus arrivals at ${stopInfo.name} (stop ${stopId}).`,
  });
};
