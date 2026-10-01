const mongoose = require('mongoose');
const NewsArticle = require('../model/NewsArticle');
const XPost = require('../model/XPost');
const Stop = require('../model/Stop');
const theBus = require('../services/theBus');
const { getRecentStops, clearRecentStops } = require('../middleware/recentStops');

const NEWS_LIMIT = 5;
const POSTS_LIMIT = 5;
// Home waits this long at most for TheBus. A recent stop it hasn't answered for shows without a bus.
const RECENT_STOP_TIMEOUT_MS = 3000;

// "Tue, Sep 29". Railway's clock runs on UTC, so dates are shown in Hawaii time on purpose.
const hawaiiDate = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Pacific/Honolulu',
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});

// "Sep 30, 10:34 AM" in Hawaii time, for posts on X
const hawaiiDateTime = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Pacific/Honolulu',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

// Resolves to null when the promise takes longer than ms
async function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// The rider's recent stops, in their order, each with TheBus's arrivals (or null when TheBus
// failed or ran out of time). Stops come from our copy of the GTFS stops, so a made-up number
// in the cookie is skipped, and TheBus is only asked about real stops.
async function loadRecentStops(stopIds) {
  if (!stopIds.length) return [];

  // sanitizeFilter (config/database.js) would neutralize $in unless it's marked as trusted
  const stops = await Stop.find({ stopId: mongoose.trusted({ $in: stopIds }) }).lean();
  const stopsById = new Map(stops.map((stop) => [stop.stopId, stop]));

  return Promise.all(
    stopIds
      .filter((stopId) => stopsById.has(stopId))
      .map(async (stopId) => {
        let arrivals = null;
        try {
          arrivals = await withTimeout(theBus.getArrivals(stopId), RECENT_STOP_TIMEOUT_MS);
        } catch (err) {
          console.error(`TheBus arrivals failed for stop ${stopId} on Home:`, err);
        }
        return { stopId, name: stopsById.get(stopId).name, arrivals };
      })
  );
}

// GET /: the Home tab. The rider's recent stops with their next bus come first, then the latest
// news from the Hawaiʻi Department of Transportation and its posts on X. scripts/fetchNews.js
// saves the news on a schedule, so only the recent stops can wait on TheBus, for 3 seconds at most.
exports.getHome = async (req, res) => {
  const [recentStops, articles, posts] = await Promise.all([
    loadRecentStops(getRecentStops(req)),
    NewsArticle.find().sort({ publishedAt: -1 }).limit(NEWS_LIMIT).lean(),
    XPost.find().sort({ postedAt: -1 }).limit(POSTS_LIMIT).lean(),
  ]);

  // The page can list this rider's own stops, so no shared cache may keep a copy
  res.set('Cache-Control', 'private, no-cache');
  res.render('home', {
    title: null,
    activeTab: 'home',
    canonicalPath: '/',
    metaDescription: 'Live TheBus arrivals for Oʻahu, plus the latest news from the Hawaiʻi Department of Transportation.',
    recentStops: recentStops.map(({ stopId, name, arrivals }) => {
      const nextBus = arrivals?.arrivals.find((arrival) => arrival.status !== 'canceled');

      return {
        stopId,
        name,
        hasTimes: Boolean(arrivals),
        nextBus: nextBus && {
          route: nextBus.route,
          isLongName: nextBus.route.length > 4, // SKYLINE gets a smaller badge, like on arrival cards
          headsign: nextBus.headsign,
          minutes: nextBus.minutesAway <= 0 ? 'Now' : `${nextBus.minutesAway} min`,
        },
      };
    }),
    recentStopsUpdatedAt: recentStops.find((stop) => stop.arrivals)?.arrivals.updatedAt ?? null,
    articles: articles.map((article) => ({
      title: article.title,
      url: article.url,
      excerpt: article.excerpt,
      date: hawaiiDate.format(article.publishedAt),
      dateTime: article.publishedAt.toISOString(),
    })),
    posts: posts.map((post) => {
      const profileUrl = `https://x.com/${post.authorUsername}`;
      const permalink = `${profileUrl}/status/${post.postId}`;

      return {
        authorName: post.authorName,
        authorUsername: post.authorUsername,
        authorImageUrl: post.authorImageUrl,
        profileUrl,
        permalink,
        historyUrl: post.isEdited ? `${permalink}/history` : null,
        parts: post.parts,
        date: hawaiiDateTime.format(post.postedAt),
        dateTime: post.postedAt.toISOString(),
      };
    }),
  });
};

// POST /recent-stops/clear: the "Clear recent stops" button on the Home tab
exports.postClearRecentStops = async (req, res) => {
  clearRecentStops(res);
  res.redirect(303, '/');
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
