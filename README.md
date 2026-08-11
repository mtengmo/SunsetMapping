# Sunset Simulator

A static, backend-free webpage that shows whether the sun/sunset is visible
from a chosen location, accounting for terrain and nearby OSM
buildings/trees, at any date and time.

## How it works

- **Map**: [Leaflet](https://leafletjs.com/) + OpenStreetMap tiles. Click the
  map (or allow geolocation on load) to pick a location.
- **Sun position**: [SunCalc](https://github.com/mourner/suncalc) computes the
  sun's azimuth/altitude for the selected date/time.
- **Obstruction**: a horizon-profile calculation samples points along the
  sun's azimuth out to 2km, fetches terrain elevation from the
  [Open-Meteo Elevation API](https://open-meteo.com/en/docs/elevation-api),
  and fetches nearby buildings/trees from the
  [Overpass API](https://overpass-api.de/). It computes the angle from the
  viewer to the highest obstruction along that line and compares it to the
  sun's altitude.
- **Date/time control**: bottom bar has a date picker and a minute-resolution
  time slider.
- **"Find best spot" wizard**: grid-searches the current map view (up to a
  6x6 grid) at the selected date/time, scoring each point by how much
  clearance the sun has above the horizon/obstructions. Buildings/trees for
  the whole area are fetched in a single Overpass query, and terrain
  elevation for all candidate points is fetched in batched requests, to keep
  API usage reasonable. Results are plotted as markers (green = visible, red
  = blocked, gold ring = top 3) and listed ranked best-first; click a marker
  or list item to jump the main simulator to that spot.
- **Timeline shading**: the time slider's track is shaded night/day/golden
  hour for the selected location + date (via `SunCalc.getTimes`), with a ⬥
  marker at the exact sunset moment and a caption showing sunset + golden
  hour times.
- **Shade map**: an optional toggle that renders approximate cast-shadow
  shapes for OSM buildings in the current map view, for the current sun
  position. Each shadow is the convex hull of a building's footprint plus
  the footprint translated away from the sun by `height / tan(altitude)` —
  a good approximation for typical rectangular buildings, less exact for
  concave/L-shaped ones. Building data for the view is fetched once and
  cached; only the (cheap, local) shadow geometry is recomputed as the time
  slider moves, and shading is disabled if the visible map area is too
  large (to avoid oversized Overpass queries).
- **Help**: an in-app ❓ Help panel explains what the map, results, chart,
  wizard, and shading mean.

Everything runs in the browser — there is no backend, database, or build
step. It deploys as static files to GitHub Pages, Vercel (static), or any
static host.

## Known limitations

- Most OSM buildings aren't tagged with `height`/`building:levels`; when
  untagged, a default of 9m (~3 storeys) is used and labeled as an estimate.
- Tree heights are never tagged in OSM; a fixed 12m estimate is used for all
  `natural=tree` nodes.
- The public Overpass API and Open-Meteo elevation API have modest anonymous
  rate limits and no CORS guarantees. Under heavy use (or if the public
  Overpass instance is busy) requests may be slow or fail — the UI surfaces
  this as an error rather than silently failing.
- The wizard's grid is intentionally coarse (max 6x6 points, 800m ray length
  vs. 2km for the single-point simulator) to keep total API calls bounded on
  the free public endpoints — it's meant to shortlist promising spots, not
  give per-point precision equal to the main simulator.

## Local preview

Any static file server works, e.g.:

```
npx serve .
```

then open the printed URL. (Opening `index.html` directly via `file://` will
generally also work, but some browsers restrict `fetch` from `file://`
origins — a local server is more reliable.)

## Deploying

- **GitHub Pages**: push this repo to GitHub, enable Pages for the branch/
  root folder in repo settings.
- **Vercel**: import the repo as a project with no build command/output
  directory overrides needed (static site).
