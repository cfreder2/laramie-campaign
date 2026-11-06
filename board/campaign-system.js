(() => {
  "use strict";

  // Campaigns, places, and encounters — the three things the board shows and
  // none of which it hardcodes. See docs/campaigns/README.md for the schemas.
  //
  //   campaign  a folder: name, theme, seats, affiliations, and three catalogs
  //   place     ordered map layers plus one board geometry
  //   encounter a cast list placed at a place; it borrows the geometry
  //
  // Everything here returns camelCase objects with absolute URLs already
  // resolved, so app.js never has to know where a file came from.

  const CAMPAIGN_INDEX_URL = "../campaigns/index.yaml";
  const DEFAULT_GRID = { visible: true, color: "#d8bd83", strength: 42 };
  //: 5e's three light levels, and the only three the board draws.
  const AMBIENT_BANDS = new Set(["bright", "dim", "dark"]);

  const placeCache = new Map();
  const encounterCache = new Map();

  const parseYaml = (text) => window.LaramieActors.parseYaml(text);

  async function fetchYaml(url) {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`${url} returned ${response.status}`);
    return parseYaml(await response.text());
  }

  // Keyed maps everywhere, so this is the one shape-guard the module needs.
  function entries(raw) {
    return raw && typeof raw === "object" && !Array.isArray(raw) ? Object.entries(raw) : [];
  }

  const text = (value, fallback = "") => {
    const result = String(value ?? "").trim();
    return result || fallback;
  };
  const positive = (value, fallback) => (Number(value) > 0 ? Math.round(Number(value)) : fallback);
  const percent = (value, fallback) => (Number.isFinite(Number(value)) ? Math.max(0, Math.min(100, Math.round(Number(value)))) : fallback);
  const hex = (value, fallback) => (/^#[0-9a-f]{6}$/i.test(value) ? String(value) : fallback);

  // ------------------------------------------------------------------- exits
  //
  // The only thing that moves a character between floors. The board's floor
  // switcher is the DM's own camera and carries nobody with it; a player's
  // screen follows their character, and a character follows an exit somebody
  // authored. Nothing here is discoverable by a player who has not been offered
  // it — a level with no exits off it is a level nobody walks out of.
  //
  // `label` is the author's own sentence and is printed verbatim. "Up the main
  // stair", "Down into the dark", "Teleport to cabbage land" — the board never
  // writes this line, it only ever offers it.

  function normalizeCell(raw) {
    const x = Math.round(Number(raw?.x)), y = Math.round(Number(raw?.y));
    return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 ? { x, y } : null;
  }

  // `"12,8 13,8"` — the squares an exit is stood on. The board's published
  // dialect takes a list of flat mappings, scalar values only, so an exit's
  // squares ride in one scalar rather than as a nested list. See `_squares_text`
  // in the CLI's scenes.py for the other end of it.
  function parseSquares(raw) {
    return String(raw ?? "").trim().split(/\s+/).map((pair) => {
      const [x, y] = pair.split(",");
      return normalizeCell({ x, y });
    }).filter(Boolean);
  }

  // The board's dialect, as `place.yaml` publishes it: a list, because a
  // coordinate should not have to be parsed back out of a mapping key.
  function normalizeExit(raw) {
    const cells = parseSquares(raw?.cells);
    const layerId = text(raw?.to);
    // The landing is required, not defaulted. An exit is a link with two ends
    // and the far end is written down; the plates of a place are not
    // necessarily drawn in register with each other, so "the square you left"
    // is a different room one floor down and guessing it drops a character
    // through a wall. An exit that does not say where it comes out is not one.
    const landing = parseSquares(raw?.lands)[0];
    if (!cells.length || !layerId || !landing) return null;
    return {
      id: text(raw.id, `${layerId}-${cells[0].x}-${cells[0].y}`),
      label: text(raw.label, `To ${layerId}`),
      cells,
      to: { layerId, x: landing.x, y: landing.y }
    };
  }

  function normalizeExits(raw) {
    return (Array.isArray(raw) ? raw : []).map(normalizeExit).filter(Boolean);
  }

  // The encounter's dialect, keyed by id like everything else a person writes
  // by hand. An entry either describes a link or switches an inherited one off.
  //
  // Flat — `from`/`from_at`/`from_label` and the same for `to` — because an
  // encounter file is written in the board's restricted dialect, which takes
  // nested mappings of scalars and no mapping inside a list item. The place
  // spells the same thing as an `ends:` list because it is authored markdown
  // and has no such limit.
  //
  // Flattened here into the same one-way pair the CLI publishes for a place, so
  // everything downstream — the board included — knows only one-way exits.
  function exitFromEncounter(id, raw) {
    if (!raw || typeof raw !== "object") return [];
    const ends = [
      { level: text(raw.from), cells: parseSquares(raw.from_at), label: text(raw.from_label) },
      { level: text(raw.to), cells: parseSquares(raw.to_at), label: text(raw.to_label) }
    ];
    if (ends.some((end) => !end.level || !end.cells.length)) return [];
    if (ends[0].level === ends[1].level) return [];
    return [ends, [...ends].reverse()].map(([here, there]) => ({
      layerId: here.level,
      exit: {
        id: text(id),
        label: here.label || `To ${there.level}`,
        cells: here.cells,
        // Always written down, never guessed. The plates of a place are not
        // necessarily drawn in register with each other, so "the square you
        // left" is a different room one floor down.
        to: { layerId: there.level, x: there.cells[0].x, y: there.cells[0].y }
      }
    }));
  }

  // The place's exits with the encounter's word on top. An encounter entry with
  // the same id as one of the place's replaces it outright rather than merging
  // field by field — half an overridden stair is nobody's intent — and
  // `disabled: true` removes it for tonight without touching the place, so
  // every other encounter there still has its trapdoor.
  function exitsForScene(place, encounter) {
    const layerIds = new Set(place.layers.map((layer) => layer.id));
    const byLayer = new Map(place.layers.map((layer) => [layer.id, [...(layer.exits || [])]]));

    for (const [id, spec] of entries(encounter?.exits)) {
      const key = text(id);
      for (const list of byLayer.values()) {
        const at = list.findIndex((item) => item.id === key);
        if (at >= 0) list.splice(at, 1);
      }
      if (spec?.disabled) continue;
      // Both directions, or neither: half a tunnel is a one-way trip somebody
      // has to be fished back out of.
      for (const made of exitFromEncounter(key, spec)) {
        if (byLayer.has(made.layerId)) byLayer.get(made.layerId).push(made.exit);
      }
    }

    // An exit onto a layer this place does not have is a door into nothing. The
    // CLI drops these at publish time; a hand-edited encounter can still write
    // one, and offering a player a floor that never arrives is worse than
    // silence.
    for (const [layerId, list] of byLayer) {
      byLayer.set(layerId, list.filter((item) => layerIds.has(item.to.layerId) && item.to.layerId !== layerId));
    }
    return byLayer;
  }

  // ---------------------------------------------------------------- campaign

  async function loadCampaign(preferredId = "") {
    const indexUrl = new URL(CAMPAIGN_INDEX_URL, location.href).href;
    const index = await fetchYaml(indexUrl);
    const registered = entries(index.campaigns);
    if (!registered.length) throw new Error("campaigns/index.yaml lists no campaigns");
    const wanted = preferredId || text(index.default) || registered[0][0];
    const [id, entry] = registered.find(([key]) => key === wanted) || registered[0];
    const manifestUrl = new URL(`${text(entry?.path, `${id}/`)}campaign.yaml`, indexUrl).href;
    return normalizeCampaign(await fetchYaml(manifestUrl), { id, manifestUrl, entry: entry || {} });
  }

  function normalizeCampaign(raw, context) {
    const catalog = raw.catalog || {};
    const defaults = raw.defaults || {};
    const grid = defaults.grid || {};
    const resolve = (path, fallback) => new URL(text(path, fallback), context.manifestUrl).href;
    return {
      id: text(raw.id, context.id),
      name: text(raw.name, text(context.entry.name, context.id)),
      subtitle: text(raw.subtitle, text(context.entry.subtitle)),
      // Only ever applied to a visitor who has never picked a table style.
      theme: text(raw.theme),
      // Which game this is, and what it calls the three universal stats. The
      // field names on an actor never change — `hp`, `armor_class`, `speed_ft`
      // are read in dozens of places here — only what the sheet calls them, so
      // a 40k campaign reads Wounds and Toughness. The CLI resolves these from
      // its system profile and writes them here; the board renders them and
      // knows nothing about any particular game.
      system: text(raw.system),
      statLabels: {
        hp: text(raw.stat_labels?.hp, "Hit Points"),
        armorClass: text(raw.stat_labels?.armor_class, "Armor Class"),
        speed: text(raw.stat_labels?.speed_ft, "Speed")
      },
      manifestUrl: context.manifestUrl,
      actorsIndexUrl: resolve(catalog.actors, "actors/index.yaml"),
      placesIndexUrl: resolve(catalog.places, "places/index.yaml"),
      encountersIndexUrl: resolve(catalog.encounters, "encounters/index.yaml"),
      defaultEncounterId: text(raw.default_encounter_id),
      defaults: {
        squareSizeFt: positive(defaults.square_size_ft, 5),
        grid: {
          visible: grid.visible !== false,
          color: hex(grid.color, DEFAULT_GRID.color),
          strength: percent(grid.strength, DEFAULT_GRID.strength)
        }
      },
      seats: entries(raw.seats).map(([id, seat]) => ({
        id, name: text(seat?.name, id), pcAssetId: text(seat?.pc_asset_id)
      })),
      affiliations: entries(raw.affiliations).map(([id, item]) => ({
        id, label: text(item?.label, id).slice(0, 40), color: hex(item?.color, "#f4efe3")
      }))
    };
  }

  // ------------------------------------------------------------------- place

  async function loadPlaceIndex(campaign) {
    const raw = await fetchYaml(campaign.placesIndexUrl);
    return entries(raw.places).map(([id, entry]) => ({
      id,
      name: text(entry?.name, id),
      district: text(entry?.district),
      // A published place is a folder: `place.yaml` beside the `maps/` it names.
      url: new URL(text(entry?.file, `${id}/place.yaml`), campaign.placesIndexUrl).href
    }));
  }

  async function loadPlace(campaign, id) {
    const listed = (await loadPlaceIndex(campaign)).find((entry) => entry.id === id);
    if (!listed) throw new Error(`Unknown place: ${id}`);
    if (placeCache.has(listed.url)) return placeCache.get(listed.url);
    const place = normalizePlace(await fetchYaml(listed.url), listed.url, campaign);
    placeCache.set(listed.url, place);
    return place;
  }

  function normalizePlace(raw, sourceUrl, campaign) {
    const board = raw.board || {};
    // Document order is the floor order, top floor first. Each layer keeps both
    // the path as authored (`mapRef`, what gets written back out) and the URL it
    // resolves to (`url`, what the <img> loads). `place.yaml` sits beside its
    // own `maps/`, so those paths resolve against the file just fetched.
    const layers = entries(raw.layers).map(([id, layer]) => ({
      id,
      name: text(layer?.name, id),
      mapRef: text(layer?.map),
      overlayRef: text(layer?.overlay),
      url: layer?.map ? new URL(text(layer.map), sourceUrl).href : "",
      // A level bigger than one plate arrives as tiles at grid coordinates. The
      // board stitches them into a single image before drawing, so everything
      // downstream — sizing, grid, actor coordinates — stays as it was.
      tiles: Array.isArray(layer?.tiles)
        ? layer.tiles
            .filter((tile) => tile && tile.map)
            .map((tile) => ({
              url: new URL(text(tile.map), sourceUrl).href,
              col: Math.max(0, Math.round(Number(tile.col) || 0)),
              row: Math.max(0, Math.round(Number(tile.row) || 0))
            }))
        : [],
      overlayUrl: layer?.overlay ? new URL(text(layer.overlay), sourceUrl).href : "",
      // A storey drawn over the one beneath it rather than instead of it. The
      // id of the level to composite underneath; empty for an opaque plate that
      // covers its whole footprint. Derived at publish time from
      // `transparent: true`, so nothing here reasons about storey numbers.
      below: text(layer?.below),
      // How lit this storey is before anyone strikes a match, and what stops
      // light and sight crossing it. `bright` is the default and means the
      // board draws no darkness at all, so every level authored before any of
      // this existed keeps behaving exactly as it did. Front Street at noon is
      // not a fog problem, and it should not have to say so.
      ambientLight: AMBIENT_BANDS.has(text(layer?.ambient_light)) ? text(layer.ambient_light) : "bright",
      occluderRef: text(layer?.occluders),
      occluderUrl: layer?.occluders ? new URL(text(layer.occluders), sourceUrl).href : "",
      // Which squares lead off this storey and where they come out. The
      // building's own stairs; an encounter may add to them or shut one.
      exits: normalizeExits(layer?.exits)
    })).filter((layer) => layer.url || layer.tiles.length);
    if (!layers.length) throw new Error(`Place ${raw.id} declares no usable layers`);
    const defaultLayerId = text(raw.default_layer_id);
    return {
      id: text(raw.id),
      name: text(raw.name, text(raw.id)),
      district: text(raw.district),
      sourceUrl,
      board: {
        columns: positive(board.columns, 48),
        rows: positive(board.rows, 32),
        squarePx: positive(board.square_size_px, 32),
        squareFt: positive(board.square_size_ft, campaign?.defaults.squareSizeFt || 5),
        offsetX: Math.round(Number(board.offset_x) || 0),
        offsetY: Math.round(Number(board.offset_y) || 0)
      },
      defaultLayerId: layers.some((layer) => layer.id === defaultLayerId) ? defaultLayerId : layers[0].id,
      layers
    };
  }

  // --------------------------------------------------------------- encounter

  async function loadEncounterIndex(campaign) {
    const raw = await fetchYaml(campaign.encountersIndexUrl);
    return entries(raw.encounters).map(([id, entry]) => ({
      id,
      title: text(entry?.title, id),
      placeId: text(entry?.place_id),
      status: text(entry?.status, "draft"),
      url: new URL(text(entry?.file, `${id}.yaml`), campaign.encountersIndexUrl).href
    }));
  }

  async function loadEncounter(campaign, id) {
    const listed = (await loadEncounterIndex(campaign)).find((entry) => entry.id === id);
    if (!listed) throw new Error(`Unknown encounter: ${id}`);
    if (encounterCache.has(listed.url)) return encounterCache.get(listed.url);
    const encounter = normalizeEncounter(await fetchYaml(listed.url), listed);
    encounterCache.set(listed.url, encounter);
    return encounter;
  }

  // Accepts both spellings: a file uses snake_case, but a draft round-trips
  // through localStorage in the camelCase shape this function returns.
  function normalizeEncounter(raw, listed = {}) {
    const counts = raw.counts || {};
    return {
      id: text(raw.id, text(listed.id)),
      title: text(raw.title, text(listed.title, "Untitled encounter")),
      status: text(raw.status, text(listed.status, "draft")),
      description: text(raw.description),
      placeId: text(raw.place_id, text(raw.placeId, text(listed.placeId))),
      defaultLayerId: text(raw.default_layer_id, text(raw.defaultLayerId)),
      counts: {
        people: Math.max(0, Number(counts.people) || 0),
        horses: Math.max(0, Number(counts.horses) || 0),
        items: Math.max(0, Number(counts.items) || 0)
      },
      placements: raw.placements && typeof raw.placements === "object" ? raw.placements : {},
      // Scene-only ways off a floor, and scene-only silencings of the place's.
      // Keyed by id: this half is authored by hand, not derived.
      exits: raw.exits && typeof raw.exits === "object" ? raw.exits : {},
      source: listed.url ? "file" : "draft"
    };
  }

  // A small item is half a square on a side, four to a square, so it lands on
  // half-square lines; everything else stays on the grid proper. The step comes
  // from the footprint rather than being global, so dropping a lantern into the
  // corner of a square never knocks a horse half off its own.
  function gridStep(footprint) {
    return Math.min(footprint.width, footprint.height) < 1 ? .5 : 1;
  }

  function clampToBoard(board, footprint, rawX, rawY) {
    const step = gridStep(footprint);
    const snap = (raw) => Number.isFinite(Number(raw)) ? Math.round(Number(raw) / step) * step : 0;
    return {
      x: Math.max(0, Math.min(board.columns - footprint.width, snap(rawX))),
      y: Math.max(0, Math.min(board.rows - footprint.height, snap(rawY)))
    };
  }

  // The encounter + place → board state boundary. Returns everything the
  // shared snapshot needs; the caller decides when to broadcast it.
  function sceneFromEncounter(encounter, place, actorLibrary) {
    const layerIds = new Set(place.layers.map((layer) => layer.id));
    const startLayer = layerIds.has(encounter.defaultLayerId) ? encounter.defaultLayerId : place.defaultLayerId;
    const actors = [];
    const missing = new Set();

    for (const group of Object.values(encounter.placements)) {
      if (!group || typeof group !== "object" || !group.positions || typeof group.positions !== "object") continue;
      const definition = actorLibrary.get(group.asset_id);
      for (const position of Object.values(group.positions)) {
        if (!position || typeof position !== "object") continue;
        if (!definition) { missing.add(text(group.asset_id, "unassigned")); continue; }
        const actor = window.LaramieActors.createInstance(definition, {
          name: position.name,
          layerId: layerIds.has(position.layer_id) ? position.layer_id : startLayer,
          x: position.x, y: position.y, rotation: position.rotation
        });
        if (typeof position.notes === "string") actor.notes = position.notes;
        if (position.hp_current != null) actor.hp.current = Math.max(0, Number(position.hp_current) || 0);
        // A seat id from the file; seats are keyed by their campaign.yaml name,
        // so this survives a reconnect. bindAllSeatPcs still owns the PC tokens.
        if (text(position.controller)) actor.controller = text(position.controller);
        Object.assign(actor, clampToBoard(place.board, window.LaramieActors.footprint(definition, actor.rotation), position.x, position.y));
        actors.push(actor);
      }
    }

    const exits = exitsForScene(place, encounter);
    return {
      actors,
      missing: [...missing],
      layers: place.layers.map((layer) => ({ ...layer, exits: exits.get(layer.id) || [] })),
      activeLayer: startLayer,
      grid: { size: place.board.squarePx, offsetX: place.board.offsetX, offsetY: place.board.offsetY }
    };
  }

  // A place is cached because it is static content fetched once. It stops being
  // static the moment the board can author an exit onto it, so the one thing
  // that writes a place is also the one thing allowed to forget it.
  function forgetPlaces() {
    placeCache.clear();
  }

  window.LaramieCampaign = {
    loadCampaign, loadPlaceIndex, loadPlace, loadEncounterIndex, loadEncounter,
    normalizeEncounter, sceneFromEncounter, clampToBoard, exitsForScene, forgetPlaces
  };
})();
