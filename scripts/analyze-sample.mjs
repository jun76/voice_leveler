import { spawn } from 'node:child_process';
import { SpeechHeuristicDetector, desiredGainDb } from '../src/audio/heuristics.js';

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: npm run analyze:sample -- <audio-file>');
  process.exit(1);
}
const sampleRate = 48000;

const ffmpeg = spawn('ffmpeg', [
  '-hide_banner',
  '-loglevel',
  'error',
  '-i',
  inputPath,
  '-f',
  's16le',
  '-ac',
  '1',
  '-ar',
  String(sampleRate),
  'pipe:1',
]);

const chunks = [];
const errors = [];
ffmpeg.stdout.on('data', (chunk) => chunks.push(chunk));
ffmpeg.stderr.on('data', (chunk) => errors.push(chunk));

const exitCode = await new Promise((resolve) => ffmpeg.on('close', resolve));
if (exitCode !== 0) {
  throw new Error(Buffer.concat(errors).toString() || `ffmpeg exited with ${exitCode}`);
}

const pcm = Buffer.concat(chunks);
const detector = new SpeechHeuristicDetector(sampleRate);
let frames = 0;
let activeFrames = 0;
let activeLevelSum = 0;
let maxScore = 0;
let desiredGainSum = 0;
let minDesiredGain = Infinity;
let maxDesiredGain = -Infinity;

for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
  const sample = pcm.readInt16LE(offset) / 32768;
  const frame = detector.processSample(sample);
  if (!frame) continue;
  frames += 1;
  maxScore = Math.max(maxScore, frame.score);
  if (frame.active) {
    activeFrames += 1;
    activeLevelSum += frame.speechDb;
    const gain = desiredGainDb(frame.speechDb);
    desiredGainSum += gain;
    minDesiredGain = Math.min(minDesiredGain, gain);
    maxDesiredGain = Math.max(maxDesiredGain, gain);
  }
}

const durationSeconds = pcm.length / 2 / sampleRate;
const activeSeconds = activeFrames * 0.02;
const averageActiveLevel = activeFrames > 0 ? activeLevelSum / activeFrames : -60;
const averageDesiredGain = activeFrames > 0 ? desiredGainSum / activeFrames : 0;

console.log(JSON.stringify({
  inputPath,
  durationSeconds: Number(durationSeconds.toFixed(2)),
  analyzedFrames: frames,
  detectedSpeechSeconds: Number(activeSeconds.toFixed(2)),
  detectedSpeechRatio: Number((activeFrames / Math.max(1, frames)).toFixed(3)),
  averageDetectedSpeechDb: Number(averageActiveLevel.toFixed(2)),
  averageDesiredGainDb: Number(averageDesiredGain.toFixed(2)),
  desiredGainRangeDb: activeFrames > 0
    ? [Number(minDesiredGain.toFixed(2)), Number(maxDesiredGain.toFixed(2))]
    : [0, 0],
  maximumSpeechScore: Number(maxScore.toFixed(3)),
}, null, 2));
