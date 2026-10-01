const mongoose = require('mongoose');

// One run of a post's text: plain text, or a link to X (an @mention, a #hashtag, or a web link)
const PostPartSchema = new mongoose.Schema(
  {
    text: { type: String, required: true },
    href: { type: String, default: '' }, // Empty for plain text
  },
  { _id: false }
);

// @DOTHawaii's newest posts on X, saved by scripts/fetchNews.js from the X API. Only the newest
// few are kept; each run replaces them, so a post deleted on X leaves the page within 15 minutes.
const XPostSchema = new mongoose.Schema(
  {
    postId: { type: String, required: true, unique: true }, // Kept as text: too big for a JS number
    text: { type: String, required: true }, // Exactly as posted
    parts: { type: [PostPartSchema], default: [] }, // The same text, split into runs for display
    postedAt: { type: Date, required: true },
    isEdited: { type: Boolean, default: false },
    authorName: { type: String, required: true },
    authorUsername: { type: String, required: true },
    authorImageUrl: { type: String, default: '' }, // Always on https://pbs.twimg.com/
  },
  { timestamps: true } // updatedAt shows when the job last saw the post
);

module.exports = mongoose.model('XPost', XPostSchema);
