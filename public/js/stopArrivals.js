// Keeps the stop page's arrivals current without reloading the page.
// The server renders the first view, so this only takes over for refreshes.
// Card rendering and polling come from arrivals.js, which loads first.

/**************************************************************
DOM selectors
***************************************************************/
const stopSection = document.querySelector('.stopArrivals');
const nextBusLabel = document.querySelector('.nextBusLabel');
const arrivalList = document.querySelector('.arrivalList');
const arrivalTemplate = document.querySelector('.arrivalTemplate');
const emptyMessage = document.querySelector('.emptyMessage');
const unavailableMessage = document.querySelector('.unavailableMessage');
const updatedTime = document.querySelector('.updatedTime');
const refreshButton = document.querySelector('.refreshButton');
const statusAnnouncer = document.querySelector('.statusAnnouncer');

let lastUpdatedAt = updatedTime.dataset.updatedAt;
// Tell screen reader users the result only for refreshes they asked for,
// so the automatic once-a-minute refresh doesn't interrupt them
let shouldAnnounce = false;

/**************************************************************
Helpers
***************************************************************/
function renderArrivals(stop) {
  const hasArrivals = renderArrivalList(arrivalList, arrivalTemplate, stop.arrivals, nextBusLabel);
  emptyMessage.hidden = hasArrivals;
  unavailableMessage.hidden = true;

  lastUpdatedAt = stop.updatedAt;
  updatedTime.textContent = `Updated ${stop.updatedAt}`;
  if (shouldAnnounce) statusAnnouncer.textContent = `Arrivals updated at ${stop.updatedAt}.`;
  shouldAnnounce = false;
}

function showRefreshFailed() {
  // Keep the last arrivals on screen, but say how old they are
  updatedTime.textContent = lastUpdatedAt
    ? `Couldn't update. Times are from ${lastUpdatedAt}.`
    : "Couldn't reach TheBus.";
  if (shouldAnnounce) statusAnnouncer.textContent = "Couldn't reach TheBus. Try again in a minute.";
  shouldAnnounce = false;
}

function setRefreshing(refreshing) {
  refreshButton.setAttribute('aria-disabled', String(refreshing));
  refreshButton.textContent = refreshing ? 'Refreshing…' : 'Refresh';
}

/**************************************************************
Main logic
***************************************************************/
const arrivalsPoller = createArrivalsPoller({
  stopId: stopSection.dataset.stopId,
  onUpdate: renderArrivals,
  onError: showRefreshFailed,
});

async function handleRefreshClick(event) {
  // Without JS the link reloads the page. With JS, refresh in place instead.
  event.preventDefault();
  shouldAnnounce = true;
  setRefreshing(true);
  await arrivalsPoller.refresh();
  setRefreshing(false);
}

function handleVisibilityChange() {
  if (document.hidden) {
    arrivalsPoller.pause();
  } else {
    arrivalsPoller.refresh();
  }
}

/**************************************************************
Event listeners
***************************************************************/
refreshButton.addEventListener('click', handleRefreshClick);
document.addEventListener('visibilitychange', handleVisibilityChange);

arrivalsPoller.start();
