// @soundtouchjs/audio-worklet's SoundTouchNode `extends AudioWorkletNode` at
// class-definition time — the global must exist before the audioManager graph
// loads. Import this module FIRST in any test that imports the playback graph.
// The stub class is only ever used as a superclass in Node; no worklet methods
// are reached in the glue tests (the real engine is never constructed).
if (typeof globalThis.AudioWorkletNode === 'undefined') {
  class AudioWorkletNodeStub {}
  globalThis.AudioWorkletNode = AudioWorkletNodeStub as unknown as typeof AudioWorkletNode
}
