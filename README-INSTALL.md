# DriveUs Frontend Premium (Static)

## Fichiers inclus
- index.html (form réservation premium)
- assets/style.css (design premium)
- assets/app.js (Google Autocomplete + estimation auto + paiement + tracking)
- assets/config.js (à configurer)
- paiement/succes.html (conversion + recap)
- paiement/annule.html

## Configuration
Édite `assets/config.js` :

- API_BASE: https://api.driveus.fr
- GOOGLE_MAPS_API_KEY: ta clé Google (Places API)
  - Restreins la clé en "HTTP referrers" à:
    - https://driveus.fr/*
    - https://www.driveus.fr/*
- GA_MEASUREMENT_ID: ton GA4 (ex: G-XXXXXXXXXX)

## Backend requis
- POST /api/bookings/public
- POST /api/payments/deposit-session
- POST /api/estimate (recommandé). Si absent, fallback estimation simple.

⚠️ CORS backend:
CORS_ORIGIN=https://driveus.fr,https://www.driveus.fr
FRONTEND_URL=https://www.driveus.fr (si tu testes sur www)

## Stripe success/cancel
Ton backend doit utiliser:
- /paiement/succes.html
- /paiement/annule.html

## Déploiement
Static site Render:
- Publish Directory: .
