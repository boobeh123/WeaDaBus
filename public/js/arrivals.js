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

// The first bus that isn't canceled goes first, under the "Next bus" label; the rest keep time order.
// services/theBus.js orders the same way, but a route page's filtering can undo it.
function putNextBusFirst(arrivals) {
  const nextIndex = arrivals.findIndex((arrival) => arrival.status !== 'canceled');
  if (nextIndex <= 0) return arrivals;
  return [arrivals[nextIndex], ...arrivals.filter((arrival, index) => index !== nextIndex)];
}

// Replaces the cards in a list and hides it when empty. Shows the "Next bus arriving to this stop:"
// label only when some bus is actually coming. Returns whether there were any cards.
function renderArrivalList(list, template, arrivals, nextBusLabel) {
  list.replaceChildren(...putNextBusFirst(arrivals).map((arrival) => buildArrivalCard(template, arrival)));
  list.hidden = arrivals.length === 0;
  nextBusLabel.hidden = !arrivals.some((arrival) => arrival.status !== 'canceled');
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
