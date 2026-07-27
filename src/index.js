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

// R (palautumiskyky) — SYKE inspire_ps WMS, suojelualueet.
// Vain aidosti ekologiset suojelutyypit, ei rakennusperintoa. Kaksi
// GetCapabilities:sta loydettya kerrosta (Eramaa-alue, Natura SCI)
// JATETTIIN POIS koska niiden oma bbox ei ulotu Rautalammille (62.9N)
// ollenkaan - havaittu 2026-07-08 GetCapabilities-tarkistuksessa,
// ei arvattu.
const SYKE_PS_WMS = "https://paikkatiedot.ymparisto.fi/geoserver/inspire_ps/wms";
const PS_LAYERS = [
  "PS.ProtectedSitesSpecialAreaOfConservation",       // Natura 2000 SAC
  "PS.ProtectedSitesSpecialProtectionArea",           // Natura 2000 SPA
  "PS.ProtectedSitesValtionOmistamaLuonnonsuojelualue", // valtion luonnonsuojelualueet
  "PS.ProtectedSitesYksityistenMaillaOlevaLuonnonsuojelualue" // yksityiset luonnonsuojelualueet
].join(",");
const FOREST_CLASSES = new Set([311, 312, 313]); // CLC level3: metsätyypit
const WATER_CLASSES = new Set([511, 512]); // CLC level3: joet/kanavat, järvet — vastaa NDVI:n SCL==6-vesimaskia
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

function gridPoints(bboxStr, n, offset = 0.5) {
  const [minLon, minLat, maxLon, maxLat] = bboxStr.split(",").map(Number);
  const pts = [];
  for (let ix = 0; ix < n; ix++) {
    for (let iy = 0; iy < n; iy++) {
      const lon = minLon + (maxLon - minLon) * (ix + offset) / n;
      const lat = minLat + (maxLat - minLat) * (iy + offset) / n;
      pts.push([lon, lat]);
    }
  }
  return pts;
}

// ── R (palautumiskyky) — SYKE inspire_ps WMS, ruudukkopisteotanta ──────
// Sama menetelma kuin CORINE:lla. Yksi GetFeatureInfo-pyynto per piste,
// nelja suojelualuekerrosta pilkuilla eroteltuna samassa pyynnossa (ei
// nelinkertaista subrequest-maaraa - GeoServer palauttaa yhdistetyn
// FeatureCollectionin kaikista kerroksista yhdessa vastauksessa).
async function fetchProtectionAtPoint(lon, lat) {
  const d = 0.01;
  const bbox = `${lon - d},${lat - d},${lon + d},${lat + d}`;
  const url = `${SYKE_PS_WMS}?service=WMS&version=1.3.0&request=GetFeatureInfo` +
    `&layers=${PS_LAYERS}&query_layers=${PS_LAYERS}` +
    `&crs=CRS:84&bbox=${bbox}&width=101&height=101&i=50&j=50` +
    `&info_format=application/json&feature_count=10`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const j = await r.json();
    return { protected: (j.features && j.features.length > 0) };
  } catch (e) {
    return null;
  }
}

async function computeR(bboxStr, n, offset = 0.5) {
  const points = gridPoints(bboxStr, n, offset);
  const results = await Promise.all(points.map(([lon, lat]) => fetchProtectionAtPoint(lon, lat)));
  const valid = results.filter(r => r !== null);

  if (valid.length === 0) {
    throw new Error("Ei yhtään validia pistettä palautunut SYKE inspire_ps:ltä");
  }

  const protectedHits = valid.filter(r => r.protected);
  const protectedFraction = protectedHits.length / valid.length;

  return {
    grid_size: `${n}x${n}`,
    offset: offset,
    points_queried: points.length,
    points_valid: valid.length,
    protected_hits: protectedHits.length,
    protected_fraction: +protectedFraction.toFixed(3),
    layers_queried: PS_LAYERS.split(","),
    source: "SYKE inspire_ps WMS (Natura 2000 SAC/SPA + valtion/yksityiset luonnonsuojelualueet), no auth required"
  };
}

async function handleR(url) {
  const bbox = url.searchParams.get("bbox") || DEFAULT_BBOX;
  const n = Math.min(7, parseInt(url.searchParams.get("grid") || "7", 10)); // katto 7x7=49, sama subrequest-raja kuin /fragmentation
  // offset [0,1): siirtaa naytepisteita solun sisalla. Kayttamalla eri
  // offset-arvoja usealla erillisella kutsulla (esim. asiakaspuolelta
  // 0.25/0.5/0.75) saadaan eri pisteet joka kerta ilman etta yksikaan
  // yksittainen Worker-suoritus ylittaa Cloudflaren 50 subrequestin
  // rajaa - kasvattaa todellista otoskokoa ilman SYKE:n WFS-tunnistetta.
  const offset = Math.max(0, Math.min(0.99, parseFloat(url.searchParams.get("offset") || "0.5")));

  let result;
  try {
    result = await computeR(bbox, n, offset);
  } catch (e) {
    return json({ error: e.message, bem_component: "R", status: "failed" }, 502);
  }

  // R: suoraan suojeltu pinta-alaosuus. Dokumentoitu approksimaatio -
  // ei huomioi suojelualueiden sijaintia suhteessa muuhun maisemaan
  // (esim. onko suojeltu alue kytkoksissa muihin vai eristyksissa),
  // vain karkea pinta-alaosuus.
  const R = Math.max(0, Math.min(1, result.protected_fraction));

  return json({
    bem_component: "R (recovery capacity proxy)",
    R: +R.toFixed(3),
    method: "grid_sample_syke_wms_ps",
    ...result,
    caveat: "Point-sample proxy suojellun pinta-alan osuudesta, ei huomioi suojelualueiden kytkeytyneisyyttä tai laatua. Kutsu useilla eri offset-arvoilla ja yhdista tulokset vahentaaksesi otantavirhetta."
  });
}

async function computeFragmentation(bboxStr, n) {
  const points = gridPoints(bboxStr, n);
  const results = await Promise.all(points.map(([lon, lat]) => fetchLandCoverAtPoint(lon, lat)));
  const valid = results.filter(r => r !== null);

  if (valid.length === 0) {
    throw new Error("Ei yhtään validia pistettä palautunut SYKE:ltä");
  }

  const forestHits = valid.filter(r => FOREST_CLASSES.has(r.level3));
  const forestFraction = forestHits.length / valid.length;

  const waterHits = valid.filter(r => WATER_CLASSES.has(r.level3));
  const waterFraction = waterHits.length / valid.length;

  const meanForestArea = forestHits.length > 0
    ? forestHits.reduce((s, r) => s + r.area, 0) / forestHits.length
    : 0;

  const classCounts = {};
  valid.forEach(r => {
    classCounts[r.className || r.level3] = (classCounts[r.className || r.level3] || 0) + 1;
  });

  return {
    grid_size: `${n}x${n}`,
    points_queried: points.length,
    points_valid: valid.length,
    forest_fraction: +forestFraction.toFixed(3),
    water_fraction: +waterFraction.toFixed(3),
    mean_forest_patch_area_m2: Math.round(meanForestArea),
    ref_forest_area_m2: REF_FOREST_AREA_M2,
    class_distribution: classCounts,
    source: "SYKE inspire_lc WMS (CorineLandCover2018), no auth required"
  };
}

async function handleFragmentation(url) {
  const bbox = url.searchParams.get("bbox") || DEFAULT_BBOX;
  // Katto 7 (49 pistettä), EI 10 (100 pistetta) - Cloudflare Workers
  // -ilmaistaso: 50 ulkoisen subrequestin raja per suoritus. grid=10
  // olisi yksinaankin ylittanyt taman (havaittu 2026-07-08 /combined-
  // reitin virheenjaljityksen yhteydessa, korjattu tanne samalla vaikka
  // ei viela ollut itse aiheuttanut virhetta koska kukaan ei ollut
  // pyytanyt grid=10:ta).
  const n = Math.min(7, parseInt(url.searchParams.get("grid") || "7", 10));

  let corine;
  try {
    corine = await computeFragmentation(bbox, n);
  } catch (e) {
    return json({ error: e.message, bem_component: "D_f", status: "failed" }, 502);
  }

  // D_f: korkea = fragmentoitunut. Laikkukoko-komponentti poistettu
  // (CORINE:n 25 ha minimikartoitusyksikko yleistaa lahekkaiset metsat
  // yhdeksi valtavaksi polygoniksi, ei erottele todellista fragmentaatiota
  // - havaittu 2026-07-08, ks. commit-historia). Kaava on nyt suoraan
  // metsaosuuden komplementti.
  const D_f = Math.max(0, Math.min(1, 1 - corine.forest_fraction));

  return json({
    bem_component: "D_f (fragmentation proxy)",
    D_f: +D_f.toFixed(3),
    method: "grid_sample_syke_wms",
    ...corine,
    caveat: "Point-sample proxy, not true patch/edge-density fragmentation analysis. Patch-size component removed — see /status for detail."
  });
}

function handleStatus() {
  return json({
    proxy: "aci-corine-proxy",
    version: "0.4",
    purpose: "D_f and R data sources for BEM — Biodiversity Endurance Monitor",
    pilot: "Rautalammin reitti",
    default_bbox: DEFAULT_BBOX,
    routes: {
      "/status": "Proxy status",
      "/fragmentation": "Grid-sampled CORINE D_f proxy · ?bbox=...&grid=7 (n x n points, max 7x7)",
      "/ndvi": "Sentinel Hub Statistical API — NDVI mean/stDev over bbox · ?bbox=...&months=3",
      "/ndvi-image": "Sentinel Hub Process API — renderoitu NDVI-kuva (vihrea-keltainen-punainen) · ?bbox=...&months=3&w=480&h=350",
      "/mndwi": "BEM-E (Aquatic Extension) — MNDWI-tilasto [A-luokka] · ?bbox=...&months=3 · EI VIELA live-testattu",
      "/mndwi-image": "BEM-E — renderoitu MNDWI-kuva (ruskea-vihrea-sininen) · ?bbox=...&months=3&w=480&h=480 · EI VIELA live-testattu",
      "/ndci": "BEM-E — NDCI-tilasto [B-luokka, KOKEELLINEN] · ?bbox=...&months=3 · vain vesipikselit (SCL==6) · EI VIELA live-testattu",
      "/ndci-image": "BEM-E — renderoitu NDCI-kuva (sininen-vihrea-keltainen-punainen) [B-luokka] · ?bbox=...&months=3&w=480&h=480 · EI VIELA live-testattu",
      "/lake-timeseries": "BEM-E — takautuva kesakauden (touko-syyskuu) MNDWI+NDCI-aikasarja · ?bbox=...&startYear=2018&endYear=2025&indices=mndwi,ndci · EI VIELA live-testattu · yksi API-kutsu per vuosi per indeksi · HUOM: startYear<2018 EI TUETTU, L2A ei systemaattista Euroopassa ennen 2017-05",
      "/catalog-check": "Diagnostiikka - STAC Catalog API -haku, tarkistaa onko Sentinel-2 L2A -skeneja olemassa · ?bbox=...&from=...&to=... (ISO 8601)",
      "/combined": "CORINE + NDVI rinnakkain, ristiintarkistus, yhdistetty D_f · ?bbox=...&grid=6&months=3",
      "/recovery": "Grid-sampled SYKE protected-area R proxy · ?bbox=...&grid=7 (n x n points, max 7x7)"
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
      },
      protected_areas: {
        service: "SYKE inspire_ps WMS (GeoServer)",
        dataset: "Natura 2000 SAC/SPA + valtion/yksityiset luonnonsuojelualueet",
        auth_required: false,
        reference: "https://ckan.ymparisto.fi/dataset/syke-suojellutalueet-wms",
        note: "Kaksi muuta suojelutyyppia (Eramaa-alue, Natura SCI) jatetty pois - niiden oma bbox ei ulotu Rautalammille."
      }
    },
    caveat: "CORINE/protected-area routes: point-sample proxies, not exhaustive spatial analysis. NDVI route: cloud-computed statistics, no raw pixel download.",
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

// ── BEM-E (Aquatic Extension) — MNDWI [A-luokka, vakiintunut] ──
// MNDWI = (B03-B11)/(B03+B11), Xu 2006. Varmistettu 2026-07-26 Sentinel
// Hubin omasta custom-scripts-arkistosta + useasta riippumattomasta
// akateemisesta lahteesta (parempi vakaus kuin perinteinen NDWI SWIR-
// kaistan ansiosta). Ks. aethercontinuity.org/tools/hem-satellite-
// water-quality-plan.md.
//
// HUOM TOISIN KUIN NDVI_EVALSCRIPT: MNDWI:n oma tarkoitus ON EROTTAA
// vesi maasta - EI siis maskata vetta pois (SCL==6-suodatinta EI
// kayteta tassa), koko bbox:in yli laskettu keskiarvo/hajonta kuvaa
// "kuinka paljon vetta suhteessa maahan" -tason muutosta ajassa.
const MNDWI_EVALSCRIPT = `
//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B03", "B11", "dataMask"] }],
    output: [
      { id: "data", bands: 1 },
      { id: "dataMask", bands: 1 }
    ]
  };
}
function evaluatePixel(samples) {
  let mndwi = (samples.B03 - samples.B11) / (samples.B03 + samples.B11);
  let valid = (samples.B03 + samples.B11 == 0) ? 0 : 1;
  return {
    data: [mndwi],
    dataMask: [samples.dataMask * valid]
  };
}
`;

async function computeMNDWI(bboxStr, months, env) {
  if (!env.COPERNICUS_CLIENT_ID || !env.COPERNICUS_CLIENT_SECRET) {
    throw new Error("COPERNICUS_CLIENT_ID / COPERNICUS_CLIENT_SECRET not configured (wrangler secret put ...)");
  }
  const [minLon, minLat, maxLon, maxLat] = bboxStr.split(",").map(Number);
  const now = new Date();
  const to = now.toISOString();
  const from = new Date(now.getTime() - months * 30 * 24 * 3600 * 1000).toISOString();
  const token = await getCopernicusToken(env);

  const statsRequest = {
    input: {
      bounds: {
        bbox: [minLon, minLat, maxLon, maxLat],
        properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" }
      },
      data: [
        { type: "sentinel-2-l2a", dataFilter: { maxCloudCoverage: 40, mosaickingOrder: "leastCC" } }
      ]
    },
    aggregation: {
      timeRange: { from, to },
      aggregationInterval: { of: `P${months * 30}D` },
      evalscript: MNDWI_EVALSCRIPT,
      // width/height, EI resx/resy - sama astevs-metri-yksikkobugi (2026-07-08)
      // jonka NDVI-koodi jo valtti, sama varovaisuus tassa.
      width: 150,
      height: 240
    }
  };

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
    throw new Error(`Statistical API: HTTP ${r.status} ${await r.text()}`);
  }
  const data = await r.json();
  const interval = data?.data?.[0];
  const stats = interval?.outputs?.data?.bands?.B0?.stats;

  if (!stats) {
    return { error: "unexpected_response_shape", raw_response: data, time_range: { from, to } };
  }

  return {
    time_range: { from, to },
    max_cloud_coverage_pct: 40,
    mndwi_stats: stats,
    grade: "A - vakiintunut (Xu 2006)",
    source: "Sentinel Hub Statistical API (Copernicus Data Space Ecosystem), Sentinel-2 L2A"
  };
}

async function handleMNDWI(url, env) {
  const bboxStr = url.searchParams.get("bbox");
  const months = Math.max(1, Math.min(12, parseInt(url.searchParams.get("months") || "3", 10)));
  if (!bboxStr) {
    return json({ error: "bbox-parametri on pakollinen (esim. Iisvesi: 26.667,62.567,27.067,62.967)" }, 400);
  }

  try {
    const result = await computeMNDWI(bboxStr, months, env);
    return json({
      bem_e_component: "MNDWI (Aquatic Extension, A-luokka)",
      method: "sentinel_hub_statistical_api",
      bbox: bboxStr,
      ...result,
      caveat: "EI VIELA live-testattu tallle nimenomaiselle bbox:ille (kirjoitettu 2026-07-26). Cloud-aggregoitu tilasto koko bbox:in ja aikaikkunan yli, ei spatiaalinen ruudukko."
    });
  } catch (e) {
    return json({ error: e.message, step: "mndwi" }, 502);
  }
}

// MNDWI-kuva: sininen (korkea MNDWI = vesi) -> ruskea/vihrea (matala/negatiivinen = maa)
const MNDWI_IMAGE_EVALSCRIPT = `
//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B03", "B11", "dataMask"] }],
    output: { bands: 4, sampleType: "UINT8" }
  };
}
function mndwiColor(m) {
  if (m < -0.3) return [140, 110, 70];   // ruskea - kuiva maa
  if (m < 0.0)  return [120, 150, 80];   // vihrea - kasvillisuus/maa
  if (m < 0.2)  return [180, 210, 160];  // vaalea vihrea - kostea maa/rantavyohyke
  if (m < 0.4)  return [140, 190, 220];  // vaalea sininen - matala/sameavesi
  if (m < 0.6)  return [60, 140, 200];   // sininen - vesi
  return [20, 80, 160];                  // tummansininen - syva/kirkas vesi
}
function evaluatePixel(s) {
  if (s.dataMask == 0) return [255, 255, 255, 60];
  var mndwi = (s.B03 - s.B11) / (s.B03 + s.B11);
  var c = mndwiColor(mndwi);
  return [c[0], c[1], c[2], 255];
}
`;

async function fetchMNDWIImage(bboxStr, months, width, height, env) {
  if (!env.COPERNICUS_CLIENT_ID || !env.COPERNICUS_CLIENT_SECRET) {
    throw new Error("COPERNICUS_CLIENT_ID / COPERNICUS_CLIENT_SECRET not configured (wrangler secret put ...)");
  }
  const [minLon, minLat, maxLon, maxLat] = bboxStr.split(",").map(Number);
  const now = new Date();
  const to = now.toISOString();
  const from = new Date(now.getTime() - months * 30 * 24 * 3600 * 1000).toISOString();
  const token = await getCopernicusToken(env);

  const processRequest = {
    input: {
      bounds: {
        bbox: [minLon, minLat, maxLon, maxLat],
        properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" }
      },
      data: [{
        type: "sentinel-2-l2a",
        dataFilter: { maxCloudCoverage: 40, mosaickingOrder: "leastCC", timeRange: { from, to } }
      }]
    },
    output: {
      width, height,
      responses: [{ identifier: "default", format: { type: "image/png" } }]
    },
    evalscript: MNDWI_IMAGE_EVALSCRIPT
  };

  const r = await fetch("https://sh.dataspace.copernicus.eu/api/v1/process", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "image/png", "Authorization": `Bearer ${token}` },
    body: JSON.stringify(processRequest)
  });
  if (!r.ok) {
    throw new Error(`Process API: HTTP ${r.status} ${await r.text()}`);
  }
  return await r.arrayBuffer();
}

async function handleMNDWIImage(url, env) {
  const bboxStr = url.searchParams.get("bbox");
  const months = Math.max(1, Math.min(12, parseInt(url.searchParams.get("months") || "3", 10)));
  const width  = Math.max(64, Math.min(640, parseInt(url.searchParams.get("w") || "480", 10)));
  const height = Math.max(64, Math.min(640, parseInt(url.searchParams.get("h") || "480", 10)));
  if (!bboxStr) {
    return json({ error: "bbox-parametri on pakollinen (esim. Iisvesi: 26.667,62.567,27.067,62.967)" }, 400);
  }

  try {
    const png = await fetchMNDWIImage(bboxStr, months, width, height, env);
    return new Response(png, {
      headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=21600", ...CORS }
    });
  } catch (e) {
    return json({ error: e.message, step: "mndwi-image" }, 502);
  }
}

// ── BEM-E (Aquatic Extension) — NDCI [B-luokka, KOKEELLINEN] ──
// NDCI = (B05-B04)/(B05+B04), Mishra & Mishra 2012. Varmistettu 2026-07-26
// Sentinel Hubin omasta custom-scripts-arkistosta. HUOM: virallinen
// Digital Earth Africa -dokumentaatio MERKITSEE TAMAN "kokeelliseksi
// Sentinel-2:lle" - EI yhta vakiintunut kuin MNDWI. Ks. aethercontinuity.org/
// tools/hem-satellite-water-quality-plan.md.
//
// TOISIN KUIN MNDWI: NDCI:n tarkoitus ON mitata klorofyllia VEDEN
// SISALLA, ei erottaa vetta maasta - siksi tama MASKAA POIS ei-vesi-
// pikselit (SCL==6 = KEEP, kaanteinen logiikka NDVI_EVALSCRIPT:iin
// verrattuna, joka maskasi veden POIS).
const NDCI_EVALSCRIPT = `
//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B04", "B05", "SCL", "dataMask"] }],
    output: [
      { id: "data", bands: 1 },
      { id: "dataMask", bands: 1 }
    ]
  };
}
function evaluatePixel(samples) {
  let ndci = (samples.B05 - samples.B04) / (samples.B05 + samples.B04);
  let valid = (samples.B05 + samples.B04 == 0) ? 0 : 1;
  let isWater = (samples.SCL == 6) ? 1 : 0;
  return {
    data: [ndci],
    dataMask: [samples.dataMask * valid * isWater]
  };
}
`;

async function computeNDCI(bboxStr, months, env) {
  if (!env.COPERNICUS_CLIENT_ID || !env.COPERNICUS_CLIENT_SECRET) {
    throw new Error("COPERNICUS_CLIENT_ID / COPERNICUS_CLIENT_SECRET not configured (wrangler secret put ...)");
  }
  const [minLon, minLat, maxLon, maxLat] = bboxStr.split(",").map(Number);
  const now = new Date();
  const to = now.toISOString();
  const from = new Date(now.getTime() - months * 30 * 24 * 3600 * 1000).toISOString();
  const token = await getCopernicusToken(env);

  const statsRequest = {
    input: {
      bounds: {
        bbox: [minLon, minLat, maxLon, maxLat],
        properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" }
      },
      data: [
        { type: "sentinel-2-l2a", dataFilter: { maxCloudCoverage: 40, mosaickingOrder: "leastCC" } }
      ]
    },
    aggregation: {
      timeRange: { from, to },
      aggregationInterval: { of: `P${months * 30}D` },
      evalscript: NDCI_EVALSCRIPT,
      width: 150,
      height: 240
    }
  };

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
    throw new Error(`Statistical API: HTTP ${r.status} ${await r.text()}`);
  }
  const data = await r.json();
  const interval = data?.data?.[0];
  const stats = interval?.outputs?.data?.bands?.B0?.stats;

  if (!stats) {
    return { error: "unexpected_response_shape", raw_response: data, time_range: { from, to } };
  }

  return {
    time_range: { from, to },
    max_cloud_coverage_pct: 40,
    ndci_stats: stats,
    grade: "B - KOKEELLINEN (Mishra & Mishra 2012, merkitty kokeelliseksi Sentinel-2:lle virallisen dokumentaation mukaan)",
    masking: "Vain vesipikselit (SCL==6) - maapikselit maskattu pois",
    source: "Sentinel Hub Statistical API (Copernicus Data Space Ecosystem), Sentinel-2 L2A"
  };
}

async function handleNDCI(url, env) {
  const bboxStr = url.searchParams.get("bbox");
  const months = Math.max(1, Math.min(12, parseInt(url.searchParams.get("months") || "3", 10)));
  if (!bboxStr) {
    return json({ error: "bbox-parametri on pakollinen (esim. Iisvesi: 26.167,62.567,27.067,63.467)" }, 400);
  }

  try {
    const result = await computeNDCI(bboxStr, months, env);
    return json({
      bem_e_component: "NDCI (Aquatic Extension, B-luokka - KOKEELLINEN)",
      method: "sentinel_hub_statistical_api",
      bbox: bboxStr,
      ...result,
      caveat: "EI VIELA live-testattu tallle nimenomaiselle bbox:ille (kirjoitettu 2026-07-26). Cloud-aggregoitu tilasto VAIN vesipikseleilta (SCL==6). Jos vesipikseleita on vahan (esim. paljon pilvia tai pieni bbox), sampleCount voi olla pieni ja tulos epaluotettava - tarkista aina sampleCount."
    });
  } catch (e) {
    return json({ error: e.message, step: "ndci" }, 502);
  }
}

// NDCI-kuva: vihrea (matala/negatiivinen = vahan klorofyllia) -> keltainen -> punainen (korkea = mahdollinen levakukinta)
const NDCI_IMAGE_EVALSCRIPT = `
//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B04", "B05", "SCL", "dataMask"] }],
    output: { bands: 4, sampleType: "UINT8" }
  };
}
function ndciColor(n) {
  if (n < -0.1) return [40, 90, 140];    // tummansininen - hyvin vahan klorofyllia (kirkas vesi)
  if (n < 0.0)  return [60, 130, 110];   // sinivihrea - vahan klorofyllia
  if (n < 0.1)  return [120, 170, 70];   // vihrea - kohtalainen
  if (n < 0.2)  return [210, 200, 60];   // keltainen - koholla
  if (n < 0.3)  return [230, 140, 40];   // oranssi - korkea
  return [200, 40, 30];                  // punainen - hyvin korkea, mahdollinen levakukinta
}
function evaluatePixel(s) {
  var isWater = (s.SCL == 6);
  if (s.dataMask == 0 || !isWater) {
    return [230, 225, 210, 70]; // vaalea, lapinakyva - ei vetta tassa pikselissa
  }
  var ndci = (s.B05 - s.B04) / (s.B05 + s.B04);
  var c = ndciColor(ndci);
  return [c[0], c[1], c[2], 255];
}
`;

async function fetchNDCIImage(bboxStr, months, width, height, env) {
  if (!env.COPERNICUS_CLIENT_ID || !env.COPERNICUS_CLIENT_SECRET) {
    throw new Error("COPERNICUS_CLIENT_ID / COPERNICUS_CLIENT_SECRET not configured (wrangler secret put ...)");
  }
  const [minLon, minLat, maxLon, maxLat] = bboxStr.split(",").map(Number);
  const now = new Date();
  const to = now.toISOString();
  const from = new Date(now.getTime() - months * 30 * 24 * 3600 * 1000).toISOString();
  const token = await getCopernicusToken(env);

  const processRequest = {
    input: {
      bounds: {
        bbox: [minLon, minLat, maxLon, maxLat],
        properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" }
      },
      data: [{
        type: "sentinel-2-l2a",
        dataFilter: { maxCloudCoverage: 40, mosaickingOrder: "leastCC", timeRange: { from, to } }
      }]
    },
    output: {
      width, height,
      responses: [{ identifier: "default", format: { type: "image/png" } }]
    },
    evalscript: NDCI_IMAGE_EVALSCRIPT
  };

  const r = await fetch("https://sh.dataspace.copernicus.eu/api/v1/process", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "image/png", "Authorization": `Bearer ${token}` },
    body: JSON.stringify(processRequest)
  });
  if (!r.ok) {
    throw new Error(`Process API: HTTP ${r.status} ${await r.text()}`);
  }
  return await r.arrayBuffer();
}

async function handleNDCIImage(url, env) {
  const bboxStr = url.searchParams.get("bbox");
  const months = Math.max(1, Math.min(12, parseInt(url.searchParams.get("months") || "3", 10)));
  const width  = Math.max(64, Math.min(640, parseInt(url.searchParams.get("w") || "480", 10)));
  const height = Math.max(64, Math.min(640, parseInt(url.searchParams.get("h") || "480", 10)));
  if (!bboxStr) {
    return json({ error: "bbox-parametri on pakollinen (esim. Iisvesi: 26.167,62.567,27.067,63.467)" }, 400);
  }

  try {
    const png = await fetchNDCIImage(bboxStr, months, width, height, env);
    return new Response(png, {
      headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=21600", ...CORS }
    });
  } catch (e) {
    return json({ error: e.message, step: "ndci-image" }, 502);
  }
}

// ── BEM-E — takautuva aikasarja (kayttajan oma suunnitelma 2026-07-27) ──
// Yleinen apufunktio: yksi Statistical API -kutsu ANNETULLE aikavalille
// (ei "months back from now" kuten computeMNDWI/computeNDCI, vaan
// tasmalliset from/to-paivamaarat). Kaytetaan aikasarjareitissa - yksi
// kutsu per vuosi per indeksi, koska Statistical APIn oma aggregationInterval
// on yksinkertainen jaksotus alkaen timeRange.from:sta, EI tue "sama
// kalenteri-ikkuna joka vuodelta, ohita talvi" -tyyppista suodatusta
// yhdessa kutsussa - tama on varmistettu johtopaatos, ei arvattu oletus.
async function runStatsForRange(evalscript, bboxStr, fromISO, toISO, env, maxCloudCoverage = 40) {
  const [minLon, minLat, maxLon, maxLat] = bboxStr.split(",").map(Number);
  const token = await getCopernicusToken(env);
  const spanDays = Math.max(1, Math.round((new Date(toISO) - new Date(fromISO)) / 86400000));

  const statsRequest = {
    input: {
      bounds: {
        bbox: [minLon, minLat, maxLon, maxLat],
        properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" }
      },
      data: [{ type: "sentinel-2-l2a", dataFilter: { maxCloudCoverage, mosaickingOrder: "leastCC" } }]
    },
    aggregation: {
      timeRange: { from: fromISO, to: toISO },
      aggregationInterval: { of: `P${spanDays}D` }, // koko ikkuna yhtena valina - yksi piste per vuosi
      evalscript,
      width: 150,
      height: 240
    }
  };

  const r = await fetch("https://sh.dataspace.copernicus.eu/statistics/v1", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify(statsRequest)
  });
  if (!r.ok) throw new Error(`Statistical API: HTTP ${r.status} ${await r.text()}`);
  const data = await r.json();
  const interval = data?.data?.[0];
  const stats = interval?.outputs?.data?.bands?.B0?.stats;
  if (!stats) {
    // KORJATTU 2026-07-27: alkuperainen koodi palautti hiljaa null jos
    // rakenne ei tasmannyt - loydettiin live-testissa etta /lake-timeseries
    // palautti kaikille 10 vuodelle null:in ilman virhetta. Nyt heitetaan
    // POIKKEUS jossa mukana RAAKA vastaus, jotta seuraava testi paljastaa
    // tarkalleen mika API:n oma vastausrakenne oli.
    throw new Error(`stats-rakenne puuttuu. spanDays=${spanDays}, data.data.length=${data?.data?.length}, raw=${JSON.stringify(data).slice(0, 500)}`);
  }
  return stats;
}

// Kesakauden (touko-syyskuu) MNDWI+NDCI-aikasarja usealle vuodelle.
// KAYTTAJAN OMA SUUNNITELMA 2026-07-26/27: kesakauden mediaani/keskiarvo
// per vuosi vahentaa pilvien/satunnaissateiden kohinaa verrattuna
// yksittaiseen kuvaan. Kehys: 2015 alkaen (Sentinel-2:n oma alku),
// verrattavissa HEM:n pitkaan HEPP-sarjaan (1959-2026).
//
// ── Catalog API -tarkistus (STAC-haku) — käyttäjän oma tuore löydös 2026-07-27 ──
// Statistical API on raportoitu ajoittain epavakaaksi (data:[] vaikka
// dataa pitaisi olla, LTA-arkistoidun historiallisen datan ongelmat).
// Tama reitti kayttaa ERI, yksinkertaisempaa STAC-pohjaista Catalog API:a
// tarkistamaan SUORAAN onko yhtaan Sentinel-2 L2A -skeneta olemassa
// annetulle bbox:ille/aikavalille - riippumaton Statistical API:n
// omista mahdollisista aggregointibugeista.
async function handleCatalogCheck(url, env) {
  const bboxStr = url.searchParams.get("bbox");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!bboxStr || !from || !to) {
    return json({ error: "bbox, from ja to (ISO 8601) ovat pakollisia" }, 400);
  }
  if (!env.COPERNICUS_CLIENT_ID || !env.COPERNICUS_CLIENT_SECRET) {
    return json({ error: "COPERNICUS_CLIENT_ID / COPERNICUS_CLIENT_SECRET not configured" }, 500);
  }

  try {
    const [minLon, minLat, maxLon, maxLat] = bboxStr.split(",").map(Number);
    const token = await getCopernicusToken(env);

    const searchBody = {
      bbox: [minLon, minLat, maxLon, maxLat],
      datetime: `${from}/${to}`,
      collections: ["sentinel-2-l2a"],
      limit: 20
    };

    const r = await fetch("https://sh.dataspace.copernicus.eu/api/v1/catalog/1.0.0/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/geo+json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify(searchBody)
    });
    if (!r.ok) {
      return json({ error: `Catalog API: HTTP ${r.status} ${await r.text()}` }, 502);
    }
    const data = await r.json();
    const features = data.features || [];
    const scenes = features.map(f => ({
      datetime: f.properties?.datetime,
      cloudCover: f.properties?.["eo:cloud_cover"],
      id: f.id
    }));

    return json({
      bem_e_component: "Catalog API -tarkistus (STAC search) - diagnostiikka",
      bbox: bboxStr,
      datetime_range: `${from}/${to}`,
      scene_count: scenes.length,
      context: data.context,
      scenes,
      caveat: "Tama tarkistaa ONKO skeneja olemassa - EI kerro suoraan miksi Statistical API palautti data:[], mutta antaa riippumattoman vahvistuksen datan olemassaolosta."
    });
  } catch (e) {
    return json({ error: e.message, step: "catalog-check" }, 502);
  }
}

// HUOM rajaus: nykyinen vuosi (kuluva kesa, esim. 2026 heinakuussa) EI
// VOI olla taydellinen (touko-syyskuu ei ole viela paattynyt) - jatetaan
// AUTOMAATTISESTI POIS jos endYear >= nykyinen vuosi JA kuluva paivamaara
// on ennen syyskuun loppua, jotta osittainen kesa ei vaarista vertailua.
async function handleLakeTimeseries(url, env) {
  const bboxStr = url.searchParams.get("bbox");
  if (!bboxStr) {
    return json({ error: "bbox-parametri on pakollinen (esim. Iisvesi: 26.167,62.567,27.067,63.467)" }, 400);
  }
  // KORJATTU 2026-07-27 (loydetty live-testissa): startYear=2016 palautti
  // "data":[] KAIKILLE vuoden 2016 kutsuille. Syy varmistettu virallisesta
  // lahteesta (sentinels.copernicus.eu): "L2A production is now systematic
  // over Europe and dissemination... started in May 2017." Vuosi 2016 ON
  // SIIS ENNEN L2A-tuotteiden systemaattista tuotantoa Euroopan ylla - tama
  // EI ole koodivirhe vaan aito datan saatavuusraja. 2017 jatetty MYOS pois
  // varmuuden vuoksi (siirtymavuosi, tuotanto alkoi VASTA toukokuussa,
  // ei kata koko touko-syyskuu-ikkunaa luotettavasti). Oletus siirretty
  // 2018:aan - kaventaa ikkunan 10:sta 8:aan vuoteen (2018-2025), mutta
  // silla varmistetaan etta jokainen vuosi on TAYSIN systemaattisen
  // L2A-tuotannon piirissa.
  const startYear = Math.max(2018, parseInt(url.searchParams.get("startYear") || "2018", 10));
  let endYear = parseInt(url.searchParams.get("endYear") || String(new Date().getUTCFullYear() - 1), 10);

  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const summerEndedThisYear = now.getUTCMonth() >= 9; // lokakuu (0-indeksoitu 9) tai myohemmin = syyskuu paattynyt
  if (endYear >= currentYear && !(endYear === currentYear && summerEndedThisYear)) {
    endYear = currentYear - 1; // kuluva, kesken oleva kesa jatetty pois
  }
  if (endYear < startYear) {
    return json({ error: `Ei taydellisia kesakausia valilla ${startYear}-${url.searchParams.get('endYear')}` }, 400);
  }

  const indicesParam = (url.searchParams.get("indices") || "mndwi,ndci").split(",").map(s => s.trim());
  // VALIAIKAINEN DIAGNOSTIIKKAPARAMETRI 2026-07-27: 2018-testi palautti
  // yha "data":[] vaikka L2A-vuosiraja (2017-05) pitaisi olla ylitetty -
  // tama kumoaa alkuperaisen hypoteesin. debugEndDay/debugStartDay
  // mahdollistavat lyhyemman ikkunan (aina yhteen paivaan asti)
  // testaamisen erottamaan onko kyse itse AIKAVALIN PITUUDESTA
  // eika vuodesta - esim. debugStartDay=07-15&debugEndDay=07-15 testaa
  // TASAN yhden paivan (15.7.).
  const debugEndDay = url.searchParams.get("debugEndDay"); // esim. "06-30"
  const debugStartDay = url.searchParams.get("debugStartDay"); // esim. "07-15" - oletus "05-01" jos puuttuu
  // Kayttajan oma huomio 2026-07-27: Sentinel-2:n ylilennot ovat
  // diskreetteja tapahtumia, data saadaan vain jos pilvipeite ei ole
  // liiallinen. debugMaxCloud mahdollistaa pilvisuodattimen loysentamisen
  // (esim. 100 = ei suodatinta ollenkaan) testataksemme onko 40%:n raja
  // liian tiukka juuri talle bbox:ille/ajanjaksolle.
  const debugMaxCloud = parseInt(url.searchParams.get("debugMaxCloud") || "40", 10);

  const results = [];

  for (let year = startYear; year <= endYear; year++) {
    // KORJATTU 2026-07-27: kaikki neljä testattua aikavalin pituutta
    // (153, 78, 61, 2 paivaa) epaonnistuivat IDENTTISESTI - tama sulki
    // pois aikavalin PITUUDEN kokonaan. Jaljelle jai vain yksi ero
    // toimiviin /mndwi//ndci-kutsuihin: nama kayttivat kasin rakennettua
    // "YYYY-MM-DDTHH:MM:SSZ" -muotoa (EI millisekunteja), kun toimivat
    // kutsut kayttivat now.toISOString():a (JOKA SISALTAA millisekunnit,
    // esim. ".832Z"). Korjattu kayttamaan new Date(...).toISOString():a
    // tassakin - varmistaa TASMALLEEN saman merkkijonomuodon kuin toimiva
    // koodipolku, ei vain samaa PAIVAMAARAA eri muodossa.
    const from = new Date(debugStartDay ? `${year}-${debugStartDay}T00:00:00Z` : `${year}-05-01T00:00:00Z`).toISOString();
    const to = new Date(debugEndDay ? `${year}-${debugEndDay}T23:59:59Z` : `${year}-09-30T23:59:59Z`).toISOString();
    const row = { year, summer_window: { from, to } };

    if (indicesParam.includes("mndwi")) {
      try {
        row.mndwi = await runStatsForRange(MNDWI_EVALSCRIPT, bboxStr, from, to, env, debugMaxCloud);
      } catch (e) {
        row.mndwi = null; row.mndwi_error = e.message;
      }
    }
    if (indicesParam.includes("ndci")) {
      try {
        row.ndci = await runStatsForRange(NDCI_EVALSCRIPT, bboxStr, from, to, env, debugMaxCloud);
      } catch (e) {
        row.ndci = null; row.ndci_error = e.message;
      }
    }
    results.push(row);
  }

  return json({
    bem_e_component: "Takautuva kesakauden aikasarja (MNDWI + NDCI)",
    bbox: bboxStr,
    years: `${startYear}-${endYear}`,
    summer_window: "touko-syyskuu (kesken oleva kuluva kesa jatetty automaattisesti pois)",
    rows: results,
    caveat: "EI VIELA live-testattu (kirjoitettu 2026-07-27). Yksi Statistical API -kutsu per vuosi per indeksi - kuluttaa Process Unit -kiintiota vastaavasti (esim. 10 vuotta x 2 indeksia = 20 kutsua). Jokaisen rivin oma sampleCount/noDataCount tulisi tarkistaa ennen tulkintaa, sama periaate kuin yksittaisilla /mndwi ja /ndci -reiteilla."
  });
}

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

async function computeNDVI(bboxStr, months, env) {
  if (!env.COPERNICUS_CLIENT_ID || !env.COPERNICUS_CLIENT_SECRET) {
    throw new Error("COPERNICUS_CLIENT_ID / COPERNICUS_CLIENT_SECRET not configured (wrangler secret put ...)");
  }

  const [minLon, minLat, maxLon, maxLat] = bboxStr.split(",").map(Number);

  const now = new Date();
  const to = now.toISOString();
  const from = new Date(now.getTime() - months * 30 * 24 * 3600 * 1000).toISOString();

  const token = await getCopernicusToken(env);

  const statsRequest = {
    input: {
      bounds: {
        bbox: [minLon, minLat, maxLon, maxLat],
        properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" }
      },
      data: [
        { type: "sentinel-2-l2a", dataFilter: { maxCloudCoverage: 40, mosaickingOrder: "leastCC" } }
      ]
    },
    aggregation: {
      timeRange: { from, to },
      aggregationInterval: { of: `P${months * 30}D` },
      evalscript: NDVI_EVALSCRIPT,
      // width/height, ei resx/resy — ks. commit-historia (astevs-metri-yksikkobugi 2026-07-08)
      width: 150,
      height: 240
    }
  };

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
    throw new Error(`Statistical API: HTTP ${r.status} ${await r.text()}`);
  }
  const data = await r.json();
  const interval = data?.data?.[0];
  const stats = interval?.outputs?.data?.bands?.B0?.stats;

  if (!stats) {
    return { error: "unexpected_response_shape", raw_response: data, time_range: { from, to } };
  }

  const noDataFraction = stats.sampleCount > 0
    ? stats.noDataCount / stats.sampleCount
    : null;

  return {
    time_range: { from, to },
    max_cloud_coverage_pct: 40,
    ndvi_stats: stats,
    // noDataFraction sisältää veden JA pilvet JA virheelliset arvot yhdessä -
    // ei puhdas vesiosuus, karkea ylaraja-arvio vertailua varten.
    no_data_fraction_upper_bound: noDataFraction != null ? +noDataFraction.toFixed(3) : null,
    source: "Sentinel Hub Statistical API (Copernicus Data Space Ecosystem), Sentinel-2 L2A"
  };
}

async function handleNDVI(url, env) {
  const bboxStr = url.searchParams.get("bbox") || DEFAULT_BBOX;
  const months = Math.max(1, Math.min(12, parseInt(url.searchParams.get("months") || "3", 10)));

  try {
    const result = await computeNDVI(bboxStr, months, env);
    return json({
      bem_component: "D_f (NDVI proxy)",
      method: "sentinel_hub_statistical_api",
      bbox: bboxStr,
      ...result,
      caveat: "Cloud-aggregated statistics over full bbox and time window, not a spatial grid — single mean/stDev value for the whole area."
    });
  } catch (e) {
    return json({ error: e.message, step: "ndvi" }, 502);
  }
}

// ── NDVI-kuva via Sentinel Hub Process API ───────────────────────────────
// SAMA OAuth-tunnistautuminen (getCopernicusToken) kuin Statistical API:lla,
// mutta Process API palauttaa RENDEROIDUN kuvan (PNG), ei tilastoja.
// Vari-evalscript maarittelee vihrea->keltainen->punainen-liukuvarin
// suoraan NDVI-arvosta - sama visuaalinen konventio kuin useimmissa
// julkisissa satelliittikuva-NDVI-esityksissa (esim. NASA Earth Observatory).
//
// HUOM: tama on ERI kutsu (eri hinnoittelu/kiintio Copernicus-tilillä)
// kuin /ndvi:n oma Statistical API -kutsu - kuvan pyytäminen usein
// (esim. joka sivunlatauksella) kuluttaa Process Unit -kiintiota nopeammin
// kuin pelkka tilastokutsu. Ei omaa valimuistia (cache) tassa versiossa -
// jos kaytto kasvaa, harkitse KV-pohjaista valimuistia (esim. 6h TTL).
const NDVI_IMAGE_EVALSCRIPT = `
//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B04", "B08", "SCL", "dataMask"] }],
    output: { bands: 4, sampleType: "UINT8" }
  };
}

// Vihrea->keltainen->punainen, korkea NDVI (terve kasvillisuus) = vihrea,
// matala/negatiivinen NDVI (paljas maa, kuivunut) = punainen. Sama
// suunta kuin useimmissa julkisissa NDVI-kartoissa.
function ndviColor(ndvi) {
  if (ndvi < 0.0)  return [140, 90, 60];    // paljas maa / kuivunut - ruskea
  if (ndvi < 0.2)  return [204, 60, 45];    // punainen - hyvin vahaista kasvillisuutta
  if (ndvi < 0.35) return [224, 150, 55];   // oranssi
  if (ndvi < 0.5)  return [220, 200, 70];   // keltainen
  if (ndvi < 0.65) return [150, 190, 70];   // vaaleanvihrea
  if (ndvi < 0.8)  return [70, 150, 60];    // vihrea
  return [30, 100, 40];                     // tummanvihrea - tiheä metsa
}

function evaluatePixel(s) {
  var isWater = (s.SCL == 6);
  if (s.dataMask == 0 || isWater) {
    return [190, 205, 215, 90]; // vaalea sinertava, lapinakyva - vesi/data puuttuu
  }
  var ndvi = (s.B08 - s.B04) / (s.B08 + s.B04);
  var c = ndviColor(ndvi);
  return [c[0], c[1], c[2], 255];
}
`;

async function fetchNDVIImage(bboxStr, months, width, height, env) {
  if (!env.COPERNICUS_CLIENT_ID || !env.COPERNICUS_CLIENT_SECRET) {
    throw new Error("COPERNICUS_CLIENT_ID / COPERNICUS_CLIENT_SECRET not configured (wrangler secret put ...)");
  }
  const [minLon, minLat, maxLon, maxLat] = bboxStr.split(",").map(Number);

  const now = new Date();
  const to = now.toISOString();
  const from = new Date(now.getTime() - months * 30 * 24 * 3600 * 1000).toISOString();

  const token = await getCopernicusToken(env);

  const processRequest = {
    input: {
      bounds: {
        bbox: [minLon, minLat, maxLon, maxLat],
        properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" }
      },
      data: [{
        type: "sentinel-2-l2a",
        dataFilter: {
          maxCloudCoverage: 40,
          mosaickingOrder: "leastCC",
          timeRange: { from, to }
        }
      }]
    },
    output: {
      width,
      height,
      responses: [{ identifier: "default", format: { type: "image/png" } }]
    },
    evalscript: NDVI_IMAGE_EVALSCRIPT
  };

  const r = await fetch("https://sh.dataspace.copernicus.eu/api/v1/process", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "image/png",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify(processRequest)
  });
  if (!r.ok) {
    throw new Error(`Process API: HTTP ${r.status} ${await r.text()}`);
  }
  return await r.arrayBuffer();
}

async function handleNDVIImage(url, env) {
  const bboxStr = url.searchParams.get("bbox") || DEFAULT_BBOX;
  const months = Math.max(1, Math.min(12, parseInt(url.searchParams.get("months") || "3", 10)));
  // Leveys/korkeus suhteessa bbox:in omaan kuvasuhteeseen (~1.36:1
  // oletus-Rautalammin-bbox:lle), katto 640px per Process API:n
  // omaa jarkevaa kayttoa varten - ei tarvita suurempaa nain pientä
  // esikatselukuvaa varten.
  const width  = Math.max(64, Math.min(640, parseInt(url.searchParams.get("w") || "480", 10)));
  const height = Math.max(64, Math.min(640, parseInt(url.searchParams.get("h") || "350", 10)));

  try {
    const png = await fetchNDVIImage(bboxStr, months, width, height, env);
    return new Response(png, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=21600", // 6h - Process Unit -kiintion sailytys
        ...CORS
      }
    });
  } catch (e) {
    return json({ error: e.message, step: "ndvi-image" }, 502);
  }
}

// ── Yhdistetty reitti: CORINE + NDVI rinnakkain, ristiintarkistus + D_f ──
async function handleCombined(url, env) {
  const bboxStr = url.searchParams.get("bbox") || DEFAULT_BBOX;
  // Katto 6 (36 pistetta), ei 10 (100 pistetta) niin kuin /fragmentation
  // sallii yksinaan. Syy: Cloudflare Workers -ilmaistason 50 ulkoisen
  // subrequestin raja per suoritus. /combined tekee CORINE-ruudukon
  // LISAKSI 2 NDVI-pyyntoa (token + tilastot) samassa suorituksessa -
  // 49 (7x7) + 2 = 51 ylitti rajan yhdella (havaittu 2026-07-08).
  // 36 (6x6) + 2 = 38, reilusti alle.
  const n = Math.min(6, parseInt(url.searchParams.get("grid") || "6", 10));
  const months = Math.max(1, Math.min(12, parseInt(url.searchParams.get("months") || "3", 10)));

  const [corineResult, ndviResult] = await Promise.allSettled([
    computeFragmentation(bboxStr, n),
    computeNDVI(bboxStr, months, env)
  ]);

  const corine = corineResult.status === "fulfilled" ? corineResult.value : null;
  const ndvi = ndviResult.status === "fulfilled" ? ndviResult.value : null;
  const errors = {};
  if (corineResult.status === "rejected") errors.corine = corineResult.reason.message;
  if (ndviResult.status === "rejected") errors.ndvi = ndviResult.reason.message;

  // Ristiintarkistus: CORINE:n oma vesiosuus vs. NDVI:n noData-ylaraja
  // (joka sisaltaa veden LISAKSI pilvet ja virheelliset pikselit - ei
  // puhdas vesiosuus, siksi vain "samaa suuruusluokkaa" -tarkistus,
  // ei tarkka yhtasuuruus).
  let crossCheck = null;
  if (corine && ndvi && ndvi.no_data_fraction_upper_bound != null) {
    crossCheck = {
      corine_water_fraction: corine.water_fraction,
      ndvi_no_data_fraction_upper_bound: ndvi.no_data_fraction_upper_bound,
      plausible: ndvi.no_data_fraction_upper_bound >= corine.water_fraction - 0.05,
      note: "NDVI-arvo sisältää veden lisäksi pilvet ja virheelliset pikselit — sen pitäisi olla >= CORINE:n vesiosuus, ei täsmälleen sama."
    };
  }

  // D_f: metsäosuus (CORINE) + NDVI-hajonta (heterogeenisuussignaali).
  // Laikkukoko-komponentti poistettu (ks. /fragmentation-kommentit).
  // NDVI stDev normalisoitu: 0.30 = tyypillinen yläraja luonnontilaiselle
  // vaihtelulle, tätä korkeampi -> 1.0. Dokumentoitu arvio, ei standardi.
  let D_f = null;
  const components = {};
  if (corine) {
    components.forest_component = +(1 - corine.forest_fraction).toFixed(3);
  }
  if (ndvi && ndvi.ndvi_stats) {
    components.heterogeneity_component = +Math.min(1, ndvi.ndvi_stats.stDev / 0.30).toFixed(3);
  }
  if (components.forest_component != null && components.heterogeneity_component != null) {
    D_f = +(0.6 * components.forest_component + 0.4 * components.heterogeneity_component).toFixed(3);
  } else if (components.forest_component != null) {
    D_f = components.forest_component; // NDVI epäonnistui, käytä vain CORINE:a
  }

  return json({
    bem_component: "D_f (combined proxy)",
    D_f,
    D_f_components: components,
    bbox: bboxStr,
    corine,
    ndvi,
    cross_check: crossCheck,
    errors: Object.keys(errors).length ? errors : null,
    caveat: "D_f yhdistää kaksi riippumatonta, molemmat vielä proxy-tasoisia signaalia — ei validoitu todellista fragmentaatiomittausta vasten. Katso corine/ndvi-kentät raakadataa varten."
  });
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
      } else if (path === "/ndvi-image") {
        return await handleNDVIImage(url, env);
      } else if (path === "/mndwi") {
        return await handleMNDWI(url, env);
      } else if (path === "/mndwi-image") {
        return await handleMNDWIImage(url, env);
      } else if (path === "/ndci") {
        return await handleNDCI(url, env);
      } else if (path === "/ndci-image") {
        return await handleNDCIImage(url, env);
      } else if (path === "/lake-timeseries") {
        return await handleLakeTimeseries(url, env);
      } else if (path === "/catalog-check") {
        return await handleCatalogCheck(url, env);
      } else if (path === "/combined") {
        return await handleCombined(url, env);
      } else if (path === "/recovery") {
        return await handleR(url);
      } else {
        return json({ error: `Unknown route: ${path}` }, 404);
      }
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }
};
