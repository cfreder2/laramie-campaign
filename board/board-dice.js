import DiceBox from "../dice/dice-box.es.min.js";
import { Rattle } from "../dice/rattle.js";

// The sound of the dice: a tumble that fades as they slow, and a crack each
// time one strikes the table. Patches the physics world module, so it has to
// land before the DiceBox below is constructed — see dice/rattle.js.
await Rattle.install();

const $ = (selector) => document.querySelector(selector);
const launcher = $("#dice-launcher");
const stage = $("#dice-stage");
const tray = $("#board-dice-tray");
const resultStack = $("#dice-results");
const fab = $("#dice-fab");
const loading = $("#dice-loading");
const readout = $("#dice-readout");
const total = $("#dice-total");
const breakdown = $("#dice-breakdown");
const rollButton = $("#dice-roll");
const clearButton = $("#dice-clear");
const modifierOutput = $("#dice-modifier");
const history = $("#dice-history");
const historyLink = $("#dice-history-link");
const drawer = $("#dice-drawer");
const drawerClose = $("#dice-drawer-close");
const dieButtons = [...document.querySelectorAll("#board-dice-bar [data-sides]")];
const diceBar = $("#board-dice-bar");
const allowedSides = [4, 6, 8, 10, 12, 20, 100];
const pool = Object.fromEntries(allowedSides.map((sides) => [sides, 0]));
const poolMode = Object.fromEntries(allowedSides.map((sides) => [sides, "normal"]));
let modifier = 0;
let ready = false;

// Give each die its own Advantage (A) / Disadvantage (D) chip — they surface in
// the die's corners once it's in the pool. Advantage rolls that die type twice
// and keeps the highest; disadvantage keeps the lowest.
for (const button of dieButtons) {
  for (const [mode, label, tip] of [
    ["advantage", "A", "Advantage — roll this die twice, keep the higher"],
    ["disadvantage", "D", "Disadvantage — roll this die twice, keep the lower"],
  ]) {
    const chip = document.createElement("span");
    chip.className = "die-mode"; chip.dataset.sides = button.dataset.sides; chip.dataset.mode = mode;
    chip.textContent = label; chip.title = tip;
    button.append(chip);
  }
}
let localOrigin = null;   // token of the roll THIS client physically rolled
let rolling = false;      // guard against overlapping physics rolls
let panelTimer = 0;
let stageTimer = 0;

const RESULT_LIFETIME = 15000;  // how long one roll's card stays up
const RESULT_MAX = 4;           // ...and how many can hold the corner at once
const RESULT_EXIT = 400;        // slightly past the CSS transition on .leaving

function setPanel(open) {
  launcher.dataset.open = String(open);
  fab.setAttribute("aria-expanded", String(open));
}

// The physical bones take the active theme's primary accent, read live so a
// mid-session theme change recolours the next roll.
function themeDieColor() {
  return getComputedStyle(document.body).getPropertyValue("--primary").trim() || "#7d2a1d";
}

function showStage(open) {
  clearTimeout(stageTimer);
  stage.classList.toggle("show", open);
  stage.setAttribute("aria-hidden", String(!open));
}

function refreshPool() {
  let count = 0;
  for (const button of dieButtons) {
    const sides = button.dataset.sides;
    const qty = pool[sides]; count += qty;
    button.classList.toggle("selected", qty > 0);
    button.querySelector("b").textContent = qty;
    for (const chip of button.querySelectorAll(".die-mode")) {
      chip.classList.toggle("active", qty > 0 && poolMode[sides] === chip.dataset.mode);
    }
  }
  rollButton.disabled = !ready || rolling || !count;
}

function setModifier(value) {
  modifier = Math.max(-20, Math.min(20, value));
  modifierOutput.textContent = `${modifier >= 0 ? "+" : ""}${modifier}`;
}

async function requestRoll(groups, options = {}) {
  if (!ready || rolling || !groups.length) return;
  rolling = true; refreshPool();
  const origin = crypto.randomUUID();
  const rollModifier = Number.isFinite(options.modifier) ? options.modifier : modifier;
  localOrigin = origin;
  // The physics roll is the source of truth. Roll the bones once and read the
  // faces they settle on. A die type with advantage/disadvantage rolls TWICE
  // (2× that die); app.js keeps the highest / lowest of it.
  clearTimeout(stageTimer); tray.classList.remove("faded"); box.clear();
  const physQty = (group) => (group.mode === "advantage" || group.mode === "disadvantage") ? group.qty * 2 : group.qty;
  let dice = null;
  try {
    const animated = await box.roll(groups.map((group) => ({ qty: physQty(group), sides: group.sides })), { themeColor: themeDieColor() });
    // box.roll resolves to a FLAT list of settled dice (in roll order), each with
    // its physical face on `.value`. (Some builds nest them under `.rolls`.)
    const faces = [];
    for (const item of (Array.isArray(animated) ? animated : [])) {
      if (item && Array.isArray(item.rolls)) for (const roll of item.rolls) faces.push(Number(roll?.value));
      else faces.push(Number(item?.value));
    }
    const flatSides = groups.flatMap((group) => Array.from({ length: physQty(group) }, () => group.sides));
    if (faces.length === flatSides.length
        && faces.every((value, index) => Number.isInteger(value) && value >= 1 && value <= flatSides[index])) {
      dice = flatSides.map((sides, index) => ({ sides, value: faces[index] }));
    }
  } catch (error) { console.error("Dice roll failed", error); }
  rolling = false; refreshPool();
  window.dispatchEvent(new CustomEvent("laramie:dice-request", { detail: { groups, modifier: rollModifier, dice, origin, roller: options.roller || undefined } }));
}

function groupsFromPool() {
  return allowedSides.filter((sides) => pool[sides]).map((sides) => ({ qty: pool[sides], sides, mode: poolMode[sides] }));
}

function clearPool() {
  for (const sides of allowedSides) { pool[sides] = 0; poolMode[sides] = "normal"; }
  readout.hidden = true; refreshPool();
}

function renderHistory(rolls = []) {
  history.replaceChildren();
  // The board retains thirty; the drawer is full-height, so show all of them
  // rather than a dozen with the rest of the panel standing empty.
  for (const roll of [...rolls].slice(-30).reverse()) {
    const item = document.createElement("li");
    const who = document.createElement("span"); who.textContent = roll.roller;
    const value = document.createElement("strong"); value.textContent = roll.total;
    const detail = document.createElement("small"); detail.textContent = `${roll.formula} · ${diceValues(roll)}`;
    item.append(who, value, detail); history.append(item);
  }
}

function diceValues(roll) {
  // dropped (not-kept) dice from an advantage/disadvantage pair show in parens
  return roll.dice.map((die) => die.kept === false ? `(${die.value})` : die.value).join(", ");
}

// The formula carries the mode as " adv"/" dis" for the history list; the result
// popup lifts it onto its own badge, which reads at a glance. A roll can carry
// both, since advantage is set per die type.
function plainFormula(formula) {
  return String(formula || "").replace(/ (?:adv|dis)\b/g, "");
}

function rollModeTags(roll) {
  const modes = new Set((roll.groups || []).map((group) => group.mode));
  return ["advantage", "disadvantage"].filter((mode) => modes.has(mode)).map((mode) => {
    const tag = document.createElement("b");
    tag.className = "roll-mode-tag"; tag.dataset.mode = mode;
    tag.textContent = mode === "advantage" ? "Advantage" : "Disadvantage";
    return tag;
  });
}

// A card's height plus the gap above it: what the stack grows by when the card
// arrives, and shrinks by when it goes.
function stackStep(card) {
  return card.offsetHeight + (parseFloat(getComputedStyle(resultStack).rowGap) || 0);
}

// The cards still counting down. A card on its way out is left in the DOM for
// the length of its fade, and must not be counted or retired twice.
function liveResults() {
  return [...resultStack.children].filter((card) => !card.classList.contains("leaving"));
}

const stillMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

function retireResult(card) {
  if (!card || card.classList.contains("leaving")) return;
  clearTimeout(card.retireTimer);
  // Pull the card's own height back out of the flow so the stack closes up
  // behind it. Under reduced motion the layout just snaps and the card fades.
  if (!stillMotion.matches) card.style.marginTop = `-${stackStep(card)}px`;
  card.classList.remove("show"); card.classList.add("leaving");
  window.setTimeout(() => card.remove(), RESULT_EXIT);
}

// Every roll gets its own card. The stack is anchored to the bottom corner, so
// appending puts the newest roll nearest the corner and lifts the ones before
// it — the number you just rolled is always the one at the bottom.
function showRollResult(roll) {
  const card = document.createElement("div");
  card.className = "dice-result";
  const total = document.createElement("strong");
  total.textContent = roll.total;
  const detail = document.createElement("span");
  detail.replaceChildren(
    document.createTextNode(`${roll.roller} · ${plainFormula(roll.formula)} · [${diceValues(roll)}]`),
    ...rollModeTags(roll)
  );
  card.append(total, detail);
  resultStack.append(card);

  if (!stillMotion.matches) {
    // Start with the card's height held out of the flow, so the older cards are
    // still where they were, then ease it back in: they travel up rather than
    // jumping. The start has to land with the transition off and be committed —
    // that is what reading offsetHeight does — or the browser animates its way
    // into the collapsed state and there is nothing left to push with.
    card.style.transition = "none";
    card.style.marginTop = `-${stackStep(card)}px`;
    void card.offsetHeight;
  }
  requestAnimationFrame(() => {
    card.style.transition = "";
    card.style.marginTop = "0px";
    card.classList.add("show");
  });

  card.retireTimer = window.setTimeout(() => retireResult(card), RESULT_LIFETIME);
  // A busy round can outrun the countdown; the oldest gives up the corner early.
  for (const old of liveResults().slice(0, -RESULT_MAX)) retireResult(old);
}

function fadeTrayLater() {
  clearTimeout(stageTimer);
  stageTimer = window.setTimeout(() => {
    tray.classList.add("faded");
    window.setTimeout(() => { try { box.clear(); } catch (error) {} tray.classList.remove("faded"); }, 550);
  }, 5000);
}

function animateSharedRoll(roll) {
  if (roll.origin && roll.origin === localOrigin) {
    // Our own roll: the dice are already settled on the tray showing the real
    // faces, and roll.total was computed from those faces — just reveal the popup.
    localOrigin = null;
    showRollResult(roll);
    fadeTrayLater();
    return;
  }
  // Someone else's roll: we don't have their physical dice, so present the shared
  // numbers without a 3D re-roll that would land on different (contradicting) faces.
  showRollResult(roll);
}

fab.addEventListener("click", (event) => { event.stopPropagation(); setPanel(launcher.dataset.open !== "true"); });
document.addEventListener("click", (event) => {
  if (!launcher.contains(event.target)) setPanel(false);
  if (!drawer.contains(event.target) && !historyLink.contains(event.target)) drawer.classList.remove("open");
});
historyLink.addEventListener("click", (event) => { event.stopPropagation(); drawer.classList.add("open"); drawer.setAttribute("aria-hidden", "false"); });
drawerClose.addEventListener("click", () => { drawer.classList.remove("open"); drawer.setAttribute("aria-hidden", "true"); });
diceBar.addEventListener("click", (event) => {
  const chip = event.target.closest(".die-mode");
  if (chip) {
    const sides = chip.dataset.sides;
    if (!pool[sides]) return;                       // A/D only matters once the die is in the pool
    poolMode[sides] = poolMode[sides] === chip.dataset.mode ? "normal" : chip.dataset.mode;  // click again to clear
    refreshPool();
    return;
  }
  const die = event.target.closest(".die-btn");
  if (die) { pool[die.dataset.sides] = Math.min(20, pool[die.dataset.sides] + 1); refreshPool(); }
});
diceBar.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  const die = event.target.closest(".die-btn"); if (!die) return;
  const sides = die.dataset.sides;
  pool[sides] = Math.max(0, pool[sides] - 1);
  if (!pool[sides]) poolMode[sides] = "normal";
  refreshPool();
});
$("#dice-mod-up").addEventListener("click", () => setModifier(modifier + 1));
$("#dice-mod-down").addEventListener("click", () => setModifier(modifier - 1));
rollButton.addEventListener("click", () => requestRoll(groupsFromPool()));
clearButton.addEventListener("click", () => { clearPool(); box.clear(); });
Rattle.bindToggle($("#dice-rattle"));
window.addEventListener("laramie:dice-history", (event) => renderHistory(event.detail));
window.addEventListener("laramie:dice-broadcast", (event) => animateSharedRoll(event.detail));
// Character-sheet rollables route through the same physics roll so they animate
// on the tray and their number matches the settled dice.
window.addEventListener("laramie:dice-roll", (event) => {
  const detail = event.detail || {};
  requestRoll(detail.groups || [], { modifier: detail.modifier, roller: detail.roller });
});

const assetPath = new URL("../dice/assets/", document.baseURI).pathname;
const box = new DiceBox({
  container: "#board-dice-tray", assetPath, origin: window.location.origin,
  theme: "default", themeColor: themeDieColor(), scale: 5, offscreen: false,
  enableShadows: true, shadowTransparency: 0.7, lightIntensity: 1.1, gravity: 1.6
});

box.init().then(() => {
  ready = true; loading.classList.add("ready"); refreshPool();
}).catch((error) => {
  loading.textContent = `The bones got stuck in the mud. (${error.message})`;
  console.error(error);
});

window.dispatchEvent(new CustomEvent("laramie:dice-ready"));
