# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A static HTML/CSS/JS site that will show real-time bus data from TheBus (Oahu Transit Services) Web API. It is an early scaffold: `index.html` is a placeholder page, and `public/css/styles.css` and `public/js/main.js` are empty.

There is no `package.json`, build step, linter, or test suite. `index.html` loads its stylesheet with a root-absolute path (`/public/css/styles.css`), so preview it through a static server rooted at the repo, not by opening the file directly.

## TheBus API

`WebServicesAPI.md` is the OTS API reference (v1.11), taken from https://hea.thebus.org/api_info.asp. It is text extracted from a PDF, so the repeated "Web API" and page-number lines are noise. Read it before writing code that calls the API. These points affect the design:

- There are three read-only GET endpoints under `http://api.thebus.org/`: `arrivals/?key=&stop=`, `vehicle/?key=&num=`, and `route/?key=&route=` or `route/?key=&headsign=`.
- Responses are XML, not JSON. Processing errors come back in an `errorMessage` element in the response body, so check for that element.
- Every request needs the AppID as `key`. Keep it in `.env` (gitignored) and never ship it in client-side JS, because anyone who has the key can use up its quota.
- The documented base URLs are `http://` only. Browsers block requests from an HTTPS page (Netlify) to `http://` URLs as mixed content. Because of this and the key rule, API calls must go through a server-side proxy.
- Each AppID is limited to 250,000 requests a day and is deleted after 6 months of inactivity. Bus positions update about once a minute and can be 2 or more minutes stale, so polling more than once a minute gains nothing.
- The Terms of Use require the legend "Route and arrival data provided by permission of Oahu Transit Services, Inc" to be displayed prominently wherever the data appears. Using the marks "OTS" or "HEA" also requires the asterisk trademark notice quoted in the doc.
- Some fields are easy to misread. For `vehicle:adherence`, positive means early and negative means late. `arrival:estimated` is 1 for a GPS estimate and 0 for scheduled only. `arrival:canceled` is 0 for active, 1 for canceled, and -1 for canceled and then reinstated.
- The doc's DTD schemas disagree with its field lists. For example, the arrivals DTD lists `scheduled` and omits `stopTime`, and the routes DTD uses `routeId` and `shapeDescription` where the field list says `routeID` and `firstStop`. Trust the field lists and real responses over the DTDs.
