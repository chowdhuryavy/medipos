// Tab name and icon come from the saved branding. Until it is known, the tab says Loading instead of the address.
try {
  var b = JSON.parse(localStorage.getItem("medipos.branding") || "{}");
  var n = b.shopName;
  if (n) document.title = n;
  if (b.logoUrl) {
    var ic = document.querySelector('link[rel="icon"]') || document.createElement("link");
    ic.rel = "icon"; ic.href = b.logoUrl; ic.type = (b.logoUrl.match(/^data:([^;,]+)/) || [])[1] || "image/png";
    if (!ic.parentNode) document.head.appendChild(ic);
  }
} catch (e) { /* storage unavailable: keep the defaults */ }
