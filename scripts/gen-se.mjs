#!/usr/bin/env node
/**
 * 生成内置环境音效/SE（WAV 44.1kHz 16bit 单声道）。
 * 程序化合成，无版权、零素材。输出到 src/gameExtra/se/，随项目分发到 game/vocal/。
 * 命名：se_rain.wav / se_thunder / se_wind / se_battle / se_door / se_step / se_sword / se_tension
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "src", "gameExtra", "se");
const SR = 44100;

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SR, 24);
  header.writeUInt32LE(SR * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function save(name, samples) {
  writeFileSync(join(OUT, `se_${name}.wav`), wav(samples));
  console.log(`se_${name}.wav  (${Math.round(samples.length / SR * 100) / 100}s)`);
}

const rng = (seed) => {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
};

// 白噪声（用于雨/风）
function white(n, rnd) {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = rnd() * 2 - 1;
  return a;
}

// 一阶低通滤波（就地）
function lowpass(a, alpha) {
  const out = new Float32Array(a.length);
  out[0] = a[0];
  for (let i = 1; i < a.length; i++) out[i] = out[i - 1] + alpha * (a[i] - out[i - 1]);
  return out;
}

// 包络
function env(a, att, rel) {
  const n = a.length;
  const out = new Float32Array(n);
  const at = Math.floor(att * SR);
  const rt = Math.floor(rel * SR);
  for (let i = 0; i < n; i++) {
    let e = 1;
    if (i < at) e = i / at;
    const t = n - 1 - i;
    if (t < rt) e = Math.min(e, t / rt);
    out[i] = a[i] * e;
  }
  return out;
}

function mix(...xs) {
  const n = Math.max(...xs.map((x) => x.length));
  const out = new Float32Array(n);
  for (const x of xs) for (let i = 0; i < x.length; i++) out[i] += x[i];
  return out;
}

function loop(a, sec) {
  const out = new Float32Array(Math.floor(sec * SR));
  for (let i = 0; i < out.length; i++) out[i] = a[i % a.length] * 0.9;
  return out;
}

// 雨：两段不同速率低通白噪声 + 稀疏水滴
function makeRain(rnd) {
  const n = SR * 4;
  const base = lowpass(white(n, rnd), 0.08);
  const hiss = lowpass(white(n, () => rnd()), 0.3);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = base[i] * 0.55 + hiss[i] * 0.18;
  // 水滴
  for (let i = 0; i < 60; i++) {
    const at = Math.floor(rnd() * n);
    for (let k = 0; k < 180; k++) {
      const idx = at + k;
      if (idx >= n) break;
      const env = Math.sin(Math.PI * k / 180) ** 3;
      out[idx] += (rnd() * 2 - 1) * env * 0.25;
    }
  }
  return loop(out, 4);
}

// 雷：低频布朗冲击
function makeThunder(rnd) {
  const n = SR * 3;
  const out = new Float32Array(n);
  let v = 0;
  for (let i = 0; i < n; i++) {
    v += (rnd() * 2 - 1) * 0.02;
    v *= 0.995;
    const t = i / SR;
    const decay = Math.exp(-t * 2.2);
    out[i] = v * 1.8 * decay;
  }
  // 初始爆发
  for (let i = 0; i < 4000; i++) out[i] += (rnd() * 2 - 1) * Math.exp(-i / 900) * 0.5;
  return out;
}

// 风：带通白噪声 + 缓慢振幅调制
function makeWind(rnd) {
  const n = SR * 4;
  const a = lowpass(white(n, rnd), 0.02);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const mod = 0.6 + 0.4 * Math.sin(t * 1.3) * Math.sin(t * 0.7 + 1.0);
    out[i] = a[i] * mod * 0.6;
  }
  return loop(out, 4);
}

// 战斗：金属碰撞脉冲序列 + 低音冲击
function makeBattle(rnd) {
  const n = SR * 2.5;
  const out = new Float32Array(n);
  for (let h = 0; h < 7; h++) {
    const at = Math.floor((0.15 + rnd() * 2.0) * SR);
    for (let k = 0; k < 3000; k++) {
      const idx = at + k;
      if (idx >= n) break;
      const env = Math.exp(-k / 500);
      const f = 1800 + rnd() * 2600;
      out[idx] += Math.sin(2 * Math.PI * f * k / SR) * env * 0.35;
    }
  }
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const thump = Math.exp(-t * 3) * Math.sin(2 * Math.PI * 70 * t);
    out[i] += thump * 0.6;
  }
  return out;
}

// 敲门：3 连击低频敲击
function makeDoor(rnd) {
  const n = SR * 1.8;
  const out = new Float32Array(n);
  for (let h = 0; h < 3; h++) {
    const at = Math.floor((0.1 + h * 0.42) * SR);
    for (let k = 0; k < 2500; k++) {
      const idx = at + k;
      if (idx >= n) break;
      const env = Math.exp(-k / 380);
      out[idx] += (Math.sin(2 * Math.PI * 120 * k / SR) + Math.sin(2 * Math.PI * 240 * k / SR) * 0.5) * env * 0.55;
    }
  }
  return out;
}

// 脚步：周期性低频踩踏
function makeStep(rnd) {
  const n = SR * 2.2;
  const out = new Float32Array(n);
  for (let h = 0; h < 8; h++) {
    const at = Math.floor((0.2 + h * 0.26) * SR);
    for (let k = 0; k < 1600; k++) {
      const idx = at + k;
      if (idx >= n) break;
      const env = Math.exp(-k / 220);
      out[idx] += Math.sin(2 * Math.PI * 95 * k / SR) * env * 0.45;
    }
  }
  return out;
}

// 挥剑：快速频率扫掠
function makeSword(rnd) {
  const n = SR * 1.2;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = 400 + 2600 * t;
    let ph = 0;
    for (let k = 0; k <= i; k++) ph += 2 * Math.PI * (400 + 2600 * k / SR) / SR;
    const env = Math.sin(Math.PI * t / 1.2) ** 2;
    out[i] = Math.sin(ph) * env * 0.4;
  }
  return out;
}

// 张力：低频持续低音 + 心跳
function makeTension(rnd) {
  const n = SR * 3;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const drone = Math.sin(2 * Math.PI * 55 * t) * 0.3 + Math.sin(2 * Math.PI * 82.5 * t) * 0.2;
    const heart = (Math.sin(2 * Math.PI * 1.4 * t) > 0.88 ? 0.35 : 0);
    out[i] = drone + heart * Math.exp(-((t % (1 / 1.4)) * 6));
  }
  return env(out, 0.15, 0.4);
}

mkdirSync(OUT, { recursive: true });
save("rain", makeRain(rng(11)));
save("thunder", makeThunder(rng(22)));
save("wind", makeWind(rng(33)));
save("battle", makeBattle(rng(44)));
save("door", makeDoor(rng(55)));
save("step", makeStep(rng(66)));
save("sword", makeSword(rng(77)));
save("tension", makeTension(rng(88)));
console.log("音效生成完成 →", OUT);
