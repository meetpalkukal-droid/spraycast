(function () {
  "use strict";

  const R = window.SprayRules;
  const API = "https://api.open-meteo.com/v1/forecast";
  const GEOCODER = "https://nominatim.openstreetmap.org/search";
  const HOURLY = [
    "temperature_2m", "temperature_80m", "relative_humidity_2m",
    "wind_speed_10m", "wind_gusts_10m", "wind_direction_10m",
    "cloud_cover", "precipitation", "precipitation_probability",
  ].join(",");
  const CACHE_TTL_MS = 60 * 60 * 1000; // models update hourly
  const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

  const $ = (id) => document.getElementById(id);
  const state = { lat: null, lon: null, data: null, profile: "general", marker: null };

  // ---------- Map ----------
  const map = L.map("map").setView([44.3, -115.5], 6);
  const esri = "https://server.arcgisonline.com/ArcGIS/rest/services/";
  const satellite = L.layerGroup([
    L.tileLayer(esri + "World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 19, attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
    }),
    L.tileLayer(esri + "Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19 }),
  ]);
  const streets = L.tileLayer(esri + "World_Street_Map/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19, attribution: "© Esri",
  });
  satellite.addTo(map);
  L.control.layers({ Satellite: satellite, Streets: streets }).addTo(map);
  map.on("click", (e) => setLocation(e.latlng.lat, e.latlng.lng, null, false));

  // ---------- Inputs ----------
  try {
    const saved = localStorage.getItem("spray:profile");
    if (saved && R.PROFILES[saved]) state.profile = saved;
  } catch (_) { /* storage unavailable */ }
  $("profile-select").value = state.profile;
  $("profile-select").addEventListener("change", (e) => {
    state.profile = e.target.value;
    try { localStorage.setItem("spray:profile", state.profile); } catch (_) {}
    render();
  });

  $("search-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("search-input").value.trim();
    if (!q) return;
    const coords = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (coords) return setLocation(+coords[1], +coords[2], null, true);
    setStatus("Searching…");
    try {
      const url = `${GEOCODER}?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(q)}`;
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      const hits = await res.json();
      if (!hits.length) return setStatus(`No match for “${q}”. Try a town name, or click the map.`, true);
      setLocation(+hits[0].lat, +hits[0].lon, hits[0].display_name, true);
    } catch (err) {
      setStatus("Address search is unavailable right now. Click the map instead.", true);
    }
  });

  $("locate-btn").addEventListener("click", () => {
    if (!navigator.geolocation) return setStatus("Your browser can't share its location.", true);
    setStatus("Finding your location…");
    navigator.geolocation.getCurrentPosition(
      (pos) => setLocation(pos.coords.latitude, pos.coords.longitude, "Your location", true),
      () => setStatus("Location access was blocked. Search or click the map instead.", true),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  // ---------- Data ----------
  async function setLocation(lat, lon, label, zoom) {
    state.lat = lat; state.lon = lon;
    if (state.marker) state.marker.setLatLng([lat, lon]);
    else state.marker = L.marker([lat, lon]).addTo(map);
    if (zoom) map.setView([lat, lon], Math.max(map.getZoom(), 12));
    $("location-info").textContent = `${label ? label + " · " : ""}${lat.toFixed(4)}, ${lon.toFixed(4)}`;

    setStatus("Loading the 7-day forecast…");
    try {
      state.data = await fetchForecast(lat, lon);
      render();
    } catch (err) {
      setStatus(`Couldn't load the forecast (${err.message}). Please try again in a minute.`, true);
    }
  }

  async function fetchForecast(lat, lon) {
    // ~1 km cache key: neighbouring pins share the same 3 km model cell anyway.
    const key = `spray:fc:${lat.toFixed(2)},${lon.toFixed(2)}`;
    try {
      const hit = JSON.parse(localStorage.getItem(key) || "null");
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
    } catch (_) {}

    const params = new URLSearchParams({
      latitude: lat.toFixed(4), longitude: lon.toFixed(4),
      hourly: HOURLY, daily: "sunrise,sunset", current: "wind_speed_10m",
      models: "gfs_seamless", // HRRR (3 km) for ~48 h, GFS beyond
      wind_speed_unit: "mph", precipitation_unit: "inch",
      timezone: "auto", forecast_days: "7",
    });
    const res = await fetch(`${API}?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.reason || "API error");
    try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), data })); } catch (_) {}
    return data;
  }

  // ---------- Analysis ----------
  const minutesOf = (iso) => +iso.slice(11, 13) * 60 + +iso.slice(14, 16);

  function buildDays(d, profile) {
    const H = d.hourly;
    const col = (name, i) => (H[name] ? H[name][i] : null);
    const nowIso = d.current && d.current.time ? d.current.time : null;
    const nowHour = nowIso ? nowIso.slice(0, 13) : null;

    const days = d.daily.time.map((date, i) => ({
      date, index: i,
      sunrise: minutesOf(d.daily.sunrise[i]),
      sunset: minutesOf(d.daily.sunset[i]),
      hours: [],
    }));
    const byDate = new Map(days.map((x) => [x.date, x]));

    H.time.forEach((t, i) => {
      const day = byDate.get(t.slice(0, 10));
      if (!day) return;
      const h = {
        time: t, minutes: minutesOf(t), hour: +t.slice(11, 13),
        wind: col("wind_speed_10m", i), gust: col("wind_gusts_10m", i), dir: col("wind_direction_10m", i),
        t2: col("temperature_2m", i), t80: col("temperature_80m", i), rh: col("relative_humidity_2m", i),
        cloud: col("cloud_cover", i), precip: col("precipitation", i), pop: col("precipitation_probability", i),
      };
      h.past = nowHour !== null && t.slice(0, 13) < nowHour;
      h.score = R.scoreHour(h, { profile, sunrise: day.sunrise, sunset: day.sunset });
      day.hours.push(h);
    });

    days.forEach((day) => {
      day.windows = runs(day.hours, (h) => !h.past && h.score.level === R.LEVEL.GOOD);
      const daylight = (h) => h.minutes + 60 > day.sunrise && h.minutes < day.sunset;
      day.limits = runsByKey(day.hours.filter((h) => !h.past && daylight(h) && h.score.level > 0));
    });
    return days;
  }

  // Consecutive hours satisfying pred → [{start, end, hours}]
  function runs(hours, pred) {
    const out = [];
    let cur = null;
    hours.forEach((h, i) => {
      const prev = hours[i - 1];
      if (pred(h) && cur && prev && prev.hour === h.hour - 1 && pred(prev)) cur.hours.push(h);
      else if (pred(h)) out.push((cur = { hours: [h] }));
      else cur = null;
    });
    out.forEach((r) => { r.start = r.hours[0].hour; r.end = r.hours[r.hours.length - 1].hour + 1; });
    return out;
  }

  // Group consecutive limited hours by their main limiting factor.
  function runsByKey(hours) {
    const out = [];
    hours.forEach((h) => {
      const last = out[out.length - 1];
      const p = h.score.primary;
      if (last && last.key === p.key && last.end === h.hour) { last.end = h.hour + 1; last.level = Math.max(last.level, h.score.level); }
      else out.push({ key: p.key, short: p.short, level: h.score.level, start: h.hour, end: h.hour + 1 });
    });
    return out;
  }

  // ---------- Formatting ----------
  const hourLabel = (h) => {
    h = ((h % 24) + 24) % 24;
    if (h === 0) return "12 AM";
    if (h === 12) return "Noon";
    return h < 12 ? `${h} AM` : `${h - 12} PM`;
  };
  const span = (a, b) => `${hourLabel(a)}–${hourLabel(b)}`;
  const compass = (deg) => (deg == null ? "" : COMPASS[Math.round(deg / 22.5) % 16]);
  const dayName = (date, i) => {
    if (i === 0) return "Today";
    if (i === 1) return "Tomorrow";
    const d = new Date(date + "T12:00:00");
    return d.toLocaleDateString(undefined, { weekday: "long" });
  };
  const dateShort = (date) => new Date(date + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const toF = (c) => Math.round(c * 9 / 5 + 32);

  function windowWind(w) {
    const speeds = w.hours.map((h) => h.wind).filter((x) => x != null);
    const dirs = w.hours.map((h) => compass(h.dir));
    const mode = dirs.sort((a, b) => dirs.filter((x) => x === b).length - dirs.filter((x) => x === a).length)[0];
    if (!speeds.length) return "";
    const lo = Math.round(Math.min(...speeds)), hi = Math.round(Math.max(...speeds));
    return `winds ${mode} ${lo === hi ? lo : lo + "–" + hi} mph`;
  }

  function confidence(i) {
    if (i <= 1) return { text: "HRRR 3 km · high detail", cls: "conf-high" };
    if (i <= 3) return { text: "GFS · moderate confidence", cls: "conf-mid" };
    return { text: "GFS · for tentative planning", cls: "conf-low" };
  }

  // ---------- Rendering ----------
  function setStatus(msg, isError) {
    const el = $("status");
    el.textContent = msg;
    el.classList.toggle("error", !!isError);
    el.hidden = !msg;
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function render() {
    if (!state.data) return;
    const d = state.data;
    const days = buildDays(d, state.profile);
    const hasT80 = (d.hourly.temperature_80m || []).some((x) => x != null);

    setStatus("");
    const meta = $("forecast-meta");
    meta.hidden = false;
    meta.textContent = `Model grid cell at ${Math.round(d.elevation * 3.281)} ft elevation · times in ${d.timezone_abbreviation || d.timezone}` +
      (hasT80 ? "" : " · Upper-air temperatures are missing, so inversions are estimated from calm, clear conditions.");

    renderBest(days);
    $("legend").hidden = false;

    const wrap = $("days");
    wrap.replaceChildren();
    days.forEach((day) => wrap.appendChild(renderDay(day)));
  }

  function renderBest(days) {
    const box = $("best");
    box.replaceChildren();
    box.hidden = false;
    const all = days.flatMap((day) => day.windows.map((w) => ({ day, w })));
    box.appendChild(el("h2", null, all.length ? "Next spray windows" : "No good spray windows this week"));
    if (!all.length) {
      box.appendChild(el("p", "muted", "No hour meets every condition. The day-by-day view below shows what's limiting each day, and the Caution (amber) hours may still work with extra care."));
      return;
    }
    const list = el("ul", "best-list");
    all.slice(0, 4).forEach(({ day, w }) => {
      const li = el("li");
      li.appendChild(el("strong", null, `${dayName(day.date, day.index)} ${span(w.start, w.end)}`));
      li.appendChild(el("span", "muted", ` · ${w.hours.length} h · ${windowWind(w)}`));
      list.appendChild(li);
    });
    box.appendChild(list);
  }

  function renderDay(day) {
    const card = el("article", "day");
    const head = el("header", "day-head");
    const title = el("h3", null, dayName(day.date, day.index));
    title.appendChild(el("span", "date", ` ${dateShort(day.date)}`));
    head.appendChild(title);
    const c = confidence(day.index);
    head.appendChild(el("span", `conf ${c.cls}`, c.text));
    card.appendChild(head);

    card.appendChild(renderSummary(day));

    const strip = el("div", "strip");
    const detail = el("div", "hour-detail");
    detail.hidden = true;

    day.hours.forEach((h) => {
      const cell = el("button", `cell lvl-${h.score.level}${h.past ? " past" : ""}`);
      cell.type = "button";
      const reason = h.score.primary ? ` – ${h.score.primary.short}` : "";
      cell.title = `${hourLabel(h.hour)}: ${R.LEVEL_NAME[h.score.level]}${reason}`;
      cell.setAttribute("aria-label", cell.title);
      cell.appendChild(el("span", "cell-wind", h.wind != null ? Math.round(h.wind) : ""));
      cell.addEventListener("click", () => {
        strip.querySelectorAll(".cell.selected").forEach((x) => x.classList.remove("selected"));
        if (detail.dataset.hour === String(h.hour) && !detail.hidden) { detail.hidden = true; return; }
        cell.classList.add("selected");
        detail.dataset.hour = String(h.hour);
        renderDetail(detail, h);
        detail.hidden = false;
      });
      strip.appendChild(cell);
    });
    card.appendChild(strip);

    const axis = el("div", "axis");
    [0, 6, 12, 18].forEach((hr) => axis.appendChild(el("span", null, hourLabel(hr))));
    card.appendChild(axis);
    card.appendChild(el("p", "strip-note", "The number in each hour is wind speed in mph. Tap an hour to see why it got that rating."));
    card.appendChild(detail);
    return card;
  }

  function renderSummary(day) {
    const box = el("div", "summary");
    if (day.hours.every((h) => h.past)) {
      box.appendChild(el("p", "muted", "This day is over."));
      return box;
    }
    if (day.windows.length) {
      day.windows.forEach((w) => {
        const p = el("p", "sum-good");
        p.appendChild(el("strong", null, `Good: ${span(w.start, w.end)}`));
        p.appendChild(document.createTextNode(` (${windowWind(w)})`));
        box.appendChild(p);
      });
    } else {
      box.appendChild(el("p", "sum-none", "No good window."));
    }
    const notable = day.limits.filter((r) => r.level === R.LEVEL.NO || r.end - r.start >= 2);
    if (notable.length) {
      const p = el("p", "sum-limits");
      notable.forEach((r, i) => {
        if (i) p.appendChild(document.createTextNode(" · "));
        p.appendChild(el("span", `tag lvl-${r.level}`, r.short));
        p.appendChild(document.createTextNode(` ${span(r.start, r.end)}`));
      });
      box.appendChild(p);
    }
    return box;
  }

  function renderDetail(box, h) {
    box.replaceChildren();
    const head = el("p", "detail-head");
    head.appendChild(el("strong", null, `${hourLabel(h.hour)} – ${hourLabel(h.hour + 1)}`));
    head.appendChild(el("span", `tag lvl-${h.score.level}`, R.LEVEL_NAME[h.score.level]));
    box.appendChild(head);

    const ul = el("ul", "factors");
    h.score.factors.forEach((f) => {
      const li = el("li", `f lvl-${f.level}`);
      li.appendChild(el("span", "dot"));
      li.appendChild(el("span", null, f.text));
      ul.appendChild(li);
    });
    box.appendChild(ul);

    const facts = [
      h.wind != null && `Wind ${Math.round(h.wind)} mph from ${compass(h.dir)}`,
      h.gust != null && `Gusts ${Math.round(h.gust)} mph`,
      h.t2 != null && `Temperature ${toF(h.t2)} °F`,
      h.rh != null && `Humidity ${Math.round(h.rh)}%`,
      h.cloud != null && `Cloud cover ${Math.round(h.cloud)}%`,
      h.pop != null && `Rain chance ${Math.round(h.pop)}%`,
    ].filter(Boolean);
    box.appendChild(el("p", "facts muted", facts.join(" · ")));
  }
})();
