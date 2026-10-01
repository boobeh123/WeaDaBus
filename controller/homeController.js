const NewsArticle = require('../model/NewsArticle');
const XPost = require('../model/XPost');

const NEWS_LIMIT = 5;
const POSTS_LIMIT = 5;

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

// GET /: the Home tab, the latest news from the Hawaiʻi Department of Transportation and its
// posts on X. scripts/fetchNews.js saves both on a schedule, so this page only reads MongoDB.
exports.getHome = async (req, res) => {
  const [articles, posts] = await Promise.all([
    NewsArticle.find().sort({ publishedAt: -1 }).limit(NEWS_LIMIT).lean(),
    XPost.find().sort({ postedAt: -1 }).limit(POSTS_LIMIT).lean(),
  ]);

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
