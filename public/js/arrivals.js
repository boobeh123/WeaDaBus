// Shared arrival helpers for the stop page (stopArrivals.js) and the map's stop sheet
// (mapView.js). Loaded as a deferred script before them, so these functions are globals.

/**************************************************************
Helpers
***************************************************************/
const ARRIVALS_REFRESH_MS = 60 * 1000; // TheBus updates about once a minute

// Fills a copy of the card rendered by views/partials/arrivalCard.ejs
function buildArrivalCard(template, arrival) {
  const card = template.content.firstElementChild.cloneNode(true);
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

// Replaces the cards in a list and hides it when empty. Returns whether there were any.
function renderArrivalList(list, template, arrivals) {
  list.replaceChildren(...arrivals.map((arrival) => buildArrivalCard(template, arrival)));
  list.hidden = arrivals.length === 0;
  return arrivals.length > 0;
}

async function fetchStopArrivals(stopId) {
  const res = await fetch(`/api/stops/${encodeURIComponent(stopId)}/arrivals`);
  if (!res.ok) throw new Error(`Arrivals request failed with HTTP ${res.status}`);
  return res.json();
}

/**************************************************************
Main logic
***************************************************************/
// Refreshes one stop's arrivals once a minute and hands each result to onUpdate or onError.
// The page decides when to pause (hidden tab) and when to stop (leaving the stop).
function createArrivalsPoller({ stopId, onUpdate, onError }) {
  let timer = null;
  let isRunning = false;
  let isRefreshing = false;

  function scheduleNext() {
    clearTimeout(timer);
    if (isRunning && !document.hidden) timer = setTimeout(refresh, ARRIVALS_REFRESH_MS);
  }

  async function refresh() {
    if (isRefreshing) return;
    isRefreshing = true;
    clearTimeout(timer);

    try {
      const stop = await fetchStopArrivals(stopId);
      if (isRunning) onUpdate(stop); // An answer can arrive after stop(); ignore it
    } catch (err) {
      console.error(err);
      if (isRunning) onError(err);
    } finally {
      isRefreshing = false;
      scheduleNext();
    }
  }

  return {
    // Starts the once-a-minute cycle. Call refresh() too if nothing is on screen yet.
    start() {
      isRunning = true;
      scheduleNext();
    },
    refresh,
    // Hidden tabs don't poll; call refresh() when the page is visible again
    pause() {
      clearTimeout(timer);
    },
    stop() {
      isRunning = false;
      clearTimeout(timer);
    },
  };
}
