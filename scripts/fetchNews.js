// Saves the latest transportation news for the home page: the Hawaiʻi Department of
// Transportation's news releases, read from HDOT's RSS feed, and its posts on X, read from the
// X API. Railway runs it as a cron job (`npm run fetch:news`, every 15 minutes). Each source is
// downloaded and checked before the database is touched, so a failed run leaves the last good
// news on the page.
require('dotenv').config();

const mongoose = require('mongoose');
const { XMLParser } = require('fast-xml-parser');
const connectDB = require('../config/database');
const NewsArticle = require('../model/NewsArticle');
const XPost = require('../model/XPost');

// HDOT's News category: the same list as the "What's New" sidebar on hidot.hawaii.gov
const HDOT_FEED_URL = 'https://hidot.hawaii.gov/blog/category/news/feed/';
const HDOT_SITE = 'https://hidot.hawaii.gov/';
const HDOT_LIMIT = 5;

// @DOTHawaii on X. Its account ID never changes, while its handle could, so posts are fetched by ID.
const X_API_URL = 'https://api.x.com/2';
const DOT_HAWAII_USER_ID = '382386622';
const X_LIMIT = 5; // Also the smallest page the API allows

const REQUEST_TIMEOUT_MS = 15 * 1000;
const USER_AGENT = 'WeaDaBus/1.0 (+https://weadabus.com)';

// Entities written as names instead of numbers, like &amp;
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

// X usernames: 1 to 15 letters, digits, or underscores
const X_USERNAME = /^\w{1,15}$/;
// One character that can be part of an @mention or #hashtag: a letter, digit, or underscore
const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

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
X posts
***************************************************************/
// Whether a link's text starts at this spot in the post. Mentions and hashtags must stand
// alone, so #hitraffic doesn't match the start of #hitrafficalert.
function isLinkAt(text, index, link) {
  const candidate = text.slice(index, index + link.match.length);
  if (candidate.toLowerCase() !== link.match.toLowerCase()) return false;
  if (!link.isWord) return true;

  const before = text[index - 1] ?? '';
  const after = text[index + link.match.length] ?? '';
  return !WORD_CHARACTER.test(before) && !WORD_CHARACTER.test(after);
}

// X's display rules require each @mention, #hashtag, and web link in a post to link to its home
// on X, with web links shown as their short display_url (like pic.x.com/abc). This splits the
// text into plain runs and those links. It finds them by their text, not by X's character
// offsets, which count differently from JavaScript strings once emoji are involved.
function toPostParts(text, entities = {}) {
  const links = [
    ...(entities.urls ?? [])
      .filter((entity) => textOf(entity.url).startsWith('https://t.co/') && textOf(entity.display_url))
      .map((entity) => ({ match: entity.url, text: entity.display_url, href: entity.url })),
    ...(entities.mentions ?? [])
      .filter((entity) => X_USERNAME.test(textOf(entity.username)))
      .map((entity) => ({ match: `@${entity.username}`, href: `https://x.com/${entity.username}`, isWord: true })),
    ...(entities.hashtags ?? [])
      .filter((entity) => textOf(entity.tag))
      .map((entity) => ({ match: `#${entity.tag}`, href: `https://x.com/hashtag/${encodeURIComponent(entity.tag)}`, isWord: true })),
  ].sort((a, b) => b.match.length - a.match.length); // Longest first, so @abc_2 wins over @abc

  const parts = [];
  let plain = '';
  let index = 0;

  while (index < text.length) {
    const link = links.find((candidate) => isLinkAt(text, index, candidate));
    if (link) {
      if (plain) parts.push({ text: plain });
      plain = '';
      // Mentions and hashtags keep the capitalization used in the post
      parts.push({ text: link.text ?? text.slice(index, index + link.match.length), href: link.href });
      index += link.match.length;
    } else {
      plain += text[index];
      index += 1;
    }
  }
  if (plain) parts.push({ text: plain });

  return parts;
}

async function fetchXPosts() {
  if (!process.env.X_BEARER_TOKEN) {
    throw new Error('X_BEARER_TOKEN is not set. Add it to .env locally or to this service in Railway.');
  }

  const params = new URLSearchParams({
    max_results: String(X_LIMIT),
    exclude: 'replies,retweets', // HDOT's own posts only
    'tweet.fields': 'created_at,entities,note_tweet,edit_history_tweet_ids',
    expansions: 'author_id', // Adds the name, @username, and picture each card must show
    'user.fields': 'name,username,profile_image_url',
  });
  const res = await fetch(`${X_API_URL}/users/${DOT_HAWAII_USER_ID}/tweets?${params}`, {
    headers: { Authorization: `Bearer ${process.env.X_BEARER_TOKEN}`, 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));

  // X explains failures (a bad token, no credits left) in title and detail. The error message
  // never includes the request, so the token can't end up in the logs.
  if (!res.ok) {
    const reason = [...new Set([body.title, body.detail].filter(Boolean))].join(': ') || 'no details';
    throw new Error(`X API returned HTTP ${res.status}: ${reason}`);
  }
  return body;
}

// Turns the API's answer into posts, newest first, keeping only complete ones from @DOTHawaii
function parseXPosts(body) {
  const author = (body.includes?.users ?? []).find((user) => user.id === DOT_HAWAII_USER_ID);
  const authorUsername = textOf(author?.username);
  if (!author || !X_USERNAME.test(authorUsername)) return [];

  // _normal is 48 px; _bigger (73 px) stays sharp on high-density phone screens
  const imageUrl = textOf(author.profile_image_url).replace('_normal.', '_bigger.');

  return (body.data ?? [])
    .map((post) => {
      // Posts over 280 characters come back cut short, with the full version in note_tweet.
      // The API escapes &, <, and > in the text, so decode them back.
      const full = post.note_tweet ?? post;
      const text = decodeEntities(textOf(full.text));

      return {
        postId: textOf(post.id),
        text,
        parts: toPostParts(text, full.entities),
        postedAt: new Date(textOf(post.created_at)),
        isEdited: (post.edit_history_tweet_ids ?? []).length > 1,
        authorName: textOf(author.name) || authorUsername,
        authorUsername,
        authorImageUrl: imageUrl.startsWith('https://pbs.twimg.com/') ? imageUrl : '',
      };
    })
    .filter((post) => /^\d{1,19}$/.test(post.postId) && post.text && !Number.isNaN(post.postedAt.getTime()))
    .sort((a, b) => b.postedAt - a.postedAt)
    .slice(0, X_LIMIT);
}

// Saves the newest posts, then removes the rest, including any HDOT deleted or edited on X
// (an edit gets a new ID). X's developer terms require deleted posts to come down.
async function syncXPosts() {
  const posts = parseXPosts(await fetchXPosts());
  if (!posts.length) throw new Error('The X API returned no usable posts');

  await XPost.bulkWrite(
    posts.map((post) => ({
      updateOne: { filter: { postId: post.postId }, update: { $set: post }, upsert: true },
    }))
  );
  await XPost.deleteMany({ postId: mongoose.trusted({ $nin: posts.map((post) => post.postId) }) });

  return posts.length;
}

/**************************************************************
Main
***************************************************************/
// Each source runs on its own, so one failing doesn't stop the others
const SOURCES = [
  { name: 'HDOT news', sync: syncHdotNews },
  { name: 'X posts', sync: syncXPosts },
];

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
