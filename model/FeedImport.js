const mongoose = require('mongoose');

// The GTFS schedule now in MongoDB, saved by scripts/importGtfs.js after each import. The next
// run sends etag and lastModified back to TheBus, which answers "not modified" when the
// schedule file hasn't changed, so most daily runs end without downloading anything.
const FeedImportSchema = new mongoose.Schema({
  url: { type: String, required: true, unique: true }, // The schedule file's address
  etag: { type: String, default: '' }, // The file's version tag, e.g. '"65281982c01bdd1:0"'
  lastModified: { type: String, default: '' }, // As TheBus sends it: 'Fri, 24 Jul 2026 23:02:32 GMT'
  feedVersion: { type: String, default: '' }, // From feed_info.txt
  startDate: { type: String, default: '' }, // '2026-08-09'
  endDate: { type: String, default: '' }, // '2026-12-05'
  importedAt: { type: Date, required: true },
});

module.exports = mongoose.model('FeedImport', FeedImportSchema);
