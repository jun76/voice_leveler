import {
  DEFAULT_SETTINGS,
  OnePoleHighPass,
  OnePoleLowPass,
  SpeechHeuristicDetector,
  approach,
  clamp,
  dbFromRms,
  desiredGainDb,
  linearFromDb,
} from './heuristics.js';

class VoiceLevelerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.settings = { ...DEFAULT_SETTINGS };
    this.detector = new SpeechHeuristicDetector(sampleRate, this.settings);
    this.targetGainDb = 0;
    this.appliedGainDb = 0;
    this.compressorGainDb = 0;
    this.compressorEnvelope = 0;
    this.channelFilters = [0, 1].map(() => ({
      low: new OnePoleLowPass(sampleRate, 180),
      high: new OnePoleHighPass(sampleRate, 4500),
    }));
    this.lastFrame = null;
    this.meterSamples = 0;
    this.meterEnergy = 0;
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'settings') {
        this.settings = { ...this.settings, ...data.settings };
        this.detector.updateSettings(this.settings);
      }
      if (data?.type === 'reset') this.reset();
    };
  }

  reset() {
    this.detector.reset();
    this.targetGainDb = 0;
    this.appliedGainDb = 0;
    this.compressorGainDb = 0;
    this.compressorEnvelope = 0;
    this.lastFrame = null;
  }

  updateFrame(frame) {
    this.lastFrame = frame;
    if (frame.active) {
      this.targetGainDb = desiredGainDb(frame.speechDb, this.settings);
    } else {
      this.targetGainDb = 0;
    }
  }

  updateGain() {
    const increasing = this.targetGainDb > this.appliedGainDb;
    const returningToUnity = this.targetGainDb === 0 && this.appliedGainDb !== 0;
    const rate = returningToUnity
      ? this.settings.releaseRateDbPerSecond
      : increasing
        ? this.settings.boostRateDbPerSecond
        : this.settings.cutRateDbPerSecond;
    const step = rate / sampleRate;
    this.appliedGainDb = approach(this.appliedGainDb, this.targetGainDb, step);
  }

  updateCompressor(inputPeak) {
    const attack = 1 - Math.exp(-1 / (sampleRate * 0.015));
    const release = 1 - Math.exp(-1 / (sampleRate * 0.18));
    const coefficient = inputPeak > this.compressorEnvelope ? attack : release;
    this.compressorEnvelope += coefficient * (inputPeak - this.compressorEnvelope);
    const envelopeDb = dbFromRms(this.compressorEnvelope);
    const threshold = this.settings.compressorThresholdDb;
    const ratio = Math.max(1, this.settings.compressorRatio);
    const reductionDb = envelopeDb > threshold
      ? -(envelopeDb - threshold) * (1 - 1 / ratio)
      : 0;
    const compressorStep = (reductionDb - this.compressorGainDb) /
      (sampleRate * (reductionDb < this.compressorGainDb ? 0.015 : 0.18));
    this.compressorGainDb += compressorStep;
  }

  applyBgmSuppression(value, channelIndex) {
    if (!this.settings.bgmSuppression || !this.lastFrame?.active) return value;
    const filters = this.channelFilters[channelIndex] ?? this.channelFilters[0];
    const low = filters.low.process(value);
    const high = filters.high.process(value);
    const mid = value - low - high;
    return low * linearFromDb(-1.8) + mid + high * linearFromDb(-0.9);
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input?.length || !input[0]?.length) {
      for (const channel of output) channel.fill(0);
      return true;
    }

    for (let i = 0; i < input[0].length; i += 1) {
      const left = input[0][i] ?? 0;
      const right = input[1]?.[i] ?? left;
      const mono = (left + right) * 0.5;
      const frame = this.detector.processSample(mono);
      if (frame) this.updateFrame(frame);

      this.updateGain();
      const gain = linearFromDb(this.appliedGainDb);
      const gainedLeft = this.applyBgmSuppression(left, 0) * gain;
      const gainedRight = this.applyBgmSuppression(right, 1) * gain;
      const inputPeak = Math.max(Math.abs(gainedLeft), Math.abs(gainedRight));
      this.updateCompressor(inputPeak);
      const compressedGain = linearFromDb(this.compressorGainDb);
      const ceiling = clamp(this.settings.limiterCeiling, 0.5, 0.99);

      output[0][i] = this.limit(gainedLeft * compressedGain, ceiling);
      if (output[1]) output[1][i] = this.limit(gainedRight * compressedGain, ceiling);
      for (let channel = 2; channel < output.length; channel += 1) {
        output[channel][i] = output[channel][i - 1] ?? 0;
      }

      this.meterEnergy += mono * mono;
      this.meterSamples += 1;
      if (this.meterSamples >= sampleRate * 0.1) {
        this.sendMeter();
        this.meterSamples = 0;
        this.meterEnergy = 0;
      }
    }

    return true;
  }

  limit(value, ceiling) {
    const magnitude = Math.abs(value);
    if (magnitude <= ceiling) return value;
    const softened = ceiling + (magnitude - ceiling) * 0.08;
    return Math.sign(value) * Math.min(softened, 0.999);
  }

  sendMeter() {
    this.port.postMessage({
      type: 'meter',
      inputDb: dbFromRms(Math.sqrt(this.meterEnergy / Math.max(1, this.meterSamples))),
      speechDetected: Boolean(this.lastFrame?.active),
      speechLevelDb: this.lastFrame?.speechDb ?? -60,
      speechScore: this.lastFrame?.score ?? 0,
      noiseFloorDb: this.lastFrame?.noiseFloorDb ?? -60,
      gainDb: this.appliedGainDb,
      targetGainDb: this.targetGainDb,
    });
  }
}

registerProcessor('voice-leveler-processor', VoiceLevelerProcessor);
