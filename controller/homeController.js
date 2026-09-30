// GET /: the Nearby tab, a full-screen map of Oʻahu
exports.getMap = async (req, res) => {
  res.render('map', { title: null, activeTab: 'nearby', route: null, canonicalPath: '/' });
};

// GET /search: the Search tab, looking up a stop by the number on its sign
exports.getSearch = async (req, res) => {
  res.render('search', {
    title: 'Search',
    activeTab: 'routes', // Search is reached from the bottom of the Routes tab
    error: null,
    canonicalPath: '/search',
    metaDescription: 'Look up live TheBus arrivals by the stop number on the sign.',
  });
};
