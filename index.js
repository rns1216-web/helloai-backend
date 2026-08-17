// LinkLyfe drop-in replacement
// Route Planner routing repair v3: normal-mode region inference + user-order preservation support.
// Phase 2 Firebase ID-token authentication remains unchanged.
// index.js — HelloAI Backend (Full Working Version + Agent Smith + Evidence Search via SerpApi DuckDuckGo)

const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { OpenAI } = require("openai");
const { initializeApp, applicationDefault, cert, getApps } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

// Load .env variables
dotenv.config();

// --------------------------------------------------
// FIREBASE ADMIN AUTHENTICATION (PHASE 2)
// --------------------------------------------------
// Preferred on Render: store the service-account JSON only in the protected
// FIREBASE_SERVICE_ACCOUNT_JSON environment variable. Never commit it to GitHub.
// GOOGLE_APPLICATION_CREDENTIALS remains supported for deployments that use a
// protected service-account file / Application Default Credentials instead.
function initializeLinklyfeFirebaseAdmin() {
  if (getApps().length > 0) return getApps()[0];

  const serviceAccountJson = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim();
  if (serviceAccountJson) {
    const serviceAccount = JSON.parse(serviceAccountJson);
    return initializeApp({
      credential: cert(serviceAccount),
      projectId: serviceAccount.project_id
    });
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return initializeApp({
      credential: applicationDefault(),
      projectId: process.env.FIREBASE_PROJECT_ID || undefined
    });
  }

  throw new Error("Firebase Admin credentials are not configured.");
}

try {
  initializeLinklyfeFirebaseAdmin();
} catch (_) {
  console.error(
    "❌ Firebase Admin initialization failed. Configure FIREBASE_SERVICE_ACCOUNT_JSON " +
    "or GOOGLE_APPLICATION_CREDENTIALS before starting the backend."
  );
  process.exit(1);
}

// Ensure OpenAI key exists
if (!process.env.OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY in .env");
  process.exit(1);
}

// SerpApi (DuckDuckGo) key for Evidence Search
const SERPAPI_API_KEY = process.env.SERPAPI_API_KEY;
const HERE_API_KEY = process.env.HERE_API_KEY || "";
const routeGeocodeCache = new Map();

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

function bearerTokenFromRequest(req) {
  const authorization = typeof req.headers.authorization === "string"
    ? req.headers.authorization.trim()
    : "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

async function requireFirebaseIdToken(req, res, next) {
  const idToken = bearerTokenFromRequest(req);
  if (!idToken) {
    return res.status(401).json({
      error: true,
      message: "Authentication required."
    });
  }

  try {
    const decodedToken = await getAuth().verifyIdToken(idToken);
    req.linklyfeAuth = {
      uid: decodedToken.uid,
      provider: decodedToken.firebase?.sign_in_provider || "unknown",
      isAnonymous: decodedToken.firebase?.sign_in_provider === "anonymous"
    };
    return next();
  } catch (_) {
    return res.status(401).json({
      error: true,
      message: "Authentication required."
    });
  }
}

// --------------------------------------------------
// HELPERS (Evidence Search)
// --------------------------------------------------

function safeString(x) {
  return typeof x === "string" ? x : "";
}

function extractDomain(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function decodeHtmlEntities(str) {
  return safeString(str)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function stripTags(str) {
  return safeString(str).replace(/<[^>]*>/g, "").trim();
}

function normalizePlaceQuery(text) {
  return safeString(text).replace(/\s+/g, " ").trim();
}

function normalizeComparableText(text) {
  return normalizePlaceQuery(text)
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeComparableText(text) {
  return normalizeComparableText(text)
    .split(" ")
    .map((x) => x.trim())
    .filter(Boolean);
}

function buildHereDisplayNames(item) {
  const title = safeString(item?.title).trim() || safeString(item?.address?.label).trim() || "Unknown place";
  const address = item?.address || {};
  const city = safeString(address.city || address.county || address.district).trim();
  const state = safeString(address.stateCode || address.state).trim();
  const country = safeString(address.countryCode || address.countryName).trim();
  const suffix = [city, state || country].filter(Boolean).join(", ");
  return {
    shortName: title,
    displayName: suffix ? `${title} — ${suffix}` : title
  };
}

function canonicalRouteDisplayName(rawQuery, anchor) {
  const q = normalizeComparableText(rawQuery);
  const anchorCity = normalizeComparableText(anchor?.city || "");
  const isChicago = anchorCity === "chicago";

  if (isChicago) {
    const canon = {
      "millennium park": "Millennium Park",
      "park millennium": "Millennium Park",
      "art institute": "Art Institute of Chicago",
      "art institute of chicago": "Art Institute of Chicago",
      "the bean": "Cloud Gate (The Bean)",
      "cloud gate": "Cloud Gate (The Bean)",
      "shedd aquarium": "Shedd Aquarium",
      "aquarium": "Shedd Aquarium",
      "john g shedd aquarium": "Shedd Aquarium",
      "lincoln park zoo": "Lincoln Park Zoo",
      "lincoln park": "Lincoln Park Zoo",
      "chicago riverwalk": "Chicago Riverwalk",
      "riverwalk": "Chicago Riverwalk",
      "wicker park": "Wicker Park",
      "portillos": "Portillo's",
      "portillos chicago": "Portillo's",
      "portillo s": "Portillo's",
      "portillo's": "Portillo's"
    };
    if (canon[q]) return canon[q];
  }

  return "";
}

function getHereAddressBits(item) {
  const address = item?.address || {};
  return {
    city: safeString(address.city || address.county || address.district).trim(),
    stateCode: safeString(address.stateCode).trim(),
    state: safeString(address.state).trim(),
    countryCode: safeString(address.countryCode).trim(),
    countryName: safeString(address.countryName).trim()
  };
}

function haversineMiles(lat1, lng1, lat2, lng2) {
  if (
    typeof lat1 !== "number" ||
    typeof lng1 !== "number" ||
    typeof lat2 !== "number" ||
    typeof lng2 !== "number"
  ) {
    return null;
  }
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 3958.7613;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function inferAnchorContext(start, end) {
  const a = start?.resolved ? start : null;
  const b = end?.resolved ? end : null;
  if (!a && !b) return null;

  const sameCountry =
    a && b &&
    a.countryCode &&
    b.countryCode &&
    normalizeComparableText(a.countryCode) === normalizeComparableText(b.countryCode);

  const sameState =
    a && b &&
    sameCountry &&
    (
      (a.stateCode && b.stateCode && normalizeComparableText(a.stateCode) === normalizeComparableText(b.stateCode)) ||
      (a.state && b.state && normalizeComparableText(a.state) === normalizeComparableText(b.state))
    );

  const sameCity =
    a && b &&
    sameCountry &&
    a.city &&
    b.city &&
    normalizeComparableText(a.city) === normalizeComparableText(b.city);

  const primary = a || b;
  const secondary = b || a;

  return {
    city: (sameCity && (a?.city || b?.city)) || primary?.city || secondary?.city || "",
    stateCode: (sameState && (a?.stateCode || b?.stateCode)) || primary?.stateCode || secondary?.stateCode || "",
    state: (sameState && (a?.state || b?.state)) || primary?.state || secondary?.state || "",
    countryCode: primary?.countryCode || secondary?.countryCode || "",
    countryName: primary?.countryName || secondary?.countryName || "",
    lat: primary?.lat,
    lng: primary?.lng
  };
}

function applyRouteAlias(rawQuery, anchor) {
  const q = normalizePlaceQuery(rawQuery);
  const lower = normalizeComparableText(q);
  const anchorCity = normalizeComparableText(anchor?.city || "");
  const isChicago = anchorCity === "chicago";

  const exactMap = {
    "art institute": isChicago ? "Art Institute of Chicago" : q,
    "the bean": isChicago ? "Cloud Gate" : q,
    "union station east door": isChicago ? "Chicago Union Station East Entrance" : q,
    "union station-east door": isChicago ? "Chicago Union Station East Entrance" : q,
    "riverwalk": isChicago ? "Chicago Riverwalk" : q,
    "chicago riverwalk": "Chicago Riverwalk"
  };

  if (exactMap[lower]) return exactMap[lower];

  if (isChicago) {
    if (lower in {"aquarium": 1, "shedd": 1, "shedd aquarium": 1}) return "Shedd Aquarium";
    if (lower in {"lincoln park": 1}) return "Lincoln Park Chicago";
    if (lower in {"portillos": 1, "portillos chicago": 1, "portillo's": 1, "portillos restaurant": 1}) return "Portillo's Chicago";
  }

  return q;
}

function buildQueryVariants(rawQuery, anchor) {
  const base = applyRouteAlias(rawQuery, anchor);
  const variants = [];
  const pushVariant = (x) => {
    const v = normalizePlaceQuery(x);
    if (!v) return;
    if (!variants.some((existing) => normalizeComparableText(existing) === normalizeComparableText(v))) {
      variants.push(v);
    }
  };

  pushVariant(rawQuery);
  pushVariant(base);

  if (anchor?.city) {
    if (anchor?.stateCode) {
      pushVariant(`${base}, ${anchor.city}, ${anchor.stateCode}`);
    }
    if (anchor?.state) {
      pushVariant(`${base}, ${anchor.city}, ${anchor.state}`);
    }
    pushVariant(`${base}, ${anchor.city}`);
  }

  if (anchor?.countryCode) {
    pushVariant(`${base}, ${anchor.countryCode}`);
  }

  return variants.slice(0, 5);
}

async function fetchHereGeocodeCandidates(query, limit = 5) {
  if (!HERE_API_KEY) {
    throw new Error("Missing HERE_API_KEY in environment.");
  }
  const url =
    `https://geocode.search.hereapi.com/v1/geocode?q=${encodeURIComponent(query)}` +
    `&limit=${encodeURIComponent(String(limit))}` +
    `&apiKey=${encodeURIComponent(HERE_API_KEY)}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HERE geocode failed with status ${response.status}`);
  }
  const data = await response.json();
  return Array.isArray(data.items) ? data.items : [];
}

function scoreHereCandidate(item, rawQuery, queryVariant, anchor) {
  const names = buildHereDisplayNames(item);
  const bits = getHereAddressBits(item);
  const titleNorm = normalizeComparableText(names.shortName);
  const rawNorm = normalizeComparableText(rawQuery);
  const queryNorm = normalizeComparableText(queryVariant);

  const titleTokens = new Set(tokenizeComparableText(names.shortName));
  const rawTokens = tokenizeComparableText(rawQuery).filter((t) => t.length > 1);
  const queryTokens = tokenizeComparableText(queryVariant).filter((t) => t.length > 1);

  let score = 0;

  if (titleNorm === rawNorm) score += 140;
  if (titleNorm === queryNorm) score += 90;
  if (titleNorm.includes(rawNorm) && rawNorm) score += 50;
  if (titleNorm.includes(queryNorm) && queryNorm) score += 35;

  for (const token of rawTokens) {
    if (titleTokens.has(token)) score += 16;
  }
  for (const token of queryTokens) {
    if (titleTokens.has(token)) score += 8;
  }

  if (anchor) {
    if (anchor.countryCode) {
      if (normalizeComparableText(bits.countryCode) === normalizeComparableText(anchor.countryCode)) score += 120;
      else score -= 260;
    }

    const stateMatch =
      (anchor.stateCode && bits.stateCode && normalizeComparableText(bits.stateCode) === normalizeComparableText(anchor.stateCode)) ||
      (anchor.state && bits.state && normalizeComparableText(bits.state) === normalizeComparableText(anchor.state));

    if (stateMatch) score += 80;

    if (anchor.city) {
      const cityMatch = bits.city && normalizeComparableText(bits.city) === normalizeComparableText(anchor.city);
      if (cityMatch) score += 170;
      else score -= 25;
    }

    const distanceMi = haversineMiles(anchor.lat, anchor.lng, item?.position?.lat, item?.position?.lng);
    if (typeof distanceMi === "number") {
      if (distanceMi <= 2) score += 120;
      else if (distanceMi <= 5) score += 100;
      else if (distanceMi <= 15) score += 70;
      else if (distanceMi <= 30) score += 40;
      else if (distanceMi <= 100) score += 10;
      else if (distanceMi > 3000) score -= 300;
      else if (distanceMi > 1000) score -= 200;
      else if (distanceMi > 250) score -= 80;
    }
  }

  return score;
}

async function geocodeSingleWithHere(rawQuery, options = {}) {
  const query = normalizePlaceQuery(rawQuery);
  const anchor = options?.anchor || null;
  const maxAnchorDistanceMi =
    typeof options?.maxAnchorDistanceMi === "number" && Number.isFinite(options.maxAnchorDistanceMi)
      ? Math.max(1, options.maxAnchorDistanceMi)
      : null;
  if (!query) {
    return {
      query: safeString(rawQuery),
      shortName: safeString(rawQuery),
      displayName: safeString(rawQuery),
      lat: null,
      lng: null,
      city: "",
      stateCode: "",
      state: "",
      countryCode: "",
      countryName: "",
      resolved: false
    };
  }

  const cacheKey = JSON.stringify({
    q: query.toLowerCase(),
    city: normalizeComparableText(anchor?.city || ""),
    state: normalizeComparableText(anchor?.stateCode || anchor?.state || ""),
    country: normalizeComparableText(anchor?.countryCode || ""),
    maxAnchorDistanceMi: maxAnchorDistanceMi || 0
  });
  if (routeGeocodeCache.has(cacheKey)) return routeGeocodeCache.get(cacheKey);

  const variants = buildQueryVariants(query, anchor);
  let bestItem = null;
  let bestScore = -Infinity;

  for (const variant of variants) {
    const items = await fetchHereGeocodeCandidates(variant, anchor ? 5 : 3);
    for (const item of items) {
      if (typeof item?.position?.lat !== "number" || typeof item?.position?.lng !== "number") continue;
      const score = scoreHereCandidate(item, query, variant, anchor);
      if (score > bestScore) {
        bestScore = score;
        bestItem = item;
      }
    }
  }

  if (!bestItem) {
    const unresolved = {
      query,
      shortName: query,
      displayName: query,
      lat: null,
      lng: null,
      city: "",
      stateCode: "",
      state: "",
      countryCode: "",
      countryName: "",
      resolved: false
    };
    routeGeocodeCache.set(cacheKey, unresolved);
    return unresolved;
  }

  const names = buildHereDisplayNames(bestItem);
  const bits = getHereAddressBits(bestItem);
  const distanceFromAnchorMi = anchor
    ? haversineMiles(anchor.lat, anchor.lng, bestItem.position.lat, bestItem.position.lng)
    : null;

  const mismatchedCountry =
    anchor?.countryCode &&
    bits.countryCode &&
    normalizeComparableText(anchor.countryCode) !== normalizeComparableText(bits.countryCode);

  const obviouslyFar =
    anchor &&
    typeof distanceFromAnchorMi === "number" &&
    distanceFromAnchorMi > 500 &&
    !(bits.city && anchor.city && normalizeComparableText(bits.city) === normalizeComparableText(anchor.city));

  const outsideProbeRadius =
    anchor &&
    maxAnchorDistanceMi !== null &&
    typeof distanceFromAnchorMi === "number" &&
    distanceFromAnchorMi > maxAnchorDistanceMi;

  if (outsideProbeRadius || (mismatchedCountry && obviouslyFar) || bestScore < 25) {
    const unresolved = {
      query,
      shortName: query,
      displayName: query,
      lat: null,
      lng: null,
      city: "",
      stateCode: "",
      state: "",
      countryCode: "",
      countryName: "",
      resolved: false
    };
    routeGeocodeCache.set(cacheKey, unresolved);
    return unresolved;
  }

  const canonicalName = canonicalRouteDisplayName(rawQuery, anchor);
  const finalShortName = canonicalName || names.shortName;
  const finalDisplayName = canonicalName
    ? ((bits.city || bits.stateCode || bits.countryCode)
        ? `${finalShortName} — ${[bits.city, bits.stateCode || bits.countryCode].filter(Boolean).join(", ")}`
        : finalShortName)
    : names.displayName;

  const resolved = {
    query,
    shortName: finalShortName,
    displayName: finalDisplayName,
    lat: bestItem.position.lat,
    lng: bestItem.position.lng,
    city: bits.city,
    stateCode: bits.stateCode,
    state: bits.state,
    countryCode: bits.countryCode,
    countryName: bits.countryName,
    resolved: true
  };
  routeGeocodeCache.set(cacheKey, resolved);
  return resolved;
}


function routeAnchorFromPoint(point) {
  return point?.resolved ? inferAnchorContext(point, point) : null;
}

function routeAnchorKey(anchor) {
  if (!anchor) return "";
  return [
    normalizeComparableText(anchor.city || ""),
    normalizeComparableText(anchor.stateCode || anchor.state || ""),
    normalizeComparableText(anchor.countryCode || anchor.countryName || ""),
    typeof anchor.lat === "number" ? anchor.lat.toFixed(2) : "",
    typeof anchor.lng === "number" ? anchor.lng.toFixed(2) : ""
  ].join("|");
}

function routeQueryTokenCount(query) {
  return tokenizeComparableText(query).filter((token) => token.length >= 3).length;
}

function routeSeedQueries(startText, endText, stops) {
  const raw = [
    safeString(startText).trim(),
    safeString(endText).trim(),
    ...stops
  ].filter(Boolean);

  const distinct = [];
  for (const query of raw) {
    const normalized = normalizeComparableText(query);
    if (!normalized) continue;
    if (!distinct.some((existing) => normalizeComparableText(existing) === normalized)) {
      distinct.push(query);
    }
  }

  // Long/distinctive place names are usually safer regional seeds than short generic labels.
  return distinct
    .map((query, index) => ({ query, index, tokens: routeQueryTokenCount(query) }))
    .sort((a, b) => (b.tokens - a.tokens) || (a.index - b.index))
    .slice(0, 6)
    .map((item) => item.query);
}

function routeProbeQueries(startText, endText, stops) {
  const seeds = routeSeedQueries(startText, endText, stops);
  const endpoints = [safeString(startText).trim(), safeString(endText).trim()].filter(Boolean);
  const combined = [...endpoints, ...seeds];

  const distinct = [];
  for (const query of combined) {
    const normalized = normalizeComparableText(query);
    if (!normalized) continue;
    if (!distinct.some((existing) => normalizeComparableText(existing) === normalized)) {
      distinct.push(query);
    }
  }
  return distinct.slice(0, 5);
}

function routeAnchorLexicalSupport(anchor, allRouteText) {
  if (!anchor) return 0;
  const routeTokens = tokenizeComparableText(allRouteText).filter((token) => token.length >= 4);
  if (!routeTokens.length) return 0;

  const anchorTokens = new Set(
    tokenizeComparableText(
      [
        anchor.city || "",
        anchor.stateCode || "",
        anchor.state || "",
        anchor.countryCode || "",
        anchor.countryName || ""
      ].join(" ")
    ).filter((token) => token.length >= 3)
  );

  let support = 0;
  for (const token of routeTokens) {
    if (anchorTokens.has(token)) support += 1;
  }
  return Math.min(8, support);
}

async function inferRouteRegionAnchor(startText, endText, stops) {
  const seedQueries = routeSeedQueries(startText, endText, stops);
  if (!seedQueries.length) return null;

  const seedResults = [];
  for (const query of seedQueries) {
    const point = await geocodeSingleWithHere(query);
    const anchor = routeAnchorFromPoint(point);
    if (anchor) seedResults.push({ query, point, anchor });
  }
  if (!seedResults.length) return null;

  const dedupedSeeds = [];
  const seen = new Set();
  for (const seed of seedResults) {
    const key = routeAnchorKey(seed.anchor);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    dedupedSeeds.push(seed);
  }

  const allRouteText = [startText, endText, ...stops].join(" ");
  const probeQueries = routeProbeQueries(startText, endText, stops);
  let best = null;

  // Keep this bounded: at most four candidate regions and five probe queries.
  for (const seed of dedupedSeeds.slice(0, 4)) {
    let score = routeAnchorLexicalSupport(seed.anchor, allRouteText);
    let resolvedProbeCount = 0;
    let nonSelfResolvedCount = 0;

    for (const probeQuery of probeQueries) {
      const probe = await geocodeSingleWithHere(probeQuery, {
        anchor: seed.anchor,
        maxAnchorDistanceMi: 175
      });

      if (!probe?.resolved) {
        score -= 1;
        continue;
      }

      resolvedProbeCount += 1;
      const isSelf =
        normalizeComparableText(probeQuery) === normalizeComparableText(seed.query);

      if (isSelf) {
        score += 1;
      } else {
        nonSelfResolvedCount += 1;
        score += 4;
      }

      const distanceMi = haversineMiles(
        seed.anchor.lat,
        seed.anchor.lng,
        probe.lat,
        probe.lng
      );
      if (typeof distanceMi === "number") {
        if (distanceMi <= 25) score += 2;
        else if (distanceMi <= 75) score += 1;
      }
    }

    const candidate = {
      anchor: seed.anchor,
      score,
      resolvedProbeCount,
      nonSelfResolvedCount
    };

    if (
      !best ||
      candidate.score > best.score ||
      (candidate.score === best.score && candidate.nonSelfResolvedCount > best.nonSelfResolvedCount) ||
      (
        candidate.score === best.score &&
        candidate.nonSelfResolvedCount === best.nonSelfResolvedCount &&
        candidate.resolvedProbeCount > best.resolvedProbeCount
      )
    ) {
      best = candidate;
    }
  }

  // Require support from at least one OTHER route input. A seed that only resolves itself
  // is not enough evidence to force the entire route into that city/state.
  if (!best || best.nonSelfResolvedCount < 1 || best.score < 4) return null;
  return best.anchor;
}

// Very simple credibility heuristic (Phase 3b-ready; replace later)
function credibilityScoreFor(url, source) {
  const d = (extractDomain(url) || "").toLowerCase();
  const s = (safeString(source) || "").toLowerCase();

  const high = [
    "reuters.com",
    "apnews.com",
    "bbc.co.uk",
    "bbc.com",
    "ft.com",
    "wsj.com",
    "economist.com",
    "investopedia.com",
    "sec.gov",
    "federalreserve.gov",
    "bls.gov",
    "whitehouse.gov",
    "cdc.gov",
    "nih.gov",
    "who.int",
    "oecd.org",
    "worldbank.org",
    "imf.org",
    "nber.org",
    "nature.com",
    "science.org"
  ];

  const mid = [
    "wikipedia.org",
    "nerdwallet.com",
    "bankrate.com",
    "morningstar.com",
    "khanacademy.org"
  ];

  if (high.includes(d)) return 86;
  if (mid.includes(d)) return 78;
  if (d) return 72;
  return 60;
}

// --------------------------------------------------
// HEALTH CHECK
// --------------------------------------------------
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "HelloAI backend is running 🚀" });
});

// --------------------------------------------------
// HERE GEOCODE BATCH ENDPOINT (DISTANCE ROUTE PLANNER)
// Expects: { startText: string, endText: string, stopTexts: string[] }
// Returns: resolved names + lat/lng for Haversine distance math on the client
// --------------------------------------------------
app.post("/geocode_batch", requireFirebaseIdToken, async (req, res) => {
  try {
    const { startText, endText, stopTexts } = req.body || {};
    if (!HERE_API_KEY) {
      return res.status(500).json({ error: "Missing HERE_API_KEY in environment." });
    }

    const stops = Array.isArray(stopTexts)
      ? stopTexts.map((x) => normalizePlaceQuery(x)).filter(Boolean)
      : [];

    if (!safeString(startText).trim() || !safeString(endText).trim() || !stops.length) {
      return res.status(400).json({ error: "startText, endText, and stopTexts[] are required." });
    }

    // NORMAL MODE FIRST:
    // Infer one trustworthy regional anchor from the route inputs themselves.
    // This prevents generic names such as "Clifton Hill" or "Hornblower" from
    // silently resolving to unrelated places in other states/countries.
    const inferredAnchor = await inferRouteRegionAnchor(startText, endText, stops);

    const [start, end] = await Promise.all([
      geocodeSingleWithHere(startText, { anchor: inferredAnchor }),
      geocodeSingleWithHere(endText, { anchor: inferredAnchor })
    ]);

    const endpointAnchor = inferAnchorContext(start, end);
    const anchor = inferredAnchor || endpointAnchor;

    const resolvedStops = [];
    for (const stop of stops) {
      // Preserve the user's list order exactly.
      resolvedStops.push(await geocodeSingleWithHere(stop, { anchor }));
    }

    return res.json({
      provider: "here",
      routeContext: anchor
        ? {
            city: anchor.city || "",
            stateCode: anchor.stateCode || "",
            state: anchor.state || "",
            countryCode: anchor.countryCode || "",
            countryName: anchor.countryName || ""
          }
        : null,
      start,
      end,
      stops: resolvedStops
    });
  } catch (err) {
    console.error("❌ /geocode_batch failed:", err);
    return res.status(500).json({ error: "Geocode batch failed", details: err.message });
  }
});

// --------------------------------------------------
// MINI-BRAIN GENERATE ENDPOINT (MAIN ENDPOINT)
// --------------------------------------------------
app.post("/generate", requireFirebaseIdToken, async (req, res) => {
  try {
    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: "Missing 'prompt' in request body." });
    }

    console.log("📩 Incoming prompt:", prompt.substring(0, 200) + "...");

    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: "You are Hello AI's smart assistant engine." },
        { role: "user", content: prompt }
      ]
    });

    const output = completion.choices?.[0]?.message?.content || "";
    console.log("📤 Output length:", output.length);

    return res.json({ result: output });
  } catch (err) {
    console.error("❌ /generate failed:", err);
    return res.status(500).json({ error: "AI generation failed", details: err.message });
  }
});

// --------------------------------------------------
// AGENT SMITH ENDPOINT (NEW)
// Expects: { prompt: string }
// Returns: strict JSON matching AgentSmithScreen parser
// --------------------------------------------------
app.post("/agent_smith", requireFirebaseIdToken, async (req, res) => {
  try {
    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({
        error: true,
        message: "Missing 'prompt' in request body."
      });
    }

    console.log("🕵️ /agent_smith prompt head:", prompt.substring(0, 200) + "...");

    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: "Return ONLY valid JSON. No markdown. No extra text." },
        { role: "user", content: prompt }
      ]
    });

    const raw = completion.choices?.[0]?.message?.content || "";
    console.log("🧾 /agent_smith raw length:", raw.length);

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      parsed = {
        answer: [raw || "Model returned empty output."],
        evidence: [],
        assumptionsAndUnknowns: ["Model did not return valid JSON."],
        warnings: ["Schema violation: non-JSON response."],
        confidence: 40,
        stoplight: "YELLOW",
        violationTags: ["SchemaViolation"],
        attemptsUsed: 1
      };
    }

    if (!Array.isArray(parsed.answer)) parsed.answer = [String(parsed.answer || "No answer.")];
    if (!Array.isArray(parsed.evidence)) parsed.evidence = [];
    if (!Array.isArray(parsed.assumptionsAndUnknowns)) parsed.assumptionsAndUnknowns = [];
    if (!Array.isArray(parsed.warnings)) parsed.warnings = [];
    if (typeof parsed.confidence !== "number") parsed.confidence = 60;
    if (!parsed.stoplight) parsed.stoplight = "YELLOW";
    if (!Array.isArray(parsed.violationTags)) parsed.violationTags = [];
    if (typeof parsed.attemptsUsed !== "number") parsed.attemptsUsed = 1;

    parsed.evidence = (parsed.evidence || [])
      .filter(Boolean)
      .map((ev) => {
        const title = typeof ev.title === "string" ? ev.title.trim() : "";
        const source = typeof ev.source === "string" ? ev.source.trim() : "";
        const date = typeof ev.date === "string" ? ev.date.trim() : "";
        const url = typeof ev.url === "string" ? ev.url.trim() : "";

        const snippet =
          typeof ev.snippet === "string" && ev.snippet.trim().length ? ev.snippet.trim() : undefined;

        const credibilityScoreRaw = ev.credibilityScore;
        const credibilityScore =
          typeof credibilityScoreRaw === "number" && Number.isFinite(credibilityScoreRaw)
            ? Math.max(0, Math.min(100, Math.round(credibilityScoreRaw)))
            : undefined;

        const out = {
          title,
          source: source || undefined,
          date: date || undefined,
          url: url || undefined
        };

        if (snippet !== undefined) out.snippet = snippet;
        if (credibilityScore !== undefined) out.credibilityScore = credibilityScore;

        return out;
      })
      .filter((ev) => ev.title && ev.title.length);

    const s = String(parsed.stoplight).toUpperCase();
    parsed.stoplight = s === "GREEN" || s === "RED" ? s : "YELLOW";

    return res.json(parsed);
  } catch (err) {
    console.error("❌ /agent_smith failed:", err);
    return res.status(500).json({
      error: true,
      message: "Agent Smith generation failed",
      details: err.message
    });
  }
});

// --------------------------------------------------
// EVIDENCE SEARCH ENDPOINT (SerpApi DuckDuckGo)
// Expects: { query: string }
// Returns: { results: EvidenceItem[] }
// --------------------------------------------------
app.post("/evidence_search", requireFirebaseIdToken, async (req, res) => {
  try {
    const { query } = req.body;

    if (!query || typeof query !== "string") {
      return res.status(400).json({
        error: true,
        message: "Missing 'query' in request body."
      });
    }

    const q = query.trim();
    console.log("🔎 /evidence_search query:", q);
    console.log("   SerpApi key present?", !!SERPAPI_API_KEY);

    if (!SERPAPI_API_KEY) {
      return res.status(500).json({
        error: true,
        message: "Missing SERPAPI_API_KEY in environment (.env / Render).",
        results: []
      });
    }

    const url = new URL("https://serpapi.com/search.json");
    url.searchParams.set("engine", "duckduckgo");
    url.searchParams.set("q", q);
    url.searchParams.set("api_key", SERPAPI_API_KEY);
    url.searchParams.set("no_cache", "true"); // helpful during dev

    const resp = await fetch(url, { method: "GET" });

    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => "");
      console.error("❌ SerpApi fetch failed:", resp.status, resp.statusText, bodyText);
      return res.status(500).json({
        error: true,
        message: "Evidence search failed (SerpApi error).",
        details: `${resp.status} ${resp.statusText}`,
        results: []
      });
    }

    const data = await resp.json();

    const organic = Array.isArray(data.organic_results) ? data.organic_results : [];
    let results = organic.slice(0, 3).map((item) => {
      const title = safeString(item.title);
      const link = safeString(item.link || item.url); // some engines vary
      const snippet = safeString(item.snippet);

      const domain = extractDomain(link);
      const source = domain || null;

      // ✅ Step 1: Pass through favicon when SerpApi provides it
      const favicon = safeString(item.favicon || item.favicon_url || item.faviconUrl);

      return {
        title: title || link || "Untitled",
        source,
        date: null,
        url: link || null,
        snippet: snippet || "No snippet available.",
        credibilityScore: credibilityScoreFor(link, source),
        favicon: favicon || null
      };
    });

    // If empty, at least return a direct DDG search link
    if (!results.length) {
      results.push({
        title: `View DuckDuckGo results for: ${q}`,
        source: "duckduckgo.com",
        date: null,
        url: `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
        snippet: "Open the full DuckDuckGo results page for this question in your browser.",
        credibilityScore: 78,
        favicon: null
      });
    }

    console.log("✅ /evidence_search (SerpApi DDG) results:", results.length);
    return res.json({ results });
  } catch (err) {
    console.error("❌ /evidence_search failed:", err);
    return res.status(500).json({
      error: true,
      message: "Evidence search failed",
      details: err.message
    });
  }
});

// --------------------------------------------------
// TEMP TEST ROUTE (SAFE TO KEEP)
// --------------------------------------------------
app.post("/test", (req, res) => {
  res.json({
    received: req.body || {},
    message: "Test route working!"
  });
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------
app.listen(PORT, () => {
  console.log(`✅ HelloAI server listening on port ${PORT}`);
});
