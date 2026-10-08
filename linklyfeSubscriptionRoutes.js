"use strict";

/**
 * LinkLyfe production subscription verification routes.
 *
 * Install after express.json() is enabled AND after your existing Firebase Admin
 * initialization:
 *   require("./linklyfeSubscriptionRoutes")(app);
 *
 * Required backend packages already used by LinkLyfe:
 *   firebase-admin
 *
 * No Google API npm package is required. This module exchanges the configured
 * Google Play service-account JWT for an Android Publisher OAuth token directly.
 */

const crypto = require("crypto");
const fs = require("fs");
const admin = require("firebase-admin");

const PACKAGE_NAME = process.env.GOOGLE_PLAY_PACKAGE_NAME || "com.linklyfe.app";
const PRODUCT_ID = process.env.LINKLYFE_SUBSCRIPTION_PRODUCT_ID || "linklyfe_unlimited";
const ALLOWED_BASE_PLANS = new Set([
  process.env.LINKLYFE_MONTHLY_BASE_PLAN_ID || "monthly",
  process.env.LINKLYFE_YEARLY_BASE_PLAN_ID || "yearly",
]);

const REQUIRE_APP_CHECK =
  String(process.env.LINKLYFE_BILLING_REQUIRE_APP_CHECK || "true").toLowerCase() !== "false";

const STATUS_REVERIFY_MS = Number(process.env.LINKLYFE_BILLING_REVERIFY_MS || 6 * 60 * 60 * 1000);
const SERVER_GRACE_MS = Number(process.env.LINKLYFE_BILLING_SERVER_GRACE_MS || 72 * 60 * 60 * 1000);

const ENTITLEMENT_COLLECTION = "linklyfe_subscription_entitlements_v1";
const PURCHASE_TOKEN_COLLECTION = "linklyfe_subscription_purchase_tokens_v1";
const ANDROID_PUBLISHER_SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

let cachedGoogleAccessToken = null;
let cachedGoogleAccessTokenExpiresAt = 0;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

class OwnershipConflictError extends Error {
  constructor() {
    super("This Google Play subscription is linked to another LinkLyfe account.");
    this.code = "purchase_owned_by_other_account";
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function base64Url(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  return buffer
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function readGooglePlayServiceAccount() {
  let raw = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON || "";

  if (!raw && process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_BASE64) {
    raw = Buffer.from(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8");
  }

  if (!raw && process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_FILE) {
    raw = fs.readFileSync(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_FILE, "utf8");
  }

  if (!raw) {
    throw new Error(
      "Missing GOOGLE_PLAY_SERVICE_ACCOUNT_JSON, GOOGLE_PLAY_SERVICE_ACCOUNT_BASE64, or GOOGLE_PLAY_SERVICE_ACCOUNT_FILE."
    );
  }

  const parsed = JSON.parse(raw);
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("Google Play service account JSON is missing client_email/private_key.");
  }
  parsed.private_key = String(parsed.private_key).replace(/\\n/g, "\n");
  return parsed;
}

async function androidPublisherAccessToken() {
  const nowMs = Date.now();
  if (cachedGoogleAccessToken && nowMs + 60_000 < cachedGoogleAccessTokenExpiresAt) {
    return cachedGoogleAccessToken;
  }

  const credential = readGooglePlayServiceAccount();
  const now = Math.floor(nowMs / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(
    JSON.stringify({
      iss: credential.client_email,
      scope: ANDROID_PUBLISHER_SCOPE,
      aud: OAUTH_TOKEN_URL,
      iat: now,
      exp: now + 3600,
    })
  );
  const unsignedJwt = `${header}.${claims}`;
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(unsignedJwt)
    .end()
    .sign(credential.private_key);
  const assertion = `${unsignedJwt}.${base64Url(signature)}`;

  const response = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    throw new HttpError(
      response.status || 502,
      "google_play_auth_failed",
      body.error_description || body.error || "Could not authorize Google Play Developer API."
    );
  }

  cachedGoogleAccessToken = body.access_token;
  cachedGoogleAccessTokenExpiresAt = nowMs + Number(body.expires_in || 3600) * 1000;
  return cachedGoogleAccessToken;
}

async function googlePlayRequest(url, options = {}) {
  const accessToken = await androidPublisherAccessToken();
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.body ? { "Content-Type": "application/json; charset=utf-8" } : {}),
      ...(options.headers || {}),
    },
  });

  const raw = await response.text();
  let parsed = {};
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { message: raw.slice(0, 500) };
    }
  }
  if (!response.ok) {
    const message =
      parsed?.error?.message || parsed?.message || `Google Play request failed (${response.status}).`;
    throw new HttpError(response.status, "google_play_request_failed", message);
  }
  return parsed;
}

async function getSubscriptionFromGooglePlay(purchaseToken) {
  const url =
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(PACKAGE_NAME)}` +
    `/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`;
  return googlePlayRequest(url, { method: "GET" });
}

async function acknowledgeSubscriptionIfNeeded(purchaseToken, productId, acknowledgementState) {
  if (acknowledgementState !== "ACKNOWLEDGEMENT_STATE_PENDING") return true;

  const url =
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(PACKAGE_NAME)}` +
    `/purchases/subscriptions/${encodeURIComponent(productId)}` +
    `/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`;

  try {
    await googlePlayRequest(url, { method: "POST", body: "{}" });
    return true;
  } catch (error) {
    // Entitlement can still be returned after a valid verification. The Android client
    // also acknowledges verified purchases, giving us a second safe path within 3 days.
    console.warn("Subscription acknowledgement did not complete:", error?.message || "unknown error");
    return false;
  }
}

function isGoogleInfrastructureError(error) {
  const status = Number(error?.status || 0);
  // 401/403 generally mean a backend service-account/API configuration problem,
  // not that the customer's purchase ceased to exist. Preserve only a recently
  // server-verified entitlement through those outages; fail closed after the grace.
  return status === 0 || status === 401 || status === 403 || status === 429 || status >= 500;
}

function isTerminalPurchaseLookupError(error) {
  const status = Number(error?.status || 0);
  return status === 400 || status === 404 || status === 410;
}

function parsePlaySubscription(play) {
  const lineItems = Array.isArray(play?.lineItems) ? play.lineItems : [];
  const matchingItems = lineItems.filter((item) => item?.productId === PRODUCT_ID);
  const item = matchingItems
    .slice()
    .sort((a, b) => Date.parse(b?.expiryTime || 0) - Date.parse(a?.expiryTime || 0))[0];

  if (!item) {
    throw new HttpError(400, "wrong_product", "Purchase token is not for LinkLyfe Unlimited.");
  }

  const basePlanId = item?.offerDetails?.basePlanId || null;
  if (!basePlanId || !ALLOWED_BASE_PLANS.has(basePlanId)) {
    throw new HttpError(400, "wrong_base_plan", "Purchase token is not for an active LinkLyfe base plan.");
  }

  const expiryMs = Date.parse(item.expiryTime || 0);
  const state = String(play.subscriptionState || "SUBSCRIPTION_STATE_UNSPECIFIED");
  const accessStates = new Set([
    "SUBSCRIPTION_STATE_ACTIVE",
    "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
    "SUBSCRIPTION_STATE_CANCELED",
  ]);
  const active = accessStates.has(state) && Number.isFinite(expiryMs) && expiryMs > Date.now();

  return {
    active,
    state,
    productId: item.productId,
    basePlanId,
    expiresAt: item.expiryTime || null,
    acknowledgementState: play.acknowledgementState || null,
    linkedPurchaseToken: play.linkedPurchaseToken || null,
    obfuscatedAccountId: play?.externalAccountIdentifiers?.obfuscatedExternalAccountId || null,
    isTestPurchase: Boolean(play?.testPurchase),
  };
}

function entitlementActiveNow(data) {
  if (!data?.active) return false;
  if (data?.state === "LINKLYFE_ADMIN") return true;
  const expiryMs = Date.parse(data?.expiresAt || 0);
  return Number.isFinite(expiryMs) && expiryMs > Date.now();
}

function responseFromEntitlement(data, extras = {}) {
  return {
    active: entitlementActiveNow(data),
    state: data?.state || "SUBSCRIPTION_STATE_UNSPECIFIED",
    productId: data?.productId || PRODUCT_ID,
    basePlanId: data?.basePlanId || null,
    expiresAt: data?.expiresAt || null,
    lastVerifiedAt: data?.lastVerifiedAt || null,
    ...extras,
  };
}

async function authenticateLinklyfeAccount(req) {
  const authHeader = String(req.get("Authorization") || "");
  if (!authHeader.startsWith("Bearer ")) {
    throw new HttpError(401, "missing_auth", "Missing Firebase authentication token.");
  }

  const idToken = authHeader.slice("Bearer ".length).trim();
  const decoded = await admin.auth().verifyIdToken(idToken, true);
  const provider = decoded?.firebase?.sign_in_provider || "";
  if (!decoded.uid || provider === "anonymous") {
    throw new HttpError(401, "account_required", "A signed-in LinkLyfe account is required.");
  }

  if (REQUIRE_APP_CHECK) {
    const appCheckToken = String(req.get("X-Firebase-AppCheck") || "").trim();
    if (!appCheckToken) {
      throw new HttpError(401, "missing_app_check", "Missing Firebase App Check token.");
    }
    await admin.appCheck().verifyToken(appCheckToken);
  }

  return decoded;
}

async function persistVerifiedPurchase(uid, purchaseToken, play, parsed, source) {
  const db = admin.firestore();
  const tokenHash = sha256(purchaseToken);
  const linkedHash = parsed.linkedPurchaseToken ? sha256(parsed.linkedPurchaseToken) : null;
  const expectedAccountId = sha256(uid);

  if (parsed.obfuscatedAccountId && parsed.obfuscatedAccountId !== expectedAccountId) {
    throw new OwnershipConflictError();
  }

  const entitlementRef = db.collection(ENTITLEMENT_COLLECTION).doc(uid);
  const tokenRef = db.collection(PURCHASE_TOKEN_COLLECTION).doc(tokenHash);
  const linkedTokenRef = linkedHash
    ? db.collection(PURCHASE_TOKEN_COLLECTION).doc(linkedHash)
    : null;

  await db.runTransaction(async (tx) => {
    const tokenSnapshot = await tx.get(tokenRef);
    if (tokenSnapshot.exists) {
      const owner = String(tokenSnapshot.data()?.ownerFirebaseUid || "");
      if (owner && owner !== uid) throw new OwnershipConflictError();
    }

    if (linkedTokenRef) {
      const linkedSnapshot = await tx.get(linkedTokenRef);
      if (linkedSnapshot.exists) {
        const linkedOwner = String(linkedSnapshot.data()?.ownerFirebaseUid || "");
        if (linkedOwner && linkedOwner !== uid) throw new OwnershipConflictError();
      }
    }

    const nowIso = new Date().toISOString();
    tx.set(
      tokenRef,
      {
        ownerFirebaseUid: uid,
        purchaseToken,
        purchaseTokenHash: tokenHash,
        linkedPurchaseTokenHash: linkedHash,
        productId: parsed.productId,
        basePlanId: parsed.basePlanId,
        state: parsed.state,
        expiresAt: parsed.expiresAt,
        active: parsed.active,
        obfuscatedAccountId: parsed.obfuscatedAccountId || null,
        testPurchase: parsed.isTestPurchase,
        lastVerifiedAt: nowIso,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: tokenSnapshot.exists
          ? tokenSnapshot.data()?.createdAt || admin.firestore.FieldValue.serverTimestamp()
          : admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    if (linkedTokenRef) {
      tx.set(
        linkedTokenRef,
        {
          ownerFirebaseUid: uid,
          purchaseTokenHash: linkedHash,
          successorPurchaseTokenHash: tokenHash,
          productId: parsed.productId,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    tx.set(
      entitlementRef,
      {
        ownerFirebaseUid: uid,
        active: parsed.active,
        productId: parsed.productId,
        basePlanId: parsed.basePlanId,
        state: parsed.state,
        expiresAt: parsed.expiresAt,
        purchaseTokenHash: tokenHash,
        linkedPurchaseTokenHash: linkedHash,
        testPurchase: parsed.isTestPurchase,
        lastVerifiedAt: nowIso,
        source,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });

  return { tokenHash, entitlementRef };
}

async function verifyAndPersist(uid, purchaseToken, source) {
  const play = await getSubscriptionFromGooglePlay(purchaseToken);
  const parsed = parsePlaySubscription(play);
  await persistVerifiedPurchase(uid, purchaseToken, play, parsed, source);
  const acknowledged = await acknowledgeSubscriptionIfNeeded(
    purchaseToken,
    parsed.productId,
    parsed.acknowledgementState
  );
  return { ...parsed, acknowledged };
}

function sendError(res, error) {
  if (error instanceof OwnershipConflictError) {
    return res.status(409).json({
      active: false,
      code: error.code,
      message: error.message,
    });
  }

  const status = Number(error?.status || 500);
  const safeStatus = status >= 400 && status <= 599 ? status : 500;
  const code = error?.code || "subscription_verification_failed";
  const message =
    safeStatus >= 500
      ? "Subscription verification is temporarily unavailable."
      : error?.message || "Subscription verification failed.";
  return res.status(safeStatus).json({ active: false, code, message });
}

module.exports = function installLinklyfeSubscriptionRoutes(app) {
  if (!app || typeof app.post !== "function") {
    throw new Error("installLinklyfeSubscriptionRoutes requires an Express app instance.");
  }

  if (!admin.apps.length) {
    throw new Error(
      "Firebase Admin must be initialized before installing LinkLyfe subscription routes."
    );
  }

  app.post("/subscription/verify", async (req, res) => {
    try {
      const decoded = await authenticateLinklyfeAccount(req);
      const purchaseToken = String(req.body?.purchaseToken || "").trim();
      const requestedProductId = String(req.body?.productId || "").trim();

      if (!purchaseToken) {
        throw new HttpError(400, "missing_purchase_token", "Missing Google Play purchase token.");
      }
      if (requestedProductId && requestedProductId !== PRODUCT_ID) {
        throw new HttpError(400, "wrong_product", "Unsupported subscription product.");
      }

      const result = await verifyAndPersist(decoded.uid, purchaseToken, "android_purchase_verify");
      return res.json(responseFromEntitlement(result, { acknowledged: result.acknowledged }));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post("/subscription/status", async (req, res) => {
    let decoded;
    try {
      decoded = await authenticateLinklyfeAccount(req);
    } catch (error) {
      return sendError(res, error);
    }

    if (decoded.linklyfeAdmin === true) {
      return res.json({
        active: true,
        state: "LINKLYFE_ADMIN",
        productId: PRODUCT_ID,
        basePlanId: null,
        expiresAt: null,
        source: "admin_claim",
      });
    }

    const db = admin.firestore();
    const entitlementRef = db.collection(ENTITLEMENT_COLLECTION).doc(decoded.uid);

    try {
      const entitlementSnapshot = await entitlementRef.get();
      if (!entitlementSnapshot.exists) {
        return res.json({
          active: false,
          state: "NO_ENTITLEMENT",
          productId: PRODUCT_ID,
          basePlanId: null,
          expiresAt: null,
        });
      }

      const entitlement = entitlementSnapshot.data() || {};
      const lastVerifiedMs = Date.parse(entitlement.lastVerifiedAt || 0);
      const ageMs = Number.isFinite(lastVerifiedMs) ? Date.now() - lastVerifiedMs : Number.MAX_SAFE_INTEGER;

      if (ageMs <= STATUS_REVERIFY_MS) {
        return res.json(responseFromEntitlement(entitlement));
      }

      const purchaseTokenHash = String(entitlement.purchaseTokenHash || "").trim();
      if (!purchaseTokenHash) {
        return res.json({
          ...responseFromEntitlement(entitlement),
          active: false,
          state: "MISSING_PURCHASE_TOKEN",
        });
      }

      const tokenSnapshot = await db
        .collection(PURCHASE_TOKEN_COLLECTION)
        .doc(purchaseTokenHash)
        .get();
      const tokenRecord = tokenSnapshot.exists ? tokenSnapshot.data() || {} : {};
      const purchaseToken = String(tokenRecord.purchaseToken || "").trim();
      const tokenOwner = String(tokenRecord.ownerFirebaseUid || "").trim();

      if (!purchaseToken || tokenOwner !== decoded.uid) {
        return res.json({
          ...responseFromEntitlement(entitlement),
          active: false,
          state: "MISSING_PURCHASE_TOKEN",
        });
      }

      try {
        const refreshed = await verifyAndPersist(
          decoded.uid,
          purchaseToken,
          "account_status_refresh"
        );
        return res.json(responseFromEntitlement(refreshed));
      } catch (error) {
        if (error instanceof OwnershipConflictError) {
          return sendError(res, error);
        }

        if (
          isGoogleInfrastructureError(error) &&
          entitlementActiveNow(entitlement) &&
          ageMs <= SERVER_GRACE_MS
        ) {
          return res.json(responseFromEntitlement(entitlement, { stale: true }));
        }

        if (isTerminalPurchaseLookupError(error)) {
          // Google authoritatively rejected/lost the token. Persist inactive and return a
          // successful status response so Android clears any UID-keyed entitlement cache.
          const inactive = {
            ...entitlement,
            active: false,
            state: "PURCHASE_NOT_ACTIVE",
            lastVerifiedAt: new Date().toISOString(),
          };
          await entitlementRef.set(
            {
              active: false,
              state: inactive.state,
              lastVerifiedAt: inactive.lastVerifiedAt,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
          return res.json(responseFromEntitlement(inactive));
        }

        // Authentication/API configuration failures and transient Google outages do not
        // prove the purchase is inactive. Outside the bounded grace period they fail closed
        // without overwriting the last known verified state.
        throw error;
      }
    } catch (error) {
      return sendError(res, error);
    }
  });
};
