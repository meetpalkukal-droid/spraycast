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

  const DEFAULTS = { profile: "general", boomIn: R.DEFAULT_SETUP.boomIn, cropIn: R.DEFAULT_SETUP.cropIn, minHours: 1 };
  const LIMITS = { boomIn: [6, 72], cropIn: [0, 120], minHours: [1, 8] };

  const ICONS = [
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v9" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><circle cx="12" cy="19" r="1.8" fill="currentColor"/></svg>',
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>',
  ];

  const $ = (id) => document.getElementById(id);
  const state = {
    lat: null, lon: null, data: null, marker: null, selectedDay: null,
    mode: "simple", setup: { ...DEFAULTS },
    fields: loadList("spray:fields"), sites: loadList("spray:sites"), addingSite: false,
  };

  // Saved fields and sensitive sites live in this browser only.
  function loadList(key) {
    try { const v = JSON.parse(localStorage.getItem(key) || "[]"); return Array.isArray(v) ? v : []; } catch (_) { return []; }
  }
  function saveList(key, list) {
    try { localStorage.setItem(key, JSON.stringify(list)); } catch (_) {}
  }

  // ---------- Saved preferences (per browser; optional) ----------
  try {
    const saved = JSON.parse(localStorage.getItem("spray:prefs") || "null");
    if (saved) {
      if (saved.mode === "detailed") state.mode = "detailed";
      state.setup = sanitize({ ...DEFAULTS, ...saved.setup });
    }
  } catch (_) { /* storage unavailable */ }

  function savePrefs() {
    try { localStorage.setItem("spray:prefs", JSON.stringify({ mode: state.mode, setup: state.setup })); } catch (_) {}
  }

  function sanitize(s) {
    const out = { ...s };
    if (!R.PROFILES[out.profile]) out.profile = DEFAULTS.profile;
    Object.keys(LIMITS).forEach((k) => {
      const [lo, hi] = LIMITS[k];
      const n = Number(out[k]);
      const v = k === "cropIn" ? Math.round(n * 10) / 10 : Math.round(n);
      out[k] = Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : DEFAULTS[k];
    });
    return out;
  }

  // ---------- Map ----------
  const map = L.map("map", { zoomControl: false }).setView([44.3, -115.5], 6);
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
  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.control.layers({ Satellite: satellite, Streets: streets }, null, { position: "bottomright" }).addTo(map);
  map.on("click", (e) => {
    if (state.addingSite) return newSitePopup(e.latlng);
    setLocation(e.latlng.lat, e.latlng.lng, null, false);
  });

  // ---------- Saved fields ----------
  const isCurrent = (f) => state.lat != null && Math.abs(f.lat - state.lat) < 1e-4 && Math.abs(f.lon - state.lon) < 1e-4;

  function renderFields() {
    const wrap = $("fields");
    wrap.replaceChildren();
    wrap.hidden = !state.fields.length;
    if (!state.fields.length) return;
    wrap.appendChild(el("span", "fields-label", "My fields:"));
    state.fields.forEach((f) => {
      const chip = el("span", `field-chip${isCurrent(f) ? " current" : ""}`);
      const go = el("button", "field-go", f.name);
      go.type = "button";
      go.addEventListener("click", () => setLocation(f.lat, f.lon, f.name, true));
      const x = el("button", "field-x", "×");
      x.type = "button";
      x.setAttribute("aria-label", `Remove ${f.name}`);
      x.addEventListener("click", () => {
        if (!confirm(`Remove “${f.name}” from your fields?`)) return;
        state.fields = state.fields.filter((g) => g !== f);
        saveList("spray:fields", state.fields);
        renderFields();
        renderSaveRow();
      });
      chip.append(go, x);
      wrap.appendChild(chip);
    });
  }

  function renderSaveRow() {
    $("save-field").hidden = state.lat == null;
    const cur = state.fields.find(isCurrent);
    const editing = !$("save-form").hidden;
    $("save-btn").hidden = !!cur || editing;
    $("saved-as").hidden = !cur;
    if (cur) $("saved-as").textContent = `★ Saved as ${cur.name}`;
  }

  $("save-btn").addEventListener("click", () => {
    $("save-form").hidden = false;
    renderSaveRow();
    $("save-name").focus();
  });
  $("save-cancel").addEventListener("click", () => { $("save-form").hidden = true; renderSaveRow(); });
  $("save-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("save-name").value.trim();
    if (!name || state.lat == null) return;
    state.fields.push({ name, lat: +state.lat.toFixed(5), lon: +state.lon.toFixed(5) });
    saveList("spray:fields", state.fields);
    $("save-name").value = "";
    $("save-form").hidden = true;
    $("location-info").textContent = `${name} · ${state.lat.toFixed(4)}, ${state.lon.toFixed(4)}`;
    renderFields();
    renderSaveRow();
  });

  // ---------- Sensitive sites ----------
  const SITE_TYPES = ["Vineyard or orchard", "Vegetables or specialty crop", "Organic field", "Beehives", "Home or school", "Water or wetland", "Other"];
  const siteLayer = L.layerGroup().addTo(map);

  function drawSites() {
    siteLayer.clearLayers();
    state.sites.forEach((s) => {
      const m = L.circleMarker([s.lat, s.lon], {
        radius: 9, color: "#ffffff", weight: 2, fillColor: "#7b3fe4", fillOpacity: 0.95, bubblingMouseEvents: false,
      }).bindTooltip(s.name || s.type).addTo(siteLayer);
      m.on("click", () => sitePopup(s));
    });
  }

  function sitePopup(s) {
    const box = el("div", "site-form");
    box.appendChild(el("strong", null, s.name || s.type));
    if (s.name) box.appendChild(el("span", "muted", s.type));
    const rm = el("button", "link-btn", "Remove this site");
    rm.type = "button";
    rm.addEventListener("click", () => { map.closePopup(); removeSite(s); });
    box.appendChild(rm);
    L.popup().setLatLng([s.lat, s.lon]).setContent(box).openOn(map);
  }

  function newSitePopup(latlng) {
    setAddingSite(false);
    const form = el("form", "site-form");
    form.appendChild(el("strong", null, "Sensitive site"));
    const sel = el("select");
    SITE_TYPES.forEach((t) => { const o = el("option", null, t); o.value = t; sel.appendChild(o); });
    const name = el("input");
    name.type = "text"; name.maxLength = 40; name.placeholder = "Name (optional)";
    const row = el("div", "site-form-row");
    const ok = el("button", null, "Add");
    ok.type = "submit";
    const cancel = el("button", "link-btn", "Cancel");
    cancel.type = "button";
    row.append(ok, cancel);
    form.append(sel, name, row);
    const popup = L.popup({ closeButton: false }).setLatLng(latlng).setContent(form).openOn(map);
    cancel.addEventListener("click", () => map.closePopup(popup));
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      state.sites.push({ type: sel.value, name: name.value.trim(), lat: +latlng.lat.toFixed(5), lon: +latlng.lng.toFixed(5) });
      saveList("spray:sites", state.sites);
      map.closePopup(popup);
      drawSites();
      renderSiteList();
      render();
    });
  }

  function removeSite(s) {
    state.sites = state.sites.filter((x) => x !== s);
    saveList("spray:sites", state.sites);
    drawSites();
    renderSiteList();
    render();
  }

  function setAddingSite(on) {
    state.addingSite = on;
    $("map-banner").hidden = !on;
    $("answer").hidden = on;
    $("map").style.cursor = on ? "crosshair" : "";
  }
  $("add-site").addEventListener("click", () => {
    setAddingSite(true);
    $("map").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("banner-cancel").addEventListener("click", () => setAddingSite(false));

  // Distance (miles) and initial bearing (degrees) from the field to a point.
  function distBearing(lat1, lon1, lat2, lon2) {
    const rad = Math.PI / 180;
    const p1 = lat1 * rad, p2 = lat2 * rad, dl = (lon2 - lon1) * rad;
    const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    const dist = 2 * 3958.8 * Math.asin(Math.sqrt(a));
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return { dist, bearing: (Math.atan2(y, x) / rad + 360) % 360 };
  }
  const fmtDist = (mi) => (mi < 0.2 ? `${Math.round(mi * 5280 / 10) * 10} ft` : `${mi.toFixed(1)} mi`);

  // Marked sites near the current field, nearest first.
  function nearbySites() {
    if (state.lat == null) return [];
    return state.sites.map((s) => {
      const { dist, bearing } = distBearing(state.lat, state.lon, s.lat, s.lon);
      return { site: s, dist, bearing, label: s.name || s.type, where: `${fmtDist(dist)} ${compass(bearing)}` };
    }).filter((x) => x.dist <= R.SENSITIVE.radiusMi).sort((a, b) => a.dist - b.dist);
  }

  function renderSiteList() {
    const ul = $("site-list");
    ul.replaceChildren();
    const near = nearbySites();
    if (!near.length) {
      ul.appendChild(el("li", "muted", state.lat == null ? "Pick a field first." : "None marked within 2 miles of this field."));
    }
    near.forEach((x) => {
      const li = el("li");
      li.appendChild(el("span", "site-dot"));
      const t = el("span", null, x.label);
      t.appendChild(el("span", "muted", ` · ${x.site.name ? x.site.type + " · " : ""}${x.where}`));
      li.appendChild(t);
      const rm = el("button", "link-btn", "Remove");
      rm.type = "button";
      rm.addEventListener("click", () => removeSite(x.site));
      li.appendChild(rm);
      ul.appendChild(li);
    });
    const far = state.sites.length - near.length;
    if (far > 0 && state.lat != null) ul.appendChild(el("li", "muted", `${far} more marked farther than 2 miles away (not counted).`));
  }

  // ---------- View mode ----------
  function applyMode() {
    document.body.dataset.mode = state.mode;
    document.querySelectorAll(".mode-toggle button").forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.mode === state.mode)));
  }
  document.querySelectorAll(".mode-toggle button").forEach((b) =>
    b.addEventListener("click", () => {
      state.mode = b.dataset.mode;
      applyMode();
      savePrefs();
      render();
    }));
  applyMode();

  // ---------- Setup inputs (detailed view) ----------
  const inputs = { profile: $("profile-select"), boomIn: $("boom-input"), cropIn: $("crop-input"), minHours: $("minhours-input") };
  function fillInputs() {
    Object.keys(inputs).forEach((k) => { inputs[k].value = state.setup[k]; });
  }
  Object.keys(inputs).forEach((k) =>
    inputs[k].addEventListener("change", () => {
      state.setup = sanitize({ ...state.setup, [k]: inputs[k].value });
      fillInputs();
      savePrefs();
      render();
    }));
  $("reset-setup").addEventListener("click", () => {
    state.setup = { ...DEFAULTS };
    fillInputs();
    savePrefs();
    render();
  });
  fillInputs();

  // ---------- Search ----------
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
      if (!hits.length) return setStatus(`No match for “${q}”. Try a town name, or tap the map.`, true);
      setLocation(+hits[0].lat, +hits[0].lon, hits[0].display_name, true);
    } catch (err) {
      setStatus("Address search is unavailable right now. Tap the map instead.", true);
    }
  });

  $("locate-btn").addEventListener("click", () => {
    if (!navigator.geolocation) return setStatus("Your browser can't share its location.", true);
    setStatus("Finding your location…");
    navigator.geolocation.getCurrentPosition(
      (pos) => setLocation(pos.coords.latitude, pos.coords.longitude, "Your location", true),
      () => setStatus("Location access was blocked. Search or tap the map instead.", true),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  // ---------- Data ----------
  async function setLocation(lat, lon, label, zoom) {
    state.lat = lat; state.lon = lon; state.selectedDay = null;
    const saved = state.fields.find(isCurrent);
    if (!label && saved) label = saved.name;
    try { localStorage.setItem("spray:last", JSON.stringify({ lat, lon, label })); } catch (_) {}
    $("save-form").hidden = true;
    renderFields();
    renderSaveRow();
    renderSiteList();
    if (state.marker) state.marker.setLatLng([lat, lon]);
    else state.marker = L.marker([lat, lon]).addTo(map);
    if (zoom) map.setView([lat, lon], Math.max(map.getZoom(), 13));
    try { history.replaceState(null, "", `?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`); } catch (_) {}
    const info = $("location-info");
    info.textContent = `${label ? label + " · " : ""}${lat.toFixed(4)}, ${lon.toFixed(4)}`;
    info.hidden = false;

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
  const isDaylight = (day, h) => h.minutes + 60 > day.sunrise && h.minutes < day.sunset;

  function buildDays(d, setup, sites) {
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
      const wind10 = col("wind_speed_10m", i);
      const h = {
        time: t, minutes: minutesOf(t), hour: +t.slice(11, 13),
        wind10, wind: R.boomWind(wind10, setup), gust: col("wind_gusts_10m", i), dir: col("wind_direction_10m", i),
        t2: col("temperature_2m", i), t80: col("temperature_80m", i), rh: col("relative_humidity_2m", i),
        cloud: col("cloud_cover", i), precip: col("precipitation", i), pop: col("precipitation_probability", i),
      };
      h.past = nowHour !== null && t.slice(0, 13) < nowHour;
      h.now = nowHour !== null && t.slice(0, 13) === nowHour;
      h.score = R.scoreHour(h, { profile: setup.profile, sunrise: day.sunrise, sunset: day.sunset, sites });
      day.hours.push(h);
    });

    days.forEach((day) => {
      day.windows = runs(day.hours, (h) => !h.past && h.score.level === R.LEVEL.GOOD)
        .filter((w) => w.hours.length >= setup.minHours);
      day.limits = runsByKey(day.hours.filter((h) => !h.past && isDaylight(day, h) && h.score.level > 0));
      day.summary = summarize(day, setup);
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

  const mostCommon = (xs) => {
    const n = new Map();
    xs.forEach((x) => n.set(x, (n.get(x) || 0) + 1));
    return [...n.entries()].sort((a, b) => b[1] - a[1])[0][0];
  };
  const longest = (ws) => ws.reduce((a, b) => (b.hours.length > a.hours.length ? b : a));

  // One headline per day: level, a short status word and one line of text.
  function summarize(day, setup) {
    const live = day.hours.filter((h) => !h.past && isDaylight(day, h));
    if (!live.length) return { level: null, label: "Over", text: "This day is over." };
    if (day.windows.length) {
      const best = longest(day.windows);
      const more = day.windows.length > 1 ? ` (+${day.windows.length - 1} more)` : "";
      return { level: R.LEVEL.GOOD, label: "Good window", text: `${span(best.start, best.end)}${more}`, best };
    }
    if (live.some((h) => h.score.level === R.LEVEL.GOOD))
      return { level: R.LEVEL.CAUTION, label: "Short windows", text: `Good spells shorter than ${setup.minHours} h` };
    const caution = live.filter((h) => h.score.level === R.LEVEL.CAUTION);
    const pool = caution.length ? caution : live;
    return {
      level: caution.length ? R.LEVEL.CAUTION : R.LEVEL.NO,
      label: caution.length ? "Caution only" : "No window",
      text: mostCommon(pool.map((h) => h.score.primary.short)),
    };
  }

  // ---------- Formatting ----------
  const hourLabel = (h) => {
    h = ((h % 24) + 24) % 24;
    if (h === 0) return "12 AM";
    if (h === 12) return "Noon";
    return h < 12 ? `${h} AM` : `${h - 12} PM`;
  };
  const timeLabel = (min) => {
    const h = Math.floor(min / 60), m = String(min % 60).padStart(2, "0");
    return `${h % 12 || 12}:${m} ${h < 12 ? "AM" : "PM"}`;
  };
  const span = (a, b) => `${hourLabel(a)}–${hourLabel(b)}`;
  const compass = (deg) => (deg == null ? "" : COMPASS[Math.round(deg / 22.5) % 16]);
  const dayName = (date, i) => {
    if (i === 0) return "Today";
    if (i === 1) return "Tomorrow";
    return new Date(date + "T12:00:00").toLocaleDateString(undefined, { weekday: "long" });
  };
  const dayShort = (date, i) => (i === 0 ? "Today" : new Date(date + "T12:00:00").toLocaleDateString(undefined, { weekday: "short" }));
  const dateShort = (date) => new Date(date + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const toF = (c) => Math.round(c * 9 / 5 + 32);

  function windowWind(w) {
    const speeds = w.hours.map((h) => h.wind).filter((x) => x != null);
    const dirs = w.hours.map((h) => compass(h.dir));
    const mode = dirs.sort((a, b) => dirs.filter((x) => x === b).length - dirs.filter((x) => x === a).length)[0];
    if (!speeds.length) return "";
    const lo = Math.round(Math.min(...speeds)), hi = Math.round(Math.max(...speeds));
    return `winds ${mode} ${lo === hi ? lo : lo + "–" + hi} mph at boom`;
  }

  function confidence(i) {
    if (i <= 1) return { text: "HRRR 2-mile grid · high detail", cls: "conf-high" };
    if (i <= 3) return { text: "GFS · moderate confidence", cls: "conf-mid" };
    return { text: "GFS · for tentative planning", cls: "conf-low" };
  }

  function setupText(s) {
    const over = s.cropIn > 0 ? `a ${s.cropIn} in crop` : "bare ground";
    return `a ${s.boomIn} in boom over ${over}`;
  }

  // ---------- Rendering helpers ----------
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function icon(level, cls) {
    const s = el("span", `badge-icon lvl-${level}${cls ? " " + cls : ""}`);
    s.innerHTML = ICONS[level]; // static markup from ICONS above
    return s;
  }

  function setStatus(msg, isError) {
    $("answer-icon").hidden = true;
    $("answer-link").hidden = true;
    const t = $("answer-text");
    t.textContent = msg;
    t.classList.toggle("error", !!isError);
  }

  function selectDay(i) {
    state.selectedDay = i;
    render();
    const target = state.mode === "simple" ? $("day-panel") : $(`day-${i}`);
    if (target) target.scrollIntoView({ block: "nearest" });
  }

  // ---------- Render ----------
  function render() {
    if (!state.data) return;
    const d = state.data;
    const setup = state.setup;
    const sites = nearbySites();
    const days = buildDays(d, setup, sites);

    if (state.selectedDay == null) {
      const firstGood = days.find((day) => day.windows.length);
      const firstLive = days.find((day) => day.summary.level != null);
      state.selectedDay = (firstGood || firstLive || days[0]).index;
    }

    const next = findNext(days);
    renderAnswer(next);
    renderHero(days, next);
    $("setup-note").textContent = state.mode === "simple"
      ? `Rated for ${setupText(setup)}, using ${setup.profile === "restricted" ? "restricted-label" : "general"} rules${sites.length ? `, watching ${sites.length} sensitive site${sites.length > 1 ? "s" : ""} nearby` : ""}. Change this in the Detailed view.`
      : "";
    $("setup-note").hidden = state.mode !== "simple";
    $("setup-readout").textContent =
      `Wind at your boom ≈ ${Math.round(R.boomFactor(setup) * 100)}% of the 33 ft forecast (FAO-56 Eq. 47), with the boom ${((setup.cropIn + setup.boomIn) / 12).toFixed(1)} ft above the ground.`;

    renderWeek(days);
    if (state.mode === "simple") {
      renderDayPanel(days[state.selectedDay] || days[0]);
    } else {
      const hasT80 = (d.hourly.temperature_80m || []).some((x) => x != null);
      $("forecast-meta").textContent = `Model grid cell at ${Math.round(d.elevation * 3.281)} ft elevation · times in ${d.timezone_abbreviation || d.timezone}` +
        (hasT80 ? "" : " · Upper-air temperatures are missing, so inversions are estimated from calm, clear conditions.");
      const wrap = $("days");
      wrap.replaceChildren();
      days.forEach((day) => wrap.appendChild(renderDay(day)));
    }
    $("results").hidden = false;
  }

  // The window happening now, or the next one coming up.
  function findNext(days) {
    for (const day of days) {
      for (const w of day.windows) return { day, w, now: w.hours[0].now };
    }
    return null;
  }

  function nextText(next) {
    if (!next) return "No good spray window in the next 7 days";
    if (next.now) return `Good to spray now, until ${hourLabel(next.w.end)}`;
    return `${dayName(next.day.date, next.day.index)}, ${span(next.w.start, next.w.end)}`;
  }

  function renderAnswer(next) {
    const ic = $("answer-icon");
    const level = next ? R.LEVEL.GOOD : R.LEVEL.NO;
    ic.className = `badge-icon lvl-${level}`;
    ic.innerHTML = ICONS[level];
    ic.hidden = false;
    const t = $("answer-text");
    t.classList.remove("error");
    t.textContent = next && !next.now ? `Next good window: ${nextText(next)}` : nextText(next);
    $("answer-link").hidden = false;
  }

  function renderHero(days, next) {
    const box = $("hero");
    box.replaceChildren();
    const level = next ? R.LEVEL.GOOD : R.LEVEL.NO;
    box.className = `hero lvl-${level}`;
    box.appendChild(icon(level));
    const body = el("div");
    body.appendChild(el("p", "hero-kicker", next ? (next.now ? "Right now" : "Next good spray window") : "This week"));
    body.appendChild(el("p", "hero-main", nextText(next)));
    if (next) {
      body.appendChild(el("p", "hero-sub", `${next.w.hours.length} h · ${windowWind(next.w)}`));
      const rest = days.flatMap((day) => day.windows.map((w) => ({ day, w }))).filter((x) => x.w !== next.w).slice(0, 4);
      if (rest.length) {
        const also = el("p", "also");
        also.appendChild(el("span", null, "Also good:"));
        rest.forEach(({ day, w }) => {
          const b = el("button", "chip", `${dayShort(day.date, day.index)} ${span(w.start, w.end)}`);
          b.type = "button";
          b.addEventListener("click", () => selectDay(day.index));
          also.appendChild(b);
        });
        body.appendChild(also);
      }
    } else {
      const live = days.flatMap((day) => day.hours.filter((h) => !h.past && isDaylight(day, h) && h.score.primary));
      const reason = live.length ? mostCommon(live.map((h) => h.score.primary.short)) : null;
      body.appendChild(el("p", "hero-sub", (reason ? `Mostly limited by: ${reason}. ` : "") +
        "Amber (caution) hours may still work with extra care."));
    }
    box.appendChild(body);
  }

  function renderWeek(days) {
    const wrap = $("week");
    wrap.replaceChildren();
    days.forEach((day) => {
      const s = day.summary;
      const tile = el("button", `tile${s.level != null ? " lvl-" + s.level : " over"}${day.index === state.selectedDay ? " selected" : ""}`);
      tile.type = "button";
      tile.setAttribute("aria-label", `${dayName(day.date, day.index)} ${dateShort(day.date)}: ${s.label}. ${s.text}`);

      const when = el("span", "tile-when");
      when.appendChild(el("span", "tile-day", dayShort(day.date, day.index)));
      when.appendChild(el("span", "tile-date", ` ${dateShort(day.date)}`));
      tile.appendChild(when);

      if (s.level != null) {
        const st = el("span", "tile-status");
        st.appendChild(icon(s.level));
        st.appendChild(el("span", null, s.label));
        tile.appendChild(st);
      }
      tile.appendChild(el("span", "tile-text", s.text));

      const mini = el("span", "mini");
      day.hours.filter((h) => isDaylight(day, h)).forEach((h) =>
        mini.appendChild(el("i", h.past ? "past" : `lvl-${h.score.level}`)));
      tile.appendChild(mini);

      tile.addEventListener("click", () => selectDay(day.index));
      wrap.appendChild(tile);
    });
  }

  // Simple view: one day, daylight hours only, in plain sentences.
  function renderDayPanel(day) {
    const box = $("day-panel");
    box.replaceChildren();
    const head = el("div", "day-panel-head");
    const title = el("h3", null, dayName(day.date, day.index));
    title.appendChild(el("span", "tile-date", ` ${dateShort(day.date)}`));
    head.appendChild(title);
    const c = confidence(day.index);
    head.appendChild(el("span", `conf ${c.cls}`, c.text));
    box.appendChild(head);

    const hours = day.hours.filter((h) => isDaylight(day, h));
    const bar = el("div", "daybar");
    const axis = el("div", "daybar-axis");
    hours.forEach((h, i) => {
      const reason = h.score.primary ? ` – ${h.score.primary.short}` : "";
      const cell = el("span", h.past ? "past" : `lvl-${h.score.level}`);
      cell.title = `${hourLabel(h.hour)}: ${h.past ? "Past" : R.LEVEL_NAME[h.score.level] + reason}`;
      bar.appendChild(cell);
      axis.appendChild(el("span", null, i % 3 === 0 ? hourLabel(h.hour) : ""));
    });
    box.appendChild(bar);
    box.appendChild(axis);

    const lines = [
      ...day.windows.map((w) => ({ start: w.start, level: R.LEVEL.GOOD, main: `Good to spray ${span(w.start, w.end)}`, sub: windowWind(w) })),
      ...day.limits.filter((r) => r.level === R.LEVEL.NO || r.end - r.start >= 2)
        .map((r) => ({ start: r.start, level: r.level, main: `${r.short} ${span(r.start, r.end)}`, sub: "" })),
    ].sort((a, b) => a.start - b.start);

    const ul = el("ul", "day-lines");
    if (!lines.length) ul.appendChild(el("li", "muted", day.summary.text));
    lines.forEach((x) => {
      const li = el("li");
      li.appendChild(icon(x.level));
      const t = el("span", null, x.main);
      if (x.sub) t.appendChild(el("span", "muted", ` · ${x.sub}`));
      li.appendChild(t);
      ul.appendChild(li);
    });
    box.appendChild(ul);
    box.appendChild(el("p", "sun", `Sunrise ${timeLabel(day.sunrise)} · Sunset ${timeLabel(day.sunset)} · Switch to Detailed for every hour and the reasons behind it.`));
  }

  // Detailed view: all 24 hours, tap an hour for its factors.
  function renderDay(day) {
    const card = el("article", "day");
    card.id = `day-${day.index}`;
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
    card.appendChild(el("p", "strip-note", `The number in each hour is wind speed in mph at boom height, for ${setupText(state.setup)}. Tap an hour to see why it got that rating.`));
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
      h.wind != null && `Wind ${Math.round(h.wind)} mph at boom height (${Math.round(h.wind10)} mph at 33 ft) from ${compass(h.dir)}`,
      h.gust != null && `Gusts ${Math.round(h.gust)} mph at 33 ft`,
      h.t2 != null && `Temperature ${toF(h.t2)} °F`,
      h.rh != null && `Humidity ${Math.round(h.rh)}%`,
      h.cloud != null && `Cloud cover ${Math.round(h.cloud)}%`,
      h.pop != null && `Rain chance ${Math.round(h.pop)}%`,
    ].filter(Boolean);
    box.appendChild(el("p", "facts muted", facts.join(" · ")));
  }

  // ---------- Startup ----------
  // A shared or bookmarked link (?lat=..&lon=..) opens straight to that field.
  const qs = new URLSearchParams(location.search);
  const qLat = parseFloat(qs.get("lat")), qLon = parseFloat(qs.get("lon"));
  drawSites();
  renderFields();
  renderSiteList();
  if (Math.abs(qLat) <= 90 && Math.abs(qLon) <= 180) setLocation(qLat, qLon, null, true);
  else {
    // Reopen the last field viewed in this browser.
    try {
      const last = JSON.parse(localStorage.getItem("spray:last") || "null");
      if (last && Math.abs(last.lat) <= 90 && Math.abs(last.lon) <= 180) setLocation(last.lat, last.lon, last.label, true);
    } catch (_) {}
  }
})();
