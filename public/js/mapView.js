// The Nearby tab: a map of Oʻahu with stop pins for the visible area, "Show stops near me",
// and a sheet with live arrivals for the chosen stop.
// Leaflet (the global L) and arrivals.js load before this file.

/**************************************************************
DOM selectors
***************************************************************/
const mapElement = document.querySelector('.map');
const zoomHint = document.querySelector('.zoomHint');
const mapMessage = document.querySelector('.mapMessage');
const locateButton = document.querySelector('.locateButton');
const locateLabel = document.querySelector('.locateLabel');
const mapSheet = document.querySelector('.mapSheet');
const sheetBody = document.querySelector('.sheetBody');
const sheetBack = document.querySelector('.sheetBack');
const sheetClose = document.querySelector('.sheetClose');
const sheetEyebrow = document.querySelector('.sheetEyebrow');
const sheetTitle = document.querySelector('.sheetTitle');
const sheetNearby = document.querySelector('.sheetNearby');
const nearbyList = document.querySelector('.nearbyList');
const nearbyEmpty = document.querySelector('.nearbyEmpty');
const nearbyTemplate = document.querySelector('.nearbyTemplate');
const sheetStop = document.querySelector('.sheetStop');
const sheetRoutes = document.querySelector('.sheetRoutes');
const sheetUpdated = document.querySelector('.sheetUpdated');
const arrivalList = document.querySelector('.arrivalList');
const arrivalTemplate = document.querySelector('.arrivalTemplate');
const emptyMessage = document.querySelector('.emptyMessage');
const unavailableMessage = document.querySelector('.unavailableMessage');
const sheetStopLink = document.querySelector('.sheetStopLink');

/**************************************************************
Settings and state
***************************************************************/
// [south, west] and [north, east] corners. The map opens on the island and can't pan far past it.
const OAHU_BOUNDS = [[21.24, -158.3], [21.73, -157.64]];
const PAN_LIMIT_BOUNDS = [[21.1, -158.5], [21.85, -157.45]];
const STOP_PIN_MIN_ZOOM = 16; // Below street level, pins would overlap and bog down phones
const NEARBY_ZOOM = 17;
const PIN_SIZE = 32; // Tap area in pixels. The visible dot is smaller (styles.css).
const FEET_PER_METER = 3.28084;
const FEET_PER_MILE = 5280;

const pinsByStopId = new Map();
let stopsRequest = null; // Aborted when the map moves again before the answer arrives
let arrivalsPoller = null;
let nearbyStops = [];
let selectedStopId = null;
let youAreHere = null;
let lastFocus = null; // Where focus returns when the sheet closes

/**************************************************************
Helpers
***************************************************************/
// Hawaii riders think in feet and miles
function formatDistance(meters) {
  const feet = meters * FEET_PER_METER;
  if (feet < 1000) return `${Math.max(50, Math.round(feet / 50) * 50)} ft`;
  return `${(feet / FEET_PER_MILE).toFixed(1)} mi`;
}

function isOnOahu(lat, lon) {
  const [[south, west], [north, east]] = PAN_LIMIT_BOUNDS;
  return lat >= south && lat <= north && lon >= west && lon <= east;
}

// The message is a live region that stays in the page (invisible while empty),
// so screen readers announce each new message
function showMapMessage(text) {
  mapMessage.textContent = text;
}

function setLocating(locating) {
  locateButton.setAttribute('aria-disabled', String(locating));
  locateLabel.textContent = locating ? 'Finding you…' : 'Show stops near me';
}

// Pins are Leaflet markers so they can take keyboard focus. The stop rides along as an option.
function buildStopPin(stop) {
  return L.marker([stop.lat, stop.lon], {
    icon: L.divIcon({
      className: stop.isRailStation ? 'stopPin railPin' : 'stopPin',
      iconSize: [PIN_SIZE, PIN_SIZE],
    }),
    title: `Stop ${stop.stopId}: ${stop.name}`,
    keyboard: true,
    riseOnHover: true,
    stop,
  });
}

function markSelectedPin() {
  pinsByStopId.forEach((pin, stopId) => {
    pin.getElement()?.classList.toggle('isSelected', stopId === selectedStopId);
  });
}

// Adds pins that came into view and removes ones that left, so pins don't flicker while panning
function showStops(stops) {
  const idsInView = new Set(stops.map((stop) => stop.stopId));

  pinsByStopId.forEach((pin, stopId) => {
    if (!idsInView.has(stopId) && stopId !== selectedStopId) {
      stopPins.removeLayer(pin);
      pinsByStopId.delete(stopId);
    }
  });

  stops
    .filter((stop) => !pinsByStopId.has(stop.stopId))
    .forEach((stop) => {
      const pin = buildStopPin(stop);
      pinsByStopId.set(stop.stopId, pin);
      stopPins.addLayer(pin);
    });

  markSelectedPin();
}

function clearStops() {
  stopPins.clearLayers();
  pinsByStopId.clear();
}

function showYouAreHere(lat, lon) {
  if (youAreHere) {
    youAreHere.setLatLng([lat, lon]);
    return;
  }
  youAreHere = L.marker([lat, lon], {
    icon: L.divIcon({ className: 'youAreHere', iconSize: [20, 20] }),
    interactive: false,
    keyboard: false,
    zIndexOffset: 1000,
  }).addTo(map);
}

function buildNearbyItem(stop) {
  const item = nearbyTemplate.content.firstElementChild.cloneNode(true);
  item.querySelector('.nearbyStop').dataset.stopId = stop.stopId;
  item.querySelector('.nearbyName').textContent = stop.name;
  item.querySelector('.nearbyMeta').textContent =
    `${formatDistance(stop.distanceMeters)} · Stop ${stop.stopId} · ${stop.routes.join(', ')}`;
  return item;
}

function renderNearbyList(stops) {
  nearbyList.replaceChildren(...stops.map(buildNearbyItem));
  nearbyList.hidden = stops.length === 0;
  nearbyEmpty.hidden = stops.length > 0;
}

function renderSheetArrivals(stop) {
  const hasArrivals = renderArrivalList(arrivalList, arrivalTemplate, stop.arrivals);
  emptyMessage.hidden = hasArrivals;
  unavailableMessage.hidden = true;
  sheetUpdated.textContent = `Updated ${stop.updatedAt}`;
}

function showSheetArrivalsError() {
  // Keep any cards already showing; the poller tries again in a minute
  const hasCards = arrivalList.children.length > 0;
  unavailableMessage.hidden = hasCards;
  sheetUpdated.textContent = hasCards ? "Couldn't update. Trying again in a minute." : '';
}

function stopArrivalsPolling() {
  arrivalsPoller?.stop();
  arrivalsPoller = null;
}

function startArrivalsPolling(stopId) {
  stopArrivalsPolling();
  arrivalsPoller = createArrivalsPoller({
    stopId,
    onUpdate: renderSheetArrivals,
    onError: showSheetArrivalsError,
  });
  arrivalsPoller.start();
  arrivalsPoller.refresh();
}

// Pans just enough that the stop isn't hidden behind the sheet (below it on phones, beside it on desktop)
function keepStopVisible(stop) {
  const sheetBox = mapSheet.getBoundingClientRect();
  const mapBox = mapElement.getBoundingClientRect();
  const isSidePanel = sheetBox.height >= mapBox.height * 0.9;
  const margin = 24;

  map.panInside([stop.lat, stop.lon], {
    paddingTopLeft: [isSidePanel ? sheetBox.width + margin : margin, margin],
    paddingBottomRight: [margin, isSidePanel ? margin : mapBox.bottom - sheetBox.top + margin],
  });
}

async function fetchNearbyStops(lat, lon) {
  const params = new URLSearchParams({ lat: lat.toFixed(6), lon: lon.toFixed(6) });
  const res = await fetch(`/api/stops/nearby?${params}`);
  if (!res.ok) throw new Error(`Nearby stops request failed with HTTP ${res.status}`);
  const { stops } = await res.json();
  return stops;
}

/**************************************************************
Map setup
***************************************************************/
const map = L.map(mapElement, {
  maxBounds: PAN_LIMIT_BOUNDS,
  maxBoundsViscosity: 1,
  minZoom: 9,
  zoomSnap: 0.25, // Lets the opening view fit Oʻahu snugly on any screen size
  zoomControl: false,
});

L.control.zoom({ position: 'topright' }).addTo(map);

L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  // OpenStreetMap's tile policy blocks browser requests with no Referer, and helmet's
  // Referrer-Policy (no-referrer) strips it site-wide. Tiles alone send our origin only,
  // never the page path, so nothing else about the rider is shared.
  referrerPolicy: 'strict-origin-when-cross-origin',
}).addTo(map);
map.attributionControl.addAttribution(
  'Route and arrival data provided by permission of Oahu Transit Services, Inc'
);

const stopPins = L.featureGroup().addTo(map);
map.fitBounds(OAHU_BOUNDS);

/**************************************************************
Main logic
***************************************************************/
async function loadStopsInView() {
  const isZoomedIn = map.getZoom() >= STOP_PIN_MIN_ZOOM;
  zoomHint.hidden = isZoomedIn;
  stopsRequest?.abort();

  if (!isZoomedIn) {
    clearStops();
    return;
  }

  // Ask for a little more than the visible area so short pans already have pins
  const area = map.getBounds().pad(0.2);
  const params = new URLSearchParams({
    west: area.getWest().toFixed(5),
    south: area.getSouth().toFixed(5),
    east: area.getEast().toFixed(5),
    north: area.getNorth().toFixed(5),
  });
  stopsRequest = new AbortController();

  try {
    const res = await fetch(`/api/stops?${params}`, { signal: stopsRequest.signal });
    if (!res.ok) throw new Error(`Stops request failed with HTTP ${res.status}`);
    const { stops } = await res.json();
    showStops(stops);
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error(err);
    showMapMessage("Couldn't load bus stops. Move the map to try again.");
  }
}

function openSheet(view) {
  if (mapSheet.hidden) lastFocus = document.activeElement;

  mapSheet.hidden = false;
  sheetNearby.hidden = view !== 'nearby';
  sheetStop.hidden = view !== 'stop';
  locateButton.hidden = true;
  sheetBody.scrollTop = 0;
  sheetTitle.focus();
}

function closeSheet() {
  stopArrivalsPolling();
  selectedStopId = null;
  markSelectedPin();

  mapSheet.hidden = true;
  locateButton.hidden = false;

  const canRefocus = lastFocus && lastFocus !== document.body && document.contains(lastFocus);
  (canRefocus ? lastFocus : locateButton).focus();
  lastFocus = null;
}

function openStop(stop, { fromNearby = false } = {}) {
  selectedStopId = stop.stopId;
  markSelectedPin();

  sheetBack.hidden = !fromNearby;
  sheetEyebrow.textContent = `Stop ${stop.stopId}`;
  sheetTitle.textContent = stop.name;
  sheetRoutes.textContent = `Routes: ${stop.routes.join(', ')}`;
  sheetStopLink.href = `/stops/${stop.stopId}`;
  sheetUpdated.textContent = 'Loading arrivals…';
  arrivalList.replaceChildren();
  arrivalList.hidden = true;
  emptyMessage.hidden = true;
  unavailableMessage.hidden = true;

  openSheet('stop');
  keepStopVisible(stop);
  startArrivalsPolling(stop.stopId);
}

function showNearbySheet() {
  stopArrivalsPolling();
  selectedStopId = null;
  markSelectedPin();

  sheetBack.hidden = true;
  sheetEyebrow.textContent = 'Nearby';
  sheetTitle.textContent = 'Stops near you';
  renderNearbyList(nearbyStops);
  openSheet('nearby');
}

async function handlePosition(position) {
  const { latitude, longitude } = position.coords;

  if (!isOnOahu(latitude, longitude)) {
    setLocating(false);
    showMapMessage("You're not on Oʻahu, so no stops are nearby. Tap a stop on the map or use Search.");
    return;
  }

  showYouAreHere(latitude, longitude);
  map.setView([latitude, longitude], NEARBY_ZOOM);

  try {
    nearbyStops = await fetchNearbyStops(latitude, longitude);
    showNearbySheet();
  } catch (err) {
    console.error(err);
    showMapMessage("Couldn't load nearby stops. Try again.");
  } finally {
    setLocating(false);
  }
}

function handlePositionError(err) {
  setLocating(false);
  const messages = {
    [err.PERMISSION_DENIED]: 'Location is blocked for this site. Allow it in your browser settings, or tap a stop on the map.',
    [err.TIMEOUT]: 'Finding your location took too long. Try again.',
  };
  showMapMessage(messages[err.code] || "We couldn't find your location. Try again.");
}

function handleLocateClick() {
  if (locateButton.getAttribute('aria-disabled') === 'true') return;
  showMapMessage('');

  if (!('geolocation' in navigator)) {
    showMapMessage("This browser can't share your location. Tap a stop on the map or use Search.");
    return;
  }

  setLocating(true);
  navigator.geolocation.getCurrentPosition(handlePosition, handlePositionError, {
    enableHighAccuracy: true,
    timeout: 15000,
    maximumAge: 60000,
  });
}

function handlePinClick(event) {
  openStop(event.layer.options.stop);
}

// Leaflet only turns Enter into a click for popups, so handle keyboard "taps" on pins here
function handlePinKeypress(event) {
  const { key } = event.originalEvent;
  if (key !== 'Enter' && key !== ' ') return;
  event.originalEvent.preventDefault();
  openStop(event.layer.options.stop);
}

function handleNearbyClick(event) {
  const button = event.target.closest('.nearbyStop');
  if (!button) return;

  const stop = nearbyStops.find((nearby) => nearby.stopId === Number(button.dataset.stopId));
  if (stop) openStop(stop, { fromNearby: true });
}

function handleKeydown(event) {
  if (event.key === 'Escape' && !mapSheet.hidden) closeSheet();
}

function handleVisibilityChange() {
  if (!arrivalsPoller) return;
  if (document.hidden) {
    arrivalsPoller.pause();
  } else {
    arrivalsPoller.refresh();
  }
}

/**************************************************************
Event listeners
***************************************************************/
map.on('moveend', loadStopsInView);
stopPins.on('click', handlePinClick);
stopPins.on('keypress', handlePinKeypress);
locateButton.addEventListener('click', handleLocateClick);
nearbyList.addEventListener('click', handleNearbyClick);
sheetBack.addEventListener('click', showNearbySheet);
sheetClose.addEventListener('click', closeSheet);
document.addEventListener('keydown', handleKeydown);
document.addEventListener('visibilitychange', handleVisibilityChange);

loadStopsInView(); // Shows the "zoom in" hint for the opening island view
