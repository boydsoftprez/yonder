# EGM96 geoid for live traffic altitude

`egm96-5.pgm` is the global EGM96 five-arcminute geoid grid distributed by GeographicLib, derived from the US NGA EGM96 model. It is used locally; the browser never requests the grid. This is a vertical datum correction, not synthetic terrain geometry.

- Downloaded 2026-09-07 from https://downloads.sourceforge.net/project/geographiclib/geoids-distrib/egm96-5.tar.bz2
- PGM size: 18,671,448 bytes; SHA-256: `c4b25a03ec5845cec4778a54b580aeda676363f2205a89137e8677b2337af3ec`.
- Grid format and model provenance: https://geographiclib.sourceforge.io/C++/doc/geoid.html
- NGA model: https://earth-info.nga.mil/index.php?dir=wgs84&action=wgs84#tab_egm96
- NGA EGM96 data are public domain; the PROJ distribution records this licence: https://github.com/OSGeo/PROJ-data/blob/master/us_nga/us_nga_README.txt
- No GeographicLib program source was copied; `geoid_grid.py` is an original bilinear reader of the documented format.

The PGM header declares a 4320 × 2161 grid with north-west origin 90°N, 0°E, west-to-east longitude samples wrapping at 360°, and north-to-south latitude samples including both poles. Big-endian unsigned 16-bit values convert to geoid undulation using `N = -108 + pixel × 0.003` metres. The documented maximum bilinear interpolation error relative to EGM96 is 0.140 m (RMS 0.005 m); this does not describe the accuracy of aircraft GNSS observations or terrain products.

readsb `alt_geom` is WGS84 ellipsoid height in feet. Conversion is `altitudeMslM = alt_geom × 0.3048 - N`. Barometric altitude remains a separate field and is never used as an MSL fallback. Without geometric altitude or a valid grid, traffic is still available on the moving map but has no valid altitude for PFD placement.

Independent check on 2026-09-07: GeographicLib's online GeoidEval returned EGM96 undulation -31.7291 m at 35.9607874°, -83.3668696°. This local bilinear implementation returns -31.72435 m, a 0.00475 m difference.

https://geographiclib.sourceforge.io/cgi-bin/GeoidEval?input=35.9607874+-83.3668696&option=Submit
