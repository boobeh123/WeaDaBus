const { validationResult, matchedData } = require('express-validator');
const Route = require('../model/Route');

// Rail first, then buses in the order riders expect (1, 1L, 2, … 42 … A LINE, C, W1)
function compareForList(a, b) {
  if (a.mode !== b.mode) return a.mode === 'rail' ? -1 : 1;
  return Route.compareNames(a.name, b.name);
}

function toListItem(route) {
  const name = Route.getDisplayName(route);
  return {
    slug: route.slug,
    name,
    // Skyline's long name repeats its name, so describe it instead
    description: route.longName && route.longName !== name ? route.longName : 'Skyline rail',
    color: route.color,
    textColor: route.textColor,
    mode: route.mode,
  };
}

// GET /routes: the Routes tab, every route with a filter box
exports.getRoutes = async (req, res) => {
  const routes = await Route.find().lean();
  res.render('routes', {
    title: 'Routes',
    activeTab: 'routes',
    routes: routes.map(toListItem).sort(compareForList),
  });
};

// GET /routes/:slug: the map, zoomed to one route. mapView.js loads the line and stops.
exports.getRoute = async (req, res) => {
  const errors = validationResult(req);
  const route = errors.isEmpty() ? await Route.findOne({ slug: matchedData(req).slug }).lean() : null;

  if (!route) {
    return res.status(404).render('error', {
      title: 'Route not found',
      message: "We couldn't find that route. Pick one from the Routes list.",
    });
  }

  const { slug, name, description } = toListItem(route);
  res.render('map', {
    title: `Route ${name}`,
    activeTab: 'routes',
    route: { slug, name, description },
  });
};
