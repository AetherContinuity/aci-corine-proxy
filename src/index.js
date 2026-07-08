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
    version: "0.1",
    purpose: "D_f (fragmentation) data source for BEM — Biodiversity Endurance Monitor",
    pilot: "Rautalammin reitti",
    default_bbox: DEFAULT_BBOX,
    routes: {
      "/status": "Proxy status",
      "/fragmentation": "Grid-sampled D_f proxy · ?bbox=...&grid=7 (n x n points, max 10x10)"
    },
    source: {
      service: "SYKE inspire_lc WMS (GeoServer)",
      dataset: "CorineLandCover2018 (LC.LandCoverSurfaces.2018)",
      auth_required: false,
      reference: "https://ckan.ymparisto.fi/dataset/syke-maanpeite-wcs"
    },
    caveat: "Point-sample proxy, not true patch/edge-density fragmentation analysis",
    reference_doc: "https://aethercontinuity.org/supplements/tn-015-biodiversity-endurance-monitor.html"
  });
}

export default {
  async fetch(request) {
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
      } else {
        return json({ error: `Unknown route: ${path}` }, 404);
      }
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }
};
