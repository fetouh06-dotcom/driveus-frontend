// DriveUs Premium Frontend (FAST + Google Places New - 2026)
// Backend:
// - /api/estimate attend pickup_text + dropoff_text et renvoie { price, distance, pickup?, dropoff?, approximate?, reason?, breakdown? }
// - /api/bookings/public attend pickup_text + dropoff_text + (optionnel) estimated_* pour éviter ORS

const CFG = window.DRIVEUS_CONFIG || {};
const API_BASE = CFG.API_BASE || "https://api.driveus.fr";

// Public config loaded from backend (Google Maps key, etc.)
let PUBLIC_CFG = null;
async function loadPublicConfig() {
  if (PUBLIC_CFG) return PUBLIC_CFG;
  try {
    const res = await fetch(`${API_BASE}/api/public-config`, { method: 'GET' });
    const data = await res.json().catch(() => ({}));
    PUBLIC_CFG = data && typeof data === 'object' ? data : {};
  } catch (_) {
    PUBLIC_CFG = {};
  }
  return PUBLIC_CFG;
}

function loadGoogleMapsScript(apiKey) {
  if (!apiKey) return false;
  if (window.__DRIVEUS_GMAPS_LOADED__ || window.__DRIVEUS_GMAPS_LOADING__) return true;
  if (document.getElementById('driveus-gmaps')) return true;

  window.__DRIVEUS_GMAPS_LOADING__ = true;

  // Google calls this when loaded
  window.driveusGmapsBootstrap = function () {
    window.__DRIVEUS_GMAPS_LOADED__ = true;
    window.__DRIVEUS_GMAPS_LOADING__ = false;
    try {
      if (typeof window.driveusGmapsReady === 'function') window.driveusGmapsReady();
    } catch (_) {}
  };

  const s = document.createElement('script');
  s.id = 'driveus-gmaps';
  s.async = true;
  s.defer = true;
  s.referrerPolicy = 'strict-origin-when-cross-origin';
  s.src =
    'https://maps.googleapis.com/maps/api/js' +
    '?key=' + encodeURIComponent(apiKey) +
    '&libraries=places' +
    '&language=fr' +
    '&v=beta' +
    '&loading=async' +
    '&callback=driveusGmapsBootstrap';

  document.head.appendChild(s);
  return true;
}
const DEFAULT_DEPOSIT_EUR = 10;

const $ = (id) => document.getElementById(id);

function val(id) {
  const el = $(id);
  return el ? el.value : "";
}

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

function setNotice(text, type = "") {
  const el = $("notice");
  if (!el) return;
  el.className = "notice" + (type ? " " + type : "");
  el.textContent = text || "";
}

function eur(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(2).replace(".", ",") + " €";
}

function track(eventName, params = {}) {
  if (typeof window.gtag === "function") {
    window.gtag("event", eventName, params);
  }
}

function setSummary({ fareEur, depositEur }) {
  setText("fareLabel", fareEur == null ? "—" : eur(fareEur));
  setText("depositLabel", eur(depositEur));
  setText("payNowLabel", eur(depositEur));
}

function getFormData() {
  return {
    customer_name: val("customer_name").trim(),
    customer_email: val("customer_email").trim(),
    // Backend expects customer_phone (validatePublicBooking whitelist)
    customer_phone: val("phone").trim(),
    pickup_address: val("pickup_address").trim(),
    dropoff_address: val("dropoff_address").trim(),
    pickup_datetime: val("pickup_datetime"),
    passengers: Number(val("passengers") || 1),
    notes: val("notes").trim()
  };
}

function validate(d) {
  if (!d.customer_name) return "Nom requis";
  if (!d.customer_email || !d.customer_email.includes("@")) return "Email invalide";
  if (!d.pickup_address) return "Adresse de départ requise";
  if (!d.dropoff_address) return "Adresse d’arrivée requise";
  if (!d.pickup_datetime) return "Date & heure requises";
  return null;
}

function roughEstimate(pickup, dropoff) {
  if (!pickup || !dropoff) return null;
  const base = 25;
  const variable = Math.min(80, Math.max(10, (pickup.length + dropoff.length) / 3.2));
  return Math.round((base + variable) * 100) / 100;
}

async function apiJson(url, method, body, { signal } = {}) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg = data.error || data.message || `Erreur API (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }

  return data;
}

function isTooLongRouteError(err) {
  const m = String(err?.message || "").toLowerCase();
  return (
    m.includes("must not be greater than 6000000") ||
    m.includes("exceed the server configuration limits")
  );
}

/* =========================
   ESTIMATE STATE (used for booking payload)
========================= */

let lastEstimate = null;
// {
//   pickup, dropoff, fare, distanceKm, approximate, reason,
//   pickupLabel, dropoffLabel, breakdown, ts
// }
const ESTIMATE_STALE_MS = 10 * 60 * 1000; // 10 min

function normAddr(s) {
  return String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function isLastEstimateUsableFor(d) {
  if (!lastEstimate) return false;
  if (Date.now() - lastEstimate.ts > ESTIMATE_STALE_MS) return false;
  return normAddr(lastEstimate.pickup) === normAddr(d.pickup_address) &&
         normAddr(lastEstimate.dropoff) === normAddr(d.dropoff_address);
}

/* =========================
   FAST ESTIMATE (cache + abort + inflight + stale-guard)
========================= */

let estimateTimer = null;
let estimateAbort = null;

const estimateCache = new Map();     // key -> { fare, approximate, reason, breakdown, distanceKm, pickupLabel, dropoffLabel, ts }
const inflightEstimates = new Map(); // key -> Promise<payload>
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min

let estimateSeq = 0;

function normalizeAddress(s) {
  return String(s || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function cacheKey(pickup, dropoff) {
  return `${normalizeAddress(pickup)}||${normalizeAddress(dropoff)}`;
}

function getCachedEstimate(pickup, dropoff) {
  const k = cacheKey(pickup, dropoff);
  const v = estimateCache.get(k);
  if (!v) return null;
  if (Date.now() - v.ts > CACHE_TTL_MS) {
    estimateCache.delete(k);
    return null;
  }
  return v;
}

function setCachedEstimate(pickup, dropoff, payload) {
  estimateCache.set(cacheKey(pickup, dropoff), { ...payload, ts: Date.now() });
}

// Returns payload:
// { fare, approximate, reason, breakdown, distanceKm, pickupLabel, dropoffLabel }
async function fetchEstimate(d) {
  const pickup = d.pickup_address.trim();
  const dropoff = d.dropoff_address.trim();

  if (!pickup || !dropoff) {
    return {
      fare: roughEstimate(pickup, dropoff),
      approximate: true,
      reason: "missing_addresses",
      breakdown: { mode: "client_missing_addresses" },
      distanceKm: null,
      pickupLabel: pickup,
      dropoffLabel: dropoff
    };
  }

  const k = cacheKey(pickup, dropoff);

  const cached = getCachedEstimate(pickup, dropoff);
  if (cached && cached.fare != null) return cached;

  if (inflightEstimates.has(k)) return inflightEstimates.get(k);

  // Abort previous request
  if (estimateAbort) estimateAbort.abort();
  estimateAbort = new AbortController();

  // Client timeout (UX)
  const CLIENT_TIMEOUT_MS = Number(CFG.ESTIMATE_CLIENT_TIMEOUT_MS || 4000);
  const timeoutId = setTimeout(() => {
    try { estimateAbort.abort(); } catch (_) {}
  }, CLIENT_TIMEOUT_MS);

  const body = {
    pickup_text: pickup,
    dropoff_text: dropoff,
    pickup_datetime: d.pickup_datetime || null
  };

  const p = (async () => {
    try {
      const data = await apiJson(`${API_BASE}/api/estimate`, "POST", body, { signal: estimateAbort.signal });

      const fareNum = Number(data.price);
      const fare = Number.isFinite(fareNum) ? fareNum : roughEstimate(pickup, dropoff);

      const approximate = !!data.approximate || !Number.isFinite(fareNum);
      const reason = data.reason || (approximate ? "approximate" : null);
      const breakdown = data.breakdown || null;

      const distanceKm = Number.isFinite(Number(data.distance)) ? Number(data.distance) : null;

      const pickupLabel = data.pickup || pickup;
      const dropoffLabel = data.dropoff || dropoff;

      const payload = {
        fare,
        approximate,
        reason,
        breakdown,
        distanceKm,
        pickupLabel,
        dropoffLabel
      };

      setCachedEstimate(pickup, dropoff, payload);
      return payload;
    } finally {
      clearTimeout(timeoutId);
    }
  })();

  inflightEstimates.set(k, p);

  try {
    return await p;
  } finally {
    inflightEstimates.delete(k);
  }
}

/* =========================
   BOOKINGS / PAYMENTS
========================= */

async function createBooking(d) {
  const pickup = d.pickup_address.trim();
  const dropoff = d.dropoff_address.trim();

  const attachEstimate = isLastEstimateUsableFor(d) ? lastEstimate : null;

  const payload = {
    ...d,
    pickup_text: pickup,
    dropoff_text: dropoff,
    pickup_address: pickup,
    dropoff_address: dropoff,

    // ✅ snapshot estimate (best effort)
    estimated_price: attachEstimate ? attachEstimate.fare : null,
    estimated_distance_km: attachEstimate ? attachEstimate.distanceKm : null,
    estimated_pickup_label: attachEstimate ? attachEstimate.pickupLabel : null,
    estimated_dropoff_label: attachEstimate ? attachEstimate.dropoffLabel : null,
    estimated_approximate: attachEstimate ? !!attachEstimate.approximate : null,
    estimated_at: attachEstimate ? attachEstimate.ts : null
  };

  return apiJson(`${API_BASE}/api/bookings/public`, "POST", payload);
}

async function createDepositSession(bookingId, publicToken) {
  return apiJson(`${API_BASE}/api/payments/deposit-session`, "POST", { booking_id: bookingId, public_token: publicToken });
}

/* =========================
   DATE DEFAULT
========================= */

function initDateDefault() {
  const el = $("pickup_datetime");
  if (!el) return;

  const now = new Date(Date.now() + 30 * 60 * 1000);
  const pad = (x) => String(x).padStart(2, "0");

  el.value =
    now.getFullYear() +
    "-" + pad(now.getMonth() + 1) +
    "-" + pad(now.getDate()) +
    "T" + pad(now.getHours()) +
    ":" + pad(now.getMinutes());
}

/* =========================
   ESTIMATE UI
========================= */

let isEstimating = false;

function scheduleEstimate(forceFast = false) {
  clearTimeout(estimateTimer);
  estimateTimer = setTimeout(recomputeEstimate, forceFast ? 80 : 500);
}

function setEstimateHintByMode(approximate, reason) {
  if (approximate) {
    const extra = reason ? ` (${reason})` : "";
    setText("estimateHint", `Estimation rapide (approx.). Le prix final peut varier.${extra}`);
  } else {
    setText("estimateHint", "Estimation indicative (itinéraire calculé). Le prix final peut varier.");
  }
}

function setPayDisabled(disabled, text) {
  const btn = $("btnPay");
  if (!btn) return;
  btn.disabled = !!disabled;
  if (text) btn.textContent = text;
}

async function recomputeEstimate() {
  const mySeq = ++estimateSeq;
  const d = getFormData();

  if (!d.pickup_address || !d.dropoff_address) {
    lastEstimate = null;
    setSummary({ fareEur: null, depositEur: DEFAULT_DEPOSIT_EUR });
    setText("estimateHint", "Renseigne départ et arrivée pour calculer l’estimation.");
    return;
  }

  isEstimating = true;
  setPayDisabled(true, "Calcul…");
  setText("estimateHint", "Calcul de l’estimation…");

  try {
    const payload = await fetchEstimate(d);
    if (mySeq !== estimateSeq) return;

    // Save snapshot for booking (must match current addresses)
    lastEstimate = {
      pickup: d.pickup_address,
      dropoff: d.dropoff_address,
      fare: payload.fare,
      distanceKm: payload.distanceKm,
      pickupLabel: payload.pickupLabel,
      dropoffLabel: payload.dropoffLabel,
      approximate: payload.approximate,
      reason: payload.reason || null,
      breakdown: payload.breakdown || null,
      ts: Date.now()
    };

    if (CFG.DEBUG_ESTIMATE && payload.breakdown) {
      console.log("[estimate breakdown]", payload.breakdown);
    }

    setSummary({ fareEur: payload.fare, depositEur: DEFAULT_DEPOSIT_EUR });
    setEstimateHintByMode(payload.approximate, payload.reason);
  } catch (e) {
    if (mySeq !== estimateSeq) return;

    const fallback = roughEstimate(d.pickup_address, d.dropoff_address);

    // Abort/timeout => local fallback
    if (e?.name === "AbortError") {
      lastEstimate = {
        pickup: d.pickup_address,
        dropoff: d.dropoff_address,
        fare: fallback,
        distanceKm: null,
        pickupLabel: d.pickup_address,
        dropoffLabel: d.dropoff_address,
        approximate: true,
        reason: "client_timeout",
        breakdown: { mode: "client_timeout_fallback" },
        ts: Date.now()
      };
      setSummary({ fareEur: fallback, depositEur: DEFAULT_DEPOSIT_EUR });
      setEstimateHintByMode(true, "client_timeout");
      return;
    }

    if (isTooLongRouteError(e)) {
      lastEstimate = {
        pickup: d.pickup_address,
        dropoff: d.dropoff_address,
        fare: fallback,
        distanceKm: null,
        pickupLabel: d.pickup_address,
        dropoffLabel: d.dropoff_address,
        approximate: true,
        reason: "address_imprecise",
        breakdown: { mode: "address_imprecise_fallback" },
        ts: Date.now()
      };
      setSummary({ fareEur: fallback, depositEur: DEFAULT_DEPOSIT_EUR });
      setText("estimateHint", "Adresse trop imprécise. Sélectionne une suggestion Google (liste déroulante).");
      return;
    }

    lastEstimate = {
      pickup: d.pickup_address,
      dropoff: d.dropoff_address,
      fare: fallback,
      distanceKm: null,
      pickupLabel: d.pickup_address,
      dropoffLabel: d.dropoff_address,
      approximate: true,
      reason: "client_error",
      breakdown: { mode: "client_error_fallback", message: String(e?.message || "") },
      ts: Date.now()
    };

    setSummary({ fareEur: fallback, depositEur: DEFAULT_DEPOSIT_EUR });
    setEstimateHintByMode(true, "client_error");
  } finally {
    // ✅ Prevent older estimate calls from re-enabling the button during a newer estimate
    if (mySeq === estimateSeq) {
      isEstimating = false;
      setPayDisabled(false, "Payer l’acompte");
    }
  }
}

/* =========================
   GOOGLE PLACES (NEW ONLY)
========================= */

function attachPlaces() {
  if (!(window.google && google.maps && google.maps.places)) return false;

  const pickupInput = $("pickup_address");
  const dropoffInput = $("dropoff_address");
  if (!pickupInput || !dropoffInput) return true;

  if (!google.maps.places.PlaceAutocompleteElement) {
    setNotice("Autocomplete Google indisponible (v=beta requis).", "warn");
    return true;
  }

  const onChosen = () => scheduleEstimate(true);

  const wrap = (input, id) => {
    if (document.getElementById(id + "_gmp")) return;

    const el = document.createElement("gmp-place-autocomplete");
    el.setAttribute("placeholder", input.getAttribute("placeholder") || "");
    el.setAttribute("id", id + "_gmp");
    el.className = input.className;
    el.style.cssText = input.style.cssText;
    el.style.width = "100%";

    const hidden = input;
    hidden.type = "hidden";
    input.parentNode.insertBefore(el, hidden);

    const setHidden = (value) => {
      hidden.value = String(value || "").trim();
    };

    const onTyping = () => {
      const v = el.value || el.getAttribute("value") || "";
      setHidden(v);
      scheduleEstimate(false);
    };
    el.addEventListener("input", onTyping);
    el.addEventListener("change", onTyping);

    el.addEventListener("gmp-select", async (ev) => {
      try {
        const pred = ev?.placePrediction;
        if (!pred?.toPlace) return;
        const place = pred.toPlace();
        await place.fetchFields({ fields: ["formattedAddress"] });
        setHidden(place.formattedAddress || "");
        onChosen();
      } catch (_) {}
    });

    el.addEventListener("gmp-requesterror", () => {
      setNotice("Google Places bloqué (clé API / restrictions / billing).", "err");
    });
  };

  wrap(pickupInput, "pickup_address");
  wrap(dropoffInput, "dropoff_address");
  return true;
}

/* =========================
   INIT
========================= */

document.addEventListener("DOMContentLoaded", () => {
  setText("year", new Date().getFullYear());
  initDateDefault();
  setSummary({ fareEur: null, depositEur: DEFAULT_DEPOSIT_EUR });

  window.driveusGmapsReady = function () {
    attachPlaces();
  };

  if (window.__DRIVEUS_GMAPS_LOADED__) attachPlaces();

  const dt = $("pickup_datetime");
  if (dt) {
    dt.addEventListener("input", () => scheduleEstimate(false));
    dt.addEventListener("change", () => scheduleEstimate(false));
  }

  const btnEstimate = $("btnEstimate");
  if (btnEstimate) {
    btnEstimate.addEventListener("click", async () => {
      setNotice("");
      await recomputeEstimate();
      setNotice("Estimation recalculée.", "ok");
    });
  }

  const form = $("bookingForm");
  if (!form) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    setNotice("");

    if (isEstimating) {
      setNotice("Estimation en cours… réessaie dans une seconde.", "warn");
      return;
    }

    const btn = $("btnPay");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Préparation du paiement…";
    }

    try {
      const d = getFormData();
      const err = validate(d);
      if (err) throw new Error(err);

      // Ensure we have a fresh estimate snapshot before booking (best effort)
      if (!isLastEstimateUsableFor(d)) {
        await recomputeEstimate();
      }

      // If still not usable, block booking to avoid "client_price_only" surprises
      if (!isLastEstimateUsableFor(d)) {
        throw new Error("Impossible de calculer l’estimation. Réessaie (ou change les adresses).");
      }

      setNotice("Création de la réservation…", "warn");
      const booking = await createBooking(d);

      const bookingId = booking.id || booking.booking_id || booking.bookingId;
      const publicToken = booking.public_token || booking.publicToken || booking.public_token;
      if (!bookingId) throw new Error("Booking ID manquant (réponse API)");
      if (!publicToken) throw new Error("public_token manquant (réponse API)");

      try {
        localStorage.setItem("driveus_last_booking_id", bookingId);
        localStorage.setItem("driveus_last_public_token", publicToken);
      } catch (e) {}

      setNotice("Redirection vers Stripe…", "warn");
      const session = await createDepositSession(bookingId, publicToken);
      if (!session.url) throw new Error("URL Stripe manquante");

      track("begin_checkout", { currency: "EUR", value: DEFAULT_DEPOSIT_EUR });

      window.location.href = session.url;
    } catch (ex) {
      setNotice(ex.message || "Erreur", "err");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Payer l’acompte";
      }
    }
  });
});
