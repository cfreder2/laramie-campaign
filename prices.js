/* ============================================================================
   prices.js — fills every price/rate on every page from prices.json
   (the single source of truth). Include on any page that shows prices:
     <script src="prices.js" defer></script>

   Mark up values like this; the inline text is a fallback if JS/fetch fails:
     <span data-price="goods.colt-army">$17</span>
     <span data-price="drinks.whiskey">50¢</span>
     <span data-rate="exchange.gold-oz" data-fmt="dollar">$20.67</span>
     <span data-rate="exchange.assay-fee-pct" data-fmt="pct">5%</span>
     <span data-rate="exchange.greenback-per-dollar" data-fmt="cents">72¢</span>

   In the store catalog, put the price span (class "amt") inside each card's
   .price div; this script also syncs the card's data-price (for sorting).
   ============================================================================ */
(function () {
  function money(v) {
    if (v == null || isNaN(v)) return '';
    if (v < 1) return Math.round(v * 100) + '¢';        // 10¢
    return '$' + (Number.isInteger(v) ? v : v.toFixed(2));    // $17 / $2.50
  }
  function fmt(v, kind) {
    if (v == null || isNaN(v)) return '';
    switch (kind) {
      case 'pct':    return v + '%';
      case 'cents':  return Math.round(v * 100) + '¢';
      case 'dollar': return '$' + (Number.isInteger(v) ? v : v.toFixed(2));
      default:       return money(v);
    }
  }
  function dig(obj, path) {
    return path.split('.').reduce(function (o, k) { return o && o[k] !== undefined ? o[k] : null; }, obj);
  }

  fetch('prices.json')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      // price values (goods, drinks)
      document.querySelectorAll('[data-price]').forEach(function (el) {
        var v = dig(data, el.getAttribute('data-price'));
        if (v == null) return;
        el.textContent = money(v);
        var card = el.closest('.card');
        if (card) card.dataset.price = v;   // keep the store's sort accurate
      });
      // exchange rates (formatted)
      document.querySelectorAll('[data-rate]').forEach(function (el) {
        var v = dig(data, el.getAttribute('data-rate'));
        if (v == null) return;
        el.textContent = fmt(v, el.getAttribute('data-fmt'));
      });
      document.dispatchEvent(new CustomEvent('prices-loaded'));
    })
    .catch(function () { /* leave inline fallback text in place */ });
})();
