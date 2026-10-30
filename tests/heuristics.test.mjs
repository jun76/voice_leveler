import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SpeechHeuristicDetector,
  DEFAULT_SETTINGS,
  desiredGainDb,
  dbFromRms,
} from '../src/audio/heuristics.js';

function feed(detector, samples) {
  const frames = [];
  for (const sample of samples) {
    const frame = detector.processSample(sample);
    if (frame) frames.push(frame);
  }
  return frames;
}

test('dB conversion is stable near silence', () => {
  assert.equal(dbFromRms(1), 0);
  assert.ok(dbFromRms(0) < -150);
});

test('silence is not classified as speech', () => {
  const detector = new SpeechHeuristicDetector(48000);
  const frames = feed(detector, new Array(48000).fill(0));
  assert.ok(frames.length > 0);
  assert.equal(frames.some((frame) => frame.active), false);
});

test('speech-like modulated signal becomes active after the hangover', () => {
  const detector = new SpeechHeuristicDetector(48000, {
    sensitivityDb: 6,
  });
  const samples = [];
  for (let i = 0; i < 48000; i += 1) {
    const modulation = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 5 * i / 48000));
    const noise = Math.sin(2 * Math.PI * 220 * i / 48000) * 0.12;
    samples.push(modulation * noise);
  }
  const frames = feed(detector, samples);
  assert.ok(frames.some((frame) => frame.active));
});

test('desired gain boosts quiet speech and cuts loud speech', () => {
  assert.ok(desiredGainDb(-35, DEFAULT_SETTINGS) > 0);
  assert.ok(desiredGainDb(-8, DEFAULT_SETTINGS) < 0);
  assert.equal(desiredGainDb(-60, { ...DEFAULT_SETTINGS, maxBoostDb: 6 }), 6);
});
