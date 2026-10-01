// Saves the latest transportation news for the home page: the Hawaiʻi Department of
// Transportation's news releases, read from HDOT's RSS feed. Railway runs it as a cron job
// (`npm run fetch:news`, every 15 minutes). Each source is downloaded and checked before the
// database is touched, so a failed run leaves the last good news on the page.
require('dotenv').config();

const mongoose = require('mongoose');
const { XMLParser } = require('fast-xml-parser');
const connectDB = require('../config/database');
const NewsArticle = require('../model/NewsArticle');

// HDOT's News category: the same list as the "What's New" sidebar on hidot.hawaii.gov
const HDOT_FEED_URL = 'https://hidot.hawaii.gov/blog/category/news/feed/';
const HDOT_SITE = 'https://hidot.hawaii.gov/';
const HDOT_LIMIT = 5;
const REQUEST_TIMEOUT_MS = 15 * 1000;
const USER_AGENT = 'WeaDaBus/1.0 (+https://weadabus.com)';

// Entities written as names instead of numbers, like &amp;
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

const feedParser = new XMLParser({
  htmlEntities: true, // Titles can contain entities like &#8217;
  parseTagValue: false, // Keep every value as text, so a title like "2026" isn't turned into a number
  isArray: (name, jpath) => jpath === 'rss.channel.item', // An array even when the feed has one item
});

/**************************************************************
Helpers
***************************************************************/
// A feed field as trimmed text, or '' when it's missing or isn't plain text
function textOf(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// The feed's excerpts sit in CDATA, which the XML parser leaves as-is, so entities like
// &#160; and &#8230; are still encoded. This turns them into the characters they stand for.
function decodeEntities(text) {
  // Matches &#8230; (decimal), &#x2026; (hex), and &amp; (named)
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (entity, code) => {
    if (!code.startsWith('#')) return NAMED_ENTITIES[code.toLowerCase()] ?? entity;

    const isHex = code[1].toLowerCase() === 'x';
    const codePoint = isHex ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
  });
}

// Drops any HTML tags, decodes entities, and collapses runs of spaces and line breaks
function toPlainText(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

// WordPress ends each excerpt with "[…]"; a plain ellipsis reads better
function toExcerpt(html) {
  const text = toPlainText(html);
  return text.endsWith('[…]') ? `${text.slice(0, -3).trimEnd()}…` : text;
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  return res.text();
}

/**************************************************************
HDOT news
***************************************************************/
// Turns the feed into articles, newest first. Each needs a title, a real date, and a link on
// HDOT's own site, so the page never shows an off-site or javascript: link from the feed.
function parseHdotFeed(xml) {
  const items = feedParser.parse(xml)?.rss?.channel?.item ?? [];

  return items
    .map((item) => ({
      guid: textOf(item.guid) || textOf(item.link),
      title: toPlainText(textOf(item.title)),
      url: textOf(item.link),
      excerpt: toExcerpt(textOf(item.description)),
      publishedAt: new Date(textOf(item.pubDate)),
    }))
    .filter(
      (article) =>
        article.guid &&
        article.title &&
        article.url.startsWith(HDOT_SITE) &&
        !Number.isNaN(article.publishedAt.getTime())
    )
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, HDOT_LIMIT);
}

// Saves the newest articles, then removes the rest. Saving first means the home page never
// sees an empty list, and a broken feed throws before anything is changed.
async function syncHdotNews() {
  const articles = parseHdotFeed(await fetchText(HDOT_FEED_URL));
  if (!articles.length) throw new Error('The HDOT feed had no usable articles');

  await NewsArticle.bulkWrite(
    articles.map((article) => ({
      updateOne: { filter: { guid: article.guid }, update: { $set: article }, upsert: true },
    }))
  );
  // sanitizeFilter (config/database.js) would neutralize $nin unless it's marked as trusted
  await NewsArticle.deleteMany({ guid: mongoose.trusted({ $nin: articles.map((article) => article.guid) }) });

  return articles.length;
}

/**************************************************************
Main
***************************************************************/
// Each source runs on its own, so one failing doesn't stop the others
const SOURCES = [{ name: 'HDOT news', sync: syncHdotNews }];

async function fetchNews() {
  if (!process.env.DB_STRING) {
    throw new Error('DB_STRING is not set. Add it to .env locally or to this service in Railway.');
  }
  await connectDB();

  let hasFailure = false;
  for (const source of SOURCES) {
    try {
      const count = await source.sync();
      console.log(`${source.name}: ${count} saved`);
    } catch (err) {
      hasFailure = true;
      console.error(`${source.name} failed:`, err);
    }
  }

  // Railway skips the next run while this one is still going, so close the connection and exit
  await mongoose.disconnect();
  if (hasFailure) process.exitCode = 1; // Marks the run as failed in Railway's logs
}

fetchNews().catch(async (err) => {
  console.error('News job failed:', err);
  await mongoose.disconnect();
  process.exit(1);
});
