// Keeps the stop page's arrivals current without reloading the page.
// The server renders the first view, so this only takes over for refreshes.

/**************************************************************
DOM selectors
***************************************************************/
const stopSection = document.querySelector('.stopArrivals');
const arrivalList = document.querySelector('.arrivalList');
const arrivalTemplate = document.querySelector('.arrivalTemplate');
const emptyMessage = document.querySelector('.emptyMessage');
const unavailableMessage = document.querySelector('.unavailableMessage');
const updatedTime = document.querySelector('.updatedTime');
const refreshButton = document.querySelector('.refreshButton');
const statusAnnouncer = document.querySelector('.statusAnnouncer');

const stopId = stopSection.dataset.stopId;
const REFRESH_INTERVAL_MS = 60 * 1000; // TheBus updates about once a minute

let lastUpdatedAt = updatedTime.dataset.updatedAt;
let refreshTimer = null;
let isRefreshing = false;

/**************************************************************
Helpers
***************************************************************/
// Fills a copy of the card rendered by views/partials/arrivalCard.ejs
function buildArrivalCard(arrival) {
  const card = arrivalTemplate.content.firstElementChild.cloneNode(true);
  const isNow = arrival.minutesAway <= 0;

  card.dataset.status = arrival.status;
  card.querySelector('.routeName').textContent = arrival.route;
  card.querySelector('.arrivalHeadsign').textContent = arrival.headsign;
  card.querySelector('.arrivalStatus').textContent = arrival.statusLabel;
  card.querySelector('.arrivalTime').textContent = arrival.time;
  card.querySelector('.arrivalDirection').textContent = arrival.direction;
  card.querySelector('.minutesValue').textContent = isNow ? 'Now' : arrival.minutesAway;
  card.querySelector('.minutesUnit').hidden = isNow;

  return card;
}

function renderArrivals(stop) {
  const hasArrivals = stop.arrivals.length > 0;

  arrivalList.replaceChildren(...stop.arrivals.map(buildArrivalCard));
  arrivalList.hidden = !hasArrivals;
  emptyMessage.hidden = hasArrivals;
  unavailableMessage.hidden = true;

  lastUpdatedAt = stop.updatedAt;
  updatedTime.textContent = `Updated ${stop.updatedAt}`;
}

function showRefreshFailed() {
  // Keep the last arrivals on screen, but say how old they are
  updatedTime.textContent = lastUpdatedAt
    ? `Couldn't update. Times are from ${lastUpdatedAt}.`
    : "Couldn't reach TheBus.";
}

function setRefreshing(refreshing) {
  isRefreshing = refreshing;
  refreshButton.setAttribute('aria-disabled', String(refreshing));
  refreshButton.textContent = refreshing ? 'Refreshing…' : 'Refresh';
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshArrivals, REFRESH_INTERVAL_MS);
}

/**************************************************************
Main logic
***************************************************************/
// announce: tell screen reader users the result. Only for refreshes they asked for,
// so the automatic once-a-minute refresh doesn't interrupt them.
async function refreshArrivals({ announce = false } = {}) {
  if (isRefreshing) return;
  setRefreshing(true);

  try {
    const res = await fetch(`/api/stops/${encodeURIComponent(stopId)}/arrivals`);
    if (!res.ok) throw new Error(`Arrivals request failed with HTTP ${res.status}`);

    const stop = await res.json();
    renderArrivals(stop);
    if (announce) statusAnnouncer.textContent = `Arrivals updated at ${stop.updatedAt}.`;
  } catch (err) {
    console.error(err);
    showRefreshFailed();
    if (announce) statusAnnouncer.textContent = "Couldn't reach TheBus. Try again in a minute.";
  } finally {
    setRefreshing(false);
    // Hidden tabs don't poll; handleVisibilityChange refreshes when the page comes back
    if (!document.hidden) scheduleRefresh();
  }
}

function handleRefreshClick(event) {
  // Without JS the link reloads the page. With JS, refresh in place instead.
  event.preventDefault();
  refreshArrivals({ announce: true });
}

function handleVisibilityChange() {
  if (document.hidden) {
    clearTimeout(refreshTimer);
  } else {
    refreshArrivals();
  }
}

/**************************************************************
Event listeners
***************************************************************/
refreshButton.addEventListener('click', handleRefreshClick);
document.addEventListener('visibilitychange', handleVisibilityChange);

scheduleRefresh();
