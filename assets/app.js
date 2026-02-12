(() => {
  const API_BASE = (window.DRIVEUS_CONFIG && window.DRIVEUS_CONFIG.apiBase) || "https://api.driveus.fr";

  const els = {
    year: document.getElementById("year"),
    form: document.getElementById("bookingForm"),
    btnEstimate: document.getElementById("btnEstimate"),
    btnPay: document.getElementById("btnPay"),
    notice: document.getElementById("notice"),
    fareLabel: document.getElementById("fareLabel"),
    depositLabel: document.getElementById("depositLabel"),
    payNowLabel: document.getElementById("payNowLabel"),
    estimateHint: document.getElementById("estimateHint"),
    pickup: document.getElementById("pickup_address"),
    dropoff: document.getElementById("dropoff_address"),
    dt: document.getElementById("pickup_datetime"),
    name: document.getElementById("customer_name"),
    email: document.getElementById("customer_email"),
    phone: document.getElementById("phone"),
    passengers: document.getElementById("passengers"),
    notes: document.getElementById("notes"),
  };

  if (els.year) els.year.textContent = String(new Date().getFullYear());

  let publicCfg = { depositEur: 10, depositExpiresMinutes: 30 };
  let lastEstimate = null;

  function setNotice(msg, type = "info") {
    if (!els.notice) return;
    els.notice.textContent = msg || "";
    els.notice.dataset.type = type;
  }

  function fmtEur(n) {
    if (n == null || Number.isNaN(Number(n))) return "—";
    return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(Number(n));
  }

  function updateSummary() {
    const price = lastEstimate?.price ?? null;

    if (els.fareLabel) els.fareLabel.textContent = price == null ? "—" : fmtEur(price);
    if (els.depositLabel) els.depositLabel.textContent = fmtEur(publicCfg.depositEur ?? 10);
    if (els.payNowLabel) els.payNowLabel.textContent = fmtEur(publicCfg.depositEur ?? 10);

    if (els.estimateHint) {
      if (price == null) els.estimateHint.textContent = "Renseigne départ et arrivée pour calculer l’estimation.";
      else els.estimateHint.textContent = lastEstimate?.approximate ? "Estimation approximative (itinéraire indisponible)." : "Estimation calculée.";
    }
  }

  async function fetchPublicConfig() {
    const res = await fetch(`${API_BASE}/api/public-config`, { cache: "no-store" });
    if (!res.ok) throw new Error(`public-config HTTP ${res.status}`);
    publicCfg = await res.json();
    updateSummary();
  }

  function onGoogleReady(fn) {
    if (window.google && window.google.maps) return fn();
    window.addEventListener("google-maps-loaded", fn, { once: true });
  }

  async function initAutocomplete() {
    if (!els.pickup || !els.dropoff) return;

    // Try to ensure Places is loaded (new API)
    try {
      if (window.google?.maps?.importLibrary) {
        await google.maps.importLibrary("places");
      }
    } catch (e) {
      console.error("❌ Could not import Places:", e);
    }

    try {
      const AutocompleteCtor = google?.maps?.places?.Autocomplete;
      if (!AutocompleteCtor) {
        setNotice("Autocomplete indisponible. Vérifie Places API (Google Cloud).", "error");
        return;
      }

      const opts = {
        fields: ["formatted_address", "geometry", "name"],
        componentRestrictions: { country: ["fr"] },
      };

      new AutocompleteCtor(els.pickup, opts);
      new AutocompleteCtor(els.dropoff, opts);
    } catch (e) {
      console.error("❌ Autocomplete init failed:", e);
      setNotice("Autocomplete indisponible (clé Google / restrictions).", "error");
    }
  }

  function getEstimatePayload() {
    return {
      pickup_text: (els.pickup?.value || "").trim(),
      dropoff_text: (els.dropoff?.value || "").trim(),
      pickup_datetime: els.dt?.value ? new Date(els.dt.value).toISOString() : null,
    };
  }

  async function estimate() {
    const payload = getEstimatePayload();

    if (!payload.pickup_text || !payload.dropoff_text) {
      lastEstimate = null;
      updateSummary();
      setNotice("Renseigne le départ et l’arrivée pour estimer.", "info");
      return;
    }

    setNotice("Calcul de l’estimation…", "info");
    if (els.btnEstimate) els.btnEstimate.disabled = true;

    try {
      const res = await fetch(`${API_BASE}/api/estimate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `estimate HTTP ${res.status}`);

      lastEstimate = data;
      updateSummary();
      setNotice("", "info");
    } catch (e) {
      console.error(e);
      lastEstimate = null;
      updateSummary();
      setNotice("Impossible de calculer l’estimation. Réessaie ou contacte-nous.", "error");
    } finally {
      if (els.btnEstimate) els.btnEstimate.disabled = false;
    }
  }

  async function createBookingAndPay() {
    if (!els.form?.checkValidity()) {
      els.form?.reportValidity?.();
      return;
    }

    if (!lastEstimate?.price) {
      await estimate();
      if (!lastEstimate?.price) return;
    }

    setNotice("Création de la réservation…", "info");
    if (els.btnPay) els.btnPay.disabled = true;

    try {
      const bookingPayload = {
        customer_name: (els.name?.value || "").trim(),
        customer_email: (els.email?.value || "").trim(),
        customer_phone: (els.phone?.value || "").trim(),
        pickup_address: (els.pickup?.value || "").trim(),
        dropoff_address: (els.dropoff?.value || "").trim(),
        pickup_datetime: els.dt?.value ? new Date(els.dt.value).toISOString() : null,
        passengers: Number(els.passengers?.value || 2),
        notes: (els.notes?.value || "").trim(),

        estimated_price: Number(lastEstimate.price),
        estimated_distance_km: lastEstimate.distance ?? null,
        estimated_approximate: !!lastEstimate.approximate,
        estimated_reason: lastEstimate.reason || null,
        estimated_breakdown: lastEstimate.breakdown || null,
      };

      const res = await fetch(`${API_BASE}/api/bookings/public`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bookingPayload),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `booking HTTP ${res.status}`);

      setNotice("Redirection vers le paiement…", "info");

      const payRes = await fetch(`${API_BASE}/api/payments/deposit-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          booking_id: data.id,
          public_token: data.public_token || data.publicToken || undefined,
        }),
      });

      const payData = await payRes.json().catch(() => ({}));
      if (!payRes.ok) throw new Error(payData?.error || `payment HTTP ${payRes.status}`);

      if (!payData.url) throw new Error("Stripe Checkout URL missing");
      window.location.href = payData.url;
    } catch (e) {
      console.error(e);
      setNotice("Erreur lors de la réservation/paiement. Réessaie ou contacte-nous.", "error");
    } finally {
      if (els.btnPay) els.btnPay.disabled = false;
    }
  }

  // Events
  els.btnEstimate?.addEventListener("click", (e) => {
    e.preventDefault();
    estimate();
  });

  let t = null;
  function debounceEstimate() {
    clearTimeout(t);
    t = setTimeout(() => estimate(), 350);
  }
  els.pickup?.addEventListener("input", debounceEstimate);
  els.dropoff?.addEventListener("input", debounceEstimate);
  els.dt?.addEventListener("change", debounceEstimate);

  els.form?.addEventListener("submit", (e) => {
    e.preventDefault();
    createBookingAndPay();
  });

  // Init
  fetchPublicConfig().catch((e) => {
    console.error(e);
    updateSummary();
  });

  onGoogleReady(() => initAutocomplete());
  updateSummary();
})();