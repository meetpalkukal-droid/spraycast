# Spray Window Forecast (prototype)

A University of Idaho Extension prototype. A grower drops a pin or types an address and gets a 7-day forecast for that field, rated hour by hour as **Good / Caution / Do not spray**. Each rating is checked against wind, gusts, temperature inversions, Delta T, rain and label timing, using thresholds from Extension guidance.

## Run it

It is a static site with no build step and no backend.

```
python -m http.server 8000
```

Then open http://localhost:8000. You can also double-click `index.html`, but a local server is more reliable for map tiles and geocoding.

## How it works

| Piece | What it does |
|---|---|
| `js/app.js` | Map (Leaflet + Esri tiles), address search (OpenStreetMap Nominatim), the forecast call, day and window grouping, rendering |
| `js/rules.js` | Pure scoring rules: one hour of forecast in, a level plus the reasons out. Every threshold lives here and is cited. |
| `index.html` | Layout, rating table and sources |

**Data:** a single Open-Meteo request per location (`models=gfs_seamless`). It uses HRRR (3 km) for about the first 48 h and GFS after that. Each pin gets its own grid cell, so there is no interpolation to do. Hourly variables: 10 m wind speed, gusts and direction; 2 m and 80 m temperature; RH; cloud cover; precipitation and its probability. Daily variables: sunrise and sunset.

**Wind at boom height:** labels set wind limits at boom height, but the forecast is for 10 m. The tool scales it with the FAO-56 log wind profile over short grass (Allen et al. 1998, Eq. 47), u(z) = u10 · ln(67.8z − 5.42) / ln(67.8·10 − 5.42), with z = 0.61 m (24 in, the dicamba-label maximum boom height above target or canopy). The factor is about 0.55. All wind thresholds use the converted value. Gusts, the gust-spread check and the no-80 m inversion proxy still use 10 m values.

**Inversions:** if the 80 m temperature is higher than the 2 m temperature, the hour is rated Do not spray. A difference within 0.3 °C rates Caution. If the model returns no 80 m data, the tool falls back to a calm + clear + near dawn/dusk proxy (NDSU AE1705).

**Delta T:** calculated from 2 m temperature and RH with Stull's (2011) wet-bulb formula.

**Turning numbers into advice:** the worst factor sets each hour's color. Consecutive Good hours are grouped into windows, for example "Good: 9 AM–1 PM (winds SW 4–6 mph)". Non-good daylight hours are grouped by their main limiting factor, for example "Inversion 7–10 AM · Too windy 2–6 PM". Clicking any hour lists every check it passed or failed.

**Quota:** results are cached in the browser for 1 hour per ~1 km location, which matches the hourly model update. With no API key, Open-Meteo's free tier is about 10,000 calls a day for non-commercial use.

## Open items before growers see it

- [ ] **Email Open-Meteo** to confirm that a free University of Idaho Extension tool counts as non-commercial use.
- [ ] **Specialist review of thresholds.** The gust and rain thresholds (marked *Prototype* in the app) need a citation or sign-off. Also confirm that the inversion cut-offs at 80 m are reasonable, since WSU uses 30 ft vs 6 ft from station towers.
- [ ] **Verify citations and add direct links.** The sources list gives titles but no deep links yet. Confirm each one, especially the Minnesota and Iowa State pages and the GRDC Delta T fact sheet.
- [ ] **Review the boom-height wind conversion.** It treats 24 in as height above ground, so it ignores canopy height, and it assumes a grass surface and neutral stability. Check whether the gust thresholds should also apply at boom height.
- [ ] **Check the current dicamba label status** before shipping the "Restricted label" profile.
- [ ] **Read the WSU/PNW forecast-based spray advisory paper** and align the logic where it makes sense.
- [ ] **Check the competition in Idaho:** Bayer Spray App and WSU AgWeatherNet coverage.

## Next features (from the planning discussion)

1. **Email alerts.** The night before, send something like "Tomorrow 8–11 AM looks good at North field." This needs a small backend: a scheduled job, a list of subscribers and pins, and Amazon SES (about $0.10 per 1,000 emails) or university mail.
2. **Sensitive neighbours.** Let growers mark a vineyard, school or organic field, then flag hours when the wind blows toward it.
3. **National Blend of Models** for days 3–7, if Open-Meteo exposes it with the needed variables.
4. **Verification** against AgriMet and Idaho stations, and later station-based bias correction (the approach AgWeatherNet uses).
5. **Grower testing** with a few Idaho growers or county educators before adding more features.

## Disclaimer

Advisory only. The pesticide label is the law.
