import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sampleRate = 48_000;
const duration = 35;
const channels = 2;
const frames = sampleRate * duration;
const tempo = 110;
const beatSeconds = 60 / tempo;
const output = resolve(dirname(fileURLToPath(import.meta.url)), '../public/audio/field-payroll/music.wav');

const roots = [38, 34, 41, 36]; // D2, Bb1, F2, C2
const chordIntervals = [[0, 3, 7], [0, 4, 7], [0, 4, 7], [0, 4, 7]];
let noiseState = 0x51f15e;

function noise() {
  noiseState ^= noiseState << 13;
  noiseState ^= noiseState >>> 17;
  noiseState ^= noiseState << 5;
  return ((noiseState >>> 0) / 0xffffffff) * 2 - 1;
}

function frequency(note) {
  return 440 * 2 ** ((note - 69) / 12);
}

function oscillator(freq, time) {
  const phase = time * freq;
  const sine = Math.sin(phase * Math.PI * 2);
  const triangle = 2 * Math.abs(2 * (phase - Math.floor(phase + 0.5))) - 1;
  return sine * 0.72 + triangle * 0.28;
}

function clampSample(value) {
  return Math.max(-1, Math.min(1, value));
}

const pcm = Buffer.alloc(frames * channels * 2);
for (let i = 0; i < frames; i += 1) {
  const time = i / sampleRate;
  const beat = time / beatSeconds;
  const beatIndex = Math.floor(beat);
  const beatPhase = beat - beatIndex;
  const eighth = Math.floor(beat * 2);
  const eighthPhase = beat * 2 - eighth;
  const bar = Math.floor(beat / 4);
  const root = roots[bar % roots.length];
  const intervals = chordIntervals[bar % chordIntervals.length];

  let pad = 0;
  for (const interval of intervals) {
    const freq = frequency(root + 12 + interval);
    pad += Math.sin(2 * Math.PI * freq * time + interval * 0.17);
  }
  pad *= 0.018;

  const pulseNote = root + 12 + [0, 7, 3, 7][eighth % 4];
  const pulseEnvelope = Math.exp(-eighthPhase * 8);
  const pulse = oscillator(frequency(pulseNote), time) * pulseEnvelope * 0.042;

  const bassEnvelope = Math.exp(-beatPhase * 5.5);
  const bass = Math.sin(2 * Math.PI * frequency(root) * time) * bassEnvelope * 0.085;

  const kickEnvelope = Math.exp(-beatPhase * 18);
  const kickFrequency = 48 + 52 * Math.exp(-beatPhase * 24);
  const kick = Math.sin(2 * Math.PI * kickFrequency * time) * kickEnvelope * 0.16;

  const snareBeat = beatIndex % 4 === 1 || beatIndex % 4 === 3;
  const snare = snareBeat && beatPhase < 0.18
    ? noise() * Math.exp(-beatPhase * 28) * 0.055
    : 0;
  const shaker = eighthPhase < 0.1
    ? noise() * Math.exp(-eighthPhase * 45) * (eighth % 2 === 0 ? 0.018 : 0.012)
    : 0;

  const fadeIn = Math.min(1, time / 0.8);
  const fadeOut = Math.min(1, Math.max(0, (duration - time) / 2.2));
  const endingLift = time > 32 ? 1 - (time - 32) / 3 : 1;
  const mono = (pad + pulse + bass + kick + snare + shaker) * fadeIn * fadeOut * endingLift;
  const left = clampSample(mono + pad * 0.18);
  const right = clampSample(mono - pad * 0.18);
  pcm.writeInt16LE(Math.round(left * 32767), i * 4);
  pcm.writeInt16LE(Math.round(right * 32767), i * 4 + 2);
}

const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + pcm.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(channels, 22);
header.writeUInt32LE(sampleRate, 24);
header.writeUInt32LE(sampleRate * channels * 2, 28);
header.writeUInt16LE(channels * 2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(pcm.length, 40);

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, Buffer.concat([header, pcm]));
console.log(`Generated ${output}`);
