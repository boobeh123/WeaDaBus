const mongoose = require('mongoose');

// News releases from the Hawaiʻi Department of Transportation, saved by scripts/fetchNews.js
// from HDOT's RSS feed. Only the newest few are kept; each run of the job replaces them.
const NewsArticleSchema = new mongoose.Schema(
  {
    // The feed's permanent ID for the post, e.g. 'https://hidot.hawaii.gov/?p=19643'
    guid: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    url: { type: String, required: true }, // Always on https://hidot.hawaii.gov/
    excerpt: { type: String, default: '' }, // The feed's short summary, as plain text
    publishedAt: { type: Date, required: true },
  },
  { timestamps: true } // updatedAt shows when the job last saw the article
);

module.exports = mongoose.model('NewsArticle', NewsArticleSchema);
