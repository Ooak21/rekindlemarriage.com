/* Rekindle — GA4 loader + site-wide events.
 * Property is Rekindle only (G-VVZ393HVW4). Never Vitality's ID.
 * Public pages: <script src="/ga.js" defer></script>
 * Custom events: window.rekindleTrack('event_name', { key: 'value' })
 * No tag on /crm/. Do not pass names, emails, or phone numbers.
 */
(function () {
  "use strict";
  var GA4_MEASUREMENT_ID = "G-VVZ393HVW4";
  var CRM = /\/crm(\/|$)/.test(location.pathname);
  var LIVE = /^G-[A-Z0-9]{6,}$/.test(GA4_MEASUREMENT_ID) && !CRM;

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = window.gtag || gtag;

  if (LIVE) {
    var s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + GA4_MEASUREMENT_ID;
    document.head.appendChild(s);
    gtag("js", new Date());
    gtag("config", GA4_MEASUREMENT_ID, { anonymize_ip: true });
  }

  window.rekindleTrack = function (name, params) {
    if (CRM) return;
    params = params || {};
    params.page_path = location.pathname;
    if (LIVE) window.gtag("event", name, params);
    else if (window.console) console.debug("[GA4 dry-run] " + name, params);
  };

  document.addEventListener("click", function (e) {
    var el = e.target && e.target.closest ? e.target.closest("a,button") : null;
    if (!el) return;
    var href = (el.getAttribute && el.getAttribute("href")) || "";
    var text = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100);
    if (href.indexOf("tel:") === 0) {
      window.rekindleTrack("call_click", { link_text: text });
    } else if (href.indexOf("mailto:") === 0) {
      window.rekindleTrack("email_click", { link_text: text });
    } else if (/marriageworkshop|score\.html|datenight|#enroll|#reserve|#cta/i.test(href)) {
      window.rekindleTrack("cta_click", { cta_text: text, destination: href.slice(0, 120) });
    }
  }, true);

  document.addEventListener("submit", function (e) {
    var f = e.target;
    if (!f || f.tagName !== "FORM") return;
    if (f.getAttribute("data-ga-manual") != null) return;
    var id = (f.id || f.getAttribute("name") || "").toLowerCase();
    if (/login|signin|reset|password|auth/.test(id)) return;
    window.rekindleTrack("generate_lead", { form_id: id || "form" });
  }, true);
})();
