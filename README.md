# SprayCast (prototype)

Spray-window forecasts for any field in the US.

A University of Idaho Extension prototype. A grower drops a pin or types an address and gets a 7-day forecast for that field, rated hour by hour as **Good / Caution / Do not spray**. Each rating is checked against wind, gusts, temperature inversions, Delta T, rain and label timing, using thresholds from Extension guidance.

## Run it

It is a static site with no build step and no backend.

```
python -m http.server 8000
```

Then open http://localhost:8000. You can also double-click `index.html`, but a local server is more reliable for map tiles and geocoding.

**Deploying a change:** bump the `?v=` stamp on the CSS and JS links in `index.html` (for example `?v=20261016` to `?v=20261017`). GitHub Pages lets browsers cache files for 10 minutes, and the stamp makes the page and its scripts update together.

## How it works

| Piece | What it does |
|---|---|
| `js/app.js` | Map (Leaflet + Esri tiles), live address search (Photon by komoot, OpenStreetMap data; Nominatim forbids search-as-you-type), the forecast call, day and window grouping, rendering |
| `js/rules.js` | Pure scoring rules: one hour of forecast in, a level plus the reasons out. Every threshold lives here and is cited. |
| `index.html` | Layout, rating table and sources |

**Data:** a single Open-Meteo request per location (`models=gfs_seamless`). It uses HRRR (3 km) for about the first 48 h and GFS after that. Each pin gets its own grid cell, so there is no interpolation to do. Hourly variables: 10 m wind speed, gusts and direction; 2 m and 80 m temperature; RH; cloud cover; precipitation and its probability. Daily variables: sunrise and sunset.

**Wind at boom height:** labels set wind limits at boom height, but the forecast is for 10 m. The tool scales it with the FAO-56 logarithmic wind profile over short grass (Allen et al. 1998, Eq. 47): u(z) = u10 · ln(67.8z − 5.42) / ln(67.8·10 − 5.42), with z = crop height + boom height above the crop. Crop height only sets the boom's height above ground; the grass-surface profile is not adjusted for the canopy. The default setup is a 24 in boom (the dicamba-label maximum above target or canopy) over a 1 m crop, so z ≈ 1.61 m and the factor is about 0.71. All wind thresholds use the converted value. Gusts, the gust-spread check and the no-80 m inversion proxy still use 10 m values.

**Two modes:** *Basic* (default) always rates with the default setup (24 in boom over a 1 m crop, general rules, 1 h shortest window) and shows only the answer: the next good window, a 7-day row of day tiles and one day's daylight hours in plain sentences. *Advanced* starts from the same defaults and adds the setup inputs (boom height above the crop, crop height, shortest useful window, rule set), sensitive neighbors, and the full 24-hour breakdown with every factor. Only the inputs a grower changes are remembered in the browser, so changing a default in code reaches everyone who hasn't overridden it. A link with `?lat=..&lon=..` opens straight to that field.

**Rules, aligned with WSU AgWeatherNet Spray Guidance (Amogi et al. 2025):** inversion (warmer at 260 ft than 6 ft) is Do not spray; Delta T 3.6–14.4 °F is Good, 0–3.6 or 14.4–18 °F Caution, above 18 °F Do not spray; wind at boom height 3–10 mph is Good (the label range; WSU uses 4–10 mph), 2–3 mph Caution, below 2 or above 10 mph Do not spray. Gusts only ever raise Caution (15 mph at 33 ft, or 10 mph above the mean wind; prototype values). The worst factor sets each hour. When a day has no Good window, the tool shows "OK with care" windows (daylight hours with no Do-not-spray factor) together with what to adjust, e.g. coarser droplets and more water when it's hot and dry.

**Saved fields:** growers can save the current pin under a name. Saved fields show as chips in the search card, and the last field viewed reopens automatically. Saved fields and sensitive sites are stored in the browser (localStorage), so they don't follow the grower to another device.

**Sensitive neighbors:** in Advanced mode growers mark vineyards, beehives, homes and so on on the map. For each hour, if the wind blows toward a marked site within 2 mi (within ±45° of the downwind direction), the hour is rated Caution under general rules and Do not spray under restricted-label rules. Dicamba labels prohibit spraying when the wind blows toward neighboring sensitive crops but define no distance, so the 2 mi radius and ±45° sector are prototype values.

**Inversions:** if the 80 m temperature is higher than the 2 m temperature, the hour is rated Do not spray. A difference within 0.3 °C rates Caution. If the model returns no 80 m data, the tool falls back to a calm + clear + near dawn/dusk proxy (NDSU AE1705).

**Delta T:** calculated from 2 m temperature and RH with Stull's (2011) wet-bulb formula.

**Turning numbers into advice:** the worst factor sets each hour's color. Consecutive Good hours are grouped into windows, for example "Good: 9 AM–1 PM (winds SW 4–6 mph)". Non-good daylight hours are grouped by their main limiting factor, for example "Inversion 7–10 AM · Too windy 2–6 PM". Clicking any hour lists every check it passed or failed.

**Quota:** results are cached in the browser for 1 hour per ~1 km location, which matches the hourly model update. With no API key, Open-Meteo's free tier is about 10,000 calls a day for non-commercial use.

## Open items before growers see it

- [ ] **Email Open-Meteo** to confirm that a free University of Idaho Extension tool counts as non-commercial use.
- [ ] **Specialist review of thresholds.** The gust and rain thresholds (marked *Prototype* in the app) need a citation or sign-off. Also check model Delta T against Idaho stations: it is the main limit in southern Idaho summers (Delta T above 18 °F in 23–60% of May–July daylight hours in archived HRRR/GFS forecasts). Also confirm that the inversion cut-offs at 80 m are reasonable, since WSU uses 30 ft vs 6 ft from station towers.
- [ ] **Verify citations and add direct links.** The sources list gives titles but no deep links yet. Confirm each one, especially the Minnesota and Iowa State pages and the GRDC Delta T fact sheet.
- [ ] **Review the boom-height wind conversion.** It assumes neutral stability and a short-grass surface, even over a tall crop. Check whether the gust thresholds should also apply at boom height.
- [ ] **Review the sensitive-neighbor radius (2 mi) and angle (±45°).**
- [ ] **Check the current dicamba label status** before shipping the "Restricted label" profile.
- [ ] **Read the WSU/PNW forecast-based spray advisory paper** and align the logic where it makes sense.
- [ ] **Check the competition in Idaho:** Bayer Spray App and WSU AgWeatherNet coverage.

## Next features (from the planning discussion)

1. **Email alerts.** The night before, send something like "Tomorrow 8–11 AM looks good at North field." This needs a small backend: a scheduled job, a list of subscribers and pins, and Amazon SES (about $0.10 per 1,000 emails) or university mail.
3. **National Blend of Models** for days 3–7, if Open-Meteo exposes it with the needed variables.
4. **Verification** against AgriMet and Idaho stations, and later station-based bias correction (the approach AgWeatherNet uses).
5. **Grower testing** with a few Idaho growers or county educators before adding more features.

## Disclaimer

Advisory only. The pesticide label is the law.
