/**
 * Bookmarklet source. NOT loaded as a normal script — index.html fetches
 * this file's text at page load, substitutes __WORKER_URL__/__FRONTEND_URL__
 * with the real deployed values from config.js, then wraps it as a
 * `javascript:` URI for the "Scrape this McMaster page" link.
 *
 * Runs in the context of the McMaster product page the user is already
 * viewing (logged in, in their own browser) when they click the
 * bookmarklet — reads the rendered DOM, so it sees real spec data that a
 * server-side fetch never could, and isn't automation McMaster's anti-bot
 * measures would flag.
 */
(function () {
  var WORKER_URL = "__WORKER_URL__";
  var FRONTEND_URL = "__FRONTEND_URL__";

  var m = location.pathname.match(/\/([A-Za-z0-9]{3,12})\/?(?:$|\?)/);
  var partNumber = m ? m[1] : "";

  var lines = [document.title];
  var nodes = document.querySelectorAll("h1, h2, h3, dt, dd, th, td, li, p");
  var total = 0;
  for (var i = 0; i < nodes.length && total < 20000; i++) {
    var t = (nodes[i].innerText || "").trim();
    if (t) {
      lines.push(t);
      total += t.length;
    }
  }
  var scrapedText = lines.join("\n").slice(0, 20000);

  fetch(WORKER_URL + "/api/xref", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ partNumber: partNumber, scrapedText: scrapedText }),
  })
    .then(function (r) {
      return r.json();
    })
    .then(function (data) {
      var encoded = btoa(unescape(encodeURIComponent(JSON.stringify(data))));
      window.open(FRONTEND_URL + "#result=" + encoded, "_blank");
    })
    .catch(function (err) {
      alert("McMaster Xref lookup failed: " + err.message);
    });
})();
