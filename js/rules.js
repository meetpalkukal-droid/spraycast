/* Spray-condition rules: turn hourly forecast values into Good / Caution / Do not spray.
 * Bracketed numbers refer to the Sources section in index.html and README.md.
 * Thresholds marked PROTOTYPE are placeholders pending review by Extension specialists.
 */
(function (global) {
  "use strict";

  const LEVEL = { GOOD: 0, CAUTION: 1, NO: 2 };
  const LEVEL_NAME = ["Good", "Caution", "Do not spray"];

  const PROFILES = {
    general: {
      label: "General guidance (most products)",
      calmNo: 2,         // below this, effectively calm: drift + inversion risk [1][3]
      windMin: 3,        // 3–7 mph preferred [3]
      windIdeal: 7,
      windMax: 10,       // avoid spraying above 10 mph [3]
      labelTiming: false,
    },
    restricted: {
      label: "Restricted label (dicamba-style rules)",
      calmNo: 3,         // label: no application below 3 mph [4]
      windMin: 3,
      windIdeal: 10,
      windMax: 10,       // label: no application above 10 mph [4]
      labelTiming: true, // label: 1 h after sunrise to 2 h before sunset [4]
    },
  };

  // Wind thresholds apply at boom height, as the labels specify [4]. The forecast is for 10 m,
  // so it is scaled with the FAO-56 logarithmic wind profile over short grass (Eq. 47) [10]:
  //   u(z) = u10 · ln(67.8 z − 5.42) / ln(67.8 · 10 − 5.42)
  // Crop height only sets how high the boom is: z = crop height + boom height above the crop.
  const IN_TO_M = 0.0254;
  // Boom 24 in: label maximum boom height above the target or crop canopy [4]. Crop 1 m (39.4 in).
  const DEFAULT_SETUP = { boomIn: 24, cropIn: Math.round(100 / 2.54 * 10) / 10 };

  const windAtHeight = (u10, z) => u10 * Math.log(67.8 * z - 5.42) / Math.log(67.8 * 10 - 5.42);
  // Ratio of boom-height wind to 10 m wind.
  const boomFactor = (setup) => {
    const s = setup || DEFAULT_SETUP;
    return windAtHeight(1, (s.cropIn + s.boomIn) * IN_TO_M);
  };
  const boomWind = (u10, setup) => (isNum(u10) ? u10 * boomFactor(setup) : null);

  const GUST = { caution: 12, no: 15, spread: 8 };   // mph at 10 m, PROTOTYPE
  const INVERSION = { no: 0, caution: -0.3 };        // T(80 m) − T(2 m) in °C [1][5]
  const DELTA_T = { low: 2, high: 8, no: 10 };       // °C [6]; shown as 3.6 / 14.4 / 18 °F
  const RAIN = { no: 0.02, popCaution: 50 };         // inches per hour, % chance; PROTOTYPE

  // Wet-bulb temperature from air temperature (°C) and RH (%), Stull 2011 [7].
  function wetBulb(t, rh) {
    return t * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) +
      Math.atan(t + rh) - Math.atan(rh - 1.676331) +
      0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh) - 4.686035;
  }

  const fmt1 = (x) => (Math.round(x * 10) / 10).toFixed(1);
  const dF = (c) => c * 9 / 5;
  const isNum = (x) => typeof x === "number" && !Number.isNaN(x);

  /* h: { minutes, wind (boom height), wind10, gust, t2, t80, rh, cloud, precip, pop }
   * ctx: { profile, sunrise, sunset }  (sunrise/sunset in minutes after local midnight)
   */
  function scoreHour(h, ctx) {
    const p = PROFILES[ctx.profile] || PROFILES.general;
    const factors = [];
    const add = (key, level, short, text) => factors.push({ key, level, short, text });

    if (isNum(h.wind)) {
      const w = Math.round(h.wind);
      if (h.wind < p.calmNo) add("calm", LEVEL.NO, "Too calm", `Wind ${w} mph at boom height is too calm. Spray can hang and drift, and inversions are likely.`);
      else if (h.wind < p.windMin) add("calm", LEVEL.CAUTION, "Light wind", `Wind ${w} mph at boom height is below the preferred 3 mph minimum.`);
      else if (h.wind > p.windMax) add("windy", LEVEL.NO, "Too windy", `Wind ${w} mph at boom height is above the ${p.windMax} mph limit.`);
      else if (h.wind > p.windIdeal) add("windy", LEVEL.CAUTION, "Breezy", `Wind ${w} mph at boom height is above the preferred ${p.windIdeal} mph. Use coarse droplets.`);
      else add("wind", LEVEL.GOOD, "Wind OK", `Wind ${w} mph at boom height is in range.`);
    }

    if (isNum(h.gust)) {
      const g = Math.round(h.gust);
      if (h.gust >= GUST.no) add("gust", LEVEL.NO, "Gusty", `Gusts up to ${g} mph.`);
      else if (h.gust >= GUST.caution || (isNum(h.wind10) && h.gust - h.wind10 >= GUST.spread))
        add("gust", LEVEL.CAUTION, "Gusty", `Gusts up to ${g} mph, which makes wind unsteady.`);
      else add("gust", LEVEL.GOOD, "Gusts OK", `Gusts up to ${g} mph.`);
    }

    if (isNum(h.t80) && isNum(h.t2)) {
      const d = h.t80 - h.t2;
      const dTxt = `${d >= 0 ? "+" : ""}${fmt1(dF(d))} °F`;
      if (d > INVERSION.no) add("inversion", LEVEL.NO, "Inversion", `Inversion: air at 260 ft is warmer than at 6 ft (${dTxt}). Fine droplets can stay trapped and move off-target.`);
      else if (d > INVERSION.caution) add("inversion", LEVEL.CAUTION, "Stable air", `Little cooling with height (${dTxt} from 6 to 260 ft). The air is stable, so an inversion may be forming.`);
      else add("inversion", LEVEL.GOOD, "No inversion", `Normal cooling with height (${dTxt} from 6 to 260 ft).`);
    } else if (isNum(h.wind10) && isNum(h.cloud)) {
      // No upper-air temperature returned: fall back to the calm + clear + dawn/dusk proxy [1].
      const nearDawnDusk = h.minutes < ctx.sunrise + 120 || h.minutes + 60 > ctx.sunset - 60;
      if (h.wind10 < 5 && h.cloud < 30 && nearDawnDusk)
        add("inversion", LEVEL.CAUTION, "Inversion likely", "Calm, clear conditions near dawn or dusk favor inversions. No upper-air data was available for this hour.");
    }

    if (isNum(h.t2) && isNum(h.rh)) {
      const dt = h.t2 - wetBulb(h.t2, Math.min(Math.max(h.rh, 5), 99));
      const dtTxt = `Delta T ${fmt1(dF(dt))} °F`;
      if (dt > DELTA_T.no) add("deltat-high", LEVEL.NO, "Too hot/dry", `${dtTxt}. Droplets evaporate fast and fines can drift far.`);
      else if (dt > DELTA_T.high) add("deltat-high", LEVEL.CAUTION, "Hot/dry", `${dtTxt} is above 14.4 °F. Evaporation is high, so use coarser droplets.`);
      else if (dt < DELTA_T.low) add("deltat-low", LEVEL.CAUTION, "Humid", `${dtTxt} is below 3.6 °F. Fine droplets last longer, so watch for inversions.`);
      else add("deltat", LEVEL.GOOD, "Delta T OK", `${dtTxt} is within the 3.6–14.4 °F range.`);
    }

    if (isNum(h.precip) && h.precip >= RAIN.no) add("rain", LEVEL.NO, "Rain", `Rain expected (${h.precip.toFixed(2)} in).`);
    else if (isNum(h.pop) && h.pop >= RAIN.popCaution) add("rain", LEVEL.CAUTION, "Rain chance", `${Math.round(h.pop)}% chance of rain.`);

    if (p.labelTiming) {
      const ok = h.minutes >= ctx.sunrise + 60 && h.minutes + 60 <= ctx.sunset - 120;
      if (!ok) add("timing", LEVEL.NO, "Outside label hours", "Outside the label window, which runs from 1 h after sunrise to 2 h before sunset.");
    } else if (h.minutes + 60 <= ctx.sunrise || h.minutes >= ctx.sunset) {
      add("night", LEVEL.CAUTION, "Night", "Night hours carry a higher inversion risk. Check the product label.");
    }

    factors.sort((a, b) => b.level - a.level);
    const level = factors.reduce((m, f) => Math.max(m, f.level), 0);
    return { level, primary: level > 0 ? factors[0] : null, factors };
  }

  global.SprayRules = { LEVEL, LEVEL_NAME, PROFILES, DEFAULT_SETUP, scoreHour, wetBulb, windAtHeight, boomFactor, boomWind };
})(window);
