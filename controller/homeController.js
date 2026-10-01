const NewsArticle = require('../model/NewsArticle');

const NEWS_LIMIT = 5;

// "Tue, Sep 29". Railway's clock runs on UTC, so dates are shown in Hawaii time on purpose.
const hawaiiDate = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Pacific/Honolulu',
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});

// GET /: the Home tab, the latest news from the Hawaiʻi Department of Transportation.
// scripts/fetchNews.js saves it on a schedule, so this page only reads MongoDB.
exports.getHome = async (req, res) => {
  const articles = await NewsArticle.find().sort({ publishedAt: -1 }).limit(NEWS_LIMIT).lean();

  res.render('home', {
    title: null,
    activeTab: 'home',
    canonicalPath: '/',
    metaDescription: 'Live TheBus arrivals for Oʻahu, plus the latest news from the Hawaiʻi Department of Transportation.',
    articles: articles.map((article) => ({
      title: article.title,
      url: article.url,
      excerpt: article.excerpt,
      date: hawaiiDate.format(article.publishedAt),
      dateTime: article.publishedAt.toISOString(),
    })),
  });
};

// GET /nearby: the Nearby tab, a full-screen map of Oʻahu
exports.getMap = async (req, res) => {
  res.render('map', {
    title: 'Nearby',
    activeTab: 'nearby',
    route: null,
    canonicalPath: '/nearby',
    metaDescription: 'Find TheBus and Skyline stops near you on a map of Oʻahu, with live arrivals.',
  });
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
