// The Routes tab: narrows the list as the rider types, and paints badges in TheBus's route colors.

/**************************************************************
DOM selectors
***************************************************************/
const routeFilter = document.querySelector('.routeFilter');
const routeItems = [...document.querySelectorAll('.routeItem')];
const routeBadges = [...document.querySelectorAll('.routeList .routeBadge')];
const routeCount = document.querySelector('.routeCount');
const routeEmpty = document.querySelector('.routeEmpty');

/**************************************************************
Helpers
***************************************************************/
// Colors come from the GTFS feed through data attributes, since pages can't use inline styles
function applyRouteColor(badge) {
  const { color, textColor } = badge.dataset;
  if (color) badge.style.setProperty('--routeColor', color);
  if (textColor) badge.style.setProperty('--routeTextColor', textColor);
}

function describeCount(count, isFiltered) {
  const routes = count === 1 ? 'route' : 'routes';
  return isFiltered ? `${count} ${routes} match` : `${count} ${routes}`;
}

/**************************************************************
Main logic
***************************************************************/
function handleFilterInput() {
  const query = routeFilter.value.trim().toLowerCase();
  const matches = routeItems.filter((item) => item.dataset.search.includes(query));

  routeItems.forEach((item) => {
    item.hidden = !matches.includes(item);
  });
  routeEmpty.hidden = matches.length > 0;
  routeCount.textContent = describeCount(matches.length, query.length > 0);
}

/**************************************************************
Event listeners
***************************************************************/
routeFilter.addEventListener('input', handleFilterInput);

routeBadges.forEach(applyRouteColor);
