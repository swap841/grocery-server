const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const cors = require("cors");
const admin = require("firebase-admin");

// ─── Helmet ───
const helmetMiddleware = helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
});

// ─── CORS ───
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const corsMiddleware = cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.length === 0) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    if (origin.startsWith("capacitor://")) return cb(null, true);
    cb(new Error("Not allowed by CORS"));
  },
  credentials: true,
});

// ─── Rate Limiting ───
const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000;
const max = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100;

const generalLimiter = rateLimit({
  windowMs,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});

// ─── API Key Auth (for webhooks) ───
function apiKeyAuth(req, res, next) {
  const apiKey = req.headers["x-api-key"];
  const expected = process.env.API_KEY;
  if (!expected) return next();
  if (!apiKey || apiKey !== expected) {
    return res.status(401).json({ error: "Invalid or missing API key" });
  }
  next();
}

// ─── Firebase ID Token Verification ───
async function verifyFirebaseToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid authorization header" });
  }
  const idToken = authHeader.split("Bearer ")[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ─── Owner Guard (requires verifyFirebaseToken first) ───
async function requireOwner(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "Authentication required" });
  }
  const uid = req.user.uid;
  try {
    const userDoc = await admin.firestore().collection("users").doc(uid).get();
    const userData = userDoc.data();
    if (userData && userData.isOwner === true) {
      return next();
    }
    return res.status(403).json({ error: "Owner access required" });
  } catch (err) {
    return res.status(500).json({ error: "Failed to verify owner status" });
  }
}

// ─── Input Sanitization ───
function inputSanitizer(req, res, next) {
  if (!req.body || typeof req.body !== "object") return next();
  try {
    const raw = JSON.stringify(req.body);
    if (raw.length > 500000) {
      return res.status(413).json({ error: "Payload too large" });
    }
    if (/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/i.test(raw)) {
      return res.status(400).json({ error: "Script tags not allowed" });
    }
    if (/\$\.|\.\(\s*\)|\beval\s*\(/.test(raw)) {
      return res.status(400).json({ error: "Suspicious input detected" });
    }
  } catch (e) {
    // ignore
  }
  next();
}

module.exports = {
  helmetMiddleware,
  corsMiddleware,
  generalLimiter,
  apiKeyAuth,
  inputSanitizer,
  verifyFirebaseToken,
  requireOwner,
};
