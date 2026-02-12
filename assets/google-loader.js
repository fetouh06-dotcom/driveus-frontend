(async function loadGoogleMaps() {
  try {
    const API_BASE =
      (window.DRIVEUS_CONFIG && window.DRIVEUS_CONFIG.apiBase) ||
      "https://api.driveus.fr";

    const res = await fetch(`${API_BASE}/api/public-config`, { cache: "no-store" });
    if (!res.ok) throw new Error(`public-config HTTP ${res.status}`);
    const cfg = await res.json();

    const key = cfg.googleMapsApiKey;
    if (!key) throw new Error("googleMapsApiKey missing from /api/public-config");

    // Already loaded?
    if (window.google?.maps) {
      // Ensure places is available
      if (google.maps.importLibrary) {
        await google.maps.importLibrary("places");
      }
      window.dispatchEvent(new Event("google-maps-loaded"));
      return;
    }

    if (document.querySelector('script[data-google-maps="1"]')) return;

    const s = document.createElement("script");
    s.dataset.googleMaps = "1";
    s.async = true;
    s.defer = true;

    // Keep libraries=places for older behavior + bootstrap
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(
      key
    )}&libraries=places&loading=async`;

    s.onload = async () => {
      try {
        // Modern way: explicitly import Places library
        if (google?.maps?.importLibrary) {
          await google.maps.importLibrary("places");
        }
      } catch (e) {
        console.error("❌ importLibrary('places') failed:", e);
      } finally {
        window.dispatchEvent(new Event("google-maps-loaded"));
      }
    };

    s.onerror = () => {
      console.error("❌ Failed to load Google Maps JS (check referrers/billing/APIs).");
    };

    document.head.appendChild(s);
  } catch (e) {
    console.error("❌ Google loader error:", e);
  }
})();
