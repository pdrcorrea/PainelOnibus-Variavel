const CONFIG = {
  TIME_WINDOW_HOURS: 2,
  SWEEP_POINTS: 12,
  SWEEP_RADIUS_M: 1200,
  PAST_TOLERANCE_MS: 20_000,

  // Dados de transporte são considerados "frescos" por 10 minutos.
  FRESH_TTL_MS: 10 * 60 * 1000,

  // Mantemos uma cópia por até 1 hora para fallback em caso de falha do Google.
  STALE_TTL_SECONDS: 60 * 60,

  // O endereço do ponto praticamente não muda.
  GEOCODE_TTL_MS: 7 * 24 * 60 * 60 * 1000,
  GEOCODE_CACHE_SECONDS: 8 * 24 * 60 * 60
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (request.method !== "GET") {
      return json({ error: "method_not_allowed" }, 405);
    }

    if (url.pathname === "/health") {
      return json({
        ok: true,
        service: "pontoview-bus-api",
        now: new Date().toISOString()
      });
    }

    if (url.pathname !== "/" && url.pathname !== "/api/bus") {
      return json({ error: "not_found" }, 404);
    }

    if (!env.GOOGLE_MAPS_API_KEY) {
      return json({ error: "google_maps_key_missing" }, 500);
    }

    const station = (url.searchParams.get("station") || env.DEFAULT_STATION || "").trim();

    if (!station) {
      return json({ error: "station_required" }, 400);
    }

    if (station.length > 300) {
      return json({ error: "station_too_long" }, 400);
    }

    const cache = caches.default;
    const cacheKey = buildBusCacheKey(request.url, station);
    const now = Date.now();

    let cachedPayload = null;

    try {
      const cachedResponse = await cache.match(cacheKey);

      if (cachedResponse) {
        cachedPayload = await cachedResponse.json();
        const ageMs = now - Number(cachedPayload.generatedAt || 0);

        if (ageMs >= 0 && ageMs < CONFIG.FRESH_TTL_MS) {
          const payload = preparePayloadForNow(cachedPayload, now);

          return json({
            ...payload,
            cache: {
              status: "HIT",
              ageSeconds: Math.floor(ageMs / 1000),
              freshForSeconds: Math.max(0, Math.ceil((CONFIG.FRESH_TTL_MS - ageMs) / 1000))
            }
          }, 200, { "X-PontoView-Cache": "HIT" });
        }
      }
    } catch (error) {
      console.warn("Falha ao ler cache:", error);
    }

    try {
      const freshPayload = await fetchBusData(station, env.GOOGLE_MAPS_API_KEY, cache, ctx);

      ctx.waitUntil(
        cache.put(
          cacheKey,
          new Response(JSON.stringify(freshPayload), {
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": `public, max-age=${CONFIG.STALE_TTL_SECONDS}`
            }
          })
        )
      );

      return json({
        ...freshPayload,
        cache: {
          status: "MISS",
          ageSeconds: 0,
          freshForSeconds: Math.floor(CONFIG.FRESH_TTL_MS / 1000)
        }
      }, 200, { "X-PontoView-Cache": "MISS" });
    } catch (error) {
      console.error("Falha ao atualizar dados:", error);

      if (cachedPayload) {
        const ageMs = now - Number(cachedPayload.generatedAt || 0);

        if (ageMs >= 0 && ageMs <= CONFIG.STALE_TTL_SECONDS * 1000) {
          const payload = preparePayloadForNow(cachedPayload, now);

          return json({
            ...payload,
            warning: "google_unavailable_using_cache",
            cache: {
              status: "STALE",
              ageSeconds: Math.floor(ageMs / 1000),
              freshForSeconds: 0
            }
          }, 200, { "X-PontoView-Cache": "STALE" });
        }
      }

      return json({
        error: "bus_data_unavailable",
        message: safeErrorMessage(error)
      }, 502);
    }
  }
};

async function fetchBusData(station, apiKey, cache, ctx) {
  const geo = await geocodeStation(station, apiKey, cache, ctx);

  const stationLatLng = {
    lat: geo.geometry.location.lat,
    lng: geo.geometry.location.lng
  };

  const destinations = buildSweepDestinations(stationLatLng);
  const departureTime = Math.floor(Date.now() / 1000);

  const responses = await Promise.all(
    destinations.map((destination) =>
      fetchDirections(stationLatLng, destination, departureTime, apiKey)
    )
  );

  const allTrips = [];
  let successfulRequests = 0;

  for (const response of responses) {
    if (!response.ok) continue;
    successfulRequests += 1;
    allTrips.push(...extractTrips(response.data));
  }

  if (!successfulRequests) {
    throw new Error("Nenhuma consulta de transporte retornou dados válidos.");
  }

  const now = Date.now();
  const cards = aggregateTrips(allTrips, now);

  return {
    version: 1,
    station: {
      query: station,
      label: buildStationLabel(geo),
      location: stationLatLng
    },
    generatedAt: now,
    generatedAtIso: new Date(now).toISOString(),
    timeWindowHours: CONFIG.TIME_WINDOW_HOURS,
    cards,
    diagnostics: {
      sweepPoints: CONFIG.SWEEP_POINTS,
      successfulRequests,
      totalRequests: destinations.length
    }
  };
}

async function geocodeStation(station, apiKey, cache, ctx) {
  const cacheKey = new Request(
    `https://pontoview-cache.invalid/geocode?station=${encodeURIComponent(normalizeStation(station))}`,
    { method: "GET" }
  );

  try {
    const cached = await cache.match(cacheKey);

    if (cached) {
      const payload = await cached.json();
      const ageMs = Date.now() - Number(payload.cachedAt || 0);

      if (
        ageMs >= 0 &&
        ageMs < CONFIG.GEOCODE_TTL_MS &&
        payload.result?.geometry?.location
      ) {
        return payload.result;
      }
    }
  } catch (error) {
    console.warn("Falha ao ler cache de geocoding:", error);
  }

  const params = new URLSearchParams({
    address: station,
    key: apiKey,
    language: "pt-BR",
    region: "br"
  });

  const response = await fetch(
    `https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`
  );

  if (!response.ok) {
    throw new Error(`Geocoding HTTP ${response.status}`);
  }

  const data = await response.json();

  if (data.status !== "OK" || !data.results?.[0]) {
    throw new Error(`Geocoding falhou: ${data.status || "UNKNOWN"}`);
  }

  const result = data.results[0];

  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(
        JSON.stringify({
          cachedAt: Date.now(),
          result
        }),
        {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": `public, max-age=${CONFIG.GEOCODE_CACHE_SECONDS}`
          }
        }
      )
    )
  );

  return result;
}

async function fetchDirections(origin, destination, departureTime, apiKey) {
  const params = new URLSearchParams({
    origin: `${origin.lat},${origin.lng}`,
    destination: `${destination.lat},${destination.lng}`,
    mode: "transit",
    alternatives: "true",
    departure_time: String(departureTime),
    language: "pt-BR",
    region: "br",
    key: apiKey
  });

  try {
    const response = await fetch(
      `https://maps.googleapis.com/maps/api/directions/json?${params.toString()}`
    );

    if (!response.ok) {
      return { ok: false, status: `HTTP_${response.status}` };
    }

    const data = await response.json();

    if (data.status !== "OK") {
      return { ok: false, status: data.status || "UNKNOWN" };
    }

    return { ok: true, data };
  } catch (error) {
    return { ok: false, status: safeErrorMessage(error) };
  }
}

function extractTrips(result) {
  const trips = [];

  for (const route of result?.routes || []) {
    const leg = route?.legs?.[0];
    if (!leg?.steps?.length) continue;

    for (const step of leg.steps) {
      if (step.travel_mode !== "TRANSIT" || !step.transit_details) continue;

      const td = step.transit_details;
      const line = td.line || {};

      const lineShort = line.short_name || line.name || "—";
      const headsign =
        td.headsign ||
        line.name ||
        td.arrival_stop?.name ||
        "Destino";

      const departureSeconds = Number(td.departure_time?.value);
      if (!Number.isFinite(departureSeconds)) continue;

      const departureMs = departureSeconds * 1000;

      const agency =
        line.agencies?.[0]?.name ||
        line.agencies?.[0]?.short_name ||
        "";

      const agencyLabel = String(agency).trim()
        ? String(agency).trim()
        : `LINHA ${String(lineShort).trim() || "—"}`;

      const lineColor = normalizeHexColor(line.color) || "#0f3d63";

      trips.push({
        line: String(lineShort),
        destination: String(headsign),
        timeMs: departureMs,
        agency: agencyLabel,
        lineColor,
        key: `${lineShort}|${headsign}|${departureMs}|${agencyLabel}|${lineColor}`
      });
    }
  }

  return trips;
}

function aggregateTrips(allTrips, now) {
  const end = now + CONFIG.TIME_WINDOW_HOURS * 60 * 60 * 1000;

  const unique = new Map();
  for (const trip of allTrips) unique.set(trip.key, trip);

  const groups = new Map();

  for (const trip of unique.values()) {
    if (trip.timeMs < now - CONFIG.PAST_TOLERANCE_MS) continue;
    if (trip.timeMs > end) continue;

    const key = [
      trip.line,
      trip.destination,
      trip.agency || "",
      trip.lineColor || ""
    ].join("||");

    if (!groups.has(key)) {
      groups.set(key, {
        line: trip.line,
        destination: trip.destination,
        times: [],
        agency: trip.agency || "",
        lineColor: trip.lineColor || "#0f3d63"
      });
    }

    groups.get(key).times.push(trip.timeMs);
  }

  const cards = [];

  for (const group of groups.values()) {
    group.times = [...new Set(group.times)].sort((a, b) => a - b);
    if (!group.times.length) continue;

    cards.push({
      ...group,
      nextTime: group.times[0]
    });
  }

  cards.sort((a, b) => a.nextTime - b.nextTime);
  return cards;
}

function preparePayloadForNow(payload, now) {
  const end = now + CONFIG.TIME_WINDOW_HOURS * 60 * 60 * 1000;

  const cards = (payload.cards || [])
    .map((card) => {
      const times = (card.times || [])
        .filter(
          (time) =>
            Number.isFinite(Number(time)) &&
            Number(time) >= now - CONFIG.PAST_TOLERANCE_MS &&
            Number(time) <= end
        )
        .map(Number)
        .sort((a, b) => a - b);

      if (!times.length) return null;

      return {
        ...card,
        times,
        nextTime: times[0]
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.nextTime - b.nextTime);

  return {
    ...payload,
    cards
  };
}

function buildSweepDestinations(stationLatLng) {
  const points = [];

  for (let i = 0; i < CONFIG.SWEEP_POINTS; i++) {
    const bearing = i * (360 / CONFIG.SWEEP_POINTS);

    points.push(
      destinationPoint(
        stationLatLng.lat,
        stationLatLng.lng,
        bearing,
        CONFIG.SWEEP_RADIUS_M
      )
    );
  }

  return points;
}

function destinationPoint(lat, lng, bearingDeg, distanceM) {
  const earthRadius = 6_371_000;
  const bearing = toRad(bearingDeg);
  const angularDistance = distanceM / earthRadius;
  const lat1 = toRad(lat);
  const lng1 = toRad(lng);

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) +
      Math.cos(lat1) *
        Math.sin(angularDistance) *
        Math.cos(bearing)
  );

  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(bearing) *
        Math.sin(angularDistance) *
        Math.cos(lat1),
      Math.cos(angularDistance) -
        Math.sin(lat1) * Math.sin(lat2)
    );

  return {
    lat: toDeg(lat2),
    lng: toDeg(lng2)
  };
}

function buildStationLabel(geo) {
  const components = geo?.address_components || [];

  const pick = (type, short = false) => {
    const item = components.find((component) =>
      (component.types || []).includes(type)
    );

    if (!item) return "";
    return short ? item.short_name || item.long_name || "" : item.long_name || item.short_name || "";
  };

  const neighborhood =
    pick("neighborhood") ||
    pick("sublocality_level_1") ||
    pick("sublocality");

  const city =
    pick("locality") ||
    pick("administrative_area_level_2");

  const state = pick("administrative_area_level_1", true);

  if (!neighborhood && city) return `Centro, ${city}`;
  if (neighborhood && city && state) return `${neighborhood}, ${city} - ${state}`;
  if (neighborhood && city) return `${neighborhood}, ${city}`;
  if (city && state) return `${city} - ${state}`;
  if (city) return city;

  return geo?.formatted_address || "Local";
}

function buildBusCacheKey(requestUrl, station) {
  const original = new URL(requestUrl);

  const cacheUrl = new URL("https://pontoview-cache.invalid/api/bus");
  cacheUrl.searchParams.set("station", normalizeStation(station));

  // Mantém o cache independente do domínio público do Worker.
  return new Request(cacheUrl.toString(), { method: "GET" });
}

function normalizeStation(value) {
  return String(value)
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("pt-BR");
}

function normalizeHexColor(value) {
  const color = String(value || "").trim();

  if (/^#[0-9a-f]{6}$/i.test(color)) return color;
  if (/^[0-9a-f]{6}$/i.test(color)) return `#${color}`;

  return "";
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function toDeg(rad) {
  return (rad * 180) / Math.PI;
}

function safeErrorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error || "unknown_error");
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(),
      ...extraHeaders
    }
  });
}
