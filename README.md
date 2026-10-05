# Rain Radar Denmark

An [Omarchy](https://omarchy.org) bar widget that answers one question: **will it
rain here, and when?**

Click the widget for a map of Denmark with the last hour of DMI's radar,
running on into a forecast of the next 90 minutes. Pick a place, and the panel
says what is falling there and what is coming ("Light rain now · dry within
~1 h"), with the chance of rain over the next 30 minutes, 1 hour and 1½ hours.

Data: [DMI](https://www.dmi.dk/) (Danish Meteorological Institute) open data,
no API key needed.

## How it works

The forecast is a radar nowcast: the rain on the latest scans is moved along
the way it has been moving over the last 30 minutes. The chance of rain comes
from 40 slightly shifted copies of that forecast. The method was chosen by a
separate research project that benchmarked nowcast methods on six months of
DMI radar:

- **[How does it work?](https://diegogardini.github.io/denmark-rain-nowcast/)**
  The short version.
- **[The full research report](https://diegogardini.github.io/denmark-rain-nowcast/report.html)**
  Methods, evidence and limits.
- **[The research code and data](https://github.com/diegogardini/denmark-rain-nowcast)**
  The benchmarks behind every choice.

This repository holds the widget only; the research, its findings and its
evidence live in the research project.

## How good is it?

Measured on 176 days of DMI radar (April to September 2026):

- **The next hour, at a town:** it caught 66% of the rainy hours, and 23% of
  the hours it called rainy stayed drier. Assuming nothing moves catches 50%.
- **The second hour is harder:** 45% caught.
- **The chances are honest:** within a few points of what happened, and about
  as good as a professional ensemble forecast (pysteps STEPS).

It moves rain that is already on the radar: it cannot foresee showers that
form, grow or die out, so it is weaker past the first hour and on showery
summer afternoons. Not yet checked in winter (snow, sleet).

## What you see

- **The map:** observed radar (marked RADAR), then the nowcast (marked
  NOWCAST, with a finely dashed Denmark outline). Rain drawn hatched in grey
  came in from beyond the map's edge and is a guess.
- **The place:** set it with **Use location** (Omarchy's weather location,
  or your connection's rough location once you turn it on), one of the four
  largest towns, the **search** (about 9,200 Danish places), or a click on the
  map.
- **The graph** (over Sweden): rain at the place in mm/h, the past hour solid
  and the nowcast dashed, with an amber strip for the chance that it is
  raining at each moment. Click it to jump the map to that time.
- **The forecast card:** the forecast in words and the chances. When it
  is dry: "Rain within" 30 min · 1 h · 1½ h. When it rains: "Dry for good by"
  30 min · 1 h · 1½ h. The words never claim more than the chances: "Dry now ·
  showers nearby" rather than "no rain" when a shower could still reach you.
- **The bar:** the rain at your place now (or the peak over Denmark without
  one); hover for the forecast in words, middle-click to refresh.

Everything counts from the clock, not from the radar scan, which DMI
publishes 12–13 minutes late.

## Install

Needs [GDAL](https://gdal.org) 3.11 or newer to read DMI's radar files:

```bash
sudo pacman -S gdal
omarchy plugin add https://github.com/diegogardini/omarchy-rain-radar-denmark-widget.git --enable
```

Update and remove:

```bash
omarchy plugin update io.github.diegogardini.omarchy-rain-radar-denmark-widget
omarchy plugin remove io.github.diegogardini.omarchy-rain-radar-denmark-widget
```

The version shows at the bottom of the panel; what changed is in
[CHANGELOG.md](CHANGELOG.md).

## Settings

- **Radar refresh interval:** 5–30 min, default 10.
- **Autoplay animation on open:** default on.

## License and data

Code: [MIT](LICENSE). Radar data: DMI, under its
[open data terms](https://www.dmi.dk/friedata/). Country outlines: Natural
Earth (public domain). Danish places (`Towns.js`): © OpenStreetMap
contributors, [ODbL](https://opendatacommons.org/licenses/odbl/). See
[MAP-SOURCES.md](MAP-SOURCES.md).

## Development

```bash
omarchy plugin validate .
node --test tests/*.test.cjs
QT_QPA_PLATFORM=offscreen QT_QUICK_BACKEND=software /usr/lib/qt6/bin/qmltestrunner -input tests
bash tests/check-panel.sh   # a Quickshell preview with stubbed downloads
```

`tools/` rebuilds the map outlines and the town list from their sources.
Before changing the motion, the history, the scans or the chance of rain,
read the [research report](https://diegogardini.github.io/denmark-rain-nowcast/report.html):
each of those settings is chosen there with its evidence.

Releases: raise the version in `manifest.json`, add the changelog entry, push
to `main` and tag `vX.Y.Z`; `omarchy plugin update` pulls `main`, so every
push there reaches users.
