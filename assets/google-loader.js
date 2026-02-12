(async function loadGoogleMaps() {
  try {
    const API_BASE = (window.DRIVEUS_CONFIG && window.DRIVEUS_CONFIG.apiBase) || "https://api.driveus.fr";

    const res = await fetch(`${API_BASE}/api/public-config`, { cache: "no-store" });
    if (!res.ok) throw new Error(`public-config HTTP ${res.status}`);
    const cfg = await res.json();

    const key = cfg.googleMapsApiKey;
    if (!key) throw new Error("googleMapsApiKey missing from /api/public-config");

    if (window.google && window.google.maps) {
      window.dispatchEvent(new Event("google-maps-loaded"));
      return;
    }
    if (document.querySelector('script[data-google-maps="1"]')) return;

    const s = document.createElement("script");
    s.dataset.googleMaps = "1";
    s.async = true;
    s.defer = true;
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&libraries=places&loading=async`;

    s.onload = () => window.dispatchEvent(new Event("google-maps-loaded"));
    s.onerror = () => console.error("❌ Failed to load Google Maps JS. Check API key referrers/billing/APIs.");

    document.head.appendChild(s);
  } catch (e) {
    console.error("❌ Google loader error:", e);
  }
})();