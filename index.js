// LinkLyfe Fitness visual results Runware generalization v18.
// Extends the existing authenticated /recipe_remix_images endpoint to supported normal-mode visual results.
// Recipe Remix behavior remains unchanged; fitness/quick and fitness/meals use explicit requestedTitles.
// LinkLyfe Patch 1-9: protected one-image Trip Runware endpoint.
// LinkLyfe Recipe Remix Runware minimal-schema delivery v17.
// Uses the existing authenticated /recipe_remix_images endpoint with FLUX.2 [klein] 4B.
// v17 sends Runware's minimal documented text-to-image request, then immediately downloads
// each returned imageURL server-side and returns base64 JPEG data to the existing Android seam.
// Existing /generate behavior, Mini-Brain prompts, ModeContracts generation rules, and all other routes are unchanged.
// LinkLyfe Phase 6 monitoring + alert-signal backend v11
// Adds safe structured monitoring events for security rejections, rate limits,
// validation failures, slow requests, and server errors without logging user content.
// Phase 5 App Check / Play Integrity enforcement behavior remains unchanged.
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

dotenv.config();

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

if (!process.env.OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY in .env");
  process.exit(1);
}

const SERPAPI_API_KEY = process.env.SERPAPI_API_KEY;
const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY || "";

const RUNWARE_API_KEY = String(process.env.RUNWARE_API_KEY || "").trim();
const RUNWARE_API_URL = "https://api.runware.ai/v1";
const RUNWARE_RECIPE_REMIX_MODEL =
  String(process.env.RUNWARE_RECIPE_REMIX_MODEL || "runware:400@4").trim() ||
  "runware:400@4";

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
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
  );
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
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
    const appCheckStatus = req.linklyfeAppCheck?.status || "not_checked";

    console.log(JSON.stringify({
      event: "request_complete",
      requestId,
      method: req.method,
      route: req.path,
      status: res.statusCode,
      durationMs,
      appCheckStatus
    }));

    if (res.statusCode >= 500) {
      console.error(JSON.stringify({
        event: "request_server_error",
        requestId,
        route: req.path,
        status: res.statusCode,
        durationMs,
        appCheckStatus
      }));
    } else if (durationMs >= 15000) {
      console.warn(JSON.stringify({
        event: "request_slow",
        requestId,
        route: req.path,
        status: res.statusCode,
        durationMs,
        appCheckStatus
      }));
    }
  });

  next();
});

app.use(cors({
  origin(origin, callback) {
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
    errorName: typeof err?.name === "string" ? err.name.slice(0, 80) : "Error",
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

function logMonitoringEvent(req, event, extra = {}) {
  console.warn(JSON.stringify({
    event,
    requestId: req?.linklyfeRequestId || "startup",
    route: req?.path || "",
    ...extra
  }));
}

app.use(express.json({
  limit: "96kb",
  strict: true
}));

app.use((err, req, res, next) => {
  if (err?.type === "entity.too.large") {
    logMonitoringEvent(req, "request_body_rejected", { reason: "too_large" });
    return res.status(413).json({
      error: true,
      message: "Request body is too large."
    });
  }

  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    logMonitoringEvent(req, "request_body_rejected", { reason: "invalid_json" });
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
    logMonitoringEvent(req, "auth_rejected", { reason: "missing_token" });
    return res.status(401).json({ error: true, message: "Authentication required." });
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
    logMonitoringEvent(req, "auth_rejected", { reason: "invalid_token" });
    return res.status(401).json({ error: true, message: "Authentication required." });
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
    logMonitoringEvent(req, "app_check_rejected", {
      reason: "missing_token",
      enforcementMode: APP_CHECK_ENFORCEMENT_MODE
    });

    if (APP_CHECK_ENFORCEMENT_MODE === "enforce") {
      return res.status(401).json({ error: true, message: "App verification required." });
    }
    return next();
  }

  try {
    const decodedAppCheck = await getAppCheck().verifyToken(appCheckToken);
    req.linklyfeAppCheck = {
      status: "verified",
      appId: typeof decodedAppCheck?.app_id === "string" ? decodedAppCheck.app_id : ""
    };
    return next();
  } catch (_) {
    req.linklyfeAppCheck = { status: "invalid" };
    logMonitoringEvent(req, "app_check_rejected", {
      reason: "invalid_token",
      enforcementMode: APP_CHECK_ENFORCEMENT_MODE
    });

    if (APP_CHECK_ENFORCEMENT_MODE === "enforce") {
      return res.status(401).json({ error: true, message: "App verification required." });
    }
    return next();
  }
}

const phase3RateBuckets = new Map();
const PHASE3_RATE_BUCKET_TTL_MS = 30 * 60 * 1000;

function normalizedNetworkPart(value) {
  return String(value || "")
    .trim()
    .replace(/^::ffff:/i, "")
    .slice(0, 120);
}

function requestNetworkKey(req) {
  const forwarded = typeof req.headers["x-forwarded-for"] === "string"
    ? req.headers["x-forwarded-for"]
        .split(",")
        .map((part) => normalizedNetworkPart(part))
        .filter(Boolean)
    : [];

  const forwardedCandidate = forwarded.length ? forwarded[forwarded.length - 1] : "";

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

const phase3RatePruneTimer = setInterval(() => prunePhase3RateBuckets(), 5 * 60 * 1000);
phase3RatePruneTimer.unref?.();

function consumePhase3RateLimit(scope, identity, limit, windowMs) {
  const now = Date.now();
  const key = `${scope}:${identity}`;
  let bucket = phase3RateBuckets.get(key);

  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs, lastSeenAt: now };
  }

  bucket.count += 1;
  bucket.lastSeenAt = now;
  phase3RateBuckets.set(key, bucket);

  if (bucket.count > limit) {
    return {
      blocked: true,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
    };
  }

  return { blocked: false, retryAfterSeconds: 0 };
}

function phase3RateLimitMiddleware({ scope, limit, windowMs, identity }) {
  return (req, res, next) => {
    const identityValue = String(identity(req) || "").trim();
    if (!identityValue) {
      logMonitoringEvent(req, "rate_limit_identity_missing", { scope });
      return res.status(429).json({
        error: true,
        message: "Too many requests. Please try again shortly."
      });
    }

    const result = consumePhase3RateLimit(scope, identityValue, limit, windowMs);
    if (result.blocked) {
      logMonitoringEvent(req, "rate_limit_blocked", {
        scope,
        retryAfterSeconds: result.retryAfterSeconds
      });
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

const phase3GenerateLimits = phase3UserEndpointLimits("generate", 6, 24);

// One request can create up to four title-matched visual-result images in one Runware batch.
// Recipe Remix itself remains capped at three by its existing parser.
const phase3RecipeRemixImageLimits = phase3UserEndpointLimits(
  "recipe-remix-images",
  6,
  24
);

const phase3TripImageLimits = phase3UserEndpointLimits("trip-image", 6, 24);
const phase3AgentSmithLimits = phase3UserEndpointLimits("agent-smith", 4, 12);
const phase3EvidenceSearchLimits = phase3UserEndpointLimits("evidence-search", 8, 30);
const phase3PlaceAutosuggestLimits = phase3UserEndpointLimits("place-autosuggest", 45, 150);
const phase3RouteComputeLimits = phase3UserEndpointLimits("route-compute", 8, 20);

function isJsonObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateAllowedKeys(value, allowedKeys) {
  if (!isJsonObject(value)) return "Request body must be a JSON object.";
  const allowed = new Set(allowedKeys);
  return Object.keys(value).some((key) => !allowed.has(key))
    ? "Request contains unsupported fields."
    : "";
}

function validateStringValue(value, { fieldName, required = false, minLength = 0, maxLength }) {
  if (value === undefined || value === null) return required ? `${fieldName} is required.` : "";
  if (typeof value !== "string") return `${fieldName} must be a string.`;

  const trimmedLength = value.trim().length;
  if (required && trimmedLength === 0) return `${fieldName} is required.`;
  if (trimmedLength < minLength) return `${fieldName} is too short.`;
  if (typeof maxLength === "number" && value.length > maxLength) return `${fieldName} is too long.`;
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

const RUNWARE_SHARED_RESULT_IMAGE_MODE_KEYS = new Set([
  "recipe/fridge",
  "recipe/quick15",
  "recipe/budget",
  "fitness/quick",
  "fitness/meals"
]);

function validateRequestedTitles(value) {
  if (!Array.isArray(value)) return "requestedTitles must be an array.";
  if (value.length < 1 || value.length > 4) return "requestedTitles must contain between 1 and 4 items.";

  for (let index = 0; index < value.length; index += 1) {
    const error = validateStringValue(value[index], {
      fieldName: `requestedTitles[${index}]`,
      required: true,
      minLength: 2,
      maxLength: 120
    });
    if (error) return error;
  }
  return "";
}

function validateRecipeRemixImagesBody(body) {
  const shapeError = validateAllowedKeys(body, [
    "baseDish",
    "cuisine",
    "remixType",
    "modeKey",
    "requestedTitles",
    "result"
  ]);
  if (shapeError) return shapeError;

  const resultError = validateStringValue(body.result, {
    fieldName: "result",
    required: true,
    minLength: 20,
    maxLength: 24000
  });
  if (resultError) return resultError;

  const modeKey = safeString(body.modeKey).trim();
  if (modeKey) {
    if (!RUNWARE_SHARED_RESULT_IMAGE_MODE_KEYS.has(modeKey)) {
      return "modeKey is not supported for result images.";
    }
    const titlesError = validateRequestedTitles(body.requestedTitles);
    if (titlesError) return titlesError;
  } else if (body.requestedTitles !== undefined) {
    return "modeKey is required when requestedTitles is provided.";
  }

  const optionalFields = [
    ["baseDish", 300],
    ["cuisine", 100],
    ["remixType", 120]
  ];

  for (const [fieldName, maxLength] of optionalFields) {
    const error = validateStringValue(body[fieldName], {
      fieldName,
      required: false,
      maxLength
    });
    if (error) return error;
  }

  return "";
}

function validateTripImageBody(body) {
  const shapeError = validateAllowedKeys(body, [
    "modeKey",
    "destination",
    "dates",
    "tripGoal",
    "result"
  ]);
  if (shapeError) return shapeError;

  const modeError = validateStringValue(body.modeKey, {
    fieldName: "modeKey",
    required: true,
    minLength: 1,
    maxLength: 40
  });
  if (modeError) return modeError;
  if (!["trip/highlights", "trip/threeDay"].includes(String(body.modeKey || "").trim())) {
    return "modeKey is not supported for trip images.";
  }

  const destinationError = validateStringValue(body.destination, {
    fieldName: "destination",
    required: true,
    minLength: 2,
    maxLength: 240
  });
  if (destinationError) return destinationError;

  const resultError = validateStringValue(body.result, {
    fieldName: "result",
    required: true,
    minLength: 20,
    maxLength: 32000
  });
  if (resultError) return resultError;

  for (const [fieldName, maxLength] of [["dates", 120], ["tripGoal", 500]]) {
    const error = validateStringValue(body[fieldName], {
      fieldName,
      required: false,
      maxLength
    });
    if (error) return error;
  }

  return "";
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
  const safeReason = typeof message === "string" ? message.slice(0, 160) : "invalid_request";
  logMonitoringEvent(res?.req, "validation_rejected", { reason: safeReason });
  return res.status(400).json({ error: true, message });
}

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

function credibilityScoreFor(url, source) {
  const d = (extractDomain(url) || "").toLowerCase();
  const high = [
    "reuters.com", "apnews.com", "bbc.co.uk", "bbc.com", "ft.com", "wsj.com",
    "economist.com", "investopedia.com", "sec.gov", "federalreserve.gov", "bls.gov",
    "whitehouse.gov", "cdc.gov", "nih.gov", "who.int", "oecd.org", "worldbank.org",
    "imf.org", "nber.org", "nature.com", "science.org"
  ];
  const mid = [
    "wikipedia.org", "nerdwallet.com", "bankrate.com", "morningstar.com", "khanacademy.org"
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
  if (normalizedTail && normalizedQuery.includes(normalizedTail)) return cleanedQuery;
  return `${cleanedQuery}, ${tail}`;
}

async function fetchGooglePlacePredictions(query, contextText) {
  if (!GOOGLE_PLACES_API_KEY) throw new Error("Missing GOOGLE_PLACES_API_KEY in environment.");

  const input = googleAutocompleteInput(query, contextText);
  const response = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
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
  });

  if (!response.ok) throw new Error(`Google Places autocomplete failed with status ${response.status}`);
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
  if (!GOOGLE_PLACES_API_KEY) throw new Error("Google Maps Platform is not configured.");
  if (!Array.isArray(points) || points.length < 2) throw new Error("A route segment needs at least two points.");

  const origin = googleRouteWaypoint(points[0], contextText);
  const destination = googleRouteWaypoint(points[points.length - 1], contextText);
  const intermediates = points.slice(1, -1).map((point) => googleRouteWaypoint(point, contextText)).filter(Boolean);
  if (!origin || !destination) throw new Error("Route origin and destination are required.");

  const response = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
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
  });

  if (!response.ok) throw new Error(`Google Routes failed with status ${response.status}`);
  const data = await response.json();
  const route = Array.isArray(data?.routes) ? data.routes[0] : null;
  if (!route) throw new Error("Google Routes returned no route.");

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
    const endIndex = Math.min(allPoints.length - 1, startIndex + MAX_POINTS_PER_ESSENTIALS_REQUEST - 1);
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

  return { legs: allLegs, totalDistanceMeters, totalDurationSeconds, segmentCount };
}

function cleanRecipeRemixImageText(raw, maxLength = 1800) {
  return safeString(raw)
    .replace(/\*\*/g, "")
    .replace(/^\s*#{1,6}\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function recipeRemixNamedTitleMatch(line) {
  const value = safeString(line).trim();
  if (!value) return null;

  let match = value.match(
    /^(?:#{1,4}\s*)?(\d{1,2})[.)]\s+\*\*([^*]{3,100})\*\*(?:\s*[:—–-]\s*(.*))?$/
  );

  if (!match) {
    match = value.match(
      /^(?:#{1,4}\s*)?\*\*(\d{1,2})[.)]\s+([^*]{3,100})\*\*(?:\s*[:—–-]\s*(.*))?$/
    );
  }

  if (!match) return null;

  const title = safeString(match[2])
    .replace(/\*\*/g, "")
    .trim()
    .replace(/:$/, "")
    .trim();

  if (title.length < 3 || title.length > 100) return null;

  return {
    number: Number(match[1]),
    title,
    inlineTail: safeString(match[3]).trim()
  };
}

function isRecipeRemixFollowingTopLevelHeading(line) {
  const cleaned = safeString(line)
    .trim()
    .replace(/^#{1,4}\s*/, "")
    .replace(/\*\*/g, "")
    .replace(/:$/, "")
    .trim()
    .toLowerCase();

  return [
    "easiest remix",
    "mild version",
    "ingredient swaps"
  ].includes(cleaned);
}

function extractRecipeRemixImageSections(rawResult) {
  const lines = safeString(rawResult)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n");

  const starts = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = recipeRemixNamedTitleMatch(lines[index]);
    if (!match) continue;

    starts.push({
      index,
      title: match.title,
      inlineTail: match.inlineTail
    });

    if (starts.length >= 3) break;
  }

  if (starts.length === 0) return [];

  return starts.map((start, position) => {
    let endIndex = position + 1 < starts.length ? starts[position + 1].index : lines.length;

    for (let index = start.index + 1; index < endIndex; index += 1) {
      if (isRecipeRemixFollowingTopLevelHeading(lines[index])) {
        endIndex = index;
        break;
      }
    }

    const bodyLines = [];
    if (start.inlineTail) bodyLines.push(start.inlineTail);
    bodyLines.push(...lines.slice(start.index + 1, endIndex));

    return {
      title: start.title,
      details: cleanRecipeRemixImageText(bodyLines.join("\n"))
    };
  });
}

function buildRecipeRemixRunwarePrompt({
  baseDish,
  cuisine,
  remixType,
  title,
  details
}) {
  return [
    "Photorealistic food photography of one finished meal for a modern recipe app.",
    `Dish: ${title}.`,
    baseDish ? `Original dish being remixed: ${baseDish}.` : "",
    cuisine ? `Cuisine / flavor direction: ${cuisine}.` : "",
    remixType ? `Requested finished format: ${remixType}.` : "",
    details ? `Recipe details to visually honor: ${details}` : "",
    "Match the named dish and its described visible ingredients as closely as possible. Preserve the correct main protein or center and the requested dish format.",
    "Show one complete finished serving only. Tight appetizing crop, realistic food textures, natural soft lighting, clean plating, believable portions.",
    "No people, no hands, no packaging, no restaurant scene, no text, no labels, no logos, no UI, no collage.",
    "Use the serving vessel that naturally fits the dish. The food should fill most of the frame and look like a real meal rather than an advertisement."
  ].filter(Boolean).join("\n");
}

function buildSharedResultRunwarePrompt({ modeKey, title }) {
  if (modeKey === "fitness/quick") {
    return [
      "Photorealistic fitness reference image for a modern workout app.",
      `Exercise: ${title}.`,
      "Show one adult demonstrating this single exercise with safe, recognizable, conventional form at a clear point in the movement.",
      "Use only the equipment naturally required by the named exercise. Keep the full body or all relevant limbs visible when practical.",
      "Neutral uncluttered gym or home-workout setting, realistic anatomy, realistic proportions, natural lighting, clean instructional composition.",
      "One person, one exercise, one continuous camera view.",
      "No collage, no before-and-after, no multiple poses, no arrows, no diagrams, no text, no labels, no logos, no UI, no watermark."
    ].join("\n");
  }

  return [
    "Photorealistic food photography of one finished meal for a modern recipe or fitness app.",
    `Dish: ${title}.`,
    "Match the named meal as closely as possible using believable visible ingredients and portions.",
    "Show one complete finished serving only. Tight appetizing crop, realistic food textures, natural soft lighting, clean plating.",
    "No people, no hands, no packaging, no restaurant scene, no text, no labels, no logos, no UI, no collage.",
    "Use the serving vessel that naturally fits the meal. The food should fill most of the frame and look like a real meal rather than an advertisement."
  ].join("\n");
}

async function fetchRunwareRecipeRemixBatch(tasks) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  timeout.unref?.();

  try {
    const response = await fetch(RUNWARE_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RUNWARE_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(tasks),
      signal: controller.signal
    });

    const payload = await response.json().catch(() => ({}));
    const data = Array.isArray(payload?.data) ? payload.data : [];
    const upstreamErrors = Array.isArray(payload?.errors) ? payload.errors : [];

    if (!response.ok) {
      const firstError = upstreamErrors[0] || {};
      const error = new Error(`Runware request failed with status ${response.status}`);
      error.status = response.status;
      error.runwareCode = safeString(firstError?.code).slice(0, 100) || undefined;
      error.runwareParameter = safeString(firstError?.parameter).slice(0, 120) || undefined;
      throw error;
    }

    if (data.length === 0) {
      const firstError = upstreamErrors[0] || {};
      const error = new Error(`Runware returned no image data (errors=${upstreamErrors.length})`);
      error.runwareCode = safeString(firstError?.code).slice(0, 100) || undefined;
      error.runwareParameter = safeString(firstError?.parameter).slice(0, 120) || undefined;
      throw error;
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchRunwareImageAsBase64(imageURL) {
  const cleanedURL = safeString(imageURL).trim();
  if (!cleanedURL) return "";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  timeout.unref?.();

  try {
    const response = await fetch(cleanedURL, { method: "GET", signal: controller.signal });
    if (!response.ok) return "";

    const contentType = safeString(response.headers.get("content-type")).toLowerCase();
    if (contentType && !contentType.startsWith("image/")) return "";

    const arrayBuffer = await response.arrayBuffer();
    if (!arrayBuffer || arrayBuffer.byteLength === 0) return "";
    return Buffer.from(arrayBuffer).toString("base64");
  } finally {
    clearTimeout(timeout);
  }
}

async function generateRecipeRemixImagesWithRunware({
  baseDish,
  cuisine,
  remixType,
  sections
}) {
  const taskMeta = sections.slice(0, 3).map((section) => ({
    taskUUID: randomUUID(),
    title: section.title,
    prompt: buildRecipeRemixRunwarePrompt({
      baseDish,
      cuisine,
      remixType,
      title: section.title,
      details: section.details
    })
  }));

  const tasks = taskMeta.map((item) => ({
    taskType: "imageInference",
    taskUUID: item.taskUUID,
    model: RUNWARE_RECIPE_REMIX_MODEL,
    positivePrompt: item.prompt,
    width: 1024,
    height: 1024
  }));

  const data = await fetchRunwareRecipeRemixBatch(tasks);
  const byTaskUUID = new Map(
    data
      .filter((item) => safeString(item?.taskUUID).trim())
      .map((item) => [safeString(item.taskUUID).trim(), item])
  );

  const resolved = await Promise.all(taskMeta.map(async (meta) => {
    const item = byTaskUUID.get(meta.taskUUID);
    if (!item) return null;

    const imageURL = safeString(item?.imageURL).trim();
    if (!imageURL) return null;

    const imageBase64 = await fetchRunwareImageAsBase64(imageURL).catch(() => "");
    if (!imageBase64) return null;

    const cost = Number(item?.cost);
    return {
      title: meta.title,
      imageBase64,
      mimeType: "image/jpeg",
      imageUUID: safeString(item?.imageUUID).trim() || undefined,
      costUsd: Number.isFinite(cost) && cost >= 0 ? cost : undefined
    };
  }));

  return resolved.filter(Boolean);
}

async function generateSharedResultImagesWithRunware({ modeKey, requestedTitles }) {
  const taskMeta = requestedTitles.slice(0, 4).map((title) => ({
    taskUUID: randomUUID(),
    title,
    prompt: buildSharedResultRunwarePrompt({ modeKey, title })
  }));

  const tasks = taskMeta.map((item) => ({
    taskType: "imageInference",
    taskUUID: item.taskUUID,
    model: RUNWARE_RECIPE_REMIX_MODEL,
    positivePrompt: item.prompt,
    width: 1024,
    height: 1024
  }));

  const data = await fetchRunwareRecipeRemixBatch(tasks);
  const byTaskUUID = new Map(
    data
      .filter((item) => safeString(item?.taskUUID).trim())
      .map((item) => [safeString(item.taskUUID).trim(), item])
  );

  const resolved = await Promise.all(taskMeta.map(async (meta) => {
    const item = byTaskUUID.get(meta.taskUUID);
    if (!item) return null;

    const imageURL = safeString(item?.imageURL).trim();
    if (!imageURL) return null;

    const imageBase64 = await fetchRunwareImageAsBase64(imageURL).catch(() => "");
    if (!imageBase64) return null;

    const cost = Number(item?.cost);
    return {
      title: meta.title,
      imageBase64,
      mimeType: "image/jpeg",
      imageUUID: safeString(item?.imageUUID).trim() || undefined,
      costUsd: Number.isFinite(cost) && cost >= 0 ? cost : undefined
    };
  }));

  return resolved.filter(Boolean);
}

function buildTripRunwarePrompt({ modeKey, destination, dates, tripGoal }) {
  const modeDirection = modeKey === "trip/highlights"
    ? "Create one clean destination photograph that captures a recognizable highlight or defining atmosphere of the place."
    : "Create one clean destination photograph suitable as the hero image for a trip plan.";

  return [
    "Generate a single photorealistic travel photograph, as if captured by one camera in one moment.",
    modeDirection,
    `Destination: ${destination}.`,
    dates ? `Season/date context only: ${dates}.` : "",
    tripGoal ? `Use this only to choose the mood or type of scenery: ${tripGoal}.` : "",
    "Choose one believable scenic or landmark-oriented view strongly associated with the destination. Use one continuous composition and one camera viewpoint.",
    "Natural light, realistic colors, realistic architecture and landscape, editorial travel-photography quality.",
    "ABSOLUTELY NO collage, diptych, split screen, side-by-side images, montage, multiple panels, inset pictures, picture-in-picture, poster, brochure, map, itinerary, schedule, cards, document, phone screen, UI, infographic, or graphic-design layout.",
    "ABSOLUTELY NO readable words, letters, numbers, captions, labels, titles, dates, notes, logos, watermarks, signs, banners, or typography anywhere in the image.",
    "Do not visualize the written trip plan. Do not add explanatory information. Output only the photographic scene."
  ].filter(Boolean).join("\n");
}

async function generateTripImageWithRunware(input) {
  const taskUUID = randomUUID();
  const task = {
    taskType: "imageInference",
    taskUUID,
    model: RUNWARE_RECIPE_REMIX_MODEL,
    positivePrompt: buildTripRunwarePrompt(input),
    width: 1024,
    height: 1024
  };

  const data = await fetchRunwareRecipeRemixBatch([task]);
  const item = data.find((candidate) => safeString(candidate?.taskUUID).trim() === taskUUID) || data[0];
  const imageURL = safeString(item?.imageURL).trim();
  if (!imageURL) return null;

  const imageBase64 = await fetchRunwareImageAsBase64(imageURL).catch(() => "");
  if (!imageBase64) return null;

  const cost = Number(item?.cost);
  return {
    imageBase64,
    mimeType: "image/jpeg",
    imageUUID: safeString(item?.imageUUID).trim() || undefined,
    costUsd: Number.isFinite(cost) && cost >= 0 ? cost : undefined
  };
}

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "HelloAI backend is running 🚀" });
});

app.post(
  "/place_autosuggest",
  phase3NetworkGate,
  requireFirebaseIdToken,
  verifyLinklyfeAppCheck,
  phase3UserGate,
  ...phase3PlaceAutosuggestLimits,
  async (req, res) => {
    try {
      const bodyShapeError = validateAllowedKeys(req.body, ["query", "contextText"]);
      if (bodyShapeError) return respondPhase3ValidationError(res, bodyShapeError);

      const queryTypeError = validateStringValue(req.body.query, {
        fieldName: "query",
        required: true,
        minLength: 3,
        maxLength: 180
      });
      if (queryTypeError) return respondPhase3ValidationError(res, queryTypeError);

      const contextTypeError = validateStringValue(req.body.contextText, {
        fieldName: "contextText",
        required: false,
        maxLength: 220
      });
      if (contextTypeError) return respondPhase3ValidationError(res, contextTypeError);

      const query = normalizePlaceQuery(req.body.query);
      const contextText = normalizePlaceQuery(req.body.contextText);

      if (!GOOGLE_PLACES_API_KEY) {
        logMonitoringEvent(req, "provider_config_missing", { provider: "google_places" });
        return res.status(503).json({ error: "Place suggestions are temporarily unavailable." });
      }

      const rawSuggestions = await fetchGooglePlacePredictions(query, contextText);
      const items = [];

      for (const suggestion of rawSuggestions) {
        if (items.length >= 5) break;
        const item = googlePlaceSuggestionFromPrediction(suggestion);
        if (item) items.push(item);
      }

      return res.json({ provider: "google_maps", items });
    } catch (err) {
      logBackendError(req, "place_autosuggest_failed", err);
      return res.status(502).json({ error: "Place suggestions are temporarily unavailable." });
    }
  }
);

app.post(
  "/route_compute",
  phase3NetworkGate,
  requireFirebaseIdToken,
  verifyLinklyfeAppCheck,
  phase3UserGate,
  ...phase3RouteComputeLimits,
  async (req, res) => {
    try {
      const bodyShapeError = validateAllowedKeys(req.body, ["start", "end", "stops", "contextText"]);
      if (bodyShapeError) return respondPhase3ValidationError(res, bodyShapeError);

      const startError = validateRouteLocationObject(req.body.start, "start");
      if (startError) return respondPhase3ValidationError(res, startError);

      const endError = validateRouteLocationObject(req.body.end, "end");
      if (endError) return respondPhase3ValidationError(res, endError);

      if (!Array.isArray(req.body.stops)) {
        return respondPhase3ValidationError(res, "stops must be an array.");
      }
      if (req.body.stops.length < 1 || req.body.stops.length > 50) {
        return respondPhase3ValidationError(res, "stops must contain between 1 and 50 items.");
      }

      for (let index = 0; index < req.body.stops.length; index += 1) {
        const stopError = validateRouteLocationObject(req.body.stops[index], `stops[${index}]`);
        if (stopError) return respondPhase3ValidationError(res, stopError);
      }

      const contextError = validateStringValue(req.body.contextText, {
        fieldName: "contextText",
        required: false,
        maxLength: 240
      });
      if (contextError) return respondPhase3ValidationError(res, contextError);

      const start = req.body.start;
      const end = req.body.end;
      const rawStops = req.body.stops;
      const contextText = normalizePlaceQuery(req.body.contextText);

      if (!GOOGLE_PLACES_API_KEY) {
        logMonitoringEvent(req, "provider_config_missing", { provider: "google_routes" });
        return res.status(503).json({ error: "Route calculation is temporarily unavailable." });
      }

      const stops = rawStops.map((value) => ({
        text: routeInputText(value),
        placeId: routeInputPlaceId(value)
      }));
      const normalizedStart = { text: routeInputText(start), placeId: routeInputPlaceId(start) };
      const normalizedEnd = { text: routeInputText(end), placeId: routeInputPlaceId(end) };
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
  }
);

app.post(
  "/trip_image",
  phase3NetworkGate,
  requireFirebaseIdToken,
  verifyLinklyfeAppCheck,
  phase3UserGate,
  ...phase3TripImageLimits,
  async (req, res) => {
    try {
      const validationError = validateTripImageBody(req.body || {});
      if (validationError) return respondPhase3ValidationError(res, validationError);

      if (!RUNWARE_API_KEY) {
        logMonitoringEvent(req, "provider_config_missing", { provider: "runware" });
        return res.status(503).json({
          error: true,
          message: "Trip images are temporarily unavailable."
        });
      }

      const input = {
        modeKey: safeString(req.body.modeKey).trim(),
        destination: safeString(req.body.destination).trim(),
        dates: safeString(req.body.dates).trim(),
        tripGoal: safeString(req.body.tripGoal).trim(),
        result: safeString(req.body.result)
      };

      const startedAt = Date.now();
      logMonitoringEvent(req, "trip_image_started", {
        provider: "runware",
        model: RUNWARE_RECIPE_REMIX_MODEL,
        modeKey: input.modeKey,
        timeoutMs: 20000
      });

      const image = await generateTripImageWithRunware(input);
      const generationMs = Date.now() - startedAt;

      if (!image) {
        logMonitoringEvent(req, "trip_image_empty", { modeKey: input.modeKey });
        return res.status(502).json({
          error: true,
          message: "Trip images are temporarily unavailable."
        });
      }

      logMonitoringEvent(req, "trip_image_completed", {
        provider: "runware",
        model: RUNWARE_RECIPE_REMIX_MODEL,
        modeKey: input.modeKey,
        generationMs
      });

      return res.json({
        provider: "runware",
        model: RUNWARE_RECIPE_REMIX_MODEL,
        ...image,
        generationMs
      });
    } catch (err) {
      logBackendError(req, "trip_image_failed", err, {
        provider: "runware",
        model: RUNWARE_RECIPE_REMIX_MODEL,
        timedOut: err?.name === "AbortError",
        runwareCode: safeString(err?.runwareCode).slice(0, 100) || undefined,
        runwareParameter: safeString(err?.runwareParameter).slice(0, 120) || undefined
      });
      return res.status(502).json({
        error: true,
        message: "Trip images are temporarily unavailable."
      });
    }
  }
);

app.post(
  "/recipe_remix_images",
  phase3NetworkGate,
  requireFirebaseIdToken,
  verifyLinklyfeAppCheck,
  phase3UserGate,
  ...phase3RecipeRemixImageLimits,
  async (req, res) => {
    try {
      const validationError = validateRecipeRemixImagesBody(req.body || {});
      if (validationError) return respondPhase3ValidationError(res, validationError);

      if (!RUNWARE_API_KEY) {
        logMonitoringEvent(req, "provider_config_missing", { provider: "runware" });
        return res.status(503).json({
          error: true,
          message: "Result images are temporarily unavailable."
        });
      }

      const modeKey = safeString(req.body.modeKey).trim();
      const isRecipeRemix = !modeKey;
      const baseDish = safeString(req.body.baseDish).trim();
      const cuisine = safeString(req.body.cuisine).trim();
      const remixType = safeString(req.body.remixType).trim();
      const result = safeString(req.body.result);
      const requestedTitles = Array.isArray(req.body.requestedTitles)
        ? req.body.requestedTitles.map((title) => safeString(title).trim()).filter(Boolean).slice(0, 4)
        : [];

      const recipeSections = isRecipeRemix
        ? extractRecipeRemixImageSections(result).slice(0, 3)
        : [];

      if (isRecipeRemix && recipeSections.length === 0) {
        logMonitoringEvent(req, "recipe_remix_images_skipped", {
          reason: "named_sections_not_found"
        });
        return res.json({
          provider: "runware",
          model: RUNWARE_RECIPE_REMIX_MODEL,
          images: [],
          partial: true,
          generationMs: 0,
          totalCostUsd: 0
        });
      }

      const requestedCount = isRecipeRemix ? recipeSections.length : requestedTitles.length;
      const startedAt = Date.now();
      logMonitoringEvent(req, "recipe_remix_images_started", {
        provider: "runware",
        model: RUNWARE_RECIPE_REMIX_MODEL,
        modeKey: modeKey || "recipe/twist",
        requested: requestedCount,
        timeoutMs: 20000
      });

      const images = isRecipeRemix
        ? await generateRecipeRemixImagesWithRunware({
            baseDish,
            cuisine,
            remixType,
            sections: recipeSections
          })
        : await generateSharedResultImagesWithRunware({
            modeKey,
            requestedTitles
          });

      const generationMs = Date.now() - startedAt;
      const totalCostUsd = images.reduce(
        (sum, image) => sum + (Number(image.costUsd) || 0),
        0
      );

      logMonitoringEvent(req, "recipe_remix_images_completed", {
        provider: "runware",
        model: RUNWARE_RECIPE_REMIX_MODEL,
        modeKey: modeKey || "recipe/twist",
        requested: requestedCount,
        received: images.length,
        generationMs,
        partial: images.length !== requestedCount
      });

      if (images.length === 0) {
        logMonitoringEvent(req, "recipe_remix_images_empty", {
          modeKey: modeKey || "recipe/twist",
          requested: requestedCount
        });
        return res.status(502).json({
          error: true,
          message: "Result images are temporarily unavailable."
        });
      }

      return res.json({
        provider: "runware",
        model: RUNWARE_RECIPE_REMIX_MODEL,
        images,
        partial: images.length !== requestedCount,
        generationMs,
        totalCostUsd
      });
    } catch (err) {
      logBackendError(req, "recipe_remix_images_failed", err, {
        provider: "runware",
        model: RUNWARE_RECIPE_REMIX_MODEL,
        timedOut: err?.name === "AbortError",
        runwareCode: safeString(err?.runwareCode).slice(0, 100) || undefined,
        runwareParameter: safeString(err?.runwareParameter).slice(0, 120) || undefined
      });
      return res.status(502).json({
        error: true,
        message: "Result images are temporarily unavailable."
      });
    }
  }
);

app.post(
  "/generate",
  phase3NetworkGate,
  requireFirebaseIdToken,
  verifyLinklyfeAppCheck,
  phase3UserGate,
  ...phase3GenerateLimits,
  async (req, res) => {
    try {
      const validationError = validateSimplePromptBody(req.body, 48000);
      if (validationError) return respondPhase3ValidationError(res, validationError);

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
  }
);

app.post(
  "/agent_smith",
  phase3NetworkGate,
  requireFirebaseIdToken,
  verifyLinklyfeAppCheck,
  phase3UserGate,
  ...phase3AgentSmithLimits,
  async (req, res) => {
    try {
      const validationError = validateSimplePromptBody(req.body, 36000);
      if (validationError) return respondPhase3ValidationError(res, validationError);

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
            typeof ev.snippet === "string" && ev.snippet.trim().length
              ? ev.snippet.trim()
              : undefined;
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
  }
);

app.post(
  "/evidence_search",
  phase3NetworkGate,
  requireFirebaseIdToken,
  verifyLinklyfeAppCheck,
  phase3UserGate,
  ...phase3EvidenceSearchLimits,
  async (req, res) => {
    try {
      const bodyShapeError = validateAllowedKeys(req.body, ["query"]);
      if (bodyShapeError) return respondPhase3ValidationError(res, bodyShapeError);

      const queryError = validateStringValue(req.body.query, {
        fieldName: "query",
        required: true,
        minLength: 2,
        maxLength: 600
      });
      if (queryError) return respondPhase3ValidationError(res, queryError);

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
      url.searchParams.set("no_cache", "true");

      const resp = await fetch(url, { method: "GET" });
      if (!resp.ok) {
        logBackendError(
          req,
          "evidence_search_upstream_failed",
          { name: "UpstreamError", status: resp.status }
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
        const link = safeString(item.link || item.url);
        const snippet = safeString(item.snippet);
        const domain = extractDomain(link);
        const source = domain || null;
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
  }
);

app.use((req, res) => {
  return res.status(404).json({
    error: true,
    message: "Endpoint not found."
  });
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  logBackendError(req, "unhandled_backend_error", err);
  return res.status(500).json({
    error: true,
    message: "Service temporarily unavailable."
  });
});

app.listen(PORT, () => {
  console.log(`✅ HelloAI server listening on port ${PORT}`);
  console.log(JSON.stringify({
    event: "server_start",
    monitoringPhase: "phase6",
    appCheckEnforcementMode: APP_CHECK_ENFORCEMENT_MODE,
    runwareRecipeRemixConfigured: Boolean(RUNWARE_API_KEY),
    runwareRecipeRemixModel: RUNWARE_RECIPE_REMIX_MODEL
  }));
});
