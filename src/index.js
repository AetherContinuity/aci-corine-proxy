// aci-corine-proxy
// D_f (fragmentaatio) -datalähde BEM:lle (Biodiversity Endurance Monitor).
// Hakee SYKE:n avoimesta inspire_lc WMS -rajapinnasta (CorineLandCover2018),
// ei autentikointia. Katso: https://ckan.ymparisto.fi/dataset/syke-maanpeite-wcs
//
// TÄRKEÄ HUOMIO: tämä on ruudukkopisteotantaan perustuva PROXY, ei todellinen
// laikkukoko/reunatiheys-fragmentaatioanalyysi. Todellinen fragmentaatioanalyysi
// vaatisi täyden raster/vektori-topologia-käsittelyn (GeoPandas/Rasterio-tasoinen
// putki, kuvattu TN-015:n arkkitehtuuriosiossa, "Pre-development"-tilassa).

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*"
};

const DEFAULT_BBOX = "26.00,62.40,27.50,63.50"; // Rautalammin reitti pilottialue

const SYKE_WMS = "https://paikkatiedot.ymparisto.fi/geoserver/inspire_lc/wms";
const LAYER = "LC.LandCoverSurfaces.2018";
const FOREST_CLASSES = new Set([311, 312, 313]); // CLC level3: metsätyypit
const REF_FOREST_AREA_M2 = 10_000_000; // 10 km² viite "ehjälle" metsälaikulle — dokumentoitu arvio, ei standardi

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...CORS }
  });
}

async function fetchLandCoverAtPoint(lon, lat) {
  const d = 0.01; // pieni bbox pisteen ympärille
  const bbox = `${lon - d},${lat - d},${lon + d},${lat + d}`;
  const url = `${SYKE_WMS}?service=WMS&version=1.3.0&request=GetFeatureInfo` +
    `&layers=${LAYER}&query_layers=${LAYER}` +
    `&crs=CRS:84&bbox=${bbox}&width=101&height=101&i=50&j=50` +
    `&info_format=application/json&feature_count=1`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const j = await r.json();
    const f = j.features && j.features[0];
    if (!f) return null;
    return {
      level3: f.properties.level3,
      className: f.properties.level3suo,
      area: f.properties.shape_area
    };
  } catch (e) {
    return null;
  }
}

function gridPoints(bboxStr, n) {
  const [minLon, minLat, maxLon, maxLat] = bboxStr.split(",").map(Number);
  const pts = [];
  for (let ix = 0; ix < n; ix++) {
    for (let iy = 0; iy < n; iy++) {
      const lon = minLon + (maxLon - minLon) * (ix + 0.5) / n;
      const lat = minLat + (maxLat - minLat) * (iy + 0.5) / n;
      pts.push([lon, lat]);
    }
  }
  return pts;
}

async function handleFragmentation(url) {
  const bbox = url.searchParams.get("bbox") || DEFAULT_BBOX;
  const n = Math.min(10, parseInt(url.searchParams.get("grid") || "7", 10)); // 7x7=49 pistettä oletuksena, katto 10x10
  const points = gridPoints(bbox, n);

  const results = await Promise.all(points.map(([lon, lat]) => fetchLandCoverAtPoint(lon, lat)));
  const valid = results.filter(r => r !== null);

  if (valid.length === 0) {
    return json({ error: "Ei yhtään validia pistettä palautunut SYKE:ltä", bem_component: "D_f", status: "failed" }, 502);
  }

  const forestHits = valid.filter(r => FOREST_CLASSES.has(r.level3));
  const forestFraction = forestHits.length / valid.length;

  const meanForestArea = forestHits.length > 0
    ? forestHits.reduce((s, r) => s + r.area, 0) / forestHits.length
    : 0;
  const areaScore = Math.min(1, meanForestArea / REF_FOREST_AREA_M2);

  // D_f: korkea = fragmentoitunut. 0.6 paino metsäosuudelle, 0.4 laikkukoolle.
  const D_f = Math.max(0, Math.min(1,
    0.6 * (1 - forestFraction) + 0.4 * (1 - areaScore)
  ));

  const classCounts = {};
  valid.forEach(r => {
    classCounts[r.className || r.level3] = (classCounts[r.className || r.level3] || 0) + 1;
  });

  return json({
    bem_component: "D_f (fragmentation proxy)",
    D_f: +D_f.toFixed(3),
    method: "grid_sample_syke_wms",
    grid_size: `${n}x${n}`,
    points_queried: points.length,
    points_valid: valid.length,
    forest_fraction: +forestFraction.toFixed(3),
    mean_forest_patch_area_m2: Math.round(meanForestArea),
    ref_forest_area_m2: REF_FOREST_AREA_M2,
    class_distribution: classCounts,
    source: "SYKE inspire_lc WMS (CorineLandCover2018), no auth required",
    caveat: "Point-sample proxy, not true patch/edge-density fragmentation analysis"
  });
}

function handleStatus() {
  return json({
    proxy: "aci-corine-proxy",
    version: "0.2",
    purpose: "D_f (fragmentation) data source for BEM — Biodiversity Endurance Monitor",
    pilot: "Rautalammin reitti",
    default_bbox: DEFAULT_BBOX,
    routes: {
      "/status": "Proxy status",
      "/fragmentation": "Grid-sampled CORINE D_f proxy · ?bbox=...&grid=7 (n x n points, max 10x10)",
      "/ndvi": "Sentinel Hub Statistical API — NDVI mean/stDev over bbox · ?bbox=...&months=3"
    },
    source: {
      corine: {
        service: "SYKE inspire_lc WMS (GeoServer)",
        dataset: "CorineLandCover2018 (LC.LandCoverSurfaces.2018)",
        auth_required: false,
        reference: "https://ckan.ymparisto.fi/dataset/syke-maanpeite-wcs"
      },
      ndvi: {
        service: "Sentinel Hub Statistical API (Copernicus Data Space Ecosystem)",
        dataset: "Sentinel-2 L2A",
        auth_required: true,
        reference: "https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Statistical/Examples.html"
      }
    },
    caveat: "CORINE route: point-sample proxy, not true patch/edge-density fragmentation analysis. NDVI route: cloud-computed statistics, no raw pixel download.",
    reference_doc: "https://aethercontinuity.org/supplements/tn-015-biodiversity-endurance-monitor.html"
  });
}

// ── NDVI via Sentinel Hub Statistical API ────────────────────────────────
// Käyttää samaa OAuth2 client_credentials -virtaa kuin aci-bem-proxy:n
// aiempi (keskeneräiseksi jäänyt) Copernicus-yritys. Vaatii secretit:
// COPERNICUS_CLIENT_ID, COPERNICUS_CLIENT_SECRET (aci-corine-proxy:lle
// asetettava erikseen — eri Worker, eri secret-varasto kuin aci-bem-proxy).
//
// Statistical API laskee NDVI:n keskiarvon/hajonnan SUORAAN palvelimella
// annetulle alueelle ja aikavälille — ei raakojen kuvatiedostojen latausta
// eikä pikselikäsittelyä Workerissa. Vesipikselit (SCL==6) ja virheelliset
// arvot suodatetaan pois evalscriptissä ennen tilastointia.

const NDVI_EVALSCRIPT = `
//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B04", "B08", "SCL", "dataMask"] }],
    output: [
      { id: "data", bands: 1 },
      { id: "dataMask", bands: 1 }
    ]
  };
}
function evaluatePixel(samples) {
  let ndvi = (samples.B08 - samples.B04) / (samples.B08 + samples.B04);
  let validNDVI = (samples.B08 + samples.B04 == 0) ? 0 : 1;
  let noWater = (samples.SCL == 6) ? 0 : 1;
  return {
    data: [ndvi],
    dataMask: [samples.dataMask * validNDVI * noWater]
  };
}
`;

async function getCopernicusToken(env) {
  const tokenUrl = "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token";
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: env.COPERNICUS_CLIENT_ID,
    client_secret: env.COPERNICUS_CLIENT_SECRET
  });
  const r = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  if (!r.ok) {
    throw new Error(`Copernicus token fetch failed: ${r.status} ${await r.text()}`);
  }
  const data = await r.json();
  return data.access_token;
}

async function handleNDVI(url, env) {
  if (!env.COPERNICUS_CLIENT_ID || !env.COPERNICUS_CLIENT_SECRET) {
    return json({
      error: "COPERNICUS_CLIENT_ID / COPERNICUS_CLIENT_SECRET not configured",
      hint: "wrangler secret put COPERNICUS_CLIENT_ID (ja _SECRET) tähän Workeriin"
    }, 500);
  }

  const bboxStr = url.searchParams.get("bbox") || DEFAULT_BBOX;
  const [minLon, minLat, maxLon, maxLat] = bboxStr.split(",").map(Number);
  const months = Math.max(1, Math.min(12, parseInt(url.searchParams.get("months") || "3", 10)));

  const now = new Date();
  const to = now.toISOString();
  const from = new Date(now.getTime() - months * 30 * 24 * 3600 * 1000).toISOString();

  let token;
  try {
    token = await getCopernicusToken(env);
  } catch (e) {
    return json({ error: e.message, step: "oauth_token" }, 502);
  }

  const statsRequest = {
    input: {
      bounds: {
        bbox: [minLon, minLat, maxLon, maxLat],
        properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" }
      },
      data: [
        {
          type: "sentinel-2-l2a",
          dataFilter: { maxCloudCoverage: 40, mosaickingOrder: "leastCC" }
        }
      ]
    },
    aggregation: {
      timeRange: { from, to },
      aggregationInterval: { of: `P${months * 30}D` },
      evalscript: NDVI_EVALSCRIPT,
      // DIAGNOSTIIKKA (2026-07-08): sama virhe (122348.89 m/px) toistui
      // identtisenä myos resx/resy=500:lla - testataan nyt 5000:lla
      // selvittaaksemme vaikuttaako tama parametri virheeseen ollenkaan.
      resx: 5000,
      resy: 5000
    }
  };

  try {
    const r = await fetch("https://sh.dataspace.copernicus.eu/statistics/v1", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify(statsRequest)
    });
    if (!r.ok) {
      return json({ error: `Statistical API: HTTP ${r.status}`, detail: await r.text() }, 502);
    }
    const data = await r.json();
    const interval = data?.data?.[0];
    const stats = interval?.outputs?.data?.bands?.B0?.stats;

    return json({
      bem_component: "D_f (NDVI proxy)",
      method: "sentinel_hub_statistical_api",
      bbox: bboxStr,
      time_range: { from, to },
      max_cloud_coverage_pct: 40,
      ndvi_stats: stats || null,
      raw_response: stats ? undefined : data, // näytä raaka vastaus jos oletettu polku ei löydy — debug
      source: "Sentinel Hub Statistical API (Copernicus Data Space Ecosystem), Sentinel-2 L2A",
      caveat: "Cloud-aggregated statistics over full bbox and time window, not a spatial grid — single mean/stDev value for the whole area."
    });
  } catch (e) {
    return json({ error: e.message, step: "statistics_request" }, 502);
  }
}


export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }
    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405);
    }

    const path = url.pathname.replace(/\/$/, "");

    try {
      if (path === "/status" || path === "") {
        return handleStatus();
      } else if (path === "/fragmentation") {
        return await handleFragmentation(url);
      } else if (path === "/ndvi") {
        return await handleNDVI(url, env);
      } else {
        return json({ error: `Unknown route: ${path}` }, 404);
      }
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }
};
