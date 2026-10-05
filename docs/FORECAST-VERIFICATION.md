# Rain Radar Denmark: forecast verification report

Date of study: 2026-09-20 (one day of data). Tools: `tools/forecast-verify.cjs`
and `tools/forecast-verify-loop.sh` (removed in October 2026, with HARMONIE;
they are in the git history).

> **HARMONIE removed, 2026-10-03.** The findings below on HARMONIE (far too
> much rain, no spatial skill, an API that mostly refused requests) led to
> its removal from the widget (backlog W16). This document is kept as the
> record of why.

> **Correction, 2026-09-25.** Every study in this document mixed DMI's two
> scan types: full-range composites at :00, :10, ... and short-range doppler
> composites at :05, :15, ..., which have no data over much of the map. That
> missing area was read as dry, so every other scan lost the rain far from the
> radars. The rain totals that swung between 0.5x and 2x from one scan to the
> next (section 11.2) and the one-night comparisons of nowcast models are
> affected. The widget now uses full-range scans only. The corrected 176-day
> evaluation is in Denmark-rain-nowcast
> ([report](https://diegogardini.github.io/denmark-rain-nowcast/report.html)); see section 12.

## 1. Bottom line

| Question | Finding | Confidence |
|---|---|---|
| Does our nowcast beat "nothing moves" (persistence)? | **Yes out to about 60 min**, clearly. About equal at 90 min. No better at 120 min. | Moderate: one weather day |
| Does HARMONIE match our nowcast? | **No.** It forecast 5–20× too much rain with no spatial correlation in the four steps that could be scored. | Low: four steps from two fetches |
| Is HARMONIE usable for the graph outlook? | **Not on this evidence.** Recommend against building it. | Moderate |
| Is DMI's HARMONIE service reachable? | **No.** Both the map endpoint (`cube`) and the location endpoint (`position`) returned 429 "Server is busy" most of the day. | High |

## 2. Question and scope

The question was whether HARMONIE agrees with the forecast from the plugin's
own cloud-moving model. Agreement between two forecasts says nothing about
which one is right, so both were scored against what the radar measured, with
persistence added as a baseline. A forecast is only worth using if it beats
persistence.

## 3. Methodology

**3.1 Ground truth.** DMI's radar composite, downloaded every 5 minutes from the
radar API and converted with the plugin's own pipeline (ODIM HDF5 → dBZ → mm/h
via Marshall–Palmer, warped to the map grid). The radar is the only
observation available at area scale, but it is itself an estimate (see 7).

**3.2 Forecasts tested.**
- **Our nowcast:** motion measured between the two newest scans, then rain
  carried forward in 5-minute steps. Recorded at +30, +60, +90 and +120 min,
  using the unfaded field (no visual fade), roughly every 30 min.
- **HARMONIE:** DMI's `cube` endpoint, three hourly steps per successful
  fetch. At most one attempt every 30 min, stopping at the first refusal, and
  a full set at most every 3 h. "Lead" is measured from when it was fetched,
  not from the model run, so the true lead is a few hours longer.
- **Persistence (baseline):** the newest scan at issue time, held unchanged.

**3.3 Common grid.** All fields were averaged onto HARMONIE's 40×30 grid
(about 11×14 km cells) over 8–15.3°E, 54.3–58°N. The plugin's HARMONIE binning
averages cells rather than taking a maximum (checked in `ForecastModel.js`), so
it does not inflate values.

**3.4 Scores.** For every forecast and its valid-time scan:
- **Rain ratio:** total forecast rain divided by total observed rain
  (1.0 = unbiased).
- **Correlation:** how well the forecast places the rain spatially.
- **CSI** (hits ÷ hits + misses + false alarms) at 0.1 and 0.5 mm/h. CSI
  rewards forecasting rain everywhere, so it is read alongside correlation
  and the rain ratio.
- **Wet cases:** at least 20% of the area at ≥0.1 mm/h at valid time. Results
  are also split into wet and drier cases.

**3.5 Uncertainty.** Confidence intervals come from a block bootstrap (2,000
resamples) over issue times, comparing the nowcast with persistence. They are
too narrow: issues 30 min apart share the same weather, so the effective number
of independent samples is a handful of weather episodes, not 23–26.

**3.6 Checking the tools.**
- Forecasts of known error were planted into the tool (a perfect one, one with
  3× the rain, an all-dry one); they scored 1.00 correlation and a pooled
  1.33×, as expected.
- 27 stored nowcasts were recomputed independently from separate copies of
  the scans: total rain matched exactly (ratio 1.000).
- Persistence and truth agreed between the tool and a separate whole-map
  check.

## 4. Data collected

- **Radar:** 197 scans, 04:45–21:05 local. The machine slept overnight, so
  nothing earlier.
- **Forecasts:** 112 recorded (108 nowcast, 4 HARMONIE); 102 scored.
- **Weather:** one day; valid times 07:55–21:05 local. Heaviest reading
  16.6 mm/h in a coarse cell. 44 scored cases were wet, mostly 10:00–16:00
  local.
- **HARMONIE:** only two fetches got through (07:41 and 13:13 local), out of
  roughly 30 attempts. That gave four steps, three of them from one fetch.

## 5. Results

### 5.1 Nowcast against persistence, all cases

CI is the 95% interval for the nowcast-minus-persistence difference.

| Lead | n | Rain ratio (now / pers) | Corr (now / pers) | CSI@0.1 (now / pers) | ΔCSI [CI] |
|---|---|---|---|---|---|
| +30 min | 26 | 0.95 / 1.01 | 0.45 / 0.20 | 0.42 / 0.31 | +0.11 [0.09, 0.13] |
| +60 min | 25 | 0.91 / 1.01 | 0.21 / 0.12 | 0.29 / 0.24 | +0.05 [0.03, 0.07] |
| +90 min | 24 | 0.81 / 0.98 | 0.09 / 0.09 | 0.22 / 0.21 | 0.00 [−0.03, 0.03] |
| +120 min | 23 | 0.71 / 0.97 | 0.06 / 0.07 | 0.18 / 0.21 | −0.03 [−0.06, 0.01] |

### 5.2 Wet cases only (rain over ≥20% of the area, n = 10–11 per lead)

| Lead | CSI@0.1 (now / pers) | ΔCSI [CI] | Corr (now / pers) |
|---|---|---|---|
| +30 min | 0.46 / 0.35 | +0.11 [0.09, 0.12] | 0.45 / 0.23 |
| +60 min | 0.34 / 0.27 | +0.07 [0.04, 0.09] | 0.25 / 0.09 |
| +90 min | 0.26 / 0.24 | +0.03 [−0.01, 0.06] | 0.12 / 0.04 |
| +120 min | 0.22 / 0.22 | 0.00 [−0.05, 0.05] | 0.09 / 0.03 |

In wet weather the nowcast keeps a small correlation advantage even at
+90 min. In drier cases (n = 13–15) persistence was the better forecast at
+90 and +120 min (ΔCSI −0.03 and −0.06, intervals excluding zero).

### 5.3 HARMONIE, all four scored steps

| Valid (UTC) | Lead from fetch | Area wet: truth / HARMONIE | Rain ratio | Corr | CSI@0.1 (HARM / pers) |
|---|---|---|---|---|---|
| 06:00 | 19 min | 7% / 24% | 6.4× | −0.03 | 0.05 / 0.17 |
| 12:00 | 47 min | 39% / 88% | 5.4× | −0.05 | 0.36 / 0.30 |
| 13:00 | 107 min | 36% / 96% | 10.1× | −0.03 | 0.35 / 0.25 |
| 14:00 | 167 min | 28% / 98% | 19.9× | −0.03 | 0.27 / 0.23 |

HARMONIE's CSI looks acceptable only because it marks nearly the whole area as
raining, so it cannot miss. Its correlation (about zero at every step) says it
is not placing the rain. The over-forecast grows with lead time. This matches
the single cached step examined the night before (about 39× too much rain,
correlation 0.08, on a dry night).

### 5.4 The earlier pixel backtest

12 rainy windows from cached scans (the figures quoted in the README): CSI
0.28 / 0.19 / 0.09 at +30 / +60 / +120 min against persistence's
0.16 / 0.07 / 0.06. Those are pixel-level (~3 km cells), so not comparable
with the coarse-cell scores above, but the pattern is the same: an edge that
shrinks with lead time.

## 6. Nowcast changes made before this study

Three defects were found while building the point graph and fixed:
- **Blurring:** re-sampling the previous step 24 times shrank a small shower
  to 40% of its peak by +2 h. Fix: trace each cell back along the motion field
  and sample the observed scan once.
- **Speed:** displacement was scaled by match confidence, so a cleanly tracked
  shower moved at 60% of its true speed. Fix: a saturating weight
  (`motionWeight` in `Interpolation.js`).
- **Stalling:** rain stopped moving about 50 km beyond where motion had been
  measured. Fix: extend the motion field over dry areas
  (`fillMotionField`).

The 12-window backtest supported the first two. The day's data is
out-of-sample for them (the constants were set on physical grounds, not fitted
to it), and the nowcast holds up against persistence on it.

## 7. Threats to validity

- **One day, one weather regime** (a shower and rain-band day). Nothing here
  speaks to fronts, thunderstorms or dry spells.
- **Small effective sample** (a handful of weather episodes); the intervals are
  optimistic.
- **Area scores, not point scores.** Scoring used 11–14 km cells, but the
  graph shows a single ~3 km cell at the pin. Point-level skill will be lower
  than these numbers, especially past 60 min. The graph's point series was not
  verified directly.
- **Radar is not perfect truth:** one Marshall–Palmer relation, no rain-gauge
  calibration, and a noise floor, so 0.1 mm/h CSI is sensitive to it. Part of
  HARMONIE's wet area could be drizzle below radar sensitivity, but its median
  forecast cell (0.69 mm/h) is well above what the radar would miss.
- **HARMONIE sample is tiny** (four steps, two fetches), and its lead is
  measured from the fetch, not the model run.
- **Units unresolved.** The plugin treats HARMONIE's `rain-precipitation-rate`
  as mm/h although DMI labels it kg/m²/s. The observed ratios (5–39×, rising
  with lead) are not a clean unit factor, so units alone probably do not
  explain the gap, but this could not be settled.
- **Persistence's rain ratio** varies with case mix (above 1 in decaying rain,
  below 1 in growing rain), so pooled rain ratios are noisy.

## 8. Retractions and corrections

- **"The nowcast loses rain at long leads"** (stated in two interim
  check-ins): **withdrawn.** The pooled total is dominated by a few morning
  cases where the rain was growing, which any method that only moves existing
  rain undershoots (persistence too: 199 against 369 in the heaviest case). An
  independent whole-map check on a different case mix put the nowcast at 1.12×
  the truth inside the box. The rain-total sign depends on whether rain is
  growing or decaying; this data does not establish a bias.
- **README backtest figures** come from the earlier 12-window pixel test. They
  are honest about lead-time decay, but should be supplemented with the in-day
  findings (useful to about 60 min, roughly no better than persistence at
  2 h).

## 9. Implications

1. **The graph's horizon is oversold.** It shows a full 2 h. The nowcast beats
   persistence to about 60 min, is level at 90 and adds nothing at 120.
   Consider de-emphasizing the line beyond about 60–90 min and rewording the
   graph footnote.
2. **HARMONIE outlook on the graph:** do not build it. It would draw a
   confident line at roughly 5–20× the rain that fell.
3. **HARMONIE map toggle:** keep it off by default (it is). A README caveat
   that its rain intensities look unreliable would be warranted.
4. **Follow-ups for more certainty:** verify the graph's point series
   directly; repeat over several days including a frontal day; settle
   HARMONIE's units (needs DMI to stop refusing requests).

## 10. State and reproduction

- Collected data lives in
  `~/.local/state/omarchy/cache/rain-radar-denmark-verify/` (scans, forecasts,
  `results.jsonl`, `loop.log`) and can be deleted at any time.
- `node tools/forecast-verify.cjs report` reprints the aggregate table;
  `bash tools/forecast-verify-loop.sh [HH:MM]` reruns the collection loop
  (every 30 min; note that it contacts DMI, including the throttled HARMONIE
  endpoint).
- The bootstrap intervals, wet/dry split and whole-map rain-total check in this
  report came from one-off analysis scripts (not kept in the repo) run over
  `results.jsonl` and the plugin's cached scans.

## 11. Second study: night of 2026-09-23/24

Same tools, fresh data directory
(`~/.local/state/omarchy/cache/rain-radar-denmark-verify-0923/`). One pass
every 30 min from 23:31 to 05:37 local, then scored. 45 forecasts scored (29
wet cases, ≥20% of the area raining). Widespread light-to-moderate rain that
was slowly decaying; heaviest cell 7.1 mm/h.

### 11.1 Results

| Lead | n | Rain ratio (now / pers) | Corr (now / pers) | CSI@0.1 (now / pers) | CSI@0.5 (now) |
|---|---|---|---|---|---|
| +30 min | 12 | 0.89 / 1.10 | 0.70 / 0.62 | 0.49 / 0.57 | 0.41 |
| +60 min | 11 | 0.79 / 1.21 | 0.56 / 0.33 | 0.36 / 0.45 | 0.29 |
| +90 min | 10 | 0.72 / 1.32 | 0.45 / 0.19 | 0.28 / 0.38 | 0.24 |
| +120 min | 9 | 0.65 / 1.40 | 0.32 / 0.12 | 0.24 / 0.31 | 0.17 |

HARMONIE: DMI answered 429 on nearly every attempt again. One fetch got
through, giving three scored steps (+0 h, +1 h, +2 h): 11.4×, 15.9× and 20.0×
the observed rain, correlation −0.09 to 0.01. Same picture as §5.3, and still
a tiny sample.

Compared with §5: **placement holds** (the nowcast's correlation beats
persistence at every lead), but **detection does not** (persistence has the
higher CSI@0.1 at every lead, where on 2026-09-20 the nowcast led out to about
60 min). The rain was light and patchy, and CSI@0.1 rewards persistence's habit
of keeping the whole wet area. One weather episode, so this may not generalise.

### 11.2 The rain ratio: a motion-field artifact, not a dry bias

The table's rain ratio (0.89 falling to 0.65) looks like the nowcast losing
rain with lead time. That reading is **withdrawn** (see §8, the same trap):
- Against persistence, the truth fell to 0.71 of the issue-time total by
  +120 min (real decay). The nowcast fell to 0.46, so it lost about a third more
  than the truth did, in those 9 cases.
- But the same algorithm run over a wider set of real scans (17:00 UTC on the
  23rd to 04:00 UTC on the 24th, 60 issue times, cached full-resolution
  grids) gives the **opposite sign**: forecast total 1.64× the truth at +60 min
  and 2.14× at +120 min (persistence: 1.11× and 1.24×). The 9 verified cases
  were the later, weaker, decaying part of the event.
- The total is unstable from one issue time to the next. For issues 5 min apart
  between 21:00 and 23:00 UTC the +60 min forecast total ran from 0.50× to
  2.14× the issue-time total, while the truth stayed between 0.77× and 1.11×.
  No steady bias explains that.
- A synthetic test (rain blobs translating at a uniform speed) retains rain
  exactly (retention 1.000 out to +120 min), so the advection step itself does
  not leak.
- The scratch hindcast reproduced the recorded verification totals for the same
  issue times to within rounding (e.g. 0.74 recorded vs 0.75).

**Likely cause (consistent with the evidence, not directly proven):** the
motion field is piecewise constant per 8×8-cell block with whole-cell steps and
varies from block to block. Tracing each output cell backwards through that
field makes neighbouring cells sample the same source rain (rain is duplicated)
or skip it (rain is dropped) wherever adjacent blocks disagree, and errors add
up over 12–24 steps. The jump in total also appears when only the block lookup
rounding is changed (floor vs round moved single cells by up to ~12 mm/h).

### 11.3 Ablation (scratch code, not in the repo)

Run over the same 55–60 issue times with the motion field replaced (all other
code identical; the "current" row matches the library to 4·10⁻⁵):

| Variant | +60 fc/truth | sd of log ratio | corr (8×8 coarse) | +120 fc/truth | sd | corr |
|---|---|---|---|---|---|---|
| current (per-block) | 1.64 | 0.28 | 0.508 | 2.14 | 0.37 | 0.341 |
| bilinear-smoothed field | 1.86 | 0.32 | 0.479 | 2.50 | 0.42 | 0.332 |
| one global vector | 1.13 | 0.14 | 0.582 | 1.28 | 0.18 | 0.364 |
| persistence | 1.11 | 0.12 | 0.404 | 1.24 | 0.16 | 0.166 |

A single confidence-weighted vector for the whole map cuts the scatter of the
total in half (0.28 → 0.14 at +60 min), brings the total in line with
persistence, and places rain better at +60 min (0.582 vs 0.508). By +120 min the
placement gain is small (0.364 vs 0.341). Smoothing the block field made it
**worse**, so mere smoothness is not the fix.

**Prototype:** the global vector is now available as an opt-in argument,
`Interpolation.extrapolateSequence(..., minConfidence, true)` (default off, so
the plugin and the verify tool behave as before). Run through the library on the
same 60 / 55 issue times it reproduces the table (+60 min: 1.64 → 1.13, scatter
0.28 → 0.14; +120 min: 2.14 → 1.28, 0.37 → 0.18). All 9 test files pass with the
flag off (default) and with it forced on. The new unit tests cover the vector and
rain conservation, but the synthetic scenes do not reproduce the per-block
artifact (the per-block field also conserves rain on them), so only the real-scan
hindcast shows the improvement.

**Caveats:** one event, issue times 10 min apart are strongly correlated, and the
sample is dominated by the heavier evening cases. A global vector cannot follow
shear or rotation (e.g. a front with a different flow to the showers ahead of
it), which this event may not have tested. Nothing has been changed in the
plugin code.

### 11.3a Side-by-side collection

`tools/forecast-verify.cjs` now issues two nowcasts from the same two scans at
every pass: `nowcast` (per-block field, as before) and `nowcast-global` (one
shared vector). `report` prints each model's own table plus a **paired** table
over the issue times and leads where both were scored. Runs made before this
change hold only `nowcast` rows, so use a fresh `RAIN_VERIFY_DIR` (or accept
that older rows have no pair and are left out of the paired table). A
three-issue offline smoke test, on cached scans with the network stubbed,
produced and scored all 24 forecasts; its numbers are far too few to mean
anything.

### 11.4 Implications

1. Do not read the rain ratios in §11.1 as a bias to correct. A scale factor
   would help on this night and hurt on the earlier ones.
2. The next thing to try is a coarser motion field: one global vector, or a
   few large regions with a blend between them, judged on total, scatter and
   correlation over several days including a frontal one. This is cheap because
   the motion estimate is already available.
3. The graph's point series (the plugin's headline number) may swing by ±2× in
   intensity between refreshes for this reason. That is a reason to prioritise
   it, not to correct for it.

## 12. Correction: two scan types (2026-09-25)

DMI's composite collection alternates `scanType` "fullRange" (minutes divisible
by 10) and "doppler" (the minutes in between). In the raw files the doppler
composite has nodata (255) over 79% of the raster against 46% for the
full-range one, and `helpers/dmi-radar-to-png` converts nodata to 0 mm/h. All
data in this document, and every motion estimate from a scan pair, therefore
had every other frame losing rain at long range.

Consequences for this document:

- The rain-ratio scatter in section 11.2 is at least partly this coverage
  change, not only the per-block motion field.
- The per-block against global-vector comparison in section 11 is on mixed
  scans. On full-range scans 10 minutes apart, over 176 days, the two are
  about level (Denmark-rain-nowcast, report section 5.3).
- Motion from scans only 5 minutes apart is too coarse for whole-cell block
  matching even without the coverage problem (Denmark-rain-nowcast,
  report Appendix A.2).

The widget now converts and animates full-range scans only
(`RadarModel.fullRangeOnly`), one every 10 minutes, and estimates motion from
the last four of them.

## 13. The whole-map vector from the blocks' own matches (2026-09-27)

Denmark-rain-nowcast found that the whole-map vector was averaged from the
smoothed and filled per-block field (`globalMotion` on the output of
`computeBlockMotion` and `fillMotionField`). Both steps give blocks the
average of their neighbours; where neighbours move differently that average
is shorter than their own vectors, so the whole-map mean ran at 0.86 of the
speed of the tracked rain features. Averaged from every block's own match
(`rawBlockMotion`, `rawGlobalMotion`) it runs at 0.91 and places rain better
at every lead time up to 2 hours (+0.007 FSS at +60 min, 157 event blocks).
The method itself is unbiased: on a scan moved by a known amount it measures
1.01 of that amount. Speeding the vector up by 5-15% gains 0.002 or less.

`globalMotionFromFrames` now uses the blocks' own matches. The research repo's parity
test checks that it reproduces the report's 30-minute whole-map vector on
real scans (`tests/test_js_parity.py`, fixture from
`scripts/make_parity_fixture.cjs`).

Tested and not adopted: refining matches to a fraction of a cell (+0.000 for
the whole-map vector), and switching to per-block motion averaged over an hour
(+0.007 over the map, but more excess rain and no gain at the cities). See
the Denmark-rain-nowcast report, sections 5.3 and 5.6 and Appendix B.4.
