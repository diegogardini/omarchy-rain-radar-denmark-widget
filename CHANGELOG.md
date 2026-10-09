# Changelog

Versions follow [Semantic Versioning](https://semver.org): MAJOR.MINOR.PATCH,
set in `manifest.json` (the one place it is written; the panel's footer and
the IPC `status` read it from there). Each release is tagged `vMAJOR.MINOR.PATCH`.

- **MAJOR**: a change that breaks what a user set up: a setting renamed or
  removed, the saved place's format, the IPC calls.
- **MINOR**: a new feature or a visible change to what the widget shows.
- **PATCH**: a fix that changes nothing else.

## 1.2.1 — 2026-10-09

- The PROJECTED hour glides as smoothly as the PAST one: each nowcast frame
  is painted once, when the frames arrive, instead of on every step (about
  100 ms of painting that stalled the glide for two of its stages).

## 1.2.0 — 2026-10-07

- The map's badge says **PAST** for the radar hour and **PROJECTED** for the
  nowcast (it said RADAR and NOWCAST), and every frame shows its time.
- The shown time steps to the nearest 10 minutes (the badge and the graph's
  reading), while the rain glides on as smoothly as before.
- The animation runs about 10% slower: 387 ms a 10-minute step (was 350).

## 1.1.3 — 2026-10-06

- "Use location" asks wttr.in where the connection is with the same care as
  the radar downloads: HTTPS only, curl stops at 1 MB (the answer is about
  40 kB), and a longer answer is not parsed (marketplace review).

## 1.1.2 — 2026-10-06

From the marketplace review of 1.1.1:

- The converter reads each B-tree and symbol node of a radar file at most
  once, within a budget of entries sized to what a radar file holds (1024 per
  group; for the data, four times the grid's number of chunks), and each chunk
  position once. A small crafted file can no longer make it parse entries over
  and over.
- A conversion stops after 30 s, and the widget runs it under `timeout 60`, so
  a bad file can never stall the radar queue.

Also:

- With little rain on the map, a pair of radar scans can give no measurable
  motion, and those radar frames jumped instead of gliding. They now glide
  along the nowcast's 30-minute motion.

## 1.1.1 — 2026-10-06

Safer handling of what comes from the network (marketplace review):

- Scan names from DMI's list must match DMI's own file names
  (`dk.com.YYYYMMDDHHMM.500_max.h5`) before they name any file; anything else
  is dropped. Scans are downloaded from DMI's address for that name, over
  HTTPS only, whatever link the list gives.
- Downloads are capped (2 MB for the list, 20 MB for a scan; a scan is about
  200 kB), and the converter refuses files over 20 MB, grids over 8192 x 8192,
  chunks that inflate past their size, pointers that leave the file, and
  looping or over-deep trees. It writes only into its own folder.

## 1.1.0 — 2026-10-06

- **No more GDAL.** DMI's radar files are now read by a small script that
  needs only Python's standard library, so the widget works on a standard
  Omarchy install with nothing else to install. Checked against GDAL on real
  scans: the same rain, cell for cell (correlation 0.9995 or better, the total
  within 0.25%), and about twice as fast once its placement cache is built.
- Old converted scans are removed after 6 hours; the cache no longer grows by
  about 60 MB a day. The first refresh after updating clears what has piled up.
- IPC `status` reports `converterStatus`; `gdalStatus` stays as an alias until 2.0.

## 1.0.1 — 2026-10-05

- The plugin's descriptions say what it answers: the chance of rain at your
  place, from a research-backed nowcast.
- A preview image (`preview.png`) for the Omarchy plugin marketplace.

## 1.0.0 — 2026-10-05

The first public release.

- DMI's observed radar over Denmark, the last hour from full-range scans
  10 minutes apart, with fixed radar echoes (Copenhagen, among others)
  filled from their surroundings.
- A radar nowcast to 90 minutes from now: one whole-map motion vector from
  every block's own match, averaged over the last 30 minutes, traced back
  from the latest scan. Rain from beyond the map's edge is hatched as a guess.
- Smooth animation: the nowcast glides along its motion; each radar scan
  glides along its own, then the next real scan replaces it.
- Rain at one place: a graph over Sweden (the rain at the pin, the chance of
  rain as a strip from "now" on), the forecast in words, and the chances of
  "Rain within" / "Dry for good by" 30 min, 1 h and 1½ h, from 40 shifted
  copies of the nowcast. The words never claim more than the chances.
- Places: "Use location" (Omarchy's weather location, or the connection's
  location via wttr.in once turned on), the four largest towns, a search
  over about 9,200 Danish places (OpenStreetMap), or a click on the map,
  which is named after the place clicked on, or "near" the nearest town.
- Everything at the place counts from the clock, not from the radar scan.

The method and its evidence: https://diegogardini.github.io/denmark-rain-nowcast/
