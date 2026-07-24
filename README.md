# aci-corine-proxy

D_f (fragmentaatio) -datalähteet BEM:lle (Biodiversity Endurance Monitor).
Kaksi riippumatonta reittiä, eri lähteistä.

## Reitit

- `/status` — proxyn tila
- `/fragmentation?bbox=...&grid=7` — CORINE-ruudukkopisteotanta (SYKE, ei autentikointia)
- `/ndvi?bbox=...&months=3` — NDVI-tilastot Sentinel-2:sta (Sentinel Hub Statistical API, vaatii Copernicus-secretit)
- `/ndvi-image?bbox=...&months=3&w=480&h=350` — renderoitu NDVI-kuva PNG:na (Sentinel Hub Process API, vihrea-keltainen-punainen -varitys, SAMAT Copernicus-secretit kuin /ndvi:lla). HUOM: Process API kuluttaa Copernicus-tilin Process Unit -kiintiota ERI TAHDISSA kuin Statistical API - 6h Cache-Control asetettu, mutta EI omaa palvelinpuolen valimuistia (KV) tassa versiossa.

**Huom:** `/fragmentation` on point-sample-proxy CORINE-datasta, ei todellinen
laikkukoko/reunatiheys-analyysi (CORINE:n 25 ha minimikartoitusyksikkö
yleistää lähekkäiset metsäalueet, ks. commit-historia).
`/ndvi` palauttaa keskiarvo/hajonta-tilastot koko bbox:lle, ei ruudukkoa.

## Secretit (tarvitaan /ndvi:lle)

```
wrangler secret put COPERNICUS_CLIENT_ID
wrangler secret put COPERNICUS_CLIENT_SECRET
```

Client Credentials -tyyppinen OAuth-asiakas luodaan Sentinel Hub -dashboardissa
(shapps.dataspace.copernicus.eu/dashboard → User settings → OAuth clients).

## Lähteet

- CORINE: https://ckan.ymparisto.fi/dataset/syke-maanpeite-wcs
- NDVI: https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Statistical/Examples.html
- NDVI-kuva: https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Process.html

## Liittyy

- BEM Monitor: https://aethercontinuity.org/tools/BEM-monitor.html
- TN-015: https://aethercontinuity.org/supplements/tn-015-biodiversity-endurance-monitor.html
