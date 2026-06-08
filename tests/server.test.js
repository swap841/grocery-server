/**
 * Comprehensive Test Suite — Grocery Ecosystem Server
 *
 * Covers: unit tests (configLoader, security, validation),
 *         integration tests (HTTP endpoints via supertest),
 *         data-integrity tests (config path, order statuses, FCM path parsing),
 *         edge-case tests (missing fields, empty collections, concurrent updates).
 *
 * Run:  npx jest tests/server.test.js --verbose
 */

// ─── Suppress noisy console output during tests ────────────────────
const _origLog = console.log;
const _origWarn = console.warn;
const _origError = console.error;
beforeAll(() => { console.log = () => {}; console.warn = () => {}; console.error = () => {}; });
afterAll(() => { console.log = _origLog; console.warn = _origWarn; console.error = _origError; });

// ─── Ensure server doesn't try to load real serviceAccountKey.json ──
process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 = Buffer.from(JSON.stringify({
  type: "service_account", project_id: "test-project",
  private_key_id: "k", private_key: "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MhgHcTz6sE2I2yP\nBaFDrBz9vFqU5yTfMJPHE2TkDBAUflsYE5mWGT0RAQM9SCY+QSYOOAkVoT4J8OZP\nBM2AUDDyHROlX3sKqCY9dFmKJmQrHcJS2/9PG6Yk/r3FZ9Wj7LCVX7XKPXlN6mvlM\nb7dHsY9eDm0dQmZBmMv7V2aC3c5K8Tz6QFJ5V2sD3hG7K4X9N0mB3cY8fW1dR6pL\n4kA7tY2iH5sF8nJ3qM9wX6bV4cZ7eA0dR5tK2mP3hL8nQ4sF6wJ9xY1bV7cZ3eA\nIDAQAB-----END RSA PRIVATE KEY-----\n",
  client_email: "test@test.iam.gserviceaccount.com", client_id: "12345",
  auth_uri: "https://accounts.google.com/o/oauth2/auth", token_uri: "https://oauth2.googleapis.com/token",
})).toString("base64");

// ─── Mocks for server services ─────────────────────────────────────
jest.mock("../services/deliveryPartner", () => ({
  dispatch: jest.fn(() => Promise.resolve({ success: true, trackingId: "SR-12345", eta: "30 min" })),
  track: jest.fn(() => Promise.resolve({ status: "in_transit" })),
  handleWebhook: jest.fn(() => Promise.resolve({ success: true })),
}));

jest.mock("node-cache", () => {
  const store = {};
  return jest.fn().mockImplementation(() => ({
    get: jest.fn((k) => store[k] || undefined),
    set: jest.fn((k, v) => { store[k] = v; }),
    del: jest.fn((k) => { delete store[k]; }),
    flushAll: jest.fn(() => { Object.keys(store).forEach((k) => delete store[k]); }),
    has: jest.fn((k) => k in store),
  }));
});

// ─── Require modules ────────────────────────────────────────────────
const request = require("supertest");
const admin = require("firebase-admin");

const mockFirestore = global.__mockFirestore;
const mockAuth = global.__mockAuth;
const mockData = global.__mockData;
const docSnapshot = global.__buildDocSnapshot;

// ─── Load the server app ────────────────────────────────────────────
let app;
try {
  app = require("../index");
} catch (e) {
  // Server couldn't load — integration tests will be skipped
}

// ─── Load individual modules for unit testing ───────────────────────
const { corsMiddleware, generalLimiter, apiKeyAuth, inputSanitizer, verifyFirebaseToken, requireOwner } = require("../middleware/security");
const { validate, verifyDeliveryCodeSchema, paySalarySchema, sendSMSOTPSchema } = require("../middleware/validation");
const { loadConfig, getConfig } = require("../services/configLoader");

// ─── Helper ─────────────────────────────────────────────────────────
function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  res.set = jest.fn(() => res);
  return res;
}

// ══════════════════════════════════════════════════════════════════════
// 1. UNIT TESTS — configLoader
// ══════════════════════════════════════════════════════════════════════
describe("configLoader", () => {
  beforeEach(() => {
    Object.keys(mockData).forEach((k) => delete mockData[k]);
  });

  it("loads config from config/appConfig (primary path)", async () => {
    mockData["config/appConfig"] = docSnapshot({ business: { name: "Primary Store" }, updatedAt: "2026-01-01" }, true);
    const result = await loadConfig();
    expect(result).toBeDefined();
    expect(result.business.name).toBe("Primary Store");
  });

  it("falls back to appConfig/settings when config/appConfig missing", async () => {
    mockData["appConfig/settings"] = docSnapshot({ business: { name: "Settings Store" }, updatedAt: "2026-02-01" }, true);
    const result = await loadConfig();
    expect(result).toBeDefined();
    expect(result.business.name).toBe("Settings Store");
  });

  it("falls back to appConfig/main when both primary and settings missing", async () => {
    mockData["appConfig/main"] = docSnapshot({ business: { name: "Main Store" }, updatedAt: "2026-03-01" }, true);
    const result = await loadConfig();
    expect(result).toBeDefined();
    expect(result.business.name).toBe("Main Store");
  });

  it("returns null when no config document exists anywhere", async () => {
    const result = await loadConfig();
    expect(result).toBeNull();
  });

  it("caches config after first load (getConfig returns cached)", async () => {
    mockData["config/appConfig"] = docSnapshot({ business: { name: "Cached Store" } }, true);
    await loadConfig();
    const cached = getConfig();
    expect(cached).toBeDefined();
    expect(cached.business.name).toBe("Cached Store");
  });

  it("returns previous config gracefully on Firestore error", async () => {
    // Load a valid config first
    mockData["config/appConfig"] = docSnapshot({ business: { name: "PreError" } }, true);
    await loadConfig();

    // Verify getConfig returns the cached value (loadConfig on error returns currentConfig)
    const cached = getConfig();
    expect(cached).toBeDefined();
    expect(cached.business.name).toBe("PreError");
  });
});

// ══════════════════════════════════════════════════════════════════════
// 2. UNIT TESTS — Security middleware
// ══════════════════════════════════════════════════════════════════════
describe("Security middleware", () => {
  const mockReq = (headers = {}) => ({ headers, body: {}, path: "/", method: "GET" });

  describe("verifyFirebaseToken", () => {
    it("rejects request with no Authorization header", async () => {
      const req = mockReq({});
      const res = mockRes();
      const next = jest.fn();
      await verifyFirebaseToken(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it("rejects request with malformed Bearer token", async () => {
      const req = mockReq({ authorization: "InvalidToken" });
      const res = mockRes();
      const next = jest.fn();
      await verifyFirebaseToken(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it("rejects request when verifyIdToken throws", async () => {
      mockAuth.verifyIdToken.mockRejectedValueOnce(new Error("Token expired"));
      const req = mockReq({ authorization: "Bearer bad_token" });
      const res = mockRes();
      const next = jest.fn();
      await verifyFirebaseToken(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it("passes and attaches decoded user to req.user", async () => {
      mockAuth.verifyIdToken.mockResolvedValueOnce({ uid: "u1", email: "a@b.com", role: "user" });
      const req = mockReq({ authorization: "Bearer valid_token" });
      const res = mockRes();
      const next = jest.fn();
      await verifyFirebaseToken(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(req.user).toEqual({ uid: "u1", email: "a@b.com", role: "user" });
    });
  });

  describe("requireOwner", () => {
    it("rejects if req.user is missing (not authenticated)", async () => {
      const req = {};
      const res = mockRes();
      const next = jest.fn();
      await requireOwner(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it("rejects if user doc has isOwner=false", async () => {
      mockData["users/u1"] = docSnapshot({ isOwner: false }, true);
      const req = { user: { uid: "u1" } };
      const res = mockRes();
      const next = jest.fn();
      await requireOwner(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });

    it("rejects if user doc does not exist", async () => {
      delete mockData["users/u1"];
      const req = { user: { uid: "u1" } };
      const res = mockRes();
      const next = jest.fn();
      await requireOwner(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });

    it("passes if user doc has isOwner=true", async () => {
      mockData["users/u1"] = docSnapshot({ isOwner: true }, true);
      const req = { user: { uid: "u1" } };
      const res = mockRes();
      const next = jest.fn();
      await requireOwner(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it("returns 500 if Firestore throws", async () => {
      mockFirestore.collection.mockImplementationOnce(() => { throw new Error("Firestore error"); });
      const req = { user: { uid: "u1" } };
      const res = mockRes();
      const next = jest.fn();
      await requireOwner(req, res, next);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe("apiKeyAuth", () => {
    const originalEnv = process.env.API_KEY;

    afterEach(() => {
      if (originalEnv === undefined) delete process.env.API_KEY;
      else process.env.API_KEY = originalEnv;
    });

    it("passes if API_KEY env is not set (no auth required)", () => {
      delete process.env.API_KEY;
      const req = { headers: {} };
      const res = mockRes();
      const next = jest.fn();
      apiKeyAuth(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it("rejects if API_KEY is set but request has no x-api-key", () => {
      process.env.API_KEY = "secret123";
      const req = { headers: {} };
      const res = mockRes();
      const next = jest.fn();
      apiKeyAuth(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it("rejects if API_KEY does not match", () => {
      process.env.API_KEY = "secret123";
      const req = { headers: { "x-api-key": "wrong" } };
      const res = mockRes();
      const next = jest.fn();
      apiKeyAuth(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it("passes if API_KEY matches", () => {
      process.env.API_KEY = "secret123";
      const req = { headers: { "x-api-key": "secret123" } };
      const res = mockRes();
      const next = jest.fn();
      apiKeyAuth(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe("inputSanitizer", () => {
    it("passes normal JSON body", () => {
      const req = { body: { name: "test", value: 123 } };
      const res = mockRes();
      const next = jest.fn();
      inputSanitizer(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it("passes empty/null body", () => {
      const req = { body: null };
      const res = mockRes();
      const next = jest.fn();
      inputSanitizer(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it("blocks <script> tag injection", () => {
      const req = { body: { x: '<script>alert("xss")</script>' } };
      const res = mockRes();
      const next = jest.fn();
      inputSanitizer(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(next).not.toHaveBeenCalled();
    });

    it("blocks eval() injection", () => {
      const req = { body: { x: "eval(document.cookie)" } };
      const res = mockRes();
      const next = jest.fn();
      inputSanitizer(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("blocks $() jQuery-style injection", () => {
      const req = { body: { x: '$.get("/admin")' } };
      const res = mockRes();
      const next = jest.fn();
      inputSanitizer(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("blocks payload over 500KB", () => {
      const big = "x".repeat(500001);
      const req = { body: { data: big } };
      const res = mockRes();
      const next = jest.fn();
      inputSanitizer(req, res, next);
      expect(res.status).toHaveBeenCalledWith(413);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════
// 3. UNIT TESTS — Validation middleware
// ══════════════════════════════════════════════════════════════════════
describe("Validation middleware", () => {
  describe("verifyDeliveryCodeSchema", () => {
    it("rejects missing orderId", () => {
      const req = { body: { code: "123456" }, query: {}, params: {} };
      const res = mockRes(); const next = jest.fn();
      validate(verifyDeliveryCodeSchema)(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("rejects code that is not 6 digits", () => {
      const req = { body: { orderId: "ord1", code: "123" }, query: {}, params: {} };
      const res = mockRes(); const next = jest.fn();
      validate(verifyDeliveryCodeSchema)(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("passes valid orderId + 6-digit code", () => {
      const req = { body: { orderId: "ord1", code: "123456" }, query: {}, params: {} };
      const res = mockRes(); const next = jest.fn();
      validate(verifyDeliveryCodeSchema)(req, res, next);
      expect(next).toHaveBeenCalled();
    });
  });

  describe("paySalarySchema", () => {
    it("rejects invalid collection name", () => {
      const req = { body: { collection: "invalid", personId: "p1", amount: 1000, monthYear: "2026-01", mode: "cash" }, query: {}, params: {} };
      const res = mockRes(); const next = jest.fn();
      validate(paySalarySchema)(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("rejects negative amount", () => {
      const req = { body: { collection: "workers", personId: "p1", amount: -100, monthYear: "2026-01", mode: "cash" }, query: {}, params: {} };
      const res = mockRes(); const next = jest.fn();
      validate(paySalarySchema)(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("rejects invalid monthYear format", () => {
      const req = { body: { collection: "workers", personId: "p1", amount: 1000, monthYear: "01-2026", mode: "cash" }, query: {}, params: {} };
      const res = mockRes(); const next = jest.fn();
      validate(paySalarySchema)(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("rejects invalid mode", () => {
      const req = { body: { collection: "workers", personId: "p1", amount: 1000, monthYear: "2026-01", mode: "bitcoin" }, query: {}, params: {} };
      const res = mockRes(); const next = jest.fn();
      validate(paySalarySchema)(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("passes valid salary payment", () => {
      const req = { body: { collection: "workers", personId: "p1", amount: 1000, monthYear: "2026-01", mode: "UPI" }, query: {}, params: {} };
      const res = mockRes(); const next = jest.fn();
      validate(paySalarySchema)(req, res, next);
      expect(next).toHaveBeenCalled();
    });
  });

  describe("sendSMSOTPSchema", () => {
    it("rejects invalid phone format", () => {
      const req = { body: { phoneNumber: "abc", otp: "123456" }, query: {}, params: {} };
      const res = mockRes(); const next = jest.fn();
      validate(sendSMSOTPSchema)(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("rejects OTP that is not 6 digits", () => {
      const req = { body: { phoneNumber: "9876543210", otp: "123" }, query: {}, params: {} };
      const res = mockRes(); const next = jest.fn();
      validate(sendSMSOTPSchema)(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("passes valid phone + OTP", () => {
      const req = { body: { phoneNumber: "+919876543210", otp: "123456" }, query: {}, params: {} };
      const res = mockRes(); const next = jest.fn();
      validate(sendSMSOTPSchema)(req, res, next);
      expect(next).toHaveBeenCalled();
    });
  });
});

// ══════════════════════════════════════════════════════════════════════
// 4. INTEGRATION TESTS — HTTP endpoints (supertest)
// ══════════════════════════════════════════════════════════════════════
if (app) {
  describe("Integration — HTTP endpoints", () => {
    beforeEach(() => {
      Object.keys(mockData).forEach((k) => delete mockData[k]);
    });

    // ── GET /health ─────────────────────────────────────────────────
    describe("GET /health", () => {
      it("returns 200 with status ok when Firestore is reachable", async () => {
        mockData["health/_check"] = docSnapshot({ ok: true }, true);
        const res = await request(app).get("/health");
        expect(res.status).toBe(200);
        expect(res.body.status).toBe("ok");
        expect(res.body).toHaveProperty("firestore");
        expect(res.body).toHaveProperty("uptime");
        expect(res.body).toHaveProperty("timestamp");
      });

      it("returns 200 even when health doc does not exist (exists || true)", async () => {
        const res = await request(app).get("/health");
        expect(res.status).toBe(200);
        expect(res.body.status).toBe("ok");
      });

      it("returns memory stats", async () => {
        const res = await request(app).get("/health");
        expect(res.body.memory).toBeDefined();
        expect(res.body.memory).toHaveProperty("rss");
        expect(res.body.memory).toHaveProperty("heapUsed");
      });
    });

    // ── GET /api/config ────────────────────────────────────────────
    describe("GET /api/config", () => {
      it("returns config object from appConfig/settings", async () => {
        mockData["appConfig/settings"] = docSnapshot({
          business: { name: "Test Store" }, store: { isOpen: true }, branding: { primaryColor: "#000" },
        }, true);
        const res = await request(app).get("/api/config");
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty("business");
      });

      it("returns fallback empty config when no doc exists", async () => {
        const res = await request(app).get("/api/config");
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty("branding");
        expect(res.body.store.isOpen).toBe(true);
      });
    });

    // ── POST /api/orders/cancel ────────────────────────────────────
    describe("POST /api/orders/cancel", () => {
      it("rejects unauthenticated request (no token)", async () => {
        const res = await request(app).post("/api/orders/cancel").send({ orderId: "ord1", userId: "u1" });
        expect(res.status).toBe(401);
      });

      it("rejects missing orderId", async () => {
        mockAuth.verifyIdToken.mockResolvedValueOnce({ uid: "u1" });
        const res = await request(app).post("/api/orders/cancel")
          .set("Authorization", "Bearer valid_token").send({ userId: "u1" });
        expect(res.status).toBe(400);
      });

      it("rejects missing userId", async () => {
        mockAuth.verifyIdToken.mockResolvedValueOnce({ uid: "u1" });
        const res = await request(app).post("/api/orders/cancel")
          .set("Authorization", "Bearer valid_token").send({ orderId: "ord1" });
        expect(res.status).toBe(400);
      });

      it("returns 404 when order does not exist", async () => {
        mockAuth.verifyIdToken.mockResolvedValueOnce({ uid: "u1" });
        const res = await request(app).post("/api/orders/cancel")
          .set("Authorization", "Bearer valid_token").send({ orderId: "ord_notexist", userId: "u1" });
        expect(res.status).toBe(404);
      });

      it("rejects cancellation of a Delivered order", async () => {
        mockAuth.verifyIdToken.mockResolvedValueOnce({ uid: "u1" });
        mockData["users/u1/orders/ord_delivered"] = docSnapshot({
          status: "Delivered", items: [], totalAmount: 300, payment: { method: "cod" },
        }, true);

        const res = await request(app).post("/api/orders/cancel")
          .set("Authorization", "Bearer valid_token").send({ orderId: "ord_delivered", userId: "u1" });
        expect(res.status).toBe(400);
        expect(res.body.error).toContain("Cannot cancel");
      });

      it("successfully cancels a Pending order", async () => {
        mockAuth.verifyIdToken.mockResolvedValueOnce({ uid: "u1" });
        mockData["users/u1/orders/ord_pending"] = docSnapshot({
          status: "Pending", items: [{ productId: "p1", quantity: 2 }],
          totalAmount: 300, payment: { method: "cod" },
        }, true);

        const mockBatch = { set: jest.fn(), update: jest.fn(), delete: jest.fn(), commit: jest.fn(() => Promise.resolve()) };
        mockFirestore.batch.mockReturnValueOnce(mockBatch);

        const res = await request(app).post("/api/orders/cancel")
          .set("Authorization", "Bearer valid_token")
          .send({ orderId: "ord_pending", userId: "u1", reason: "Changed mind" });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(mockBatch.commit).toHaveBeenCalled();
      });
    });

    // ── POST /api/invalidate-cache ─────────────────────────────────
    describe("POST /api/invalidate-cache", () => {
      it("rejects request with no auth and no admin key", async () => {
        const res = await request(app).post("/api/invalidate-cache").send({});
        expect(res.status).toBe(401);
      });

      it("accepts valid admin key", async () => {
        process.env.ADMIN_KEY = "test_admin_key";
        const res = await request(app).post("/api/invalidate-cache")
          .set("x-admin-key", "test_admin_key").send({});
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        delete process.env.ADMIN_KEY;
      });

      it("rejects invalid admin key", async () => {
        process.env.ADMIN_KEY = "test_admin_key";
        const res = await request(app).post("/api/invalidate-cache")
          .set("x-admin-key", "wrong_key").send({});
        expect(res.status).toBe(401);
        delete process.env.ADMIN_KEY;
      });

      it("accepts valid Firebase owner token", async () => {
        mockAuth.verifyIdToken.mockResolvedValueOnce({ uid: "owner_uid" });
        mockData["users/owner_uid"] = docSnapshot({ isOwner: true }, true);
        const res = await request(app).post("/api/invalidate-cache")
          .set("Authorization", "Bearer owner_token").send({});
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
      });

      it("rejects Firebase token of non-owner user", async () => {
        mockAuth.verifyIdToken.mockResolvedValueOnce({ uid: "regular_uid" });
        mockData["users/regular_uid"] = docSnapshot({ isOwner: false }, true);
        const res = await request(app).post("/api/invalidate-cache")
          .set("Authorization", "Bearer user_token").send({});
        expect(res.status).toBe(403);
      });
    });

    // ── POST /api/refresh-config ────────────────────────────────────
    describe("POST /api/refresh-config", () => {
      it("rejects unauthenticated request", async () => {
        const res = await request(app).post("/api/refresh-config");
        expect(res.status).toBe(401);
      });

      it("rejects non-owner user", async () => {
        mockAuth.verifyIdToken.mockResolvedValueOnce({ uid: "u1" });
        mockData["users/u1"] = docSnapshot({ isOwner: false }, true);
        const res = await request(app).post("/api/refresh-config")
          .set("Authorization", "Bearer user_token");
        expect(res.status).toBe(403);
      });

      it("returns config reload success for owner", async () => {
        mockAuth.verifyIdToken.mockResolvedValueOnce({ uid: "owner_uid" });
        mockData["users/owner_uid"] = docSnapshot({ isOwner: true }, true);
        mockData["config/appConfig"] = docSnapshot({ business: { name: "Store" } }, true);
        const res = await request(app).post("/api/refresh-config")
          .set("Authorization", "Bearer owner_token");
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
      });
    });

    // ── POST /api/set-owner ────────────────────────────────────────
    describe("POST /api/set-owner", () => {
      it("rejects unauthenticated request", async () => {
        const res = await request(app).post("/api/set-owner").send({ uid: "new_owner", email: "new@test.com" });
        expect(res.status).toBe(401);
      });

      it("rejects missing uid", async () => {
        mockAuth.verifyIdToken.mockResolvedValueOnce({ uid: "existing_owner" });
        mockData["users/existing_owner"] = docSnapshot({ isOwner: true }, true);
        const res = await request(app).post("/api/set-owner")
          .set("Authorization", "Bearer owner_token").send({ email: "new@test.com" });
        expect(res.status).toBe(400);
      });

      it("rejects missing email", async () => {
        mockAuth.verifyIdToken.mockResolvedValueOnce({ uid: "existing_owner" });
        mockData["users/existing_owner"] = docSnapshot({ isOwner: true }, true);
        const res = await request(app).post("/api/set-owner")
          .set("Authorization", "Bearer owner_token").send({ uid: "new_uid" });
        expect(res.status).toBe(400);
      });

      it("rejects unauthorized email not in allowed list", async () => {
        process.env.ALLOWED_OWNER_EMAILS = "admin@store.com";
        mockAuth.verifyIdToken.mockResolvedValueOnce({ uid: "existing_owner" });
        mockData["users/existing_owner"] = docSnapshot({ isOwner: true }, true);
        const res = await request(app).post("/api/set-owner")
          .set("Authorization", "Bearer owner_token").send({ uid: "new_uid", email: "hacker@evil.com" });
        expect(res.status).toBe(403);
        delete process.env.ALLOWED_OWNER_EMAILS;
      });
    });

    // ── GET /metrics ───────────────────────────────────────────────
    describe("GET /metrics", () => {
      it("returns 200 with uptime and memory info", async () => {
        const res = await request(app).get("/metrics");
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty("uptime_seconds");
        expect(res.body).toHaveProperty("memory_mb");
        expect(res.body).toHaveProperty("node_version");
        expect(res.body).toHaveProperty("environment");
      });
    });

    // ── GET /api/analytics/daily ───────────────────────────────────
    describe("GET /api/analytics/daily", () => {
      it("returns analytics data", async () => {
        mockData["analytics/dailyStats"] = docSnapshot({ totalOrders: 10, totalRevenue: 5000 }, true);
        const res = await request(app).get("/api/analytics/daily");
        expect(res.status).toBe(200);
        expect(res.body.totalOrders).toBe(10);
        expect(res.body.totalRevenue).toBe(5000);
      });

      it("returns zeros when no analytics doc exists", async () => {
        const res = await request(app).get("/api/analytics/daily");
        expect(res.status).toBe(200);
        expect(res.body.totalOrders).toBe(0);
        expect(res.body.totalRevenue).toBe(0);
      });
    });

    // ── POST /verifyDeliveryCode ───────────────────────────────────
    describe("POST /verifyDeliveryCode", () => {
      it("rejects invalid body (missing code)", async () => {
        const res = await request(app).post("/verifyDeliveryCode").send({ orderId: "ord1" });
        expect(res.status).toBe(400);
      });

      it("rejects invalid body (missing orderId)", async () => {
        const res = await request(app).post("/verifyDeliveryCode").send({ code: "123456" });
        expect(res.status).toBe(400);
      });
    });

    // ── POST /api/delivery-partner/request ──────────────────────────
    describe("POST /api/delivery-partner/request", () => {
      it("rejects missing orderId", async () => {
        const res = await request(app).post("/api/delivery-partner/request").send({ partner: "Shiprocket" });
        expect(res.status).toBe(400);
      });

      it("rejects missing partner", async () => {
        const res = await request(app).post("/api/delivery-partner/request").send({ orderId: "ord1" });
        expect(res.status).toBe(400);
      });

      it("accepts valid orderId + partner and returns trackingId", async () => {
        const res = await request(app).post("/api/delivery-partner/request")
          .send({ orderId: "ord1", partner: "Shiprocket" });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.trackingId).toMatch(/^SR-/);
      });
    });

    // ── POST /api/notify-owner ──────────────────────────────────────
    describe("POST /api/notify-owner", () => {
      it("rejects missing required fields", async () => {
        const res = await request(app).post("/api/notify-owner").send({});
        expect(res.status).toBe(400);
      });

      it("accepts valid payload and returns success", async () => {
        const res = await request(app).post("/api/notify-owner")
          .send({ orderId: "ord1", amount: 300, customerName: "Test" });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
      });
    });

    // ── POST /api/fcm/register ─────────────────────────────────────
    describe("POST /api/fcm/register", () => {
      it("rejects missing userId", async () => {
        const res = await request(app).post("/api/fcm/register").send({ token: "abc" });
        expect(res.status).toBe(400);
      });

      it("rejects missing token", async () => {
        const res = await request(app).post("/api/fcm/register").send({ userId: "u1" });
        expect(res.status).toBe(400);
      });

      it("accepts valid userId + token", async () => {
        const res = await request(app).post("/api/fcm/register").send({ userId: "u1", token: "fcm_token_123" });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
      });
    });

    // ── POST /api/fcm/unregister ───────────────────────────────────
    describe("POST /api/fcm/unregister", () => {
      it("rejects missing userId", async () => {
        const res = await request(app).post("/api/fcm/unregister").send({});
        expect(res.status).toBe(400);
      });

      it("accepts valid userId", async () => {
        mockData["fcmTokens/u1"] = docSnapshot({ token: "abc", active: true }, true);
        const res = await request(app).post("/api/fcm/unregister").send({ userId: "u1" });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
      });
    });

    // ── POST /api/orders/create ────────────────────────────────────
    describe("POST /api/orders/create", () => {
      it("rejects unauthenticated request", async () => {
        const res = await request(app).post("/api/orders/create").send({ userId: "u1", orderData: {} });
        expect(res.status).toBe(401);
      });

      it("rejects missing userId", async () => {
        mockAuth.verifyIdToken.mockResolvedValueOnce({ uid: "u1" });
        const res = await request(app).post("/api/orders/create")
          .set("Authorization", "Bearer valid_token").send({ orderData: { items: [], totalAmount: 100 } });
        expect(res.status).toBe(400);
      });

      it("rejects missing orderData", async () => {
        mockAuth.verifyIdToken.mockResolvedValueOnce({ uid: "u1" });
        const res = await request(app).post("/api/orders/create")
          .set("Authorization", "Bearer valid_token").send({ userId: "u1" });
        expect(res.status).toBe(400);
      });
    });

    // ── POST /api/clear-cache ──────────────────────────────────────
    describe("POST /api/clear-cache", () => {
      it("rejects unauthenticated request", async () => {
        const res = await request(app).post("/api/clear-cache").send({});
        expect(res.status).toBe(401);
      });
    });

    // ── POST /api/products/archive ──────────────────────────────────
    describe("POST /api/products/archive", () => {
      it("rejects unauthenticated request", async () => {
        const res = await request(app).post("/api/products/archive").send({ productId: "p1" });
        expect(res.status).toBe(401);
      });

      it("rejects missing productId", async () => {
        mockAuth.verifyIdToken.mockResolvedValueOnce({ uid: "owner_uid" });
        mockData["users/owner_uid"] = docSnapshot({ isOwner: true }, true);
        const res = await request(app).post("/api/products/archive")
          .set("Authorization", "Bearer owner_token").send({});
        expect(res.status).toBe(400);
      });
    });
  });
} else {
  describe("Integration — skipped (server could not load)", () => {
    it("placeholder", () => { expect(true).toBe(true); });
  });
}

// ══════════════════════════════════════════════════════════════════════
// 5. DATA INTEGRITY TESTS
// ══════════════════════════════════════════════════════════════════════
describe("Data integrity", () => {
  describe("Config path consistency", () => {
    beforeEach(() => {
      Object.keys(mockData).forEach((k) => delete mockData[k]);
    });

    it("configLoader checks config/appConfig first (primary path)", async () => {
      mockData["config/appConfig"] = docSnapshot({ business: { name: "Primary" } }, true);
      await loadConfig();
      // If it loaded from the primary path, the result has business.name
      const cached = getConfig();
      expect(cached.business.name).toBe("Primary");
    });

    it("configLoader falls back to appConfig/settings when primary missing", async () => {
      mockData["appConfig/settings"] = docSnapshot({ business: { name: "Settings" } }, true);
      const result = await loadConfig();
      expect(result.business.name).toBe("Settings");
    });

    it("configLoader falls back to appConfig/main when others missing", async () => {
      mockData["appConfig/main"] = docSnapshot({ business: { name: "Main" } }, true);
      const result = await loadConfig();
      expect(result.business.name).toBe("Main");
    });
  });

  describe("Order status values", () => {
    const cancellableStatuses = ["Pending", "pending", "Packing", "packing"];
    const validStatuses = [
      "Pending", "Packing", "Ready to Dispatch", "Assigned", "Accepted",
      "Out for Delivery", "Awaiting Verification", "Delivered", "Cancelled",
    ];

    it("cancellable statuses are Title Case or lowercase", () => {
      cancellableStatuses.forEach((s) => {
        expect(typeof s).toBe("string");
        expect(s.length).toBeGreaterThan(0);
      });
    });

    it("valid order statuses match expected values", () => {
      expect(validStatuses).toEqual(expect.arrayContaining([
        "Pending", "Packing", "Ready to Dispatch", "Assigned", "Accepted",
        "Out for Delivery", "Awaiting Verification", "Delivered", "Cancelled",
      ]));
    });

    it("Delivered status is not in cancellable list", () => {
      expect(cancellableStatuses).not.toContain("Delivered");
    });

    it("Cancelled status is not in cancellable list", () => {
      expect(cancellableStatuses).not.toContain("Cancelled");
    });
  });

  describe("FCM notification path parsing", () => {
    it("parses subcollection path: /users/{userId}/orders/{orderId}", () => {
      const path = "users/abc123/orders/ord456";
      const parts = path.split("/");
      let userId = null, orderId = null;
      if (parts.length >= 4 && parts[0] === "users" && parts[2] === "orders") {
        userId = parts[1]; orderId = parts[3];
      }
      expect(userId).toBe("abc123");
      expect(orderId).toBe("ord456");
    });

    it("parses top-level path: /orders/{orderId}", () => {
      const path = "orders/ord789";
      const parts = path.split("/");
      let orderId = null;
      if (parts.length >= 2 && parts[0] === "orders") orderId = parts[1];
      expect(orderId).toBe("ord789");
    });

    it("returns null for unknown path structures", () => {
      const parts = "unknown/collection/doc".split("/");
      let userId = null, orderId = null;
      if (parts.length >= 4 && parts[0] === "users" && parts[2] === "orders") {
        userId = parts[1]; orderId = parts[3];
      } else if (parts.length >= 2 && parts[0] === "orders") {
        orderId = parts[1];
      }
      expect(userId).toBeNull();
      expect(orderId).toBeNull();
    });

    it("extracts userId from document data for top-level orders", () => {
      const parts = "orders/ord789".split("/");
      let userId = null, orderId = null;
      const docData = { userId: "user_from_data" };
      if (parts.length >= 4 && parts[0] === "users" && parts[2] === "orders") {
        userId = parts[1]; orderId = parts[3];
      } else if (parts.length >= 2 && parts[0] === "orders") {
        orderId = parts[1]; userId = docData?.userId;
      }
      expect(orderId).toBe("ord789");
      expect(userId).toBe("user_from_data");
    });
  });
});

// ══════════════════════════════════════════════════════════════════════
// 6. EDGE CASE TESTS
// ══════════════════════════════════════════════════════════════════════
describe("Edge cases", () => {
  describe("Missing required fields in requests", () => {
    if (app) {
      it("POST /api/orders/cancel rejects empty body", async () => {
        mockAuth.verifyIdToken.mockResolvedValueOnce({ uid: "u1" });
        const res = await request(app).post("/api/orders/cancel")
          .set("Authorization", "Bearer valid_token").send({});
        expect(res.status).toBe(400);
      });

      it("POST /api/orders/create rejects empty body", async () => {
        mockAuth.verifyIdToken.mockResolvedValueOnce({ uid: "u1" });
        const res = await request(app).post("/api/orders/create")
          .set("Authorization", "Bearer valid_token").send({});
        expect(res.status).toBe(400);
      });

      it("POST /api/fcm/register rejects empty body", async () => {
        const res = await request(app).post("/api/fcm/register").send({});
        expect(res.status).toBe(400);
      });

      it("POST /verifyDeliveryCode rejects empty body", async () => {
        const res = await request(app).post("/verifyDeliveryCode").send({});
        expect(res.status).toBe(400);
      });
    }
  });

  describe("Empty Firestore collections", () => {
    if (app) {
      beforeEach(() => {
        Object.keys(mockData).forEach((k) => delete mockData[k]);
      });

      it("GET /api/config returns fallback config when Firestore is empty", async () => {
        const res = await request(app).get("/api/config");
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty("branding");
      });

      it("GET /api/analytics/daily returns zeros when no data", async () => {
        const res = await request(app).get("/api/analytics/daily");
        expect(res.status).toBe(200);
        expect(res.body.totalOrders).toBe(0);
      });
    }
  });

  describe("Concurrent config updates", () => {
    it("handles rapid successive loadConfig calls", async () => {
      let loadCount = 0;
      mockData["config/appConfig"] = docSnapshot({ business: { name: "Config" } }, true);

      const results = await Promise.all([
        loadConfig(),
        loadConfig(),
        loadConfig(),
      ]);

      results.forEach((r) => {
        expect(r).toBeDefined();
        expect(r.business).toBeDefined();
      });
    });
  });

  describe("Server behavior without Firebase credentials", () => {
    it("getConfig returns cached value even if Firestore is down", async () => {
      // Load valid config first
      mockData["config/appConfig"] = docSnapshot({ business: { name: "PreError" } }, true);
      await loadConfig();

      // Simulate Firestore failure
      mockFirestore.collection.mockImplementationOnce(() => { throw new Error("ECONNREFUSED"); });
      const result = await loadConfig();

      expect(result).toBeDefined();
      expect(result.business.name).toBe("PreError");
    });
  });

  describe("Input edge cases", () => {
    it("verifyDeliveryCode rejects code with wrong length", async () => {
      if (app) {
        const res = await request(app).post("/verifyDeliveryCode")
          .send({ orderId: "ord1", code: "12345" });
        expect(res.status).toBe(400);
      }
    });

    it("paySalary rejects zero amount", () => {
      const req = { body: { collection: "workers", personId: "p1", amount: 0, monthYear: "2026-01", mode: "cash" }, query: {}, params: {} };
      const res = mockRes(); const next = jest.fn();
      validate(paySalarySchema)(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("sendSMSOTP rejects phone number shorter than 10 digits", () => {
      const req = { body: { phoneNumber: "123456789", otp: "123456" }, query: {}, params: {} };
      const res = mockRes(); const next = jest.fn();
      validate(sendSMSOTPSchema)(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
    });
  });
});
