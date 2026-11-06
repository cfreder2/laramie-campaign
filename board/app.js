(() => {
  "use strict";

  const HOST_STATE_KEY = "laramie-board-host-v1";
  const VIEW_STATE_KEY = "laramie-board-view-v1";
  // Bumped whenever the shared snapshot changes shape. A stored board from an
  // older version is discarded rather than merged — loadJson is a shallow
  // spread, so a stale `layers` array would otherwise survive into the new model
  // and point at files that have since moved.
  const STATE_VERSION = 7;
  const DEFAULT_STATE = {
    schemaVersion: STATE_VERSION,
    revision: 0,
    // What the table is showing. Everything here arrives from docs/campaigns —
    // there are no maps, seats, or encounters compiled into this file.
    campaignId: "",
    campaignName: "",
    encounter: null,
    place: null,
    activeLayer: "",
    layers: [],
    // Geometry only, and DM-only: every token position is expressed in these
    // squares, so it has to be identical for everyone. Appearance (visible,
    // colour, strength) is per-viewer and lives in `view.grid`.
    grid: { size: 32, offsetX: 0, offsetY: 0 },
    actors: [],
    affiliations: [],
    effects: [],
    rolls: [],
    // Darkness, and what pushes it back. `fogEnabled` used to sit here as a
    // reserved flag nothing read; this is that slot, filled in.
    //
    // `mode` is the escape hatch and matters more than any of the rest:
    //   dynamic  — computed from lights, darkvision, and walls
    //   revealed — off, and off on the proven code path: the host sends the
    //              same object it always sent and nothing draws. One click when
    //              a session is going sideways.
    //   hidden   — every seat is blind. The lights just went out. Reversible;
    //              it does not clear what the party has already explored.
    //
    // `explored` is the party's memory and is deliberately synced and saved —
    // it has to survive a reload and a week between sessions.
    fog: {
      enabled: false,
      mode: "dynamic",
      ambient: {},
      reveals: [],
      explored: {}
    },
    // A light is not an actor: you cannot select it, damage it, rotate it, or
    // put it in a chest. But a *dropped lantern* is an actor, so a light with
    // an `actorId` reads its position through that actor and never copies it —
    // which is why carrying one needs no changes to `moveActor` at all.
    lights: []
  };

  // Up here with DEFAULT_STATE rather than beside normalizeFog, because
  // migrateBoardState() is CALLED before that point in the file and a `const`
  // is in the temporal dead zone until its own line runs — declared lower down,
  // these threw ReferenceError on load with nothing to show for it at parse time.
  const FOG_MODES = new Set(["dynamic", "revealed", "hidden"]);
  const AMBIENT_BANDS = new Set(["bright", "dim", "dark"]);

  const $ = (selector) => document.querySelector(selector);
  const ui = {
    lobby: $("#lobby-panel"), controls: $("#board-controls"),
    navRail: $("#nav-rail"), railToggle: $("#rail-toggle"),
    hostLobby: $("#host-lobby"), playerLobby: $("#player-lobby"),
    chooseHost: $("#choose-host"), choosePlayer: $("#choose-player"),
    addSeat: $("#add-seat-button"), seatList: $("#seat-list"),
    playerName: $("#player-name"), offerInput: $("#offer-input"), makeAnswer: $("#make-answer-button"),
    answerBlock: $("#answer-block"), answerOutput: $("#answer-output"), copyAnswer: $("#copy-answer-button"),
    roleHeading: $("#role-heading"), roleEyebrow: $("#role-eyebrow"),
    previewButton: $("#player-preview-button"), previewBar: $("#player-preview-bar"), exitPreview: $("#exit-player-preview"),
    campaignName: $("#campaign-name"), encounterName: $("#encounter-name"),
    seatChips: $("#seat-chips"), saveBoard: $("#save-board"),
    whoButton: $("#who-button"), whoRole: $("#who-role"), whoName: $("#who-name"),
    whoDropdown: $("#who-dropdown"), whoNameInput: $("#who-name-input"),
    menuLoadEncounter: $("#menu-load-encounter"), menuDisplay: $("#menu-display"), menuSeats: $("#menu-seats"),
    displayDialog: $("#display-dialog"), closeDisplay: $("#close-display"), themeSelect: $("#theme-select"),
    nowPlaying: $("#now-playing"), nowPlayingTitle: $("#now-playing-title"), nowPlayingPlace: $("#now-playing-place"),
    nowPlayingStatus: $("#now-playing-status"), nowPlayingCounts: $("#now-playing-counts"),
    openEncounters: $("#open-encounters"), placeList: $("#place-list"), layerHint: $("#layer-hint"),
    showLobby: $("#show-lobby-button"), connectedList: $("#connected-list"), layerSwitch: $("#layer-switch"),
    pinTable: $("#pin-table"), exitSection: $("#exit-section"), exitList: $("#exit-list"), exitHint: $("#exit-hint"),
    addExit: $("#add-exit"), addExitHint: $("#add-exit-hint"),
    exitDialog: $("#exit-dialog"), closeExitDialog: $("#close-exit-dialog"), saveExit: $("#save-exit"),
    exitDialogFrom: $("#exit-dialog-from"), exitDialogTo: $("#exit-dialog-to"),
    exitFromLabel: $("#exit-from-label"), exitToLabel: $("#exit-to-label"),
    gridGeometry: $("#grid-geometry"),
    gridColumns: $("#grid-columns"), gridColumnsOutput: $("#grid-columns-output"),
    gridRows: $("#grid-rows"), gridRowsOutput: $("#grid-rows-output"),
    gridSize: $("#grid-size"), gridSizeOutput: $("#grid-size-output"),
    gridFeet: $("#grid-feet"), gridFeetOutput: $("#grid-feet-output"),
    gridX: $("#grid-x"), gridXOutput: $("#grid-x-output"), gridY: $("#grid-y"), gridYOutput: $("#grid-y-output"),
    gridVisible: $("#grid-visible"), gridColor: $("#grid-color"),
    gridStrength: $("#grid-strength"), gridStrengthOutput: $("#grid-strength-output"), gridReset: $("#grid-reset"),
    flatMinis: $("#flat-minis"), itemGlow: $("#item-glow"),
    encounterBrowser: $("#encounter-browser"), closeEncounterBrowser: $("#close-encounter-browser"), encounterGrid: $("#encounter-grid"),
    assetLibrary: $("#asset-library"), librarySearch: $("#library-search"),
    brushMove: $("#brush-move"), brushFlame: $("#brush-flame"), brushExtinguish: $("#brush-extinguish"), clearEffects: $("#clear-effects"), effectsLayer: $("#effects-layer"),
    fogEnabled: $("#fog-enabled"), fogMode: $("#fog-mode"), fogAmbient: $("#fog-ambient"), fogModeRow: $("#fog-mode-row"),
    brushLight: $("#brush-light"), lightKind: $("#light-kind"),
    effectType: $("#effect-type"), areaShape: $("#area-shape"), areaRadius: $("#area-radius"), playerActorList: $("#player-actor-list"),
    // Everything writable about one actor. It lives in the sheet on the right,
    // not the sidebar: the pane already showing the piece is the pane that edits it.
    actorManageSection: $("#actor-manage-section"),
    manageHpCurrent: $("#manage-hp-current"), manageHpMax: $("#manage-hp-max"),
    manageHpCurrentField: $("#manage-hp-current-field"), manageHpMaxField: $("#manage-hp-max-field"),
    manageAc: $("#manage-ac"), manageAcField: $("#manage-ac-field"),
    manageThreshold: $("#manage-threshold"), manageThresholdField: $("#manage-threshold-field"),
    manageIndestructible: $("#manage-indestructible"), manageIndestructibleField: $("#manage-indestructible-field"),
    manageController: $("#manage-controller"), manageControllerField: $("#manage-controller-field"),
    manageRotation: $("#manage-rotation"), manageRotationField: $("#manage-rotation-field"),
    manageSize: $("#manage-size"), manageSizeField: $("#manage-size-field"),
    manageInventory: $("#manage-inventory"), manageInventoryField: $("#manage-inventory-field"),
    manageNotes: $("#manage-notes"),
    manageDamageRow: $("#manage-damage-row"), manageDamageAmount: $("#manage-damage-amount"),
    manageApplyDamage: $("#manage-apply-damage"), manageDestroy: $("#manage-destroy"), manageRemove: $("#manage-remove"),
    viewport: $("#board-viewport"), surface: $("#board-surface"), image: $("#map-image"), overlay: $("#map-overlay"), canvas: $("#grid-canvas"), fogCanvas: $("#fog-canvas"),
    tokensLayer: $("#tokens-layer"), selectionBox: $("#actor-selection-box"), actorTooltip: $("#actor-tooltip"), emptyBoard: $("#empty-board"), zoomReadout: $("#zoom-readout"),
    fit: $("#fit-button"),
    help: $("#help-button"), helpDialog: $("#help-dialog"), closeHelp: $("#close-help"), toast: $("#toast"),
    actorSheet: $("#actor-sheet"), closeSheet: $("#close-actor-sheet"), actorKind: $("#actor-kind"), actorTitle: $("#actor-title"), actorMeta: $("#actor-meta"),
    actorPortrait: $("#actor-portrait"), actorPortraitButton: $("#actor-portrait-button"),
    actorHp: $("#actor-hp"), actorAc: $("#actor-ac"), actorSpeed: $("#actor-speed"), actorSpace: $("#actor-space"),
    actorThreshold: $("#actor-threshold"), actorRules: $("#actor-rules"),
    vitalHp: $("#vital-hp"), vitalAc: $("#vital-ac"), vitalSpeed: $("#vital-speed"), vitalThreshold: $("#vital-threshold"),
    actorRulesSection: $("#actor-rules-section"), actorAttacks: $("#actor-attacks"), actorAttacksSection: $("#actor-attacks-section"),
    actorAbilities: $("#actor-abilities"), actorAbilitiesSection: $("#actor-abilities-section"), actorHealthAccess: $("#actor-health-access"),
    actorItem: $("#actor-item"), actorItemSection: $("#actor-item-section"), itemControls: $("#item-controls"),
    itemContents: $("#item-contents"), itemContentsList: $("#item-contents-list"),
    actorDossier: $("#actor-dossier"), actorDossierSection: $("#actor-dossier-section"),
    actorGallery: $("#actor-gallery"), actorGallerySection: $("#actor-gallery-section"),
    actorFactList: $("#actor-fact-list"), actorFactEmpty: $("#actor-fact-empty"),
    factComposer: $("#fact-composer"), factText: $("#fact-text"),
    hpStepper: $("#hp-stepper"), actorHpVisibility: $("#actor-hp-visibility"), sheetKeyboard: $("#sheet-keyboard"),
    affiliationChip: $("#affiliation-chip"), affiliationField: $("#affiliation-field"), actorAffiliation: $("#actor-affiliation"),
    affiliationList: $("#affiliation-list"), affiliationAdd: $("#affiliation-add"), affiliationName: $("#affiliation-name"),
    addAffiliation: $("#add-affiliation"), affiliationHint: $("#affiliation-hint"),
    portraitDialog: $("#portrait-dialog"), portraitLarge: $("#portrait-large"), portraitCaption: $("#portrait-caption"), portraitStrip: $("#portrait-strip"), closePortrait: $("#close-portrait"),
    decreaseHp: $("#decrease-hp"), increaseHp: $("#increase-hp"),
    rollAnnouncement: $("#roll-announcement"), rollRoller: $("#roll-roller"), rollTotal: $("#roll-total"), rollDetail: $("#roll-detail")
  };

  let role = location.hash.startsWith("#/join") ? "player" : "host";
  // A DM-side rehearsal of the player's screen. It is deliberately local: the
  // connection, the authority over board state, and every broadcast stay exactly
  // where they were, so a table mid-session never notices the DM looking.
  let previewAsPlayer = false;
  let boardState = loadJson(HOST_STATE_KEY, DEFAULT_STATE);
  // Local to this browser and never broadcast: pan, zoom, personal grid
  // appearance, and which nav sections are open.
  let view = loadJson(VIEW_STATE_KEY, {
    x: 0, y: 0, scale: 1,
    grid: { visible: true, color: "#d8bd83", strength: 42, userSet: false },
    flatMinis: false,
    itemGlow: true,
    // The sidebar collapsed to its icon rail, and the packs pinned to the top of
    // their shelves. Both are this browser's business and neither is broadcast.
    railOnly: false,
    pinned: [],
    sections: {},
    // How this screen draws the darkness, never what it is allowed to see.
    // `dmStrength` in particular must never go on the wire: it is the DM's own
    // "let me see through it" knob, and broadcasting it would hand every player
    // a dimmer switch for their own fog.
    fog: { dmStrength: 34, softEdges: true, showLightRings: true, previewSeatId: "" }
  });
  let campaign = null;
  let placeIndex = [];
  let encounterIndex = [];
  let currentPlace = null;
  // The encounter object as loaded, not the trimmed copy in `boardState`. Kept
  // so that re-reading a place after the DM edits an exit can put the scene's
  // own overrides back on top without rebuilding the cast from the file and
  // throwing away where everyone is standing.
  let currentEncounter = null;
  // What the player's last frame was showing, so a DM-driven scene change can
  // refit the map instead of stranding them at the old pan and zoom.
  let lastSceneKey = "";
  let mapSize = { width: 0, height: 0 };
  // A player's fog, kept OUT of boardState on purpose: handlePlayerMessage
  // replaces boardState wholesale, and the host only resends the bands when
  // they change, so a mask parked on the snapshot would be wiped by the next
  // HP tick. Null means draw no fog, so a client on an older build talking to
  // a newer host degrades to the board it has always seen — never a black screen.
  let remoteFog = null;
  let playerPeer = null;
  let playerChannel = null;
  let playerSeatId = "";
  let seatCounter = 0;
  const seats = new Map();
  let toastTimer = 0;
  let initialFitDone = false;
  let selectedActorId = "";
  const selectedActorIds = new Set();
  // Where the library's spotlight walk currently stands: the card being clicked
  // and the instance it last landed on.
  let libraryCycle = { assetId: "", actorId: "" };
  let libraryClickTimer = 0;
  let brushMode = "move";
  let actorLibrary = new Map();
  let draftRegion = null;   // effect patch being painted (pointer down → up)
  let hoverCell = null;     // grid cell under the flame cursor (radius preview)
  let hoverRegionId = "";    // effect patch under the extinguish cursor
  let effectsRaf = 0;
  let spacePressed = false;
  let lastActorTap = { id: "", time: 0 };
  let sheetActorId = "";
  // The stand-in instance behind a library pack's sheet. It is never added to
  // `boardState`, so it exists only for as long as that sheet is open.
  let previewActor = null;
  let rollsInitialized = false;
  let lastAnnouncedRollId = "";
  let rollAnnouncementTimer = 0;

  // Everything on the table is an actor; `kind` only decides which roster it files
  // under and whether the party may read its health. There is no `vehicle`:
  // anything can carry a person — a horse, a raft, a wagon bed — so the kind
  // never told the board a thing it could act on. A cart is a prop you can load,
  // which its `container:` block says outright.
  const ACTOR_GROUPS = [
    { id: "party", label: "The party", kinds: ["player_character"] },
    { id: "npcs", label: "Non-player characters", kinds: ["npc", "creature"] },
    { id: "items", label: "Items & props", kinds: ["item", "prop"] }
  ];
  const GROUP_OF_KIND = new Map(ACTOR_GROUPS.flatMap((group) => group.kinds.map((kind) => [kind, group.id])));
  const ROSTERS = new Set(ACTOR_GROUPS.map((group) => group.id));

  // The library's shelves. `kind` says what a thing IS; a shelf is where a DM
  // goes looking for it mid-scene, which is not the same question — the answer
  // to "I need to arm someone" is a shelf, and `kind: item` holds revolvers and
  // barrels alike. Objects declare `category:` in their pack; people are shelved
  // by what they are, and NPCs are subdivided by affiliation rather than by any
  // second taxonomy, because the campaign already answers "whose side are you
  // on" and the board already paints every token by it.
  const ITEM_SHELVES = [
    { id: "weapon", label: "Weapons" },
    { id: "explosive", label: "Explosives" },
    { id: "gear", label: "Gear" },
    { id: "scenery", label: "Scenery" },
    { id: "other", label: "Other" }
  ];
  const ITEM_CATEGORIES = new Set(ITEM_SHELVES.map((shelf) => shelf.id));

  function categoryOf(definition) {
    const declared = String(definition?.category || "");
    return ITEM_CATEGORIES.has(declared) && declared !== "other" ? declared : "other";
  }

  // Primary affiliation paints the token's outline. A western palette, picked so the
  // colours stay apart from each other and off the dusty browns of the maps. Bone is
  // the "we don't know yet" state and is what an unassigned actor wears.
  const UNKNOWN_OUTLINE = "#f4efe3";
  const AFFILIATION_PALETTE = [
    { label: "Bone", hex: UNKNOWN_OUTLINE },
    { label: "Blood Red", hex: "#c0392b" },
    { label: "Boiler Rust", hex: "#cf7326" },
    { label: "Assay Gold", hex: "#e3b23c" },
    { label: "Prairie Sage", hex: "#9cb45f" },
    { label: "Bottle Green", hex: "#3f9160" },
    { label: "Turquoise", hex: "#2fb3ad" },
    { label: "Cavalry Blue", hex: "#4b86c8" },
    { label: "Vestment Indigo", hex: "#8069cf" },
    { label: "Wine Plum", hex: "#b4568f" },
    { label: "Gun Smoke", hex: "#9aa3ab" }
  ];

  // Everything a player may not do. `role` stays "host"/"player" internally and
  // on the wire; only the visible label says Dungeon Master. This set is the one
  // place the boundary is stated — the nav renders from it, and the host-side
  // intent handlers are what actually enforce it.
  // Content is created with the DND CLI and committed to docs/campaigns — the
  // board only ever loads and displays it. There is no authoring capability
  // here for either role, so none appears in this set.
  const DM_ONLY = new Set([
    "loadEncounter", "editPlace", "gridGeometry", "layerSwitch",
    "actorLibrary", "affiliations", "effects", "damage", "seats", "editAnyActor"
  ]);

  // The seam the player preview turns on. `role` answers "who is this browser on
  // the wire" and never moves; `isDM()` answers "what may this screen show", and
  // that is the only one the preview flips. Every reveal — facts, hit points,
  // dossier lines, DM panels — asks isDM(); saving, broadcasting, and answering
  // player intents ask `role`.
  function isDM() {
    return role === "host" && !previewAsPlayer;
  }

  function can(action) {
    return isDM() || !DM_ONLY.has(action);
  }

  // A fact is public (the table knows it), staged (host-only, queued for a reveal),
  // or secret (host eyes only).
  const FACT_VISIBILITY = ["public", "staged", "secret"];
  const FACT_LABELS = { public: "Known to the table", staged: "Held back", secret: "DM only" };
  const FACT_SHORT = { public: "Table", staged: "Held", secret: "DM" };

  // Firefox only grew plaintext-only editing recently; fall back to rich editing
  // plus a paste filter so a pasted name can never smuggle markup into the sheet.
  const EDITABLE_MODE = (() => {
    const probe = document.createElement("div");
    try { probe.contentEditable = "plaintext-only"; return probe.contentEditable === "plaintext-only" ? "plaintext-only" : "true"; }
    catch { return "true"; }
  })();

  migrateBoardState();
  view.grid = normalizeGridView(view.grid);
  view.fog = normalizeFogView(view.fog);
  view.sections = view.sections && typeof view.sections === "object" ? view.sections : {};

  function migrateBoardState() {
    // Before v7 the board carried hardcoded Bucket of Blood layers and a grid
    // that mixed geometry with appearance. Those boards cannot be mapped onto a
    // campaign, and their map paths no longer exist, so start clean.
    if (Number(boardState.schemaVersion) !== STATE_VERSION) boardState = structuredClone(DEFAULT_STATE);
    boardState.actors = Array.isArray(boardState.actors) ? boardState.actors : [];
    boardState.layers = Array.isArray(boardState.layers) ? boardState.layers : [];
    boardState.effects = normalizeEffects(boardState.effects);
    boardState.rolls = Array.isArray(boardState.rolls) ? boardState.rolls.slice(-30) : [];
    boardState.grid = normalizeGridGeometry(boardState.grid);
    for (const actor of boardState.actors) {
      actor.facts = normalizeFacts(actor.facts);
      if (typeof actor.hpVisible !== "boolean") actor.hpVisible = true;
    }
    // `affiliation` is deliberately left undefined here: reconcileActorDefinitions
    // seeds it from the pack once the library is loaded, and only once.
    boardState.affiliations = normalizeAffiliations(boardState.affiliations);
    // Additive, so STATE_VERSION deliberately does not move for these. A bump
    // throws the whole board away three lines up, and a DM who opens a new
    // build mid-session should not lose the scene they have set up.
    boardState.fog = normalizeFog(boardState.fog, boardState.fogEnabled);
    boardState.lights = normalizeLights(boardState.lights);
    delete boardState.fogEnabled;
    boardState.schemaVersion = STATE_VERSION;
  }


  function normalizeFog(raw, legacyEnabled) {
    const fog = raw && typeof raw === "object" ? raw : {};
    const ambient = {};
    if (fog.ambient && typeof fog.ambient === "object") {
      for (const [layerId, band] of Object.entries(fog.ambient)) {
        if (AMBIENT_BANDS.has(band)) ambient[String(layerId)] = band;
      }
    }
    const explored = {};
    if (fog.explored && typeof fog.explored === "object") {
      for (const [layerId, seats] of Object.entries(fog.explored)) {
        if (!seats || typeof seats !== "object") continue;
        const kept = {};
        for (const [seatId, packed] of Object.entries(seats)) {
          if (typeof packed === "string" && packed) kept[String(seatId)] = packed;
        }
        if (Object.keys(kept).length) explored[String(layerId)] = kept;
      }
    }
    return {
      // `fogEnabled` was the reserved flag. If some old board carries it true,
      // honour it rather than quietly turning the feature off under someone.
      enabled: typeof fog.enabled === "boolean" ? fog.enabled : Boolean(legacyEnabled),
      mode: FOG_MODES.has(fog.mode) ? fog.mode : "dynamic",
      ambient,
      // Same shape as boardState.effects on purpose — traceLoops, loopsPath,
      // effectSvg and the whole brush draft path then apply unchanged.
      reveals: Array.isArray(fog.reveals) ? fog.reveals.filter((region) =>
        region && typeof region === "object" && Array.isArray(region.cells) && region.cells.length
      ).map((region) => ({
        id: region.id || crypto.randomUUID(),
        layerId: String(region.layerId || ""),
        mode: region.mode === "conceal" ? "conceal" : "reveal",
        cells: region.cells
          .filter((cell) => Number.isFinite(Number(cell?.x)) && Number.isFinite(Number(cell?.y)))
          .map((cell) => ({ x: Math.max(0, Math.round(Number(cell.x))), y: Math.max(0, Math.round(Number(cell.y))) }))
      })).filter((region) => region.cells.length) : [],
      explored
    };
  }

  function normalizeLights(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter((light) => light && typeof light === "object").map((light) => ({
      id: light.id || crypto.randomUUID(),
      layerId: String(light.layerId || ""),
      // Non-empty means the light is carried: position is read through that
      // actor at use time and never stored here, so it cannot go stale.
      actorId: String(light.actorId || ""),
      x: Math.max(0, Math.round(Number(light.x) || 0)),
      y: Math.max(0, Math.round(Number(light.y) || 0)),
      brightFt: Math.max(0, Number(light.brightFt) || 0),
      dimFt: Math.max(0, Number(light.dimFt) || 0),
      color: typeof light.color === "string" && light.color ? light.color : "#ffb761",
      on: light.on !== false,
      name: String(light.name || "Light")
    }));
  }

  // Shared, DM-only. Appearance never appears here — see normalizeGridView.
  function normalizeGridGeometry(raw) {
    const grid = raw && typeof raw === "object" ? raw : {};
    return {
      size: Number(grid.size) > 0 ? Math.round(Number(grid.size)) : 32,
      offsetX: Math.round(Number(grid.offsetX) || 0),
      offsetY: Math.round(Number(grid.offsetY) || 0)
    };
  }

  // Local to this browser. `userSet` is the latch: until someone moves one of
  // these controls, the campaign's defaults keep seeding them.
  function normalizeGridView(raw) {
    const grid = raw && typeof raw === "object" ? raw : {};
    return {
      visible: grid.visible !== false,
      color: /^#[0-9a-f]{6}$/i.test(grid.color) ? grid.color : "#d8bd83",
      strength: Number.isFinite(Number(grid.strength)) ? Math.max(0, Math.min(100, Math.round(Number(grid.strength)))) : 42,
      userSet: grid.userSet === true
    };
  }

  // Per-browser, like normalizeGridView above and for the same reason: these
  // decide how the darkness is drawn on this screen, never what it may show.
  function normalizeFogView(raw) {
    const fog = raw && typeof raw === "object" ? raw : {};
    return {
      dmStrength: Number.isFinite(Number(fog.dmStrength)) ? Math.max(0, Math.min(100, Math.round(Number(fog.dmStrength)))) : 34,
      softEdges: fog.softEdges !== false,
      showLightRings: fog.showLightRings !== false,
      previewSeatId: typeof fog.previewSeatId === "string" ? fog.previewSeatId : ""
    };
  }

  function normalizeAffiliations(raw) {
    // The campaign supplies the roster; until it has loaded there simply is no
    // roster, and the DM can still rename, recolour, add, or remove any of them.
    const list = Array.isArray(raw) && raw.length ? raw : structuredClone(campaign?.affiliations || []);
    const seen = new Set();
    return list
      .map((item) => ({
        id: String(item?.id || "").trim() || crypto.randomUUID(),
        label: String(item?.label ?? "").trim().slice(0, 40) || "Unnamed",
        color: /^#[0-9a-f]{6}$/i.test(item?.color) ? item.color : UNKNOWN_OUTLINE
      }))
      .filter((item) => (seen.has(item.id) ? false : seen.add(item.id)));
  }

  // Facts arrive from disk or from the host's broadcast; keep the shape honest either way.
  function normalizeFacts(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((fact) => ({
        id: fact?.id || crypto.randomUUID(),
        text: String(fact?.text ?? "").trim().slice(0, 400),
        visibility: FACT_VISIBILITY.includes(fact?.visibility) ? fact.visibility : "secret",
        // Authored on the knowledge chunk this fact came from: what it takes to
        // learn it, and what question it answers. Both are the DM's.
        check: String(fact?.check ?? "").trim().slice(0, 80),
        topic: String(fact?.topic ?? "").trim().slice(0, 40)
      }))
      .filter((fact) => fact.text);
  }

  function loadJson(key, fallback) {
    try { return { ...structuredClone(fallback), ...JSON.parse(localStorage.getItem(key) || "null") }; }
    catch { return structuredClone(fallback); }
  }

  function saveHostState() {
    if (role === "host") localStorage.setItem(HOST_STATE_KEY, JSON.stringify(boardState));
  }

  function activeLayer() {
    // No layers means no encounter has been loaded yet; the empty board shows instead.
    return boardState.layers?.find((layer) => layer.id === boardState.activeLayer) || boardState.layers?.[0] || null;
  }

  // Empty until an encounter loads, which is safe everywhere it is compared
  // against an actor's or an effect's layerId — nothing matches, nothing draws.
  function activeLayerId() {
    return activeLayer()?.id || "";
  }

  function hasLayer(layerId) {
    return Boolean(layerId) && Boolean(boardState.layers?.some((layer) => layer.id === layerId));
  }

  // ---- storeys that see through themselves --------------------------------
  //
  // The Bucket's upper plate is the second storey alone on a transparent
  // canvas. Drawn by itself, the street around the building is a black void —
  // when what is actually there is the ground floor, in daylight, with people
  // standing in it. So a level marked `transparent:` is drawn *over* the one
  // beneath rather than instead of it, and the negative space in its own art is
  // the hole you see the floor below through.
  //
  // That same alpha answers the harder half. Somebody standing in the alley is
  // visible from upstairs because nothing is between you and them; somebody
  // standing in the barroom is not, because there is a floor in the way. The
  // plate already knows which is which — opaque means "this storey covers that
  // square" — so the mask is read off the art rather than authored twice.

  // The level composited beneath this one, or null for an ordinary plate.
  function layerUnder(layer) {
    const id = layer?.below;
    if (!id || id === layer.id) return null;
    return layerNamed(id);
  }

  // Which plate is actually in `#map-image`. Not always the active layer.
  function baseLayerId() {
    return (layerUnder(activeLayer()) || activeLayer())?.id || "";
  }

  //: layerId -> {key, cells: Uint8Array} — one byte a square, 1 where this
  //: storey's own art is solid enough to stand on and hide what is under it.
  const coverage = new Map();

  //: Alpha at or above this counts as floor. A square the plate only clips the
  //: corner of is not a floor you can stand on, and treating it as one would
  //: hide somebody standing in the street outside a jutting balcony.
  const COVER_ALPHA = 96;

  function ensureCoverage(layer) {
    const { columns, rows } = boardDimensions();
    const key = `${layer.url}|${columns}x${rows}`;
    if (coverage.get(layer.id)?.key === key) return;
    // Claimed before the image loads so a second render does not queue it
    // again; the cells fill in when it arrives and the board redraws.
    coverage.set(layer.id, { key, cells: null });

    const image = new Image();
    image.crossOrigin = "anonymous";
    image.addEventListener("load", () => {
      try {
        // Drawn down to one pixel a square: the browser's own filter does the
        // averaging, and per-square is the only resolution this is asked at.
        const canvas = document.createElement("canvas");
        canvas.width = columns; canvas.height = rows;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.drawImage(image, 0, 0, columns, rows);
        const { data } = context.getImageData(0, 0, columns, rows);
        const cells = new Uint8Array(columns * rows);
        for (let i = 0; i < cells.length; i += 1) cells[i] = data[i * 4 + 3] >= COVER_ALPHA ? 1 : 0;
        coverage.set(layer.id, { key, cells });
        renderActors();
      } catch (error) {
        // A tainted canvas — the board opened from a different origin than its
        // art. Nothing is hidden rather than everything: a DM who can see the
        // whole floor is inconvenienced, one who cannot see a player is lost.
        console.warn("Could not read the floor mask", error);
        coverage.set(layer.id, { key, cells: null });
      }
    });
    image.addEventListener("error", () => coverage.set(layer.id, { key, cells: null }));
    image.src = layer.url;
  }

  // Is this square roofed over by the storey being looked at? Unknown mask
  // means no, so an unreadable plate shows everyone rather than nobody.
  function coveredAt(layerId, x, y) {
    const cells = coverage.get(layerId)?.cells;
    if (!cells) return false;
    const { columns, rows } = boardDimensions();
    if (x < 0 || y < 0 || x >= columns || y >= rows) return false;
    return cells[y * columns + x] === 1;
  }

  // An actor is seen through the hole if the square it stands on is not roofed.
  // Measured at the middle of the footprint rather than the corner, so a wagon
  // half in a doorway resolves to wherever most of it is.
  function showsThroughFloor(actor, layerId) {
    const footprint = actorFootprint(actor);
    return !coveredAt(layerId,
      Math.floor(actor.x + footprint.width / 2),
      Math.floor(actor.y + footprint.height / 2));
  }

  // Every layer whose actors belong on screen when looking at this one: itself,
  // plus whatever shows through it. Takes an id rather than reading the active
  // layer, because the host answers this per seat and seats are on their own
  // floors.
  function layersSeenFrom(layerId) {
    const under = layerUnder(layerNamed(layerId));
    return under ? [layerId, under.id] : [layerId];
  }

  // Whether this actor is drawn on the floor currently being looked at.
  //
  // Standing on it, always. Standing on the floor below a transparent one, only
  // where that floor is not roofed over — which is the whole rule: the woman in
  // the alley is visible from upstairs, the man at the bar is not, and the art
  // is what knows the difference.
  function drawnHere(actor) {
    const active = activeLayerId();
    // A token predating layers carries no layerId and rides along with whatever
    // floor is showing, exactly as it did before any of this existed.
    if (!actor.layerId || actor.layerId === active) return true;
    const under = layerUnder(activeLayer());
    if (!under || actor.layerId !== under.id) return false;
    return showsThroughFloor(actor, active);
  }

  function layerNamed(layerId) {
    return boardState.layers?.find((layer) => layer.id === layerId) || null;
  }

  // ---- who is looking at which floor --------------------------------------
  //
  // `boardState.activeLayer` used to be the whole answer: one floor, broadcast,
  // and the table went where the DM went. That is wrong once a cellar and a
  // barroom are being played at the same time, which is the entire point of an
  // exit — Father Dominic is downstairs and the party is not, and both screens
  // have to be right at once.
  //
  // So the DM's floor is now the DM's camera and carries nobody, and a seat's
  // floor is *derived from where its character is standing*. Derived rather
  // than stored, because then nothing has to be kept in sync: the DM dragging a
  // token down a stair moves that player's screen for free, and so does a
  // player taking an exit, and so does loading an encounter that starts the
  // priest in the cellar.
  //
  // The one piece of stored state is the pin, which is what "bring the table
  // here" sets — an explicit, visible, DM-held override of the derived answer.

  // The character a seat is looking through. Its own PC first, because a seat
  // that controls a player and their horse is a person, not a horse.
  function seatAnchor(seat) {
    const mine = boardState.actors.filter((actor) => actor.controller === seat.id);
    return mine.find((actor) => seat.pcAssetId && actor.assetId === seat.pcAssetId) || mine[0] || null;
  }

  function viewLayerForSeat(seat) {
    if (seat.pinnedLayer && hasLayer(seat.pinnedLayer)) return seat.pinnedLayer;
    const anchor = seatAnchor(seat);
    if (anchor && hasLayer(anchor.layerId)) return anchor.layerId;
    // A seat with nobody on the board yet has nothing to follow, so it watches
    // over the DM's shoulder until it does.
    return activeLayerId();
  }

  // ---- exits ---------------------------------------------------------------
  //
  // Authored on the place, overridable by the encounter, and the only thing
  // that moves a character between floors. See campaign-system.js for the two
  // dialects; by the time anything here sees one it is already
  // {id, label, cells[], to:{layerId, x, y}}.

  function exitsOn(layerId) {
    return layerNamed(layerId)?.exits || [];
  }

  // Every exit an actor is standing on. Tested against the whole footprint, so
  // a wagon parked across a trapdoor is on it — the same rule the board already
  // uses for what a token covers.
  function exitsUnder(actor) {
    if (!actor || !hasLayer(actor.layerId)) return [];
    const footprint = actorFootprint(actor);
    const x0 = Math.floor(actor.x), y0 = Math.floor(actor.y);
    const x1 = x0 + Math.max(1, Math.ceil(footprint.width)) - 1;
    const y1 = y0 + Math.max(1, Math.ceil(footprint.height)) - 1;
    return exitsOn(actor.layerId).filter((exit) => exit.cells.some(
      (cell) => cell.x >= x0 && cell.x <= x1 && cell.y >= y0 && cell.y <= y1));
  }

  // Where an actor comes out: the far end of the link, always written down and
  // never inferred from where they were standing. A place's plates are not
  // necessarily drawn in register with each other — the Bucket of Blood's
  // cellar sits about seven squares left of its barroom — so "the same square,
  // one floor down" is a different room, and a tunnel's two mouths are nowhere
  // near each other by design.
  function exitLanding(exit, actor) {
    return clampActorPosition(actor, exit.to.x, exit.to.y);
  }

  // Board dimensions come from the place, not from measuring the map art.
  function boardDimensions() {
    const board = boardState.place?.board;
    return { columns: Number(board?.columns) || 48, rows: Number(board?.rows) || 32 };
  }

  function actorDefinition(actor) {
    return actorLibrary.get(actor?.assetId) || null;
  }

  // Every item has a rarity, and a pack that declares none is common — there is
  // no such thing as an item without one. It can be declared on its own, since
  // rarity is not enchantment (a one-of-a-kind deed is legendary and does nothing
  // to your attack roll), or inside `magic:`, where it also implies the bonus.
  // A token may overrule its pack — the DM decides mid-scene that this particular
  // deed is the legendary one — so the instance is asked first. The manifest is a
  // static file this board can read and never write, which is why the override
  // lives on the actor rather than going back to disk.
  const RARITIES = ["common", "uncommon", "rare", "legendary"];

  function rarityOf(definition, actor = null) {
    // An override only counts if it names a real rarity. Anything else falls
    // through to the pack rather than dragging the answer down to common —
    // a token carrying junk must not quietly demote a legendary deed.
    if (RARITIES.includes(actor?.rarity)) return actor.rarity;
    const declared = definition?.rarity || definition?.magic?.rarity;
    return RARITIES.includes(declared) ? declared : "common";
  }

  // Named characters and PCs are single-instance (only one on the board);
  // creatures and props (Wolf, Goblin Warrior, barrel, dynamite) are multi.
  function isSingleInstance(definition) {
    if (definition?.instancing === "single") return true;
    // Legendary means there is exactly one in the world, so it needs no
    // `instancing:` line to say so. A pack that writes `multi` anyway has
    // contradicted itself and the validator refuses it, so reading the rarity
    // here can never overrule a choice an author actually made.
    if (rarityOf(definition) === "legendary") return true;
    if (definition?.instancing === "multi") return false;
    return definition?.kind === "player_character";
  }

  function canEditActor(actor, seatId = playerSeatId) {
    return isDM() || Boolean(actor && seatId && actor.controller === seatId);
  }

  // Which roster this files under. `kind` answers for almost everything, but a
  // pack may overrule it with `roster:` — Clap is Nickles' horse, so he belongs
  // with the party rather than among the townsfolk and the wolves, while his
  // `kind` stays `creature` so an encounter still counts him as a horse. Takes
  // either a pack or a token: a token carries no roster of its own, so its pack
  // is asked.
  function actorGroup(actor) {
    const definition = actorDefinition(actor);
    const declared = actor?.roster || definition?.roster;
    if (ROSTERS.has(declared)) return declared;
    // The pack answers for the kind too, so a token that arrived without one —
    // an older save, a hand-written fixture — still files where it belongs
    // instead of falling through to the items.
    return GROUP_OF_KIND.get(actor?.kind || definition?.kind) || "items";
  }

  function isPartyMember(actor) {
    return actorGroup(actor) === "party";
  }

  function partyActors() {
    return boardState.actors.filter(isPartyMember);
  }

  // Health is the DM's ledger, with two exceptions: adventurers know their own
  // condition and each other's, so PC hit points are open to everyone; and a
  // player reads whatever they control — their horse's wounds are theirs to see.
  function canSeeHp(actor) {
    return isDM() || isPartyMember(actor) || canEditActor(actor);
  }

  // Whether the bar is drawn over the token, for viewers allowed to read it at all.
  function showsHpBar(actor) {
    return Boolean(actor) && tracksHealth(actor) && !actor.indestructible && actor.hpVisible !== false && canSeeHp(actor);
  }

  // Does this actor have a hit-point total worth tracking? Its pack answers, by
  // whether it wrote `stats.hp` at all — see resolveDefinition. Everything that
  // only makes sense against a health total follows this one question: the bar
  // over the token, the HP / armour / threshold tiles on the sheet, the fields
  // that write them, and whether damage wears the thing down or simply ends it.
  // The manifest is the authority; the copy on the token answers for a board
  // restored from an older save whose pack has since gone missing.
  function tracksHealth(actor) {
    const definition = actorDefinition(actor);
    if (definition) return definition.tracksHealth !== false;
    return actor?.tracksHealth !== false;
  }

  // Rotation is a fact about which way a thing faces, which needs a front. A
  // horse, a wagon, a person has one. A bottle on the floor does not — its pack
  // may ship four painted facings, and they are four looks at the same object
  // rather than four directions it could be pointing, so the board sets it down
  // facing the room like everything else and never asks the question again.
  function canRotate(actor) {
    return canMoveActor(actor) && actor?.kind !== "item";
  }

  // "0.5×0.5" is the number the grid works in; it is not what a person calls the
  // space a bottle takes up.
  function footprintLabel(footprint) {
    if (!footprint) return "";
    if (footprint.width === 0.5 && footprint.height === 0.5) return "Quarter square";
    return `${footprint.width}×${footprint.height}`;
  }

  // ---------------------------------------------------------------------------
  // Primary affiliation — the clan, outfit, or badge an actor wears. DM-only, all
  // of it: the panel, the outline colour, the hover line, the sheet chip. Who
  // rides with whom is something the table finds out in play, not something the
  // board hands them by colouring the room in. Every read goes through
  // `affiliationOf`, so the one isDM() check there is what keeps a player's
  // screen honest — outlines stay bone white and the labels never render.
  // ---------------------------------------------------------------------------

  function affiliations() {
    return Array.isArray(boardState.affiliations) ? boardState.affiliations : [];
  }

  function affiliationOf(actor) {
    if (!isDM()) return null;
    return actor?.affiliation ? affiliations().find((item) => item.id === actor.affiliation) || null : null;
  }

  function outlineColor(actor) {
    return affiliationOf(actor)?.color || UNKNOWN_OUTLINE;
  }

  function affiliationLabel(actor) {
    return affiliationOf(actor)?.label || "Unknown affiliation";
  }

  function actorsWithAffiliation(id) {
    return boardState.actors.filter((actor) => actor.affiliation === id).length;
  }

  function setActorAffiliation(actorId, affiliationId) {
    if (role !== "host") return;
    const actor = boardState.actors.find((item) => item.id === actorId); if (!actor) return;
    const next = affiliations().some((item) => item.id === affiliationId) ? affiliationId : "";
    if (actor.affiliation === next) return;
    actor.affiliation = next;
    broadcastState();
  }

  function addAffiliation(label) {
    if (role !== "host") return;
    const name = String(label || "").trim().slice(0, 40);
    if (!name) { ui.affiliationName.focus(); return; }
    // Give a new outfit the first palette colour nobody has claimed yet.
    const taken = new Set(affiliations().map((item) => item.color.toLowerCase()));
    const free = AFFILIATION_PALETTE.find((swatch) => swatch.hex !== UNKNOWN_OUTLINE && !taken.has(swatch.hex.toLowerCase()));
    boardState.affiliations = affiliations().concat({
      id: crypto.randomUUID(), label: name, color: (free || AFFILIATION_PALETTE[1]).hex
    });
    ui.affiliationName.value = "";
    broadcastState();
    showToast(`Added ${name}`);
  }

  function updateAffiliation(id, patch) {
    if (role !== "host") return;
    const item = affiliations().find((entry) => entry.id === id); if (!item) return;
    if (typeof patch.label === "string") item.label = patch.label.trim().slice(0, 40) || item.label;
    if (/^#[0-9a-f]{6}$/i.test(patch.color)) item.color = patch.color;
    broadcastState();
  }

  function removeAffiliation(id) {
    if (role !== "host") return;
    const count = actorsWithAffiliation(id);
    if (count && !confirm(`Remove this affiliation? ${count} actor${count === 1 ? "" : "s"} will go back to unknown.`)) return;
    boardState.affiliations = affiliations().filter((item) => item.id !== id);
    for (const actor of boardState.actors) if (actor.affiliation === id) actor.affiliation = "";
    broadcastState();
  }

  // The panel is the DM's editor and nobody else's — its section is `data-scope="dm"`,
  // so a player never opens it. Leaving the list built anyway would only keep a
  // roster of outfit names sitting in a player's DOM, so the render stops at the door.
  function renderAffiliations() {
    if (!isDM()) { ui.affiliationList.replaceChildren(); ui.affiliationAdd.hidden = true; return; }
    const shown = affiliations();
    ui.affiliationList.replaceChildren();
    for (const item of shown) ui.affiliationList.append(affiliationRow(item));
    if (!shown.length) {
      const empty = document.createElement("span"); empty.className = "muted";
      empty.textContent = "No affiliations yet.";
      ui.affiliationList.append(empty);
    }
    const unknown = boardState.actors.filter((actor) => !affiliationOf(actor)).length;
    ui.affiliationList.append(legendRow(UNKNOWN_OUTLINE, "Unknown affiliation", unknown));
    ui.affiliationAdd.hidden = false;
    ui.affiliationHint.textContent =
      "The colour paints each token's outline on your screen only — players see every outline bone white.";
  }

  function legendRow(color, label, count) {
    const row = document.createElement("div"); row.className = "affiliation-row legend-only";
    const swatch = document.createElement("span"); swatch.className = "affiliation-swatch"; swatch.style.background = color;
    const name = document.createElement("span"); name.className = "affiliation-label"; name.textContent = label;
    const tally = document.createElement("small"); tally.className = "affiliation-count"; tally.textContent = count || "";
    row.append(swatch, name, tally);
    return row;
  }

  function affiliationRow(item) {
    const row = document.createElement("div"); row.className = "affiliation-row";
    const swatch = document.createElement("span"); swatch.className = "affiliation-swatch"; swatch.style.background = item.color;
    const name = document.createElement("input");
    name.type = "text"; name.className = "affiliation-label"; name.value = item.label; name.maxLength = 40;
    name.addEventListener("change", () => updateAffiliation(item.id, { label: name.value }));
    const tally = document.createElement("small"); tally.className = "affiliation-count"; tally.textContent = actorsWithAffiliation(item.id) || "";
    const remove = document.createElement("button");
    remove.type = "button"; remove.className = "remove-token"; remove.textContent = "×"; remove.title = "Remove this affiliation";
    remove.addEventListener("click", () => removeAffiliation(item.id));
    const swatches = document.createElement("div"); swatches.className = "affiliation-palette";
    for (const paint of AFFILIATION_PALETTE) {
      const pick = document.createElement("button");
      pick.type = "button";
      pick.className = `palette-swatch ${paint.hex.toLowerCase() === item.color.toLowerCase() ? "active" : ""}`;
      pick.style.background = paint.hex; pick.title = paint.label;
      pick.setAttribute("aria-label", paint.label);
      pick.addEventListener("click", () => updateAffiliation(item.id, { color: paint.hex }));
      swatches.append(pick);
    }
    row.append(swatch, name, tally, remove, swatches);
    return row;
  }

  function fillAffiliationSelect(select, actor) {
    select.replaceChildren(new Option("Unknown affiliation", ""));
    for (const item of affiliations()) select.append(new Option(item.label, item.id));
    select.value = affiliationOf(actor)?.id || "";
  }

  function actorFacts(actor) {
    return Array.isArray(actor?.facts) ? actor.facts : [];
  }

  function visibleFacts(actor) {
    return isDM() ? actorFacts(actor) : actorFacts(actor).filter((fact) => fact.visibility === "public");
  }

  function canViewActorSheet(actor) {
    if (!actor) return false;
    if (isDM()) return true;
    const definition = actorDefinition(actor);
    const visibility = definition?.sheet_visibility;
    if (visibility === "all") return true;
    if (visibility === "controller") return Boolean(playerSeatId && actor.controller === playerSeatId);
    if (visibility === "host") return false;
    return actor.kind === "player_character";
  }

  function canMoveActor(actor) {
    return Boolean(actor) && (role === "host" || playerChannel?.readyState === "open");
  }

  // A library sheet describes a pack rather than one token, so it outlives a
  // change of selection among that pack's copies — the spotlight walking through
  // them is the very thing the sheet is about. Anything else closes it.
  function previewCovers(actorId) {
    if (!sheetIsPreview()) return false;
    const actor = boardState.actors.find((item) => item.id === actorId);
    return Boolean(actor) && actor.assetId === previewActor.assetId;
  }

  function selectOnly(actorId) {
    if (sheetIsOpen() && actorId !== sheetActorId && !previewCovers(actorId)) closeActorSheet();
    selectedActorIds.clear();
    if (actorId) selectedActorIds.add(actorId);
    selectedActorId = actorId || "";
  }

  function toggleActorSelection(actorId) {
    if (selectedActorIds.has(actorId)) selectedActorIds.delete(actorId);
    else selectedActorIds.add(actorId);
    selectedActorId = selectedActorIds.has(actorId) ? actorId : [...selectedActorIds].at(-1) || "";
  }

  function clearActorSelection(render = true) {
    selectOnly("");
    ui.actorTooltip.hidden = true;
    if (render) renderActors();
  }

  function selectedActors() {
    return boardState.actors.filter((actor) => selectedActorIds.has(actor.id));
  }

  function refreshSelectionVisuals() {
    renderExitList();
    ui.tokensLayer.querySelectorAll(".token").forEach((element) => element.classList.toggle("selected", selectedActorIds.has(element.dataset.id)));
    if (sheetIsOpen()) updateActorSheet();
  }

  async function loadActorPacks() {
    try {
      actorLibrary = await LaramieActors.loadLibrary(campaign.actorsIndexUrl);
      const reconciled = reconcileActorDefinitions();
      renderAssetLibrary();
      if (reconciled && role === "host") broadcastState(); else { renderActors(); if (sheetIsOpen()) updateActorSheet(); }
    } catch (error) {
      ui.assetLibrary.textContent = "Actor packs could not be loaded.";
      showToast(error.message || "Actor packs could not be loaded");
    }
  }

  function reconcileActorDefinitions() {
    let changed = false;
    for (const actor of boardState.actors) {
      const definition = actorDefinition(actor); if (!definition) continue;
      if ((!actor.hp || actor.hp.max === 1) && Number(definition.stats.hp) > 1) {
        actor.hp = { current: Number(definition.stats.hp), max: Number(definition.stats.hp) }; changed = true;
      }
      if ((actor.armorClass == null || actor.armorClass === 10) && Number(definition.stats.armor_class) !== 10) {
        actor.armorClass = Number(definition.stats.armor_class); changed = true;
      }
      if (!Number.isFinite(actor.movementSpeed)) { actor.movementSpeed = Number(definition.stats.speed_ft) || 0; changed = true; }
      // Actors placed before facts existed inherit their pack's opening dossier.
      // The flag makes the seeding a one-time event, so a fact the DM deletes stays deleted.
      if (!actor.factsSeeded) {
        if (!actorFacts(actor).length) actor.facts = LaramieActors.seedFacts(definition);
        actor.factsSeeded = true; changed = true;
      }
      // A pack only declares an affiliation the table can see at a glance — a badge,
      // a collar, the company someone openly keeps. Anyone whose allegiance is a
      // secret ships without one and stays bone white until the DM colours them in.
      if (actor.affiliation === undefined) {
        const declared = definition.affiliation || "";
        actor.affiliation = affiliations().some((item) => item.id === declared) ? declared : "";
        changed = true;
      }
    }
    return changed;
  }

  // Pinned packs, per browser. Named "pinned" rather than "saved" on purpose:
  // Save in the title bar means writing the campaign back to disk, and one word
  // meaning two things that far apart is a trap.
  function pinnedAssets() {
    if (!Array.isArray(view.pinned)) view.pinned = [];
    return view.pinned;
  }

  function isPinned(assetId) {
    return pinnedAssets().includes(assetId);
  }

  function togglePin(assetId) {
    const pinned = pinnedAssets();
    const at = pinned.indexOf(assetId);
    if (at >= 0) pinned.splice(at, 1); else pinned.push(assetId);
    saveView(); renderAssetLibrary();
  }

  // One box over the whole library rather than one per shelf. You type "colt"
  // wanting the revolver, not wanting to first remember which shelf it is on —
  // and six search boxes down the side of a panel is six things to look at.
  function librarySearchTerms() {
    return ui.librarySearch.value.toLowerCase().split(/\s+/).filter(Boolean);
  }

  function matchesSearch(definition, terms) {
    if (!terms.length) return true;
    const haystack = [definition.name, definition.kind, definition.category,
      definition.mechanics?.kind_note, affiliationTitle(definition.affiliation)]
      .filter(Boolean).join(" ").toLowerCase();
    return terms.every((term) => haystack.includes(term));
  }

  function affiliationTitle(id) {
    return affiliations().find((item) => item.id === id)?.label || "";
  }

  // The shelves, in the order a DM reaches for them. People first, because a
  // scene is people; then the objects, weapons before scenery because that is
  // the order a fight needs them in.
  function libraryShelves() {
    const packs = [...actorLibrary.values()].filter((definition) => actorGroup(definition) !== "party");
    const shelves = [];

    // NPCs are grouped by affiliation and nothing else. The campaign already
    // answers "whose side is this one on", every token is already painted by it,
    // and a second taxonomy on top would be one more thing to keep true.
    const people = packs.filter((definition) => definition.kind === "npc");
    if (people.length) {
      const byOutfit = new Map();
      for (const definition of people) {
        const key = definition.affiliation || "";
        if (!byOutfit.has(key)) byOutfit.set(key, []);
        byOutfit.get(key).push(definition);
      }
      const outfits = [...byOutfit.entries()]
        .sort(([a], [b]) => (a ? affiliationTitle(a) : "\uffff").localeCompare(b ? affiliationTitle(b) : "\uffff"));
      shelves.push({
        id: "npcs", label: "Non-player characters", total: people.length,
        // An NPC with no declared allegiance is not a leftover — the table does
        // not know where that one stands, which is a fact about them.
        groups: outfits.map(([id, list]) => ({ label: id ? affiliationTitle(id) : "Unaligned townsfolk", packs: list }))
      });
    }

    const creatures = packs.filter((definition) => definition.kind === "creature");
    if (creatures.length) shelves.push({ id: "creatures", label: "Creatures", total: creatures.length, groups: [{ label: "", packs: creatures }] });

    const objects = packs.filter((definition) => ["item", "prop"].includes(definition.kind));
    for (const shelf of ITEM_SHELVES) {
      const list = objects.filter((definition) => categoryOf(definition) === shelf.id);
      if (list.length) shelves.push({ id: shelf.id, label: shelf.label, total: list.length, groups: [{ label: "", packs: list }] });
    }
    return shelves;
  }

  function renderAssetLibrary() {
    ui.assetLibrary.replaceChildren();
    // The library shelves non-player characters under the outfit they ride for,
    // so its group headings are the affiliation roster spelled out. The panel is
    // DM-scoped and hidden either way, but building it for a player would leave
    // that roster sitting in their page. Both callers re-render on the way back.
    if (!isDM()) return;
    const terms = librarySearchTerms();
    const pinned = pinnedAssets()
      .map((id) => actorLibrary.get(id))
      .filter((definition) => definition && matchesSearch(definition, terms));
    let shown = pinned.length;

    if (pinned.length) {
      ui.assetLibrary.append(shelfElement(
        { id: "pinned", label: "Pinned", total: pinned.length, groups: [{ label: "", packs: pinned }] },
        pinned.length, true));
    }

    for (const shelf of libraryShelves()) {
      const groups = shelf.groups
        .map((group) => ({ ...group, packs: group.packs.filter((definition) => matchesSearch(definition, terms)) }))
        .filter((group) => group.packs.length);
      const count = groups.reduce((sum, group) => sum + group.packs.length, 0);
      if (!count) continue;
      shown += count;
      // A search is a question, so every shelf holding an answer opens itself.
      ui.assetLibrary.append(shelfElement({ ...shelf, groups }, count, terms.length > 0));
    }

    if (!shown) ui.assetLibrary.append(muted(terms.length ? "Nothing in the library matches that" : "Loading actor packs…"));
    refreshLibraryAvailability();
  }

  function shelfElement(shelf, count, open) {
    const element = document.createElement("details");
    element.className = "asset-shelf"; element.dataset.shelf = shelf.id;
    element.open = Boolean(open) || Boolean(sectionState()[`shelf:${shelf.id}`]);
    element.addEventListener("toggle", () => {
      // Only remember a deliberate open, never one a search forced.
      if (!librarySearchTerms().length) { sectionState()[`shelf:${shelf.id}`] = element.open; saveView(); }
    });
    const summary = document.createElement("summary");
    const name = document.createElement("span"); name.className = "shelf-name"; name.textContent = shelf.label;
    const tally = document.createElement("span"); tally.className = "shelf-count";
    tally.textContent = count === shelf.total ? String(count) : `${count} / ${shelf.total}`;
    summary.append(name, tally);
    element.append(summary);
    for (const group of shelf.groups) {
      if (group.label) {
        const heading = document.createElement("p");
        heading.className = "asset-group-heading"; heading.textContent = `${group.label} · ${group.packs.length}`;
        element.append(heading);
      }
      const cards = document.createElement("div"); cards.className = "shelf-cards";
      for (const definition of group.packs) cards.append(assetCardButton(definition));
      element.append(cards);
    }
    return element;
  }

  // Every picture a pack ships — the mini's facings, its state variants, the flat
  // overhead art — as a row of thumbnails that open the full-size gallery. This
  // lives on the sheet rather than on the library card: the card is a handle to
  // drag, and a strip of art under each one turned the library into a contact
  // sheet you had to scroll past to reach the next actor.
  function assetStrip(pictures, title, limit = Infinity) {
    const strip = document.createElement("div");
    strip.className = "asset-strip";
    const shown = pictures.slice(0, limit);
    for (const [index, item] of shown.entries()) {
      const thumb = document.createElement("button");
      thumb.type = "button"; thumb.className = "asset-thumb"; thumb.title = item.label;
      const image = document.createElement("img");
      image.src = item.url; image.alt = "";
      thumb.append(image);
      thumb.addEventListener("click", (event) => {
        event.stopPropagation();
        openGallery(pictures, title, index);
      });
      strip.append(thumb);
    }
    if (pictures.length > shown.length) {
      const more = document.createElement("button");
      more.type = "button"; more.className = "asset-thumb asset-more";
      more.textContent = `+${pictures.length - shown.length}`;
      more.title = `See all ${pictures.length} images`;
      more.addEventListener("click", (event) => {
        event.stopPropagation();
        openGallery(pictures, title, shown.length);
      });
      strip.append(more);
    }
    return strip;
  }

  function assetCardButton(definition) {
    const control = document.createElement("button"); control.type = "button"; control.className = `asset-card group-${actorGroup(definition)}`;
    control.draggable = true; control.dataset.assetId = definition.id; control.dataset.single = String(isSingleInstance(definition));
    // A 42px circle wants a face, so the card asks for the portrait first and
    // only falls back to map art. It changes nothing for the packs that ship one
    // or the other; it is Clap, who has both a portrait and overhead sprites,
    // who would otherwise be filed under the party as a horse seen from above.
    const imageUrl = definition.image || LaramieActors.imageFor(definition, "north");
    if (imageUrl) {
      const image = document.createElement("img"); image.src = imageUrl; image.alt = "";
      // A card falls back to the mini only when a pack ships no flat art, and a
      // whole standing figure letterboxed into a 42px circle is a speck — crop to
      // the head and shoulders, which is how you recognise one anyway.
      if (imageUrl === LaramieActors.miniImageFor(definition, "north")) image.className = "mini-art";
      control.append(image);
    } else {
      const placeholder = document.createElement("span"); placeholder.className = "asset-placeholder"; placeholder.textContent = definition.name.slice(0, 1); control.append(placeholder);
    }
    const copy = document.createElement("span");
    const name = document.createElement("strong"); name.textContent = definition.name;
    // The pack's own words for what it is — "Repeating rifle", "Thrown
    // incendiary" — which is more use on a card than repeating "item" 22 times.
    const kind = document.createElement("small");
    const fallback = definition.kind.replace("_", " ");
    kind.textContent = definition.mechanics?.kind_note || fallback.charAt(0).toUpperCase() + fallback.slice(1);
    copy.append(name, kind); control.append(copy);
    control.append(pinControl(definition));
    // A pack's `description` is the DM's dossier line. It must never ride along in
    // a title attribute on a player's screen, hidden panel or not.
    control.title = isDM() ? definition.description || definition.name : definition.name;
    control.addEventListener("dragstart", (event) => {
      event.dataTransfer.effectAllowed = "copy"; event.dataTransfer.setData("application/x-laramie-asset", definition.id);
    });
    // The sheet opens at once — it describes the pack, so it is right whether the
    // spotlight or the double-click's select-all follows. One shared timer, so a
    // click on a second card cancels the first card's pending spotlight instead
    // of firing both.
    control.addEventListener("click", () => {
      clearTimeout(libraryClickTimer);
      openLibrarySheet(definition);
      libraryClickTimer = window.setTimeout(() => highlightAssetInstances(definition.id, false), 220);
    });
    control.addEventListener("dblclick", (event) => {
      event.preventDefault(); clearTimeout(libraryClickTimer);
      highlightAssetInstances(definition.id, true);
    });
    return control;
  }

  // A star on the card rather than a row of its own: pinning is something you do
  // to a pack while looking at it, and it has to sit inside the same hit target
  // without dragging the card along with it.
  function pinControl(definition) {
    const pin = document.createElement("span");
    pin.className = `asset-pin${isPinned(definition.id) ? " pinned" : ""}`;
    pin.setAttribute("role", "button"); pin.tabIndex = 0;
    pin.title = isPinned(definition.id) ? "Unpin from the top of the shelf" : "Pin to the top of the shelf";
    pin.textContent = isPinned(definition.id) ? "★" : "☆";
    const flip = (event) => { event.preventDefault(); event.stopPropagation(); togglePin(definition.id); };
    pin.addEventListener("click", flip);
    pin.addEventListener("pointerdown", (event) => event.stopPropagation());
    pin.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") flip(event); });
    return pin;
  }

  function refreshLibraryAvailability() {
    const placed = new Set(boardState.actors.map((actor) => actor.assetId));
    for (const card of ui.assetLibrary.querySelectorAll(".asset-card")) {
      const used = card.dataset.single === "true" && placed.has(card.dataset.assetId);
      card.classList.toggle("placed", used);
      card.draggable = !used;
      card.setAttribute("aria-disabled", String(used));
    }
  }

  function boardInstancesOfAsset(assetId) {
    return boardState.actors.filter((actor) =>
      actor.assetId === assetId && (!actor.layerId || actor.layerId === activeLayerId()));
  }

  // Library click → spotlight one instance, newest first, walking back through
  // the older copies on repeat clicks; double-click → spotlight all of them so
  // they move and delete as one, exactly like a marquee selection.
  function highlightAssetInstances(assetId, all) {
    const instances = boardInstancesOfAsset(assetId);
    if (!instances.length) {
      libraryCycle = { assetId: "", actorId: "" };
      showToast(boardState.actors.some((actor) => actor.assetId === assetId)
        ? "That actor is on another layer" : "Drag this actor onto the map to place it");
      return;
    }
    if (all) {
      // A library sheet describes the pack every one of these copies came from,
      // so it survives the select-all; an instance's sheet does not.
      if (sheetIsOpen() && !sheetIsPreview()) closeActorSheet();
      selectedActorIds.clear();
      for (const actor of instances) selectedActorIds.add(actor.id);
      selectedActorId = instances.at(-1).id;
      // A fresh walk starts at the newest again once the group is broken up.
      libraryCycle = { assetId: "", actorId: "" };
      if (instances.length > 1) showToast(`Highlighted all ${instances.length} · ${instances[0].name}`);
    } else {
      const order = [...instances].reverse();
      // The walk only advances while this card is still driving the selection;
      // touch the board in between and the next click restarts at the newest.
      const standing = order.findIndex((actor) => actor.id === libraryCycle.actorId);
      const walking = libraryCycle.assetId === assetId && standing >= 0
        && selectedActorIds.size === 1 && selectedActorIds.has(libraryCycle.actorId);
      const index = walking ? (standing + 1) % order.length : 0;
      selectOnly(order[index].id);
      libraryCycle = { assetId, actorId: order[index].id };
      if (order.length > 1) showToast(`${order[index].name} · ${index + 1} of ${order.length}, newest first`);
    }
    renderActors();
    centerViewOnActors(all ? instances : selectedActors());
    // Hand focus back to the board so the arrow keys, Delete and the rotation
    // keys answer the click instead of the library button that still holds it.
    ui.viewport.focus({ preventScroll: true });
  }

  // Nudge the camera so the highlighted tokens are on screen — but leave it alone
  // when they are already comfortably in view, so single clicks don't jump the map.
  function centerViewOnActors(actors) {
    if (!actors.length) return;
    const size = boardState.grid.size;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const actor of actors) {
      const definition = actorDefinition(actor);
      const footprint = actorFootprint(actor);
      const cx = boardState.grid.offsetX + (actor.x + footprint.width / 2) * size;
      const cy = boardState.grid.offsetY + (actor.y + footprint.height / 2) * size;
      minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
      minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
    }
    const rect = ui.viewport.getBoundingClientRect();
    const margin = 48;
    const onScreen =
      minX * view.scale + view.x >= margin && maxX * view.scale + view.x <= rect.width - margin &&
      minY * view.scale + view.y >= margin && maxY * view.scale + view.y <= rect.height - margin;
    if (onScreen) return;
    view.x = rect.width / 2 - (minX + maxX) / 2 * view.scale;
    view.y = rect.height / 2 - (minY + maxY) / 2 * view.scale;
    applyTransform();
  }

  function placeAsset(assetId, x, y) {
    const definition = actorLibrary.get(assetId); if (!definition) return;
    if (isSingleInstance(definition) && boardState.actors.some((actor) => actor.assetId === assetId)) {
      showToast(`${definition.name} is already on the board — only one allowed`); return;
    }
    const actor = LaramieActors.createInstance(definition, { layerId: activeLayerId(), x: Math.max(0, x), y: Math.max(0, y) });
    Object.assign(actor, clampActorPosition(actor, x, y));
    boardState.actors.push(actor); selectOnly(actor.id); broadcastState();
  }

  // Loading an encounter replaces the whole scene: its place's layers and
  // geometry, and its cast. It is one broadcast, so every connected player
  // follows without touching anything.
  // Open a place with nobody in it. An encounter is a cast list placed at a
  // place, so building one has to start with the place on the table —
  // otherwise the only way to reach an empty board is `dnd encounter new` at a
  // terminal, and the board is where you can actually see what you are doing.
  // The scene carries no encounter id; Save asks for a name and the helper
  // creates the file, the same route an existing encounter saves through.
  async function openPlace(placeId, { silent = false } = {}) {
    if (!can("loadEncounter")) { showToast("Only the DM can set the table"); return false; }
    if (!actorLibrary.size) { showToast("Actor packs are still loading"); return false; }
    try {
      const place = await LaramieCampaign.loadPlace(campaign, placeId);
      const scene = LaramieCampaign.sceneFromEncounter(
        { placements: {}, defaultLayerId: "" }, place, actorLibrary
      );

      currentPlace = place;
      currentEncounter = null;
      boardState.campaignId = campaign.id;
      boardState.campaignName = campaign.name;
      boardState.encounter = {
        id: "", title: place.name, status: "draft", description: "",
        placeId: place.id, counts: { people: 0, horses: 0, items: 0 }, source: ""
      };
      boardState.place = {
        id: place.id, name: place.name, district: place.district, board: place.board
      };
      boardState.layers = scene.layers;
      boardState.activeLayer = scene.activeLayer; FOG.dirty = true;
      resetSeatPins();
      boardState.grid = normalizeGridGeometry(scene.grid);
      boardState.actors = [];
      boardState.effects = [];

      bindAllSeatPcs();
      clearActorSelection(false);
      initialFitDone = false;
      openBoard();
      broadcastState();
      renderPlaceList();
      lastSceneKey = sceneKey();
      renderSaveButton();
      if (!silent) showToast(`${place.name} is on the table — place the cast, then Save`);
      return true;
    } catch (error) {
      console.error("Could not open that place", error);
      showToast(error.message || "Could not open that place");
      return false;
    }
  }

  async function applyEncounter(encounterId, { silent = false } = {}) {
    if (!can("loadEncounter")) { showToast("Only the DM can load an encounter"); return false; }
    if (!actorLibrary.size) { showToast("Actor packs are still loading"); return false; }
    try {
      const encounter = await LaramieCampaign.loadEncounter(campaign, encounterId);
      const place = await LaramieCampaign.loadPlace(campaign, encounter.placeId);
      const scene = LaramieCampaign.sceneFromEncounter(encounter, place, actorLibrary);

      currentPlace = place;
      currentEncounter = encounter;
      boardState.campaignId = campaign.id;
      boardState.campaignName = campaign.name;
      boardState.encounter = {
        id: encounter.id, title: encounter.title, status: encounter.status,
        description: encounter.description, placeId: encounter.placeId,
        counts: encounter.counts, source: encounter.source
      };
      boardState.place = {
        id: place.id, name: place.name, district: place.district, board: place.board
      };
      boardState.layers = scene.layers;
      boardState.activeLayer = scene.activeLayer; FOG.dirty = true;
      resetSeatPins();
      boardState.grid = normalizeGridGeometry(scene.grid);
      boardState.actors = scene.actors;
      boardState.effects = [];

      bindAllSeatPcs();
      clearActorSelection(false);
      initialFitDone = false;
      openBoard();
      broadcastState();
      renderPlaceList();
      lastSceneKey = sceneKey();
      renderSaveButton();
      if (!silent) showToast(`Loaded ${encounter.title} — ${scene.actors.length} actors`);
      if (scene.missing.length) showToast(`Skipped unknown assets: ${scene.missing.join(", ")}`);
      return true;
    } catch (error) {
      console.error("Encounter load failed", error);
      showToast(error.message || "Could not load that encounter");
      return false;
    }
  }

  // ---------------------------------------------------------------- saving
  //
  // The board is a static page: it can fetch, and it cannot write a file or
  // reach git. So Save is not a button that does the work — it is a button that
  // asks something on the DM's own machine to do it. `dnd encounter serve`
  // answers on loopback; when nothing answers, Save stays disabled and says so,
  // which is exactly the state this page shipped in.
  const SAVE_HELPER = "http://127.0.0.1:8787";
  let saveHelper = null;              // {campaign, name} once one answers

  async function probeSaveHelper() {
    if (!isDM()) { saveHelper = null; renderSaveButton(); return; }
    try {
      const response = await fetch(`${SAVE_HELPER}/health`, { method: "GET" });
      const body = await response.json();
      // A helper serving a different campaign is worse than none: it would
      // write this scene into somebody else's encounters directory.
      saveHelper = body?.ok && body.campaign === campaign?.id ? body : null;
    } catch (error) {
      saveHelper = null;
    }
    renderSaveButton();
  }

  function renderSaveButton() {
    // The exit tool lives or dies by the same helper Save does, so it is
    // re-read here rather than left showing a button that writes nowhere.
    renderExitList();
    const scene = boardState.encounter;
    // A scene opened from a place has no file yet. That is savable too — the
    // helper creates the encounter and reindexes it — so the only thing that
    // disables Save is having nothing on the table or no helper listening.
    const draft = Boolean(scene?.placeId) && !scene?.id;
    const live = Boolean(saveHelper) && (Boolean(scene?.id) || draft);
    ui.saveBoard.disabled = !live;
    ui.saveBoard.textContent = draft ? "Save as…" : "Save";
    ui.saveBoard.title = !saveHelper
      ? "Run `dnd encounter serve` beside the table to enable saving."
      : draft
        ? "Name this encounter and write it into the campaign."
        : !scene?.id
          ? "Open a place or an encounter first."
          : `Write this arrangement back to ${scene.id}.yaml`;
  }

  // The board's ids match the CLI's: lowercase, hyphenated, no surprises for
  // whoever types `dnd encounter list` afterwards.
  function encounterIdFrom(title) {
    return String(title).toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  }

  async function saveEncounter() {
    const scene = boardState.encounter;
    if (!saveHelper || !scene?.placeId) return;
    if (!scene.id) {
      const title = (prompt("Name this encounter", scene.title || placeName(scene.placeId)) || "").trim();
      if (!title) return;
      const id = encounterIdFrom(title);
      if (!id) { showToast("That name has no letters or numbers in it to make an id from"); return; }
      if (encounterIndex.some((entry) => entry.id === id)
        && !confirm(`There is already an encounter called ${id}. Overwrite it?`)) return;
      scene.title = title;
      scene.id = id;
    }
    ui.saveBoard.disabled = true;
    ui.saveBoard.textContent = "Saving…";
    // Only what the file is allowed to hold. The board carries a great deal of
    // per-token state — selection, drag offsets, computed z — and none of it is
    // the scene; it is how this browser happens to be drawing the scene.
    const payload = {
      campaign: campaign.id,
      id: scene.id,
      title: scene.title,
      status: scene.status,
      description: scene.description,
      place_id: scene.placeId,
      default_layer_id: boardState.activeLayer,
      actors: (boardState.actors || []).map((actor) => ({
        assetId: actor.assetId, name: actor.name, kind: actor.kind,
        layerId: actor.layerId, x: actor.x, y: actor.y, rotation: actor.rotation,
        controller: actor.controller,
        hp: actor.hp?.current,
        notes: actor.notes || ""
      }))
    };
    try {
      const response = await fetch(`${SAVE_HELPER}/encounter`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const body = await response.json();
      if (!response.ok || !body?.ok) throw new Error(body?.error || "the helper refused it");
      const counts = body.counts || {};
      showToast(`Saved ${body.id} — ${counts.people || 0} people, ${counts.items || 0} items`);
      // A brand new encounter is not in the index this page read at load; add it
      // so the browser lists it and a second Save overwrites rather than asks.
      if (!encounterIndex.some((entry) => entry.id === body.id)) {
        encounterIndex.push({
          id: body.id, title: scene.title, status: scene.status || "draft",
          placeId: scene.placeId, counts: body.counts
        });
      }
    } catch (error) {
      console.error("Save failed", error);
      showToast(`Could not save: ${error.message}`);
      // The helper may have stopped mid-session; find out rather than leaving a
      // live-looking button that fails every time it is pressed.
      probeSaveHelper();
      return;
    }
    renderSaveButton();
    renderPlaceList();
  }

  let saveViewTimer = 0;
  function saveView() {
    // Coalesce rapid pan/zoom frames into a single write once the gesture settles;
    // a synchronous localStorage write every frame is what makes panning choppy.
    clearTimeout(saveViewTimer);
    saveViewTimer = window.setTimeout(() => {
      try { localStorage.setItem(VIEW_STATE_KEY, JSON.stringify(view)); } catch (error) { /* quota/full */ }
    }, 350);
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    ui.toast.textContent = message;
    ui.toast.classList.add("show");
    toastTimer = setTimeout(() => ui.toast.classList.remove("show"), 2200);
  }

  // The old single pill could only answer "is the table connected", which is the
  // wrong question once there are five seats — the DM needs to know that Pete is
  // in and Nickles has dropped. So the host gets one chip per seat, and a player,
  // who has no seats to show, gets one chip for their own line to the host.
  function renderSeatChips() {
    ui.seatChips.replaceChildren();
    if (role === "player") {
      const live = playerChannel?.readyState === "open";
      ui.seatChips.append(seatChip(seatName(), live ? "online" : "waiting",
        live ? "Connected to the DM" : "Waiting for the DM"));
      return;
    }
    if (!seats.size) {
      const empty = seatChip("No players yet", "offline", "Hosting locally — add a seat to invite someone");
      empty.addEventListener("click", () => openSection("table"));
      ui.seatChips.append(empty);
      return;
    }
    for (const seat of seats.values()) {
      const live = seat.channel?.readyState === "open";
      const status = live ? "online" : seat.status === "gathering" ? "offline" : "waiting";
      const label = seat.pcAssetId && seat.playerName ? `${seat.name} — ${seat.playerName}` : seat.name;
      // Seats are named for their character — "Billy Bones" — and a chip has
      // room for a word, so it wears the first one and tells the whole story on hover.
      const chip = seatChip(String(seat.name).split(/\s+/)[0] || "Seat", status,
        live ? `${label} is at the table` : `${label} has not connected yet`);
      // A chip is the way back to that seat's codes, which is the only thing you
      // ever want from one that has not arrived.
      chip.addEventListener("click", () => { openSection("table"); });
      ui.seatChips.append(chip);
    }
  }

  function seatChip(label, status, title) {
    const chip = document.createElement("button");
    chip.type = "button"; chip.className = "seat-chip"; chip.dataset.status = status; chip.title = title;
    const dot = document.createElement("i");
    const text = document.createElement("span"); text.textContent = label;
    chip.append(dot, text);
    return chip;
  }

  function encodeCode(value) {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  function decodeCode(code) {
    const binary = atob(code.trim().replace(/\s/g, ""));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  function waitForIce(peer) {
    if (peer.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const timeout = setTimeout(resolve, 8000);
      const onChange = () => {
        if (peer.iceGatheringState === "complete") {
          clearTimeout(timeout);
          peer.removeEventListener("icegatheringstatechange", onChange);
          resolve();
        }
      };
      peer.addEventListener("icegatheringstatechange", onChange);
    });
  }

  async function copyText(text, message = "Copied") {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const temp = document.createElement("textarea");
      temp.value = text; document.body.append(temp); temp.select(); document.execCommand("copy"); temp.remove();
    }
    showToast(message);
  }

  // ---------------------------------------------------------------------------
  // View as player — the DM's rehearsal. Everything that decides what to reveal
  // reads isDM(), so flipping one flag and re-rendering is the whole mechanism.
  // Nothing here touches boardState, so nothing here can reach the table.
  // ---------------------------------------------------------------------------

  function setPlayerPreview(on) {
    const next = role === "host" && Boolean(on);
    if (next === previewAsPlayer) return;
    previewAsPlayer = next;
    document.body.classList.toggle("previewing-player", previewAsPlayer);
    syncRoleChrome();
    // Anything already on screen keeps showing what it was showing until it is
    // told otherwise, and a stale panel is exactly how a secret survives the
    // toggle. The tooltip is the sharp one: it is drawn on hover and left up, so
    // the token under the cursor when the switch is thrown would still be
    // wearing the DM's read of it.
    ui.actorTooltip.hidden = true;
    if (previewAsPlayer) {
      closeBrowsers();
      if (sheetIsOpen() && !canViewActorSheet(sheetActor())) closeActorSheet();
    }
    applyPermissions();
    if (actorLibrary.size) renderAssetLibrary();
    renderBoard();
    if (sheetIsOpen()) updateActorSheet();
    showToast(previewAsPlayer ? "Seeing the table as a player sees it" : "Back to the DM's view");
  }

  // The sidebar's own label is part of what a player sees, so it follows isDM();
  // the preview button and bar are the DM's scaffolding around the illusion and
  // follow the real role — deliberately not .dm-only, or the preview would hide
  // its own way out.
  function syncRoleChrome() {
    ui.roleEyebrow.textContent = isDM() ? "Dungeon Master" : "Player";
    ui.previewButton.hidden = role !== "host" || previewAsPlayer;
    ui.previewButton.setAttribute("aria-pressed", String(previewAsPlayer));
    ui.previewBar.hidden = !previewAsPlayer;
    ui.whoRole.textContent = isDM() ? "DM" : "Player";
    ui.whoName.textContent = seatName();
    ui.whoNameInput.value = seatName();
    ui.whoNameInput.placeholder = isDM() ? "Dungeon Master" : "Player";
    // Saving is the DM writing the campaign back to disk; it is not a player's
    // to press even once it works.
    ui.saveBoard.hidden = !isDM();
    renderSaveButton();
    renderSeatChips();
  }

  // What this browser is called at the table. The host had no name at all before
  // — seats did, the DM did not — so their rolls went into the history as
  // "Host". It is local to this browser: a name is not board state.
  const NAME_KEY = "laramie-board-name";

  function seatName() {
    const stored = localStorage.getItem(NAME_KEY);
    if (stored) return stored;
    return role === "host" ? "Dungeon Master" : (ui.playerName.value.trim() || "Player");
  }

  function setSeatName(raw) {
    const name = String(raw || "").replace(/\s+/g, " ").trim().slice(0, 32);
    if (name) localStorage.setItem(NAME_KEY, name); else localStorage.removeItem(NAME_KEY);
    syncRoleChrome();
  }

  function chooseMode(nextRole) {
    role = nextRole;
    // Joining as a player for real makes the rehearsal meaningless.
    if (role !== "host" && previewAsPlayer) {
      previewAsPlayer = false;
      document.body.classList.remove("previewing-player");
    }
    syncRoleChrome();
    location.hash = nextRole === "host" ? "#/host" : "#/join";
    ui.chooseHost.classList.toggle("active", role === "host");
    ui.choosePlayer.classList.toggle("active", role === "player");
    ui.hostLobby.hidden = role !== "host";
    ui.playerLobby.hidden = role !== "player";
    applyPermissions();
    renderSeatChips();
    // Card tooltips carry DM copy for the host and nothing but names for a player.
    if (actorLibrary.size) renderAssetLibrary();
    renderAffiliations();
  }

  function makePeer() {
    // Deliberately no STUN/TURN servers: this edition uses GitHub Pages only.
    return new RTCPeerConnection({ iceServers: [] });
  }

  async function seatPlayers() {
    for (const config of campaign?.seats || []) {
      if ([...seats.values()].some((seat) => seat.pcAssetId === config.pcAssetId)) continue;
      await createSeat(config);
    }
  }

  function bindSeatPc(seat) {
    if (!seat?.pcAssetId) return;
    let changed = false;
    for (const actor of boardState.actors) {
      if (actor.assetId === seat.pcAssetId && actor.controller !== seat.id) { actor.controller = seat.id; changed = true; }
    }
    if (changed) broadcastState();
  }

  function unbindSeatPc(seat) {
    if (!seat?.pcAssetId) return;
    let changed = false;
    for (const actor of boardState.actors) {
      if (actor.assetId === seat.pcAssetId && actor.controller === seat.id) { actor.controller = "host"; changed = true; }
    }
    if (changed) broadcastState();
  }

  function bindAllSeatPcs() {
    for (const seat of seats.values()) {
      if (seat.pcAssetId && seat.channel?.readyState === "open") {
        for (const actor of boardState.actors) if (actor.assetId === seat.pcAssetId) actor.controller = seat.id;
      }
    }
  }

  async function createSeat(options = {}) {
    // A campaign seat keeps its own id, so an encounter that hands a token to
    // `controller: nickles` still means Nickles' seat after a reconnect. Extra
    // seats the DM adds by hand get a generated one.
    const id = options.id && !seats.has(options.id) ? options.id : `seat-${Date.now().toString(36)}-${++seatCounter}`;
    const peer = makePeer();
    const channel = peer.createDataChannel("laramie-board", { ordered: true });
    // `pinnedLayer` empty is the normal state and means "follow your own
    // character". Only the DM's bring-the-table button ever fills it in.
    const seat = { id, peer, channel, name: options.name || `Player ${seats.size + 1}`, pcAssetId: options.pcAssetId || null, playerName: "", status: "gathering", offer: "", pinnedLayer: "" };
    seats.set(id, seat);
    bindHostChannel(seat);
    peer.addEventListener("connectionstatechange", () => updateSeatConnection(seat));
    renderSeats();

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await waitForIce(peer);
    seat.offer = encodeCode({ v: 1, kind: "offer", seatId: id, description: peer.localDescription });
    seat.status = "waiting";
    renderSeats();
    renderSeatChips();
  }

  function bindHostChannel(seat) {
    seat.channel.addEventListener("open", () => {
      seat.status = "online";
      seat.lastFogPacked = "";
      // A seat that has just connected has no band array yet, and recomputeFog
      // is a no-op unless something marked it dirty — without this the new seat
      // would fall through stateForSeat's `!bands` guard and be handed the
      // unfiltered board, which is the exact thing this feature exists to stop.
      FOG.dirty = true;
      recomputeFog();
      send(seat.channel, { type: "state", state: stateForSeat(seat) });
      bindSeatPc(seat);
      renderSeats(); renderConnected(); updateHostStatus();
      openBoard();
    });
    seat.channel.addEventListener("message", (event) => handleHostMessage(seat, event.data));
    seat.channel.addEventListener("close", () => { seat.status = "closed"; unbindSeatPc(seat); renderSeats(); renderConnected(); updateHostStatus(); });
  }

  function updateSeatConnection(seat) {
    if (["failed", "disconnected", "closed"].includes(seat.peer.connectionState)) {
      seat.status = seat.peer.connectionState;
      renderSeats(); renderConnected(); updateHostStatus();
    }
  }

  function renderSeats() {
    ui.seatList.replaceChildren();
    for (const seat of seats.values()) {
      const card = document.createElement("article"); card.className = "seat-card"; card.dataset.id = seat.id;
      const heading = document.createElement("h3");
      const name = document.createElement("span"); name.textContent = seat.name;
      const state = document.createElement("span"); state.className = `seat-state ${seat.status === "online" ? "online" : ""}`; state.textContent = seat.status;
      heading.append(name, state); card.append(heading);
      if (seat.status === "gathering") {
        const note = document.createElement("span"); note.className = "muted"; note.textContent = "Preparing connection code…"; card.append(note);
      } else if (seat.status === "waiting") {
        const offer = document.createElement("textarea"); offer.readOnly = true; offer.value = seat.offer; offer.setAttribute("aria-label", "Offer code");
        const answer = document.createElement("textarea"); answer.placeholder = "Paste this player's answer"; answer.setAttribute("aria-label", "Player answer code");
        const actions = document.createElement("div"); actions.className = "seat-actions";
        const copy = button("Copy offer", () => copyText(seat.offer, "Offer copied"));
        const connect = button("Connect answer", () => acceptAnswer(seat, answer.value));
        actions.append(copy, connect); card.append(offer, answer, actions);
      } else if (seat.status === "online") {
        const note = document.createElement("span"); note.className = "muted"; note.textContent = "Direct connection established."; card.append(note);
      } else {
        const retry = button("Remove seat", () => removeSeat(seat.id)); retry.className += " wide"; card.append(retry);
      }
      ui.seatList.append(card);
    }
  }

  function button(label, action) {
    const element = document.createElement("button"); element.type = "button"; element.className = "button"; element.textContent = label; element.addEventListener("click", action); return element;
  }

  async function acceptAnswer(seat, rawCode) {
    try {
      const answer = decodeCode(rawCode);
      if (answer.kind !== "answer" || answer.seatId !== seat.id) throw new Error("This answer belongs to a different seat.");
      await seat.peer.setRemoteDescription(answer.description);
      seat.status = "connecting"; renderSeats(); renderSeatChips();
    } catch (error) { showToast(error.message || "That answer code is invalid"); }
  }

  function removeSeat(id) {
    const seat = seats.get(id); if (!seat) return;
    unbindSeatPc(seat);
    seat.channel?.close(); seat.peer?.close(); seats.delete(id); renderSeats(); renderConnected(); updateHostStatus();
  }

  async function createPlayerAnswer() {
    try {
      const offer = decodeCode(ui.offerInput.value);
      if (offer.kind !== "offer") throw new Error("That is not a host offer code.");
      playerSeatId = offer.seatId;
      playerPeer?.close();
      playerPeer = makePeer();
      playerPeer.addEventListener("datachannel", (event) => {
        playerChannel = event.channel;
        bindPlayerChannel(playerChannel);
      });
      playerPeer.addEventListener("connectionstatechange", () => {
        const value = playerPeer.connectionState;
        if (["failed", "disconnected", "closed"].includes(value)) renderSeatChips();
      });
      await playerPeer.setRemoteDescription(offer.description);
      const answer = await playerPeer.createAnswer();
      await playerPeer.setLocalDescription(answer);
      await waitForIce(playerPeer);
      ui.answerOutput.value = encodeCode({ v: 1, kind: "answer", seatId: offer.seatId, description: playerPeer.localDescription });
      ui.answerBlock.hidden = false;
      renderSeatChips();
      showToast("Answer ready—send it to the host");
    } catch (error) { showToast(error.message || "That offer code is invalid"); }
  }

  function bindPlayerChannel(channel) {
    channel.addEventListener("open", () => {
      send(channel, { type: "hello", name: ui.playerName.value.trim() || "Player" });
      renderSeatChips();
      openBoard();
    });
    channel.addEventListener("message", (event) => handlePlayerMessage(event.data));
    channel.addEventListener("close", () => renderSeatChips());
  }

  function send(channel, message) {
    if (channel?.readyState === "open") channel.send(JSON.stringify(message));
  }

  function handleHostMessage(seat, raw) {
    try {
      const message = JSON.parse(raw);
      if (message.type === "hello") { seat.playerName = String(message.name || "").slice(0, 32); if (!seat.pcAssetId) seat.name = seat.playerName || seat.name; renderSeats(); renderConnected(); }
      if (message.type === "intent" && message.action === "moveActor") moveActor(message.actorId, message.x, message.y, seat.id, message.layerId);
      if (message.type === "intent" && message.action === "moveActors") moveActors(message.moves, seat.id);
      if (message.type === "intent" && message.action === "rotateActor") rotateActor(message.actorId, message.rotation, seat.id);
      if (message.type === "intent" && message.action === "updateActor") updateActorFromPlayer(seat, message.actorId, message.patch);
      if (message.type === "intent" && message.action === "addEffect") applyEffectRegion(message.region);
      if (message.type === "intent" && message.action === "removeEffect") { boardState.effects = boardState.effects.filter((region) => region.id !== message.id); broadcastState(); }
      if (message.type === "intent" && message.action === "clearEffects") { const layer = boardState.layers.some((item) => item.id === message.layerId) ? message.layerId : activeLayerId(); boardState.effects = boardState.effects.filter((region) => region.layerId !== layer); broadcastState(); }
      if (message.type === "intent" && message.action === "takeExit") takeExit(message.actorId, message.exitId, seat.id);
      if (message.type === "intent" && message.action === "rollDice") publishDiceRoll(message.roll?.roller || seat.name || "Player", message.roll);
      if (message.type === "requestState") { seat.lastFogPacked = ""; FOG.dirty = true; recomputeFog(); send(seat.channel, { type: "state", state: stateForSeat(seat) }); }
    } catch { /* Ignore malformed peer messages. */ }
  }

  function updateActorFromPlayer(seat, actorId, patch = {}) {
    const actor = boardState.actors.find((item) => item.id === actorId);
    if (!actor || actor.controller !== seat.id) return;
    // Health travels up from a seat only for an actor that seat controls — its
    // player tracks their own PC and their own animals. The host still writes it,
    // and clamps against the maximum it owns, so a seat can never invent hit points.
    const setHp = (value) => { actor.hp = { current: Math.max(0, Math.min(actor.hp.max, Math.trunc(value))), max: actor.hp.max }; };
    if (Number.isFinite(patch.hpDelta) && patch.hpDelta) setHp(actor.hp.current + patch.hpDelta);
    if (Number.isFinite(patch.hpCurrent)) setHp(patch.hpCurrent);
    if (typeof patch.name === "string" && patch.name.trim()) actor.name = patch.name.trim().slice(0, 40);
    if (typeof patch.inventory === "string") actor.inventory = patch.inventory.slice(0, 4000);
    if (typeof patch.notes === "string") actor.notes = patch.notes.slice(0, 4000);
    if (["north", "east", "south", "west"].includes(patch.rotation)) actor.rotation = patch.rotation;
    broadcastState();
  }

  // What the current frame is showing. When this changes, the DM has moved the
  // table and the map underneath us is a different size — so refit rather than
  // stranding the player at the old pan and zoom.
  function sceneKey() {
    const layer = activeLayer();
    // The plate under a transparent storey is what actually sizes the board, so
    // it belongs in the key — otherwise switching to a see-through floor keeps
    // the old pan and zoom against a differently-sized base.
    const base = layerUnder(layer);
    return `${boardState.encounter?.id || ""}|${layer?.url || ""}|${layer?.overlayUrl || ""}|${base?.url || ""}`;
  }

  function handlePlayerMessage(raw) {
    try {
      const message = JSON.parse(raw);
      if (message.type !== "state") return;
      const fog = message.state?.fog;
      if (fog && typeof fog.bands === "string" && fog.bands) {
        try {
          remoteFog = {
            layerId: String(fog.layerId || ""),
            columns: Math.max(1, Math.round(Number(fog.columns) || 0)),
            rows: Math.max(1, Math.round(Number(fog.rows) || 0)),
            bands: unpackBands(fog.bands, Math.round(Number(fog.columns) || 0) * Math.round(Number(fog.rows) || 0))
          };
        } catch { remoteFog = null; }
      }
      const previousEncounter = boardState.encounter?.id;
      boardState = message.state;
      for (const actor of boardState.actors || []) actor.facts = normalizeFacts(actor.facts);
      boardState.affiliations = normalizeAffiliations(boardState.affiliations);

      const key = sceneKey();
      if (key !== lastSceneKey) {
        lastSceneKey = key;
        initialFitDone = false;
        if (boardState.encounter?.id && boardState.encounter.id !== previousEncounter) {
          showToast(`The table moved to ${boardState.encounter.title}`);
        }
      }
      showBoard();
      renderBoard();
    } catch { /* Ignore malformed host messages. */ }
  }

  function broadcastState() {
    boardState.revision += 1;
    // Before the render and before the send: both need the field current, and
    // this is the one place every mutation already funnels through.
    recomputeFog();
    saveHostState(); renderBoard();
    for (const seat of seats.values()) send(seat.channel, { type: "state", state: stateForSeat(seat) });
  }

  // The snapshot one seat is allowed to have.
  //
  // Terrain is not secret and cannot be: the map plates are static files on a
  // public web root, and a player who wants the layout can fetch the PNG. What
  // IS secret is where things are standing, and that is the leak this closes —
  // a kobold two rooms away is not in the array at all, so devtools shows a
  // player nothing their character has not seen.
  //
  // The floor this seat's screen is pointed at is decided here and nowhere
  // else, and `activeLayer` is overwritten with it on the way out — so the
  // player's board, sheet, effects and darkness all agree without a single one
  // of them learning that floors are now per seat.
  //
  // When fog is off and the seat is on the DM's own floor this returns the very
  // object the board has always sent, so the old path stays the proven one.
  function stateForSeat(seat) {
    const layerId = viewLayerForSeat(seat);
    const base = layerId === boardState.activeLayer
      ? boardState
      : { ...boardState, activeLayer: layerId };
    if (!fogActive(layerId)) return base;
    const bands = FOG.fields.get(layerId)?.bands.get(seat.id);
    if (!bands) return base;
    // Shallow on purpose: layers, rolls, affiliations and grid ride along by
    // reference, and JSON.stringify in send() does not care.
    const state = { ...base, actors: actorsForSeat(seat, bands, layerId) };
    // Keyed by floor as well as by content: a seat that walks downstairs onto a
    // cellar whose bands happen to pack identically still needs the new field,
    // or its screen keeps drawing the barroom's darkness.
    const packed = `${layerId}|${packBands(bands)}`;
    if (packed !== seat.lastFogPacked) {
      seat.lastFogPacked = packed;
      state.fog = {
        ...boardState.fog, layerId,
        columns: FOG.columns, rows: FOG.rows, bands: packed.slice(layerId.length + 1)
      };
    }
    return state;
  }

  function coversAnySeenCell(actor, bands) {
    const footprint = actorFootprint(actor);
    const x0 = Math.floor(actor.x), y0 = Math.floor(actor.y);
    for (let dy = 0; dy < Math.max(1, Math.ceil(footprint.height)); dy += 1) {
      for (let dx = 0; dx < Math.max(1, Math.ceil(footprint.width)); dx += 1) {
        const x = x0 + dx, y = y0 + dy;
        if (x < 0 || y < 0 || x >= FOG.columns || y >= FOG.rows) continue;
        if (bands[idx(x, y, FOG.columns)] >= DIM) return true;
      }
    }
    return false;
  }

  function actorsForSeat(seat, bands, layerId) {
    const kept = boardState.actors.filter((actor) => {
      // The party is a roster, not a token list — you have to be able to see
      // who is missing, and a marching order is a thing players talk about out
      // loud. Losing sight of your own friend round a corner is worse at the
      // table than the small infidelity of keeping them on screen.
      if (isPartyMember(actor) || actor.controller === seat.id) return true;
      // A transparent storey shows the floor below through its gaps, so that
      // floor's actors have to reach the seat for its board to draw them. Which
      // of them are actually painted is decided there, against the same mask
      // the DM's screen uses — see `drawnHere`.
      const seen = new Set(layersSeenFrom(layerId));
      if (actor.layerId && !seen.has(actor.layerId)) return false;
      return coversAnySeenCell(actor, bands);
    });
    // A chest that was filtered out has to take its contents with it. Without
    // this, isHiddenInContainer cannot find the parent, returns false, and
    // spills the contents onto the floor — publishing the very secret the
    // container was keeping.
    const ids = new Set(kept.map((actor) => actor.id));
    return kept.filter((actor) => !actor.parent || ids.has(actor.parent));
  }

  function requestDiceRoll(rawRoll) {
    if (role === "host") { publishDiceRoll(rawRoll.roller || "Host", rawRoll); return; }
    if (playerChannel?.readyState !== "open") { showToast("Connect to the host before rolling"); return; }
    send(playerChannel, { type: "intent", action: "rollDice", roll: rawRoll });
  }

  function publishDiceRoll(rawRoller, rawRoll = {}) {
    const allowedSides = new Set([4, 6, 8, 10, 12, 20, 100]);
    const allowedModes = new Set(["normal", "advantage", "disadvantage"]);
    // Advantage/disadvantage is PER die type: a die type set to advantage rolls
    // twice as many dice and keeps the highest N (lowest N for disadvantage).
    let groups = Array.isArray(rawRoll.groups) ? rawRoll.groups.slice(0, 8).map((group) => ({
      qty: Math.max(0, Math.min(20, Math.floor(Number(group.qty) || 0))),
      sides: Number(group.sides),
      mode: allowedModes.has(group.mode) ? group.mode : "normal"
    })).filter((group) => group.qty && allowedSides.has(group.sides)) : [];
    // Cap total PHYSICAL dice at 40 (an adv/dis die type rolls two per die).
    let physCount = 0; const capped = [];
    for (const group of groups) {
      const per = group.mode === "normal" ? 1 : 2;
      const qty = Math.min(group.qty, Math.floor((40 - physCount) / per));
      if (qty <= 0) break;
      capped.push({ ...group, qty }); physCount += qty * per;
    }
    groups = capped;
    if (!groups.length) return;
    const modifier = Math.max(-20, Math.min(20, Math.trunc(Number(rawRoll.modifier) || 0)));
    // The roller's client already tumbled these dice and read the settled faces;
    // trust those so the shown total matches the animation. Fall back to a secure
    // draw only where a physical value is missing.
    const providedDice = Array.isArray(rawRoll.dice) ? rawRoll.dice : null;
    let providedIndex = 0;
    const nextFace = (sides) => {
      const candidate = providedDice ? providedDice[providedIndex] : null;
      providedIndex += 1;
      const usable = candidate && Number(candidate.sides) === sides
        && Number.isInteger(candidate.value) && candidate.value >= 1 && candidate.value <= sides;
      return usable ? candidate.value : secureDie(sides);
    };
    const dice = []; let subtotal = 0;
    for (const group of groups) {
      const per = group.mode === "normal" ? 1 : 2;
      const rolled = Array.from({ length: group.qty * per }, () => nextFace(group.sides));
      if (group.mode === "normal") {
        rolled.forEach((value) => { dice.push({ sides: group.sides, value, kept: true }); subtotal += value; });
      } else {
        // rolled 2×qty faces — keep the best/worst `qty` of them
        const order = rolled.map((value, index) => index)
          .sort((a, b) => group.mode === "disadvantage" ? rolled[a] - rolled[b] : rolled[b] - rolled[a]);
        const keptSet = new Set(order.slice(0, group.qty));
        rolled.forEach((value, index) => {
          const kept = keptSet.has(index);
          dice.push({ sides: group.sides, value, kept });
          if (kept) subtotal += value;
        });
      }
    }
    const formula = groups.map((group) =>
      `${group.qty}d${group.sides}${group.mode === "advantage" ? " adv" : group.mode === "disadvantage" ? " dis" : ""}`
    ).join(" + ") + (modifier ? ` ${modifier > 0 ? "+" : "−"} ${Math.abs(modifier)}` : "");
    const roll = {
      id: crypto.randomUUID(), roller: String(rawRoller || "Player").slice(0, 32), groups, dice, modifier,
      total: subtotal + modifier, formula, origin: typeof rawRoll.origin === "string" ? rawRoll.origin : "", createdAt: Date.now()
    };
    boardState.rolls.push(roll); boardState.rolls = boardState.rolls.slice(-30); broadcastState();
  }

  function secureDie(sides) {
    const limit = Math.floor(0x100000000 / sides) * sides;
    const value = new Uint32Array(1);
    do crypto.getRandomValues(value); while (value[0] >= limit);
    return value[0] % sides + 1;
  }

  // Advantage and disadvantage are per die type, so one roll can carry both. The
  // formula spells the mode out as " adv"/" dis" for the history line; the popups
  // lift it onto its own badge instead, where a glance can catch it.
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

  function renderSharedRolls() {
    const rolls = boardState.rolls || [];
    window.dispatchEvent(new CustomEvent("laramie:dice-history", { detail: rolls }));
    const latest = rolls.at(-1);
    if (!rollsInitialized) { rollsInitialized = true; lastAnnouncedRollId = latest?.id || ""; return; }
    if (!latest || latest.id === lastAnnouncedRollId) return;
    lastAnnouncedRollId = latest.id;
    ui.rollRoller.replaceChildren(
      document.createTextNode(`${latest.roller} rolled ${plainFormula(latest.formula)}`),
      ...rollModeTags(latest)
    );
    ui.rollTotal.textContent = latest.total;
    const values = latest.dice.map((die) => die.kept === false ? `(${die.value})` : die.value).join(", ");
    ui.rollDetail.textContent = `Rolled: ${values}`;
    ui.rollAnnouncement.hidden = false;
    requestAnimationFrame(() => ui.rollAnnouncement.classList.add("show"));
    clearTimeout(rollAnnouncementTimer);
    rollAnnouncementTimer = window.setTimeout(() => {
      ui.rollAnnouncement.classList.remove("show");
      window.setTimeout(() => { ui.rollAnnouncement.hidden = true; }, 220);
    }, 5000);
    window.dispatchEvent(new CustomEvent("laramie:dice-broadcast", { detail: latest }));
  }

  function updateHostStatus() {
    renderSeatChips();
  }

  function renderConnected() {
    ui.connectedList.replaceChildren();
    const online = [...seats.values()].filter((seat) => seat.channel?.readyState === "open");
    if (!online.length) { const empty = document.createElement("span"); empty.className = "muted"; empty.textContent = "No players connected"; ui.connectedList.append(empty); if (sheetIsOpen()) updateActorSheet(); return; }
    for (const seat of online) {
      const row = document.createElement("div"); row.className = "connected-row";
      const dot = document.createElement("span"); dot.className = "token-swatch"; dot.style.background = "#7faf68";
      const label = seat.pcAssetId && seat.playerName ? `${seat.name} — ${seat.playerName}` : seat.name;
      const name = document.createElement("span"); name.textContent = label;
      const remove = button("×", () => removeSeat(seat.id)); remove.className = "remove-token"; remove.title = "Disconnect";
      row.append(dot, name, remove); ui.connectedList.append(row);
    }
    // A seat coming or going changes who the sheet may hand this actor to.
    if (sheetIsOpen()) updateActorSheet();
  }

  function openBoard() {
    ui.lobby.hidden = true; ui.controls.hidden = false; ui.navRail.hidden = false; showBoard();
  }

  function showBoard() {
    if (!activeLayer()) { ui.emptyBoard.hidden = false; ui.surface.hidden = true; renderSharedRolls(); return; }
    ui.emptyBoard.hidden = true; ui.surface.hidden = false; loadMap(activeLayer()); renderSharedRolls();
  }

  // A tiled level is stitched into one plate once and cached by layer id, so the
  // rest of the board never learns that some maps arrive in pieces. Keyed by the
  // tile urls too, so revised art replaces a stale stitch.
  const stitched = new Map();

  function stitchKey(layer) {
    return layer.tiles.map((tile) => `${tile.col},${tile.row}:${tile.url}`).join("|");
  }

  async function stitchTiles(layer) {
    const key = stitchKey(layer);
    const cached = stitched.get(layer.id);
    if (cached && cached.key === key) return cached.url;
    const images = await Promise.all(layer.tiles.map((tile) => new Promise((resolve, reject) => {
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.onload = () => resolve({ image, col: tile.col, row: tile.row });
      image.onerror = () => reject(new Error(`tile ${tile.col},${tile.row} failed to load`));
      image.src = tile.url;
    })));
    // Tile size comes from the art rather than the manifest — the same reason
    // `dnd place map` measures the plate instead of trusting a declared size.
    const tileWidth = Math.max(...images.map((item) => item.image.naturalWidth));
    const tileHeight = Math.max(...images.map((item) => item.image.naturalHeight));
    // The plate is the size the BOARD says it is, not the bounding box of the
    // tiles that happen to exist. "A missing tile is empty ground, not an
    // error" (places/SCHEMA.md), and a level may cover only part of its grid —
    // the claim's surface is one tile at col 3 of a 4x2, so measuring the tiles
    // gave a plate half the declared height with rows 32-63 over nothing at all.
    // Falling back to the bounding box keeps a place with no board block working.
    const board = boardState.place?.board;
    const declaredWidth = Number(board?.columns) * Number(board?.squarePx);
    const declaredHeight = Number(board?.rows) * Number(board?.squarePx);
    const cols = Math.max(...images.map((item) => item.col)) + 1;
    const rows = Math.max(...images.map((item) => item.row)) + 1;
    const canvas = document.createElement("canvas");
    canvas.width = declaredWidth > 0 ? declaredWidth : tileWidth * cols;
    canvas.height = declaredHeight > 0 ? declaredHeight : tileHeight * rows;
    const context = canvas.getContext("2d");
    for (const item of images) {
      context.drawImage(item.image, item.col * tileWidth, item.row * tileHeight, tileWidth, tileHeight);
    }
    // A blob, not a data URL: this canvas is 3072x4096 for the warren, and the
    // base64 of it would be a ~16MB string held in memory and re-parsed on every
    // assignment. The old blob is revoked so a revised stitch does not leak it.
    const url = await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(URL.createObjectURL(blob)) : reject(new Error("canvas is empty")), "image/png");
    });
    if (cached?.url) URL.revokeObjectURL(cached.url);
    stitched.set(layer.id, { key, url });
    return url;
  }

  function loadMap(layer) {
    // A transparent storey takes the overlay slot and hands the base to the
    // level beneath it: `#map-image` draws the barroom, `#map-overlay` draws
    // the upstairs on top of it, and the negative space in the upper plate is
    // simply where you can see the ground floor. The two <img> elements were
    // already stacked in that order, so nothing new is drawn — what changes is
    // which plate goes in which slot.
    const under = layerUnder(layer);
    const overlayUrl = under ? layer.url : (layer?.overlayUrl || "");
    ui.overlay.hidden = !overlayUrl;
    if (overlayUrl && ui.overlay.getAttribute("src") !== overlayUrl) ui.overlay.src = overlayUrl;
    if (!overlayUrl) ui.overlay.removeAttribute("src");
    // The mask that decides who shows through the gaps, read off the very plate
    // just put in the overlay slot.
    if (under) ensureCoverage(layer);
    // Only the host computes vision, so only the host needs the wall plate.
    if (role === "host") for (const live of boardState.layers) loadOccluders(live);
    loadBase(under || layer);
  }

  // Whichever plate is the bottom of the stack. Split out so a transparent
  // storey can hand this its downstairs neighbour without the overlay slot
  // being rewritten by the neighbour's own overlay on the way through.
  function loadBase(layer) {
    if (layer?.tiles?.length) {
      const cached = stitched.get(layer.id);
      if (cached && cached.key === stitchKey(layer)) { setMapSrc(cached.url); return; }
      stitchTiles(layer)
        .then((url) => { if (baseLayerId() === layer.id) setMapSrc(url); })
        .catch((error) => showToast(`The map could not be assembled — ${error.message}`));
      return;
    }
    if (!layer?.url) return;
    setMapSrc(layer.url);
  }

  function setMapSrc(url) {
    if (ui.image.getAttribute("src") === url && ui.image.complete && ui.image.naturalWidth) return;
    ui.image.src = url;
  }

  function renderBoard() {
    syncControls();
    if (!ui.surface.hidden) loadMap(activeLayer());
    drawGrid(); renderEffects(); drawFog(); renderActors(); renderAffiliations(); renderSharedRolls();
    renderFogControls();
  }

  function syncControls() {
    renderLayerSwitch();
    renderNowPlaying();
    syncGridControls();
    syncRoleChrome();
    document.body.classList.toggle("rail-only", Boolean(view.railOnly));
    syncRail();
  }

  function syncGridControls() {
    const board = boardState.place?.board;
    const { columns, rows } = boardDimensions();
    ui.gridColumns.value = columns; ui.gridColumnsOutput.value = `${columns} squares`;
    ui.gridRows.value = rows; ui.gridRowsOutput.value = `${rows} squares`;
    ui.gridSize.value = boardState.grid.size; ui.gridSizeOutput.value = `${boardState.grid.size} px`;
    const feet = Number(board?.squareFt) || campaign?.defaults.squareSizeFt || 5;
    ui.gridFeet.value = feet; ui.gridFeetOutput.value = `${feet} ft`;
    ui.gridX.value = boardState.grid.offsetX; ui.gridXOutput.value = `${boardState.grid.offsetX} px`;
    ui.gridY.value = boardState.grid.offsetY; ui.gridYOutput.value = `${boardState.grid.offsetY} px`;
    ui.gridVisible.checked = view.grid.visible;
    ui.gridColor.value = view.grid.color;
    ui.gridStrength.value = view.grid.strength; ui.gridStrengthOutput.value = `${view.grid.strength}%`;
    ui.flatMinis.checked = view.flatMinis === true;
    ui.itemGlow.checked = view.itemGlow !== false;
  }

  function renderNowPlaying() {
    const encounter = boardState.encounter;
    ui.nowPlayingTitle.textContent = encounter?.title || "No encounter loaded";
    ui.encounterName.textContent = encounter?.title || "No encounter loaded";
    ui.nowPlayingPlace.textContent = boardState.place?.name
      || (can("loadEncounter") ? "Pick an encounter to set the table" : "Waiting for the DM");


    const status = encounter?.source === "draft" ? "draft (this browser)" : encounter?.status;
    ui.nowPlayingStatus.hidden = !status;
    ui.nowPlayingStatus.textContent = status || "";
    ui.nowPlayingStatus.dataset.status = encounter?.source === "draft" ? "draft" : (encounter?.status || "");

    const counts = encounter?.counts;
    const summary = counts ? countSummary(counts) : "";
    ui.nowPlayingCounts.hidden = !summary;
    ui.nowPlayingCounts.textContent = summary;
  }

  function countSummary(counts) {
    return [
      [counts.people, "people"], [counts.horses, "horses"], [counts.items, "items"]
    ].filter(([value]) => Number(value) > 0).map(([value, label]) => `${value} ${label}`).join(" · ");
  }

  // The DM's own camera. Cycling it moves nobody — a player's screen follows
  // their character, and a character follows an exit. The one way to override
  // that from here is the pin button below, which is deliberately a separate,
  // visible act rather than a side effect of looking at a floor.
  function renderLayerSwitch() {
    ui.layerSwitch.replaceChildren();
    const layers = boardState.layers || [];
    // Hidden rather than disabled for a player. A row of dead buttons showing a
    // floor they are not on and cannot reach is worse than no row at all — it
    // reads as something broken, and it is the exits below that answer the
    // question it looks like it is answering.
    ui.layerSwitch.hidden = !can("layerSwitch");
    for (const layer of layers) {
      const control = button(layer.name, () => {
        if (!can("layerSwitch") || boardState.activeLayer === layer.id) return;
        boardState.activeLayer = layer.id; FOG.dirty = true; initialFitDone = false; broadcastState();
      });
      control.className = `layer-button ${layer.id === boardState.activeLayer ? "active" : ""}`;
      control.disabled = !can("layerSwitch");
      // Who is standing on a floor is most of what the DM needs to know before
      // switching to it, and counting tokens by eye across three storeys is how
      // a priest gets forgotten in a cellar for an hour.
      const here = boardState.actors.filter((actor) => actor.layerId === layer.id).length;
      if (here && can("layerSwitch")) {
        const tally = document.createElement("span");
        tally.className = "layer-count";
        tally.textContent = String(here);
        tally.title = `${here} on this floor`;
        control.append(tally);
      }
      ui.layerSwitch.append(control);
    }

    const pinned = tableIsPinned();
    if (ui.pinTable) {
      ui.pinTable.hidden = !can("layerSwitch") || !layers.length;
      ui.pinTable.textContent = pinned ? "Let them follow their characters" : "Bring the table to this floor";
      ui.pinTable.classList.toggle("active", pinned);
    }
    ui.layerHint.textContent = !layers.length
      ? "No floors until an encounter is loaded."
      : can("layerSwitch")
        ? (pinned
          ? "Every screen is held on your floor. Release it and each player goes back to their own character's."
          : "Yours alone. Every player sees the floor their character is standing on, and changes it by taking an exit.")
        : "You see the floor your character is standing on. Take an exit to change it.";
    renderExitList();
  }

  // The ways off this floor, for whoever is looking. A player is offered what
  // their own character is standing on; the DM is offered what the token they
  // have selected is standing on, so a priest can be walked up out of the
  // cellar without giving anyone a floor switcher.
  function renderExitList() {
    if (!ui.exitList) return;
    ui.exitList.replaceChildren();
    const actor = exitSubject();
    const available = actor ? exitsUnder(actor) : [];

    // A place with no exits authored anywhere says nothing at all — unless the
    // DM can draw one, in which case the empty section is the invitation.
    // "You are not standing on a way off this floor" is otherwise a permanent
    // notice about a feature nobody used.
    const anyExits = (boardState.layers || []).some((layer) => layer.exits?.length);
    ui.exitSection.hidden = !anyExits && !canAuthorPlace();
    renderExitTool();
    for (const exit of available) {
      const destination = layerNamed(exit.to.layerId)?.name || exit.to.layerId;
      // The label is the author's sentence and is printed exactly as written.
      // The destination goes underneath it rather than into it, so "Teleport to
      // cabbage land" never becomes "Teleport to cabbage land (The Gambling
      // Cellar)" and gives its own joke away.
      const control = button(exit.label, () => requestExit(actor.id, exit.id));
      control.className = "exit-button";
      const where = document.createElement("span");
      where.className = "exit-destination";
      where.textContent = destination;
      control.append(where);
      ui.exitList.append(control);
    }

    ui.exitHint.textContent = !actor
      ? (isDM() ? "Select a token to see the ways off its floor." : "Nothing of yours is on the board yet.")
      : available.length
        ? (isDM() ? `${actor.name} is standing on a way off this floor.` : "")
        : `${isDM() ? `${actor.name} is` : "You are"} not standing on a way off this floor.`;
    ui.exitHint.hidden = !ui.exitHint.textContent;
  }

  // The DM's half of the Ways out section: drawing one. Hidden outright for a
  // player, and for a DM with no helper listening — a tool that cannot write
  // anywhere is worse than no tool, and the hint says which is the case.
  function renderExitTool() {
    if (!ui.addExit) return;
    const allowed = canAuthorPlace();
    ui.addExit.hidden = !isDM() || !boardState.place?.id;
    ui.addExit.disabled = !allowed;
    ui.addExit.textContent = brushMode === "exit" ? "Stop drawing" : "Draw an exit";

    const hint = !isDM() || !boardState.place?.id ? ""
      : !saveHelper ? "Run `dnd encounter serve` beside the table to draw exits."
        : brushMode !== "exit" ? "Writes to the place, so every encounter here gets it."
          : exitDraft
            ? `Near end on ${layerNamed(exitDraft.from.layerId)?.name || exitDraft.from.layerId} ${exitDraft.from.x},${exitDraft.from.y}. Switch floors and click where it comes out.`
            : "Click the square it leaves from — or an exit already there to remove it.";
    ui.addExitHint.textContent = hint;
    ui.addExitHint.hidden = !hint;
  }

  // Whose feet the exit list is read from. The DM's selection, so they can move
  // an NPC; otherwise the seat's own character.
  function exitSubject() {
    // One at a time on purpose. Marching the whole selection down a stair reads
    // as a convenience right up until half of it was standing on the landing
    // and the other half was not, and the board has silently split the party.
    if (isDM()) return selectedActors().length === 1 ? selectedActor() : null;
    // On the host this is the player preview, which is only meaningful once it
    // says which player — the same reason fog bands are previewed per seat.
    const seatId = role === "host" ? view.fog.previewSeatId : playerSeatId;
    const mine = boardState.actors.filter((actor) => seatId && actor.controller === seatId);
    return mine.find((actor) => !actor.parent) || mine[0] || null;
  }

  // Sections a player may not use are removed outright rather than hidden, and
  // Grid Settings opens for the DM but starts closed for a player.
  // `grid: null` means "open for the DM, collapsed for a player" — a player wants
  // the board, not six sliders, but the DM is setting the table.
  // Floor and the party are what you touch every few minutes; the rest is
  // set-up. `null` means "open for the DM, shut for a player".
  const DEFAULT_OPEN_SECTIONS = {
    floor: true, party: true, library: null,
    encounter: false, environment: false, affiliations: false, table: false
  };

  // Remembered per role: sitting down as a player in a browser that has hosted
  // should not inherit the DM's open sections.
  function sectionState() {
    if (!view.sections[role] || typeof view.sections[role] !== "object") view.sections[role] = {};
    return view.sections[role];
  }

  function applyPermissions() {
    const stored = sectionState();
    for (const section of document.querySelectorAll(".nav-section")) {
      const allowed = section.dataset.scope !== "dm" || isDM();
      section.hidden = !allowed;
      if (!allowed) continue;
      const key = section.dataset.section;
      const remembered = stored[key];
      const fallback = DEFAULT_OPEN_SECTIONS[key];
      section.open = typeof remembered === "boolean" ? remembered : (fallback === null ? isDM() : Boolean(fallback));
    }
    for (const element of document.querySelectorAll(".dm-only")) element.hidden = !isDM();
    ui.gridGeometry.hidden = !can("gridGeometry");
    // A rail button for a section this screen may not open would be a locked
    // door with a sign on it.
    for (const control of ui.navRail.querySelectorAll(".rail-button")) {
      const section = sectionElement(control.dataset.opens);
      control.hidden = !section || section.hidden;
    }
    syncRail();
  }

  // ---------------------------------------------------------------------------
  // The rail. Collapsed, the sidebar is a column of icons rather than nothing at
  // all — which is the whole point: shutting the panel to see more map used to
  // cost you the floor switcher and the library with it. Each icon opens its own
  // section; pressing the one already showing shuts the panel again.
  // ---------------------------------------------------------------------------

  function sectionElement(id) {
    return id ? document.querySelector(`.nav-section[data-section="${id}"]`) : null;
  }

  function railOnly() {
    return document.body.classList.contains("rail-only");
  }

  function setRailOnly(on) {
    document.body.classList.toggle("rail-only", Boolean(on));
    view.railOnly = Boolean(on);
    saveView(); syncRail();
    // The map's share of the window just changed; the fit has to follow it.
    setTimeout(fitMap, 60);
  }

  function syncRail() {
    const collapsed = railOnly();
    ui.railToggle.setAttribute("aria-expanded", String(!collapsed));
    ui.railToggle.setAttribute("aria-label", collapsed ? "Open the menu" : "Collapse the menu");
    for (const control of ui.navRail.querySelectorAll(".rail-button")) {
      const section = sectionElement(control.dataset.opens);
      control.classList.toggle("active", Boolean(section?.open) && !collapsed);
      control.setAttribute("aria-expanded", String(Boolean(section?.open) && !collapsed));
    }
  }

  // Open one section and put it where the eye is. Called by the rail, and by
  // anything that wants to send the DM somewhere — a seat chip to the seat list,
  // for instance.
  function openSection(id) {
    const section = sectionElement(id);
    if (!section || section.hidden) return;
    if (railOnly()) setRailOnly(false);
    section.open = true;
    sectionState()[id] = true; saveView(); syncRail();
    section.scrollIntoView({ block: "nearest" });
  }

  function setWhoMenu(open) {
    ui.whoDropdown.hidden = !open;
    ui.whoButton.setAttribute("aria-expanded", String(Boolean(open)));
  }

  function toggleSection(id) {
    const section = sectionElement(id);
    if (!section || section.hidden) return;
    if (!railOnly() && section.open) { section.open = false; sectionState()[id] = false; saveView(); syncRail(); return; }
    openSection(id);
  }

  // Geometry is shared (it is the coordinate system every token position is in);
  // colour, strength, and whether the grid shows at all are personal to this
  // browser and never leave it.
  function drawGrid() {
    if (!mapSize.width) return;
    const canvas = ui.canvas; const context = canvas.getContext("2d");
    canvas.width = mapSize.width; canvas.height = mapSize.height;
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (!view.grid.visible) return;
    const { size, offsetX, offsetY } = boardState.grid;
    context.strokeStyle = view.grid.color; context.globalAlpha = view.grid.strength / 100; context.lineWidth = Math.max(1, size / 48);
    context.beginPath();
    const startX = ((offsetX % size) + size) % size;
    const startY = ((offsetY % size) + size) % size;
    for (let x = startX; x <= canvas.width; x += size) { context.moveTo(x, 0); context.lineTo(x, canvas.height); }
    for (let y = startY; y <= canvas.height; y += size) { context.moveTo(0, y); context.lineTo(canvas.width, y); }
    context.stroke();
  }

  // Blue-black rather than pure black: a pure black wash over a brown map reads
  // as a hole punched in the page, and this should read as night.
  const FOG_RGBA = [[4, 6, 11, 247], [8, 11, 20, 158], [10, 14, 24, 74], [0, 0, 0, 0]];
  //: Mask pixels per grid square. The field is built tiny and magnified, and
  //: the browser's own bilinear filter does the soft falloff for nothing — at 2
  //: the feather lands at about half a square, which reads as lamplight on rock.
  const FOG_SUB = 2;
  let fogMaskCanvas = null, fogMaskCtx = null, fogMaskImage = null;

  // Which band array this screen should draw. The host draws the union of what
  // the table can see; a player draws whatever the host last sent them. Null
  // means draw nothing at all, which is the pre-fog behaviour exactly.
  function fogBandsForViewer() {
    if (!boardState.fog?.enabled || boardState.fog.mode === "revealed") return null;
    if (role === "host") {
      if (ambientBand(activeLayerId()) === BRIGHT) return null;
      const field = FOG.fields.get(activeLayerId());
      if (!field) return null;
      if (previewAsPlayer && view.fog.previewSeatId) return field.bands.get(view.fog.previewSeatId) || null;
      return field.dmBands;
    }
    if (!remoteFog || remoteFog.layerId !== activeLayerId()) return null;
    return remoteFog.bands;
  }

  function ensureFogMask(width, height) {
    if (fogMaskCanvas && fogMaskCanvas.width === width && fogMaskCanvas.height === height) return;
    fogMaskCanvas = document.createElement("canvas");
    fogMaskCanvas.width = width; fogMaskCanvas.height = height;
    fogMaskCtx = fogMaskCanvas.getContext("2d", { willReadFrequently: true });
    fogMaskImage = fogMaskCtx.createImageData(width, height);
  }

  function drawFog() {
    if (!mapSize.width) return;
    if (role === "host" && FOG.dirty) recomputeFog();
    const canvas = ui.fogCanvas; const context = canvas.getContext("2d");
    canvas.width = mapSize.width; canvas.height = mapSize.height;   // assignment clears
    const bands = fogBandsForViewer();
    if (!bands) return;

    const { columns, rows } = boardDimensions();
    if (bands.length !== columns * rows) return;
    const { size, offsetX, offsetY } = boardState.grid;
    const w = columns * FOG_SUB, h = rows * FOG_SUB;
    ensureFogMask(w, h);
    const pixels = fogMaskImage.data;
    // The DM is looking at the same darkness the players are, but through it.
    const strength = isDM() && !previewAsPlayer ? Math.max(0, Math.min(100, view.fog.dmStrength)) / 100 : 1;
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < columns; x += 1) {
        const colour = FOG_RGBA[bands[y * columns + x]] || FOG_RGBA[0];
        const alpha = colour[3] * strength;
        for (let sy = 0; sy < FOG_SUB; sy += 1) {
          let offset = ((y * FOG_SUB + sy) * w + x * FOG_SUB) * 4;
          for (let sx = 0; sx < FOG_SUB; sx += 1, offset += 4) {
            pixels[offset] = colour[0]; pixels[offset + 1] = colour[1];
            pixels[offset + 2] = colour[2]; pixels[offset + 3] = alpha;
          }
        }
      }
    }
    fogMaskCtx.putImageData(fogMaskImage, 0, 0);
    context.imageSmoothingEnabled = view.fog.softEdges !== false;
    context.imageSmoothingQuality = "high";
    const gw = columns * size, gh = rows * size;
    context.drawImage(fogMaskCanvas, 0, 0, w, h, offsetX, offsetY, gw, gh);

    // Anything outside the grid rect is off the board. Painted as four rects
    // rather than one fill underneath, because a full fill would composite
    // twice and no cell could ever reach fully clear.
    context.fillStyle = `rgba(4,6,11,${0.97 * strength})`;
    if (offsetY > 0) context.fillRect(0, 0, canvas.width, offsetY);
    if (offsetX > 0) context.fillRect(0, offsetY, offsetX, gh);
    if (offsetX + gw < canvas.width) context.fillRect(offsetX + gw, offsetY, canvas.width - offsetX - gw, gh);
    if (offsetY + gh < canvas.height) context.fillRect(0, offsetY + gh, canvas.width, canvas.height - offsetY - gh);
  }

  const TOKEN_COLORS = { red: "#b0432f", green: "#5f7d34", blue: "#3f6690", yellow: "#b98a2e", orange: "#c07a1e", purple: "#7a4f9c", white: "#8a8272" };

  // A base sits inside its square rather than flush against the gridlines, the
  // way a real one does — and the measured base width includes a little painted
  // rim and antialiasing besides. One number covers both.
  const MINI_BASE_FIT = .84;

  // Whether this screen is drawing the pack's standing figure. Laying the minis
  // flat is a personal view setting — it never leaves this browser, so one
  // player can flatten the board without changing anyone else's table.
  function standingMini(definition) {
    return view.flatMinis ? null : definition?.mini || null;
  }

  // What the board currently knows about an actor's condition, as the key@value
  // pairs a pack names its variant sculpts after. `destroyed` is the one the
  // board tracks on its own; anything a DM sets by hand rides in `actor.states`,
  // so a pack that ships `mini/north__condition@poisoned.png` picks it up the
  // moment that state is set, with no change here.
  // The squares this token occupies: the DM's override for this one if it has
  // one, otherwise whatever its pack declares.
  function actorFootprint(actor) {
    return LaramieActors.footprint(actorDefinition(actor), actor?.rotation, actor?.footprint);
  }

  // The unrotated squares, which is what the mini art was cut against.
  function baseFootprint(actor) {
    return LaramieActors.normalizeFootprint(actor?.footprint)
      || actorDefinition(actor)?.footprint || { width: 1, height: 1 };
  }

  // Gear occupies a quarter of a square, which is a small thing to find on a
  // floor full of boots. A soft halo behind the art says something is lying
  // there, without drawing over the art itself. Personal to this screen, like
  // the rest of the appearance settings — it changes nothing about the board.
  function glows(definition) {
    return view.itemGlow !== false && definition?.kind === "item";
  }

  function actorStates(actor) {
    const states = { ...(actor?.states || {}) };
    if (actor && actor.hp?.current <= 0) states.condition = "destroyed";
    return states;
  }

  function renderActors() {
    refreshLibraryAvailability();
    const availableIds = new Set(boardState.actors.map((actor) => actor.id));
    for (const id of selectedActorIds) if (!availableIds.has(id)) selectedActorIds.delete(id);
    if (!availableIds.has(selectedActorId)) selectedActorId = [...selectedActorIds].at(-1) || "";
    // An open sheet with nothing selected is a stale instance sheet — unless it is
    // a library pack's, which never had a selection behind it in the first place.
    if (!selectedActorId && sheetIsOpen() && !sheetIsPreview()) closeActorSheet();
    // The ways out are read off whoever is selected, so they are re-read
    // whenever the selection or a position can have changed.
    renderExitList();
    ui.tokensLayer.replaceChildren();
    const size = boardState.grid.size;
    for (const actor of boardState.actors.filter((item) => drawnHere(item) && !isHiddenInContainer(item))) {
      const definition = actorDefinition(actor);
      const footprint = actorFootprint(actor);
      const mini = standingMini(definition);
      const imageUrl = !definition ? ""
        : mini ? LaramieActors.miniImageFor(definition, actor.rotation, actorStates(actor))
        : LaramieActors.imageFor(definition, actor.rotation);
      const element = document.createElement("div");
      // Somebody seen through a hole in the floor is a storey away, and reading
      // them as standing beside you is how a DM measures a move wrong.
      const storeyBelow = Boolean(actor.layerId) && actor.layerId !== activeLayerId();
      element.className = `token ${imageUrl ? "actor-sprite" : ""} ${selectedActorIds.has(actor.id) ? "selected" : ""} ${actor.hp.current <= 0 ? "destroyed" : ""} ${storeyBelow ? "storey-below" : ""}`;
      element.dataset.id = actor.id;
      element.style.left = `${boardState.grid.offsetX + (actor.x + footprint.width / 2) * size}px`;
      element.style.top = `${boardState.grid.offsetY + (actor.y + footprint.height / 2) * size}px`;
      // Depth: whoever's feet are further down the board paints in front, so a
      // standing mini overlaps what is behind it rather than being sliced by
      // whichever actor happened to be added later.
      // Depth sorts by the row an actor's feet are on, doubled so half-square
      // rows still separate. A small item is a quarter-square thing lying on the
      // ground — a knife, a pouch, a lamp — and it rides above everything on its
      // square, because otherwise it vanishes under the first body to stand there.
      const small = Math.min(footprint.width, footprint.height) < 1;
      element.style.zIndex = String((small ? 500 : 0) + Math.round((actor.y + footprint.height) * 2));
      const tokenColor = actor.color || TOKEN_COLORS[definition?.mechanics?.token_color] || "#8f3d2f";
      const hideLabel = definition?.map_label === false;
      element.style.width = `${footprint.width * size}px`; element.style.height = `${footprint.height * size}px`; element.style.background = tokenColor;
      // Primary affiliation rides the outline, so the room reads at a glance —
      // for the DM. `affiliationOf` hands a player null, which paints bone white,
      // drops the halo, and leaves no `data-affiliation` on the element to read.
      const affiliation = affiliationOf(actor);
      element.style.setProperty("--outline-color", affiliation?.color || UNKNOWN_OUTLINE);
      element.classList.toggle("allied", Boolean(affiliation));
      if (affiliation) element.dataset.affiliation = affiliation.id; else delete element.dataset.affiliation;
      // A real element rather than a pseudo-element: ::before and ::after on a
      // token are already spoken for by hover and selection, and a halo has to
      // survive both.
      if (glows(definition)) {
        element.classList.add("loot");
        // The light takes its colour from the rarity, and the colour itself from
        // the theme — so a legendary reads as legendary at any table.
        element.dataset.rarity = rarityOf(definition);
        if (definition.magic?.magical) element.classList.add("enchanted");
        const halo = document.createElement("span");
        halo.className = "token-glow";
        // The motes need a child to hang three animations off.
        if (definition.magic?.magical) halo.append(document.createElement("i"));
        element.append(halo);
      }
      const showPlaceholder = () => {
        element.classList.remove("actor-sprite", "standing");
        element.style.background = tokenColor;
        if (!hideLabel) element.prepend(document.createTextNode(actor.name.slice(0, 1).toUpperCase()));
      };
      if (imageUrl) {
        const image = document.createElement("img");
        // A mini is placed by its base, not by the picture: scale the art until
        // the round base covers the footprint, then drop it so the base rests on
        // the square's front edge. Whatever rises above that overhangs the
        // squares behind, which the depth order above sorts out. Flat art keeps
        // filling its footprint, the way it always has.
        //
        // The base width here is the pack's own, never the rotated one, because
        // the art has already turned. `dnd mini` cuts the four facings at one
        // shared scale, so a 1x2 base that is one square across head-on is drawn
        // two squares across side-on — the turn is in the pixels. Scaling by the
        // rotated width on top of that counts it twice, which is what drew Clap
        // at double size facing east and west.
        const spriteWidth = mini
          ? (baseFootprint(actor).width || 1) * size * MINI_BASE_FIT * mini.scale / mini.base
          : Math.max(footprint.width, footprint.height) * size;
        // Every sprite in this system is authored square.
        const spriteHeight = spriteWidth;
        if (mini) {
          element.classList.add("standing");
          // On the token, not the image: the light is a sibling of the art and
          // has to stand on the same ground it does.
          element.style.setProperty("--lift", `${(-mini.bottom * spriteHeight).toFixed(2)}px`);
        }
        image.src = imageUrl; image.alt = ""; image.style.width = `${spriteWidth}px`; image.style.height = `${spriteHeight}px`;
        // Keep the white keyline a hairline whatever the grid size — the stacked
        // drop-shadows that draw it compound, so a whole pixel reads as a fat rind.
        image.style.setProperty("--outline", `${Math.max(.32, Math.max(spriteWidth, spriteHeight) / 96).toFixed(2)}px`);
        // A mini whose art has not been sculpted yet falls back to the pack's
        // flat token rather than to a bare letter, so a manifest can be wired up
        // while the PNGs are still being made.
        let triedFlat = false;
        image.addEventListener("error", () => {
          const flat = mini && !triedFlat ? LaramieActors.imageFor(definition, actor.rotation) : "";
          triedFlat = true;
          if (flat && flat !== image.src) {
            element.classList.remove("standing");
            element.style.removeProperty("--lift");
            const flatSize = Math.max(footprint.width, footprint.height) * size;
            image.style.width = `${flatSize}px`; image.style.height = `${flatSize}px`;
            image.style.setProperty("--outline", `${Math.max(.32, flatSize / 96).toFixed(2)}px`);
            image.src = flat;
            return;
          }
          image.remove(); showPlaceholder();
        });
        element.append(image);
      } else showPlaceholder();
      if (!hideLabel) { const label = document.createElement("span"); label.className = "token-label"; label.textContent = actor.name; element.append(label); }
      if (showsHpBar(actor)) {
        const bar = document.createElement("span"); bar.className = "hp-bar";
        bar.style.setProperty("--hp-height", `${Math.max(4, Math.round(size * .15))}px`);
        bar.style.setProperty("--hp-edge", `${Math.max(1, Math.round(size / 44))}px`);
        const fill = document.createElement("span"); fill.style.width = `${Math.max(0, Math.min(100, actor.hp.current / actor.hp.max * 100))}%`; bar.append(fill); element.append(bar);
      }
      element.addEventListener("pointerdown", beginActorDrag);
      element.addEventListener("pointerenter", (event) => showActorTooltip(actor, event));
      element.addEventListener("pointermove", positionActorTooltip);
      element.addEventListener("pointerleave", () => { ui.actorTooltip.hidden = true; });
      // Opening a sheet is a deliberate act. A single click selects and stops
      // there: the sheet covers a third of the map, and picking a piece up is
      // not the same as asking to read about it.
      element.addEventListener("dblclick", (event) => {
        event.stopPropagation();
        if (!selectedActorIds.has(actor.id)) selectOnly(actor.id); else selectedActorId = actor.id;
        refreshSelectionVisuals(); openActorSheet();
      });
      ui.tokensLayer.append(element);
    }
    renderPlayerActorList(); if (sheetIsOpen()) updateActorSheet();
  }

  function showActorTooltip(actor, event) {
    const definition = actorDefinition(actor);
    const title = document.createElement("strong"); title.textContent = actor.name;
    const stats = document.createElement("span");
    const speed = Number(actor.movementSpeed ?? definition?.stats?.speed_ft ?? 0);
    // Only what this actor actually has. A bottle of coal oil is not "1/1 HP,
    // AC 10, 0 ft." — it is a bottle, and the hover should say so and stop.
    const health = actor.indestructible ? "indestructible"
      : canSeeHp(actor) ? `${actor.hp.current}/${actor.hp.max} ${statAbbreviation}` : "health unknown";
    stats.textContent = [
      actor.kind.replace("_", " "),
      tracksHealth(actor) ? health : "",
      tracksHealth(actor) ? `AC ${actor.armorClass}` : "",
      speed ? `${speed} ft.` : ""
    ].filter(Boolean).join(" · ");
    // Allegiance is the DM's line. A player gets no row at all rather than an
    // "Unknown affiliation" placeholder — a placeholder still tells them the board
    // is tracking sides, and which hovers are missing one is its own tell.
    const nodes = [title, stats];
    if (isDM()) {
      const allegiance = document.createElement("span");
      allegiance.className = "tooltip-affiliation";
      allegiance.style.setProperty("--chip", outlineColor(actor));
      allegiance.textContent = affiliationLabel(actor);
      nodes.push(allegiance);
    }
    // Hover shows only what this viewer has learned — the DM sees the whole file.
    for (const fact of visibleFacts(actor).slice(0, 3)) {
      const line = document.createElement("div");
      line.className = `tooltip-fact fact-${fact.visibility}`;
      line.textContent = fact.text;
      nodes.push(line);
    }
    if (nodes.length === 3 && isDM() && actor.notes) {
      const note = document.createElement("div"); note.textContent = actor.notes; nodes.push(note);
    }
    ui.actorTooltip.replaceChildren(...nodes);
    ui.actorTooltip.hidden = false;
    positionActorTooltip(event);
  }

  function positionActorTooltip(event) {
    if (ui.actorTooltip.hidden) return;
    const rect = ui.viewport.getBoundingClientRect();
    const left = Math.min(rect.width - ui.actorTooltip.offsetWidth - 10, Math.max(10, event.clientX - rect.left + 14));
    const top = Math.min(rect.height - ui.actorTooltip.offsetHeight - 10, Math.max(10, event.clientY - rect.top + 14));
    ui.actorTooltip.style.left = `${left}px`; ui.actorTooltip.style.top = `${top}px`;
  }

  // The party roster: every player character, plus anything else this seat controls.
  // The party reads its own hit points here, which is the one health readout a
  // player ever gets.
  // Every player character in the campaign, whether or not they are on the board
  // — which is why this is not just a list of tokens. The library used to carry
  // a second copy of the party so the DM could place one; one roster that knows
  // who is down and who is not does both jobs, and the party is the section a
  // player actually opens.
  function renderPlayerActorList() {
    ui.playerActorList.replaceChildren();
    const placed = boardState.actors.filter(isPartyMember);
    // People first, then whatever else rides with them. Clap belongs on this
    // roster, but he is Nickles' horse and should not head a list of the party.
    const packs = [...actorLibrary.values()]
      .filter((definition) => actorGroup(definition) === "party")
      .sort((a, b) => Number(b.kind === "player_character") - Number(a.kind === "player_character"));
    // Anything else this seat controls — a horse, a wagon, the gear the DM
    // handed them — rides along under the party, because it is theirs to move.
    const mine = boardState.actors.filter((actor) => !isPartyMember(actor) && actor.controller === playerSeatId && playerSeatId);
    if (!packs.length && !placed.length) {
      ui.playerActorList.append(muted("No player characters in this campaign"));
      return;
    }
    const seen = new Set();
    for (const definition of packs) {
      const actor = placed.find((item) => item.assetId === definition.id);
      if (actor) seen.add(actor.id);
      ui.playerActorList.append(partyRow(actor, definition));
    }
    // A PC on the board whose pack has since gone missing still has to be listed.
    for (const actor of [...placed.filter((item) => !seen.has(item.id)), ...mine]) {
      ui.playerActorList.append(partyRow(actor, actorDefinition(actor)));
    }
  }

  function partyRow(actor, definition) {
    const onBoard = Boolean(actor);
    const mine = onBoard && Boolean(playerSeatId) && actor.controller === playerSeatId;
    const row = document.createElement("div");
    row.className = `token-row ${onBoard && selectedActorIds.has(actor.id) ? "selected" : ""} ${mine ? "mine" : ""} ${onBoard ? "" : "absent"}`;
    // Dragging a row is how a character gets onto the board. Seating one is the
    // DM's — creating actors always has been — so a player's roster drags only
    // the tokens already down there, by id rather than placing a second copy.
    // `isDM()` rather than `role`, so the DM rehearsing the player view sees the
    // roster a player actually gets. The drop itself is still gated on `role`,
    // which is what stops a seat inventing actors.
    const canPlace = !onBoard && Boolean(definition) && isDM();
    row.draggable = mine || canPlace;
    const portraitUrl = definition?.image || (definition && LaramieActors.imageFor(definition, "north")) || "";
    if (portraitUrl) {
      const face = document.createElement("img"); face.className = "token-face"; face.src = portraitUrl; face.alt = "";
      row.append(face);
    } else {
      const dot = document.createElement("span"); dot.className = "token-swatch";
      dot.style.background = outlineColor(actor || {}); row.append(dot);
    }
    const name = document.createElement("span");
    const label = actor?.name || definition?.name || "Character";
    name.textContent = onBoard && canSeeHp(actor) ? `${label} · ${actor.hp.current}/${actor.hp.max} ${statAbbreviation}` : label;
    row.append(name);
    if (mine) { const badge = document.createElement("small"); badge.className = "roster-badge"; badge.textContent = "yours"; row.append(badge); }
    else if (!onBoard) { const badge = document.createElement("small"); badge.className = "roster-badge absent"; badge.textContent = "not seated"; row.append(badge); }

    if (row.draggable) {
      row.addEventListener("dragstart", (event) => {
        event.dataTransfer.effectAllowed = onBoard ? "move" : "copy";
        event.dataTransfer.setData(onBoard ? "application/x-laramie-actor" : "application/x-laramie-asset",
          onBoard ? actor.id : definition.id);
      });
    }
    row.addEventListener("click", (event) => {
      // A character who is not on the board has nothing to select, so the click
      // shows their sheet from the pack instead — which is the only thing there
      // is to say about them yet.
      if (!onBoard) { if (definition) openLibrarySheet(definition); return; }
      if (event.shiftKey) toggleActorSelection(actor.id); else selectOnly(actor.id);
      libraryCycle = { assetId: "", actorId: "" };
      renderActors(); ui.viewport.focus({ preventScroll: true });
    });
    return row;
  }

  // Which floor a move is allowed to land on.
  //
  // A move crosses a floor; it does not change one. The DM may drop a token
  // wherever they like — they are the one holding the building — but a seat's
  // move intent keeps the actor on the floor it is already on, whatever layer
  // the message claimed. Changing floor is `takeExit` and only `takeExit`, so
  // the ways between storeys are exactly the ones somebody authored.
  function layerForMove(actor, layerId, requestingSeat) {
    if (requestingSeat !== "host") return actor.layerId;
    return boardState.layers.some((layer) => layer.id === layerId) ? layerId : actor.layerId;
  }

  function moveActor(id, x, y, requestingSeat = "host", layerId = activeLayerId()) {
    FOG.dirty = true;
    const actor = boardState.actors.find((item) => item.id === id);
    if (!actor) return;
    actor.layerId = layerForMove(actor, layerId, requestingSeat);
    const from = { x: actor.x, y: actor.y };
    Object.assign(actor, clampActorPosition(actor, x, y));
    carryContents(actor, actor.x - from.x, actor.y - from.y);
    broadcastState();
  }

  // Take an exit. The host is the only thing that runs this — a player asks for
  // it by intent and everything is re-checked here, because a seat that could
  // name any exit id and any actor id could walk the sheriff into the vault.
  //
  // The three checks are: you control this actor, this actor is standing on
  // that exit, and that exit is one the scene actually declares. Nothing about
  // the request is trusted beyond the two ids.
  function takeExit(actorId, exitId, requestingSeat = "host") {
    const actor = boardState.actors.find((item) => item.id === actorId);
    if (!actor) return;
    if (requestingSeat !== "host" && actor.controller !== requestingSeat) return;
    const exit = exitsUnder(actor).find((item) => item.id === exitId);
    if (!exit || !hasLayer(exit.to.layerId)) return;

    const from = { x: actor.x, y: actor.y };
    const landing = exitLanding(exit, actor);
    actor.layerId = exit.to.layerId;
    Object.assign(actor, landing);
    // What is in the cart goes where the cart goes, down a stair as much as
    // across a room — and onto the new floor with it.
    for (const held of boardState.actors.filter((item) => item.parent === actor.id)) {
      held.layerId = actor.layerId;
    }
    carryContents(actor, actor.x - from.x, actor.y - from.y);

    // Their character moved, so the derived answer is the right one again and
    // any pin the DM had set on them is spent. A player who walks downstairs
    // during a cutscene has chosen to stop watching the cutscene.
    const seat = seats.get(requestingSeat);
    if (seat) seat.pinnedLayer = "";

    // No refit here. The screen that changed floor refits itself off the scene
    // key it receives; refitting the host as well would yank the DM's own view
    // every time a player used a stair on a floor the DM is not even watching.
    FOG.dirty = true;
    broadcastState();
    // The DM is not watching every screen. A character leaving the floor the DM
    // is looking at is exactly the thing they need told.
    if (role === "host") {
      showToast(`${actor.name} — ${exit.label} → ${layerNamed(exit.to.layerId)?.name || exit.to.layerId}`);
    }
  }

  // ---- authoring an exit from the board ------------------------------------
  //
  // The board could always move a character *through* an exit and never make
  // one, which left the DM counting squares off a map plate by hand to write a
  // CLI command. This is the other half, and it is the first thing here that
  // edits a **place** rather than a scene.
  //
  // That is a real change of rule and worth being plain about: places were
  // read-only on the board, and editing them was the CLI's job. The authority
  // has not moved — the authored markdown is still the source, `dnd place exit`
  // still writes the same file, and both go through one function in the CLI so
  // the board cannot author an exit the CLI would refuse. What moved is only
  // where the DM stands while doing it.
  //
  // An exit has two ends on two floors, so drawing one takes two clicks with a
  // floor change between them. `exitDraft` is that half-finished state.
  let exitDraft = null;   // {from: {layerId, x, y}} once the near end is placed

  function beginExitDraft() {
    if (!canAuthorPlace()) return;
    exitDraft = null;
    setBrush("exit");
    showToast("Click the square this exit leaves from");
  }

  function cancelExitDraft(quiet) {
    const had = Boolean(exitDraft);
    exitDraft = null;
    if (brushMode === "exit") setBrush("move");
    renderEffects();
    if (had && !quiet) showToast("Exit abandoned");
  }

  // Whether this screen may write a place at all: the DM, with the local helper
  // answering. Without the helper there is nothing to write through, and a tool
  // that silently does nothing is worse than one that is plainly unavailable.
  function canAuthorPlace() {
    return isDM() && Boolean(saveHelper) && Boolean(boardState.place?.id);
  }

  function handleExitClick(cell) {
    // Clicking a square that already leads somewhere offers to take it away,
    // which is the only way to remove one from here.
    const existing = exitsOn(cell.layerId).find(
      (exit) => exit.cells.some((c) => c.x === cell.x && c.y === cell.y));
    if (existing && !exitDraft) {
      if (confirm(`Remove "${existing.label}"? It goes both ways, so this closes it from both ends.`)) {
        writePlaceExit({ exit_id: existing.id, remove: true });
      }
      return;
    }
    if (!exitDraft) {
      exitDraft = { from: { layerId: cell.layerId, x: cell.x, y: cell.y } };
      renderEffects();
      showToast(`From ${layerNamed(cell.layerId)?.name || cell.layerId} ${cell.x},${cell.y} — now show me the far end`);
      return;
    }
    if (cell.layerId === exitDraft.from.layerId) {
      showToast("The far end is on another floor — switch floors, then click");
      return;
    }
    openExitDialog(exitDraft.from, { layerId: cell.layerId, x: cell.x, y: cell.y });
  }

  // The two ends are placed; the words are what is left, and they are the part
  // the board must never invent.
  function openExitDialog(from, to) {
    const name = (layerId) => layerNamed(layerId)?.name || layerId;
    ui.exitDialogFrom.textContent = `${name(from.layerId)} · ${from.x},${from.y}`;
    ui.exitDialogTo.textContent = `${name(to.layerId)} · ${to.x},${to.y}`;
    ui.exitFromLabel.value = "";
    ui.exitToLabel.value = "";
    ui.exitDialog.dataset.from = JSON.stringify(from);
    ui.exitDialog.dataset.to = JSON.stringify(to);
    ui.exitDialog.showModal();
    ui.exitFromLabel.focus();
  }

  function commitExitDialog() {
    const from = JSON.parse(ui.exitDialog.dataset.from || "null");
    const to = JSON.parse(ui.exitDialog.dataset.to || "null");
    if (!from || !to) return;
    const fromLabel = ui.exitFromLabel.value.trim();
    const toLabel = ui.exitToLabel.value.trim();
    if (!fromLabel || !toLabel) { showToast("Both ends want their own words"); return; }
    // The id is derived from the near end's words the way an encounter id is
    // derived from its title, so the DM is not asked for a slug they will never
    // look at again.
    const exitId = encounterIdFrom(fromLabel) || `exit-${from.x}-${from.y}`;
    ui.exitDialog.close();
    writePlaceExit({
      exit_id: exitId,
      ends: [
        { level: from.layerId, x: from.x, y: from.y, label: fromLabel },
        { level: to.layerId, x: to.x, y: to.y, label: toLabel }
      ]
    });
  }

  // One POST, then re-read the place from disk rather than patching the copy in
  // memory — the file is the source, and the board should be showing what
  // actually landed in it.
  async function writePlaceExit(body) {
    if (!canAuthorPlace()) { showToast("Run `dnd encounter serve` to edit exits"); return; }
    // Only the write is guarded here. Anything that goes wrong afterwards has
    // still left the exit on disk, and reporting that as "could not write it"
    // would send the DM off to do it again — so the two halves report
    // separately and each says what actually happened.
    try {
      const response = await fetch(`${SAVE_HELPER}/place/exit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaign: campaign.id, place_id: boardState.place.id, ...body })
      });
      const answer = await response.json();
      if (!response.ok || !answer?.ok) throw new Error(answer?.error || "the helper refused it");
    } catch (error) {
      console.error("Could not write the exit", error);
      showToast(`Could not write it: ${error.message}`);
      probeSaveHelper();
      return;
    }

    cancelExitDraft(true);
    showToast(body.remove ? "Exit removed" : "Exit written to the place");
    try {
      await reloadPlaceExits();
    } catch (error) {
      console.error("Could not re-read the place", error);
      showToast("Written, but the board could not re-read the place — reload the page");
    }
  }

  // Re-read the place and put the scene's own exit overrides back on top.
  // Deliberately not a reload of the encounter: that would rebuild the cast from
  // the file and throw away where everyone is standing mid-session.
  async function reloadPlaceExits() {
    LaramieCampaign.forgetPlaces();
    const place = await LaramieCampaign.loadPlace(campaign, boardState.place.id);
    currentPlace = place;
    const exits = LaramieCampaign.exitsForScene(place, currentEncounter);
    boardState.layers = place.layers.map((layer) => ({ ...layer, exits: exits.get(layer.id) || [] }));
    FOG.dirty = true;
    broadcastState();
  }

  // What the button in the sidebar actually calls. The DM moves the token
  // outright; a player asks, and the host decides — the same shape as every
  // other thing a player does to the board.
  function requestExit(actorId, exitId) {
    if (role === "host") { takeExit(actorId, exitId, "host"); return; }
    if (playerChannel?.readyState !== "open") { showToast("Connect to the host before moving"); return; }
    send(playerChannel, { type: "intent", action: "takeExit", actorId, exitId });
  }

  // The cutscene lever. Every screen is dragged to the floor the DM is on and
  // held there, overriding where each character happens to be standing, until
  // it is released or that player takes an exit of their own.
  function pinTableToActiveLayer(pinned) {
    if (!can("layerSwitch")) return;
    for (const seat of seats.values()) seat.pinnedLayer = pinned ? activeLayerId() : "";
    FOG.dirty = true;
    renderLayerSwitch();
    broadcastState();
    showToast(pinned
      ? `Every screen is on ${activeLayer()?.name || "this floor"}`
      : "Every screen is back on its own character's floor");
  }

  // A new scene is a new building, and a pin naming a floor of the old one is
  // meaningless — so every screen goes back to following its own character.
  function resetSeatPins() {
    for (const seat of seats.values()) seat.pinnedLayer = "";
  }

  // True when the table is being held on the DM's floor rather than following
  // its own characters. Seats that joined after the pin are not held, which is
  // why this asks "any" rather than "all" — the button reads as lit, and
  // pressing it again pins the newcomer too.
  function tableIsPinned() {
    return [...seats.values()].some((seat) => seat.pinnedLayer && hasLayer(seat.pinnedLayer));
  }

  function clampActorPosition(actor, rawX, rawY) {
    const definition = actorDefinition(actor); const footprint = actorFootprint(actor);
    const { columns, rows } = boardDimensions();
    return LaramieCampaign.clampToBoard(
      { columns: Math.max(footprint.width, columns), rows: Math.max(footprint.height, rows) },
      footprint, rawX, rawY
    );
  }

  function moveActors(rawMoves, requestingSeat = "host") {
    FOG.dirty = true;
    if (!Array.isArray(rawMoves)) return;
    for (const move of rawMoves.slice(0, 100)) {
      const actor = boardState.actors.find((item) => item.id === move.id); if (!actor) continue;
      actor.layerId = layerForMove(actor, move.layerId, requestingSeat);
      const from = { x: actor.x, y: actor.y };
      Object.assign(actor, clampActorPosition(actor, move.x, move.y));
      carryContents(actor, actor.x - from.x, actor.y - from.y);
    }
    broadcastState();
  }

  // What is in the cart goes where the cart goes. Contents are ordinary actors
  // with a `parent`, so they keep their own hit points, facts, and secrets —
  // they are simply dragged by the same delta rather than repositioned, which
  // keeps a chest's own arrangement of coins intact across the move.
  function contentsOf(containerId) {
    return boardState.actors.filter((actor) => actor.parent === containerId);
  }

  // The finest grid any selected actor sits on. Move a lantern and a horse
  // together and they step a whole square, because half of one would leave the
  // horse off the grid; move the lantern alone and it steps a half.
  function smallestStep() {
    const selected = boardState.actors.filter((actor) => selectedActorIds.has(actor.id));
    const footprints = selected.map((actor) => {
      const definition = actorDefinition(actor);
      return actorFootprint(actor);
    });
    if (!footprints.length) return 1;
    return footprints.every((fp) => Math.min(fp.width, fp.height) < 1) ? .5 : 1;
  }

  // What is shut and opaque shows the party nothing. The DM sees through it, so
  // they can move a chest's contents about before it is ever opened.
  function isHiddenInContainer(actor) {
    if (!actor.parent || isDM()) return false;
    const container = boardState.actors.find((item) => item.id === actor.parent);
    if (!container) return false;
    const definition = actorDefinition(container);
    return Boolean(definition?.container?.opaque) && !container.open;
  }

  function carryContents(container, deltaX, deltaY, seen = new Set()) {
    if ((!deltaX && !deltaY) || seen.has(container.id)) return;
    seen.add(container.id);
    for (const held of contentsOf(container.id)) {
      Object.assign(held, clampActorPosition(held, held.x + deltaX, held.y + deltaY));
      held.layerId = container.layerId;
      // A strongbox in a cart carries its own contents along with it.
      carryContents(held, deltaX, deltaY, seen);
    }
  }

  const ROTATIONS = LaramieActors.ROTATIONS;

  function rotateActor(id, rotation, requestingSeat = "host") {
    FOG.dirty = true;
    const actor = boardState.actors.find((item) => item.id === id);
    if (!actor || !ROTATIONS.includes(rotation)) return;
    actor.rotation = rotation; broadcastState();
  }

  function beginActorDrag(event) {
    event.stopPropagation(); event.preventDefault();
    const element = event.currentTarget; const actorId = element.dataset.id;
    const actor = boardState.actors.find((item) => item.id === actorId); if (!actor) return;
    if (event.shiftKey) toggleActorSelection(actorId);
    else if (!selectedActorIds.has(actorId)) selectOnly(actorId);
    else selectedActorId = actorId;
    refreshSelectionVisuals();
    if (!selectedActorIds.has(actorId) || !canMoveActor(actor)) return;
    const start = { x: event.clientX, y: event.clientY }; let dragged = false;
    element.setPointerCapture(event.pointerId); element.classList.toggle("pending", role === "player");
    // The rest of the selection rides along under the cursor rather than
    // teleporting into place on drop.
    const origin = { left: parseFloat(element.style.left), top: parseFloat(element.style.top) };
    const companions = selectedActorIds.size < 2 ? [] :
      [...ui.tokensLayer.querySelectorAll(".token.selected")]
        .filter((node) => node !== element)
        .map((node) => ({ node, left: parseFloat(node.style.left), top: parseFloat(node.style.top) }));
    const onMove = (moveEvent) => {
      if (Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y) > 4) dragged = true;
      if (!dragged) return;
      element.classList.add("dragging");
      for (const companion of companions) companion.node.classList.add("dragging");
      const point = clientToWorld(moveEvent.clientX, moveEvent.clientY);
      element.style.left = `${point.x}px`; element.style.top = `${point.y}px`;
      for (const companion of companions) {
        companion.node.style.left = `${companion.left + point.x - origin.left}px`;
        companion.node.style.top = `${companion.top + point.y - origin.top}px`;
      }
    };
    // A cancelled pointer (a browser gesture takeover, a lost stylus) leaves the
    // ghosts mid-air; redraw so they snap back to where the board says they are.
    const onCancel = () => { stopDrag(); renderActors(); };
    const stopDrag = () => {
      element.removeEventListener("pointermove", onMove);
      element.removeEventListener("pointerup", onUp);
      element.removeEventListener("pointercancel", onCancel);
      element.classList.remove("dragging");
      for (const companion of companions) companion.node.classList.remove("dragging");
    };
    const onUp = (upEvent) => {
      stopDrag();
      if (!dragged) {
        element.classList.remove("pending");
        const now = Date.now();
        if (upEvent.pointerType === "touch" && lastActorTap.id === actorId && now - lastActorTap.time < 420) openActorSheet();
        lastActorTap = { id: actorId, time: now };
        return;
      }
      const point = clientToWorld(upEvent.clientX, upEvent.clientY); const size = boardState.grid.size;
      // Dropped onto the grid the selection actually lives on: whole squares for
      // anything ordinary, half-squares when everything being dragged is small,
      // so a pouch lands in the quarter you dropped it in.
      const step = smallestStep();
      const cell = (world, offset) => Math.floor((world - offset) / (size * step)) * step;
      const x = cell(point.x, boardState.grid.offsetX); const y = cell(point.y, boardState.grid.offsetY);
      moveSelectedActorsBy(x - actor.x, y - actor.y);
    };
    element.addEventListener("pointermove", onMove); element.addEventListener("pointerup", onUp);
    element.addEventListener("pointercancel", onCancel);
  }

  // ---------------------------------------------------------------------------
  // Environment effects — each patch is ONE region {id, layerId, type, cells[]}
  // rendered as a single traced-outline SVG (pulsing interior, flaming edge,
  // a few embers). No per-cell DOM nodes, no per-cell animations.
  // ---------------------------------------------------------------------------

  function normalizeEffects(raw) {
    if (!Array.isArray(raw)) return [];
    const regions = [];
    const legacy = new Map(); // "layer:type" -> Set("x,y") for old per-cell effects
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const type = item.type === "smoke" ? "smoke" : "fire";
      if (Array.isArray(item.cells)) {
        const cells = item.cells
          .filter((cell) => Number.isFinite(Number(cell?.x)) && Number.isFinite(Number(cell?.y)))
          .map((cell) => ({ x: Math.max(0, Math.round(Number(cell.x))), y: Math.max(0, Math.round(Number(cell.y))) }));
        if (cells.length) regions.push({ id: item.id || crypto.randomUUID(), layerId: item.layerId, type, cells });
      } else if (Number.isFinite(Number(item.x))) {
        const layerId = item.layerId || boardState.layers?.[0]?.id || "ground";
        const key = `${layerId}:${type}`;
        if (!legacy.has(key)) legacy.set(key, new Set());
        legacy.get(key).add(`${Math.max(0, Math.round(Number(item.x)))},${Math.max(0, Math.round(Number(item.y)))}`);
      }
    }
    for (const [key, set] of legacy) {
      const [layerId, type] = key.split(":");
      regions.push({ id: crypto.randomUUID(), layerId, type, cells: keysToCells(set) });
    }
    return regions;
  }

  function keysToCells(keys) {
    return [...keys].map((key) => { const [x, y] = key.split(",").map(Number); return { x, y }; });
  }

  function effectRadiusFt() { return Math.max(0, Number(ui.areaRadius.value) || 5); }

  // How many feet one square is worth. The board carries it, the campaign has a
  // default, and 5 is the last resort — a place mapped at 10 ft to the square
  // has to halve every radius, and hardcoding 5 silently drew it twice too big.
  function squareFeet() {
    return Math.max(1, Number(boardState.place?.board?.squareFt)
      || Number(campaign?.defaults?.squareSizeFt) || 5);
  }

  // A radius in feet becomes a radius in squares at the board's own scale.
  function stampCells(center, ft, shape) {
    const r = Math.max(0, Math.round(ft / squareFeet())); const cells = [];
    for (let dy = -r; dy <= r; dy += 1) for (let dx = -r; dx <= r; dx += 1) {
      if (shape === "circle" && dx * dx + dy * dy > r * r) continue;
      const x = center.x + dx, y = center.y + dy;
      if (x >= 0 && y >= 0) cells.push({ x, y });
    }
    return cells;
  }

  function stampInto(draft, cell) {
    for (const c of stampCells(cell, effectRadiusFt(), ui.areaShape.value)) {
      if (draft.keys.size >= 2400) break;
      draft.keys.add(`${c.x},${c.y}`);
    }
  }

  function regionAt(cell) {
    return boardState.effects.find((region) =>
      region.layerId === cell.layerId && region.cells.some((c) => c.x === cell.x && c.y === cell.y));
  }

  // Trace the outline of a set of grid cells into closed loops of corner points.
  // Edges are emitted with the filled interior on the right, so the outer ring
  // and any holes wind oppositely and nonzero fill renders them correctly.
  function traceLoops(keys) {
    const has = (x, y) => keys.has(`${x},${y}`);
    const edges = new Map();
    const push = (from, to) => { const list = edges.get(from); if (list) list.push(to); else edges.set(from, [to]); };
    for (const key of keys) {
      const [x, y] = key.split(",").map(Number);
      if (!has(x, y - 1)) push(`${x},${y}`, [x + 1, y]);
      if (!has(x + 1, y)) push(`${x + 1},${y}`, [x + 1, y + 1]);
      if (!has(x, y + 1)) push(`${x + 1},${y + 1}`, [x, y + 1]);
      if (!has(x - 1, y)) push(`${x},${y + 1}`, [x, y]);
    }
    const loops = [];
    for (const [startKey, list] of edges) {
      while (list.length) {
        const [sx, sy] = startKey.split(",").map(Number);
        const loop = [[sx, sy]]; let cx = sx, cy = sy, guard = 0;
        do {
          const outs = edges.get(`${cx},${cy}`); if (!outs || !outs.length) break;
          const [nx, ny] = outs.shift(); loop.push([nx, ny]); cx = nx; cy = ny;
        } while (!(cx === sx && cy === sy) && guard++ < 200000);
        if (loop.length > 2) loops.push(loop);
      }
    }
    return loops;
  }

  function loopsPath(loops, minX, minY, size) {
    let d = "";
    for (const loop of loops) {
      d += "M";
      for (const [px, py] of loop) d += ` ${((px - minX) * size).toFixed(1)} ${((py - minY) * size).toFixed(1)}`;
      d += "Z";
    }
    return d;
  }

  function svgEl(tag) { return document.createElementNS("http://www.w3.org/2000/svg", tag); }

  function hashString(text) { let h = 2166136261; for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function seededRandom(seed) {
    return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  function cellsBounds(cells) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of cells) { if (c.x < minX) minX = c.x; if (c.y < minY) minY = c.y; if (c.x > maxX) maxX = c.x; if (c.y > maxY) maxY = c.y; }
    return { minX, minY, maxX, maxY };
  }

  function effectSvg(cells, size, className) {
    if (!cells.length) return null;
    const keys = new Set(cells.map((c) => `${c.x},${c.y}`));
    const { minX, minY, maxX, maxY } = cellsBounds(cells);
    const wPx = (maxX - minX + 1) * size, hPx = (maxY - minY + 1) * size;
    const svg = svgEl("svg"); svg.setAttribute("class", className);
    svg.style.left = `${boardState.grid.offsetX + minX * size}px`; svg.style.top = `${boardState.grid.offsetY + minY * size}px`;
    svg.style.width = `${wPx}px`; svg.style.height = `${hPx}px`; svg.setAttribute("viewBox", `0 0 ${wPx} ${hPx}`);
    return { svg, path: loopsPath(traceLoops(keys), minX, minY, size), minX, minY };
  }

  function buildRegionSvg(region, size, hover) {
    const built = effectSvg(region.cells, size, `fx-region ${region.type}${hover ? " fx-hover" : ""}`); if (!built) return null;
    const { svg, path, minX, minY } = built;
    const fill = svgEl("path"); fill.setAttribute("class", "fx-fill"); fill.setAttribute("d", path);
    const edge = svgEl("path"); edge.setAttribute("class", "fx-edge"); edge.setAttribute("d", path);
    svg.append(fill, edge);
    const random = seededRandom(hashString(region.id));
    const smoke = region.type === "smoke";
    const emberCount = Math.min(32, Math.max(6, Math.round(region.cells.length * (smoke ? 0.55 : 0.4))));
    for (let i = 0; i < emberCount; i += 1) {
      const c = region.cells[Math.floor(random() * region.cells.length)];
      const ember = svgEl("circle"); ember.setAttribute("class", "fx-ember");
      // spawn anywhere in a random cell of the patch (full-cell jitter), so they
      // don't cluster on the same handful of points
      ember.setAttribute("cx", ((c.x - minX + random()) * size).toFixed(1));
      ember.setAttribute("cy", ((c.y - minY + random()) * size).toFixed(1));
      ember.setAttribute("r", (size * (smoke ? 0.09 + random() * 0.11 : 0.035 + random() * 0.05)).toFixed(1));
      // per-particle motion: rise height, sway amplitude (± for phase), speed, brightness
      const rise = size * (smoke ? 1.6 + random() * 1.9 : 1.1 + random() * 1.4);
      const amp = size * (smoke ? 0.22 + random() * 0.5 : 0.12 + random() * 0.28) * (random() < 0.5 ? -1 : 1);
      const duration = smoke ? 3.6 + random() * 3.4 : 1.9 + random() * 1.7;
      const peak = smoke ? 0.28 + random() * 0.28 : 0.62 + random() * 0.34;
      ember.style.setProperty("--rise", `${rise.toFixed(1)}px`);
      ember.style.setProperty("--amp", `${amp.toFixed(1)}px`);
      ember.style.setProperty("--peak", peak.toFixed(2));
      ember.style.animationDuration = `${duration.toFixed(2)}s`;
      ember.style.animationDelay = `${(-random() * duration).toFixed(2)}s`;
      svg.append(ember);
    }
    return svg;
  }

  function buildPreviewSvg(cells, size) {
    const built = effectSvg(cells, size, `fx-preview ${ui.effectType.value}`); if (!built) return null;
    const path = svgEl("path"); path.setAttribute("d", built.path); built.svg.append(path);
    return built.svg;
  }

  function renderEffects() {
    ui.effectsLayer.replaceChildren();
    const size = boardState.grid.size; const layerId = activeLayerId();
    for (const region of boardState.effects) {
      if (region.layerId !== layerId || !region.cells.length) continue;
      const svg = buildRegionSvg(region, size, region.id === hoverRegionId); if (svg) ui.effectsLayer.append(svg);
    }
    if (draftRegion && draftRegion.layerId === layerId && draftRegion.keys.size) {
      const svg = buildRegionSvg({ id: "draft", type: draftRegion.type, cells: keysToCells(draftRegion.keys) }, size, false);
      if (svg) ui.effectsLayer.append(svg);
    }
    if (brushMode === "flame" && hoverCell) {
      const svg = buildPreviewSvg(stampCells(hoverCell, effectRadiusFt(), ui.areaShape.value), size);
      if (svg) ui.effectsLayer.append(svg);
    }
    // Where the lights actually are, on the DM's screen only. A player does not
    // need a marker: they can see the light itself, which is the whole point.
    if (isDM() && boardState.fog?.enabled && view.fog.showLightRings) {
      for (const light of boardState.lights) {
        const origin = lightOrigin(light);
        if (!origin || origin.layerId !== layerId) continue;
        const pip = document.createElement("div");
        pip.className = `light-pip${light.on ? "" : " out"}${light.actorId ? " carried" : ""}`;
        pip.style.left = `${boardState.grid.offsetX + (origin.x + 0.5) * size}px`;
        pip.style.top = `${boardState.grid.offsetY + (origin.y + 0.5) * size}px`;
        pip.title = `${light.name} — ${light.brightFt}/${light.dimFt} ft${light.on ? "" : " (out)"}`;
        ui.effectsLayer.append(pip);
      }
    }
    if (brushMode === "light" && hoverCell) {
      const kind = lightKind(ui.lightKind?.value);
      const svg = buildPreviewSvg(stampCells(hoverCell, kind.dimFt, "circle"), size);
      if (svg) ui.effectsLayer.append(svg);
    }
    renderExitMarks(size, layerId);
  }

  // A square that leads somewhere says so on the board. Without this the only
  // sign is a panel that appears once you are already standing on it, which
  // makes a stair something you find by walking over the whole floor.
  //
  // The mark is the author's label as a tooltip and nothing more on screen —
  // printing "Teleport to cabbage land" across the boards of the barroom would
  // give away every secret the labels are carrying.
  function renderExitMarks(size, layerId) {
    const mark = (x, y, className, title) => {
      const element = document.createElement("div");
      element.className = className;
      element.style.left = `${boardState.grid.offsetX + (x + 0.5) * size}px`;
      element.style.top = `${boardState.grid.offsetY + (y + 0.5) * size}px`;
      element.style.width = element.style.height = `${size}px`;
      element.title = title;
      ui.effectsLayer.append(element);
      return element;
    };
    for (const exit of exitsOn(layerId)) {
      for (const cell of exit.cells) mark(cell.x, cell.y, "exit-mark", exit.label);
    }
    // The near end of a link being drawn, on the floor it was placed on. Without
    // it the DM switches floor to pick the far end and has nothing on screen
    // saying what they are joining it to.
    if (exitDraft && exitDraft.from.layerId === layerId) {
      mark(exitDraft.from.x, exitDraft.from.y, "exit-mark drafting", "This exit's near end");
    }
  }

  function scheduleEffectsRender() {
    if (effectsRaf) return;
    effectsRaf = requestAnimationFrame(() => { effectsRaf = 0; renderEffects(); });
  }

  function gridCellFromClient(clientX, clientY) {
    const point = clientToWorld(clientX, clientY); const size = boardState.grid.size;
    const x = Math.floor((point.x - boardState.grid.offsetX) / size); const y = Math.floor((point.y - boardState.grid.offsetY) / size);
    return x < 0 || y < 0 ? null : { layerId: activeLayerId(), x, y };
  }

  function sameCell(a, b) { return Boolean(a) && Boolean(b) && a.layerId === b.layerId && a.x === b.x && a.y === b.y; }

  function commitDraftRegion() {
    const draft = draftRegion; draftRegion = null;
    if (!draft || !draft.keys.size) { renderEffects(); return; }
    commitEffectRegion({ id: crypto.randomUUID(), layerId: draft.layerId, type: draft.type, cells: keysToCells(draft.keys) });
  }

  function commitEffectRegion(region) {
    if (role === "host") { boardState.effects.push(region); broadcastState(); }
    else { send(playerChannel, { type: "intent", action: "addEffect", region }); renderEffects(); }
  }

  // Host-side sanitiser for a region requested by a connected player.
  function applyEffectRegion(raw) {
    if (role !== "host" || !raw || typeof raw !== "object") return;
    const type = raw.type === "smoke" ? "smoke" : "fire";
    const layerId = boardState.layers.some((layer) => layer.id === raw.layerId) ? raw.layerId : activeLayerId();
    const cells = Array.isArray(raw.cells) ? raw.cells.slice(0, 2400)
      .map((cell) => ({ x: Math.max(0, Math.round(Number(cell.x) || 0)), y: Math.max(0, Math.round(Number(cell.y) || 0)) })) : [];
    if (!cells.length) return;
    boardState.effects.push({ id: crypto.randomUUID(), layerId, type, cells });
    broadcastState();
  }

  function extinguishRegion(id) {
    hoverRegionId = "";
    if (role === "host") { boardState.effects = boardState.effects.filter((region) => region.id !== id); broadcastState(); }
    else { send(playerChannel, { type: "intent", action: "removeEffect", id }); renderEffects(); }
  }

  function clearEffectsOnLayer(layerId) {
    if (role === "host") { boardState.effects = boardState.effects.filter((region) => region.layerId !== layerId); broadcastState(); }
    else { send(playerChannel, { type: "intent", action: "clearEffects", layerId }); renderEffects(); }
  }

  // ---------------------------------------------------------------------------
  // Darkness
  // ---------------------------------------------------------------------------
  // Three fields over the same grid the tokens stand on, all indexed y*cols+x:
  //
  //   occluder  what stops light and sight. Derived from a public PNG beside
  //             the maps, so it is never broadcast — a player can already fetch
  //             the terrain, and pretending otherwise would be theatre.
  //   light     objective illumination: 0 dark, 1 dim, 2 bright. One pass for
  //             the whole table; darkness is a property of the room.
  //   bands     what ONE seat perceives: 0 dark, 1 remembered, 2 dim, 3 bright.
  //             Per seat, because darkvision is per creature — the same dark
  //             corridor is DIM to Stinky Pete and nothing at all to Nickels.
  //
  // That split is the whole design. Light is objective and computed once; sight
  // is subjective and computed per seat, and only the subjective half goes on
  // the wire.
  const DARK = 0, REMEMBERED = 1, DIM = 2, BRIGHT = 3;

  // One field per floor, not one field for the floor showing. Exits mean the
  // party can be spread over three storeys at once, each seat's screen on its
  // own character's, and each of those needs its own light and its own bands —
  // so darkness is computed for every floor somebody is looking at, and only
  // for those.
  //
  // Memory is per floor and kept, which is also what going down a stair and
  // coming back up demands: the barroom does not un-remember itself because you
  // spent a round in the cellar.
  const FOG = {
    epoch: 0,
    dirty: true,
    columns: 0,
    rows: 0,
    fields: new Map()      // layerId -> field, see fogField
  };

  // Everything darkness needs to know about one floor.
  function fogField(layerId) {
    const { columns, rows } = boardDimensions();
    let field = FOG.fields.get(layerId);
    if (field && FOG.columns === columns && FOG.rows === rows) return field;
    // A board that changed size is a different board; nothing measured against
    // the old one survives it.
    if (FOG.columns !== columns || FOG.rows !== rows) {
      FOG.columns = columns; FOG.rows = rows; FOG.fields.clear();
    }
    field = {
      occluder: occluders.get(layerId)?.data || null,
      light: new Uint8Array(columns * rows),
      bands: new Map(),      // seatId -> Uint8Array, rebuilt each pass
      explored: new Map(),   // seatId -> Uint8Array, persists across passes
      dmBands: new Uint8Array(columns * rows)
    };
    FOG.fields.set(layerId, field);
    return field;
  }

  const occluders = new Map();   // layerId -> {key, data|null}

  // The plate that says where the rock is, read off a PNG beside the maps.
  //
  // Not broadcast, and not secret: it is derived from a public file, and a
  // player who wants the layout can already fetch the terrain. Only the host
  // needs it, because only the host computes what anybody can see.
  //
  // Black blocks, white is walkable, one pixel to the square. The image is
  // drawn into a canvas at the board's own cell dimensions, so whatever
  // resolution it was authored at the browser resamples it for free.
  async function loadOccluders(layer) {
    if (!layer) return;
    const url = layer.occluderUrl || "";
    // Keyed on the board's own dimensions, not FOG's: FOG.columns is still zero
    // until the first field is built, so keying on it would load every mask
    // twice — once against 0x0 and again against the real board.
    const { columns, rows } = boardDimensions();
    const key = `${url}|${columns}x${rows}`;
    const cached = occluders.get(layer.id);
    if (cached && cached.key === key) return;
    if (!url) { occluders.set(layer.id, { key, data: null }); FOG.dirty = true; return; }
    // Claim the slot before awaiting, so a floor switched to twice in a second
    // does not start the same fetch twice.
    occluders.set(layer.id, { key, data: cached?.data || null });
    try {
      const image = await new Promise((resolve, reject) => {
        const element = new Image();
        element.crossOrigin = "anonymous";
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error(`${url} failed to load`));
        element.src = url;
      });
      const canvas = document.createElement("canvas");
      canvas.width = columns; canvas.height = rows;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(image, 0, 0, columns, rows);
      const pixels = context.getImageData(0, 0, columns, rows).data;
      const data = new Uint8Array(columns * rows);
      for (let i = 0; i < data.length; i += 1) {
        const offset = i * 4;
        // Transparent counts as open, so a mask authored with a cut-out rather
        // than a white fill still reads the way its author meant.
        const lit = pixels[offset + 3] < 128 ? 255
          : (pixels[offset] + pixels[offset + 1] + pixels[offset + 2]) / 3;
        data[i] = lit < 128 ? 1 : 0;
      }
      occluders.set(layer.id, { key, data });
      const blocked = data.reduce((n, v) => n + v, 0);
      // A mask that blocks everything or nothing is a loading mistake, not a
      // map, and silently drawing a black floor is a bad way to find that out.
      if (blocked === 0 || blocked === data.length) {
        showToast(`Wall mask for ${layer.name} looks wrong — ${blocked ? "everything" : "nothing"} blocks`);
      }
    } catch {
      occluders.set(layer.id, { key, data: null });
      showToast(`No wall mask for ${layer.name} — light will carry through rock`);
    }
    // Whatever the answer, the field that read the old one is now stale.
    FOG.dirty = true;
    renderBoard();
  }

  function boardDimensions() {
    const board = boardState.place?.board;
    return {
      columns: Math.max(1, Math.round(Number(board?.columns) || 48)),
      rows: Math.max(1, Math.round(Number(board?.rows) || 32))
    };
  }

  // The band a layer sits at with nothing burning on it. Unstated is `bright`,
  // which is what keeps every map authored before this feature exactly as it
  // was: bright ambient means fog never activates at all.
  function ambientBand(layerId) {
    const override = boardState.fog?.ambient?.[layerId];
    if (AMBIENT_BANDS.has(override)) return override === "dark" ? DARK : override === "dim" ? DIM : BRIGHT;
    const layer = boardState.layers.find((item) => item.id === layerId);
    const authored = layer?.ambientLight;
    return authored === "dark" ? DARK : authored === "dim" ? DIM : BRIGHT;
  }

  // The one question every other part asks, and it is asked per floor: a cellar
  // is dark while the barroom over it is noon, and with exits both are on
  // screen at once. Kept cheap and total — if this is false for a floor, that
  // floor behaves exactly as it did before any of this existed.
  function fogActive(layerId = activeLayerId()) {
    if (!boardState.fog?.enabled) return false;
    if (boardState.fog.mode === "revealed") return false;
    return ambientBand(layerId) !== BRIGHT;
  }

  const idx = (x, y, columns) => y * columns + x;

  // A radius in feet is a radius in squares at whatever scale this board is
  // drawn to. Lifted out of stampCells so light and area effects cannot drift
  // apart — a place mapped at 10 ft to the square has to halve both.
  function radiusCells(ft) {
    return Math.max(0, Math.round(ft / squareFeet()));
  }

  // Threaded rather than read off a module-level "current floor", because with
  // exits there are several floors in flight in one pass and a stale global
  // would light the cellar through the barroom's walls.
  function blockedAt(occluder, x, y) {
    if (!occluder) return false;
    if (x < 0 || y < 0 || x >= FOG.columns || y >= FOG.rows) return true;
    return occluder[idx(x, y, FOG.columns)] === 1;
  }

  // Recursive shadowcasting, eight octants, each cell visited at most once.
  // Chosen over permissive FOV because permissive lets you see round a corner
  // you are not standing at, and that starts arguments at the table.
  const OCTANTS = [
    [1, 0, 0, 1], [0, 1, 1, 0], [0, -1, 1, 0], [-1, 0, 0, 1],
    [-1, 0, 0, -1], [0, -1, -1, 0], [0, 1, -1, 0], [1, 0, 0, -1]
  ];

  function castOctant(occluder, ox, oy, radius, xx, xy, yx, yy, visit) {
    const stack = [{ row: 1, start: 1.0, end: 0.0 }];
    while (stack.length) {
      const { row: startRow, start, end } = stack.pop();
      let slopeStart = start;
      for (let row = startRow; row <= radius; row += 1) {
        let blockedRun = false, nextStart = slopeStart;
        for (let dx = -row; dx <= 0; dx += 1) {
          const dy = -row;
          const lSlope = (dx - 0.5) / (dy + 0.5);
          const rSlope = (dx + 0.5) / (dy - 0.5);
          if (rSlope > slopeStart) continue;
          if (lSlope < end) break;
          const x = ox + dx * xx + dy * xy;
          const y = oy + dx * yx + dy * yy;
          if (dx * dx + dy * dy <= radius * radius) visit(x, y);
          const solid = blockedAt(occluder, x, y);
          if (blockedRun) {
            if (solid) { nextStart = rSlope; continue; }
            blockedRun = false; slopeStart = nextStart;
          } else if (solid && row < radius) {
            blockedRun = true;
            stack.push({ row: row + 1, start: slopeStart, end: lSlope });
            nextStart = rSlope;
          }
        }
        if (blockedRun) break;
      }
    }
  }

  // Everything the source can reach, origin included. `visit` decides what that
  // means — raising a light level, or marking a cell seen.
  function castFrom(occluder, x, y, radiusInCells, visit) {
    visit(x, y);
    if (radiusInCells <= 0) return;
    for (const [xx, xy, yx, yy] of OCTANTS) castOctant(occluder, x, y, radiusInCells, xx, xy, yx, yy, visit);
  }

  // A carried light has no position of its own: it reads its bearer's. Nothing
  // is ever copied, so `moveActor` needs no knowledge of lights at all, and a
  // lantern taken down a stair is on the stair's floor without being told.
  function lightOrigin(light) {
    if (!light.actorId) return { x: light.x, y: light.y, layerId: light.layerId };
    const actor = boardState.actors.find((item) => item.id === light.actorId);
    if (!actor) return null;
    const footprint = actorFootprint(actor);
    return {
      x: Math.floor(actor.x + footprint.width / 2),
      y: Math.floor(actor.y + footprint.height / 2),
      layerId: actor.layerId
    };
  }

  function darkvisionCellsOf(actor) {
    const declared = Number(actor?.darkvisionFt);
    if (Number.isFinite(declared) && declared > 0) return radiusCells(declared);
    return 0;
  }

  // Objective illumination on one floor. Brightest source wins; ambient is the
  // floor under all of them.
  function recomputeLight(field, layerId) {
    const base = ambientBand(layerId) === BRIGHT ? 2 : ambientBand(layerId) === DIM ? 1 : 0;
    field.light.fill(base);
    for (const light of boardState.lights) {
      if (!light.on) continue;
      const origin = lightOrigin(light);
      if (!origin || origin.layerId !== layerId) continue;
      if (origin.x < 0 || origin.y < 0 || origin.x >= FOG.columns || origin.y >= FOG.rows) continue;
      const bright = radiusCells(light.brightFt);
      const dim = Math.max(bright, radiusCells(light.dimFt));
      if (dim <= 0) continue;
      const bright2 = bright * bright;
      castFrom(field.occluder, origin.x, origin.y, dim, (x, y) => {
        if (x < 0 || y < 0 || x >= FOG.columns || y >= FOG.rows) return;
        const dx = x - origin.x, dy = y - origin.y;
        const level = (dx * dx + dy * dy) <= bright2 ? 2 : 1;
        const i = idx(x, y, FOG.columns);
        if (level > field.light[i]) field.light[i] = level;
      });
    }
  }

  // What one seat perceives, from the creatures it is looking through.
  //
  // The 5e rule, and the reason bands are per seat rather than one shared mask:
  // darkvision does not light a room, it upgrades what you personally get out
  // of it — darkness reads as dim, dim reads as bright, and beyond that range
  // you get nothing. Two characters standing on the same square can genuinely
  // see different things.
  function recomputeSeatBands(field, seatId, viewers, layerId) {
    const size = FOG.columns * FOG.rows;
    let bands = field.bands.get(seatId);
    if (!bands || bands.length !== size) { bands = new Uint8Array(size); field.bands.set(seatId, bands); }
    else bands.fill(DARK);
    let explored = field.explored.get(seatId);
    if (!explored || explored.length !== size) { explored = new Uint8Array(size); field.explored.set(seatId, explored); }

    for (const actor of viewers) {
      if (actor.layerId !== layerId) continue;
      const footprint = actorFootprint(actor);
      const ox = Math.floor(actor.x + footprint.width / 2);
      const oy = Math.floor(actor.y + footprint.height / 2);
      if (ox < 0 || oy < 0 || ox >= FOG.columns || oy >= FOG.rows) continue;
      const dv = darkvisionCellsOf(actor);
      const dv2 = dv * dv;
      // Unbounded on purpose: a character with no darkvision standing in a
      // black cave must still see a bonfire two hundred feet away. Capping the
      // cast at the darkvision range would take that away from them.
      const reach = FOG.columns + FOG.rows;
      castFrom(field.occluder, ox, oy, reach, (x, y) => {
        if (x < 0 || y < 0 || x >= FOG.columns || y >= FOG.rows) return;
        const i = idx(x, y, FOG.columns);
        const lit = field.light[i];
        const dx = x - ox, dy = y - oy;
        const withinDark = dv > 0 && (dx * dx + dy * dy) <= dv2;
        let band = DARK;
        if (lit >= 2) band = BRIGHT;
        else if (lit === 1) band = withinDark ? BRIGHT : DIM;
        else if (withinDark) band = DIM;
        if (band > bands[i]) bands[i] = band;
      });
    }

    // The DM's forced overrides, after the geometry. Conceal is applied last so
    // that "no, they cannot see that" always wins over anything else.
    for (const region of boardState.fog.reveals) {
      if (region.layerId !== layerId || region.mode !== "reveal") continue;
      for (const cell of region.cells) {
        if (cell.x >= FOG.columns || cell.y >= FOG.rows) continue;
        const i = idx(cell.x, cell.y, FOG.columns);
        if (bands[i] < DIM) bands[i] = DIM;
      }
    }
    for (let i = 0; i < size; i += 1) if (bands[i] >= DIM) explored[i] = 1;
    for (let i = 0; i < size; i += 1) if (bands[i] === DARK && explored[i]) bands[i] = REMEMBERED;
    for (const region of boardState.fog.reveals) {
      if (region.layerId !== layerId || region.mode !== "conceal") continue;
      for (const cell of region.cells) {
        if (cell.x >= FOG.columns || cell.y >= FOG.rows) continue;
        bands[idx(cell.x, cell.y, FOG.columns)] = DARK;
      }
    }
    if (boardState.fog.mode === "hidden") bands.fill(DARK);
    return bands;
  }

  // Who a seat is looking through. A seat sees out of the eyes of what it
  // controls; the DM's own preview borrows a named seat's, because with fog
  // "what a player can see" is meaningless without saying which player.
  function viewersForSeat(seatId) {
    return boardState.actors.filter((actor) => actor.controller === seatId);
  }

  // Every floor a screen is currently pointed at: the DM's own, plus whichever
  // one each seat's character is standing on. Bounded by the number of seats,
  // not by the number of storeys — nobody pays for the attic they are not in.
  function liveLayerIds() {
    const found = new Set([activeLayerId()]);
    for (const seat of seats.values()) found.add(viewLayerForSeat(seat));
    found.delete("");
    return found;
  }

  function recomputeFog() {
    if (!FOG.dirty) return;
    FOG.dirty = false;
    const live = liveLayerIds();
    // A floor nobody is on stops being computed, but its explored memory is
    // kept — coming back up the stair should find the room as you left it.
    for (const layerId of live) {
      const field = fogField(layerId);
      // Re-read rather than trusted from when the field was made: a mask that
      // finished loading after the party walked onto its floor has to start
      // stopping light the moment it arrives.
      field.occluder = occluders.get(layerId)?.data || null;
      if (!fogActive(layerId)) continue;
      recomputeLight(field, layerId);
      // Every seat is banded on every live floor, not only on its own. The DM's
      // union below needs all of them, and a seat that takes a stair mid-round
      // then already has bands waiting on the floor it arrives at.
      for (const seat of seats.values()) recomputeSeatBands(field, seat.id, viewersForSeat(seat.id), layerId);
      // The DM sees the union of everything anyone can see, so the fog on their
      // screen marks what the table has NOT reached rather than hiding it.
      const size = FOG.columns * FOG.rows;
      if (field.dmBands.length !== size) field.dmBands = new Uint8Array(size);
      field.dmBands.fill(DARK);
      for (const bands of field.bands.values()) {
        for (let i = 0; i < size; i += 1) if (bands[i] > field.dmBands[i]) field.dmBands[i] = bands[i];
      }
    }
    FOG.epoch += 1;
  }

  // Two bits a cell, base64'd. 12,288 cells on the warren is 3 KB packed, and
  // it only goes when it changes — so fog costs bandwidth per move, not per HP
  // tick, and a state that is absolute rather than a delta cannot desync.
  function packBands(bands) {
    const bytes = new Uint8Array(Math.ceil(bands.length / 4));
    for (let i = 0; i < bands.length; i += 1) bytes[i >> 2] |= (bands[i] & 3) << ((i & 3) * 2);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(binary);
  }

  // ---- lights ----------------------------------------------------------------
  // 5e's kit, in feet of bright then dim. A torch is 20/20, which is to say
  // bright to 20 and dim to 40 — the second number here is the outer edge, not
  // the width of the ring, because that is how a lantern is described on a
  // character sheet and this is read by whoever is holding one.
  const LIGHT_KINDS = [
    { id: "candle", name: "Candle", brightFt: 5, dimFt: 10 },
    { id: "torch", name: "Torch", brightFt: 20, dimFt: 40 },
    { id: "lantern", name: "Coal-oil lantern", brightFt: 30, dimFt: 60 },
    { id: "bullseye", name: "Bullseye lantern", brightFt: 60, dimFt: 120 }
  ];

  function lightKind(id) {
    return LIGHT_KINDS.find((kind) => kind.id === id) || LIGHT_KINDS[1];
  }

  function lightAt(cell) {
    return boardState.lights.find((light) => {
      const origin = lightOrigin(light);
      return origin && origin.layerId === cell.layerId && origin.x === cell.x && origin.y === cell.y;
    }) || null;
  }

  function addLightAt(cell, unlit) {
    const kind = lightKind(ui.lightKind?.value);
    boardState.lights.push({
      id: crypto.randomUUID(),
      layerId: cell.layerId,
      actorId: "",
      x: cell.x, y: cell.y,
      brightFt: kind.brightFt, dimFt: kind.dimFt,
      color: "#ffb761",
      on: !unlit,
      name: kind.name
    });
    FOG.dirty = true;
    broadcastState();
  }

  function removeLight(id) {
    boardState.lights = boardState.lights.filter((light) => light.id !== id);
    FOG.dirty = true;
    broadcastState();
  }

  // Hand a light to an actor. Nothing about the position is copied — see
  // lightOrigin — so from here on it simply goes where they go.
  function carryLight(actorId, kindId) {
    if (!can("effects")) return;
    boardState.lights = boardState.lights.filter((light) => light.actorId !== actorId);
    if (kindId !== "none") {
      const kind = lightKind(kindId);
      boardState.lights.push({
        id: crypto.randomUUID(), layerId: "", actorId, x: 0, y: 0,
        brightFt: kind.brightFt, dimFt: kind.dimFt, color: "#ffb761", on: true, name: kind.name
      });
    }
    FOG.dirty = true;
    broadcastState();
  }

  function carriedLight(actorId) {
    return boardState.lights.find((light) => light.actorId === actorId) || null;
  }

  // ---- the DM's controls. All three are geometry-class: shared and DM-only. ----

  function setFogEnabled(next) {
    if (!can("effects")) return;
    boardState.fog.enabled = Boolean(next);
    FOG.dirty = true;
    renderFogControls();
    broadcastState();
  }

  function setFogMode(mode) {
    if (!can("effects") || !FOG_MODES.has(mode)) return;
    boardState.fog.mode = mode;
    FOG.dirty = true;
    renderFogControls();
    broadcastState();
    // Worth saying out loud: "revealed" looks identical to "fog is broken"
    // from the DM's chair, and the difference matters at 11pm.
    if (mode === "revealed") showToast("Darkness off — every screen sees the whole floor");
    if (mode === "hidden") showToast("Lights out — every player screen is dark");
  }

  function setLayerAmbient(layerId, band) {
    if (!can("effects") || !AMBIENT_BANDS.has(band)) return;
    boardState.fog.ambient = { ...boardState.fog.ambient, [layerId]: band };
    FOG.dirty = true;
    renderFogControls();
    broadcastState();
  }

  function renderFogControls() {
    if (!ui.fogEnabled) return;
    const fog = boardState.fog || {};
    ui.fogEnabled.checked = Boolean(fog.enabled);
    ui.fogMode.value = FOG_MODES.has(fog.mode) ? fog.mode : "dynamic";
    const layerId = activeLayerId();
    const band = ambientBand(layerId);
    ui.fogAmbient.value = band === DARK ? "dark" : band === DIM ? "dim" : "bright";
    ui.fogModeRow.hidden = !fog.enabled;
  }

  function unpackBands(packed, size) {
    const binary = atob(packed);
    const bands = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) bands[i] = (binary.charCodeAt(i >> 2) >> ((i & 3) * 2)) & 3;
    return bands;
  }

  function selectedActor() {
    return boardState.actors.find((actor) => actor.id === selectedActorId) || null;
  }

  // The sheet's writable half — what used to be the sidebar's "Actor details".
  // Two questions decide every row: does this actor have the thing at all (a
  // bottle has no armour class and nothing to rotate), and may this screen write
  // it (the DM writes everything; a seat writes the current health of what it
  // controls, and its name, inventory, and notes).
  //
  // A library pack shows none of it. There is no token to write to, so a field
  // would be a lie the moment anyone typed in it.
  function renderSheetControls() {
    const actor = sheetActor();
    const preview = sheetIsPreview();
    if (!actor || preview || !canEditActor(actor)) { ui.actorManageSection.hidden = true; return; }
    const definition = actorDefinition(actor);
    const host = isDM();
    const health = tracksHealth(actor);
    ui.actorManageSection.hidden = false;

    // Health, and everything that only means something against a health total.
    const seeHp = health && canSeeHp(actor);
    ui.manageHpCurrentField.hidden = !seeHp; ui.manageHpMaxField.hidden = !(seeHp && host);
    ui.manageAcField.hidden = !(health && host); ui.manageThresholdField.hidden = !(health && host);
    ui.manageIndestructibleField.hidden = !(health && host);
    if (document.activeElement !== ui.manageHpCurrent) ui.manageHpCurrent.value = seeHp ? actor.hp.current : "";
    if (document.activeElement !== ui.manageHpMax) ui.manageHpMax.value = seeHp ? actor.hp.max : "";
    if (document.activeElement !== ui.manageAc) ui.manageAc.value = actor.armorClass;
    if (document.activeElement !== ui.manageThreshold) ui.manageThreshold.value = actor.damageThreshold;
    ui.manageIndestructible.checked = Boolean(actor.indestructible);

    ui.manageControllerField.hidden = !host;
    if (host && document.activeElement !== ui.manageController) {
      ui.manageController.replaceChildren(new Option("DM / Host", "host"));
      for (const seat of seats.values()) if (seat.channel?.readyState === "open") ui.manageController.append(new Option(seat.name, seat.id));
      ui.manageController.value = actor.controller;
    }

    ui.manageRotationField.hidden = actor.kind === "item";
    ui.manageRotation.querySelectorAll("button").forEach((control) => {
      control.classList.toggle("active", control.dataset.rotation === actor.rotation);
      control.disabled = !canRotate(actor);
    });

    ui.manageSizeField.hidden = !host;
    if (host && document.activeElement !== ui.manageSize) {
      const own = LaramieActors.normalizeFootprint(actor.footprint);
      ui.manageSize.value = own ? `${own.width}x${own.height}` : "";
    }

    // Inventory is what an actor carries. A person carries things; an item does
    // not — a container holds them, and that is its own list further down.
    ui.manageInventoryField.hidden = actor.kind === "item";
    if (document.activeElement !== ui.manageInventory) ui.manageInventory.value = actor.inventory || "";
    if (document.activeElement !== ui.manageNotes) ui.manageNotes.value = actor.notes || "";

    // Damage is the DM's. A thing with no health has no number to subtract, so
    // it gets the only button that means anything: end it.
    ui.manageDamageRow.hidden = !host || !health;
    ui.manageDestroy.hidden = !host || health;
    ui.manageDestroy.textContent = actor.removeOnDestroyed ? "Use it up" : "Break it";
    ui.manageRemove.hidden = !host;
  }

  // Every writable field commits the same way: the DM writes the board, a seat
  // asks the host to. What a seat may send is decided here and enforced again in
  // updateActorFromPlayer, because a message is only ever a request.
  function commitSheetControls() {
    const actor = sheetActor();
    if (!actor || sheetIsPreview() || !canEditActor(actor)) return;
    const patch = { inventory: ui.manageInventory.value, notes: ui.manageNotes.value };
    if (role === "player") {
      if (tracksHealth(actor) && ui.manageHpCurrent.value !== "") {
        patch.hpCurrent = Math.max(0, Number(ui.manageHpCurrent.value) || 0);
      }
      send(playerChannel, { type: "intent", action: "updateActor", actorId: actor.id, patch });
      return;
    }
    const hp = { current: Math.max(0, Number(ui.manageHpCurrent.value) || 0), max: Math.max(1, Number(ui.manageHpMax.value) || 1) };
    hp.current = Math.min(hp.current, hp.max);
    Object.assign(actor, patch, {
      armorClass: Math.max(0, Number(ui.manageAc.value) || 0),
      damageThreshold: Math.max(0, Number(ui.manageThreshold.value) || 0),
      indestructible: ui.manageIndestructible.checked,
      controller: ui.manageController.value || "host"
    });
    // An actor with no health total keeps the single point its pack was given;
    // writing the fields it never showed would be inventing a number.
    if (tracksHealth(actor)) actor.hp = hp;
    broadcastState();
  }

  // Rarity is what an item is, and the DM may say this one is something else —
  // the plain revolver on the table turning out to be the famous one. It is an
  // override on this token; the pack on disk is never touched.
  function raritySelect(actor, definition) {
    const select = document.createElement("select");
    select.className = "rarity-select";
    for (const rarity of RARITIES) select.append(new Option(rarity, rarity));
    select.value = rarityOf(definition, actor);
    select.addEventListener("change", () => {
      const target = boardState.actors.find((item) => item.id === actor.id);
      if (!target || role !== "host") return;
      // Back to whatever the pack says, rather than freezing today's answer in.
      if (select.value === rarityOf(definition)) delete target.rarity; else target.rarity = select.value;
      broadcastState(); renderActors(); openItemSheetAgain();
    });
    return select;
  }

  // Rotation follows the whole selection, the same as a move or a delete does,
  // so a group highlighted from the library turns together. Items in that group
  // sit it out — they have no front to turn.
  function rotateSelected(rotation) {
    applyRotations(selectedActors().filter(canRotate).map((actor) => ({ id: actor.id, rotation })));
  }

  function applyRotations(changes) {
    if (!changes.length) return;
    if (role === "player") {
      for (const change of changes) send(playerChannel, { type: "intent", action: "rotateActor", actorId: change.id, rotation: change.rotation });
      return;
    }
    for (const change of changes) {
      const actor = boardState.actors.find((item) => item.id === change.id);
      if (actor && ROTATIONS.includes(change.rotation)) actor.rotation = change.rotation;
    }
    broadcastState();
  }

  // Damage is dealt from the sheet, to the actor the sheet is about. A pack shown
  // straight from the library is not on the table and cannot be hurt.
  function damageSheetActor(rawDamage) {
    const actor = sheetActor(); if (!actor || sheetIsPreview() || role !== "host") return;
    const result = LaramieActors.applyDamage(actor, rawDamage);
    if (result.reason === "indestructible") showToast(`${actor.name} is indestructible`);
    else if (result.reason === "threshold") showToast("The damage did not exceed the threshold");
    else if (result.reason === "destroyed") showToast(`${actor.name} is finished`);
    else showToast(`${result.applied} damage to ${actor.name}`);
    if (result.destroyed && actor.removeOnDestroyed) {
      boardState.actors = boardState.actors.filter((item) => item.id !== actor.id);
      selectedActorIds.delete(actor.id); selectedActorId = [...selectedActorIds].at(-1) || "";
      showToast(`${actor.name} was destroyed and removed`);
      closeActorSheet();
    }
    broadcastState();
  }

  function removeSheetActor() {
    FOG.dirty = true;
    const actor = sheetActor(); if (!actor || sheetIsPreview()) return;
    if (role !== "host") { showToast("Only the host can remove actors"); return; }
    boardState.actors = boardState.actors.filter((item) => item.id !== actor.id);
    selectedActorIds.delete(actor.id); selectedActorId = [...selectedActorIds].at(-1) || "";
    closeActorSheet(); broadcastState();
    showToast(`${actor.name} removed`);
  }

  function deleteSelectedActors() {
    FOG.dirty = true;
    const actors = selectedActors();
    if (!actors.length) return;
    if (role !== "host") { showToast("Only the host can remove actors"); return; }
    const ids = new Set(actors.map((actor) => actor.id));
    boardState.actors = boardState.actors.filter((actor) => !ids.has(actor.id));
    clearActorSelection(false); broadcastState();
    showToast(`${actors.length} actor${actors.length === 1 ? "" : "s"} removed`);
  }

  // The copy holds detached snapshots rather than actor ids, so it survives the
  // originals being deleted, a floor switch, or a whole new encounter loading.
  // Positions are stored relative to the group's top-left corner, which is what
  // lets a paste rebuild the same arrangement anywhere on the board.
  let clipboard = null;

  function copySelectedActors() {
    const actors = selectedActors();
    if (!actors.length) return;
    const originX = Math.min(...actors.map((actor) => actor.x));
    const originY = Math.min(...actors.map((actor) => actor.y));
    let width = 1; let height = 1;
    for (const actor of actors) {
      const definition = actorDefinition(actor);
      const footprint = actorFootprint(actor);
      width = Math.max(width, actor.x - originX + footprint.width);
      height = Math.max(height, actor.y - originY + footprint.height);
    }
    clipboard = {
      x: originX, y: originY, width, height,
      actors: actors.map((actor) => ({ ...structuredClone(actor), x: actor.x - originX, y: actor.y - originY }))
    };
    showToast(`${actors.length} actor${actors.length === 1 ? "" : "s"} copied`);
  }

  // How far a paste lands from what it was copied from. Down-and-right is the
  // default, the way a duplicated thing usually appears, but a group sitting
  // against an edge — of the board, or of what is actually on screen — flips
  // that axis so the copy arrives somewhere the DM can still see it.
  const PASTE_MARGIN = 24;

  function pasteShift(bounds) {
    const size = boardState.grid.size;
    const rect = ui.viewport.getBoundingClientRect();
    const { columns, rows } = boardDimensions();
    const step = size * view.scale;
    const screenLeft = (boardState.grid.offsetX + bounds.x * size) * view.scale + view.x;
    const screenTop = (boardState.grid.offsetY + bounds.y * size) * view.scale + view.y;
    // Board room is a hard limit; screen room only decides which way to lean,
    // so a group hard against the board's edge still pastes back toward the map.
    const pick = (start, span, limit, near, far, viewport) => {
      const forward = start + span + 1 <= limit;
      const back = start - 1 >= 0;
      if (forward && far + step <= viewport - PASTE_MARGIN) return 1;
      if (back && near - step >= PASTE_MARGIN) return -1;
      return forward ? 1 : back ? -1 : 0;
    };
    return {
      dx: pick(bounds.x, bounds.width, columns, screenLeft, screenLeft + bounds.width * step, rect.width),
      dy: pick(bounds.y, bounds.height, rows, screenTop, screenTop + bounds.height * step, rect.height)
    };
  }

  function pasteActors() {
    if (!clipboard?.actors.length) return;
    // Creating actors is the DM's, the same as removing them; a player's board
    // has no way to add one and no intent to sync it with.
    if (role !== "host") { showToast("Only the host can add actors"); return; }
    const layerId = activeLayerId(); if (!layerId) return;
    const shift = pasteShift(clipboard);
    const anchorX = Math.max(0, clipboard.x + shift.dx);
    const anchorY = Math.max(0, clipboard.y + shift.dy);
    const created = [];
    let blocked = 0;
    for (const entry of clipboard.actors) {
      const definition = actorDefinition(entry);
      // A named character or PC is one to a board, exactly as when dragged in.
      if (isSingleInstance(definition) && boardState.actors.some((actor) => actor.assetId === entry.assetId)) { blocked += 1; continue; }
      const actor = { ...structuredClone(entry), id: crypto.randomUUID(), layerId, x: anchorX + entry.x, y: anchorY + entry.y };
      actor.facts = (actor.facts || []).map((fact) => ({ ...fact, id: crypto.randomUUID() }));
      Object.assign(actor, clampActorPosition(actor, actor.x, actor.y));
      boardState.actors.push(actor); created.push(actor);
    }
    if (!created.length) { showToast(`${blocked === 1 ? "That actor is" : "Those actors are"} already on the board`); return; }
    // Cascade: the next paste steps off this copy instead of landing on it.
    clipboard.x = anchorX; clipboard.y = anchorY;
    selectedActorIds.clear();
    for (const actor of created) selectedActorIds.add(actor.id);
    selectedActorId = created.at(-1).id;
    broadcastState();
    showToast(blocked
      ? `${created.length} pasted, ${blocked} already on the board`
      : `${created.length} actor${created.length === 1 ? "" : "s"} pasted`);
  }

  // Resizing a token is the DM overruling its pack for this one piece: it moves
  // the squares the thing occupies, so collision, clamping and the marquee all
  // follow it, and it goes out to the table like any other board change.
  function resizeSheetActor(value) {
    const actor = sheetActor();
    if (!actor || sheetIsPreview() || role !== "host") return;
    if (!value) delete actor.footprint;
    else {
      const [width, height] = value.split("x").map(Number);
      const size = LaramieActors.normalizeFootprint({ width, height });
      if (!size) { showToast("A token is either a quarter square or whole squares"); return; }
      actor.footprint = size;
    }
    // A bigger token can now overhang the map edge; pull it back if it does.
    Object.assign(actor, clampActorPosition(actor, actor.x, actor.y));
    broadcastState();
  }

  function setBrush(mode) {
    brushMode = mode;
    [[ui.brushMove, "move"], [ui.brushFlame, "flame"], [ui.brushExtinguish, "extinguish"], [ui.brushLight, "light"]].forEach(([control, value]) => control.classList.toggle("active", value === mode));
    ui.viewport.dataset.brush = mode;
    // Leaving the exit tool abandons a half-drawn link rather than leaving it
    // waiting to catch the next click on some unrelated floor.
    if (mode !== "exit") exitDraft = null;
    if (ui.addExit) ui.addExit.classList.toggle("active", mode === "exit");
    hoverCell = null; hoverRegionId = "";
    renderEffects();
    renderExitList();
  }

  function openActorSheet() {
    const actor = selectedActor(); if (!actor) return;
    if (!canViewActorSheet(actor)) { showToast("That NPC sheet is visible to the host only"); return; }
    if (sheetIsOpen() && sheetActorId === actor.id) { closeActorSheet(); return; }
    previewActor = null;
    showSheetFor(actor);
  }

  // A library card opens the same sheet a token does. There is no instance to
  // show, so the pack is dressed in a stand-in that never reaches the board: every
  // renderer below then works unchanged, while the write affordances — health,
  // rename, facts, item state — stay shut, because there is nothing to write to.
  // Clicking the card again re-renders rather than toggling, so it never fights
  // the spotlight walking through that pack's copies on the board.
  function openLibrarySheet(definition) {
    if (!definition) return;
    previewActor = LaramieActors.createInstance(definition, { layerId: activeLayerId() });
    showSheetFor(previewActor);
  }

  function showSheetFor(actor) {
    sheetActorId = actor.id;
    const definition = actorDefinition(actor);
    ui.actorKind.textContent = `${actor.kind.replace("_", " ")} reference`;
    // A pack with a `mini:` block uses it for the map token, but the sheet wants
    // a face — so the portrait art wins here, falling back to the token.
    const tokenUrl = definition ? LaramieActors.imageFor(definition, actor.rotation) : "";
    const portraitUrl = definition?.portrait || definition?.image || tokenUrl;
    // The button opens every picture the pack ships, so a mini-only pack still
    // offers one even with no portrait of its own.
    const pictures = LaramieActors.gallery(definition);
    ui.actorPortraitButton.hidden = !pictures.length;
    ui.actorPortraitButton.setAttribute("aria-label",
      pictures.length > 1 ? `View all ${pictures.length} images of ${actor.name}` : "View the full portrait");
    if (portraitUrl) { ui.actorPortrait.src = portraitUrl; ui.actorPortrait.alt = `${actor.name} portrait`; }
    else { ui.actorPortrait.removeAttribute("src"); ui.actorPortrait.alt = ""; }
    renderSheetGallery(definition, pictures);
    renderDossier(definition?.dossier);
    openItemSheetAgain();
    renderSheetEntries(ui.actorRules, ui.actorRulesSection, definition?.mechanics);
    renderSheetEntries(ui.actorAttacks, ui.actorAttacksSection, definition?.attacks);
    renderSheetEntries(ui.actorAbilities, ui.actorAbilitiesSection, definition?.abilities);
    ui.factText.value = "";
    updateActorSheet();
    ui.actorSheet.classList.add("open");
    ui.actorSheet.setAttribute("aria-hidden", "false");
  }

  function sheetActor() {
    return boardState.actors.find((actor) => actor.id === sheetActorId)
      || (previewActor?.id === sheetActorId ? previewActor : null);
  }

  // True while the sheet is showing a library pack rather than a token on the
  // board. Everything that writes checks this: the stand-in is not in
  // `boardState`, so a change made to it would go nowhere and broadcast nothing.
  function sheetIsPreview() {
    return Boolean(previewActor) && previewActor.id === sheetActorId;
  }

  // A single picture needs no strip — the portrait at the top of the sheet is
  // already it, and the button beside it opens the full-size view.
  function renderSheetGallery(definition, pictures = LaramieActors.gallery(definition)) {
    ui.actorGallerySection.hidden = pictures.length < 2;
    ui.actorGallery.replaceChildren(...(ui.actorGallerySection.hidden
      ? [] : [assetStrip(pictures, definition?.name || "")]));
  }

  function sheetMeta(definition, actor) {
    const mechanics = definition?.mechanics || {};
    return [mechanics.race || mechanics.species, mechanics.class_level, mechanics.size, actor.kind.replaceAll("_", " ")]
      .filter(Boolean).join(" · ");
  }

  function sheetIsOpen() { return ui.actorSheet.classList.contains("open"); }

  function closeActorSheet() {
    sheetActorId = ""; previewActor = null;
    if (ui.portraitDialog.open) ui.portraitDialog.close();
    ui.actorSheet.classList.remove("open");
    ui.actorSheet.setAttribute("aria-hidden", "true");
    ui.viewport.focus({ preventScroll: true });
  }


  // The pack's `dossier:` block — prose the DM keeps on hand. It rides inside the
  // sheet, so `sheet_visibility` already decides who may read it: an NPC's dossier
  // is DM-only because its whole sheet is, and a PC's is open because its sheet is.
  function renderDossier(dossier) {
    ui.actorDossier.replaceChildren();
    const sections = Object.entries(dossier || {}).filter(([, prose]) => String(prose ?? "").trim());
    ui.actorDossierSection.hidden = !sections.length;
    for (const [key, prose] of sections) {
      const heading = document.createElement("h4");
      heading.textContent = key.replaceAll("_", " ");
      ui.actorDossier.append(heading);
      // Blank lines are paragraph breaks; single newlines are soft wraps.
      for (const paragraph of String(prose).trim().split(/\n\s*\n/)) {
        const block = document.createElement("p");
        block.textContent = paragraph.replace(/\s*\n\s*/g, " ").trim();
        ui.actorDossier.append(block);
      }
    }
  }

  // Everything an object is that a person is not: how rare it is, what it takes
  // to open, what happens if you get that wrong, and what is inside. The numbers
  // are targets a player has to beat, so they are gathered into one block the DM
  // reads at a glance rather than left scattered through the prose.
  //
  // Some of this is per-instance and moves during a scene — this chest is
  // unlocked now, that trap has been found — so it reads the instance and falls
  // back to the manifest.
  // The board adjudicates nothing. It is a table with the pieces on it: it shows
  // what a thing is and what is true about it right now, and the people decide
  // what happens. So a target number is the DM's side of the conversation and
  // never appears on a player's sheet — the player rolls, says "does 13 beat
  // it?", and someone behind the screen answers. Print the DC for them and
  // nobody ever has to ask.
  function itemEntries(definition, actor) {
    const entries = {};
    const dm = {};
    // Rarity is what an item is, so it leads — and it is answered for every item,
    // enchanted or not. A barrel or a wagon is scenery rather than something
    // anyone owns, so it is not asked the question unless its pack answers it
    // anyway, which is an author saying this particular prop is worth ranking.
    if (definition?.kind === "item" || definition?.rarity || definition?.magic?.rarity || actor?.rarity) {
      const rarity = rarityOf(definition, actor);
      entries.rarity = rarity === "legendary" ? "legendary — the only one there is" : rarity;
    }
    const magic = definition?.magic;
    if (magic) {
      const bonus = magic.magical ? (magic.bonus ?? RARITY_BONUS[rarityOf(definition, actor)] ?? 0) : 0;
      // A concealed enchantment stays concealed until it is found; once it is,
      // the bonus is the item's own statistic and belongs to whoever holds it.
      if (magic.magical && (actor.magicKnown || isDM())) {
        entries.enchantment = bonus ? `Magical, ${signed(bonus)} to attack and damage` : "Magical";
        for (const [key, text] of Object.entries(magic.effects || {})) entries[key] = text;
      }
      if (magic.detect_dc && !actor.magicKnown) dm.detect_magic = `DC ${magic.detect_dc} Arcana to notice it is enchanted`;
      if (magic.identify_dc) dm.identify = `DC ${magic.identify_dc} to learn what it does`;
    }

    const security = definition?.security;
    if (security) {
      // That it is locked is plain to anyone who tries the lid. What it takes to
      // beat it is not.
      if (security.locked || actor.locked) entries.locked = "Locked";
      if (security.lock_dc) dm.pick_the_lock = `DC ${security.lock_dc} with thieves' tools`;
      if (security.force_dc) dm.force_it = `DC ${security.force_dc} Athletics`;
      if (security.spot_dc) dm.spot_it = `DC ${security.spot_dc} Perception to find it at all`;
      if (security.key) dm.the_key = security.key;
      if (security.ward) dm.ward = security.ward + (security.ward_dc ? ` — DC ${security.ward_dc}` : "");
      const trap = security.trap;
      if (trap) {
        // Finding a trap tells the party there is one. It does not hand them the
        // trigger, the damage, or the number to disarm it.
        if (actor.trapFound) entries.trapped = actor.trapArmed ? "Trapped, still armed" : "Trapped, disarmed";
        dm.trap = trap.trigger || "Trapped.";
        dm.spot_the_trap = `DC ${trap.spot_dc} Perception`;
        dm.disarm_the_trap = `DC ${trap.disarm_dc} with thieves' tools`;
        if (trap.damage) dm.trap_damage = trap.damage + (trap.save ? ` — ${trap.save}` : "");
      }
    }

    const ammunition = definition?.ammunition;
    if (ammunition) {
      entries.loaded = `${actor.loaded ?? ammunition.loaded} of ${ammunition.capacity}` +
        (ammunition.uses ? ` · ${ammunition.uses}` : "");
      if (ammunition.reload) entries.reload = ammunition.reload;
    }

    const stats = definition?.stats || {};
    if (stats.weak_to?.length) entries.weak_to = stats.weak_to.join(", ");
    if (stats.resists?.length) entries.resists = stats.resists.join(", ");
    return isDM() ? { ...entries, ...dm } : entries;
  }

  const RARITY_BONUS = { common: 0, rare: 1, legendary: 2 };

  // The state that moves during play. Only the DM turns these — a locked box is
  // the DM's fact about the world, not something a player toggles from a sheet.
  function renderItemControls(definition, actor) {
    ui.itemControls.replaceChildren();
    // A library pack has no lock to turn and no lid to open — those are states a
    // particular chest on the board is in, not facts about the manifest.
    if (!isDM() || sheetIsPreview()) return;
    const toggle = (label, on, apply) => {
      const control = button(label, () => { apply(); broadcastState(); renderActors(); openItemSheetAgain(); });
      control.className = `button compact${on ? " active" : ""}`;
      ui.itemControls.append(control);
    };
    if (definition?.security) {
      toggle(actor.locked ? "Locked" : "Unlocked", actor.locked, () => { actor.locked = !actor.locked; });
      if (definition.security.trap) {
        toggle(actor.trapFound ? "Trap found" : "Trap hidden", actor.trapFound, () => { actor.trapFound = !actor.trapFound; });
        toggle(actor.trapArmed ? "Trap armed" : "Trap disarmed", actor.trapArmed, () => { actor.trapArmed = !actor.trapArmed; });
      }
    }
    if (definition?.container) {
      // Open and locked are set independently and never inferred from each
      // other. A lid forced off a still-locked strongbox, a chest unlocked but
      // never opened, a lock picked and re-set behind them — those are all
      // states a table reaches, and the board's job is to show whichever one the
      // DM says it is, not to work out which are allowed.
      toggle(actor.open ? "Open" : "Closed", actor.open, () => { actor.open = !actor.open; });
    }
    if (definition?.magic?.magical && definition.magic.detect_dc) {
      toggle(actor.magicKnown ? "Enchantment known" : "Enchantment hidden", actor.magicKnown,
        () => { actor.magicKnown = !actor.magicKnown; });
    }
  }

  function renderItemContents(definition, actor) {
    const held = sheetIsPreview() ? [] : contentsOf(actor.id);
    // A closed opaque container tells the party nothing; the DM always sees in.
    const visible = isDM() || actor.open || !definition?.container?.opaque;
    ui.itemContents.hidden = !definition?.container || !held.length || !visible;
    ui.itemContentsList.replaceChildren();
    if (ui.itemContents.hidden) return;
    for (const item of held) {
      const row = document.createElement("li");
      const name = document.createElement("strong"); name.textContent = item.name;
      row.append(name);
      if (isDM()) {
        const spill = button("Take it out", () => {
          // Spilling is just cutting the parent — it is already a real actor
          // standing on the board, so it simply stops travelling with the box.
          item.parent = ""; broadcastState(); renderActors(); openItemSheetAgain();
        });
        spill.className = "button compact"; row.append(spill);
      }
      ui.itemContentsList.append(row);
    }
  }

  // Re-render the open sheet in place after a control changes instance state.
  function openItemSheetAgain() {
    const actor = sheetActor(); if (!actor) return;
    const definition = actorDefinition(actor);
    const editors = isDM() && !sheetIsPreview() ? { rarity: () => raritySelect(actor, definition) } : {};
    renderSheetEntries(ui.actorItem, ui.actorItemSection, itemEntries(definition, actor), editors);
    ui.actorItemSection.hidden = !hasItemLayer(definition);
    renderItemControls(definition, actor);
    renderItemContents(definition, actor);
  }

  // An item always has the block, because it always has a rarity. Everything else
  // — a wagon, a barrel, a chest — earns one only by carrying something to say.
  function hasItemLayer(definition) {
    return definition?.kind === "item"
      || Boolean(definition?.magic || definition?.security || definition?.container || definition?.ammunition
        || definition?.stats?.weak_to?.length || definition?.stats?.resists?.length);
  }

  // `editors` turns a row from a readout into a control: a key named there gets
  // whatever element its function builds instead of the text. It is how a value
  // the DM may change is edited where it is read, rather than in a second panel
  // that says the same thing again.
  function renderSheetEntries(list, section, entries = {}, editors = {}) {
    list.replaceChildren();
    const actor = sheetActor();
    for (const [key, value] of Object.entries(entries || {})) {
      const label = key.replaceAll("_", " ");
      const term = document.createElement("dt"); term.textContent = label;
      const detail = document.createElement("dd");
      const who = `${actor?.name || "Actor"} · ${label}`;
      const attack = editors[key] ? null : parseAttackLine(value);
      const roll = attack || editors[key] ? null : parseRollable(value);
      if (editors[key]) {
        detail.append(editors[key]());
      } else if (attack) {
        // The statblock sentence stays readable prose; the rolls hang off it as
        // their own controls — one d20 to hit, one button per damage die.
        const prose = document.createElement("p");
        prose.className = "sheet-attack-text"; prose.textContent = String(value);
        const actions = document.createElement("div"); actions.className = "roll-actions";
        actions.append(d20Combo(`Attack ${signed(attack.toHit)}`, `${who} atk`, {
          groups: [{ qty: 1, sides: 20, mode: "normal" }], modifier: attack.toHit
        }));
        for (const damage of attack.damage) {
          const text = attack.damage.length > 1 && damage.label ? `${damage.label} dmg` : "Dmg";
          actions.append(sheetRollButton(`${text} ${damage.formula}`, `${who} dmg`, damage.roll));
        }
        detail.append(prose, actions);
      } else if (roll && String(value).length <= 64) {
        // A bare "+N" is a d20 check, so it gets the tray's A/D chips too.
        detail.append(isD20(roll)
          ? d20Combo(String(value), who, roll)
          : sheetRollButton(String(value), who, roll));
      } else if (roll && /\d\s*d\s*\d/i.test(value)) {
        // Prose with dice buried in it: keep the sentence readable and hang a
        // compact button off it rather than making the paragraph one big target.
        const prose = document.createElement("p");
        prose.className = "sheet-attack-text"; prose.textContent = String(value);
        const actions = document.createElement("div"); actions.className = "roll-actions";
        actions.append(sheetRollButton(rollFormula(roll), who, roll));
        detail.append(prose, actions);
      } else detail.textContent = String(value);
      list.append(term, detail);
    }
    section.hidden = !list.children.length;
  }

  const signed = (value) => `${value >= 0 ? "+" : "−"}${Math.abs(value)}`;
  const isD20 = (roll) => roll.groups.length === 1 && roll.groups[0].sides === 20;
  const rollFormula = (roll) => roll.groups.map((group) => `${group.qty}d${group.sides}`).join(" + ")
    + (roll.modifier ? ` ${signed(roll.modifier)}` : "");

  function sheetRollButton(text, roller, roll) {
    const trigger = document.createElement("button");
    trigger.type = "button"; trigger.className = "rollable";
    trigger.textContent = text; trigger.title = "Click to roll";
    trigger.addEventListener("click", () => rollFromSheet(roller, roll));
    return trigger;
  }

  // A d20 roll carries its own Advantage / Disadvantage chips — the same idea as
  // the dice tray's A/D: roll the d20 twice and keep the higher (or the lower).
  function d20Combo(text, roller, roll) {
    const wrap = document.createElement("span"); wrap.className = "roll-combo";
    wrap.append(sheetRollButton(text, roller, roll));
    for (const [mode, chip, tip] of [
      ["advantage", "A", "Advantage — roll twice, keep the higher"],
      ["disadvantage", "D", "Disadvantage — roll twice, keep the lower"],
    ]) {
      const button = document.createElement("button");
      button.type = "button"; button.className = "roll-mode"; button.dataset.mode = mode;
      button.textContent = chip; button.title = tip;
      const shifted = { ...roll, groups: roll.groups.map((group) => group.sides === 20 ? { ...group, mode } : group) };
      button.addEventListener("click", () => rollFromSheet(roller, shifted));
      wrap.append(button);
    }
    return wrap;
  }

  // A statblock attack sentence — "Melee Weapon Attack: +2 to hit, reach 5 ft.,
  // one target. Hit: 3 (1d4 + 1) bludgeoning damage." — is TWO rolls, not one.
  // Read the to-hit bonus and each damage expression out separately; blending
  // them gives the nonsense "1d4 + 2" the sheet used to roll.
  function parseAttackLine(raw) {
    const value = String(raw ?? "").trim();
    if (!/\bto hit\b/i.test(value)) return null;
    const hit = value.match(/([+-]\s*\d+)\s*to hit/i);
    const damage = [];
    for (const match of value.matchAll(/\d+\s*d\s*\d+(?:\s*[+-]\s*\d+)?/gi)) {
      const roll = parseRollable(match[0]);
      if (!roll) continue;
      // The damage type is the word right before "damage", within this clause.
      const after = value.slice(match.index + match[0].length, match.index + match[0].length + 40);
      const type = after.match(/^[^.;]*?\b([a-z]+)\s+damage/i);
      damage.push({ roll, label: type ? type[1].toLowerCase() : "", formula: match[0].replace(/\s+/g, "") });
    }
    return { toHit: hit ? Number(hit[1].replace(/\s+/g, "")) : 0, damage };
  }

  // Turn a sheet value into a dice roll: "1d10+4" / "2d6" -> those dice;
  // a bare modifier like "+3", "-1", or "16 (+3)" -> a d20 check with that bonus.
  // "adv"/"dis" anywhere in a d20 value rolls with advantage/disadvantage.
  function parseRollable(raw) {
    const value = String(raw ?? "").trim();
    if (!value) return null;
    const allowed = new Set([4, 6, 8, 10, 12, 20, 100]);
    const diceMatches = [...value.matchAll(/(\d+)\s*d\s*(\d+)/gi)];
    const mode = /disadv/i.test(value) ? "disadvantage" : /\badv/i.test(value) ? "advantage" : "normal";
    if (diceMatches.length) {
      const groups = diceMatches.map((m) => ({ qty: Number(m[1]), sides: Number(m[2]), mode }))
        .filter((g) => g.qty > 0 && allowed.has(g.sides));
      if (!groups.length) return null;
      const tail = value.replace(/\d+\s*d\s*\d+/gi, "");
      const mod = tail.match(/[+-]\s*\d+/);
      return { groups, modifier: mod ? Number(mod[0].replace(/\s+/g, "")) : 0 };
    }
    const mod = value.match(/[+-]\s*\d+/);
    if (!mod) return null;
    // A bare "+N" check is a d20; an "adv"/"disadv" note applies to that d20.
    return { groups: [{ qty: 1, sides: 20, mode }], modifier: Number(mod[0].replace(/\s+/g, "")) };
  }

  function rollFromSheet(roller, roll) {
    window.dispatchEvent(new CustomEvent("laramie:dice-roll", {
      detail: { groups: roll.groups, modifier: roll.modifier, roller }
    }));
  }

  function updateActorSheet() {
    const actor = sheetActor(); if (!actor) return;
    const definition = actorDefinition(actor);
    const footprint = actorFootprint(actor);
    const host = isDM();
    const health = tracksHealth(actor);
    const speed = Number(actor.movementSpeed ?? definition?.stats?.speed_ft ?? 0);
    syncSheetTitle(actor);
    ui.actorMeta.textContent = sheetMeta(definition, actor);
    ui.actorHp.textContent = canSeeHp(actor) ? `${actor.hp.current} / ${actor.hp.max}` : "—";
    ui.actorAc.textContent = actor.armorClass;
    ui.actorSpeed.textContent = `${speed} ft.`;
    ui.actorSpace.textContent = footprintLabel(footprint);
    ui.actorThreshold.textContent = actor.indestructible ? "∞" : actor.damageThreshold;
    // Only the tiles this actor has an answer for. A thing with no health total
    // has no armour class and no threshold either — a bomb is not hit, it is
    // used — and a thing that does not move has no speed to print. The space it
    // takes up on the board is the one statistic every actor always has.
    ui.vitalHp.hidden = !health; ui.vitalAc.hidden = !health; ui.vitalThreshold.hidden = !health;
    ui.vitalSpeed.hidden = !speed;
    // Nothing on a library pack's sheet is writable: it is the manifest, not a
    // thing on the table that can be hurt, renamed, or given a secret.
    const preview = sheetIsPreview();
    const mayEdit = canEditActor(actor) && !preview;
    ui.hpStepper.hidden = !mayEdit;
    ui.decreaseHp.disabled = actor.hp.current <= 0;
    ui.increaseHp.disabled = actor.hp.current >= actor.hp.max;
    const barShown = actor.hpVisible !== false;
    ui.actorHpVisibility.hidden = !host || preview;
    ui.actorHpVisibility.textContent = barShown ? "Bar shown" : "Bar hidden";
    ui.actorHpVisibility.classList.toggle("off", !barShown);
    ui.actorHpVisibility.setAttribute("aria-pressed", String(barShown));
    ui.actorHealthAccess.textContent = preview
      ? "Straight from the pack. Drag it onto the map to make one you can damage."
      : !health
        ? "Nothing here wears down. One hit and it is spent."
        : host
          ? "Only you track health. The party reads its own; everyone else sees nothing."
          : mayEdit
            ? "This one is yours to track. Every change reaches the DM."
            : isPartyMember(actor)
              ? "Their own player keeps this count."
              : "Only the DM knows this one’s condition.";
    ui.sheetKeyboard.textContent = [
      "C toggles this sheet",
      mayEdit ? "click the name to rename" : "",
      mayEdit && health ? "+/− changes HP" : "",
      "Escape or × closes it",
    ].filter(Boolean).join(" · ");
    // The whole affiliation block is `.dm-only`, so a player's sheet never shows
    // it. Blank the chip on the way out anyway rather than leave the last outfit
    // the DM looked at sitting in a hidden node.
    if (host) {
      const affiliation = affiliationOf(actor);
      ui.affiliationChip.style.setProperty("--chip", affiliation?.color || UNKNOWN_OUTLINE);
      ui.affiliationChip.classList.toggle("unknown", !affiliation);
      ui.affiliationChip.querySelector("b").textContent = affiliationLabel(actor);
      ui.affiliationField.hidden = preview;
      if (!preview && document.activeElement !== ui.actorAffiliation) fillAffiliationSelect(ui.actorAffiliation, actor);
    } else {
      ui.affiliationChip.querySelector("b").textContent = "";
      ui.affiliationField.hidden = true;
    }
    renderActorFacts(actor, preview);
    renderSheetControls();
  }

  // The sheet name is the rename affordance: click it, type, and the change lands
  // on every screen. Never overwrite the text mid-edit.
  function syncSheetTitle(actor) {
    const editable = canEditActor(actor) && !sheetIsPreview();
    ui.actorTitle.classList.toggle("editable", editable);
    ui.actorTitle.title = editable ? "Click to rename this actor" : "";
    ui.actorTitle.setAttribute("contenteditable", editable ? EDITABLE_MODE : "false");
    if (document.activeElement === ui.actorTitle) return;
    if (ui.actorTitle.textContent !== actor.name) ui.actorTitle.textContent = actor.name;
  }

  function commitSheetTitle() {
    const actor = sheetActor(); if (!actor) return;
    const name = ui.actorTitle.textContent.replace(/\s+/g, " ").trim().slice(0, 40);
    if (!name || name === actor.name) { ui.actorTitle.textContent = actor.name; return; }
    renameActor(actor.id, name);
  }

  function renameActor(actorId, name) {
    const actor = boardState.actors.find((item) => item.id === actorId);
    if (!actor || !canEditActor(actor)) return;
    actor.name = name;
    if (role === "host") { broadcastState(); return; }
    renderActors();
    send(playerChannel, { type: "intent", action: "updateActor", actorId, patch: { name } });
  }

  function bindSheetTitle() {
    ui.actorTitle.addEventListener("keydown", (event) => {
      // Commit on Enter rather than leaning on the blur that follows: commitSheetTitle
      // is idempotent, and a rename should never hinge on a focus event arriving.
      if (event.key === "Enter") { event.preventDefault(); commitSheetTitle(); ui.actorTitle.blur(); }
      else if (event.key === "Escape") {
        event.preventDefault();
        const actor = sheetActor(); if (actor) ui.actorTitle.textContent = actor.name;
        ui.actorTitle.blur();
      }
    });
    ui.actorTitle.addEventListener("blur", commitSheetTitle);
    ui.actorTitle.addEventListener("paste", (event) => {
      if (EDITABLE_MODE === "plaintext-only") return;
      event.preventDefault();
      const text = (event.clipboardData?.getData("text/plain") || "").replace(/\s+/g, " ");
      ui.actorTitle.textContent = `${ui.actorTitle.textContent}${text}`.slice(0, 40);
    });
  }

  function adjustActorHp(delta) {
    const actor = sheetActor();
    if (!actor || sheetIsPreview() || !canEditActor(actor)) return;
    // A seat asks for the step and takes what comes back, so the host's ledger
    // stays the only writer and two clicks can never race to a wrong total.
    if (role !== "host") {
      if (playerChannel?.readyState !== "open") { showToast("Connect to the host before changing health"); return; }
      send(playerChannel, { type: "intent", action: "updateActor", actorId: actor.id, patch: { hpDelta: delta } });
      return;
    }
    actor.hp = { current: Math.max(0, Math.min(actor.hp.max, actor.hp.current + delta)), max: actor.hp.max };
    broadcastState();
  }

  // ---------------------------------------------------------------------------
  // Facts — an actor is a growing list of things the table has learned, not a
  // fixed paragraph. The DM writes each one straight to the table, into a holding
  // area to reveal on cue, or into their own private file.
  // ---------------------------------------------------------------------------

  // A library pack's facts are the ones its manifest ships with — what every copy
  // starts life knowing. They are shown, but not edited: a fact is recorded against
  // one actor on the table, and this sheet is not standing for any of them.
  function renderActorFacts(actor, preview = false) {
    const host = isDM();
    const facts = visibleFacts(actor);
    ui.actorFactList.replaceChildren();
    for (const fact of facts) ui.actorFactList.append(factRow(actor, fact, host && !preview));
    ui.actorFactList.hidden = !facts.length;
    ui.actorFactEmpty.hidden = Boolean(facts.length);
    ui.actorFactEmpty.textContent = preview
      ? "This pack ships with nothing recorded."
      : host
        ? "Nothing recorded yet. Write the first fact below."
        : "Nothing is known about them yet.";
    ui.factComposer.hidden = !host || preview;
  }

  function factRow(actor, fact, host) {
    const item = document.createElement("li");
    item.className = `fact fact-${fact.visibility}`;
    const text = document.createElement("p"); text.className = "fact-text"; text.textContent = fact.text;
    item.append(text);
    if (!host) return item;
    const tools = document.createElement("div"); tools.className = "fact-tools";
    const badge = document.createElement("span"); badge.className = "fact-badge"; badge.textContent = FACT_LABELS[fact.visibility];
    tools.append(badge);
    // What the author said it takes to learn this. The DM needs it in front of
    // them at the moment somebody asks — "can I tell?" is answered by a DC that
    // otherwise lives in a markdown file on another screen. Host branch only,
    // so the number never renders on a player's board even after a reveal.
    if (fact.check) {
      const check = document.createElement("span");
      check.className = "fact-check";
      check.textContent = fact.check;
      check.title = fact.topic ? `${fact.topic} — what it takes to learn this` : "What it takes to learn this";
      tools.append(check);
    }
    for (const visibility of FACT_VISIBILITY) {
      const control = document.createElement("button");
      control.type = "button";
      control.className = `fact-visibility ${fact.visibility === visibility ? "active" : ""}`;
      control.textContent = FACT_SHORT[visibility];
      control.title = visibility === "public" ? "Reveal to the table" : `Move to “${FACT_LABELS[visibility]}”`;
      control.addEventListener("click", () => setFactVisibility(actor.id, fact.id, visibility));
      tools.append(control);
    }
    const remove = document.createElement("button");
    remove.type = "button"; remove.className = "fact-remove"; remove.textContent = "×"; remove.title = "Delete this fact";
    remove.addEventListener("click", () => removeActorFact(actor.id, fact.id));
    tools.append(remove);
    item.append(tools);
    return item;
  }

  function addActorFact(visibility) {
    const actor = sheetActor();
    if (!actor || role !== "host") { showToast("Only the DM records facts"); return; }
    const text = ui.factText.value.replace(/\s+/g, " ").trim().slice(0, 400);
    if (!text) { ui.factText.focus(); return; }
    actor.facts = normalizeFacts(actor.facts);
    actor.facts.push({ id: crypto.randomUUID(), text, visibility });
    ui.factText.value = "";
    broadcastState();
    showToast(visibility === "public" ? `The table learns: ${text.slice(0, 40)}${text.length > 40 ? "…" : ""}` : `Filed as ${FACT_LABELS[visibility].toLowerCase()}`);
  }

  function setFactVisibility(actorId, factId, visibility) {
    if (role !== "host" || !FACT_VISIBILITY.includes(visibility)) return;
    const fact = actorFacts(boardState.actors.find((item) => item.id === actorId)).find((item) => item.id === factId);
    if (!fact || fact.visibility === visibility) return;
    fact.visibility = visibility;
    broadcastState();
    if (visibility === "public") showToast("Revealed to the table");
  }

  function removeActorFact(actorId, factId) {
    if (role !== "host") return;
    const actor = boardState.actors.find((item) => item.id === actorId); if (!actor) return;
    actor.facts = actorFacts(actor).filter((fact) => fact.id !== factId);
    broadcastState();
  }

  function setSheetHpVisibility() {
    const actor = sheetActor(); if (!actor || role !== "host") return;
    actor.hpVisible = actor.hpVisible === false;
    broadcastState();
  }

  // The lightbox holds every picture the pack ships — the portrait, each painted
  // mini facing, each overhead rotation — so clicking the sheet portrait is a way
  // to look the whole actor over, not just enlarge one image.
  let galleryItems = [];
  let galleryIndex = 0;
  let galleryTitle = "";

  function openPortrait() {
    const actor = sheetActor();
    openGallery(LaramieActors.gallery(actorDefinition(actor)), actor?.name || "");
  }

  // Both the sheet portrait and a library card's thumbnails open the same
  // lightbox; only the title and where the set came from differ.
  function openGallery(items, title, startAt = 0) {
    galleryItems = items;
    galleryTitle = title;
    if (!galleryItems.length) return;
    ui.portraitStrip.replaceChildren(...galleryItems.map((item, index) => {
      const control = document.createElement("button");
      control.type = "button"; control.className = "portrait-thumb"; control.title = item.label;
      const image = document.createElement("img");
      image.src = item.url; image.alt = item.label || "";
      control.append(image);
      control.addEventListener("click", () => showGalleryItem(index));
      return control;
    }));
    ui.portraitStrip.hidden = galleryItems.length < 2;
    showGalleryItem(startAt);
    ui.portraitDialog.showModal();
  }

  function showGalleryItem(index) {
    galleryIndex = (index + galleryItems.length) % galleryItems.length;
    const item = galleryItems[galleryIndex];
    ui.portraitLarge.src = item.url;
    ui.portraitLarge.alt = [galleryTitle, item.label || "portrait"].filter(Boolean).join(", ");
    ui.portraitCaption.textContent = [galleryTitle, item.label].filter(Boolean).join(" · ");
    ui.portraitStrip.querySelectorAll(".portrait-thumb").forEach((control, position) => {
      control.classList.toggle("current", position === galleryIndex);
    });
  }

  function moveSelectedActorsBy(rawDx, rawDy) {
    const layerId = activeLayerId();
    // Actors predating layers carry no layerId and draw on whichever floor is
    // showing, so they move with it too — otherwise select-all would gather
    // tokens the arrow keys then refused to touch.
    const actors = selectedActors().filter((actor) => (!actor.layerId || actor.layerId === layerId) && canMoveActor(actor));
    if (!actors.length) return;
    // Snapped to half-squares, not whole ones: a small item's arrow step is .5,
    // and rounding would turn it into a whole square and skip three of the four
    // quarters it can occupy. Each actor still clamps to its own grid below.
    const half = (raw) => Math.round(raw * 2) / 2;
    const dx = half(rawDx); const dy = half(rawDy);
    // Each actor clamps to the board on its own, through the same helper a drag
    // uses. A selection keeps its shape as long as every member has room, and
    // whoever reaches the edge simply stops there. Clamping the group to its
    // most hemmed-in member instead is what froze a select-all: one prop parked
    // against a wall vetoed the move for everyone else on the floor.
    const moves = actors.map((actor) => ({ id: actor.id, layerId: actor.layerId || layerId, ...clampActorPosition(actor, actor.x + dx, actor.y + dy) }));
    if (moves.every((move, index) => move.x === actors[index].x && move.y === actors[index].y)) { renderActors(); return; }
    if (role === "host") moveActors(moves);
    else {
      for (const move of moves) { const actor = boardState.actors.find((item) => item.id === move.id); actor.x = move.x; actor.y = move.y; }
      renderActors(); send(playerChannel, { type: "intent", action: "moveActors", moves });
    }
  }

  function rotateSelectedBy(step) {
    applyRotations(selectedActors().filter(canRotate).map((actor) => ({
      id: actor.id,
      rotation: ROTATIONS[(ROTATIONS.indexOf(actor.rotation) + step + ROTATIONS.length) % ROTATIONS.length]
    })));
  }

  // Typing a name or a fact must never reach the board's single-letter shortcuts.
  function isTextEntry(target) {
    return Boolean(target?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false'])"));
  }

  function handleKeyboard(event) {
    if (isTextEntry(event.target)) return;
    const key = event.key.toLowerCase();
    // Copy and paste answer even with a sheet open, where a bare C would close
    // it — and both have to land before the movement keys, or Cmd+C reads as
    // the C that opens a sheet.
    if ((event.metaKey || event.ctrlKey) && (key === "c" || key === "v")) {
      event.preventDefault();
      if (key === "c") copySelectedActors(); else pasteActors();
      return;
    }
    // The sheet is the inspector: it stands open through a whole scene now, so
    // it takes only the keys that are its own and lets the board keep the rest.
    // Move, rotate, copy, and delete all still work with a sheet on screen.
    if (sheetIsOpen()) {
      if (key === "c" || key === "escape") { event.preventDefault(); closeActorSheet(); return; }
      if (event.key === "+" || event.key === "=") { event.preventDefault(); adjustActorHp(1); return; }
      if (event.key === "-" || event.key === "_") { event.preventDefault(); adjustActorHp(-1); return; }
    }
    // A focused button keeps Space and Enter — that is how it is pressed — but
    // nothing else, so the board shortcuts stay live right after a sidebar click.
    // `matches?.` because a key can arrive with the window itself as its target,
    // which has no such method — and this line is now on the path a sheet-open
    // keypress takes rather than behind an early return.
    if (event.target.matches?.("button") && (event.key === " " || event.key === "Enter")) return;
    // Ahead of the movement keys, or Cmd+A would read as the bare A that walks
    // the selection one square left.
    if (key === "a" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); selectAllOnActiveLayer(); return; }
    // One key for the panic button. Mid-session, with five people waiting, the
    // DM wants the darkness gone now, not three clicks into a sidebar.
    if (key === "f" && !event.metaKey && !event.ctrlKey && !event.altKey && can("effects") && boardState.fog?.enabled) {
      event.preventDefault();
      setFogMode(boardState.fog.mode === "revealed" ? "dynamic" : "revealed");
      return;
    }
    if (key === " ") { event.preventDefault(); spacePressed = true; return; }
    const actor = selectedActor();
    if (actor) {
      // A small item steps half a square at a time, because that is the grid it
      // lives on — whole-square arrows could never reach three of the four
      // quarters of a square.
      const step = smallestStep();
      const moves = { arrowup: [0, -1], w: [0, -1], arrowdown: [0, 1], s: [0, 1], arrowleft: [-1, 0], a: [-1, 0], arrowright: [1, 0], d: [1, 0] };
      if (moves[key]) { event.preventDefault(); moveSelectedActorsBy(moves[key][0] * step, moves[key][1] * step); return; }
      if (key === "delete" || key === "backspace") { event.preventDefault(); deleteSelectedActors(); return; }
      if (key === "q") { event.preventDefault(); rotateSelectedBy(1); return; }
      if (key === "e") { event.preventDefault(); rotateSelectedBy(-1); return; }
      if (key === "c") { event.preventDefault(); openActorSheet(); return; }
      if (key === "escape") { clearActorSelection(); return; }
    }
    const pan = { arrowup: [0, 64], arrowdown: [0, -64], arrowleft: [64, 0], arrowright: [-64, 0] };
    if (pan[key]) { event.preventDefault(); view.x += pan[key][0]; view.y += pan[key][1]; applyTransform(); }
  }

  function clientToWorld(clientX, clientY) {
    const rect = ui.viewport.getBoundingClientRect();
    return { x: (clientX - rect.left - view.x) / view.scale, y: (clientY - rect.top - view.y) / view.scale };
  }

  let lastZoomText = "";
  let movingTimer = 0;
  let zoomSettleTimer = 0;
  function applyTransform() {
    ui.surface.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    const zoomText = `${Math.round(view.scale * 100)}%`;
    if (zoomText !== lastZoomText) { ui.zoomReadout.textContent = zoomText; lastZoomText = zoomText; }
    // While the board is moving, hint the compositor to cache it as one GPU layer
    // so a pan is a cheap layer move instead of repainting ~40 filtered sprites.
    // Released shortly after the gesture so idle memory stays low.
    ui.surface.classList.add("moving");
    clearTimeout(movingTimer);
    movingTimer = window.setTimeout(() => ui.surface.classList.remove("moving"), 400);
    saveView();
  }

  function fitMap() {
    if (!mapSize.width) return;
    const rect = ui.viewport.getBoundingClientRect(); const padding = 36;
    view.scale = Math.min((rect.width - padding * 2) / mapSize.width, (rect.height - padding * 2) / mapSize.height);
    view.scale = Math.max(.08, view.scale);
    view.x = (rect.width - mapSize.width * view.scale) / 2; view.y = (rect.height - mapSize.height * view.scale) / 2;
    applyTransform();
  }

  function drawActorSelectionBox(start, end) {
    const left = Math.min(start.x, end.x); const top = Math.min(start.y, end.y);
    ui.selectionBox.style.left = `${left}px`; ui.selectionBox.style.top = `${top}px`;
    ui.selectionBox.style.width = `${Math.abs(end.x - start.x)}px`; ui.selectionBox.style.height = `${Math.abs(end.y - start.y)}px`;
    ui.selectionBox.hidden = false;
  }

  // Cmd/Ctrl+A takes the whole floor at once. It matches what the board is
  // drawing rather than the strict layer test the marquee uses: an actor that
  // predates layers carries no layerId and rides along with whichever floor is
  // showing, so select-all has to take those too or it would miss visible tokens.
  function selectAllOnActiveLayer() {
    const layerId = activeLayerId();
    if (!layerId) return;
    selectedActorIds.clear();
    for (const actor of boardState.actors) {
      if (!actor.layerId || actor.layerId === layerId) selectedActorIds.add(actor.id);
    }
    selectedActorId = [...selectedActorIds].at(-1) || "";
    ui.actorTooltip.hidden = true;
    renderActors();
  }

  function selectActorsInBox(start, end, additive) {
    if (!additive) selectedActorIds.clear();
    const left = Math.min(start.x, end.x); const right = Math.max(start.x, end.x);
    const top = Math.min(start.y, end.y); const bottom = Math.max(start.y, end.y); const size = boardState.grid.size;
    for (const actor of boardState.actors.filter((item) => item.layerId === activeLayerId())) {
      const definition = actorDefinition(actor); const footprint = actorFootprint(actor);
      const actorLeft = boardState.grid.offsetX + actor.x * size; const actorTop = boardState.grid.offsetY + actor.y * size;
      const actorRight = actorLeft + footprint.width * size; const actorBottom = actorTop + footprint.height * size;
      if (actorRight >= left && actorLeft <= right && actorBottom >= top && actorTop <= bottom) selectedActorIds.add(actor.id);
    }
    selectedActorId = [...selectedActorIds].at(-1) || "";
  }

  function bindViewport() {
    let pan = null;
    let painting = false;
    let marquee = null;
    let wheelGesture = { mode: "", expires: 0 };
    const canEditBoard = () => role === "host" || playerChannel?.readyState === "open";
    ui.viewport.addEventListener("pointerdown", (event) => {
      if (event.target.closest(".token, button")) return;
      // Dropping a light is the DM's: a player who could put a 60 ft source
      // anywhere could reveal the whole floor by throwing lanterns at it.
      if (brushMode === "light") {
        if (!can("effects")) return;
        const cell = gridCellFromClient(event.clientX, event.clientY); if (!cell) return;
        const existing = lightAt(cell);
        if (existing) removeLight(existing.id); else addLightAt(cell, event.shiftKey);
        return;
      }
      // Drawing an exit is authoring the building, so it is the DM's and it
      // needs the helper listening — `canAuthorPlace` asks both.
      if (brushMode === "exit") {
        if (!canAuthorPlace()) return;
        const cell = gridCellFromClient(event.clientX, event.clientY); if (!cell) return;
        handleExitClick(cell);
        return;
      }
      if (brushMode === "flame" || brushMode === "extinguish") {
        if (!canEditBoard()) return;
        const cell = gridCellFromClient(event.clientX, event.clientY); if (!cell) return;
        if (brushMode === "flame") {
          draftRegion = { layerId: activeLayerId(), type: ui.effectType.value, keys: new Set() };
          stampInto(draftRegion, cell); painting = true; hoverCell = null;
          ui.viewport.setPointerCapture(event.pointerId); scheduleEffectsRender();
        } else {
          const region = regionAt(cell); if (region) extinguishRegion(region.id);
        }
        return;
      }
      if (spacePressed || event.button === 1 || event.button === 2) {
        pan = { startX: event.clientX, startY: event.clientY, viewX: view.x, viewY: view.y };
        ui.viewport.setPointerCapture(event.pointerId); ui.viewport.classList.add("dragging"); return;
      }
      if (event.button === 0) {
        marquee = { start: clientToWorld(event.clientX, event.clientY), end: null, clientX: event.clientX, clientY: event.clientY, additive: event.shiftKey };
        ui.viewport.setPointerCapture(event.pointerId);
      }
    });
    ui.viewport.addEventListener("pointermove", (event) => {
      if (painting && draftRegion) {
        const cell = gridCellFromClient(event.clientX, event.clientY);
        if (cell) { stampInto(draftRegion, cell); scheduleEffectsRender(); }
        return;
      }
      if (brushMode === "flame" || brushMode === "light") {
        const cell = gridCellFromClient(event.clientX, event.clientY);
        if (!sameCell(cell, hoverCell)) { hoverCell = cell; scheduleEffectsRender(); }
        return;
      }
      if (brushMode === "extinguish") {
        const cell = gridCellFromClient(event.clientX, event.clientY);
        const id = cell ? (regionAt(cell)?.id || "") : "";
        if (id !== hoverRegionId) { hoverRegionId = id; scheduleEffectsRender(); }
        return;
      }
      if (marquee) {
        if (Math.hypot(event.clientX - marquee.clientX, event.clientY - marquee.clientY) > 4) {
          marquee.end = clientToWorld(event.clientX, event.clientY); drawActorSelectionBox(marquee.start, marquee.end);
        }
        return;
      }
      if (!pan) return; view.x = pan.viewX + event.clientX - pan.startX; view.y = pan.viewY + event.clientY - pan.startY; applyTransform();
    });
    ui.viewport.addEventListener("pointerleave", () => {
      if (hoverCell || hoverRegionId) { hoverCell = null; hoverRegionId = ""; scheduleEffectsRender(); }
    });
    const endPan = () => {
      if (draftRegion) { painting = false; commitDraftRegion(); }
      if (marquee) {
        if (marquee.end) { selectActorsInBox(marquee.start, marquee.end, marquee.additive); renderActors(); }
        else if (!marquee.additive) clearActorSelection();
        marquee = null; ui.selectionBox.hidden = true;
      }
      pan = null; painting = false; ui.viewport.classList.remove("dragging");
    };
    ui.viewport.addEventListener("pointerup", endPan); ui.viewport.addEventListener("pointercancel", endPan);
    ui.viewport.addEventListener("contextmenu", (event) => event.preventDefault());
    ui.viewport.addEventListener("wheel", (event) => {
      event.preventDefault();
      const now = performance.now();
      if (now > wheelGesture.expires || event.ctrlKey) {
        const trackpadLike = event.deltaMode === WheelEvent.DOM_DELTA_PIXEL
          && (Math.abs(event.deltaX) > 0 || Math.abs(event.deltaY) < 50 || !Number.isInteger(event.deltaY));
        wheelGesture.mode = event.ctrlKey ? "zoom" : trackpadLike ? "pan" : "zoom";
      }
      wheelGesture.expires = now + 180;
      if (wheelGesture.mode === "pan") {
        ui.surface.classList.remove("zooming");   // panning is instant, no easing
        view.x -= event.deltaX; view.y -= event.deltaY; applyTransform(); return;
      }
      // Zoom: ease the transform toward the target so quick zooms glide into place —
      // the GPU scales the cached layer instead of re-rasterizing every step.
      ui.surface.classList.add("zooming");
      clearTimeout(zoomSettleTimer);
      zoomSettleTimer = window.setTimeout(() => ui.surface.classList.remove("zooming"), 220);
      const rect = ui.viewport.getBoundingClientRect(); const cursorX = event.clientX - rect.left; const cursorY = event.clientY - rect.top;
      const worldX = (cursorX - view.x) / view.scale; const worldY = (cursorY - view.y) / view.scale;
      const normalizedDelta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      const factor = Math.exp(-normalizedDelta * .0035); view.scale = Math.min(6, Math.max(.06, view.scale * factor));
      view.x = cursorX - worldX * view.scale; view.y = cursorY - worldY * view.scale; applyTransform();
    }, { passive: false });
    ui.viewport.addEventListener("dragover", (event) => { event.preventDefault(); event.dataTransfer.dropEffect = event.dataTransfer.types.includes("application/x-laramie-asset") ? "copy" : "move"; });
    ui.viewport.addEventListener("drop", (event) => {
      event.preventDefault(); const cell = gridCellFromClient(event.clientX, event.clientY); if (!cell) return;
      const assetId = event.dataTransfer.getData("application/x-laramie-asset");
      const actorId = event.dataTransfer.getData("application/x-laramie-actor");
      if (assetId && role === "host") placeAsset(assetId, cell.x, cell.y);
      if (actorId) {
        if (role === "host") moveActor(actorId, cell.x, cell.y);
        else send(playerChannel, { type: "intent", action: "moveActor", actorId, x: cell.x, y: cell.y, layerId: cell.layerId });
      }
    });
  }

  // Geometry is the coordinate system — it must match for everyone, so it goes
  // out over the wire and only the DM may touch it.
  function updateGridGeometry() {
    FOG.dirty = true;
    if (!can("gridGeometry")) return;
    boardState.grid = normalizeGridGeometry({
      size: Number(ui.gridSize.value), offsetX: Number(ui.gridX.value), offsetY: Number(ui.gridY.value)
    });
    if (boardState.place?.board) {
      boardState.place.board = {
        ...boardState.place.board,
        columns: Number(ui.gridColumns.value), rows: Number(ui.gridRows.value),
        squarePx: boardState.grid.size, squareFt: Number(ui.gridFeet.value),
        offsetX: boardState.grid.offsetX, offsetY: boardState.grid.offsetY
      };
    }
    // Squares changed shape, so anything now hanging off the board comes back on.
    for (const actor of boardState.actors) Object.assign(actor, clampActorPosition(actor, actor.x, actor.y));
    // Scale feeds the feet-to-squares conversion, so a live radius preview is
    // stale the moment it changes.
    if (brushMode === "flame") renderEffects();
    broadcastState();
  }

  // Appearance is personal. It never leaves this browser, and touching it latches
  // `userSet` so the campaign default stops overwriting the choice.
  function updateGridAppearance() {
    view.grid = normalizeGridView({
      visible: ui.gridVisible.checked, color: ui.gridColor.value,
      strength: Number(ui.gridStrength.value), userSet: true
    });
    ui.gridStrengthOutput.value = `${view.grid.strength}%`;
    drawGrid(); saveView();
  }

  function updateItemGlow() {
    view.itemGlow = ui.itemGlow.checked;
    saveView(); renderActors();
    showToast(view.itemGlow ? "Dropped items lit — hold Alt to name them" : "Item lights off on your screen");
  }

  // Also personal: a screen that wants to see what a tall mini is standing in
  // front of lays them all flat without touching anyone else's board.
  function toggleFlatMinis() {
    view.flatMinis = ui.flatMinis.checked;
    saveView(); renderActors();
    showToast(view.flatMinis ? "Minis laid flat on your screen" : "Minis standing on your screen");
  }

  function resetGridAppearance() {
    view.grid = normalizeGridView({ ...(campaign?.defaults.grid || {}), userSet: false });
    syncGridControls(); drawGrid(); saveView();
    showToast("Grid reset to the campaign default");
  }

  // ------------------------------------------------------------ encounters UI

  function placeName(id) {
    return placeIndex.find((item) => item.id === id)?.name || id || "Unknown place";
  }


  // The list is the shortcut, not a menu that opens a menu. Clicking a place
  // puts its map on the table with nobody on it; its saved encounters sit
  // underneath it, one click each. The browser behind "New encounter…" is still
  // there for picking from cards, but nothing here needs it.
  function renderPlaceList() {
    ui.placeList.replaceChildren();
    if (!placeIndex.length) { ui.placeList.append(muted("No places yet")); return; }
    for (const entry of placeIndex) {
      const here = encounterIndex.filter((item) => item.placeId === entry.id);
      const row = button(entry.name, () => confirmOpenPlace(entry.id, entry.name));
      // add, never assign: `button()` already set `.button`, and replacing the
      // class list drops the background and text colour with it.
      row.classList.add("place-row");
      row.title = `Put ${entry.name} on the table with an empty cast`;
      const meta = document.createElement("small");
      meta.textContent = here.length
        ? `${here.length} ${here.length === 1 ? "encounter" : "encounters"} — or open it empty`
        : "no encounters yet — open it empty";
      row.append(meta);
      const active = entry.id === boardState.place?.id;
      if (active) row.classList.add("active");
      ui.placeList.append(row);

      if (!here.length) continue;
      const nest = document.createElement("div");
      nest.className = "place-encounters";
      for (const item of here) {
        const child = button(item.title || item.id, () => confirmLoadEncounter(item.id, item.title || item.id));
        child.classList.add("encounter-subrow");
        child.title = `Load ${item.title || item.id}`;
        if (item.id === boardState.encounter?.id) child.classList.add("active");
        nest.append(child);
      }
      ui.placeList.append(nest);
    }
  }

  function muted(message) {
    const span = document.createElement("span"); span.className = "muted"; span.textContent = message; return span;
  }

  async function confirmOpenPlace(id, name) {
    if (boardState.actors.length
      && !confirm(`Clear the board and set out ${name}? Everyone at the table will follow.`)) return;
    if (await openPlace(id)) closeBrowsers();
  }

  async function confirmLoadEncounter(id, title) {
    if (boardState.actors.length && boardState.encounter?.id !== id
      && !confirm(`Replace the board with “${title}”? Everyone at the table will follow.`)) return;
    if (await applyEncounter(id)) closeBrowsers();
  }

  async function openEncounterBrowser() {
    if (!can("loadEncounter")) return;
    renderEncounterGrid();
    setBrowser(ui.encounterBrowser, true);
    // The index is a light registry and carries no counts; read them off the
    // encounter files themselves, then redraw. loadEncounter memoizes, so
    // reopening the browser costs nothing.
    await enrichEncounterIndex();
    renderEncounterGrid();
  }

  async function enrichEncounterIndex() {
    await Promise.all(encounterIndex.map(async (entry) => {
      if (entry.counts !== undefined) return;
      try {
        const encounter = await LaramieCampaign.loadEncounter(campaign, entry.id);
        entry.counts = encounter.counts;
        entry.description = encounter.description;
      } catch { entry.counts = null; }
    }));
  }

  function renderEncounterGrid() {
    ui.encounterGrid.replaceChildren();
    for (const entry of encounterIndex) {
      const card = document.createElement("article");
      card.className = `encounter-card ${entry.id === boardState.encounter?.id ? "active" : ""}`;

      const title = document.createElement("h3"); title.textContent = entry.title;
      const chip = document.createElement("span");
      chip.className = "status-chip"; chip.dataset.status = entry.status || "";
      chip.textContent = entry.status || "draft";
      const heading = document.createElement("div"); heading.className = "encounter-card-heading";
      heading.append(title, chip);

      const where = document.createElement("p"); where.className = "encounter-card-where";
      where.textContent = placeName(entry.placeId);

      const counts = document.createElement("p"); counts.className = "encounter-card-counts";
      counts.textContent = entry.counts ? countSummary(entry.counts) : "";

      const description = document.createElement("p"); description.className = "encounter-card-where";
      description.textContent = entry.description ? `${entry.description.slice(0, 140)}${entry.description.length > 140 ? "…" : ""}` : "";
      description.hidden = !entry.description;

      const actions = document.createElement("div"); actions.className = "encounter-card-actions";
      const load = button("Load", () => confirmLoadEncounter(entry.id, entry.title));
      load.className = "button primary compact";
      actions.append(load);

      card.append(heading, where, counts, description, actions);
      ui.encounterGrid.append(card);
    }
    if (!encounterIndex.length) ui.encounterGrid.append(muted("No encounters in this campaign yet — write one with `dnd make`."));
  }

  // ---------------------------------------------------------------- places UI
  // Read-only. A place's maps and geometry are authored with the DND CLI;
  // this panel exists so the DM can see what a place is without leaving the table.




  function setBrowser(panel, open) {
    panel.classList.toggle("open", open);
    panel.setAttribute("aria-hidden", open ? "false" : "true");
  }

  function closeBrowsers() {
    setBrowser(ui.encounterBrowser, false);
  }

  function bindEvents() {
    ui.chooseHost.addEventListener("click", () => chooseMode("host")); ui.choosePlayer.addEventListener("click", () => chooseMode("player"));
    ui.addSeat.addEventListener("click", () => createSeat()); ui.makeAnswer.addEventListener("click", createPlayerAnswer);
    document.getElementById("seat-players-button")?.addEventListener("click", seatPlayers);
    ui.copyAnswer.addEventListener("click", () => copyText(ui.answerOutput.value, "Answer copied"));
    ui.showLobby.addEventListener("click", () => { ui.lobby.hidden = false; ui.controls.hidden = true; ui.navRail.hidden = true; });
    [ui.gridColumns, ui.gridRows, ui.gridSize, ui.gridFeet, ui.gridX, ui.gridY]
      .forEach((control) => control.addEventListener("input", updateGridGeometry));
    [ui.gridVisible, ui.gridColor, ui.gridStrength]
      .forEach((control) => control.addEventListener("input", updateGridAppearance));
    ui.gridReset.addEventListener("click", resetGridAppearance);
    ui.flatMinis.addEventListener("change", toggleFlatMinis);
    ui.itemGlow.addEventListener("change", updateItemGlow);

    // --- the rail --------------------------------------------------------
    ui.railToggle.addEventListener("click", () => setRailOnly(!railOnly()));
    for (const control of ui.navRail.querySelectorAll(".rail-button")) {
      control.addEventListener("click", () => toggleSection(control.dataset.opens));
    }

    // --- the who menu ----------------------------------------------------
    ui.whoButton.addEventListener("click", () => setWhoMenu(ui.whoDropdown.hidden));
    ui.whoNameInput.addEventListener("change", () => setSeatName(ui.whoNameInput.value));
    ui.menuLoadEncounter.addEventListener("click", () => { setWhoMenu(false); openEncounterBrowser(); });
    ui.menuDisplay.addEventListener("click", () => { setWhoMenu(false); ui.displayDialog.showModal(); });
    ui.menuSeats.addEventListener("click", () => { setWhoMenu(false); openSection("table"); });
    ui.closeDisplay.addEventListener("click", () => ui.displayDialog.close());
    ui.themeSelect.addEventListener("change", () => {
      document.body.dataset.theme = ui.themeSelect.value;
      localStorage.setItem("laramie-board-theme", ui.themeSelect.value);
    });
    // Any click outside shuts the menu, the way every other menu on earth does.
    document.addEventListener("pointerdown", (event) => {
      if (!ui.whoDropdown.hidden && !event.target.closest?.(".who-menu")) setWhoMenu(false);
    });

    // --- the library -----------------------------------------------------
    ui.librarySearch.addEventListener("input", renderAssetLibrary);
    ui.librarySearch.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { ui.librarySearch.value = ""; renderAssetLibrary(); }
    });

    ui.previewButton.addEventListener("click", () => setPlayerPreview(true));
    ui.exitPreview.addEventListener("click", () => setPlayerPreview(false));

    ui.openEncounters.addEventListener("click", openEncounterBrowser);
    ui.closeEncounterBrowser.addEventListener("click", closeBrowsers);

    // Remember which sections this browser leaves open.
    for (const section of document.querySelectorAll(".nav-section")) {
      section.addEventListener("toggle", () => {
        if (section.hidden) return;
        sectionState()[section.dataset.section] = section.open;
        saveView();
      });
    }
    ui.brushMove.addEventListener("click", () => setBrush("move"));
    ui.brushFlame.addEventListener("click", () => setBrush("flame"));
    ui.brushExtinguish.addEventListener("click", () => setBrush("extinguish"));
    ui.brushLight.addEventListener("click", () => setBrush("light"));
    ui.clearEffects.addEventListener("click", () => clearEffectsOnLayer(activeLayerId()));
    ui.pinTable.addEventListener("click", () => pinTableToActiveLayer(!tableIsPinned()));
    ui.addExit.addEventListener("click", () => (brushMode === "exit" ? cancelExitDraft() : beginExitDraft()));
    ui.saveExit.addEventListener("click", commitExitDialog);
    ui.closeExitDialog.addEventListener("click", () => ui.exitDialog.close());
    // Closing the dialog any way at all — the ×, Escape, the backdrop — leaves
    // the half-drawn link behind rather than writing a nameless one.
    ui.exitDialog.addEventListener("close", () => cancelExitDraft(true));
    for (const field of [ui.exitFromLabel, ui.exitToLabel]) {
      field.addEventListener("keydown", (event) => {
        if (event.key === "Enter") { event.preventDefault(); commitExitDialog(); }
      });
    }
    ui.fogEnabled.addEventListener("change", () => setFogEnabled(ui.fogEnabled.checked));
    ui.fogMode.addEventListener("change", () => setFogMode(ui.fogMode.value));
    ui.fogAmbient.addEventListener("change", () => setLayerAmbient(activeLayerId(), ui.fogAmbient.value));
    [ui.effectType, ui.areaShape, ui.areaRadius].forEach((control) => control.addEventListener("change", () => { if (brushMode === "flame") renderEffects(); }));
    [ui.manageHpCurrent, ui.manageHpMax, ui.manageAc, ui.manageThreshold, ui.manageIndestructible, ui.manageController, ui.manageInventory, ui.manageNotes]
      .forEach((control) => control.addEventListener("change", commitSheetControls));
    ui.manageRotation.querySelectorAll("button").forEach((control) => control.addEventListener("click", () => rotateSelected(control.dataset.rotation)));
    ui.manageApplyDamage.addEventListener("click", () => damageSheetActor(ui.manageDamageAmount.value));
    // A thing with no health has no number to type: one press ends it.
    ui.manageDestroy.addEventListener("click", () => damageSheetActor(1));
    ui.manageRemove.addEventListener("click", removeSheetActor);
    ui.image.addEventListener("load", () => {
      mapSize = { width: ui.image.naturalWidth, height: ui.image.naturalHeight };
      ui.surface.style.width = `${mapSize.width}px`; ui.surface.style.height = `${mapSize.height}px`;
      drawGrid(); renderEffects(); drawFog(); renderActors(); if (!initialFitDone) { fitMap(); initialFitDone = true; }
    });
    ui.image.addEventListener("error", () => showToast("The map image could not be loaded"));
    ui.overlay.addEventListener("error", () => showToast("The upper-floor overlay could not be loaded"));
    ui.fit.addEventListener("click", fitMap);
    ui.help.addEventListener("click", () => { setWhoMenu(false); ui.helpDialog.showModal(); });
    ui.closeHelp.addEventListener("click", () => ui.helpDialog.close());
    ui.closeSheet.addEventListener("click", closeActorSheet);
    ui.decreaseHp.addEventListener("click", () => adjustActorHp(-1)); ui.increaseHp.addEventListener("click", () => adjustActorHp(1));
    ui.actorHpVisibility.addEventListener("click", setSheetHpVisibility);
    ui.actorAffiliation.addEventListener("change", () => setActorAffiliation(sheetActorId, ui.actorAffiliation.value));
    ui.manageSize.addEventListener("change", () => resizeSheetActor(ui.manageSize.value));
    ui.addAffiliation.addEventListener("click", () => addAffiliation(ui.affiliationName.value));
    ui.affiliationName.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); addAffiliation(ui.affiliationName.value); } });
    ui.actorPortraitButton.addEventListener("click", openPortrait);
    ui.closePortrait.addEventListener("click", () => ui.portraitDialog.close());
    ui.portraitDialog.addEventListener("click", (event) => { if (event.target === ui.portraitDialog) ui.portraitDialog.close(); });
    ui.portraitDialog.addEventListener("keydown", (event) => {
      if (galleryItems.length < 2) return;
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
      if (!step) return;
      event.preventDefault(); showGalleryItem(galleryIndex + step);
    });
    ui.portraitDialog.addEventListener("close", () => {
      ui.portraitLarge.removeAttribute("src"); ui.portraitStrip.replaceChildren();
      galleryItems = [];
    });
    bindSheetTitle();
    for (const control of ui.factComposer.querySelectorAll("[data-visibility]")) {
      control.addEventListener("click", () => addActorFact(control.dataset.visibility));
    }
    // Ctrl/⌘+Enter is the fast path for the commonest case: telling the table.
    ui.factText.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); addActorFact("public"); }
    });
    window.addEventListener("laramie:dice-request", (event) => requestDiceRoll(event.detail));
    window.addEventListener("laramie:dice-ready", () => window.dispatchEvent(new CustomEvent("laramie:dice-history", { detail: boardState.rolls || [] })));
    ui.saveBoard.addEventListener("click", saveEncounter);
    window.addEventListener("keydown", handleKeyboard);
    // Hold Alt and every item on the floor names itself at once — the answer to
    // "which of those specks is the musket" that no amount of glow solves. The
    // key is never consumed: it only paints, so nothing else changes meaning.
    const showLoot = (on) => document.body.classList.toggle("naming-loot", on);
    window.addEventListener("keydown", (event) => { if (event.key === "Alt") showLoot(true); });
    window.addEventListener("keyup", (event) => { if (event.key === "Alt") showLoot(false); });
    window.addEventListener("blur", () => showLoot(false));
    // Hold Z and the party and the gear light up in the theme's own gold, so a
    // floor of townsfolk stops hiding them. Same bargain as Alt: it only paints.
    //
    // Alt could be bound bare because Alt is a modifier and never text. Z is a
    // letter, so it has to yield to anything being typed into — otherwise
    // renaming an actor to "Zeke" strobes the board. A held key also repeats,
    // which is why this is a no-op once already on.
    const spotlight = (on) => {
      if (document.body.classList.contains("spotlighting") === on) return;
      document.body.classList.toggle("spotlighting", on);
    };
    window.addEventListener("keydown", (event) => {
      if (event.key !== "z" && event.key !== "Z") return;
      if (isTextEntry(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      spotlight(true);
    });
    window.addEventListener("keyup", (event) => { if (event.key === "z" || event.key === "Z") spotlight(false); });
    // Releasing Z over another window never reaches us, so the board would stay
    // lit until the next press. Both of these put it out.
    window.addEventListener("blur", () => spotlight(false));
    window.addEventListener("keyup", (event) => { if (event.key === " ") spacePressed = false; });
    window.addEventListener("blur", () => { spacePressed = false; });
    window.addEventListener("resize", () => { if (initialFitDone) fitMap(); });
    window.addEventListener("hashchange", () => { if (!playerChannel && !seats.size) chooseMode(location.hash.startsWith("#/join") ? "player" : "host"); });
    bindViewport();
  }

  // The campaign decides the table style, but only for a visitor who has never
  // picked one — the inline bootstrap in index.html owns the choice after that.
  function applyCampaignChrome() {
    ui.campaignName.textContent = campaign.name;
    document.title = `${campaign.name} — Battle Board`;
    // Named from the manifest rather than written into the markup. The label
    // used to list five characters from a campaign that has four, because it
    // was typed once and the seats moved on without it — and a button that
    // names players the loop cannot seat is worse than one that names none.
    const seatButton = document.getElementById("seat-players-button");
    if (seatButton) {
      const names = (campaign.seats || []).map((seat) => seat.name.split(" ")[0]);
      seatButton.textContent = names.length
        ? `Seat the players (${names.join(" · ")})`
        : "Seat the players";
      seatButton.disabled = !names.length;
      seatButton.title = names.length ? "" : "This campaign declares no seats — use Add an extra seat.";
    }
    if (campaign.theme && !localStorage.getItem("laramie-board-theme")) {
      document.body.dataset.theme = campaign.theme;
      ui.themeSelect.value = campaign.theme;
    }
    applyStatLabels();
    if (!view.grid.userSet) { view.grid = normalizeGridView({ ...campaign.defaults.grid, userSet: false }); saveView(); }
    if (!boardState.affiliations?.length) boardState.affiliations = normalizeAffiliations([]);
  }

  // Abbreviated form for the compact readouts, derived from the full label.
  let statAbbreviation = "HP";

  // What this game calls the three universal stats. The markup ships D&D's
  // words as its default; a campaign that declares a different system replaces
  // them here. Nothing else moves — an actor's `hp` is still `hp` on disk and
  // in every calculation, it is only the word above the number that changes.
  function applyStatLabels() {
    const labels = campaign?.statLabels;
    if (!labels) return;
    const write = (tile, wording) => {
      const span = tile?.querySelector("span");
      if (span && wording) span.textContent = wording;
    };
    write(ui.vitalHp, labels.hp);
    write(ui.vitalAc, labels.armorClass);
    write(ui.vitalSpeed, labels.speed);
    // The compact readouts say "12/14 HP" beside a token, where the full label
    // would not fit. Abbreviate to the initials of whatever the system calls it.
    statAbbreviation = (labels.hp || "Hit Points")
      .split(/\s+/).map(word => word[0] || "").join("").toUpperCase().slice(0, 3) || "HP";
  }


  async function boot() {
    bindEvents(); chooseMode(role); applyTransform(); setBrush("move");
    if (role === "host") { openBoard(); updateHostStatus(); }

    try {
      const requested = new URLSearchParams(location.search).get("campaign") || "";
      campaign = await LaramieCampaign.loadCampaign(requested);
    } catch (error) {
      console.error("Campaign load failed", error);
      ui.campaignName.textContent = "Campaign unavailable";
      showToast(error.message || "Could not load the campaign");
      return;
    }

    applyCampaignChrome();
    await loadActorPacks();

    // The catalogs are DM-only reading; a player's board arrives over the wire.
    if (role === "host") {
      const [places, encounters] = await Promise.all([
        LaramieCampaign.loadPlaceIndex(campaign).catch(() => []),
        LaramieCampaign.loadEncounterIndex(campaign).catch(() => [])
      ]);
      placeIndex = places; encounterIndex = encounters;
      renderPlaceList();
      // Ask once the campaign is known, since a helper serving a different one
      // is no use here. Fire and forget: Save simply stays disabled if nothing
      // answers, which is the state this page shipped in.
      probeSaveHelper();
      // Only auto-load when there is nothing to lose; a board in progress stands.
      if (!boardState.actors.length) {
        const opening = campaign.defaultEncounterId || encounterIndex[0]?.id;
        if (opening) await applyEncounter(opening, { silent: true });
      }
    }

    syncControls(); renderBoard();
    lastSceneKey = sceneKey();
  }

  boot();
})();
