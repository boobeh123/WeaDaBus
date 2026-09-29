<p align="center">
  <h3 align="center">Wea Da Bus</h3>

  <p align="center">This is a full-stack web application that uses Oahu Transit Services' Web Services API to show real-time TheBus arrivals and bus locations, plus Skyline rail stations and schedules.</p>

  <p align="center">Deployed on Railway: https://weadabus.up.railway.app/</p>
</p>

## About The Project
This project's goal is to see what could be built with the data offered from this API

### Why this exists:
This application is free to use, and the information available here could offer new perspectives

## How It Works

### Features
* Full-stack web application deployed with Railway
* Responsive to mobile viewports
* Interactive map built with the Leaflet library and OpenStreetMap tiles
* Oahu Transit Services / Web Services APIs
* TheBus GTFS schedule data (stops, routes, and route lines) stored in MongoDB

### Technologies
<img src="https://img.shields.io/badge/html5%20-%23E34F26.svg?&style=for-the-badge&logo=html5&logoColor=white" alt="HTML" height="50"/><img src="https://img.shields.io/badge/css3%20-%231572B6.svg?&style=for-the-badge&logo=css3&logoColor=white" alt="CSS" height="50"/><img src="https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black" alt="JavaScript" height="50"/><img src="https://img.shields.io/badge/node.js%20-3F873F.svg?&style=for-the-badge&logo=node.js&logoColor=white" alt="Node" height="50"/><img src="https://img.shields.io/badge/Express.js-000000?style=for-the-badge&logo=express&logoColor=white" alt="Express" height="50"/><img src="https://img.shields.io/badge/MongoDB-4EA94B?style=for-the-badge&logo=mongodb&logoColor=white" alt="MongoDB" height="50"/><img src="https://img.shields.io/badge/Mongoose.js-8A0403?style=for-the-badge&logoColor=white" alt="Mongoose" height="50"/><img src="https://img.shields.io/badge/EJS-B4CA65?style=for-the-badge&logo=ejs&logoColor=black" alt="EJS" height="50"/><img src="https://img.shields.io/badge/Leaflet-199900?style=for-the-badge&logo=leaflet&logoColor=white" alt="Leaflet" height="50"/>

### Full Breakdown

#### What riders can do
* **Nearby (the home page):** a map of Oʻahu. Tap **Show stops near me** to list the closest stops. The app asks for your location only when you tap. Zoom in to street level to see every stop as a pin, and tap any stop for its live arrivals.
* **Routes:** all 118 routes, listed as Skyline first, then letter routes, then number routes, with a filter box. Each route opens a map that shows:
  * both directions in their own colors, solid for the direction you pick and dotted for the trip back
  * the route's stops in order
  * its buses moving live
* **Search:** look up any stop by the number on its bus stop sign.
* **Stop pages:** the next 2 hours of arrivals, with the next bus called out at the top. Each arrival says whether it's tracked live by GPS or only scheduled, canceled trips are marked, and the list refreshes every minute.
* **Live buses:** tap a bus to see where it's headed, how early or late it's running, and when it last reported its position.
* **Dark mode** follows your phone's setting.

#### Where the data comes from
* **Live data:** stop arrivals and bus positions from TheBus's Web Services API.
  * Every call goes through this app's server, so the API key never reaches the browser.
  * Results are cached for 30 seconds, so riders looking at the same stop or route share one call.
* **Schedule data:** stops, routes, and route lines from TheBus's GTFS feed, imported into MongoDB. The import is re-run when TheBus publishes a new feed.
* **Maps:** OpenStreetMap tiles, drawn with Leaflet.
* **Skyline:** stations and scheduled times appear. TheBus's live feed doesn't include train positions yet.

#### Project structure
```
server.js               Express app: security headers, routes, error handling
config/                 MongoDB connection
controller/             Page and API handlers
model/                  Mongoose models: Stop, Route, RoutePattern
routes/                 URL routing
middleware/             Input validation and rate limits
services/theBus.js      The only code that calls TheBus's API
scripts/importGtfs.js   Loads TheBus's GTFS schedule into MongoDB
views/                  EJS pages and partials
public/                 CSS and browser JavaScript
```

#### Run it locally
1. Install Node.js 22 or newer, then run `npm install`.
2. Create a `.env` file using the variable names in `.env.example`:
   * `WEBSERVICESKEY`: a TheBus API key. Register for one at https://hea.thebus.org/api_info.asp.
   * `DB_STRING`: a MongoDB connection string.
   * `PORT` and `NODE_ENV` are optional when running locally.
3. Run `npm run import:gtfs` to load TheBus's stops and routes into MongoDB.
4. Run `npm run dev` and open http://localhost:3000.

#### Credits
Route and arrival data provided by permission of Oahu Transit Services, Inc. Map data © OpenStreetMap contributors.