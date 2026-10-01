// Recent stops: the last few stops a rider opened, kept in a cookie on their own device, so the
// Home tab can list them with their next bus in the first page load, with no account needed.
// Anyone can edit their own cookies, so only real stop numbers are read back.
const COOKIE_NAME = 'recentStops';
const MAX_STOPS = 3;
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const COOKIE_OPTIONS = {
  httpOnly: true, // Only the server reads it
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production', // HTTPS only on Railway; local dev runs on plain HTTP
};

// The stop numbers in the cookie, newest first: "4523.983" -> [4523, 983]. Express doesn't read
// cookies on its own, so this finds the one it needs in the Cookie header.
function getRecentStops(req) {
  const cookie = (req.headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`));
  if (!cookie) return [];

  const stopIds = cookie
    .slice(COOKIE_NAME.length + 1)
    .split('.')
    .filter((value) => /^\d{1,5}$/.test(value)) // 1 to 5 digits, like the stop number validator
    .map(Number)
    .filter((stopId) => stopId >= 1);

  return [...new Set(stopIds)].slice(0, MAX_STOPS);
}

// Puts a stop at the front of the list. When it's already first, the cookie isn't sent again,
// so a stop page's refresh every 60 seconds doesn't rewrite it each time.
function rememberStop(req, res, stopId) {
  const stopIds = getRecentStops(req);
  if (stopIds[0] === stopId) return;

  const updated = [stopId, ...stopIds.filter((id) => id !== stopId)].slice(0, MAX_STOPS);
  res.cookie(COOKIE_NAME, updated.join('.'), { ...COOKIE_OPTIONS, maxAge: ONE_YEAR_MS });
}

function clearRecentStops(res) {
  res.clearCookie(COOKIE_NAME, COOKIE_OPTIONS);
}

module.exports = { getRecentStops, rememberStop, clearRecentStops };
