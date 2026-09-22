// aci-corine-proxy
// D_f (fragmentaatio) -datalähde BEM:lle (Biodiversity Endurance Monitor).
// Hakee SYKE:n avoimesta inspire_lc WMS -rajapinnasta (CorineLandCover2018),
// ei autentikointia. Katso: https://ckan.ymparisto.fi/dataset/syke-maanpeite-wcs
//
// TÄRKEÄ HUOMIO: tämä on ruudukkopisteotantaan perustuva PROXY, ei todellinen
// laikkukoko/reunatiheys-fragmentaatioanalyysi. Todellinen fragmentaatioanalyysi
// vaatisi täyden raster/vektori-topologia-käsittelyn (GeoPandas/Rasterio-tasoinen
// putki, kuvattu TN-015:n arkkitehtuuriosiossa, "Pre-development"-tilassa).

import IISVESI_MASK from "./iisvesi_ndci_mask.json";
import IISVESI_RAW_MASK from "./iisvesi_lake_raw.json";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*"
};

// Bumpataan jokaisella BEM-E-korjauskierroksella - /version-reitti (item 4).
const PROXY_VERSION = "0.9.7-ndci-bbox-hint";

const DEFAULT_BBOX = "26.00,62.40,27.50,63.50"; // Rautalammin reitti pilottialue

// Iisvesi-Virmasvesi-Rasvanki -jarviryhma (BEM-E §09). Kayttajan
// 2026-09-17 Sentinel-2-analyysi (NIR<0.05 kolmella pilvettomalla kuvalla,
// 20 m, laatat 35VMK+35VNK): raaka jarviala 156.9 km^2, bbox 26.695,62.666,
// 27.051,63.004 - KORVAA aiemmat kaksi arvattua bbox-esimerkkia (jotka
// kumpikaan eivat osuneet oikein: toinen leikkasi pohjoisosan, toinen oli
// 2x liian laaja pohjois-etela). IISVESI_MASK-polygoni (-40 m rantapuskuri,
// 137.4 km^2, 8 osaa, 3089 kärkea, EPSG:4326) kaytetaan NDCI:n shoreline-
// eroosioon (item 5b) - EI kaytetty MNDWI:lle, jonka tarkoitus on
// nimenomaan mitata vesiala koko bbox:in yli.
const IISVESI_BBOX = "26.695,62.666,27.051,63.004";

// SYKE JarviWiki-jarvirekisteri 14.722.1.001, vahvistettu 2026-09-17:
// Iisvesi+Virmasvesi+Rasvanki YHTEENSA 164.47 km^2 (eteläinen allas
// Nokisenkosken alapuolella EI mukana). IISVESI_RAW_MASK (rajaamaton
// jarvipolygoni, 157.9 km^2, 4310 karkea, EPSG:4326) kayttajan omasta
// Sentinel-2-maskista - kaytetaan ?polygon=iisvesi_raw:lla MNDWI:n
// jarvi-kohtaiseen mittariin (odotettu vesiosuus >=95%).
const IISVESI_AREA_KM2 = 164.47;

// KORJATTU 2026-09 (kayttajan mittaus): sampleCount oli 36000 KAIKILLA
// bbox/polygon-kooilla, koska width/height oli kiinnitetty vakioksi -
// pikselikoko vaihteli rajauksen mukaan (Iisveden polygonissa ~130 m,
// ei 20 m). Tama teki -40 m rantapuskurista merkityksettoman (yksi
// pikseli on puskuria leveampi). Korjaus: resx/resy Sentinel-2:n omalla
// ~20 m resoluutiolla, EI kiinnitetty pikselimaara. HUOM aiempi bugi
// (2026-07-08, "astevs-metri-yksikkobugi"): resx/resy on ANNETTAVA
// bounds-CRS:n omissa yksikoissa - EPSG:4326:lla se on ASTEITA, ei
// metreja. computeResxResy() laskee asteen vastaavuuden oikein
// (resy = m/111320, resx = m/(111320*cos(keskileveysaste))).
const RESOLUTION_M = 20;

function computeResxResy(minLat, maxLat, resolutionM = RESOLUTION_M) {
  const midLatRad = ((minLat + maxLat) / 2) * Math.PI / 180;
  const resy = resolutionM / 111320;
  const resx = resolutionM / (111320 * Math.cos(midLatRad));
  return { resx, resy };
}

// MAX_PIXELS-katto (item 2, kayttajan ohje): 20 m kiinteana kaikille
// rajauksille olisi ~23 milj. pikselia DEFAULT_BBOX:lle (76x122 km) -
// kuluttaisi Sentinel Hubin Process Unit -kiintiota tarpeettomasti ja
// riskeeraisi kiintion loppumisen. adaptiveResolutionM kasvattaa
// pikselikokoa isoille rajauksille (resolution_m = max(20, sqrt(bbox_ala_m2
// / 250000))) mutta pysyy 20 m:ssa pienille (Iisvesi-polygonit/bbox
// mahtuvat 20 m:iin talla kaavalla - ks. kayttajan omat luvut: 52 m
// Iisvesi-bboxille, ~193 m DEFAULT_BBOX:lle).
const MAX_PIXELS = 250000;

function adaptiveResolutionM(minLon, minLat, maxLon, maxLat, maxPixels = MAX_PIXELS, minResolutionM = RESOLUTION_M) {
  const midLatRad = ((minLat + maxLat) / 2) * Math.PI / 180;
  const kmPerLonDeg = 111.32 * Math.cos(midLatRad);
  const widthKm = (maxLon - minLon) * kmPerLonDeg;
  const heightKm = (maxLat - minLat) * 111.32;
  const areaM2 = widthKm * heightKm * 1e6;
  return Math.max(minResolutionM, Math.sqrt(areaM2 / maxPixels));
}

// Laskee GeoJSON-geometrian (Polygon/MultiPolygon) bbox:in [minLon,minLat,
// maxLon,maxLat] - tarvitaan resx/resy-laskentaan kun kutsu kayttaa
// polygon-parametria bbox:in sijaan.
function geometryBounds(geometry) {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  function walk(c) {
    if (typeof c[0] === "number") {
      if (c[0] < minLon) minLon = c[0];
      if (c[0] > maxLon) maxLon = c[0];
      if (c[1] < minLat) minLat = c[1];
      if (c[1] > maxLat) maxLat = c[1];
    } else {
      for (const x of c) walk(x);
    }
  }
  walk(geometry.coordinates);
  return [minLon, minLat, maxLon, maxLat];
}

// KORJATTU 2026-09-21 (kayttajan ohje 3): polygon-kyselyissa (Iisvesi-
// ryhma, aina pieni) resoluutio on KIINTEA 20 m - kalibrointi ja live-arvo
// on aina laskettava samalla resoluutiolla, muuten ne eivat ole
// vertailukelpoisia (kayttaja mittasi 93.6% 20 m:lla ja mediaanin 88.8%
// 52 m:lla samalle polygonille - erot johtuivat resoluutiosta, ei jarvesta).
// Adaptiivinen resoluutio (MAX_PIXELS-katto) pysyy kaytossa VAIN bbox-
// kyselyille, joissa rajaus voi olla mielivaltaisen suuri (DEFAULT_BBOX).
function resolveResolutionM(polygonGeoJson, minLon, minLat, maxLon, maxLat) {
  return polygonGeoJson ? RESOLUTION_M : adaptiveResolutionM(minLon, minLat, maxLon, maxLat);
}

// KORJATTU 2026-09-21 (kayttajan riippumaton tarkistus Earth Searchista):
// yksi P{months*30}D- tai P{spanDays}D-vali antoi Statistical API:n omalla
// "yksi mosaiikki per vali" -logiikalla KESAN VIIMEISEN pilvettoman kuvan,
// EI kesan keskiarvoa - eri vuosien erot selittyivat sen mukaan millainen
// se yksittainen viimeinen kuva sattui olemaan (syksylla aurinko matalalla,
// heijastukset hairitsevat). Korjaus: pilkotaan aikavali P10D-osavaleihin
// (Statistical API:n oma aggregointi, ei kutsuja Workerista), lasketaan
// tilasto JOKAISELLE osavalille erikseen, ja otetaan MEDIAANI niista
// osavaleista joissa validien (ei-pilvi/ei-nodata) pikselien osuus on
// vahintaan minValidFraction (oletus 50%) - vahentaa yksittaisten
// pilvisten/reunatapausten vaikutusta koko kesan yli.
// 0.9.3: polygonin pinta-ala (m²) paikallisella tasoprojektiolla — riittää
// validien pikselien odotusarvoon (~1 % tarkkuus Suomen leveyksillä).
function polygonAreaM2(geom) {
  if (!geom) return null;
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.type === "MultiPolygon" ? geom.coordinates : [];
  const R = 6371008.8;
  const ringArea = ring => {
    const lat0 = ring.reduce((a, c) => a + c[1], 0) / ring.length * Math.PI / 180;
    let a = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const x1 = ring[i][0] * Math.PI / 180 * R * Math.cos(lat0), y1 = ring[i][1] * Math.PI / 180 * R;
      const x2 = ring[i+1][0] * Math.PI / 180 * R * Math.cos(lat0), y2 = ring[i+1][1] * Math.PI / 180 * R;
      a += x1 * y2 - x2 * y1;
    }
    return Math.abs(a) / 2;
  };
  let total = 0;
  for (const poly of polys) poly.forEach((ring, k) => { total += (k === 0 ? 1 : -1) * ringArea(ring); });
  return total;
}

// 0.9.3: expectedValidPixels. Polygonikyselyssä sampleCount on polygonin
// BBOXIN pikselimäärä ja polygonin ulkopuoli on noDataa → (sample−noData)/sample
// jäi aina ~0,24:ään (Iisvesi) eikä yksikään väli läpäissyt 0,5-rajaa.
// Nyt nimittäjä = polygonin odotettu pikselimäärä, kun polygoni on annettu.
async function computeMedianOverIntervals(evalscript, bounds, resx, resy, fromISO, toISO, env, maxCloudCoverage = 40, intervalDays = 10, minValidFraction = 0.5, expectedValidPixels = null) {
  const token = await getCopernicusToken(env);
  const statsRequest = {
    input: {
      bounds,
      data: [{
        type: "sentinel-2-l2a",
        dataFilter: { maxCloudCoverage, mosaickingOrder: "leastCC" },
        // KORJATTU 2026-09-21 (item 4, kayttajan ohje): kayttajan oma
        // riippumaton tarkistus loysi Sen2Cor-kasittelyversioita 04.00:sta
        // 05.11:een SAMAN aikasarjan sisalla - baseline 04.00 lisasi
        // BOA_ADD_OFFSET-siirtyman heijastusarvoihin, joka vaaristaa
        // suoraan vertailun ilman korjausta. harmonizeValues normalisoi
        // taman kaikille vuosille samaksi.
        processing: { harmonizeValues: true }
      }]
    },
    aggregation: {
      timeRange: { from: fromISO, to: toISO },
      aggregationInterval: { of: `P${intervalDays}D`, lastIntervalBehavior: "SHORTEN" },
      evalscript,
      resx, resy
    }
  };

  const r = await fetch("https://sh.dataspace.copernicus.eu/statistics/v1", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify(statsRequest)
  });
  if (!r.ok) throw new Error(`Statistical API: HTTP ${r.status} ${await r.text()}`);
  const data = await r.json();
  const entries = data?.data || [];

  const intervals = [];
  for (const entry of entries) {
    const stats = entry?.outputs?.data?.bands?.B0?.stats;
    if (!stats || !stats.sampleCount) continue;
    const waterStats = entry?.outputs?.water?.bands?.B0?.stats;
    const validFraction = Math.min(1, (stats.sampleCount - stats.noDataCount) / (expectedValidPixels || stats.sampleCount));
    intervals.push({
      from: entry.interval?.from,
      to: entry.interval?.to,
      mean: stats.mean,
      stDev: stats.stDev,
      sampleCount: stats.sampleCount,
      noDataCount: stats.noDataCount,
      valid_fraction: Math.round(validFraction * 1000) / 1000,
      water_fraction_pct: waterStats ? Math.round(waterStats.mean * 1000) / 10 : null
    });
  }

  const used = intervals.filter(iv => iv.valid_fraction >= minValidFraction);

  function median(arr, key) {
    const vals = arr.map(x => x[key]).filter(v => v != null).sort((a, b) => a - b);
    if (!vals.length) return null;
    const n = vals.length;
    return n % 2 ? vals[(n - 1) / 2] : (vals[n / 2 - 1] + vals[n / 2]) / 2;
  }

  return {
    n_intervals_total: intervals.length,
    n_intervals_used: used.length,
    min_valid_fraction: minValidFraction,
    median_mean: median(used, "mean"),
    median_water_fraction_pct: median(used, "water_fraction_pct"),
    intervals
  };
}

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

function handleVersion() {
  // /version — sama tarkoitus kuin aci-nve-proxyn ja metsaproxyn /version:
  // kevyt, ei-autentikoitu reitti deployn tarkistukseen (ei kutsu
  // Copernicusta, ei API-avaimia tarvita).
  return json({
    proxy: "aci-corine-proxy",
    version: PROXY_VERSION,
    changelog_latest: "2026-09-22 (0.9.7): NDCI:n bbox-tilan no_valid_intervals-virheeseen lisatty hint-kentta, kun kutsu ei ole polygon-muotoinen. Kayttajan diagnoosi HEM:n §09-virheesta (BEM-E): bbox-tila vaatii SCL==6-vesipikseleita >=50% per P10D-vali (item 2), joten maavaltaisella bbox:illa (esim. HEM:n oma bbox, vesiosuus 19% MNDWI:n mukaan) kaikki valit hylataan AINA - ei ohimeneva virhe eika satunnainen. Ei muutettu itse kynnysta - vain selkeytetty virheviestia, jotta kutsuja ymmartaa vaihtaa polygon-tilaan. (0.9.6): Poikkeama = havaitun vaihteluvalin ulkopuolisuus + jarjestysluku (water_fraction_rank / ndci_rank, esim. 2/9 alimmasta), ei 2*sd-raja. Syy: 8 vuoden aineistolla sd-raja on hauras - 0.9.5:ssa NDCI iisvesi (-0.0337) ylitti rajan 0.0002:lla, vaikka 2018 (-0.0364) oli matalampi. Vuosikohtaiset kalibrointiarvot lisatty perusarvoihin (values). Havaintovuosi jatetaan pois vertailusta, jos se on itse kalibrointivuosi. Tarkistettu 2026-09-21: NDCI ei korreloi kesan virtaaman kanssa (r=0.09, Nokisenkoski 2018-2026) - matala NDCI ei ole kuivuusindikaattori. (0.9.5): (1) NDCI-perusarvot polygonikohtaisiksi - /ndci kayttaa -40 m puskuroitua polygonia (iisvesi), mutta 0.9.4:n perusarvo 0.0168 oli rajaamattomasta (iisvesi_raw); live -0.023 halytti virheellisesti. Uudelleenkalibroitu iisvesi: mediaani -0.0015, sd 0.0160 (rantapikselit nostivat NDCI:ta ~0.018). Vesiosuuden perusarvo vain iisvesi_raw:lle. (2) Kausi-ikkuna: polygonikutsu ilman ?months= laskee 1.5.->nyt (touko-syyskuu), sama ikkuna kuin perusarvoissa; ?months= antaa anomaly=null. comparison_window-kentta vastaukseen. (3) /ndci hyvaksyy myos ?polygon=iisvesi_raw. (4) Vanhentuneet EI VIELA live-testattu -tekstit poistettu /mndwi- ja /ndci-reiteilta. (0.9.4): ENSIMMAINEN onnistunut kalibrointiajo (/lake-timeseries?polygon=iisvesi_raw&indices=mndwi,ndci&startYear=2018&endYear=2025, 20m, kaikki 8 vuotta laskettu, 9-14 kayttokelpoista P10D-valia/vuosi). Vesiosuus: mediaani 91.65%, keskihajonta 1.69pp, vaihteluvali 88.1-94.1% - korvaa arvioidun 95%:n rajan (IISVESI_RAW_EXPECTED_WATER_FRACTION_PCT_MIN poistettu, tilalla IISVESI_RAW_WATER_FRACTION_BASELINE {median,sd,range}; poikkeama = |havainto-91.65|>2*keskihajonta). NDCI: mediaani 0.0168, keskihajonta 0.0136 (IISVESI_NDCI_BASELINE) - vuosien 2024-2025 aiempi romahdus (-0.31/-0.57) vahvistui 0.9.1-0.9.3:n laskentavirheeksi, ei jarven muutokseksi (kayttajan riippumaton Earth Search -tarkistus: -0.012...0.035, sopusoinnussa). Vesiosuudella EI korrelaatiota Iisveden mitatun kesan keskivedenkorkeuden kanssa (r=0.06, SYKE-asema 1966, 2018-2025, esim. 2022: jakson pienin vesiosuus, suurin vedenkorkeus) - vuosien valinen vaihtelu johtuu vesikasvillisuudesta/heijastuksista/kelpuutetuista P10D-valeista, EI kuivuudesta; kuivuus mitataan HEM:ssa SYKE-sarjoilla (§02). (0.9.3): P10D-valien validiosuus laskettiin polygonin BBOXIN pikseleista (sampleCount), jolloin polygonin ulkopuoli oli noDataa ja osuus jai Iisvedella aina ~0,24:aan - 0/12-16 valia lapaisi 0,5-rajan joka vuonna. Nimittaja on nyt polygonin odotettu pikselimaara (polygonAreaM2 / res^2), bbox-kyselyissa ennallaan. (0.9.2): kaistakohtainen input-jako (0.9.1) tulkittiin datafuusioksi - Dataset with id: 1 not found. Palattu yhteen input-objektiin ilman units-kenttaa: oletukset ovat B-kaistoille REFLECTANCE ja SCL/dataMask DN, eli sama kuin eksplisiittinen tavoite. (0.9.1): units:REFLECTANCE koski koko input-lohkoa myos SCL:aa, jota Sentinel Hub tukee vain DN-yksikkona - kaikki 16 /lake-timeseries-kutsua palauttivat HTTP 400 (Invalid script! Band SCL requested in unsupported units REFLECTANCE). Input jaettu kaistakohtaisiin objekteihin: indeksikaistat REFLECTANCE, SCL DN, dataMask oletus. Koskee MNDWI_EVALSCRIPT, NDCI_EVALSCRIPT, NDCI_EVALSCRIPT_POLYGON. 2026-09-21: kayttajan riippumaton Earth Search -tarkistus paljasti etta yksi P{months*30}D/P{spanDays}D-vali antoi kesan VIIMEISEN pilvettoman kuvan, ei keskiarvoa - korvattu P10D-osavalien mediaanilla (computeMedianOverIntervals, n_intervals_used/n_intervals_total nakyviin) kaikissa: /mndwi, /ndci, /lake-timeseries. SCL==6-vaatimus poistettu NDCI:n polygon-kutsuilta (kattoi mittauksessa vain 35-40% polygonista - NDCI_EVALSCRIPT_POLYGON kayttaa pilvimaskia). Resoluutio: polygon-kutsut AINA kiintea 20m (resolveResolutionM), adaptiivinen VAIN bbox-kutsuille - kalibrointi ja live-arvo eivat olleet vertailukelpoisia (88.8%@52m vs 93.6%@20m). harmonizeValues:true lisatty (Sen2Cor-baseline 04.00-05.11 -yhtenaistys) + units:REFLECTANCE eksplisiittisena. Aiemmat: lastIntervalBehavior=SHORTEN (2026-09-18), resx/resy+MNDWI-pilvimaski+/version (2026-09-17).",
    deployed_check: new Date().toISOString()
  });
}

function handleStatus() {
  return json({
    proxy: "aci-corine-proxy",
    version: PROXY_VERSION,
    purpose: "D_f and R data sources for BEM — Biodiversity Endurance Monitor",
    pilot: "Rautalammin reitti",
    default_bbox: DEFAULT_BBOX,
    routes: {
      "/status": "Proxy status",
      "/version": "Deploy-tarkistus (versio + changelog)",
      "/fragmentation": "Grid-sampled CORINE D_f proxy · ?bbox=...&grid=7 (n x n points, max 7x7)",
      "/ndvi": "Sentinel Hub Statistical API — NDVI mean/stDev over bbox · ?bbox=...&months=3 · adaptiivinen resoluutio (20-193m riippuen bbox:in koosta, ks. resolution_m) · HUOM stDev ennen v0.6 ei ole vertailukelpoinen (oli ~500m/px DEFAULT_BBOX:lla)",
      "/ndvi-image": "Sentinel Hub Process API — renderoitu NDVI-kuva (vihrea-keltainen-punainen) · ?bbox=...&months=3&w=480&h=350",
      "/mndwi": "BEM-E (Aquatic Extension) — MNDWI [A-luokka] · ?bbox=26.695,62.666,27.051,63.004&months=3 (Iisvesi-ryhma, adaptiivinen resoluutio) TAI ?polygon=iisvesi_raw (jarvi-kohtainen, kalibroitu perusarvo mediaani 91.65%±1.69pp, kiintea 20m) · mediaani P10D-osavaleista (n_intervals_used), SCL-pilvimaski, harmonizeValues · polygon ilman months-parametria = kausi-ikkuna 1.5.->nyt ja poikkeamavertailu · live-testattu 2026-09-21",
      "/mndwi-image": "BEM-E — renderoitu MNDWI-kuva (ruskea-vihrea-sininen) · ?bbox=...&months=3&w=480&h=480 · EI VIELA live-testattu",
      "/ndci": "BEM-E — NDCI [B-luokka, KOKEELLINEN] · ?bbox=...&months=3 (SCL==6-vaatimus, adaptiivinen resoluutio) TAI ?polygon=iisvesi (-40m rantapuskuroitu, 137.4 km^2) TAI ?polygon=<oma GeoJSON>&months=3 (pilvimaski, EI SCL==6, kiintea 20m) · mediaani P10D-osavaleista, harmonizeValues · perusarvot polygonikohtaisia (iisvesi -0.0015 / iisvesi_raw 0.0168) · polygon ilman months-parametria = kausi-ikkuna 1.5.->nyt ja poikkeamavertailu · live-testattu 2026-09-21",
      "/ndci-image": "BEM-E — renderoitu NDCI-kuva (sininen-vihrea-keltainen-punainen) [B-luokka] · ?bbox=...&months=3&w=480&h=480 · EI VIELA live-testattu",
      "/lake-timeseries": "BEM-E — takautuva kesakauden (touko-syyskuu) MNDWI+NDCI-aikasarja, P10D-mediaani per vuosi · ?bbox=...&startYear=2018&endYear=2025&indices=mndwi,ndci TAI ?polygon=iisvesi_raw (kalibroitu 2026-09-21, ks. IISVESI_RAW_WATER_FRACTION_BASELINE/IISVESI_NDCI_BASELINE-kommentit) · live-testattu · yksi API-kutsu per vuosi per indeksi · HUOM: startYear<2018 EI TUETTU, L2A ei systemaattista Euroopassa ennen 2017-05",
      "/catalog-check": "Diagnostiikka - STAC Catalog API -haku, tarkistaa onko Sentinel-2 L2A -skeneja olemassa JA Sen2Cor processing_baseline -yhtenaisyys (SCL-vesiluokan vertailukelpoisuus) · ?bbox=...&from=...&to=... (ISO 8601)",
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
// Kiintea kynnys vesi/maa-luokitukseen. Xu 2006 -oletus on 0 (MNDWI>0 =
// vesi). HUOM: turbidilla/humuspitoisella jarvella kynnys voi vaatia
// kalibrointia paikallisesti - 0 on lahtokohta, ei validoitu Iisveden/
// Rautalammin reitin omaa dataa vastaan (ei live-testattu, ks. caveat).
const MNDWI_WATER_THRESHOLD = 0;

// KORJATTU 2026-09 (item 3, kayttajan mittaus: noDataCount 23 = pilvet
// laskettiin mukaan tilastoon). SCL-pilvimaski lisatty - EI rajata
// pelkkiin vesipikseleihin (se olisi NDCI:n logiikka, ei MNDWI:n oma
// tarkoitus). Poistetaan: 0 NO_DATA, 1 SATURATED_DEFECTIVE,
// 3 CLOUD_SHADOWS, 8 CLOUD_MEDIUM_PROBABILITY, 9 CLOUD_HIGH_PROBABILITY,
// 10 THIN_CIRRUS. Vesi (6), maa (2,4,5,7) ja lumi/jaa (11) jaavat mukaan.
const MNDWI_EVALSCRIPT = `
//VERSION=3
function setup() {
  return {
    // units: "REFLECTANCE" eksplisiittisena (item 4, kayttajan ohje) - ei
    // jateta oletusarvon varaan, samat yksikot kaikille kasittelyversioille
    // yhdessa harmonizeValues:n kanssa (ks. computeMedianOverIntervals).
    // Yksi input-objekti = yksi datalahde. Useampi objekti tulkitaan
    // datafuusioksi (0.9.1: "Dataset with id: 1 not found"). units jatetaan
    // oletukselle: B-kaistat = REFLECTANCE, SCL/dataMask = DN (0.9: SCL ei
    // tue REFLECTANCE-yksikkoa).
    input: [{ bands: ["B03", "B11", "SCL", "dataMask"] }],
    output: [
      { id: "data", bands: 1 },
      { id: "water", bands: 1 },
      { id: "dataMask", bands: 1 }
    ]
  };
}
function evaluatePixel(samples) {
  let mndwi = (samples.B03 - samples.B11) / (samples.B03 + samples.B11);
  let valid = (samples.B03 + samples.B11 == 0) ? 0 : 1;
  let water = (mndwi > ${MNDWI_WATER_THRESHOLD}) ? 1 : 0;
  let scl = samples.SCL;
  let cloudFree = (scl == 0 || scl == 1 || scl == 3 || scl == 8 || scl == 9 || scl == 10) ? 0 : 1;
  return {
    data: [mndwi],
    water: [water],
    dataMask: [samples.dataMask * valid * cloudFree]
  };
}
`;

// Mitattu 2026-09-17 (kayttajan Sentinel-2-maski): koko IISVESI_BBOX:in
// pysyva avovesi on 37.0% - EI Iisveden 156.9-164.47 km^2 / bbox-ala,
// koska rajaukseen kuuluu myos osia Niinivedesta, Nokisenkosken alapuolinen
// allas ja muita jarvia. Aiempi laskukaava (Iisveden pinta-ala jaettuna
// bbox-alalla) OLETTI VIRHEELLISESTI etta bbox:in ainoa vesi on Iisvesi -
// mitattu 33.7% osui talla oletuksella "vaarin" vaikka oli oikeasti
// sopusoinnussa 37.0%:n kanssa (karkea 130m-pikselikoko jatti osan
// rantavedesta laskematta, korjattu resx/resy-muutoksella yllä).
const IISVESI_BBOX_WATER_FRACTION_PCT = 37.0;

// Iisvesi-JARVI-kohtainen mittari (?polygon=iisvesi_raw, IISVESI_RAW_MASK
// - rajaamaton jarvipolygoni, EI -40m puskuria, 157.9 km^2).
// KALIBROITU 2026-09-21: /lake-timeseries?polygon=iisvesi_raw&indices=mndwi,ndci
// &startYear=2018&endYear=2025, 20m-resoluutio (item 3), P10D-mediaani per
// vuosi (item 1), validiosuuden nimittaja polygonin oma pikselimaara
// (0.9.3-korjaus). Kaikki 8 vuotta laskettiin, 9-14 kayttokelpoista
// P10D-valia/vuosi. Vesiosuuden (mediaani 91.65%, keskihajonta 1.69pp,
// vaihteluvali 88.1-94.1%) ja Iisveden mitatun kesan keskivedenkorkeuden
// (SYKE, asema 1966, 2018-2025) valilla EI korrelaatiota (r=0.06) - esim.
// 2022 oli jakson pienin vesiosuus mutta suurin vedenkorkeus. Vuosien
// valinen vaihtelu johtuu vesikasvillisuudesta, heijastuksista ja siita
// mitka P10D-valit kelpuutettiin, EI kuivuudesta. Kuivuutta mitataan
// HEM:ssa SYKE:n vedenkorkeus- ja virtaamasarjoilla (§02), ei tata mittaria.
const IISVESI_RAW_WATER_FRACTION_BASELINE = {
  median: 91.65, sd: 1.69, range: [88.05, 94.10], years: "2018-2025",
  res_m: 20, method: "P10D-mediaani, valid >= 0.5 polygonin pikseleista",
  note: "Vesiosuus ei korreloi vedenkorkeuden kanssa (r = 0.06, SYKE-asema 1966, 2018-2025) - ei kuivuusindikaattori."
};

// NDCI-perusarvo samalta kalibrointiajolta (ks. yllä). Aiempi 2024-2025
// "romahdus" (-0.31, -0.57, yksittaisen P{spanDays}D-mosaiikin virhe) on
// poissa P10D-mediaanilla - kayttajan riippumaton Earth Search -tarkistus
// (-0.012...0.035) tayttyy talla perusarvolla.
const IISVESI_NDCI_BASELINE = { median: 0.0168, sd: 0.0136, years: "2018-2025" };

// 0.9.5: perusarvot POLYGONIKOHTAISIKSI. /ndci kayttaa oletuksena -40 m
// puskuroitua polygonia (iisvesi), mutta 0.9.4:n NDCI-perusarvo laskettiin
// rajaamattomasta (iisvesi_raw) -> live-arvo -0.023 hälytti virheellisesti.
// Uudelleenkalibrointi 2026-09-21 samalla polygonilla (/lake-timeseries
// ?polygon=iisvesi&indices=ndci, 20 m, 8/8 vuotta, 9-14 valia/v):
// mediaani -0.0015, sd 0.0160. Rantapikselit nostivat NDCI:ta ~0.018.
// 0.9.6: vuosikohtaiset kalibrointiarvot (touko-syyskuu, P10D-mediaani, 20 m).
// Poikkeama maaritellaan HAVAITUN VAIHTELUVALIN ulkopuolisuutena ja
// jarjestyslukuna, ei 2*sd-rajana: 8 vuoden aineistolla sd-raja on hauras
// (0.9.5: NDCI iisvesi ylitti rajan 0.0002:lla, vaikka 2018 oli matalampi).
const WATER_FRACTION_BASELINES = {
  iisvesi_raw: { ...IISVESI_RAW_WATER_FRACTION_BASELINE,
    values: { 2018: 91.6, 2019: 91.6, 2020: 91.7, 2021: 91.7, 2022: 88.05, 2023: 94.1, 2024: 93.25, 2025: 90.45 } }
};
const NDCI_BASELINES = {
  iisvesi:     { median: -0.0015, sd: 0.0160, years: "2018-2025", polygon: "iisvesi (-40 m)",
    values: { 2018: -0.0364, 2019: 0.00802, 2020: 0.00071, 2021: 0.00307, 2022: -0.02928, 2023: 0.00832, 2024: -0.00381, 2025: -0.01543 } },
  iisvesi_raw: { ...IISVESI_NDCI_BASELINE, polygon: "iisvesi_raw (rajaamaton)",
    values: { 2018: -0.01141, 2019: 0.02009, 2020: 0.02168, 2021: 0.01918, 2022: -0.0116, 2023: 0.02112, 2024: 0.01445, 2025: 0.00096 } }
};
// Sijoitus kalibrointivuosien joukossa. Havaintovuosi jatetaan pois
// vertailusta, jos se on itse kalibrointivuosi (ettei arvo vertaa itseaan).
function rankAgainstBaseline(baseline, x, year) {
  const vals = Object.entries(baseline.values).filter(([y]) => +y !== year).map(([, v]) => v);
  const min = Math.min(...vals), max = Math.max(...vals);
  const all = [...vals, x].sort((a, b) => a - b);
  const rankLow = all.indexOf(x) + 1, n = all.length;
  const outside = x < min || x > max;
  const pos = x < min ? "alle havaitun minimin" : x > max ? "yli havaitun maksimin"
    : `havaitun vaihteluvalin sisalla (${min} ... ${max})`;
  return { rank_low: rankLow, n, observed_min: min, observed_max: max, outside,
    label: `${rankLow}/${n} alimmasta, ${pos}` };
}
// Perusarvot on laskettu kesaikkunasta 1.5.-1.10. Live-vertailu tehdaan vain
// samalla kausi-ikkunalla: 1.5. -> nyt (touko-syyskuu), muuten edellisen
// kesan koko ikkuna. Eksplisiittinen ?months= ohittaa taman, jolloin
// anomaly = null (ikkuna ei vertailukelpoinen).
function seasonWindow(now) {
  const y = now.getUTCFullYear(), m = now.getUTCMonth() + 1;
  // Alle 10 vrk kauden alusta -> ei yhtaan P10D-valia; kaytetaan edellista kesaa.
  const early = m === 5 && now.getUTCDate() <= 10;
  if (m >= 5 && m <= 9 && !early) return { from: new Date(Date.UTC(y, 4, 1)).toISOString(), to: now.toISOString(), season: `${y} touko->nyt` };
  const yy = (m < 5 || early) ? y - 1 : y;
  return { from: new Date(Date.UTC(yy, 4, 1)).toISOString(), to: new Date(Date.UTC(yy, 9, 1)).toISOString(), season: `${yy} touko-syyskuu (kausi paattynyt)` };
}

async function computeMNDWI(bboxStr, months, env, polygonGeoJson, opts = {}) {
  if (!env.COPERNICUS_CLIENT_ID || !env.COPERNICUS_CLIENT_SECRET) {
    throw new Error("COPERNICUS_CLIENT_ID / COPERNICUS_CLIENT_SECRET not configured (wrangler secret put ...)");
  }
  const now = new Date();
  const sw = opts.useSeason ? seasonWindow(now) : null;
  const to = sw ? sw.to : now.toISOString();
  const from = sw ? sw.from : new Date(now.getTime() - months * 30 * 24 * 3600 * 1000).toISOString();

  const [minLon, minLat, maxLon, maxLat] = polygonGeoJson
    ? geometryBounds(polygonGeoJson)
    : bboxStr.split(",").map(Number);
  const resolutionM = resolveResolutionM(polygonGeoJson, minLon, minLat, maxLon, maxLat);
  const { resx, resy } = computeResxResy(minLat, maxLat, resolutionM);

  const bounds = polygonGeoJson
    ? { geometry: polygonGeoJson, properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" } }
    : { bbox: [minLon, minLat, maxLon, maxLat], properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" } };

  // KORJATTU 2026-09-21 (item 1): P{months*30}D yhtena valina antoi
  // Statistical API:n oman mosaiikkilogiikan takia kauden VIIMEISEN
  // pilvettoman kuvan, ei kauden keskiarvoa. computeMedianOverIntervals
  // pilkkoo P10D-osavaleihin ja ottaa mediaanin niista, joissa validien
  // pikselien osuus on riittava.
  const result = await computeMedianOverIntervals(MNDWI_EVALSCRIPT, bounds, resx, resy, from, to, env, 40, 10, 0.5,
    polygonGeoJson ? polygonAreaM2(polygonGeoJson) / (resolutionM * resolutionM) : null);

  if (result.n_intervals_used === 0) {
    return {
      error: "no_valid_intervals", n_intervals_total: result.n_intervals_total,
      time_range: { from, to }, resolution_m: resolutionM
    };
  }

  const waterFractionPct = result.median_water_fraction_pct;

  let expectedWaterFractionPct = null, waterFractionAnomaly = null, expectedWaterFractionNote = undefined, waterRank = null;
  const wBase = polygonGeoJson ? WATER_FRACTION_BASELINES[opts.polygonKey] : null;
  if (polygonGeoJson && !wBase) {
    expectedWaterFractionNote = `Ei perusarvoa polygonille ${opts.polygonKey || "custom"} - vertailu vain ?polygon=iisvesi_raw.`;
  } else if (polygonGeoJson) {
    const baseline = wBase;
    expectedWaterFractionPct = baseline.median;
    if (waterFractionPct != null && opts.useSeason) {
      waterRank = rankAgainstBaseline(baseline, waterFractionPct, now.getUTCFullYear());
      waterFractionAnomaly = waterRank.outside;
    }
    expectedWaterFractionNote = `Kalibroitu perusarvo (mediaani ${baseline.years}, ${baseline.method}, ${baseline.res_m}m): ${baseline.median}% (keskihajonta ${baseline.sd}pp, vaihteluvali ${baseline.range[0]}-${baseline.range[1]}%). Poikkeama = havainto kalibrointivuosien havaitun vaihteluvalin ulkopuolella (ks. water_fraction_rank); 2*sd-rajaa ei kayteta (n=8). ${baseline.note}`;
  } else if (bboxStr === IISVESI_BBOX) {
    expectedWaterFractionPct = IISVESI_BBOX_WATER_FRACTION_PCT;
    expectedWaterFractionNote = "Koko bbox:in pysyva avovesi, MITATTU kayttajan omasta Sentinel-2-maskista 2026-09-17 (37.0%) - EI Iisveden pinta-ala/bbox-ala, koska rajaukseen kuuluu myos Niinivetta, Nokisenkosken alapuolinen allas ja muita jarvia.";
  }

  return {
    time_range: { from, to },
    max_cloud_coverage_pct: 40,
    resolution_m: resolutionM,
    n_intervals_total: result.n_intervals_total,
    n_intervals_used: result.n_intervals_used,
    mndwi_mean: result.median_mean,
    water_fraction_pct: waterFractionPct,
    water_threshold: MNDWI_WATER_THRESHOLD,
    expected_water_fraction_pct: expectedWaterFractionPct,
    water_fraction_anomaly: waterFractionAnomaly,
    water_fraction_rank: waterRank ? waterRank.label : null,
    comparison_window: sw ? sw.season : "months-ikkuna - EI vertailukelpoinen perusarvon (touko-syyskuu) kanssa, anomaly=null",
    grade: "A - vakiintunut (Xu 2006)",
    source: "Sentinel Hub Statistical API (Copernicus Data Space Ecosystem), Sentinel-2 L2A",
    caveat_water_fraction: waterFractionPct == null
      ? "water-kaistan tilastoa ei palautunut - tarkista raaka vastaus"
      : `Kynnys MNDWI>${MNDWI_WATER_THRESHOLD} (Xu 2006 -oletus), EI kalibroitu taman jarven omaa dataa vastaan. Pilvet/nodata/varjot maskattu SCL:sta. Arvo on mediaani ${result.n_intervals_used}/${result.n_intervals_total} P10D-osavalilta (item 1), ei yhden kuvan arvo.`,
    caveat_expected_water_fraction: expectedWaterFractionNote
  };
}

async function handleMNDWI(url, env) {
  const bboxStr = url.searchParams.get("bbox");
  const polygonStr = url.searchParams.get("polygon");
  const months = Math.max(1, Math.min(12, parseInt(url.searchParams.get("months") || "3", 10)));

  let polygonGeoJson = null, polygonSource = null;
  if (polygonStr === "iisvesi_raw") {
    // Jarvi-kohtainen mittari (item 2): rajaamaton jarvipolygoni,
    // kayttajan Sentinel-2-maski 2026-09-17, 157.9 km^2.
    polygonGeoJson = IISVESI_RAW_MASK.features[0].geometry;
    polygonSource = "iisvesi_raw (sisainen, " + IISVESI_RAW_MASK.features[0].properties.area_km2 + " km^2, rekisteri " + IISVESI_RAW_MASK.features[0].properties.register_area_km2 + " km^2)";
  } else if (polygonStr === "iisvesi") {
    polygonGeoJson = IISVESI_MASK.features[0].geometry;
    polygonSource = "iisvesi (sisainen, -40m puskuroitu, " + IISVESI_MASK.features[0].properties.area_km2 + " km^2)";
  } else if (polygonStr) {
    try {
      polygonGeoJson = JSON.parse(polygonStr);
      polygonSource = "custom";
    } catch (e) {
      return json({ error: `polygon ei ole kelvollista GeoJSON:ia (eika avainsana "iisvesi"/"iisvesi_raw"): ${e.message}` }, 400);
    }
  }

  if (!bboxStr && !polygonGeoJson) {
    return json({ error: "bbox- tai polygon-parametri on pakollinen (esim. Iisvesi bbox: 26.695,62.666,27.051,63.004, tai ?polygon=iisvesi_raw)" }, 400);
  }

  try {
    const polygonKey = polygonStr === "iisvesi_raw" || polygonStr === "iisvesi" ? polygonStr : (polygonGeoJson ? "custom" : null);
    const useSeason = !!polygonGeoJson && !url.searchParams.has("months");
    const result = await computeMNDWI(bboxStr, months, env, polygonGeoJson, { polygonKey, useSeason });
    return json({
      bem_e_component: "MNDWI (Aquatic Extension, A-luokka)",
      method: "sentinel_hub_statistical_api",
      bbox: polygonGeoJson ? null : bboxStr,
      used_polygon: !!polygonGeoJson,
      polygon_source: polygonSource,
      ...result,
      caveat: "Live-testattu 2026-09-21 (0.9.4-0.9.5) polygoneilla iisvesi_raw ja iisvesi. Mediaani P10D-osavaleista koko aikaikkunan yli (ei spatiaalinen ruudukko, ei yhden kuvan arvo) - ks. n_intervals_used/n_intervals_total."
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
    return json({ error: "bbox-parametri on pakollinen (esim. Iisvesi: 26.695,62.666,27.051,63.004)" }, 400);
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
//
// BEM-E item 5b (KORJATTU 2026-09-17, kayttajan ohje 7): vesimaskin
// kaventaminen rannoilta EI vaadi Process API:a eika rasterin eroosiota
// Workerissa - aiempi paatelma (ks. git-historia) oli vaarin. Statistical
// API:n input.bounds hyvaksyy bbox:in TILALLA geometry:n (GeoJSON), joten
// jarven rantaviivasta 30-60m sisaanpain puskuroitu polygoni rajaa
// aggregoinnin pois reunan sekapikseleista - sama vaikutus kuin eroosio,
// ilman pikselikasittelya. Katso computeNDCI(...,polygonGeoJson) ja
// handleNDCI:n ?polygon=-parametri. Polygonin GEOMETRIA ITSE EI sisally
// tahan koodiin - se pitaa laskea kertaalleen offline (esim. Turf.js
// bufferilla jarven rantaviiva-aineistosta, esim. OSM tai SYKE:n
// vesistoaluerajat) ja antaa kutsussa. EI VIELA live-testattu (ei
// verkkoyhteytta Copernicus Data Spaceen tasta ymparistosta) - testaa
// oikealla polygonilla ennen tuotantokayttoa.
const NDCI_EVALSCRIPT = `
//VERSION=3
function setup() {
  return {
    // Yksi input-objekti = yksi datalahde. Useampi objekti tulkitaan
    // datafuusioksi (0.9.1: "Dataset with id: 1 not found"). units jatetaan
    // oletukselle: B-kaistat = REFLECTANCE, SCL/dataMask = DN (0.9: SCL ei
    // tue REFLECTANCE-yksikkoa).
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

// KORJATTU 2026-09-21 (item 2, kayttajan riippumaton tarkistus): SCL==6
// kattoi omissa kuvissa vain 35-40% polygonin pikseleista - vesiluokka
// EI ole luotettava koko jarven kattava maski. Kun polygoni ITSE on jo
// jarven rajaus (?polygon=iisvesi/iisvesi_raw), SCL==6-vaatimusta EI
// tarvita - riittaa poistaa pilvet/varjot/nodata (sama luokkajoukko kuin
// MNDWI_EVALSCRIPT:ssa: 0,1,3,8,9,10). Kaytetaan VAIN polygon-kutsuissa;
// bbox-kutsuissa (ei jarven rajausta) SCL==6 on yha tarpeen erottamaan
// vesi maasta - NDCI_EVALSCRIPT (ylla) pysyy silla logiikalla.
const NDCI_EVALSCRIPT_POLYGON = `
//VERSION=3
function setup() {
  return {
    // Yksi input-objekti = yksi datalahde. Useampi objekti tulkitaan
    // datafuusioksi (0.9.1: "Dataset with id: 1 not found"). units jatetaan
    // oletukselle: B-kaistat = REFLECTANCE, SCL/dataMask = DN (0.9: SCL ei
    // tue REFLECTANCE-yksikkoa).
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
  let scl = samples.SCL;
  let cloudFree = (scl == 0 || scl == 1 || scl == 3 || scl == 8 || scl == 9 || scl == 10) ? 0 : 1;
  return {
    data: [ndci],
    dataMask: [samples.dataMask * valid * cloudFree]
  };
}
`;

async function computeNDCI(bboxStr, months, env, polygonGeoJson, opts = {}) {
  if (!env.COPERNICUS_CLIENT_ID || !env.COPERNICUS_CLIENT_SECRET) {
    throw new Error("COPERNICUS_CLIENT_ID / COPERNICUS_CLIENT_SECRET not configured (wrangler secret put ...)");
  }
  const now = new Date();
  const sw = opts.useSeason ? seasonWindow(now) : null;
  const to = sw ? sw.to : now.toISOString();
  const from = sw ? sw.from : new Date(now.getTime() - months * 30 * 24 * 3600 * 1000).toISOString();

  const [minLon, minLat, maxLon, maxLat] = polygonGeoJson
    ? geometryBounds(polygonGeoJson)
    : bboxStr.split(",").map(Number);
  // item 3: kiintea 20m polygon-kutsuille, adaptiivinen bbox-kutsuille.
  const resolutionM = resolveResolutionM(polygonGeoJson, minLon, minLat, maxLon, maxLat);
  const { resx, resy } = computeResxResy(minLat, maxLat, resolutionM);

  const bounds = polygonGeoJson
    ? { geometry: polygonGeoJson, properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" } }
    : { bbox: [minLon, minLat, maxLon, maxLat], properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" } };

  // item 2: polygon-kutsuissa jarven rajaus tulee polygonista itsestaan,
  // SCL==6-vaatimusta EI tarvita (kattoi kayttajan mittauksessa vain
  // 35-40% polygonista) - riittaa pilvimaski. bbox-kutsuissa (ei jarven
  // rajausta) SCL==6 pysyy tarpeellisena veden erottamiseksi maasta.
  const evalscript = polygonGeoJson ? NDCI_EVALSCRIPT_POLYGON : NDCI_EVALSCRIPT;

  // item 1: P10D-osavalien mediaani, ei yhta P{months*30}D-mosaiikkia
  // (joka antoi kauden VIIMEISEN pilvettoman kuvan, ei kesan keskiarvoa -
  // kayttajan riippumaton Earth Search -tarkistus paljasti taman).
  const result = await computeMedianOverIntervals(evalscript, bounds, resx, resy, from, to, env, 40, 10, 0.5,
    polygonGeoJson ? polygonAreaM2(polygonGeoJson) / (resolutionM * resolutionM) : null);

  if (result.n_intervals_used === 0) {
    return {
      error: "no_valid_intervals",
      // 2026-09-22 (kayttajan diagnoosi): bbox-tilassa NDCI vaatii SCL==6:n
      // (vesi) >=50% pikseleista per P10D-vali (item 2 -kommentti ylla).
      // Maavaltaisella bbox:illa (esim. vesiosuus < 50%) tama epaonnistuu
      // AINA, riippumatta saasta/ajankohdasta - ei ohimeneva virhe.
      hint: polygonGeoJson ? undefined :
        "Bbox-tilassa NDCI vaatii SCL==6-vesipikseleita >=50% per P10D-vali. Jos bbox:in vesiosuus on pieni (maavaltainen rajaus - ks. /mndwi:n water_fraction_pct samalle bbox:ille), tama epaonnistuu aina. Kayta ?polygon=iisvesi tai ?polygon=iisvesi_raw jarven omalle rajaukselle.",
      n_intervals_total: result.n_intervals_total,
      time_range: { from, to }, resolution_m: resolutionM
    };
  }

  // Kalibrointi (2026-09-21, ks. IISVESI_NDCI_BASELINE-kommentti):
  // odotusarvo vain polygon-kutsuille - bbox kattaa muutakin kuin Iisveden.
  let expectedNdci = null, ndciAnomaly = null, expectedNdciNote = undefined, ndciRank = null;
  const nBase = polygonGeoJson ? NDCI_BASELINES[opts.polygonKey] : null;
  if (polygonGeoJson && !nBase) {
    expectedNdciNote = `Ei perusarvoa polygonille ${opts.polygonKey || "custom"} - vertailu vain ?polygon=iisvesi tai iisvesi_raw.`;
  } else if (polygonGeoJson) {
    const baseline = nBase;
    expectedNdci = baseline.median;
    if (result.median_mean != null && opts.useSeason) {
      ndciRank = rankAgainstBaseline(baseline, Math.round(result.median_mean * 1e5) / 1e5, now.getUTCFullYear());
      ndciAnomaly = ndciRank.outside;
    }
    expectedNdciNote = `Kalibroitu perusarvo polygonille ${baseline.polygon} (mediaani ${baseline.years}, touko-syyskuu, P10D-mediaani per vuosi): ${baseline.median} (keskihajonta ${baseline.sd}). Poikkeama = havainto kalibrointivuosien havaitun vaihteluvalin ulkopuolella (ks. ndci_rank); 2*sd-rajaa ei kayteta (n=8).`;
  }

  return {
    time_range: { from, to },
    max_cloud_coverage_pct: 40,
    resolution_m: resolutionM,
    n_intervals_total: result.n_intervals_total,
    n_intervals_used: result.n_intervals_used,
    ndci_mean: result.median_mean,
    expected_ndci: expectedNdci,
    ndci_anomaly: ndciAnomaly,
    ndci_rank: ndciRank ? ndciRank.label : null,
    comparison_window: sw ? sw.season : "months-ikkuna - EI vertailukelpoinen perusarvon (touko-syyskuu) kanssa, anomaly=null",
    grade: "B - KOKEELLINEN (Mishra & Mishra 2012, merkitty kokeelliseksi Sentinel-2:lle virallisen dokumentaation mukaan)",
    masking: polygonGeoJson
      ? "Polygon-tila: SCL-pilvimaski (0,1,3,8,9,10), EI SCL==6-vaatimusta - jarven rajaus tulee polygonista (item 2)."
      : "Bbox-tila: vain vesipikselit (SCL==6) - maapikselit maskattu pois.",
    source: "Sentinel Hub Statistical API (Copernicus Data Space Ecosystem), Sentinel-2 L2A",
    caveat_ndci_accuracy: "Kirkkaassa/karussa vedessa punaisen (B04) ja red edge (B05) -kanavien heijastukset ovat matalia (~1-2%), joten ilmakehakorjauksen epatarkkuus voi vaikuttaa tulokseen yhta paljon kuin klorofylli - tulkitse varoen (kayttajan huomio 2026-09-21).",
    caveat_median: `Arvo on mediaani ${result.n_intervals_used}/${result.n_intervals_total} P10D-osavalilta, ei yhden kuvan arvo.`,
    caveat_expected_ndci: expectedNdciNote
  };
}

async function handleNDCI(url, env) {
  const bboxStr = url.searchParams.get("bbox");
  const polygonStr = url.searchParams.get("polygon");
  const months = Math.max(1, Math.min(12, parseInt(url.searchParams.get("months") || "3", 10)));
  if (!bboxStr && !polygonStr) {
    return json({ error: "bbox- tai polygon-parametri on pakollinen (esim. Iisvesi bbox: 26.695,62.666,27.051,63.004)" }, 400);
  }

  let polygonGeoJson = null;
  let polygonSource = null;
  if (polygonStr === "iisvesi") {
    // Valmiiksi laskettu -40m rantapuskuroitu maski (kayttajan Sentinel-2-
    // analyysi 2026-09-17): 137.4 km^2, 8 osaa, 3089 karkea, EPSG:4326.
    polygonGeoJson = IISVESI_MASK.features[0].geometry;
    polygonSource = "iisvesi (sisainen, " + IISVESI_MASK.features[0].properties.area_km2 + " km^2)";
  } else if (polygonStr === "iisvesi_raw") {
    polygonGeoJson = IISVESI_RAW_MASK.features[0].geometry;
    polygonSource = "iisvesi_raw (sisainen, rajaamaton, " + IISVESI_RAW_MASK.features[0].properties.area_km2 + " km^2)";
  } else if (polygonStr) {
    try {
      polygonGeoJson = JSON.parse(polygonStr);
      polygonSource = "custom";
    } catch (e) {
      return json({ error: `polygon ei ole kelvollista GeoJSON:ia (eika avainsana "iisvesi"/"iisvesi_raw"): ${e.message}` }, 400);
    }
  }

  try {
    const polygonKey = polygonStr === "iisvesi_raw" || polygonStr === "iisvesi" ? polygonStr : (polygonGeoJson ? "custom" : null);
    const useSeason = !!polygonGeoJson && !url.searchParams.has("months");
    const result = await computeNDCI(bboxStr, months, env, polygonGeoJson, { polygonKey, useSeason });
    return json({
      bem_e_component: "NDCI (Aquatic Extension, B-luokka - KOKEELLINEN)",
      method: "sentinel_hub_statistical_api",
      bbox: polygonGeoJson ? null : bboxStr,
      used_polygon: !!polygonGeoJson,
      polygon_source: polygonSource,
      shoreline_erosion: polygonGeoJson
        ? "Kaytetty ?polygon= -geometriaa bbox:in sijaan - jos polygoni on puskuroitu rantaviivasta sisaanpain, tama vastaa vesimaskin kaventamista (item 5b) ilman rasterikasittelya."
        : "EI kaytetty - bbox sisaltaa koko rantaviivan, ei eroosiota (ks. item 5b -kommentti computeNDCI:n yla puolella). Kokeile ?polygon=iisvesi.",
      ...result,
      caveat: "Live-testattu 2026-09-21 (0.9.4-0.9.5) polygoneilla iisvesi ja iisvesi_raw. Mediaani P10D-osavaleista - ks. n_intervals_used/n_intervals_total ja masking-kentta (SCL-logiikka riippuu bbox/polygon-tilasta).",
      caveat_polygon_size: polygonGeoJson
        ? "iisvesi-maski: 8 osaa, 3089 karkea (~127kB GeoJSON). Jos Statistics API hylkaa geometrian koon vuoksi (HTTP 400/413), yksinkertaista offline Python/shapely-simplify(tolerance=40, preserve_topology=True):lla ja korvaa src/iisvesi_ndci_mask.json - TATA EI voi tehda Workerissa (ei shapelya/geometriakirjastoa JS-runtimessa)."
        : undefined,
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
    return json({ error: "bbox-parametri on pakollinen (esim. Iisvesi: 26.695,62.666,27.051,63.004)" }, 400);
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
async function runStatsForRange(evalscript, bboxStr, fromISO, toISO, env, maxCloudCoverage = 40, polygonGeoJson) {
  const [minLon, minLat, maxLon, maxLat] = polygonGeoJson
    ? geometryBounds(polygonGeoJson)
    : bboxStr.split(",").map(Number);
  // item 3: kiintea 20m polygon-kutsuille, adaptiivinen bbox-kutsuille -
  // kalibrointi (tama reitti) ja live-arvo (computeMNDWI/computeNDCI)
  // kaytettava AINA samaa resoluutiologiikkaa, muuten mediaanit eivat
  // ole vertailukelpoisia (kayttajan loydos 2026-09-21: 88.8% 52m:lla vs.
  // 93.6% 20m:lla samalle polygonille - resoluutioero, ei jarven muutos).
  const resolutionM = resolveResolutionM(polygonGeoJson, minLon, minLat, maxLon, maxLat);
  const { resx, resy } = computeResxResy(minLat, maxLat, resolutionM);

  const bounds = polygonGeoJson
    ? { geometry: polygonGeoJson, properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" } }
    : { bbox: [minLon, minLat, maxLon, maxLat], properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" } };

  // KORJATTU 2026-09-21 (item 1, kayttajan riippumaton Earth Search-
  // tarkistus): yksi P{spanDays}D-vali (aiemmin tassa) antoi Statistical
  // API:n mosaiikkilogiikalla KESAN VIIMEISEN pilvettoman kuvan, ei kesan
  // keskiarvoa - 2024/2025 "romahdus" oli tama artefakti, ei jarven
  // muutos. computeMedianOverIntervals pilkkoo P10D-osavaleihin ja ottaa
  // mediaanin (ks. myos lastIntervalBehavior/spanDays-korjaus 2026-09-18,
  // joka ratkaisi TYHJAN vastauksen mutta ei tata eri bugia).
  const result = await computeMedianOverIntervals(evalscript, bounds, resx, resy, fromISO, toISO, env, maxCloudCoverage, 10, 0.5,
    polygonGeoJson ? polygonAreaM2(polygonGeoJson) / (resolutionM * resolutionM) : null);

  if (result.n_intervals_used === 0) {
    throw new Error(`0 kaytettavaa P10D-osavalia (n_intervals_total=${result.n_intervals_total}) - tarkista pilvipeite/aikavali.`);
  }

  return {
    stats: { mean: result.median_mean, sampleType: "median_over_intervals" },
    water_fraction_pct: result.median_water_fraction_pct,
    n_intervals_total: result.n_intervals_total,
    n_intervals_used: result.n_intervals_used,
    resolution_m: resolutionM
  };
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
      processingBaseline: f.properties?.["s2:processing_baseline"] ?? null,
      id: f.id
    }));

    // Sen2Cor-versioyhtenaisyys (BEM-E item 5c): SCL-vesiluokan (SCL==6)
    // raja-arvot ovat muuttuneet Sen2Cor-versioiden valilla, joten MNDWI/
    // NDCI-aikasarjaa ei pitaisi verrata suoraan yli baseline-rajan
    // varmistamatta etta samaa luokittelulogiikkaa on kaytetty.
    const baselines = [...new Set(scenes.map(s => s.processingBaseline).filter(b => b != null))];

    return json({
      bem_e_component: "Catalog API -tarkistus (STAC search) - diagnostiikka",
      bbox: bboxStr,
      datetime_range: `${from}/${to}`,
      scene_count: scenes.length,
      context: data.context,
      scenes,
      processing_baselines_present: baselines,
      processing_baseline_consistent: baselines.length <= 1,
      caveat: "Tama tarkistaa ONKO skeneja olemassa - EI kerro suoraan miksi Statistical API palautti data:[], mutta antaa riippumattoman vahvistuksen datan olemassaolosta.",
      caveat_baseline: baselines.length > 1
        ? `USEITA Sen2Cor-processing_baseline-versioita samassa aikavalissa (${baselines.join(', ')}) - SCL-vesiluokka (SCL==6) ei valttamatta vertailukelpoinen naiden skenejen valilla, MNDWI/NDCI-aikasarjan tulkinnassa huomioitava. EI VIELA live-testattu, s2:processing_baseline-kentan nimi ei vahvistettu taman STAC-endpointin oikeaa vastausta vasten.`
        : "Ei havaittu useita baseline-versioita tassa haussa (tai kentta puuttuu vastauksesta - EI VIELA vahvistettu)."
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
  const polygonStr = url.searchParams.get("polygon");

  // item 3 (kayttajan ohje): ?polygon=iisvesi|iisvesi_raw mahdollistaa
  // kalibroinnin - aja 2018-2025 ja katso normaalivuosien vesiosuuden/
  // NDCI:n mediaani polygonille, korvaa kiintean 95%:n odotusarvon.
  let polygonGeoJson = null, polygonSource = null;
  if (polygonStr === "iisvesi_raw") {
    polygonGeoJson = IISVESI_RAW_MASK.features[0].geometry;
    polygonSource = "iisvesi_raw (sisainen, " + IISVESI_RAW_MASK.features[0].properties.area_km2 + " km^2)";
  } else if (polygonStr === "iisvesi") {
    polygonGeoJson = IISVESI_MASK.features[0].geometry;
    polygonSource = "iisvesi (sisainen, -40m puskuroitu, " + IISVESI_MASK.features[0].properties.area_km2 + " km^2)";
  } else if (polygonStr) {
    try {
      polygonGeoJson = JSON.parse(polygonStr);
      polygonSource = "custom";
    } catch (e) {
      return json({ error: `polygon ei ole kelvollista GeoJSON:ia (eika avainsana "iisvesi"/"iisvesi_raw"): ${e.message}` }, 400);
    }
  }

  if (!bboxStr && !polygonGeoJson) {
    return json({ error: "bbox- tai polygon-parametri on pakollinen (esim. Iisvesi bbox: 26.695,62.666,27.051,63.004, tai ?polygon=iisvesi_raw)" }, 400);
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
    // KORJATTU 2026-09-18 (kayttajan loydos): oletusvali oli 05-01T00:00:00Z
    // .. 09-30T23:59:59Z = 152.99 paivaa, ei tasan 153 - spanDays pyoristyi
    // ylospain (Math.round) ja aggregationInterval:n P153D ylitti timeRange:n
    // todellisen pituuden sekunnilla, jolloin Statistical API pudotti
    // vajaan/ylimenevan AINOAN valin ja vastaus oli tyhja kaikilta vuosilta.
    // Puoliavoin vali [1.5. 00:00Z, 1.10. 00:00Z) on TASAN 153 paivaa -
    // ei enaa millisekuntipyoristysta. debugEndDay-ohitus jatetaan ennalleen
    // (diagnostiikkaparametri, kutsuja hallitsee tarkan arvon itse).
    const to = new Date(debugEndDay ? `${year}-${debugEndDay}T23:59:59Z` : `${year}-10-01T00:00:00Z`).toISOString();
    const row = { year, summer_window: { from, to } };

    if (indicesParam.includes("mndwi")) {
      try {
        const r = await runStatsForRange(MNDWI_EVALSCRIPT, bboxStr, from, to, env, debugMaxCloud, polygonGeoJson);
        row.mndwi = r.stats;
        row.mndwi_water_fraction_pct = r.water_fraction_pct;
        row.mndwi_n_intervals_used = r.n_intervals_used;
        row.mndwi_n_intervals_total = r.n_intervals_total;
        row.resolution_m = r.resolution_m;
      } catch (e) {
        row.mndwi = null; row.mndwi_error = e.message;
      }
    }
    if (indicesParam.includes("ndci")) {
      try {
        // item 2: polygon-tilassa pilvimaski riittaa (jarven rajaus tulee
        // polygonista), bbox-tilassa SCL==6 pysyy tarpeellisena.
        const ndciScript = polygonGeoJson ? NDCI_EVALSCRIPT_POLYGON : NDCI_EVALSCRIPT;
        const r = await runStatsForRange(ndciScript, bboxStr, from, to, env, debugMaxCloud, polygonGeoJson);
        row.ndci = r.stats;
        row.ndci_n_intervals_used = r.n_intervals_used;
        row.ndci_n_intervals_total = r.n_intervals_total;
        row.resolution_m = r.resolution_m;
      } catch (e) {
        row.ndci = null; row.ndci_error = e.message;
      }
    }
    results.push(row);
  }

  // Mediaanit talta ajolta - vertailukelpoisia IISVESI_RAW_WATER_FRACTION_
  // BASELINE/IISVESI_NDCI_BASELINE-vakioihin (kalibroitu 2026-09-21 talla
  // samalla reitilla, ks. vakioiden kommentit). Reitti EI kirjoita
  // vakioihin takaisin automaattisesti - jos tulevat vuodet siirtavat
  // mediaania pysyvasti, vakiot paivitetaan kasin.
  const waterFractions = results.map(r => r.mndwi_water_fraction_pct).filter(v => v != null).sort((a, b) => a - b);
  let waterFractionMedian = null;
  if (waterFractions.length) {
    const n = waterFractions.length;
    waterFractionMedian = n % 2 ? waterFractions[(n - 1) / 2] : (waterFractions[n / 2 - 1] + waterFractions[n / 2]) / 2;
  }
  const ndciValues = results.map(r => r.ndci && r.ndci.mean).filter(v => v != null).sort((a, b) => a - b);
  let ndciMedian = null;
  if (ndciValues.length) {
    const n = ndciValues.length;
    ndciMedian = n % 2 ? ndciValues[(n - 1) / 2] : (ndciValues[n / 2 - 1] + ndciValues[n / 2]) / 2;
  }

  return json({
    bem_e_component: "Takautuva kesakauden aikasarja (MNDWI + NDCI)",
    bbox: polygonGeoJson ? null : bboxStr,
    used_polygon: !!polygonGeoJson,
    polygon_source: polygonSource,
    years: `${startYear}-${endYear}`,
    summer_window: "touko-syyskuu (kesken oleva kuluva kesa jatetty automaattisesti pois)",
    rows: results,
    mndwi_water_fraction_pct_median: waterFractionMedian,
    ndci_median: ndciMedian,
    caveat_calibration: waterFractionMedian == null ? undefined :
      `Perusarvo (IISVESI_RAW_WATER_FRACTION_BASELINE): mediaani ${IISVESI_RAW_WATER_FRACTION_BASELINE.median}% (${IISVESI_RAW_WATER_FRACTION_BASELINE.years}). Taman ajon mediaani: ${waterFractionMedian}% (${waterFractions.length} vuodelta). ${IISVESI_RAW_WATER_FRACTION_BASELINE.note}`,
    caveat: "Live-testattu P10D-mediaanimekanismilla 2026-09-21 (kalibrointiajo: 8/8 vuotta, 9-14 kayttokelpoista valia/vuosi, ks. IISVESI_RAW_WATER_FRACTION_BASELINE/IISVESI_NDCI_BASELINE). Yksi Statistical API -kutsu per vuosi per indeksi (API pilkkoo P10D-osavaleihin yhden kutsun sisalla, ei lisaa Worker-puolen kutsumaaraa) - kuluttaa Process Unit -kiintiota vastaavasti (esim. 8 vuotta x 2 indeksia = 16 kutsua). Tarkista aina n_intervals_used/n_intervals_total per rivi - jos kaytettyja valeja on vahan, mediaani perustuu harvaan dataan."
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
  // KORJATTU 2026-09 (kayttajan ohje, item 1 - "korjaa heti, BEM:n
  // ydinmittari"): width/height (150x240) oli kiinnitetty, joten
  // DEFAULT_BBOX:lla (~76x122 km) pikselikoko oli ~500 m. Keskiarvo pysyy
  // likimain samana tallaisella karkealla otannalla, MUTTA stDev EI -
  // 500 m -pikseli tasoittaa maisemavaihtelun, joten kaikki stDev-arvot
  // ENNEN tata korjausta (versio <0.6) EIVAT ole vertailukelpoisia uusien
  // kanssa. 20 m kiinteana kaikille rajauksille olisi ~23 milj. pikselia
  // DEFAULT_BBOX:lle - liikaa (Sentinel Hubin Process Unit -kiintio).
  // adaptiveResolutionM skaalaa: ~193 m DEFAULT_BBOX:lle, 52 m Iisvesi-
  // bboxille, 20 m pienille ruuduille (max MAX_PIXELS per kutsu).
  const resolutionM = adaptiveResolutionM(minLon, minLat, maxLon, maxLat);
  const { resx, resy } = computeResxResy(minLat, maxLat, resolutionM);

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
      aggregationInterval: { of: `P${months * 30}D`, lastIntervalBehavior: "SHORTEN" },
      evalscript: NDVI_EVALSCRIPT,
      resx, resy
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
    return { error: "unexpected_response_shape", raw_response: data, time_range: { from, to }, resolution_m: resolutionM };
  }

  const noDataFraction = stats.sampleCount > 0
    ? stats.noDataCount / stats.sampleCount
    : null;

  return {
    time_range: { from, to },
    max_cloud_coverage_pct: 40,
    resolution_m: resolutionM,
    ndvi_stats: stats,
    // noDataFraction sisältää veden JA pilvet JA virheelliset arvot yhdessä -
    // ei puhdas vesiosuus, karkea ylaraja-arvio vertailua varten.
    no_data_fraction_upper_bound: noDataFraction != null ? +noDataFraction.toFixed(3) : null,
    source: "Sentinel Hub Statistical API (Copernicus Data Space Ecosystem), Sentinel-2 L2A",
    caveat_resolution: "KORJATTU 2026-09 (v0.6+): resx/resy adaptiivisella resoluutiolla korvasi kiinnitetyn 150x240-pikselikoon (DEFAULT_BBOX:lla tama oli ~500m/pikseli). ndvi_stats.mean on likimain vertailukelpoinen vanhojen (<0.6) tallenteiden kanssa, MUTTA ndvi_stats.stdDev EI OLE - karkea pikseli tasoitti maisemavaihtelun keinotekoisesti pienemmaksi."
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
      } else if (path === "/version") {
        return handleVersion();
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
