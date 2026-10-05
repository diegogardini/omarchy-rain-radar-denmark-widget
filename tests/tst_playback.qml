import QtQuick
import QtTest
import ".." as Rain

Item {
  Rain.PlaybackController {
    id: playback
    playing: false
    // 3 observed scans (the middle one without a measured motion), then 4 nowcast steps
    frames: [{ kind: "observed", motion: { dx: 2, dy: -1 } }, { kind: "observed" }, { kind: "observed", motion: { dx: 2, dy: -1 } },
      { kind: "forecast", motion: { dx: 2, dy: -1 } }, { kind: "forecast", motion: { dx: 2, dy: -1 } },
      { kind: "forecast", motion: { dx: 2, dy: -1 } }, { kind: "forecast", motion: { dx: 2, dy: -1 } }]
    nowIndex: 3
  }
  TestCase {
    name: "Playback"

    function init() { playback.seek(0) }

    function test_observedScansGlideAlongTheirMotionThenTheNextScanReplacesThem() {
      verify(playback.smooth)
      for (var i = 1; i < playback.subSteps; i++) { playback.tick(); compare(playback.index, 0) }
      verify(playback.fraction > 0.8)
      playback.tick()
      compare(playback.index, 1)
      compare(playback.fraction, 0)
    }

    function test_aFrameWithoutMotionStepsWhole() {
      playback.seek(1)
      compare(playback.smooth, false)
      compare(playback.fraction, 0)
      playback.tick()
      compare(playback.index, 2)
    }

    function test_nowcastStepsMoveInSubStepsThenAdvance() {
      playback.seek(3)
      verify(playback.smooth)
      var seen = [playback.fraction]
      for (var i = 1; i < playback.subSteps; i++) { playback.tick(); compare(playback.index, 3); seen.push(playback.fraction) }
      for (var k = 0; k < seen.length; k++) verify(Math.abs(seen[k] - k / playback.subSteps) < 1e-9, "fraction " + seen[k])
      // the slider's position glides with it
      verify(Math.abs(playback.position - (3 + (playback.subSteps - 1) / playback.subSteps)) < 1e-9, "position " + playback.position)
      playback.tick()
      compare(playback.index, 4)
      compare(playback.fraction, 0)
    }

    function test_theLastNowcastStepHoldsStillThenTheLoopRestarts() {
      playback.seek(6)
      compare(playback.smooth, false)
      compare(playback.fraction, 0)
      playback.tick()
      compare(playback.index, 0)
    }

    function test_aJumpHoldsTheFrameThenPlaysOn() {
      playback.playing = true
      playback.hold(150)
      compare(playback.playing, false)
      tryCompare(playback, "playing", true, 1000)
      playback.playing = false
    }

    function test_aJumpWhilePausedStaysPaused() {
      playback.pause()
      playback.hold(100)
      wait(250)
      compare(playback.playing, false)
    }

    function test_pausingDuringAHoldCancelsTheResume() {
      playback.playing = true
      playback.hold(150)
      playback.pause()
      wait(300)
      compare(playback.playing, false)
    }

    function test_theTimerRunsFasterOnlyWhileGliding() {
      playback.seek(1)
      compare(playback.smooth, false)
      playback.seek(4)
      verify(playback.smooth)
      // seeking always lands at the start of a step
      playback.tick(); playback.tick()
      playback.seek(5)
      compare(playback.fraction, 0)
    }
  }
}
