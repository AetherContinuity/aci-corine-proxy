# aci-corine-proxy

D_f (fragmentaatio) -datalähde BEM:lle (Biodiversity Endurance Monitor).

Hakee SYKE:n avoimesta `inspire_lc` WMS -rajapinnasta (CorineLandCover2018),
ei autentikointia. Ruudukkopisteotanta bbox:n yli, laskee metsäosuuden ja
keskimääräisen metsälaikun koon.

**Huom:** tämä on point-sample-proxy, ei todellinen laikkukoko/reunatiheys-
fragmentaatioanalyysi (joka vaatisi täyden raster/vektori-topologia-käsittelyn).

## Reitit
- `/status` — proxyn tila
- `/fragmentation?bbox=26.00,62.40,27.50,63.50&grid=7` — D_f-proxy

## Lähde
https://ckan.ymparisto.fi/dataset/syke-maanpeite-wcs

## Liittyy
- BEM Monitor: https://aethercontinuity.org/tools/BEM-monitor.html
- TN-015: https://aethercontinuity.org/supplements/tn-015-biodiversity-endurance-monitor.html
