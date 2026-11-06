/* ============================================================================
   weapons.js — fills weapon stats on the store catalog from weapons.json
   (the single source of truth, shared with the dice roller). Mirrors prices.js.

   Mark a product card with the weapon id (same slug as prices.json goods), and
   mark the value spans with data-wf="<field>". The inline text is a fallback if
   JS/fetch fails:

     <div class="card" data-weapon="colt-army" ...>
       <span class="k">Damage</span><span class="v" data-wf="dmg">1d10 piercing</span>
       <span class="k">Range</span> <span class="v" data-wf="range">40 / 120 ft</span>

   Fields: dmg (dice + damage type), range (falls back to area), area, save.
   The card's data-dmg (used by the "Avg. Damage" sort) is also re-derived from
   the canonical dice so the sort stays in step with weapons.json.
   ============================================================================ */
(function () {
  function avgOf(notation) {                 // "2d6" -> 7, "1d10" -> 5.5
    var m = /^\s*(\d+)d(\d+)\s*$/.exec(notation || '');
    return m ? (+m[1]) * ((+m[2]) + 1) / 2 : null;
  }
  function field(w, name) {
    switch (name) {
      case 'dmg':   return w.dmg ? (w.dmg + (w.dtype ? ' ' + w.dtype : '')) : 'No damage';
      case 'range': return w.range || w.area || '';
      case 'area':  return w.area || '';
      case 'save':  return w.save || '';
      default:      return (w[name] != null) ? String(w[name]) : '';
    }
  }

  fetch('weapons.json')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var byId = {};
      (data.weapons || []).forEach(function (w) { if (w.id) byId[w.id] = w; });

      document.querySelectorAll('[data-weapon]').forEach(function (card) {
        var w = byId[card.getAttribute('data-weapon')];
        if (!w) return;

        card.querySelectorAll('[data-wf]').forEach(function (el) {
          var v = field(w, el.getAttribute('data-wf'));
          if (v !== '') el.textContent = v;
        });

        // keep the average-damage sort key consistent with the canonical dice
        var avg = avgOf(w.dmg);
        if (avg != null) card.setAttribute('data-dmg', String(avg));
      });
    })
    .catch(function () { /* leave the inline fallback text in place */ });
})();
