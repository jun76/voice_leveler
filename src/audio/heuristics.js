export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  strength: 0.72,
  targetLevelDb: -20,
  sensitivityDb: 8,
  maxBoostDb: 12,
  maxCutDb: 12,
  boostRateDbPerSecond: 18,
  cutRateDbPerSecond: 36,
  releaseRateDbPerSecond: 5,
  compressorThresholdDb: -12,
  compressorRatio: 3,
  limiterCeiling: 0.94,
  bgmSuppression: false,
  bandRatioThresholdDb: -22,
  activityThresholdDb: -48,
});

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function dbFromRms(rms) {
  return 20 * Math.log10(Math.max(rms, 1e-8));
}

export function linearFromDb(db) {
  return 10 ** (db / 20);
}

export function approach(current, target, maxStep) {
  if (Math.abs(target - current) <= maxStep) return target;
  return current + Math.sign(target - current) * maxStep;
}

export class OnePoleHighPass {
  constructor(sampleRate, cutoffHz) {
    this.sampleRate = sampleRate;
    this.cutoffHz = cutoffHz;
    this.previousInput = 0;
    this.previousOutput = 0;
    this.updateCoefficient();
  }

  updateCoefficient() {
    const rc = 1 / (2 * Math.PI * this.cutoffHz);
    const dt = 1 / this.sampleRate;
    this.alpha = rc / (rc + dt);
  }

  process(input) {
    const output = this.alpha * (this.previousOutput + input - this.previousInput);
    this.previousInput = input;
    this.previousOutput = output;
    return output;
  }
}

export class OnePoleLowPass {
  constructor(sampleRate, cutoffHz) {
    this.sampleRate = sampleRate;
    this.cutoffHz = cutoffHz;
    this.previousOutput = 0;
    this.updateCoefficient();
  }

  updateCoefficient() {
    const rc = 1 / (2 * Math.PI * this.cutoffHz);
    const dt = 1 / this.sampleRate;
    this.alpha = dt / (rc + dt);
  }

  process(input) {
    this.previousOutput += this.alpha * (input - this.previousOutput);
    return this.previousOutput;
  }
}

function normalizedScore(value, floor, ceiling) {
  return clamp((value - floor) / (ceiling - floor), 0, 1);
}

export class SpeechHeuristicDetector {
  constructor(sampleRate, settings = {}) {
    this.sampleRate = sampleRate;
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.frameSize = Math.max(128, Math.round(sampleRate * 0.02));
    this.highPass = new OnePoleHighPass(sampleRate, 90);
    this.lowPass = new OnePoleLowPass(sampleRate, 4300);
    this.reset();
  }

  reset() {
    this.frameSamples = 0;
    this.fullEnergy = 0;
    this.speechEnergy = 0;
    this.activityEnergy = 0;
    this.previousBandSample = 0;
    this.noiseFloorDb = -60;
    this.active = false;
    this.onFrames = 0;
    this.offFrames = 0;
  }

  updateSettings(settings = {}) {
    this.settings = { ...this.settings, ...settings };
  }

  processSample(sample) {
    const highPassed = this.highPass.process(sample);
    const bandSample = this.lowPass.process(highPassed);

    this.fullEnergy += sample * sample;
    this.speechEnergy += bandSample * bandSample;
    const difference = bandSample - this.previousBandSample;
    this.activityEnergy += difference * difference;
    this.previousBandSample = bandSample;
    this.frameSamples += 1;

    if (this.frameSamples < this.frameSize) return null;
    const result = this.finishFrame();
    this.frameSamples = 0;
    this.fullEnergy = 0;
    this.speechEnergy = 0;
    this.activityEnergy = 0;
    return result;
  }

  finishFrame() {
    const fullDb = dbFromRms(Math.sqrt(this.fullEnergy / this.frameSize));
    const speechDb = dbFromRms(Math.sqrt(this.speechEnergy / this.frameSize));
    const activityDb = dbFromRms(Math.sqrt(this.activityEnergy / this.frameSize));
    const ratioDb = speechDb - fullDb;

    const marginDb = speechDb - this.noiseFloorDb;
    const levelScore = normalizedScore(marginDb, 3, 21);
    const ratioScore = normalizedScore(
      ratioDb,
      this.settings.bandRatioThresholdDb - 12,
      this.settings.bandRatioThresholdDb + 8,
    );
    const activityScore = normalizedScore(
      activityDb,
      this.settings.activityThresholdDb - 12,
      this.settings.activityThresholdDb + 12,
    );
    const score = 0.55 * levelScore + 0.3 * ratioScore + 0.15 * activityScore;
    const candidate =
      marginDb >= this.settings.sensitivityDb &&
      ratioDb >= this.settings.bandRatioThresholdDb &&
      score >= 0.45;

    if (!this.active && !candidate && speechDb < this.noiseFloorDb + 6) {
      this.noiseFloorDb = approach(this.noiseFloorDb, speechDb, 0.15);
    }

    if (candidate) {
      this.onFrames += 1;
      this.offFrames = 0;
      if (!this.active && this.onFrames >= 5) this.active = true;
    } else {
      this.offFrames += 1;
      this.onFrames = 0;
      if (this.active && this.offFrames >= 20) this.active = false;
    }

    return {
      active: this.active,
      candidate,
      score,
      fullDb,
      speechDb,
      ratioDb,
      activityDb,
      noiseFloorDb: this.noiseFloorDb,
    };
  }
}

export function desiredGainDb(speechLevelDb, settings = {}) {
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  const correction = (merged.targetLevelDb - speechLevelDb) * merged.strength;
  return clamp(correction, -merged.maxCutDb, merged.maxBoostDb);
}
