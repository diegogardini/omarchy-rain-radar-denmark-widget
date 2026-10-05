#!/usr/bin/env python3
"""Converts an ESRI ASCII grid (AAIGrid, as produced by `gdal_translate -of
AAIGrid`) into the same {cols, rows, bounds, values} JSON shape
ForecastModel.js's parseCubeToGrid() produces, so Interpolation.js can treat
observed-radar grids and HARMONIE forecast grids identically.

AAIGrid stores rows top-to-bottom (north first), which already matches the
row-0-is-north convention used throughout this plugin (see MapModel.js's
project()) -- no row-flip needed.
"""
import json
import sys


def main():
    path, west, south, east, north = sys.argv[1:6]
    with open(path) as f:
        header = {}
        while True:
            pos = f.tell()
            line = f.readline()
            key, _, value = line.strip().partition(" ")
            key = key.lower()
            if key in ("ncols", "nrows", "xllcorner", "yllcorner", "cellsize", "nodata_value"):
                header[key] = value.strip()
            else:
                f.seek(pos)
                break
        values = []
        for line in f:
            values.extend(float(v) for v in line.split())

    cols = int(header["ncols"])
    rows = int(header["nrows"])
    nodata = float(header.get("nodata_value", -9999))
    # 0.001 mm/h is far finer than radar + Z-R can resolve, and keeps the
    # (now much larger) sidecar files ~3x smaller to write and re-parse.
    values = [0.0 if v == nodata else round(max(0.0, v), 3) for v in values]

    out = {
        "cols": cols,
        "rows": rows,
        "bounds": {"west": float(west), "south": float(south), "east": float(east), "north": float(north)},
        "values": values,
    }
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
