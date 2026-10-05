# Changelog

Versions follow [Semantic Versioning](https://semver.org): MAJOR.MINOR.PATCH,
set in `manifest.json` (the one place it is written; the panel's footer and
the IPC `status` read it from there). Each release is tagged `vMAJOR.MINOR.PATCH`.

- **MAJOR**: a change that breaks what a user set up: a setting renamed or
  removed, the saved place's format, the IPC calls.
- **MINOR**: a new feature or a visible change to what the widget shows.
- **PATCH**: a fix that changes nothing else.

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
