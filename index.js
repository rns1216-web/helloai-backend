// LinkLyfe Phase 5 App Check / Play Integrity backend v10
// Verifies X-Firebase-AppCheck on all authenticated production endpoints.
// Defaults to MONITOR mode so rollout cannot break older installed app versions.
// LinkLyfe Phase 4 backend hardening v9
// Removes user-content logging, adds request metadata logging + request IDs,
// generic public error responses, deliberate CORS, security headers,
// removes the public test route, and deletes unused HERE Route Planner code.
// Phase 2 Firebase auth and Phase 3 rate limits/validation remain unchanged.
// LinkLyfe Phase 3 security hardening v8
// Adds bounded JSON parsing, authenticated UID + network rate limits,
// expensive-endpoint burst/sustained limits, and strict request validation.
// No Android contract changes; Phase 2 Firebase authentication is preserved.
// LinkLyfe narrow hotfix v7
// Fixes GOOGLE_PLACES_API_KEY declaration accidentally commented out in v6.
// No route behavior, Firebase auth, Places logic, or Routes logic changed.
// LinkLyfe drop-in replacement
// Route Planner Google Places + Google Routes v6.
// Selected Place IDs route directly through Google Routes; HERE is no longer used by Route Planner.
// Phase 2 Firebase auth remains fail-closed and unchanged.
// LinkLyfe drop-in replacement
// Route Planner Google Places Autocomplete v5.
// Preserves Phase 2 Firebase auth, HERE route geocoding, and normal-mode routing repair.
// LinkLyfe drop-in replacement
// Route Planner HERE Autosuggest v4.
// Preserves Phase 2 Firebase auth and the normal-mode Route Planner regional-routing repair.
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
const { getAppCheck } = require("firebase-admin/app-check");
const { randomUUID } = require("crypto");

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
// Shared restricted Google Maps Platform key: Places API (New) + Routes API only.
const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY || "";

// Phase 5 App Check rollout:
// - monitor (default): verify/log tokens but never block an otherwise authenticated request.
// - enforce: reject missing/invalid App Check tokens.
// Keep monitor during initial rollout so existing installed versions are not broken.
const APP_CHECK_ENFORCEMENT_MODE =
  String(process.env.APP_CHECK_ENFORCEMENT_MODE || "monitor")
    .trim()
    .toLowerCase() === "enforce"
    ? "enforce"
    : "monitor";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const app = express();
const PORT = process.env.PORT || 3000;

// --------------------------------------------------
// PHASE 4 — RESPONSE SECURITY + SAFE REQUEST LOGGING
// --------------------------------------------------

const defaultCorsOrigins = [
  "https://linklyfe.com",
  "https://www.linklyfe.com"
];

const configuredCorsOrigins = String(process.env.CORS_ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const allowedCorsOrigins = new Set([
  ...defaultCorsOrigins,
  ...configuredCorsOrigins
]);

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()"
  );
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
  );
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains"
  );
  next();
});

app.use((req, res, next) => {
  const requestId = randomUUID();
  const startedAt = process.hrtime.bigint();

  req.linklyfeRequestId = requestId;
  res.setHeader("X-Request-Id", requestId);

  res.on("finish", () => {
    const elapsedNs = process.hrtime.bigint() - startedAt;
    const durationMs = Number(elapsedNs / 1000000n);

    console.log(JSON.stringify({
      event: "request_complete",
      requestId,
      method: req.method,
      route: req.path,
      status: res.statusCode,
      durationMs,
      appCheckStatus: req.linklyfeAppCheck?.status || "not_checked"
    }));
  });

  next();
});

app.use(cors({
  origin(origin, callback) {
    // Native Android/server-to-server requests normally have no Origin header.
    if (!origin) return callback(null, true);
    return callback(null, allowedCorsOrigins.has(origin));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Firebase-AppCheck"],
  exposedHeaders: ["X-Request-Id"],
  credentials: false,
  maxAge: 600
}));

function safeBackendErrorMeta(err) {
  const rawCode =
    typeof err?.code === "string" || typeof err?.code === "number"
      ? String(err.code).slice(0, 80)
      : "";

  let upstreamStatus = null;
  const directStatus = Number(
    err?.status ??
    err?.statusCode ??
    err?.response?.status
  );

  if (Number.isFinite(directStatus) && directStatus >= 100 && directStatus <= 599) {
    upstreamStatus = directStatus;
  } else {
    const message = typeof err?.message === "string" ? err.message : "";
    const match = message.match(/\b([45]\d{2})\b/);
    if (match) upstreamStatus = Number(match[1]);
  }

  return {
    errorName:
      typeof err?.name === "string"
        ? err.name.slice(0, 80)
        : "Error",
    errorCode: rawCode || undefined,
    upstreamStatus: upstreamStatus || undefined
  };
}

function logBackendError(req, event, err, extra = {}) {
  console.error(JSON.stringify({
    event,
    requestId: req?.linklyfeRequestId || "startup",
    route: req?.path || "",
    ...safeBackendErrorMeta(err),
    ...extra
  }));
}

// Phase 3: bound request bodies before any expensive work.
// 96 KB comfortably covers current LinkLyfe prompts/forms while preventing
// unbounded JSON payloads from reaching Firebase/OpenAI/Google/SerpApi paths.
app.use(express.json({
  limit: "96kb",
  strict: true
}));

app.use((err, req, res, next) => {
  if (err?.type === "entity.too.large") {
    return res.status(413).json({
      error: true,
      message: "Request body is too large."
    });
  }

  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    return res.status(400).json({
      error: true,
      message: "Invalid JSON request body."
    });
  }

  return next(err);
});

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


function firebaseAppCheckTokenFromRequest(req) {
  const value = req.headers["x-firebase-appcheck"];
  return typeof value === "string" ? value.trim() : "";
}

async function verifyLinklyfeAppCheck(req, res, next) {
  const appCheckToken = firebaseAppCheckTokenFromRequest(req);

  if (!appCheckToken) {
    req.linklyfeAppCheck = { status: "missing" };

    if (APP_CHECK_ENFORCEMENT_MODE === "enforce") {
      return res.status(401).json({
        error: true,
        message: "App verification required."
      });
    }

    return next();
  }

  try {
    const decodedAppCheck = await getAppCheck().verifyToken(appCheckToken);

    req.linklyfeAppCheck = {
      status: "verified",
      appId:
        typeof decodedAppCheck?.app_id === "string"
          ? decodedAppCheck.app_id
          : ""
    };

    return next();
  } catch (_) {
    req.linklyfeAppCheck = { status: "invalid" };

    if (APP_CHECK_ENFORCEMENT_MODE === "enforce") {
      return res.status(401).json({
        error: true,
        message: "App verification required."
      });
    }

    return next();
  }
}


// --------------------------------------------------
// PHASE 3 — RATE LIMITING + REQUEST VALIDATION
// --------------------------------------------------
// This limiter is intentionally dependency-free so the patch does not change
// package.json/package-lock.json. It protects both authenticated UID and a
// best-effort network key. If the service is horizontally scaled later, move
// the limiter state to a shared store such as Redis.

const phase3RateBuckets = new Map();
const PHASE3_RATE_BUCKET_TTL_MS = 30 * 60 * 1000;

function normalizedNetworkPart(value) {
  return String(value || "")
    .trim()
    .replace(/^::ffff:/i, "")
    .slice(0, 120);
}

function requestNetworkKey(req) {
  // Managed proxies normally append to X-Forwarded-For. Taking the right-most
  // entry avoids trusting a client-supplied left-most value when one exists.
  const forwarded = typeof req.headers["x-forwarded-for"] === "string"
    ? req.headers["x-forwarded-for"]
        .split(",")
        .map((part) => normalizedNetworkPart(part))
        .filter(Boolean)
    : [];

  const forwardedCandidate = forwarded.length
    ? forwarded[forwarded.length - 1]
    : "";

  return forwardedCandidate ||
    normalizedNetworkPart(req.socket?.remoteAddress) ||
    "unknown-network";
}

function prunePhase3RateBuckets(now = Date.now()) {
  for (const [key, bucket] of phase3RateBuckets.entries()) {
    if (!bucket || now - bucket.lastSeenAt > PHASE3_RATE_BUCKET_TTL_MS) {
      phase3RateBuckets.delete(key);
    }
  }
}

const phase3RatePruneTimer = setInterval(
  () => prunePhase3RateBuckets(),
  5 * 60 * 1000
);
phase3RatePruneTimer.unref?.();

function consumePhase3RateLimit(scope, identity, limit, windowMs) {
  const now = Date.now();
  const key = `${scope}:${identity}`;
  let bucket = phase3RateBuckets.get(key);

  if (!bucket || now >= bucket.resetAt) {
    bucket = {
      count: 0,
      resetAt: now + windowMs,
      lastSeenAt: now
    };
  }

  bucket.count += 1;
  bucket.lastSeenAt = now;
  phase3RateBuckets.set(key, bucket);

  if (bucket.count > limit) {
    return {
      blocked: true,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((bucket.resetAt - now) / 1000)
      )
    };
  }

  return {
    blocked: false,
    retryAfterSeconds: 0
  };
}

function phase3RateLimitMiddleware({
  scope,
  limit,
  windowMs,
  identity
}) {
  return (req, res, next) => {
    const identityValue = String(identity(req) || "").trim();
    if (!identityValue) {
      return res.status(429).json({
        error: true,
        message: "Too many requests. Please try again shortly."
      });
    }

    const result = consumePhase3RateLimit(
      scope,
      identityValue,
      limit,
      windowMs
    );

    if (result.blocked) {
      res.set("Retry-After", String(result.retryAfterSeconds));
      return res.status(429).json({
        error: true,
        message: "Too many requests. Please try again shortly."
      });
    }

    return next();
  };
}

const phase3NetworkGate = phase3RateLimitMiddleware({
  scope: "network-global",
  limit: 180,
  windowMs: 60 * 1000,
  identity: requestNetworkKey
});

const phase3UserGate = phase3RateLimitMiddleware({
  scope: "uid-global",
  limit: 90,
  windowMs: 60 * 1000,
  identity: (req) => req.linklyfeAuth?.uid
});

function phase3UserEndpointLimits(name, burstLimit, sustainedLimit) {
  return [
    phase3RateLimitMiddleware({
      scope: `${name}-burst`,
      limit: burstLimit,
      windowMs: 60 * 1000,
      identity: (req) => req.linklyfeAuth?.uid
    }),
    phase3RateLimitMiddleware({
      scope: `${name}-sustained`,
      limit: sustainedLimit,
      windowMs: 10 * 60 * 1000,
      identity: (req) => req.linklyfeAuth?.uid
    })
  ];
}

const phase3GenerateLimits = phase3UserEndpointLimits(
  "generate",
  6,
  24
);
const phase3AgentSmithLimits = phase3UserEndpointLimits(
  "agent-smith",
  4,
  12
);
const phase3EvidenceSearchLimits = phase3UserEndpointLimits(
  "evidence-search",
  8,
  30
);
const phase3PlaceAutosuggestLimits = phase3UserEndpointLimits(
  "place-autosuggest",
  45,
  150
);
const phase3RouteComputeLimits = phase3UserEndpointLimits(
  "route-compute",
  8,
  20
);

function isJsonObject(value) {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value);
}

function validateAllowedKeys(value, allowedKeys) {
  if (!isJsonObject(value)) {
    return "Request body must be a JSON object.";
  }

  const allowed = new Set(allowedKeys);
  const hasUnknownKey = Object.keys(value).some((key) => !allowed.has(key));
  return hasUnknownKey
    ? "Request contains unsupported fields."
    : "";
}

function validateStringValue(
  value,
  {
    fieldName,
    required = false,
    minLength = 0,
    maxLength
  }
) {
  if (value === undefined || value === null) {
    return required ? `${fieldName} is required.` : "";
  }

  if (typeof value !== "string") {
    return `${fieldName} must be a string.`;
  }

  const trimmedLength = value.trim().length;
  if (required && trimmedLength === 0) {
    return `${fieldName} is required.`;
  }

  if (trimmedLength < minLength) {
    return `${fieldName} is too short.`;
  }

  if (typeof maxLength === "number" && value.length > maxLength) {
    return `${fieldName} is too long.`;
  }

  return "";
}

function validateSimplePromptBody(body, maxLength) {
  const shapeError = validateAllowedKeys(body, ["prompt"]);
  if (shapeError) return shapeError;

  return validateStringValue(body.prompt, {
    fieldName: "prompt",
    required: true,
    minLength: 1,
    maxLength
  });
}

function validateRouteLocationObject(value, fieldName) {
  const shapeError = validateAllowedKeys(value, ["text", "placeId"]);
  if (shapeError) return `${fieldName} is invalid.`;

  const textError = validateStringValue(value.text, {
    fieldName: `${fieldName}.text`,
    required: true,
    minLength: 1,
    maxLength: 240
  });
  if (textError) return textError;

  return validateStringValue(value.placeId, {
    fieldName: `${fieldName}.placeId`,
    required: false,
    maxLength: 180
  });
}

function respondPhase3ValidationError(res, message) {
  return res.status(400).json({
    error: true,
    message
  });
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


function googleAutocompleteContextTail(contextText) {
  const parts = normalizePlaceQuery(contextText)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length >= 3) return parts.slice(-3).join(", ");
  if (parts.length >= 2) return parts.slice(-2).join(", ");
  return "";
}

function googleAutocompleteInput(query, contextText) {
  const cleanedQuery = normalizePlaceQuery(query);
  const tail = googleAutocompleteContextTail(contextText);

  if (!tail) return cleanedQuery;

  const normalizedQuery = normalizeComparableText(cleanedQuery);
  const normalizedTail = normalizeComparableText(tail);

  // Avoid duplicating region words the user already typed.
  if (normalizedTail && normalizedQuery.includes(normalizedTail)) {
    return cleanedQuery;
  }

  return `${cleanedQuery}, ${tail}`;
}

async function fetchGooglePlacePredictions(query, contextText) {
  if (!GOOGLE_PLACES_API_KEY) {
    throw new Error("Missing GOOGLE_PLACES_API_KEY in environment.");
  }

  const input = googleAutocompleteInput(query, contextText);
  const response = await fetch(
    "https://places.googleapis.com/v1/places:autocomplete",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_PLACES_API_KEY,
        "X-Goog-FieldMask": [
          "suggestions.placePrediction.placeId",
          "suggestions.placePrediction.text.text",
          "suggestions.placePrediction.structuredFormat.mainText.text",
          "suggestions.placePrediction.structuredFormat.secondaryText.text"
        ].join(",")
      },
      body: JSON.stringify({
        input,
        includeQueryPredictions: false,
        languageCode: "en"
      })
    }
  );

  if (!response.ok) {
    throw new Error(`Google Places autocomplete failed with status ${response.status}`);
  }

  const data = await response.json();
  return Array.isArray(data?.suggestions) ? data.suggestions : [];
}

function googlePlaceSuggestionFromPrediction(suggestion) {
  const prediction = suggestion?.placePrediction;
  if (!prediction) return null;

  const placeId = safeString(prediction?.placeId).trim();
  const title = safeString(prediction?.structuredFormat?.mainText?.text).trim();
  const subtitle = safeString(prediction?.structuredFormat?.secondaryText?.text).trim();
  const fullText = safeString(prediction?.text?.text).trim();

  if (!placeId || (!title && !fullText)) return null;

  return {
    id: placeId,
    title: title || fullText,
    subtitle,
    selectionText: fullText || [title, subtitle].filter(Boolean).join(", "),
    lat: null,
    lng: null
  };
}


function routeInputText(value) {
  return safeString(value?.text).trim();
}

function routeInputPlaceId(value) {
  return safeString(value?.placeId).trim();
}

function googleRouteWaypoint(value, contextText = "") {
  const placeId = routeInputPlaceId(value);
  if (placeId) return { placeId };

  let address = routeInputText(value);
  const context = safeString(contextText).trim();

  if (address && context) {
    const comparableAddress = normalizeComparableText(address);
    const comparableContext = normalizeComparableText(context);
    if (comparableContext && !comparableAddress.includes(comparableContext)) {
      address = `${address}, ${context}`;
    }
  }

  return address ? { address } : null;
}

function parseGoogleDurationSeconds(raw) {
  const value = safeString(raw).trim();
  if (!value.endsWith("s")) return null;
  const seconds = Number(value.slice(0, -1));
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function routePointResponse(value) {
  const text = routeInputText(value);
  const placeId = routeInputPlaceId(value);
  return {
    query: text,
    shortName: text.split(",")[0]?.trim() || text,
    displayName: text,
    placeId,
    resolved: true,
    lat: null,
    lng: null
  };
}

async function fetchGoogleRouteSegment(points, contextText = "") {
  if (!GOOGLE_PLACES_API_KEY) {
    throw new Error("Google Maps Platform is not configured.");
  }
  if (!Array.isArray(points) || points.length < 2) {
    throw new Error("A route segment needs at least two points.");
  }

  const origin = googleRouteWaypoint(points[0], contextText);
  const destination = googleRouteWaypoint(points[points.length - 1], contextText);
  const intermediates = points
    .slice(1, -1)
    .map((point) => googleRouteWaypoint(point, contextText))
    .filter(Boolean);

  if (!origin || !destination) {
    throw new Error("Route origin and destination are required.");
  }

  const response = await fetch(
    "https://routes.googleapis.com/directions/v2:computeRoutes",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_PLACES_API_KEY,
        "X-Goog-FieldMask": [
          "routes.distanceMeters",
          "routes.duration",
          "routes.legs.distanceMeters",
          "routes.legs.duration"
        ].join(",")
      },
      body: JSON.stringify({
        origin,
        destination,
        intermediates,
        travelMode: "DRIVE",
        computeAlternativeRoutes: false
      })
    }
  );

  if (!response.ok) {
    throw new Error(`Google Routes failed with status ${response.status}`);
  }

  const data = await response.json();
  const route = Array.isArray(data?.routes) ? data.routes[0] : null;
  if (!route) {
    throw new Error("Google Routes returned no route.");
  }

  const legs = Array.isArray(route?.legs)
    ? route.legs.map((leg) => ({
        distanceMeters:
          typeof leg?.distanceMeters === "number" && Number.isFinite(leg.distanceMeters)
            ? Math.max(0, Math.round(leg.distanceMeters))
            : null,
        durationSeconds: parseGoogleDurationSeconds(leg?.duration)
      }))
    : [];

  return {
    legs,
    distanceMeters:
      typeof route?.distanceMeters === "number" && Number.isFinite(route.distanceMeters)
        ? Math.max(0, Math.round(route.distanceMeters))
        : legs.reduce((sum, leg) => sum + (leg.distanceMeters || 0), 0),
    durationSeconds:
      parseGoogleDurationSeconds(route?.duration) ??
      legs.reduce((sum, leg) => sum + (leg.durationSeconds || 0), 0)
  };
}

async function computeGoogleOrderedRoute(allPoints, contextText = "") {
  const MAX_POINTS_PER_ESSENTIALS_REQUEST = 12;
  const allLegs = [];
  let totalDistanceMeters = 0;
  let totalDurationSeconds = 0;
  let segmentCount = 0;

  let startIndex = 0;
  while (startIndex < allPoints.length - 1) {
    const endIndex = Math.min(
      allPoints.length - 1,
      startIndex + MAX_POINTS_PER_ESSENTIALS_REQUEST - 1
    );
    const segmentPoints = allPoints.slice(startIndex, endIndex + 1);
    const segment = await fetchGoogleRouteSegment(segmentPoints, contextText);

    allLegs.push(...segment.legs);
    totalDistanceMeters += segment.distanceMeters || 0;
    totalDurationSeconds += segment.durationSeconds || 0;
    segmentCount += 1;
    startIndex = endIndex;
  }

  if (allLegs.length !== allPoints.length - 1) {
    throw new Error("Google Routes returned an unexpected leg count.");
  }

  return {
    legs: allLegs,
    totalDistanceMeters,
    totalDurationSeconds,
    segmentCount
  };
}

// --------------------------------------------------
// HEALTH CHECK
// --------------------------------------------------
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "HelloAI backend is running 🚀" });
});

// --------------------------------------------------
// GOOGLE PLACES AUTOCOMPLETE (DISTANCE ROUTE PLANNER)
// Expects: { query: string, contextText?: string }
// Returns Google place predictions only; no Place Details request is made.
// Free-form typing remains valid if no suggestion is selected.
// --------------------------------------------------
app.post(
  "/place_autosuggest",
  phase3NetworkGate,
  requireFirebaseIdToken,
  verifyLinklyfeAppCheck,
  phase3UserGate,
  ...phase3PlaceAutosuggestLimits,
  async (req, res) => {
  try {
    const bodyShapeError = validateAllowedKeys(
      req.body,
      ["query", "contextText"]
    );
    if (bodyShapeError) {
      return respondPhase3ValidationError(res, bodyShapeError);
    }

    const queryTypeError = validateStringValue(req.body.query, {
      fieldName: "query",
      required: true,
      minLength: 3,
      maxLength: 180
    });
    if (queryTypeError) {
      return respondPhase3ValidationError(res, queryTypeError);
    }

    const contextTypeError = validateStringValue(req.body.contextText, {
      fieldName: "contextText",
      required: false,
      maxLength: 220
    });
    if (contextTypeError) {
      return respondPhase3ValidationError(res, contextTypeError);
    }

    const query = normalizePlaceQuery(req.body.query);
    const contextText = normalizePlaceQuery(req.body.contextText);

    if (!GOOGLE_PLACES_API_KEY) {
      return res.status(503).json({ error: "Place suggestions are temporarily unavailable." });
    }

    const rawSuggestions = await fetchGooglePlacePredictions(query, contextText);
    const items = [];

    for (const suggestion of rawSuggestions) {
      if (items.length >= 5) break;
      const item = googlePlaceSuggestionFromPrediction(suggestion);
      if (item) items.push(item);
    }

    return res.json({
      provider: "google_maps",
      items
    });
  } catch (err) {
    logBackendError(req, "place_autosuggest_failed", err);
    return res.status(502).json({ error: "Place suggestions are temporarily unavailable." });
  }
});

// --------------------------------------------------
// GOOGLE ROUTES — DISTANCE ROUTE PLANNER
// Selected Google Places predictions use Place IDs.
// Free-typed entries fall back to address strings.
// Stop order is preserved; Pro waypoint optimization is not enabled.
// --------------------------------------------------
app.post(
  "/route_compute",
  phase3NetworkGate,
  requireFirebaseIdToken,
  verifyLinklyfeAppCheck,
  phase3UserGate,
  ...phase3RouteComputeLimits,
  async (req, res) => {
  try {
    const bodyShapeError = validateAllowedKeys(
      req.body,
      ["start", "end", "stops", "contextText"]
    );
    if (bodyShapeError) {
      return respondPhase3ValidationError(res, bodyShapeError);
    }

    const startError = validateRouteLocationObject(
      req.body.start,
      "start"
    );
    if (startError) {
      return respondPhase3ValidationError(res, startError);
    }

    const endError = validateRouteLocationObject(
      req.body.end,
      "end"
    );
    if (endError) {
      return respondPhase3ValidationError(res, endError);
    }

    if (!Array.isArray(req.body.stops)) {
      return respondPhase3ValidationError(
        res,
        "stops must be an array."
      );
    }

    if (req.body.stops.length < 1 || req.body.stops.length > 50) {
      return respondPhase3ValidationError(
        res,
        "stops must contain between 1 and 50 items."
      );
    }

    for (let index = 0; index < req.body.stops.length; index += 1) {
      const stopError = validateRouteLocationObject(
        req.body.stops[index],
        `stops[${index}]`
      );
      if (stopError) {
        return respondPhase3ValidationError(res, stopError);
      }
    }

    const contextError = validateStringValue(req.body.contextText, {
      fieldName: "contextText",
      required: false,
      maxLength: 240
    });
    if (contextError) {
      return respondPhase3ValidationError(res, contextError);
    }

    const start = req.body.start;
    const end = req.body.end;
    const rawStops = req.body.stops;
    const contextText = normalizePlaceQuery(req.body.contextText);

    if (!GOOGLE_PLACES_API_KEY) {
      return res.status(503).json({ error: "Route calculation is temporarily unavailable." });
    }

    const startText = routeInputText(start);
    const endText = routeInputText(end);

    const stops = rawStops.map((value) => ({
      text: routeInputText(value),
      placeId: routeInputPlaceId(value)
    }));

    const normalizedStart = {
      text: startText,
      placeId: routeInputPlaceId(start)
    };
    const normalizedEnd = {
      text: endText,
      placeId: routeInputPlaceId(end)
    };

    const allPoints = [normalizedStart, ...stops, normalizedEnd];
    const computed = await computeGoogleOrderedRoute(allPoints, contextText);

    return res.json({
      provider: "google_routes",
      start: routePointResponse(normalizedStart),
      end: routePointResponse(normalizedEnd),
      stops: stops.map(routePointResponse),
      legs: computed.legs,
      totalDistanceMeters: computed.totalDistanceMeters,
      totalDurationSeconds: computed.totalDurationSeconds,
      segmentCount: computed.segmentCount
    });
  } catch (err) {
    logBackendError(req, "route_compute_failed", err);
    return res.status(502).json({ error: "Route calculation is temporarily unavailable." });
  }
});

// --------------------------------------------------
// MINI-BRAIN GENERATE ENDPOINT (MAIN ENDPOINT)
// --------------------------------------------------
app.post(
  "/generate",
  phase3NetworkGate,
  requireFirebaseIdToken,
  verifyLinklyfeAppCheck,
  phase3UserGate,
  ...phase3GenerateLimits,
  async (req, res) => {
  try {
    const validationError = validateSimplePromptBody(
      req.body,
      48000
    );
    if (validationError) {
      return respondPhase3ValidationError(res, validationError);
    }

    const prompt = req.body.prompt;

    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: "You are Hello AI's smart assistant engine." },
        { role: "user", content: prompt }
      ]
    });

    const output = completion.choices?.[0]?.message?.content || "";
    return res.json({ result: output });
  } catch (err) {
    logBackendError(req, "generate_failed", err);
    return res.status(500).json({ error: "Generation is temporarily unavailable." });
  }
});

// --------------------------------------------------
// AGENT SMITH ENDPOINT (NEW)
// Expects: { prompt: string }
// Returns: strict JSON matching AgentSmithScreen parser
// --------------------------------------------------
app.post(
  "/agent_smith",
  phase3NetworkGate,
  requireFirebaseIdToken,
  verifyLinklyfeAppCheck,
  phase3UserGate,
  ...phase3AgentSmithLimits,
  async (req, res) => {
  try {
    const validationError = validateSimplePromptBody(
      req.body,
      36000
    );
    if (validationError) {
      return respondPhase3ValidationError(res, validationError);
    }

    const prompt = req.body.prompt;

    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: "Return ONLY valid JSON. No markdown. No extra text." },
        { role: "user", content: prompt }
      ]
    });

    const raw = completion.choices?.[0]?.message?.content || "";
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
    logBackendError(req, "agent_smith_failed", err);
    return res.status(500).json({
      error: true,
      message: "Agent Smith is temporarily unavailable."
    });
  }
});

// --------------------------------------------------
// EVIDENCE SEARCH ENDPOINT (SerpApi DuckDuckGo)
// Expects: { query: string }
// Returns: { results: EvidenceItem[] }
// --------------------------------------------------
app.post(
  "/evidence_search",
  phase3NetworkGate,
  requireFirebaseIdToken,
  verifyLinklyfeAppCheck,
  phase3UserGate,
  ...phase3EvidenceSearchLimits,
  async (req, res) => {
  try {
    const bodyShapeError = validateAllowedKeys(
      req.body,
      ["query"]
    );
    if (bodyShapeError) {
      return respondPhase3ValidationError(res, bodyShapeError);
    }

    const queryError = validateStringValue(req.body.query, {
      fieldName: "query",
      required: true,
      minLength: 2,
      maxLength: 600
    });
    if (queryError) {
      return respondPhase3ValidationError(res, queryError);
    }

    const q = req.body.query.trim();
    if (!SERPAPI_API_KEY) {
      logBackendError(
        req,
        "evidence_search_config_missing",
        { name: "ConfigurationError", code: "SERVICE_NOT_CONFIGURED" }
      );
      return res.status(503).json({
        error: true,
        message: "Evidence search is temporarily unavailable.",
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
      logBackendError(
        req,
        "evidence_search_upstream_failed",
        {
          name: "UpstreamError",
          status: resp.status
        }
      );
      return res.status(502).json({
        error: true,
        message: "Evidence search is temporarily unavailable.",
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

    return res.json({ results });
  } catch (err) {
    logBackendError(req, "evidence_search_failed", err);
    return res.status(500).json({
      error: true,
      message: "Evidence search is temporarily unavailable.",
      results: []
    });
  }
});

// --------------------------------------------------
// PHASE 4 — FINAL PUBLIC ERROR BOUNDARY
// --------------------------------------------------
app.use((req, res) => {
  return res.status(404).json({
    error: true,
    message: "Endpoint not found."
  });
});

app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  logBackendError(req, "unhandled_backend_error", err);
  return res.status(500).json({
    error: true,
    message: "Service temporarily unavailable."
  });
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------
app.listen(PORT, () => {
  console.log(`✅ HelloAI server listening on port ${PORT}`);
});
