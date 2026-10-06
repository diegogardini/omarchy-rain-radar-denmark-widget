#!/usr/bin/env python3
"""Converts one DMI radar composite (ODIM HDF5) into what the widget draws and
computes with, using nothing but Python's standard library:

  <out>.png                  the rain rate, coloured with rain-colorramp.txt,
                             640 x 458 pixels over the map (MapModel.bounds),
                             evenly spaced in longitude and latitude, as the
                             map draws it (cosine-scaled equirectangular)
  <out>.nowcast-grid.json    {cols, rows, bounds, values}: 224 x 160 cells of
                             about 3.2 km over the same box, each the mean rain
                             rate over the radar pixels it covers (dry ones as
                             0), for the nowcast, the graph and the chances

usage: dmi-radar-convert.py <input.h5> <output-basename>

DMI's composites are small HDF5 files of one layout (format version 0): one
1728 x 1984 grid of bytes in deflate-compressed chunks, and a few attributes
(how to turn a byte into dBZ, the Z-R pair, the projection and its corners).
This reads just that, so the widget needs no GDAL. A file of another layout
stops with a message, rather than being read wrongly.

Bytes become rain rate as DMI records it: dBZ = byte * gain + offset (the
"nodata" byte is outside radar range, the "undetect" byte dry), then
Marshall-Palmer, rate = (10^(dBZ/10) / a)^(1/b). Rates below 0.05 mm/h count
as dry: the dBZ noise over the huge composite would otherwise tint the whole
map. Outside radar range counts as dry too; that is only safe because the
widget converts the full-range scans alone, whose uncovered area is the same
far corners in every scan.

The radar grid is in an oblique stereographic projection on WGS84
(+proj=stere, as PROJ computes it). Each radar pixel's centre is placed on the
map by the inverse projection, exact at every 16th pixel and interpolated in
between (off by far less than a metre), then binned:

  - a grid cell takes the mean over all its radar pixels, dry ones as 0 and
    pixels outside radar range left out (cells with none read 0), as the
    nowcast research measured everything;
  - a map pixel (about 1.5 km) takes the mean over its wet radar pixels, so a
    small shower keeps its strength on the map.
"""
import array
import hashlib
import json
import math
import os
import re
import struct
import sys
import zlib

# Map domain, kept in sync with MapModel.js's `bounds` (tests/maprange.test.cjs).
WEST, SOUTH, EAST, NORTH = 5.0, 53.9, 16.5, 58.5
PNG_W, PNG_H = 640, 458
GRID_COLS, GRID_ROWS = 224, 160
RATE_FLOOR = 0.05
LATTICE = 16
GEOMETRY_VERSION = 1

# Limits, far above DMI's files (about 200 kB, 1728 x 1984 bytes, 128 chunks),
# so a damaged or hostile file is refused instead of using memory or time.
MAX_FILE_BYTES = 20_000_000
MAX_GRID_SIDE = 8192
MAX_GRID_BYTES = 32_000_000
MAX_MESSAGES = 1024
MAX_TREE_DEPTH = 16
MAX_ENTRIES = 65536
MAX_ATTR_VALUES = 4096
SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


class Unsupported(Exception):
    pass


# ---- A reader for DMI's HDF5 layout (superblock 0, v1 object headers) ----

class H5:
    def __init__(self, data):
        self.d = data
        if data[:8] != b"\x89HDF\r\n\x1a\n":
            raise Unsupported("not an HDF5 file")
        if data[8] != 0:
            raise Unsupported("HDF5 superblock version %d (expected 0)" % data[8])
        if data[13] != 8 or data[14] != 8:
            raise Unsupported("HDF5 offsets/lengths are not 8 bytes")
        # root group's symbol table entry: name offset, object header address
        self.root = self.u64(56 + 8)

    def check(self, o, n=1):
        if o < 0 or o + n > len(self.d):
            raise Unsupported("a pointer leaves the file")
        return o

    def u8(self, o):
        return self.d[self.check(o)]

    def u16(self, o):
        return struct.unpack_from("<H", self.d, self.check(o, 2))[0]

    def u32(self, o):
        return struct.unpack_from("<I", self.d, self.check(o, 4))[0]

    def u64(self, o):
        return struct.unpack_from("<Q", self.d, self.check(o, 8))[0]

    def bytes_at(self, o, n):
        return self.d[self.check(o, n):o + n]

    def messages(self, addr):
        """(type, offset, size) of every message in a version 1 object header."""
        if self.u8(addr) != 1:
            raise Unsupported("object header version %d (expected 1)" % self.u8(addr))
        count = min(self.u16(addr + 2), MAX_MESSAGES)
        blocks = [(addr + 16, self.u32(addr + 8))]
        seen = set()
        out = []
        while blocks and len(out) < count:
            start, size = blocks.pop(0)
            if start in seen:
                raise Unsupported("an object header loops")
            seen.add(start)
            self.check(start, size)
            o = start
            while o + 8 <= start + size and len(out) < count:
                mtype, msize = self.u16(o), self.u16(o + 2)
                body = o + 8
                self.check(body, msize)
                if mtype == 0x10:  # continuation
                    blocks.append((self.u64(body), self.u64(body + 8)))
                out.append((mtype, body, msize))
                o = body + msize
        return out

    def children(self, addr):
        """{name: object header address} of a group (symbol table, v1 B-tree)."""
        for mtype, o, _ in self.messages(addr):
            if mtype == 0x11:
                btree, heap = self.u64(o), self.u64(o + 8)
                break
        else:
            return {}
        if self.bytes_at(heap, 4) != b"HEAP":
            raise Unsupported("group without a local heap")
        heap_data = self.u64(heap + 24)
        out = {}
        seen = set()

        def node(a, depth=0):
            if depth > MAX_TREE_DEPTH or a in seen or len(seen) > MAX_ENTRIES:
                raise Unsupported("a group B-tree loops or is too deep")
            seen.add(a)
            if self.bytes_at(a, 4) != b"TREE":
                raise Unsupported("bad group B-tree")
            level, used = self.u8(a + 5), self.u16(a + 6)
            o = a + 24 + 8  # past the header and the first key
            for _ in range(used):
                child = self.u64(o)
                o += 16
                if level > 0:
                    node(child, depth + 1)
                else:
                    if self.bytes_at(child, 4) != b"SNOD":
                        raise Unsupported("bad symbol node")
                    for k in range(self.u16(child + 6)):
                        e = child + 8 + 40 * k
                        name_off, header = self.u64(e), self.u64(e + 8)
                        n = self.check(heap_data + name_off)
                        end = self.d.find(b"\0", n, n + 256)
                        if end < 0:
                            raise Unsupported("a name without an end")
                        out[self.d[n:end].decode("ascii", "replace")] = header
        node(btree)
        return out

    def path(self, p):
        addr = self.root
        for part in [x for x in p.split("/") if x]:
            kids = self.children(addr)
            if part not in kids:
                raise Unsupported("no %s in the file" % p)
            addr = kids[part]
        return addr

    @staticmethod
    def pad8(n):
        return (n + 7) & ~7

    def decode(self, o, dtype_o, count):
        cls_ver = self.u8(dtype_o)
        cls, bits0 = cls_ver & 0x0F, self.u8(dtype_o + 1)
        size = self.u32(dtype_o + 4)
        if count > MAX_ATTR_VALUES or size > 65536:
            raise Unsupported("an attribute is too large")
        self.check(o, size * count)
        if cls == 3:  # string
            return self.d[o:o + size].split(b"\0")[0].decode("ascii", "replace")
        if cls == 0:  # fixed-point
            fmt = {1: "b", 2: "h", 4: "i", 8: "q"}[size]
            if not bits0 & 0x08:
                fmt = fmt.upper()
        elif cls == 1:  # floating-point
            fmt = {4: "f", 8: "d"}[size]
        else:
            return None
        vals = struct.unpack_from("<" + fmt * count, self.d, o)
        return vals[0] if count == 1 else list(vals)

    def attrs(self, addr):
        """{name: value} of an object's scalar attributes (attribute message v1)."""
        out = {}
        for mtype, o, _ in self.messages(addr):
            if mtype != 0x0C or self.u8(o) != 1:
                continue
            name_len, dt_len, ds_len = self.u16(o + 2), self.u16(o + 4), self.u16(o + 6)
            name_o = o + 8
            dt_o = name_o + self.pad8(name_len)
            ds_o = dt_o + self.pad8(dt_len)
            data_o = ds_o + self.pad8(ds_len)
            rank = self.u8(ds_o + 1)
            count = 1
            for k in range(rank):
                count *= self.u64(ds_o + 8 + 8 * k)
            name = self.d[name_o:name_o + name_len].split(b"\0")[0].decode()
            out[name] = self.decode(data_o, dt_o, count)
        return out

    def dataset_u8(self, addr):
        """(rows, cols, bytes) of a 2-D, 1-byte, chunked and deflated dataset."""
        layout = shape = None
        filters = []
        for mtype, o, _ in self.messages(addr):
            if mtype == 0x01:  # dataspace
                ver, rank = self.u8(o), self.u8(o + 1)
                base = o + (8 if ver == 1 else 4)
                shape = [self.u64(base + 8 * k) for k in range(rank)]
            elif mtype == 0x03:  # datatype
                if self.u8(o) & 0x0F != 0 or self.u32(o + 4) != 1:
                    raise Unsupported("the radar data are not single bytes")
            elif mtype == 0x08:
                layout = o
            elif mtype == 0x0B:  # filter pipeline
                ver, n = self.u8(o), self.u8(o + 1)
                p = o + (8 if ver == 1 else 2)
                for _ in range(n):
                    fid = self.u16(p)
                    if ver == 1 or fid >= 256:
                        name_len = self.u16(p + 2)
                    else:
                        name_len = 0
                    nvals = self.u16(p + 6)
                    filters.append(fid)
                    p += 8 + (self.pad8(name_len) if ver == 1 else name_len) + 4 * nvals
                    if ver == 1 and nvals % 2:
                        p += 4
        if shape is None or len(shape) != 2 or layout is None:
            raise Unsupported("the radar dataset is not a 2-D grid")
        if not (0 < shape[0] <= MAX_GRID_SIDE and 0 < shape[1] <= MAX_GRID_SIDE and shape[0] * shape[1] <= MAX_GRID_BYTES):
            raise Unsupported("the radar grid is %d x %d" % tuple(shape))
        if self.u8(layout) != 3 or self.u8(layout + 1) != 2:
            raise Unsupported("the radar dataset is not stored in chunks")
        if any(f != 1 for f in filters):
            raise Unsupported("the radar dataset uses filters other than deflate")
        dims = self.u8(layout + 2)
        if dims != 3:
            raise Unsupported("the radar chunks have %d dimensions" % dims)
        btree = self.u64(layout + 3)
        chunk = [self.u32(layout + 11 + 4 * k) for k in range(dims)]
        rows, cols = shape
        crow, ccol = chunk[0], chunk[1]
        if not (0 < crow <= rows and 0 < ccol <= cols) or chunk[2] != 1:
            raise Unsupported("bad chunk size")
        out = bytearray(rows * cols)
        seen = set()

        def node(a, depth=0):
            if depth > MAX_TREE_DEPTH or a in seen or len(seen) > MAX_ENTRIES:
                raise Unsupported("a chunk B-tree loops or is too deep")
            seen.add(a)
            if self.bytes_at(a, 4) != b"TREE" or self.u8(a + 4) != 1:
                raise Unsupported("bad chunk B-tree")
            level, used = self.u8(a + 5), self.u16(a + 6)
            key = 8 + 8 * dims
            o = a + 24
            for _ in range(used):
                size, mask = self.u32(o), self.u32(o + 4)
                r0, c0 = self.u64(o + 8), self.u64(o + 16)
                child = self.u64(o + key)
                if level > 0:
                    node(child, depth + 1)
                else:
                    if r0 >= rows or c0 >= cols or r0 % crow or c0 % ccol:
                        raise Unsupported("a chunk lies outside the grid")
                    raw = self.bytes_at(child, size)
                    want = crow * ccol
                    if (mask & 1) or not filters:
                        block = raw
                    else:
                        # never inflate past the chunk's own size
                        z = zlib.decompressobj()
                        block = z.decompress(raw, want)
                        if z.unconsumed_tail:
                            raise Unsupported("a chunk inflates past its size")
                    if len(block) != want:
                        raise Unsupported("a chunk has the wrong size")
                    h, w = min(crow, rows - r0), min(ccol, cols - c0)
                    for r in range(h):
                        out[(r0 + r) * cols + c0:(r0 + r) * cols + c0 + w] = block[r * ccol:r * ccol + w]
                o += key + 8
        node(btree)
        return rows, cols, bytes(out)


# ---- Projection: PROJ's ellipsoidal oblique stereographic (+proj=stere) ----

class Stere:
    def __init__(self, projdef):
        p = dict(re.findall(r"\+(\w+)=([^\s]+)", projdef))
        if p.get("proj") != "stere":
            raise Unsupported("projection %s (expected stere)" % p.get("proj"))
        if p.get("ellps", "WGS84") != "WGS84":
            raise Unsupported("ellipsoid %s (expected WGS84)" % p.get("ellps"))
        self.a = 6378137.0
        f = 1 / 298.257223563
        self.e = math.sqrt(f * (2 - f))
        self.lon0 = float(p.get("lon_0", 0))
        phi0 = math.radians(float(p.get("lat_0", 90)))
        if abs(abs(phi0) - math.pi / 2) < 1e-9:
            raise Unsupported("polar stereographic")
        k0 = float(p.get("k", p.get("k_0", 1)))
        t = math.sin(phi0)
        X = 2 * math.atan(self.ssfn(phi0, t)) - math.pi / 2
        self.akm1 = 2 * k0 * math.cos(phi0) / math.sqrt(1 - (self.e * t) ** 2)
        self.sinX1, self.cosX1 = math.sin(X), math.cos(X)

    def ssfn(self, phit, sinphi):
        sinphi *= self.e
        return math.tan(.5 * (math.pi / 2 + phit)) * ((1 - sinphi) / (1 + sinphi)) ** (.5 * self.e)

    def forward(self, lon, lat):
        lam, phi = math.radians(lon - self.lon0), math.radians(lat)
        X = 2 * math.atan(self.ssfn(phi, math.sin(phi))) - math.pi / 2
        sX, cX, cl = math.sin(X), math.cos(X), math.cos(lam)
        A = self.akm1 / (self.cosX1 * (1 + self.sinX1 * sX + self.cosX1 * cX * cl))
        return self.a * A * cX * math.sin(lam), self.a * A * (self.cosX1 * sX - self.sinX1 * cX * cl)

    def inverse(self, x, y):
        x, y = x / self.a, y / self.a
        rho = math.hypot(x, y)
        tp = 2 * math.atan2(rho * self.cosX1, self.akm1)
        cosphi, sinphi = math.cos(tp), math.sin(tp)
        if rho == 0:
            phi_l = math.asin(cosphi * self.sinX1)
        else:
            phi_l = math.asin(cosphi * self.sinX1 + y * sinphi * self.cosX1 / rho)
        tp = math.tan(.5 * (math.pi / 2 + phi_l))
        x *= sinphi
        y = rho * self.cosX1 * cosphi - y * self.sinX1 * sinphi
        phi = phi_l
        for _ in range(15):
            s = self.e * math.sin(phi_l)
            phi = 2 * math.atan(tp * ((1 + s) / (1 - s)) ** (.5 * self.e)) - math.pi / 2
            if abs(phi_l - phi) < 1e-11:
                break
            phi_l = phi
        lam = 0.0 if x == 0 and y == 0 else math.atan2(x, y)
        return math.degrees(lam) + self.lon0, math.degrees(phi)


NO_CELL = 0xFFFF


def geometry(proj, rows, cols, x0, y0, px, py, cache_dir, key):
    """Where each radar pixel falls on the map: its grid cell and map pixel,
    and how many radar pixels each cell holds. The same for every scan of one
    radar grid, so it is computed once and kept next to the frames."""
    tag = hashlib.sha1(repr((key, WEST, SOUTH, EAST, NORTH, PNG_W, PNG_H, GRID_COLS, GRID_ROWS,
                             LATTICE, GEOMETRY_VERSION)).encode()).hexdigest()[:16]
    path = os.path.join(cache_dir, "geometry-%s.bin" % tag)
    try:
        with open(path, "rb") as f:
            head = struct.unpack("<5I", f.read(20))
            rmin, rmax, cmin, cmax, n = head
            cell_of = array.array("H")
            cell_of.fromfile(f, n)
            pix_of = array.array("I")
            pix_of.fromfile(f, n)
            cell_all = array.array("I")
            cell_all.fromfile(f, GRID_COLS * GRID_ROWS)
        return rmin, rmax, cmin, cmax, cell_of, pix_of, cell_all
    except (OSError, EOFError, struct.error):
        pass

    # the radar rows and columns that can reach the map, from its outline
    edge = []
    for k in range(101):
        t = k / 100
        for lon, lat in ((WEST + (EAST - WEST) * t, SOUTH), (WEST + (EAST - WEST) * t, NORTH),
                         (WEST, SOUTH + (NORTH - SOUTH) * t), (EAST, SOUTH + (NORTH - SOUTH) * t)):
            x, y = proj.forward(lon, lat)
            edge.append(((y0 - y) / py, (x - x0) / px))
    rmin = max(0, int(min(e[0] for e in edge)) - 2)
    rmax = min(rows - 1, int(max(e[0] for e in edge)) + 2)
    cmin = max(0, int(min(e[1] for e in edge)) - 2)
    cmax = min(cols - 1, int(max(e[1] for e in edge)) + 2)
    width = cmax - cmin + 1

    # pixel centres: exact on a lattice of every LATTICE-th pixel, linear in between
    lat_rows = sorted(set(list(range(rmin, rmax + 1, LATTICE)) + [rmax]))
    lat_cols = sorted(set(list(range(cmin, cmax + 1, LATTICE)) + [cmax]))
    lattice = [[proj.inverse(x0 + (c + .5) * px, y0 - (r + .5) * py) for c in lat_cols] for r in lat_rows]

    gx, gy = GRID_COLS / (EAST - WEST), GRID_ROWS / (NORTH - SOUTH)
    mx, my = PNG_W / (EAST - WEST), PNG_H / (NORTH - SOUTH)
    cell_of = array.array("H", [NO_CELL]) * (width * (rmax - rmin + 1))
    pix_of = array.array("I", [0]) * (width * (rmax - rmin + 1))
    cell_all = array.array("I", [0]) * (GRID_COLS * GRID_ROWS)
    i = 0
    for r in range(rmin, rmax + 1):
        j = 0
        while j + 1 < len(lat_rows) and lat_rows[j + 1] < r:
            j += 1
        if j + 1 >= len(lat_rows):
            j = len(lat_rows) - 2
        fr = (r - lat_rows[j]) / (lat_rows[j + 1] - lat_rows[j])
        top, bottom = lattice[j], lattice[j + 1]
        along = [(a[0] + (b[0] - a[0]) * fr, a[1] + (b[1] - a[1]) * fr) for a, b in zip(top, bottom)]
        for s in range(len(lat_cols) - 1):
            c0, c1 = lat_cols[s], lat_cols[s + 1]
            (lon0, lat0), (lon1, lat1) = along[s], along[s + 1]
            dlon, dlat = (lon1 - lon0) / (c1 - c0), (lat1 - lat0) / (c1 - c0)
            last = c1 + 1 if s == len(lat_cols) - 2 else c1
            for c in range(c0, last):
                lon, lat = lon0 + dlon * (c - c0), lat0 + dlat * (c - c0)
                if WEST <= lon < EAST and SOUTH < lat <= NORTH:
                    cell = int((NORTH - lat) * gy) * GRID_COLS + int((lon - WEST) * gx)
                    cell_of[i + c - cmin] = cell
                    pix_of[i + c - cmin] = int((NORTH - lat) * my) * PNG_W + int((lon - WEST) * mx)
                    cell_all[cell] += 1
        i += width

    tmp = "%s.%d.tmp" % (path, os.getpid())
    try:
        with open(tmp, "wb") as f:
            f.write(struct.pack("<5I", rmin, rmax, cmin, cmax, len(cell_of)))
            cell_of.tofile(f)
            pix_of.tofile(f)
            cell_all.tofile(f)
        os.replace(tmp, path)
    except OSError:
        pass
    return rmin, rmax, cmin, cmax, cell_of, pix_of, cell_all


# ---- Conversion ----

def read_ramp(path):
    stops = []
    for line in open(path):
        parts = line.split()
        if len(parts) == 5 and not line.startswith("#") and parts[0] != "nv":
            stops.append((float(parts[0]),) + tuple(int(v) for v in parts[1:]))
    return stops


def colour(rate, stops):
    if rate <= stops[0][0]:
        return stops[0][1:]
    for lo, hi in zip(stops, stops[1:]):
        if rate <= hi[0]:
            t = (rate - lo[0]) / (hi[0] - lo[0])
            return tuple(int(round(a + (b - a) * t)) for a, b in zip(lo[1:], hi[1:]))
    return stops[-1][1:]


def write_png(path, width, height, rgba):
    def chunk(tag, body):
        return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)
    rows = b"".join(b"\0" + bytes(rgba[y * width * 4:(y + 1) * width * 4]) for y in range(height))
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(rows, 6)) + chunk(b"IEND", b""))
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(png)
    os.replace(tmp, path)


def convert(in_path, out_base, ramp_path):
    # the output stays in its own folder: a plain file name, no path in it
    if not SAFE_NAME.match(os.path.basename(out_base)) or not os.path.isdir(os.path.dirname(os.path.abspath(out_base))):
        raise Unsupported("unsafe output name %r" % out_base)
    if os.path.getsize(in_path) > MAX_FILE_BYTES:
        raise Unsupported("the file is larger than %d bytes" % MAX_FILE_BYTES)
    with open(in_path, "rb") as f:
        h5 = H5(f.read(MAX_FILE_BYTES + 1))
    what = h5.attrs(h5.path("/what"))
    how = h5.attrs(h5.path("/how"))
    where = h5.attrs(h5.path("/where"))
    data_what = {}
    for p in ("/dataset1/what", "/dataset1/data1/what"):
        try:
            data_what.update(h5.attrs(h5.path(p)))
        except Unsupported:
            pass
    meta = dict(what, **data_what)
    rows, cols, raw = h5.dataset_u8(h5.path("/dataset1/data1/data"))

    gain, offset = float(meta.get("gain", 0.5)), float(meta.get("offset", -32))
    nodata, undetect = int(meta.get("nodata", 255)), int(meta.get("undetect", 0))
    zr_a, zr_b = float(how.get("zr-a", 200)), float(how.get("zr-b", 1.6))

    # byte -> rain rate, and a class per byte: 0 dry, 1 wet, 2 outside radar range
    rate = [0.0] * 256
    cls = bytearray(256)
    for b in range(256):
        if b == nodata:
            cls[b] = 2
            continue
        if b == undetect:
            continue
        r = ((10 ** ((b * gain + offset) / 10)) / zr_a) ** (1 / zr_b)
        if r >= RATE_FLOOR:
            rate[b], cls[b] = r, 1
    classes = raw.translate(bytes(cls))

    proj = Stere(where["projdef"])
    x0, y0 = proj.forward(float(where["UL_lon"]), float(where["UL_lat"]))
    px = (proj.forward(float(where["UR_lon"]), float(where["UR_lat"]))[0] - x0) / cols
    py = (y0 - proj.forward(float(where["LL_lon"]), float(where["LL_lat"]))[1]) / rows

    geo = geometry(proj, rows, cols, x0, y0, px, py, os.path.dirname(os.path.abspath(out_base)),
                   (where["projdef"], x0, y0, px, py, rows, cols))
    rmin, rmax, cmin, cmax, cell_of, pix_of, cell_all = geo
    width = cmax - cmin + 1

    cell_sum = [0.0] * (GRID_COLS * GRID_ROWS)
    cell_out = [0] * (GRID_COLS * GRID_ROWS)
    map_sum = [0.0] * (PNG_W * PNG_H)
    map_n = [0] * (PNG_W * PNG_H)

    # only wet pixels and those outside radar range need more than their
    # cell's (cached) pixel count
    run = re.compile(rb"\x01+|\x02+")
    for r in range(rmin, rmax + 1):
        base = r * cols + cmin
        row = classes[base:base + width]
        gbase = (r - rmin) * width
        for m in run.finditer(row):
            wet = row[m.start()] == 1
            for k in range(m.start(), m.end()):
                cell = cell_of[gbase + k]
                if cell == NO_CELL:
                    continue
                if wet:
                    v = rate[raw[base + k]]
                    cell_sum[cell] += v
                    pix = pix_of[gbase + k]
                    map_sum[pix] += v
                    map_n[pix] += 1
                else:
                    cell_out[cell] += 1

    values = []
    for k in range(GRID_COLS * GRID_ROWS):
        n = cell_all[k] - cell_out[k]
        values.append(round(cell_sum[k] / n, 3) if n > 0 else 0.0)
    grid = {"cols": GRID_COLS, "rows": GRID_ROWS,
            "bounds": {"west": WEST, "south": SOUTH, "east": EAST, "north": NORTH}, "values": values}
    tmp = out_base + ".nowcast-grid.json.tmp"
    with open(tmp, "w") as f:
        json.dump(grid, f)
    os.replace(tmp, out_base + ".nowcast-grid.json")

    stops = read_ramp(ramp_path)
    rgba = bytearray(PNG_W * PNG_H * 4)
    for k in range(PNG_W * PNG_H):
        if map_n[k]:
            rgba[4 * k:4 * k + 4] = bytes(colour(map_sum[k] / map_n[k], stops))
    write_png(out_base + ".png", PNG_W, PNG_H, rgba)


def main():
    if len(sys.argv) != 3:
        sys.stderr.write("usage: dmi-radar-convert.py <input.h5> <output-basename>\n")
        return 1
    ramp = os.path.join(os.path.dirname(os.path.abspath(__file__)), "rain-colorramp.txt")
    try:
        convert(sys.argv[1], sys.argv[2], ramp)
    except Unsupported as e:
        sys.stderr.write("dmi-radar-convert: unsupported radar file: %s\n" % e)
        return 2
    except (struct.error, IndexError, KeyError, ValueError, TypeError, ZeroDivisionError, zlib.error, MemoryError) as e:
        sys.stderr.write("dmi-radar-convert: unreadable radar file: %s\n" % e)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
