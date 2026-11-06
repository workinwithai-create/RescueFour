# RescueFour

Four-bar rescue pocket desk for bedroom producers and AI-music finishers.

Unfinished beats and blank sessions stall because the core never locks. RescueFour writes a complete 4-bar pocket — live FluidR3 kit, upright, piano, nylon, violin — over your BPM, key, and 4-chord progression. Export WAV + MIDI that drop on the grid.

Live samples only from the PreEight bank pinned to commit SHA. No oscillators. Audio never leaves the tab.

Distinct from TagFour (last-line end tag), LiftTwo (pre-hook lift), PreEight (pre-chorus climb), AfterHook, EndEight, LastHook.

## Pricing

**Free.** (Finite desk; no subscription. Forge Pass remains for the recurring tools.)

## License

MIT. Free to use.

Built for workinwithai-create.

## Audio engine compliance

- Lookahead scheduler on AudioContext clock (LOOKAHEAD_MS=25, SCHEDULE_AHEAD=0.12)
- Live mutable state read every step; changes within one bar; immediate stop
- OfflineAudioContext export: first downbeat at sample 0, exact length Math.round(bars*4*60/bpm*sampleRate), tail folded, 48 kHz 24-bit stereo, peak ≤ −1 dBFS, matching multi-track MIDI
- User BPM 60–180 + key + 4-chord persist in localStorage
- Samples pinned to PreEight@d58301e4a494555f411a2afbc448b724136eee76
- Pitch shift clamped ±4 semitones with revoicing
