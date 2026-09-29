// The map page, in one of two modes:
// - Nearby (GET /): stop pins for the visible area, "Show stops near me", and live arrivals for a stop.
// - Route (GET /routes/:slug): one route's line (solid this way, dotted the way back), its stops,
//   a direction toggle, and live arrivals for that route only.
// Leaflet (the global L) and arrivals.js load before this file.

/**************************************************************
DOM selectors
***************************************************************/
const mapPage = document.querySelector('.mapPage');
const mapElement = document.querySelector('.map');
const zoomHint = document.querySelector('.zoomHint');
const mapMessage = document.querySelector('.mapMessage');
const locateButton = document.querySelector('.locateButton');
const locateLabel = document.querySelector('.locateLabel');
const routeSheetButton = document.querySelector('.routeSheetButton'); // Route mode only
const mapSheet = document.querySelector('.mapSheet');
const sheetBody = document.querySelector('.sheetBody');
const sheetBack = document.querySelector('.sheetBack');
const sheetBackLabel = document.querySelector('.sheetBackLabel');
const sheetClose = document.querySelector('.sheetClose');
const sheetEyebrow = document.querySelector('.sheetEyebrow');
const sheetTitle = document.querySelector('.sheetTitle');
const sheetNearby = document.querySelector('.sheetNearby');
const nearbyList = document.querySelector('.nearbyList');
const nearbyEmpty = document.querySelector('.nearbyEmpty');
const nearbyTemplate = document.querySelector('.nearbyTemplate');
const sheetRoute = document.querySelector('.sheetRoute');
const directionButtons = [...document.querySelectorAll('.directionButton')];
const routeHint = document.querySelector('.routeHint');
const routeStopList = document.querySelector('.routeStopList');
const routeStopTemplate = document.querySelector('.routeStopTemplate');
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
const PIN_DETAIL_ZOOM = 14; // Below this, pins shrink to small dots so they don't hide a route's line
const NEARBY_ZOOM = 17;
const PIN_SIZE = 32; // Tap area in pixels. The visible dot is smaller (styles.css).
const SHEET_MARGIN = 24; // Pixels kept between map content and the sheet
const FEET_PER_METER = 3.28084;
const FEET_PER_MILE = 5280;

const routeSlug = mapPage.dataset.routeSlug; // Set only on route pages
const floatingButton = routeSlug ? routeSheetButton : locateButton; // Shown while the sheet is closed

const pinsByStopId = new Map();
let stopsRequest = null; // Aborted when the map moves again before the answer arrives
let arrivalsPoller = null;
let nearbyStops = [];
let selectedStopId = null;
let youAreHere = null;
let lastFocus = null; // Where focus returns when the sheet closes
let backTo = null; // Which list the stop sheet's back button returns to: 'nearby' or 'route'
let routeData = null; // { route, directions } from /api/routes/:slug
let selectedDirection = null;

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

// GeoJSON stores [longitude, latitude]; Leaflet wants [latitude, longitude]
function toLatLngs(path) {
  return path.map(([lon, lat]) => [lat, lon]);
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

// Map padding that keeps content out from under the sheet: below it on phones, beside it on desktop
function getSheetPadding() {
  if (mapSheet.hidden) {
    return { paddingTopLeft: [SHEET_MARGIN, SHEET_MARGIN], paddingBottomRight: [SHEET_MARGIN, SHEET_MARGIN] };
  }

  const sheetBox = mapSheet.getBoundingClientRect();
  const mapBox = mapElement.getBoundingClientRect();
  const isSidePanel = sheetBox.height >= mapBox.height * 0.9;

  return {
    paddingTopLeft: [isSidePanel ? sheetBox.right - mapBox.left + SHEET_MARGIN : SHEET_MARGIN, SHEET_MARGIN],
    paddingBottomRight: [SHEET_MARGIN, isSidePanel ? SHEET_MARGIN : mapBox.bottom - sheetBox.top + SHEET_MARGIN],
  };
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

// Adds pins that are new and removes ones no longer wanted, so pins don't flicker while panning
function showStops(stops) {
  const wantedIds = new Set(stops.map((stop) => stop.stopId));

  pinsByStopId.forEach((pin, stopId) => {
    if (!wantedIds.has(stopId) && stopId !== selectedStopId) {
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

// styles.css shrinks pins to small dots while the map has isZoomedOut
function updatePinSize() {
  mapElement.classList.toggle('isZoomedOut', map.getZoom() < PIN_DETAIL_ZOOM);
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

function buildRouteStopItem(stop) {
  const item = routeStopTemplate.content.firstElementChild.cloneNode(true);
  item.querySelector('.routeStop').dataset.stopId = stop.stopId;
  item.querySelector('.routeStopName').textContent = stop.name;
  item.querySelector('.routeStopMeta').textContent = `Stop ${stop.stopId}`;
  return item;
}

function getSelectedDirection() {
  return routeData.directions.find((direction) => direction.direction === selectedDirection);
}

// The selected direction is a solid line on a white casing; the trip back is dotted and drawn
// first, so the selected line stays on top where the two share a street
function drawRouteLines() {
  routeLines.clearLayers();

  const backFirst = [...routeData.directions].sort(
    (a, b) => Number(a.direction === selectedDirection) - Number(b.direction === selectedDirection)
  );

  backFirst.forEach((direction) => {
    const latLngs = toLatLngs(direction.path);
    if (direction.direction === selectedDirection) {
      routeLines.addLayer(L.polyline(latLngs, { className: 'routeLineCasing', weight: 10, interactive: false }));
      routeLines.addLayer(L.polyline(latLngs, { className: 'routeLine', weight: 6, interactive: false }));
    } else {
      routeLines.addLayer(L.polyline(latLngs, { className: 'routeLine isReturn', weight: 4, interactive: false }));
    }
  });
}

function fitRoute() {
  const allPoints = routeData.directions.flatMap((direction) => toLatLngs(direction.path));
  map.fitBounds(L.latLngBounds(allPoints), getSheetPadding());
}

// On a route page, only that route's buses; everywhere else, every bus at the stop
function renderSheetArrivals(stop) {
  const arrivals = routeData
    ? stop.arrivals.filter((arrival) => arrival.route === routeData.route.apiName)
    : stop.arrivals;
  const hasArrivals = renderArrivalList(arrivalList, arrivalTemplate, arrivals);
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
  // Route pages don't limit panning. On phones the sheet covers the bottom of the map, so fitting
  // a south-shore route into the space above it moves the map's center out over the ocean.
  maxBounds: routeSlug ? null : PAN_LIMIT_BOUNDS,
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

const routeLines = L.layerGroup().addTo(map); // Leaflet draws lines in a pane under the stop pins
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
  sheetRoute.hidden = view !== 'route';
  sheetStop.hidden = view !== 'stop';
  floatingButton.hidden = true;
  sheetBody.scrollTop = 0;
  sheetTitle.focus();
}

function closeSheet() {
  stopArrivalsPolling();
  selectedStopId = null;
  markSelectedPin();

  mapSheet.hidden = true;
  floatingButton.hidden = false;

  const canRefocus = lastFocus && lastFocus !== document.body && document.contains(lastFocus);
  (canRefocus ? lastFocus : floatingButton).focus();
  lastFocus = null;
}

// backTo: which list "‹ Back" returns to ('nearby' or 'route'), or null for no back button
function openStop(stop, { backTo: backToView = null } = {}) {
  selectedStopId = stop.stopId;
  backTo = backToView;
  markSelectedPin();

  sheetBack.hidden = !backTo;
  sheetBackLabel.textContent = backTo === 'route' ? `Route ${routeData.route.name}` : 'Nearby stops';
  sheetEyebrow.textContent = `Stop ${stop.stopId}`;
  sheetTitle.textContent = stop.name;
  sheetRoutes.textContent = routeData
    ? `Showing route ${routeData.route.name} only. The stop page shows every bus.`
    : `Routes: ${stop.routes.join(', ')}`;
  emptyMessage.textContent = routeData
    ? `No route ${routeData.route.name} buses in the next 2 hours.`
    : 'No buses in the next 2 hours. Service at this stop may be done for the day.';
  sheetStopLink.href = `/stops/${stop.stopId}`;
  sheetUpdated.textContent = 'Loading arrivals…';
  arrivalList.replaceChildren();
  arrivalList.hidden = true;
  emptyMessage.hidden = true;
  unavailableMessage.hidden = true;

  openSheet('stop');
  map.panInside([stop.lat, stop.lon], getSheetPadding());
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

// returnToStopId: coming back from a stop, put focus (and the scroll) on that stop in the list
function showRouteSheet({ returnToStopId = null } = {}) {
  stopArrivalsPolling();
  selectedStopId = null;
  markSelectedPin();

  sheetBack.hidden = true;
  sheetEyebrow.textContent = routeData.route.mode === 'rail' ? 'Skyline rail' : `Route ${routeData.route.name}`;
  sheetTitle.textContent = routeData.route.longName || routeData.route.name;
  openSheet('route');

  routeStopList.querySelector(`.routeStop[data-stop-id="${returnToStopId}"]`)?.focus();
}

function selectDirection(directionNumber) {
  selectedDirection = directionNumber;
  const direction = getSelectedDirection();

  directionButtons.forEach((button) => {
    button.setAttribute('aria-pressed', String(Number(button.dataset.direction) === directionNumber));
  });
  drawRouteLines();
  showStops(direction.stops);
  routeStopList.replaceChildren(...direction.stops.map(buildRouteStopItem));
}

async function loadRoute() {
  try {
    const res = await fetch(`/api/routes/${encodeURIComponent(routeSlug)}`);
    if (!res.ok) throw new Error(`Route request failed with HTTP ${res.status}`);
    routeData = await res.json();
  } catch (err) {
    console.error(err);
    showMapMessage("Couldn't load this route. Try refreshing the page.");
    return;
  }

  if (routeData.directions.length === 0) {
    showMapMessage("TheBus hasn't published a map line for this route.");
    return;
  }

  // TheBus's own route colors, when it sets them. Set on the page so the line, the stop timeline,
  // and the arrival badges all use them (styles.css falls back to the primary colors).
  if (routeData.route.color) mapPage.style.setProperty('--routeColor', routeData.route.color);
  if (routeData.route.textColor) mapPage.style.setProperty('--routeTextColor', routeData.route.textColor);

  // One toggle button per direction, labeled by where it's headed
  directionButtons.forEach((button, index) => {
    const direction = routeData.directions[index];
    button.hidden = !direction;
    if (!direction) return;
    button.dataset.direction = direction.direction;
    button.textContent = `To ${direction.headsign}`;
  });
  routeHint.hidden = routeData.directions.length < 2;

  selectDirection(routeData.directions[0].direction);
  showRouteSheet();
  fitRoute();
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
  openStop(event.layer.options.stop, { backTo: routeData ? 'route' : null });
}

// Leaflet only turns Enter into a click for popups, so handle keyboard "taps" on pins here
function handlePinKeypress(event) {
  const { key } = event.originalEvent;
  if (key !== 'Enter' && key !== ' ') return;
  event.originalEvent.preventDefault();
  openStop(event.layer.options.stop, { backTo: routeData ? 'route' : null });
}

function handleNearbyClick(event) {
  const button = event.target.closest('.nearbyStop');
  if (!button) return;

  const stop = nearbyStops.find((nearby) => nearby.stopId === Number(button.dataset.stopId));
  if (stop) openStop(stop, { backTo: 'nearby' });
}

function handleRouteStopClick(event) {
  const button = event.target.closest('.routeStop');
  if (!button) return;

  const stop = getSelectedDirection().stops.find((routeStop) => routeStop.stopId === Number(button.dataset.stopId));
  if (stop) openStop(stop, { backTo: 'route' });
}

function handleDirectionClick(event) {
  selectDirection(Number(event.currentTarget.dataset.direction));
  sheetBody.scrollTop = 0;
}

function handleBackClick() {
  if (backTo === 'route') {
    showRouteSheet({ returnToStopId: selectedStopId });
  } else {
    showNearbySheet();
  }
}

function handleRouteSheetButtonClick() {
  showRouteSheet();
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
map.on('zoomend', updatePinSize);
stopPins.on('click', handlePinClick);
stopPins.on('keypress', handlePinKeypress);
nearbyList.addEventListener('click', handleNearbyClick);
sheetBack.addEventListener('click', handleBackClick);
sheetClose.addEventListener('click', closeSheet);
document.addEventListener('keydown', handleKeydown);
document.addEventListener('visibilitychange', handleVisibilityChange);

updatePinSize();

if (routeSlug) {
  routeSheetButton.addEventListener('click', handleRouteSheetButtonClick);
  routeStopList.addEventListener('click', handleRouteStopClick);
  directionButtons.forEach((button) => button.addEventListener('click', handleDirectionClick));
  loadRoute();
} else {
  map.on('moveend', loadStopsInView);
  locateButton.addEventListener('click', handleLocateClick);
  loadStopsInView(); // Shows the "zoom in" hint for the opening island view
}
