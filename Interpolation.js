// Motion estimation and the radar nowcast, on rain-rate grids of identical
// shape ({cols, rows, bounds, values}): block matching between scans, one
// whole-map motion vector from it, and the forecast that moves the latest
// scan along that vector (extrapolateSequence).
//
// Pure JS, no QML/Process dependency, so it's directly unit-testable.

function sampleBilinear(grid, colF, rowF) {
  var c = Math.max(0, Math.min(grid.cols - 1, colF))
  var r = Math.max(0, Math.min(grid.rows - 1, rowF))
  var c0 = Math.floor(c), r0 = Math.floor(r)
  var c1 = Math.min(c0 + 1, grid.cols - 1), r1 = Math.min(r0 + 1, grid.rows - 1)
  var tc = c - c0, tr = r - r0
  var v00 = grid.values[r0 * grid.cols + c0]
  var v01 = grid.values[r0 * grid.cols + c1]
  var v10 = grid.values[r1 * grid.cols + c0]
  var v11 = grid.values[r1 * grid.cols + c1]
  var top = v00 + (v01 - v00) * tc
  var bottom = v10 + (v11 - v10) * tc
  return top + (bottom - top) * tr
}

// Block-matching motion estimate from gridA to gridB. Returns a flat array
// of blocks, each { c0, r0, c1, r1, dx, dy, confidence }, where dx/dy are in
// grid-cell units and confidence is in [0,1] (1 = a clear, well-correlated
// match; 0 = no reliable motion found, caller should fall back to a plain
// blend for that block).
function computeBlockMotion(gridA, gridB, blockSize, searchRadius) {
  blockSize = blockSize || 8
  var blocks = rawBlockMotion(gridA, gridB, blockSize, searchRadius)
  var blockCols = Math.ceil(gridA.cols / blockSize)
  var blockRows = Math.ceil(gridA.rows / blockSize)
  return smoothBlockMotion(blocks, blockCols, blockRows, 2)
}

// Each block's own match, before any neighbour smoothing: what the whole-map
// vector is averaged from (see globalMotionFromFrames).
function rawBlockMotion(gridA, gridB, blockSize, searchRadius) {
  blockSize = blockSize || 8
  searchRadius = searchRadius || 4
  var blocks = []
  for (var r0 = 0; r0 < gridA.rows; r0 += blockSize) {
    for (var c0 = 0; c0 < gridA.cols; c0 += blockSize) {
      var r1 = Math.min(gridA.rows, r0 + blockSize)
      var c1 = Math.min(gridA.cols, c0 + blockSize)
      blocks.push(matchBlock(gridA, gridB, c0, r0, c1, r1, searchRadius))
    }
  }
  return blocks
}

// A block only trusts a match it found directly within its own 8x8 (or so)
// cells — but real rain is mostly smooth/broad, and a flat interior region
// matches equally well at many offsets, so the direct match there is
// genuinely ambiguous (see matchBlock's confidence comment) and correctly
// comes back near-zero. Left as-is, that made only sharp-edged features
// (cell boundaries, embedded convective cores) appear to move at all, while
// broad rain areas sat frozen — the same "some areas don't move" limitation
// real optical-flow nowcasts solve by regularizing the motion field
// spatially. This does the same: a low-confidence block borrows a
// confidence-weighted average from its nearby confident neighbors instead
// of defaulting to zero motion, so a smooth block sitting inside a moving
// rain mass moves along with it. A block with no confident neighbors either
// (a genuinely dry, far-from-any-rain area) is correctly left at zero.
function smoothBlockMotion(blocks, blockCols, blockRows, radius) {
  var trustThreshold = 0.5
  var smoothed = new Array(blocks.length)
  for (var br = 0; br < blockRows; br++) {
    for (var bc = 0; bc < blockCols; bc++) {
      var idx = br * blockCols + bc
      var self = blocks[idx]
      if (!self || self.confidence >= trustThreshold) { smoothed[idx] = self; continue }
      var sumDx = 0, sumDy = 0, sumW = 0, maxNeighborConf = 0
      for (var dr = -radius; dr <= radius; dr++) {
        for (var dc = -radius; dc <= radius; dc++) {
          if (dr === 0 && dc === 0) continue
          var nr = br + dr, nc = bc + dc
          if (nr < 0 || nr >= blockRows || nc < 0 || nc >= blockCols) continue
          var neighbor = blocks[nr * blockCols + nc]
          if (!neighbor || neighbor.confidence <= 0) continue
          sumDx += neighbor.dx * neighbor.confidence
          sumDy += neighbor.dy * neighbor.confidence
          sumW += neighbor.confidence
          if (neighbor.confidence > maxNeighborConf) maxNeighborConf = neighbor.confidence
        }
      }
      if (sumW > 0) {
        // Inherited motion is trusted less than a genuine direct match.
        var inherited = Math.min(0.6, maxNeighborConf * 0.8)
        smoothed[idx] = {
          c0: self.c0, r0: self.r0, c1: self.c1, r1: self.r1,
          dx: sumDx / sumW, dy: sumDy / sumW,
          confidence: Math.max(self.confidence, inherited)
        }
      } else {
        smoothed[idx] = self
      }
    }
  }
  return smoothed
}

function blockSsdAndVariance(gridA, gridB, c0, r0, c1, r1, dx, dy) {
  var ssd = 0, mean = 0, n = 0
  for (var r = r0; r < r1; r++) {
    for (var c = c0; c < c1; c++) {
      var a = gridA.values[r * gridA.cols + c]
      var b = sampleBilinear(gridB, c + dx, r + dy)
      var diff = a - b
      ssd += diff * diff
      mean += a
      n++
    }
  }
  mean /= Math.max(1, n)
  var variance = 0
  for (var r2 = r0; r2 < r1; r2++) {
    for (var c2 = c0; c2 < c1; c2++) {
      var d = gridA.values[r2 * gridA.cols + c2] - mean
      variance += d * d
    }
  }
  return { ssd: ssd, variance: variance, n: n, mean: mean }
}

function matchBlock(gridA, gridB, c0, r0, c1, r1, searchRadius) {
  var base = blockSsdAndVariance(gridA, gridB, c0, r0, c1, r1, 0, 0)
  // A near-empty/dry block has nothing distinctive to track — treat as
  // zero motion, zero confidence, and let the caller fall back to a blend.
  if (base.mean < 0.05) return { c0: c0, r0: r0, c1: c1, r1: r1, dx: 0, dy: 0, confidence: 0 }

  var bestSsd = base.ssd, bestDx = 0, bestDy = 0
  for (var dy = -searchRadius; dy <= searchRadius; dy++) {
    for (var dx = -searchRadius; dx <= searchRadius; dx++) {
      if (dx === 0 && dy === 0) continue
      var candidate = blockSsdAndVariance(gridA, gridB, c0, r0, c1, r1, dx, dy)
      if (candidate.ssd < bestSsd) { bestSsd = candidate.ssd; bestDx = dx; bestDy = dy }
    }
  }
  // Confidence: how much the best-matched offset improved on staying put.
  // A perfectly flat block matches equally well at any offset (gridB is
  // flat there too if the underlying field is flat), so bestSsd can't beat
  // base.ssd and improvement naturally comes out at ~0 — that degenerate
  // case is already handled without needing a separate variance-based
  // gate. An earlier version also multiplied by variance/(n*4) as a
  // "structure" factor, reasoning that only well-textured blocks give a
  // trustworthy peak — but real rain-rate fields have per-pixel variance
  // typically in the 0.001-3 (mm/h)^2 range within one block (checked
  // against live DMI data), while that factor needed variance >= 4 to
  // avoid crushing confidence toward zero. It was silently suppressing
  // almost all real motion (confidence ~0.001-0.01 even for blocks with a
  // clean, spatially-consistent match), which read as "clouds stop moving
  // and fade in place" in the rendered nowcast. improvement alone tracks
  // real, spatially-coherent motion well on real data without that bias.
  var improvement = base.ssd > 0 ? (base.ssd - bestSsd) / base.ssd : 0
  var confidence = Math.max(0, Math.min(1, improvement))
  return { c0: c0, r0: r0, c1: c1, r1: r1, dx: bestDx, dy: bestDy, confidence: confidence }
}

function blockFor(blocks, blockSize, col, row) {
  var bc = Math.floor(col / blockSize)
  var br = Math.floor(row / blockSize)
  var cols = Math.ceil(blocks[0] ? (blocks[blocks.length - 1].c1) / blockSize : 1)
  return blocks[br * cols + bc] || blocks[0]
}

// Where the look upstream leaves the map, sampleBilinear repeats the edge
// value: rain keeps coming in from beyond the map at the strength it has at
// the edge. That is a guess, but a helpful one (research #29, report B.5:
// FSS +0.006 at +2 h against letting no rain in). Each step's `fromEdge`
// (1 per such cell) lets the map draw those cells as a guess.
//
// This is a simple constant-velocity extrapolation (motion estimated once
// from recent observed frames, then repeated), not a real nowcasting
// algorithm (no rotation/growth/decay modeling, no ensemble) — real weather
// motion deviates from that assumption more with every step, so accuracy
// necessarily degrades with lead time. The predicted rain is not faded with
// lead time (it once was, as an untested visual cue; that made the map's
// colours disagree with the legend and with the pin): the uncertainty is
// told by the chance of rain instead (ChanceModel.js).
//
// Extends the motion field over blocks that still have none (dry areas
// beyond smoothBlockMotion's short reach). The nowcast looks up motion at
// the places rain is heading *to*, which are typically dry right now — with
// no motion there, a shower slowed to a halt where the measured field ended
// (~50 km past the rain) instead of carrying on. Each pass lets an empty
// block take the confidence-weighted motion of its filled neighbours, with
// confidence fading a little per hop, so the flow eases out with distance
// rather than being cut off. A scene with no measured motion stays empty.
function fillMotionField(blocks, blockCols, blockRows) {
  var field = blocks.slice()
  for (var pass = 0; pass < blockCols + blockRows; pass++) {
    var next = field.slice(), changed = false
    for (var br = 0; br < blockRows; br++) {
      for (var bc = 0; bc < blockCols; bc++) {
        var idx = br * blockCols + bc
        var self = field[idx]
        if (!self || self.confidence > 0) continue
        var sumDx = 0, sumDy = 0, sumW = 0, best = 0
        for (var dr = -1; dr <= 1; dr++) {
          for (var dc = -1; dc <= 1; dc++) {
            var nr = br + dr, nc = bc + dc
            if ((dr === 0 && dc === 0) || nr < 0 || nr >= blockRows || nc < 0 || nc >= blockCols) continue
            var neighbor = field[nr * blockCols + nc]
            if (!neighbor || neighbor.confidence <= 0) continue
            sumDx += neighbor.dx * neighbor.confidence
            sumDy += neighbor.dy * neighbor.confidence
            sumW += neighbor.confidence
            if (neighbor.confidence > best) best = neighbor.confidence
          }
        }
        if (sumW > 0) {
          next[idx] = { c0: self.c0, r0: self.r0, c1: self.c1, r1: self.r1,
            dx: sumDx / sumW, dy: sumDy / sumW, confidence: Math.min(0.6, best * 0.95) }
          changed = true
        }
      }
    }
    field = next
    if (!changed) break
  }
  return field
}

// How far to trust a block's measured motion. `confidence` is match quality
// (how much better the best offset fit than staying put), not a speed
// estimate — scaling the displacement by it made everything move at a
// fraction of its true speed (a cleanly tracked shower came out at 60%),
// which shifts every predicted arrival time. So a block that matched
// reasonably moves at its full measured speed; only a weak match is eased
// toward standing still. Backtested on real DMI scans, this is a consistent
// (if modest) gain in rain-detection skill at every lead time from 30 to
// 120 min over the confidence-scaled version.
function motionWeight(confidence) {
  return Math.max(0, Math.min(1, confidence / 0.3))
}

// One motion vector for the whole map: the confidence-weighted mean of every
// block's (weighted) displacement, or null when nothing was measured. A
// per-block field lets neighbouring blocks disagree, and walking cells back
// through it duplicates or drops rain where they do (a rain total that swung
// 0.5x-2x between scans five minutes apart, docs/FORECAST-VERIFICATION.md
// section 11). A single vector cannot do that. It cannot follow shear or
// rotation either.
function globalMotion(blocks) {
  var sx = 0, sy = 0, sw = 0
  for (var i = 0; i < blocks.length; i++) {
    var b = blocks[i]
    if (!b || b.confidence <= 0) continue
    var w = motionWeight(b.confidence)
    sx += b.dx * w * b.confidence
    sy += b.dy * w * b.confidence
    sw += b.confidence
  }
  return sw > 0 ? { dx: sx / sw, dy: sy / sw } : null
}

// One motion vector for a scan pair from each block's own match (no neighbour
// smoothing, no fill of empty blocks, no down-weighting of weak matches),
// weighted by match confidence; null when nothing was measured. Averaging the
// smoothed and filled field instead (globalMotion) pulls the vector toward the
// mean of neighbouring blocks that move differently, which is shorter: that
// version ran at 0.86 of the tracked rain speed, this one at 0.91, and it
// places rain better by +0.007 FSS at +60 min (Denmark-rain-nowcast report, section 5.2
// and Appendix B.4).
function rawGlobalMotion(blocks) {
  var sx = 0, sy = 0, sw = 0
  for (var i = 0; i < blocks.length; i++) {
    var b = blocks[i]
    if (!b || b.confidence <= 0) continue
    sx += b.dx * b.confidence
    sy += b.dy * b.confidence
    sw += b.confidence
  }
  return sw > 0 ? { dx: sx / sw, dy: sy / sw } : null
}

// The whole-map vector averaged over every consecutive pair in `grids` (oldest
// first, evenly spaced in time). One pair gives a noisy vector; about 30 minutes
// of history (four scans 10 minutes apart) is best, and longer windows lose a
// little (Denmark-rain-nowcast report, Appendix B.1). Pairs where nothing
// could be measured are skipped; returns null if none could.
function globalMotionFromFrames(grids, blockSize, searchRadius) {
  var vectors = []
  for (var k = 0; k + 1 < grids.length; k++) vectors.push(pairMotion(grids[k], grids[k + 1], blockSize, searchRadius))
  return meanMotion(vectors)
}

// One scan pair's whole-map vector (null if nothing could be measured). This
// is the expensive part, about half a second of block matching per pair in
// the shell, so DataService keeps each pair's vector and computes only the
// pair a new scan adds.
function pairMotion(gridA, gridB, blockSize, searchRadius) {
  return rawGlobalMotion(rawBlockMotion(gridA, gridB, blockSize, searchRadius))
}

// The plain mean of the pair vectors that could be measured (nulls skipped),
// or null if none could: globalMotionFromFrames over the same pairs.
function meanMotion(vectors) {
  var sx = 0, sy = 0, n = 0
  for (var k = 0; k < vectors.length; k++) {
    var v = vectors[k]
    if (v) { sx += v.dx; sy += v.dy; n++ }
  }
  return n > 0 ? { dx: sx / n, dy: sy / n } : null
}

// Each output cell is found by walking *backwards* along the motion field
// from that cell (one block-motion step per output step) and sampling the
// last observed grid ONCE at wherever that walk ends. For a steady flow this
// is the same as advecting the field forwards, but it never resamples an
// already-resampled grid: doing that (bilinear interpolation applied to the
// previous step's output, 24 times over) blurs a small intense shower to
// under half its peak within 2 hours, all by itself.
//
// Each returned grid has `values`, the predicted rain, and `rawValues`, the
// same array (kept so callers that read it keep working). The sixth argument
// once set a fade toward a floor; it is ignored now, but stays in place so
// callers passing `useGlobalMotion` after it (the research repo's parity
// script among them) keep working.
// `useGlobalMotion` (default false) moves every cell by one shared vector
// instead of the per-block field. Pass an object {dx, dy} to supply that
// vector (see globalMotionFromFrames); then gridA is not used for motion.
function extrapolateSequence(gridA, gridB, steps, blockSize, searchRadius, unusedFade, useGlobalMotion) {
  if (steps <= 0) return []
  blockSize = blockSize || 8
  var cols = gridB.cols, rows = gridB.rows
  var explicit = useGlobalMotion && typeof useGlobalMotion === "object" ? useGlobalMotion : null
  var blocks = explicit ? null : fillMotionField(computeBlockMotion(gridA, gridB, blockSize, searchRadius),
    Math.ceil(cols / blockSize), Math.ceil(rows / blockSize))
  var shared = explicit || (useGlobalMotion ? (globalMotion(blocks) || { dx: 0, dy: 0 }) : null)
  var px = new Float32Array(cols * rows)
  var py = new Float32Array(cols * rows)
  for (var row = 0; row < rows; row++)
    for (var col = 0; col < cols; col++) { px[row * cols + col] = col; py[row * cols + col] = row }

  var sequence = []
  for (var i = 0; i < steps; i++) {
    var raw = new Float32Array(cols * rows)
    var fromEdge = new Uint8Array(cols * rows)
    for (var idx = 0; idx < cols * rows; idx++) {
      var x = px[idx], y = py[idx]
      if (shared) {
        x -= shared.dx
        y -= shared.dy
        px[idx] = x
        py[idx] = y
        var sv = Math.max(0, sampleBilinear(gridB, x, y))
        raw[idx] = sv
        if (x < 0 || x > cols - 1 || y < 0 || y > rows - 1) fromEdge[idx] = 1
        continue
      }
      var block = blockFor(blocks, blockSize,
        Math.max(0, Math.min(cols - 1, Math.round(x))), Math.max(0, Math.min(rows - 1, Math.round(y))))
      if (block && block.confidence > 0) {
        var weight = motionWeight(block.confidence)
        x -= block.dx * weight
        y -= block.dy * weight
        px[idx] = x
        py[idx] = y
      }
      var value = Math.max(0, sampleBilinear(gridB, x, y))
      raw[idx] = value
      if (x < 0 || x > cols - 1 || y < 0 || y > rows - 1) fromEdge[idx] = 1
    }
    sequence.push({ cols: cols, rows: rows, bounds: gridB.bounds, values: raw, rawValues: raw,
      fromEdge: fromEdge })
  }
  return sequence
}

if (typeof module !== "undefined") module.exports = {
  sampleBilinear: sampleBilinear,
  computeBlockMotion: computeBlockMotion,
  rawBlockMotion: rawBlockMotion,
  smoothBlockMotion: smoothBlockMotion,
  extrapolateSequence: extrapolateSequence,
  motionWeight: motionWeight,
  fillMotionField: fillMotionField,
  globalMotion: globalMotion,
  rawGlobalMotion: rawGlobalMotion,
  globalMotionFromFrames: globalMotionFromFrames,
  pairMotion: pairMotion,
  meanMotion: meanMotion
}
