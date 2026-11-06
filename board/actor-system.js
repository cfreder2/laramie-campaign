(() => {
  "use strict";

  function scalar(raw) {
    const value = stripComment(raw).trim();
    if (!value) return {};
    if (value === "true") return true;
    if (value === "false") return false;
    if (value === "null") return null;
    if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      // Unescape in one pass so an escaped backslash cannot swallow the next escape.
      return value.slice(1, -1).replace(/\\(.)/g, (_, char) => (char === "n" ? "\n" : char));
    }
    return value;
  }

  // A trailing `# comment` is only a comment on an unquoted value. A quoted one
  // keeps every character, so `color: "#d8bd83"` survives intact while
  // `category: person   # horse | person | item` loses its annotation.
  function stripComment(raw) {
    const value = raw.trimStart();
    if (value.startsWith('"') || value.startsWith("'")) return raw;
    const comment = raw.search(/(^|\s)#/);
    return comment === -1 ? raw : raw.slice(0, comment);
  }

  // `key: |` swallows every following line indented past the key. The first
  // non-blank line sets the content indent; interior blank lines are kept, and
  // `#` inside the block is prose, not a comment. Chomping follows YAML:
  // `|` clips to one trailing newline, `|-` strips it, `|+` keeps them all.
  function readBlockScalar(lines, start, keyIndent, marker) {
    const collected = [];
    let contentIndent = -1;
    let index = start;
    for (; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.trim()) { collected.push(""); continue; }
      const indent = line.match(/^\s*/)[0].length;
      if (indent <= keyIndent) break;
      if (contentIndent === -1) contentIndent = indent;
      if (indent < contentIndent) break;
      collected.push(line.slice(contentIndent));
    }
    let trailing = 0;
    while (collected.length && !collected.at(-1).trim()) { collected.pop(); trailing += 1; }
    const body = collected.join("\n");
    if (marker === "|-") return { text: body, next: index };
    if (marker === "|+") return { text: body + "\n".repeat(Math.max(1, trailing)), next: index };
    return { text: body ? `${body}\n` : "", next: index };
  }

  // Nested block mappings of scalars, flat block sequences of scalars, and `|`
  // block scalars for prose. No inline flow collections and no anchors — the
  // data files in docs/campaigns are written to this subset on purpose.
  function parseYaml(text) {
    const root = {};
    const stack = [{ indent: -1, value: root }];
    const lines = text.replace(/\r/g, "").split("\n");
    for (let cursor = 0; cursor < lines.length; cursor += 1) {
      const sourceLine = lines[cursor];
      if (!sourceLine.trim() || sourceLine.trimStart().startsWith("#")) continue;
      const indent = sourceLine.match(/^\s*/)[0].length;
      const body = sourceLine.trim();

      // `- item` fills the block its parent key opened. YAML lets the dashes sit
      // at or below the key's own indent, so only strictly deeper frames close.
      if (body === "-" || body.startsWith("- ")) {
        while (stack.at(-1).indent > indent) stack.pop();
        const frame = stack.at(-1);
        if (!Array.isArray(frame.value)) {
          if (!frame.owner || Object.keys(frame.value).length) throw new Error(`Unexpected YAML list item: ${body}`);
          frame.value = [];
          frame.owner[frame.key] = frame.value;
        }
        const item = stripComment(body.slice(1)).trim();
        if (!item) throw new Error(`Empty YAML list item`);
        if (/^[A-Za-z0-9_-]+:(\s|$)/.test(item)) {
          // `- key: value` opens a mapping item — the shape a tiled level uses
          // for {map, col, row}. Its remaining pairs are the lines indented to
          // where that first key starts, so the frame anchors just left of it:
          // deeper lines belong to this item, and the next dash, which sits
          // further left, closes it.
          // Kept in step with `dnd/yaml_io.py` and `campaigns/validate.py` —
          // three parsers, one subset.
          const entry = {};
          frame.value.push(entry);
          const afterDash = sourceLine.slice(indent + 1);
          const keyColumn = indent + 1 + (afterDash.length - afterDash.replace(/^ +/, "").length);
          const pair = item.match(/^([A-Za-z0-9_-]+):(?:\s+(.*))?$/);
          if (!pair) throw new Error(`Unsupported YAML list item: ${body}`);
          entry[pair[1]] = scalar(pair[2] || "");
          stack.push({ indent: keyColumn - 1, value: entry, owner: frame.value, key: null });
          continue;
        }
        frame.value.push(scalar(item));
        continue;
      }

      const match = body.match(/^([A-Za-z0-9_-]+):(?:\s+(.*))?$/);
      if (!match) throw new Error(`Unsupported YAML line: ${body}`);
      while (stack.at(-1).indent >= indent) stack.pop();
      const parent = stack.at(-1).value;
      if (Array.isArray(parent)) throw new Error(`Cannot nest a key inside a YAML list: ${body}`);

      const marker = (match[2] || "").trim();
      if (marker === "|" || marker === "|-" || marker === "|+") {
        const block = readBlockScalar(lines, cursor + 1, indent, marker);
        parent[match[1]] = block.text;
        cursor = block.next - 1;
        continue;
      }

      const value = scalar(match[2] || "");
      parent[match[1]] = value;
      // An empty body is a placeholder: the next line decides whether it becomes
      // a mapping or, via the branch above, a list. Remember its owner so it can
      // be swapped out in place.
      if (value && typeof value === "object") stack.push({ indent, value, owner: parent, key: match[1] });
    }
    return root;
  }

  // A character is known through a list of facts, not one paragraph. Each fact is
  // public (everyone sees it), staged (host-only, queued for a later reveal), or
  // secret (host eyes only). A manifest may declare them explicitly:
  //
  //   facts:
  //     trade:   { text: "…", visibility: public }
  //     murders: { text: "…", visibility: secret }
  //
  // A manifest with only a `description` seeds one secret fact from it, so the
  // old dossier line stays in the DM's hands until they choose to reveal it.
  const FACT_VISIBILITY = ["public", "staged", "secret"];

  function normalizeFactSeeds(raw) {
    if (!raw || typeof raw !== "object") return [];
    return Object.values(raw)
      .map((entry) => {
        const object = entry && typeof entry === "object" ? entry : null;
        const text = String(object ? object.text ?? "" : entry ?? "").trim();
        const visibility = object ? object.visibility : "";
        return {
          text,
          visibility: FACT_VISIBILITY.includes(visibility) ? visibility : "secret",
          // What it takes to learn this — "investigation 13 · insight 14". The
          // author wrote it as a check on a knowledge chunk, and the DM needs it
          // in front of them to know what to call for. Shown to the DM only.
          check: String(object?.check ?? "").trim().slice(0, 80),
          topic: String(object?.topic ?? "").trim().slice(0, 40)
        };
      })
      .filter((seed) => seed.text);
  }

  const ROTATIONS = ["north", "east", "south", "west"];

  // Most art lies flat in its square, seen from overhead. A pack may instead ship
  // a painted mini: a figure standing on a round base, one image per facing, seen
  // from a low three-quarter angle. A mini is placed by its BASE, not by the
  // picture's edges, so two measurements taken off the art decide how it sits:
  //
  //   mini:
  //     north: mini/north.png            # and east, south, west
  //     base: 0.49     # how much of the image WIDTH the round base covers
  //     bottom: 0.10   # how much of the image HEIGHT is empty below the base
  //     scale: 1       # optional taste multiplier once it has been fitted
  //
  // The base is scaled to cover the actor's footprint and dropped so it rests on
  // the front edge of the square; everything above that overhangs the squares
  // behind, which is the entire point of a mini.
  function normalizeMini(raw) {
    if (!raw || typeof raw !== "object") return null;
    const images = {};
    for (const rotation of ROTATIONS) if (raw[rotation]) images[rotation] = String(raw[rotation]);
    if (!Object.keys(images).length) return null;
    const bounded = (value, fallback, min, max) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
    };
    // `states` lists the variants the pack ships, each entry a sorted
    // `key@value__key@value` string. The file for one is the plain facing with
    // that string appended: `mini/north__condition@poisoned.png`.
    const variants = {};
    for (const entry of Array.isArray(raw.states) ? raw.states : []) {
      const key = String(entry).trim();
      if (!key) continue;
      variants[key] = Object.fromEntries(
        Object.entries(images).map(([rotation, path]) =>
          [rotation, path.replace(/\.png$/i, `${STATE_SEPARATOR}${key}.png`)])
      );
    }
    return {
      style: String(raw.style || ""), images, variants,
      base: bounded(raw.base, .5, .05, 1),
      bottom: bounded(raw.bottom, .1, 0, .6),
      scale: bounded(raw.scale, 1, .25, 4)
    };
  }

  // Either a quarter square or whole squares. A half on one side only is a shape
  // the grid cannot fit four of, so it is refused rather than drawn wrong — the
  // same rule the pack schema enforces when one is written to disk.
  const SMALL_SIDE = 0.5;

  function normalizeFootprint(raw) {
    if (!raw || typeof raw !== "object") return null;
    const width = Number(raw.width); const height = Number(raw.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
    if (width <= 0 || height <= 0 || width > 8 || height > 8) return null;
    if (width === SMALL_SIDE && height === SMALL_SIDE) return { width, height };
    if (width !== Math.trunc(width) || height !== Math.trunc(height)) return null;
    return { width, height };
  }

  function seedFacts(definition) {
    return (definition?.factSeeds || []).map((seed) => ({
      id: crypto.randomUUID(), text: seed.text, visibility: seed.visibility,
      check: seed.check || "", topic: seed.topic || ""
    }));
  }

  function resolveDefinition(raw, manifestUrl) {
    const base = new URL(manifestUrl, location.href);
    const definition = structuredClone(raw);
    definition.manifestUrl = base.href;
    definition.images = definition.images || {};
    for (const [rotation, path] of Object.entries(definition.images)) {
      definition.images[rotation] = new URL(path, base).href;
    }
    if (definition.image) definition.image = new URL(definition.image, base).href;
    // Optional full-size art for the sheet lightbox; the token image stands in otherwise.
    if (definition.portrait) definition.portrait = new URL(definition.portrait, base).href;
    definition.footprint = { width: 1, height: 1, ...(definition.footprint || {}) };
    // The `mini:` block's facings are pack-relative too; `style` is a label, not
    // a path, and the placement numbers are plain scalars.
    definition.mini = normalizeMini(definition.mini);
    if (definition.mini) {
      for (const [rotation, path] of Object.entries(definition.mini.images)) {
        definition.mini.images[rotation] = new URL(path, base).href;
      }
      for (const set of Object.values(definition.mini.variants)) {
        for (const [rotation, path] of Object.entries(set)) set[rotation] = new URL(path, base).href;
      }
    }
    // Whether this pack keeps a hit-point total at all. Anything that can be
    // worn down — a person, a horse, a barrel, a chest — declares `stats.hp`.
    // A thrown bomb, a knife lying on the floor, a stick of dynamite does not:
    // it is whole, and then it is used or broken and gone. Both still get the
    // single point below, so one hit finishes them, but nothing draws a bar over
    // them, prints an armour class, or asks the DM to track a number that never
    // moves. Read before the defaults land, because after that every pack has one.
    definition.tracksHealth = Number.isFinite(Number(definition.stats?.hp));
    definition.stats = {
      hp: 1, armor_class: 10, speed_ft: 0, damage_threshold: 0,
      indestructible: false, remove_on_destroyed: false, hp_visible: true,
      ...(definition.stats || {})
    };
    definition.factSeeds = normalizeFactSeeds(definition.facts);
    if (!definition.factSeeds.length && String(definition.description || "").trim()) {
      // A pack that already publishes its sheet (props, vehicles, the party) is
      // describing itself in the open; everything else is a DM dossier and stays shut.
      const open = definition.sheet_visibility === "all";
      definition.factSeeds = [{ text: String(definition.description).trim(), visibility: open ? "public" : "secret" }];
    }
    return definition;
  }

  // `indexUrl` is a board.actor-index/v1 file inside a campaign; the campaign
  // manifest is what knows where that is, so there is no default here.
  // Manifests are small text files that change every time the CLI runs, and a
  // cached one is worse than a slow one: the board goes on drawing a mini that
  // the pack no longer declares, or art it no longer points at, and no amount of
  // regenerating fixes it. `campaign-system` already fetches this way.
  const FRESH = { cache: "no-store" };

  async function loadLibrary(indexUrl) {
    const indexResponse = await fetch(indexUrl, FRESH);
    if (!indexResponse.ok) throw new Error(`Actor index returned ${indexResponse.status}`);
    const index = parseYaml(await indexResponse.text());
    const packs = Array.isArray(index.packs) ? index.packs : [];
    if (!packs.length) throw new Error(`Actor index at ${indexUrl} lists no packs`);
    const definitions = await Promise.all(packs.map(async (path) => {
      const manifestUrl = new URL(path, new URL(indexUrl, location.href));
      const response = await fetch(manifestUrl, FRESH);
      if (!response.ok) throw new Error(`${path} returned ${response.status}`);
      return resolveDefinition(parseYaml(await response.text()), manifestUrl);
    }));
    return new Map(definitions.map((definition) => [definition.id, definition]));
  }

  // A pack declares the squares its actor occupies; the DM may override that on
  // one token, which is what `override` carries. Rotation swaps the two sides,
  // so a 1x2 horse is 2x1 facing east.
  function footprint(definition, rotation = "north", override = null) {
    const base = normalizeFootprint(override) || definition?.footprint || { width: 1, height: 1 };
    return ["east", "west"].includes(rotation)
      ? { width: base.height, height: base.width }
      : { width: base.width, height: base.height };
  }

  // Every picture a pack ships, in the order a person would want to leaf through
  // them: the face first, then the painted mini it stands as on the board, then
  // the flat overhead art. Duplicates are dropped — a pack whose portrait and
  // token are the same file should offer that image once.
  function gallery(definition) {
    if (!definition) return [];
    const items = [];
    const add = (url, label) => {
      if (url && !items.some((item) => item.url === url)) items.push({ url, label });
    };
    add(definition.portrait, "Portrait");
    add(definition.image, "Portrait");
    for (const rotation of ROTATIONS) add(definition.mini?.images?.[rotation], `Mini · facing ${rotation}`);
    for (const [state, set] of Object.entries(definition.mini?.variants || {})) {
      const label = state.split(STATE_SEPARATOR).map((pair) => pair.replace("@", " ")).join(", ");
      for (const rotation of ROTATIONS) add(set[rotation], `Mini (${label}) · facing ${rotation}`);
    }
    for (const rotation of ROTATIONS) add(definition.images?.[rotation], `Top-down · facing ${rotation}`);
    // A lone image needs no label; a set does.
    return items.length > 1 ? items : items.map((item) => ({ ...item, label: "" }));
  }

  // The flat, top-down art: the overhead rotation map, then the single image.
  // A mini-only pack falls back to its painted facing so it still has a token
  // when a screen has laid the minis flat.
  //
  // South before north, matching `miniImageFor` and `defaultRotation` below: a
  // pack that draws one facing draws the front one, because that is the view a
  // piece set down on a table is turned to show. Older packs that named only
  // `north` still resolve through the line after.
  function imageFor(definition, rotation = "north") {
    return definition?.images?.[rotation]
      || definition?.image
      || definition?.images?.south
      || definition?.images?.north
      || miniImageFor(definition, rotation);
  }

  // The painted mini for a facing. South is the front view and the most legible,
  // so it stands in for any facing a pack did not sculpt.
  // A pack may sculpt the same figure again for a state it cares about — poisoned,
  // frozen, burning, destroyed — by dropping extra facings beside the plain ones:
  //
  //   mini/north.png                        the figure as it normally stands
  //   mini/north__condition@poisoned.png    the same figure, green about the gills
  //   mini/north__condition@frozen.png
  //   mini/north__condition@poisoned__wet@true.png
  //
  // The states a pack ships are listed in its manifest, because this board is a
  // static site: it can fetch a file but it cannot list a directory, so the
  // manifest is how it learns which variants exist. `dnd mini` writes that list
  // by scanning the pack, so the naming convention stays the only thing an
  // author has to know.
  const STATE_SEPARATOR = "__";

  function stateKey(pairs) {
    // Sorted, so `a@1__b@2` and `b@2__a@1` name the same file.
    return pairs.map(([key, value]) => `${key}@${value}`).sort().join(STATE_SEPARATOR);
  }

  // Every combination of the actor's live states, longest first, so the most
  // specific sculpt an author bothered to make is the one that gets used.
  function stateCandidates(states) {
    const pairs = Object.entries(states || {})
      .filter(([, value]) => value !== undefined && value !== null && value !== false && value !== "")
      .map(([key, value]) => [key, value === true ? "true" : String(value)]);
    if (!pairs.length) return [];
    const combinations = [[]];
    for (const pair of pairs) {
      for (const existing of [...combinations]) combinations.push([...existing, pair]);
    }
    return combinations
      .filter((combination) => combination.length)
      .sort((a, b) => b.length - a.length)
      .map(stateKey);
  }

  function miniImageFor(definition, rotation = "north", states = null) {
    const images = definition?.mini?.images;
    if (!images) return "";
    const variants = definition.mini.variants || {};
    for (const candidate of stateCandidates(states)) {
      const set = variants[candidate];
      const hit = set?.[rotation] || set?.south || set?.north;
      if (hit) return hit;
    }
    return images[rotation] || images.south || images.north || "";
  }

  // Which way a piece faces when it is first set down. South is the front view —
  // a figure placed on a table is turned to face the room, and it is the most
  // legible of the four facings, which is why miniImageFor already falls back to
  // it. A pack that never drew a south keeps north rather than claiming a facing
  // it cannot show. An encounter that states a rotation still wins: this only
  // answers for a piece nobody has said anything about.
  function defaultRotation(definition) {
    return definition?.mini?.images?.south || definition?.images?.south ? "south" : "north";
  }

  function createInstance(definition, options = {}) {
    return {
      id: options.id || crypto.randomUUID(),
      assetId: definition.id,
      name: options.name || definition.name,
      kind: definition.kind || "prop",
      layerId: options.layerId || "ground",
      x: Number(options.x || 0), y: Number(options.y || 0),
      rotation: options.rotation || defaultRotation(definition),
      controller: options.controller || "host",
      hp: { current: Number(definition.stats.hp), max: Number(definition.stats.hp) },
      // A pack fact rather than per-instance state, but it is copied onto the
      // token anyway so applyDamage can answer "does this wear down, or is it
      // simply spent" without reaching back for the manifest.
      tracksHealth: Boolean(definition.tracksHealth),
      armorClass: Number(definition.stats.armor_class),
      movementSpeed: Number(definition.stats.speed_ft),
      damageThreshold: Number(definition.stats.damage_threshold),
      indestructible: Boolean(definition.stats.indestructible),
      removeOnDestroyed: Boolean(definition.stats.remove_on_destroyed),
      // Health is host-only knowledge; this only decides whether the host's own
      // board draws the bar over this actor.
      hpVisible: definition.stats.hp_visible !== false,
      // Only what the room can see at a glance; a concealed allegiance ships blank.
      affiliation: definition.affiliation || "",
      // The item layer. `parent` is what makes contents travel with a container;
      // it is empty for anything sitting on the ground in its own right. The
      // rest is per-instance state the DM changes mid-scene — this chest is
      // unlocked now, that trap has been found — so it is copied off the
      // manifest rather than read through to it.
      parent: options.parent || "",
      locked: Boolean(definition.security?.locked),
      open: Boolean(definition.container?.open),
      trapArmed: Boolean(definition.security?.trap?.armed),
      trapFound: Boolean(definition.security?.trap?.found),
      loaded: Number(definition.ammunition?.loaded ?? 0),
      magicKnown: !definition.magic?.detect_dc,
      facts: seedFacts(definition), factsSeeded: true,
      inventory: "", notes: "",
      createdFrom: definition.manifestUrl
    };
  }

  function applyDamage(instance, rawDamage) {
    if (instance.indestructible) return { applied: 0, destroyed: false, reason: "indestructible" };
    const damage = Math.max(0, Number(rawDamage) || 0);
    // A thing with no hit-point total has nothing to wear down and no threshold
    // to beat. One hit is the whole story: the bottle breaks, the fuse burns,
    // and it comes off the board.
    if (instance.tracksHealth === false) {
      if (!damage) return { applied: 0, destroyed: false, reason: "damaged" };
      instance.hp.current = 0;
      return { applied: damage, destroyed: true, reason: "destroyed" };
    }
    const applied = Math.max(0, damage - Math.max(0, Number(instance.damageThreshold) || 0));
    instance.hp.current = Math.max(0, Number(instance.hp.current) - applied);
    return { applied, destroyed: instance.hp.current <= 0, reason: applied ? "damaged" : "threshold" };
  }

  window.LaramieActors = { parseYaml, loadLibrary, footprint, normalizeFootprint, imageFor, miniImageFor, gallery, createInstance, defaultRotation, applyDamage, seedFacts, ROTATIONS, FACT_VISIBILITY };
})();
