// =====================================================================
//  rattle.js — the sound of dice on a table.
//
//  Two layers, from the same physics data:
//
//    strikes — a crack each time a die lands, read off a local minimum in
//              height. Discrete, loud, and driven by the impact speed.
//    the bed — a continuous tumble underneath, driven by how fast the whole
//              handful is moving. Between the strikes the dice are still
//              rolling and skidding, and silence there reads as broken. Its
//              volume tracks speed directly, so it swells as they scatter
//              and thins to nothing as they come to rest.
//
//  dice-box has no collision callback (it exposes onBeforeRoll,
//  onDieComplete, onRollComplete, onRemoveComplete and nothing else) and
//  ships no audio, so this hooks one layer down instead.
//
//  Ammo runs in a worker and posts transforms back every frame. The world
//  module unpacks them in `updatesFromPhysics(buffer)` as a Float32Array:
//
//      [0] die count, then per die, stride 8:
//      +0 id   +1 x   +2 y   +3 z   +4..+7 quaternion
//      (+1 === -1 is the "asleep" sentinel, not a position)
//
//  There is no velocity in there, so a bounce is read off the geometry: a
//  local minimum in height — falling one frame, not falling the next. The
//  fall speed at that moment is the impact, and it drives the volume.
//
//  `install()` imports the world module by the path dice-box itself uses,
//  so it gets the same cached module record and patches the same class the
//  DiceBox instance will be built from. No fork of the vendored bundle.
//
//  Usage, before constructing a DiceBox:
//      import { Rattle } from "<...>/dice/rattle.js";
//      await Rattle.install();
// =====================================================================

// --- Thresholds are RELATIVE, not absolute. The physics world's units are
// --- not documented anywhere and differ with `scale`, so anything hard-coded
// --- in world-units/frame is a guess that silently fails when it is wrong.
// --- Instead the loudest fall yet seen calibrates the rest: a die accelerates
// --- downward for many frames before it lands, so by its first impact the
// --- peak is already the right order of magnitude.
let   UP           = 2;      // buffer offset of the vertical axis (Babylon is Y-up)
const FLOOR_FRAC   = 0.05;   // below 5% of peak fall it is settling, not a bounce
const REF_FRAC     = 0.55;   // 55% of peak fall plays at full volume
const PEAK_DECAY   = 0.9995; // per frame, so one freak value cannot deafen it
const COOLDOWN_MS  = 55;     // per die, or a settling die machine-guns
const TELEPORT_FRAC= 8;      // a jump this many times the peak is a respawn, not a fall
const MAX_VOICES   = 12;
const MASTER       = 0.5;

// --- The rolling bed. Calibrated the same relative way, off 3D speed rather
// --- than the vertical axis alone: a die skidding flat across the table is
// --- still making noise, and only its x/z are changing.
let   ROLL_LEVEL   = 0.22;   // bed volume at full tilt — deliberately under the strikes
const ROLL_GATE    = 0.05;   // below 5% of reference speed, stop rather than whisper
const ROLL_REF     = 0.85;   // fraction of peak speed that plays full — see note below
// --- Deliberately higher than the strikes' REF_FRAC. A strike is one moment,
// --- so clamping the loud half of the range to full volume costs nothing. The
// --- bed is heard for the whole roll, and the same clamp would hold it pinned
// --- at maximum until the dice were already half-stopped, which is precisely
// --- the taper this layer exists to provide.
const ROLL_SPREAD  = 4;      // dice at reference speed needed to reach full volume
const ROLL_ATTACK  = 0.04;   // s, gain smoothing as it rises
const ROLL_RELEASE = 0.16;   // s, gain smoothing as it falls — the audible taper
const ROLL_IDLE_MS = 160;    // no physics frame for this long means everything stopped

let ctx = null, master = null, noise = null, voices = 0;
let enabled = localStorage.getItem("rattle") !== "off";
let installed = false;
let peakFall = 0;           // largest downward step seen, the calibration datum
let peakSpeed = 0;          // same, for 3D motion — calibrates the bed
let bed = null;             // { src, hp, lp, gain, target } while the dice move
let bedIdle = 0;            // watchdog: frames stop arriving when the world sleeps
const tracks = new Map();   // die id -> { x, y, z, up, vy, last }

// Live counters. `Rattle.stats` in the console answers, in order: is the patch
// running (frames), is it seeing dice (dice), is there motion on the axis we
// think is up (peakFall), did anything fire (impacts), and could it be heard
// (blocked). Whichever is zero is the fault.
const stats = { frames: 0, dice: 0, peakFall: 0, peakSpeed: 0, impacts: 0, roll: 0, blocked: 0, audio: "none" };

function boot() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = MASTER;
  master.connect(ctx.destination);
  // One second of white noise, generated once and reused as the body of
  // every impact. Cheaper than a sample and nothing to fetch.
  noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return ctx;
}

// Bone on wood: a filtered noise crack for the surface, plus a short low
// body whose weight scales with the hit. Randomised per strike so forty
// impacts are not the same click forty times.
function strike(hit) {
  if (!enabled) return;
  if (!ctx) { boot(); }
  if (!ctx) { stats.audio = "unsupported"; return; }
  if (ctx.state !== "running") {
    // Created outside a gesture, or the tab was backgrounded. Ask anyway —
    // it succeeds if a gesture has happened since.
    stats.audio = ctx.state; stats.blocked++; ctx.resume();
    return;
  }
  stats.audio = "running";
  if (voices >= MAX_VOICES) return;
  const t = ctx.currentTime;
  hit = Math.max(0, Math.min(1, hit));
  const level = 0.12 + 0.88 * hit * hit;   // squared: soft taps stay soft
  voices++;

  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.playbackRate.value = 0.85 + Math.random() * 0.5;
  src.loop = true;

  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 900 + Math.random() * 1300 + hit * 500;
  band.Q.value = 0.9 + Math.random() * 0.8;

  const crack = ctx.createGain();
  const decay = 0.035 + Math.random() * 0.05 + hit * 0.03;
  crack.gain.setValueAtTime(0, t);
  crack.gain.linearRampToValueAtTime(level, t + 0.001);
  crack.gain.exponentialRampToValueAtTime(0.0001, t + decay);

  src.connect(band).connect(crack).connect(master);
  src.start(t);
  src.stop(t + decay + 0.02);
  src.onended = () => { voices--; };

  if (hit > 0.25) {                        // only real hits get a thud
    const body = ctx.createOscillator();
    body.type = "triangle";
    body.frequency.setValueAtTime(150 + Math.random() * 60, t);
    body.frequency.exponentialRampToValueAtTime(70, t + 0.06);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0, t);
    bg.gain.linearRampToValueAtTime(level * 0.35, t + 0.002);
    bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    body.connect(bg).connect(master);
    body.start(t);
    body.stop(t + 0.09);
  }
}

// A loop of the same noise, darkened and band-limited: many small collisions
// running together rather than any one of them. Built on the first moving
// frame and torn down when the table goes quiet, so nothing is left running
// between rolls.
function bedStart() {
  if (bed || !ctx || ctx.state !== "running") return;

  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.loop = true;

  // Rolled off at both ends: the low end belongs to the strikes' thud, and
  // the top end is what makes noise sound like static instead of wood.
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 240;

  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 600;
  lp.Q.value = 0.7;

  const gain = ctx.createGain();
  gain.gain.value = 0;

  src.connect(hp).connect(lp).connect(gain).connect(master);
  src.start();
  // `level` is the param, `gain` the node it belongs to — the node is only
  // kept so the teardown can disconnect it.
  bed = { src, hp, lp, gain, level: gain.gain, target: 0 };
}

function bedStop() {
  if (!bed) return;
  const { src, gain } = bed;
  bed = null;
  const t = ctx.currentTime;
  gain.gain.cancelScheduledValues(t);
  gain.gain.setTargetAtTime(0, t, 0.04);
  src.onended = () => { try { gain.disconnect(); } catch { /* already gone */ } };
  try { src.stop(t + 0.3); } catch { /* already stopped */ }
}

// `speed` is 0..1 — the whole handful's motion this frame, normalised.
function bedLevel(speed) {
  if (!enabled) { bedStop(); return; }
  if (speed < ROLL_GATE) {
    // Fall silent, but leave the loop running. Speed crosses this line more
    // than once while a handful settles, and tearing down on each dip would
    // stack up overlapping sources with 0.3s tails. The idle watchdog owns
    // the teardown, and it only fires once the world has actually stopped.
    if (bed) { bed.level.setTargetAtTime(0, ctx.currentTime, ROLL_RELEASE); bed.target = 0; }
    return;
  }
  if (!ctx) boot();
  if (!ctx || ctx.state !== "running") return;   // unlock() resumes it on the first gesture
  bedStart();
  if (!bed) return;

  const t = ctx.currentTime;
  // The point of the whole layer: volume is proportional to speed, so the bed
  // thins out at exactly the rate the dice lose momentum. Release is slower
  // than attack so the taper is heard as a fade rather than a stutter.
  const target = ROLL_LEVEL * speed;
  bed.level.setTargetAtTime(target, t, target > bed.target ? ROLL_ATTACK : ROLL_RELEASE);
  bed.target = target;

  // Fast dice are brighter, so losing speed darkens the sound as well as
  // quietening it — which is what a real handful does as it runs out of energy.
  bed.lp.frequency.setTargetAtTime(400 + 2400 * speed * speed, t, 0.05);
  bed.src.playbackRate.setTargetAtTime(0.75 + 0.5 * speed, t, 0.08);
}

// Called with the raw physics buffer, every frame, before it renders.
function read(view) {
  const count = view[0];
  const now = performance.now();
  stats.frames++;
  if (count > stats.dice) stats.dice = count;
  peakFall *= PEAK_DECAY;
  peakSpeed *= PEAK_DECAY;
  let energy = 0;   // summed per-die speed, in units of "one die at reference"

  for (let i = 0, t = 1; i < count; i++, t += 8) {
    const id = view[t];
    if (view[t + 1] === -1) { tracks.delete(id); continue; }   // asleep
    // Position is always at +1/+2/+3; UP only says which of them is height.
    const x = view[t + 1], y = view[t + 2], z = view[t + 3];
    const up = view[t + UP];
    const prev = tracks.get(id);
    if (!prev) { tracks.set(id, { x, y, z, up, vy: 0, last: 0 }); continue; }

    const vy = up - prev.up;
    const speed = Math.hypot(x - prev.x, y - prev.y, z - prev.z);

    // Calibrate off the motion itself, before any threshold is applied.
    if (-vy > peakFall && -vy < 1e4) { peakFall = -vy; stats.peakFall = peakFall; }
    const floor = peakFall * FLOOR_FRAC;
    const ref = peakFall * REF_FRAC;

    // A die being respawned somewhere else reads as one enormous step. Decide
    // that BEFORE touching the calibration, or the jump sets the very peak
    // every later frame is measured against and the bed stays inaudible for
    // the rest of the roll.
    const teleport = peakSpeed > 0 && speed > peakSpeed * TELEPORT_FRAC;
    if (!teleport && speed > peakSpeed && speed < 1e4) { peakSpeed = speed; stats.peakSpeed = peakSpeed; }

    // A die at reference speed contributes 1. Summing means a fistful of dice
    // is louder than a lone d20, which is right; the sqrt below keeps that
    // from running away once there are a dozen of them.
    const refSpeed = peakSpeed * ROLL_REF;
    if (!teleport && refSpeed > 0) energy += Math.min(1, speed / refSpeed);

    if (Math.abs(vy) > peakFall * TELEPORT_FRAC) {
      prev.x = x; prev.y = y; prev.z = z; prev.up = up; prev.vy = 0; continue;
    }

    // Falling last frame, no longer falling this frame = it hit something.
    const landed = floor > 0 && prev.vy < -floor && vy > prev.vy * 0.35;
    if (landed && now - prev.last > COOLDOWN_MS) {
      stats.impacts++;
      if (Rattle.debug) console.log("[rattle] impact", (-prev.vy).toFixed(5), "of peak", peakFall.toFixed(5));
      strike(ref > 0 ? -prev.vy / ref : 1);
      prev.last = now;
    }
    prev.x = x; prev.y = y; prev.z = z; prev.up = up;
    prev.vy = vy;
  }

  const drive = Math.min(1, Math.sqrt(energy / ROLL_SPREAD));
  stats.roll = drive;
  bedLevel(drive);

  // The worker stops posting once every die is asleep, so the last frame seen
  // would otherwise leave the bed holding whatever gain it had. Close it out.
  clearTimeout(bedIdle);
  bedIdle = setTimeout(() => { stats.roll = 0; bedStop(); }, ROLL_IDLE_MS);
}

export const Rattle = {
  debug: false,

  // --- diagnosis -------------------------------------------------------
  // Rattle.stats after a roll. Read the zeros left to right:
  //   frames 0   -> the patch never ran (install failed, or a different world
  //                 module is in use — check the console for a warning)
  //   dice 0     -> patched, but no dice in the buffer
  //   peakFall 0 -> dice move, but not on axis UP. Try Rattle.axis(1|2|3)
  //   impacts 0  -> motion seen but no landings detected
  //   roll 0     -> mid-roll, the rolling bed is not tracking (check peakSpeed)
  //   blocked >0 -> impacts fired but audio is suspended; click the page
  get stats() { return { ...stats, installed, enabled, axis: UP }; },

  // Play one hit at full volume. Separates "audio is broken" from
  // "detection is broken" in a single call.
  test() { this.unlock(); strike(1); return this.stats; },

  // How loud the rolling bed gets at full speed, 0..1. The strikes sit on top
  // of it, so this wants to stay well under them — set 0 for strikes only.
  // Tune it by ear from the console mid-roll; it takes effect on the next frame.
  get rollLevel() { return ROLL_LEVEL; },
  set rollLevel(value) { ROLL_LEVEL = Math.max(0, Math.min(1, value)); },

  // If dice move but peakFall stays 0, the vertical axis is not where we
  // think. 1=x, 2=y, 3=z. Resets calibration so the next roll re-seats it.
  axis(index) { UP = index; peakFall = 0; tracks.clear(); return this.stats; },

  get enabled() { return enabled; },
  set enabled(value) {
    enabled = value;
    // Strikes are one-shots and stop on their own; the bed is a sustained
    // loop, so muting mid-roll has to actually tear it down.
    if (!value) bedStop();
    localStorage.setItem("rattle", value ? "on" : "off");
  },

  // Autoplay policy: the context can only start inside a user gesture.
  unlock() { const c = boot(); if (c && c.state === "suspended") c.resume(); },

  // Patch the world module. Must run before any DiceBox is constructed.
  // Safe to call more than once; only the first call patches.
  async install() {
    if (installed) return true;
    try {
      const World = (await import("./world.onscreen.min.js")).default;
      const original = World.prototype.updatesFromPhysics;
      World.prototype.updatesFromPhysics = function (buffer) {
        try { read(new Float32Array(buffer)); } catch { /* never break the render */ }
        return original.call(this, buffer);
      };
      installed = true;
      document.addEventListener("pointerdown", () => Rattle.unlock(), { once: true });
      return true;
    } catch (error) {
      console.warn("Dice sound unavailable:", error);
      return false;
    }
  },

  // Wire up a toggle button: paints itself and persists across reloads.
  bindToggle(button, { on = "🔊 Rattle", off = "🔇 Rattle" } = {}) {
    if (!button) return;
    const paint = () => {
      button.classList.toggle("on", enabled);
      button.setAttribute("aria-pressed", String(enabled));
      button.textContent = enabled ? on : off;
    };
    button.addEventListener("click", () => {
      Rattle.unlock();
      Rattle.enabled = !enabled;
      paint();
    });
    paint();
  },
};

// Reachable from the console for diagnosis: Rattle.stats / .test() / .axis(n)
if (typeof window !== "undefined") window.Rattle = Rattle;

export default Rattle;
