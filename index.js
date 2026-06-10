require("dotenv").config();

const express = require("express");
const compression = require("compression");
const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");
const crypto = require("crypto");
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const {
  corsMiddleware,
  helmetMiddleware,
  generalLimiter,
  apiKeyAuth,
  inputSanitizer,
  verifyFirebaseToken,
  requireOwner,
} = require("./middleware/security");

const {
  validate,
  verifyDeliveryCodeSchema,
  dispatchToThirdPartySchema,
  thirdPartyWebhookSchema,
  paySalarySchema,
  createOrderSchema,
  createRazorpayOrderSchema,
  verifyPaymentSchema,
  sendOTPFcmSchema,
  verifyOTPSchema,
} = require("./middleware/validation");

const { logger, morganMiddleware, errorHandler, logErrorToFirestore } = require("./middleware/logging");

// ─── Initialize Firebase Admin ───
if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
  const serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8")
  );
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  logger.info("Firebase Admin initialized from environment variable");
} else {
  try {
    const serviceAccount = require("./serviceAccountKey.json");
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    logger.info("Firebase Admin initialized from local JSON file");
  } catch (err) {
    logger.error("Failed to initialize Firebase Admin. Provide FIREBASE_SERVICE_ACCOUNT_BASE64 or serviceAccountKey.json");
    process.exit(1);
  }
}

const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

const NodeCache = require("node-cache");
const productCache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5 min TTL

const otpCache = new Map(); // key: phoneNumber, value: { code, userId, expiresAt, attempts }
const OTP_TTL = 5 * 60 * 1000; // 5 minutes
const OTP_MAX_ATTEMPTS = 3;
const OTP_LENGTH = 4;

function generateOTP() {
  let code = "";
  for (let i = 0; i < OTP_LENGTH; i++) {
    code += Math.floor(Math.random() * 10).toString();
  }
  return code;
}

function cleanExpiredOTPs() {
  const now = Date.now();
  for (const [phone, data] of otpCache) {
    if (now > data.expiresAt) otpCache.delete(phone);
  }
}
setInterval(cleanExpiredOTPs, 60000);

const { loadConfig: reloadConfig, getConfig } = require("./services/configLoader");
const { dispatch: dispatchToPartner, track: trackOrder, handleWebhook } = require("./services/deliveryPartner");
const { validatePincode } = require("./services/pincodeValidator");

const app = express();
const PORT = process.env.PORT || 3000;
const startTime = Date.now();

// ─── Middleware ───
app.use(compression());
app.use(helmetMiddleware);
app.use(corsMiddleware);
app.use(express.json({ limit: "1mb" }));
app.use(inputSanitizer);
app.use(morganMiddleware);
app.use(generalLimiter);

// ─── Cache control helper ───
function cacheControl(duration) {
  return (req, res, next) => {
    res.set("Cache-Control", `public, max-age=${duration}, s-maxage=${duration}`);
    next();
  };
}

// ─── FCM Helpers with retry ───
async function sendFCMToTokenWithRetry(token, title, body, data = {}, retries = 2) {
  if (!token) {
    logger.warn("FCM: no token provided");
    return null;
  }
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await admin.messaging().send({
        token,
        notification: { title, body },
        data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v ?? "")])),
      });
      logger.debug(`FCM sent to ${token.substring(0, 10)}... (attempt ${attempt + 1})`);
      return result;
    } catch (err) {
      const isLast = attempt === retries;
      logger.warn(`FCM attempt ${attempt + 1}/${retries + 1} failed for ${token.substring(0, 10)}...: ${err.code || err.message}`);
      if (isLast) {
        logger.error(`FCM exhausted retries for token`, { token: token.substring(0, 10) });
        if (err.code === "messaging/registration-token-not-registered") {
          logger.warn(`Token not registered, consider removing: ${token.substring(0, 10)}`);
        }
        return null;
      }
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
}

async function sendFCMToTokens(tokens, title, body, data = {}) {
  if (tokens.length === 0) return;
  const results = await Promise.allSettled(
    tokens.map((t) => sendFCMToTokenWithRetry(t, title, body, data))
  );
  const failures = results.filter((r) => r.status === "rejected").length;
  if (failures > 0) logger.warn(`FCM multicast: ${failures}/${tokens.length} failed`);
}

// ─── Firestore Listeners (debounced) ───
let listeners = [];

function debounce(fn, ms = 1000) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function startListeners() {
  // 1. New pending orders → notify workers
  const unsubOrders = db.collectionGroup("orders").onSnapshot(
    (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type !== "added") return;
        const order = change.doc.data();
        if (!order || order.status !== "Pending") return;
        try {
          const workersSnap = await db.collection("workers").where("active", "==", true).limit(50).get();
          const tokens = [];
          workersSnap.forEach((doc) => {
            const token = doc.data().fcmToken;
            if (token) tokens.push(token);
          });
          if (tokens.length > 0) {
            await sendFCMToTokens(tokens, "New Order", "New order pending! Claim it now.", {
              type: "new_order",
              orderId: change.doc.id,
            });
          }
        } catch (err) {
          logErrorToFirestore(err);
        }
      });
    },
    (err) => logger.error("Orders listener error:", err)
  );
  listeners.push(unsubOrders);

  // 2+3. Order status changes → notify customer + OTP generation (combined)
  const unsubCombinedStatus = db.collectionGroup("orders").onSnapshot(
    (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type !== "modified") return;
        const order = change.doc.data();
        if (!order) return;
        const newStatus = order?.status;
        if (!newStatus) return;

        // Parse Firestore document path to extract userId and orderId
        const pathParts = change.doc.ref.path.split("/");
        let userId = null;
        let orderId = null;

        // Case 1: Nested subcollection path: /users/{userId}/orders/{orderId}
        if (pathParts.length >= 4 && pathParts[0] === "users" && pathParts[2] === "orders") {
          userId = pathParts[1];
          orderId = pathParts[3];
        }
        // Case 2: Top-level collection path: /orders/{orderId}
        else if (pathParts.length >= 2 && pathParts[0] === "orders") {
          orderId = pathParts[1];
          userId = (change.doc.data())?.userId; // Extract userId from document data
        }
        // Case 3: Unknown path structure - log and skip
        else {
          console.warn(`[Firestore] Unknown path structure: ${change.doc.ref.path}`);
          return;
        }

        if (!orderId) {
          console.warn(`[Firestore] Could not extract orderId from path: ${change.doc.ref.path}`);
          return;
        }

        // --- Part A: Notify customer on status transitions ---
        const triggerStatuses = ["Packing", "Out for Delivery", "Delivered"];
        if (triggerStatuses.includes(newStatus)) {
          try {
            const userDoc = await db.collection("users").doc(userId).get();
            const fcmToken = userDoc.data()?.fcmToken;
            if (fcmToken) {
              const body = newStatus === "Packing" ? "Your order is being packed!"
                : newStatus === "Out for Delivery" ? "Your order is out for delivery!"
                : "Your order has been delivered!";
              await sendFCMToTokenWithRetry(fcmToken, "Order Update", body, {
                type: "order_status", orderId, status: newStatus,
              });
            }
          } catch (err) {
            logErrorToFirestore(err);
          }
        }

        // --- Part B: Generate OTP when status becomes "Awaiting Verification" ---
        if (newStatus === "Awaiting Verification" && !order.verificationCode) {
          const code = Math.floor(1000 + Math.random() * 9000).toString();
          try {
            await change.doc.ref.update({ verificationCode: code });
            const userDoc = await db.collection("users").doc(userId).get();
            const fcmToken = userDoc.data()?.fcmToken;
            if (fcmToken) {
              await sendFCMToTokenWithRetry(fcmToken, "Delivery Verification", `Your OTP is: ${code}`, {
                type: "delivery_otp", orderId, code,
              });
            }
            logger.info(`OTP ${code} generated for order ${orderId}`);
          } catch (err) {
            logErrorToFirestore(err);
          }
        }
      });
    },
    (err) => logger.error("Combined status listener error:", err)
  );
  listeners.push(unsubCombinedStatus);

  // 4. Low stock → notify owner (debounced)
  const debouncedLowStock = debounce(async (productId, product) => {
    try {
      const infoSnap = await db.collection("contactInfo").doc("info").get();
      const ownerFcmToken = infoSnap.data()?.ownerFcmToken;
      if (ownerFcmToken) {
        await sendFCMToTokenWithRetry(ownerFcmToken, "Low Stock Alert",
          `${product.name || "Product"} is low (${product.stock ?? 0} left)`,
          { type: "low_stock", productId });
      }
    } catch (err) {
      logErrorToFirestore(err);
    }
  }, 5000);

  const unsubStock = db.collection("products").onSnapshot(
    (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type !== "modified" && change.type !== "added") return;
        const product = change.doc.data();
        if (!product) return;
        const stock = product.stock ?? 0;
        const threshold = product.lowStockThreshold ?? 5;
        if (stock >= threshold) return;
        debouncedLowStock(change.doc.id, product);
      });
    },
    (err) => logger.error("Stock listener error:", err)
  );
  listeners.push(unsubStock);

  // 5. New basket → notify delivery boy
  const unsubBasket = db.collectionGroup("basket").onSnapshot(
    (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type !== "added") return;
        const basket = change.doc.data();
        if (!basket) return;
        const dboyId = change.doc.ref.path.split("/")[1];
        try {
          const dboyDoc = await db.collection("deliveryBoys").doc(dboyId).get();
          const fcmToken = dboyDoc.data()?.fcmToken;
          if (fcmToken) {
            await sendFCMToTokenWithRetry(fcmToken, "New Delivery Basket",
              `${basket.orders?.length ?? 0} order(s) assigned`,
              { type: "new_basket", basketId: change.doc.id });
          }
        } catch (err) {
          logErrorToFirestore(err);
        }
      });
    },
    (err) => logger.error("Basket listener error:", err)
  );
  listeners.push(unsubBasket);

  // 6. New support ticket → notify owner
  const lastKnownContactIds = new Set();
  const unsubNewContact = db.collection("contacts").onSnapshot(
    (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type !== "added") return;
        const contact = change.doc.data();
        if (!contact) return;
        const contactId = change.doc.id;
        if (lastKnownContactIds.has(contactId)) return;
        lastKnownContactIds.add(contactId);
        try {
          const infoSnap = await db.collection("contactInfo").doc("info").get();
          const ownerFcmToken = infoSnap.data()?.ownerFcmToken;
          if (ownerFcmToken) {
            await sendFCMToTokenWithRetry(ownerFcmToken, "New Support Ticket",
              `${contact.name || "Customer"}: ${contact.subject || "New complaint"}`,
              { type: "new_ticket", contactId });
          }
        } catch (err) {
          logErrorToFirestore(err);
        }
      });
    },
    (err) => logger.error("Contact listener error:", err)
  );
  listeners.push(unsubNewContact);

  // 7. Ticket reply → notify other party
  const lastKnownReplyCounts = {};
  const unsubContactReply = db.collection("contacts").onSnapshot(
    (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type !== "modified") return;
        const contact = change.doc.data();
        if (!contact || !contact.replies) return;
        const contactId = change.doc.id;
        const currentCount = contact.replies.length;
        const prevCount = lastKnownReplyCounts[contactId] || 0;
        lastKnownReplyCounts[contactId] = currentCount;
        if (currentCount <= prevCount) return;
        const lastReply = contact.replies[currentCount - 1];
        if (!lastReply?.by) return;
        try {
          if (lastReply.by === "owner" && contact.userId) {
            const userDoc = await db.collection("users").doc(contact.userId).get();
            const fcmToken = userDoc.data()?.fcmToken;
            if (fcmToken) {
              await sendFCMToTokenWithRetry(fcmToken, "Owner Replied",
                `Reply to your ticket: ${contact.subject || "Support ticket"}`,
                { type: "ticket_reply", contactId });
            }
          } else if (lastReply.by === "customer") {
            const infoSnap = await db.collection("contactInfo").doc("info").get();
            const ownerFcmToken = infoSnap.data()?.ownerFcmToken;
            if (ownerFcmToken) {
              await sendFCMToTokenWithRetry(ownerFcmToken, "Customer Replied",
                `${contact.name || "Customer"} replied to: ${contact.subject || "Support ticket"}`,
                { type: "ticket_reply", contactId });
            }
          }
        } catch (err) {
          logErrorToFirestore(err);
        }
      });
    },
    (err) => logger.error("Reply listener error:", err)
  );
  listeners.push(unsubContactReply);

  // 8. Salary paid → notify worker / delivery boy
  const lastKnownSalaryIds = new Set();
  const unsubSalary = db.collectionGroup("salaryPayments").onSnapshot(
    (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type !== "added") return;
        const salaryId = change.doc.id;
        if (lastKnownSalaryIds.has(salaryId)) return;
        lastKnownSalaryIds.add(salaryId);
        const salary = change.doc.data();
        if (!salary) return;
        try {
          const [collection, personId] = change.doc.ref.path.split("/");
          if (!["workers", "deliveryBoys"].includes(collection)) return;
          const personDoc = await db.collection(collection).doc(personId).get();
          const fcmToken = personDoc.data()?.fcmToken;
          const name = personDoc.data()?.name || "Employee";
          if (fcmToken) {
            const label = collection === "workers" ? "Worker" : "Delivery Boy";
            await sendFCMToTokenWithRetry(fcmToken, "Salary Paid",
              `${salary.monthYear || ""}: ₹${salary.amount} credited via ${salary.mode || "cash"}`,
              { type: "salary_paid", salaryId, collection, personId });
          }
        } catch (err) {
          logErrorToFirestore(err);
        }
      });
    },
    (err) => logger.error("Salary listener error:", err)
  );
  listeners.push(unsubSalary);

  logger.info("All 8 Firestore listeners started");
}

// ─── HTTP Endpoints ───

app.get("/health", async (req, res) => {
  try {
    const testDoc = await db.collection("health").doc("_check").get();
    const firestoreOk = testDoc.exists || true;
    res.json({
      status: "ok",
      firestore: firestoreOk ? "connected" : "error",
      uptime: Math.floor((Date.now() - startTime) / 1000),
      memory: process.memoryUsage(),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({ status: "error", firestore: "disconnected", error: err.message });
  }
});

app.get("/metrics", cacheControl(30), async (req, res) => {
  const mem = process.memoryUsage();
  const metrics = {
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    memory_mb: {
      rss: Math.round(mem.rss / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
    },
    listeners_active: listeners.length,
    node_version: process.version,
    environment: process.env.NODE_ENV || "development",
    timestamp: new Date().toISOString(),
  };
  if (process.env.NODE_ENV !== "production") {
    metrics.allowed_origins = (process.env.ALLOWED_ORIGINS || "").split(",").filter(Boolean);
  }
  res.json(metrics);
});

app.post("/verifyDeliveryCode", validate(verifyDeliveryCodeSchema), async (req, res) => {
  try {
    const { orderId, code } = req.body;
    const ordersSnap = await db.collectionGroup("orders").where("__name__", "==", orderId).get();
    if (ordersSnap.empty) return res.status(404).json({ success: false, error: "Order not found" });
    const orderDoc = ordersSnap.docs[0];
    const order = orderDoc.data();
    if (order.status !== "Awaiting Verification") return res.status(400).json({ success: false, error: "Order not awaiting verification" });
    if (order.verificationCode !== code) return res.status(403).json({ success: false, error: "Invalid code" });
    await orderDoc.ref.update({ status: "Delivered", deliveredAt: FieldValue.serverTimestamp() });
    logger.info(`Order ${orderId} verified and marked delivered`);
    return res.json({ success: true, message: "Delivery verified" });
  } catch (err) {
    logErrorToFirestore(err, req);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/dispatchToThirdParty", validate(dispatchToThirdPartySchema), async (req, res) => {
  try {
    const { orderId, partner } = req.body;
    const prefix = { Shiprocket: "SR", Delhivery: "DH", Shadowfax: "SF" }[partner];
    const trackingId = `${prefix}-${Date.now()}`;
    await db.collection("delivery_partner_logs").add({
      orderId, partner, trackingId,
      status: "Dispatched",
      createdAt: FieldValue.serverTimestamp(),
    });
    const ordersSnap = await db.collectionGroup("orders").where("__name__", "==", orderId).get();
    if (!ordersSnap.empty) {
      await ordersSnap.docs[0].ref.update({ outOfCity: true, status: "Out for Delivery" });
    }
    logger.info(`Order ${orderId} dispatched via ${partner}, tracking: ${trackingId}`);
    return res.json({ success: true, trackingId, partner, status: "Dispatched" });
  } catch (err) {
    logErrorToFirestore(err, req);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/thirdPartyWebhook", apiKeyAuth, validate(thirdPartyWebhookSchema), async (req, res) => {
  try {
    const { trackingId, status, orderId } = req.body;
    const logsSnap = await db.collection("delivery_partner_logs").where("trackingId", "==", trackingId).limit(1).get();
    if (logsSnap.empty) return res.status(404).json({ error: "Tracking ID not found" });
    await logsSnap.docs[0].ref.update({ status, updatedAt: FieldValue.serverTimestamp() });
    if (status === "Delivered" && orderId) {
      const ordersSnap = await db.collectionGroup("orders").where("__name__", "==", orderId).get();
      await Promise.all(ordersSnap.docs.map((doc) =>
        doc.ref.update({ status: "Delivered", deliveredAt: FieldValue.serverTimestamp() })
      ));
    }
    logger.info(`Webhook: ${trackingId} → ${status}`);
    return res.json({ success: true });
  } catch (err) {
    logErrorToFirestore(err, req);
    return res.status(500).json({ error: err.message });
  }
});

app.post("/paySalary", verifyFirebaseToken, requireOwner, validate(paySalarySchema), async (req, res) => {
  try {
    const { collection, personId, amount, monthYear, mode } = req.body;
    await db.collection(collection).doc(personId).collection("salaryPayments").add({
      amount, monthYear, paidAt: FieldValue.serverTimestamp(), mode,
    });
    await db.collection(collection).doc(personId).update({
      totalEarnings: FieldValue.increment(amount),
    });
    logger.info(`Salary ₹${amount} paid to ${collection}/${personId} for ${monthYear}`);
    return res.json({ success: true, message: "Salary recorded" });
  } catch (err) {
    logErrorToFirestore(err, req);
    return res.status(500).json({ success: false, error: err.message });
  }
});



// ─── Analytics Aggregation Helpers ───
async function incrementDailyStats(amount, isCancelled = false) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const ref = db.collection("analytics").doc("dailyStats");
    const update = isCancelled
      ? { cancelledOrders: FieldValue.increment(1), cancelledRevenue: FieldValue.increment(amount) }
      : { totalOrders: FieldValue.increment(1), totalRevenue: FieldValue.increment(amount) };
    update.lastUpdated = FieldValue.serverTimestamp();
    await ref.set(update, { merge: true });
  } catch (err) {
    logErrorToFirestore(err);
  }
}

// ─── Migrated Next.js API Routes ───

// ─── Order Rate Limiter ───
const orderRateLimit = new Map();
function orderRateLimiter(req, res, next) {
  const userId = req.body?.userId || req.user?.uid || req.ip;
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const maxOrders = 10;
  const entry = orderRateLimit.get(userId);
  if (entry && now < entry.resetTime) {
    if (entry.count >= maxOrders) {
      return res.status(429).json({ success: false, error: "Too many orders. Please try again after 1 hour." });
    }
    entry.count++;
  } else {
    orderRateLimit.set(userId, { count: 1, resetTime: now + windowMs });
  }
  next();
}

// 1. POST /api/orders/create — COD order creation (batch write)
app.post("/api/orders/create", verifyFirebaseToken, orderRateLimiter, validate(createOrderSchema), async (req, res) => {
  try {
    const { userId, orderData, couponCode } = req.validated;
    if (!userId || !orderData) {
      return res.status(400).json({ success: false, error: "Missing user or order data" });
    }
    const orderId = `order_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const now = new Date().toISOString();

    // Reserve stock temporarily
    const stockReservations = [];
    for (const item of orderData.items || []) {
      if (item.productId) {
        const productRef = admin.firestore().collection("products").doc(item.productId);
        const productSnap = await productRef.get();
        const currentStock = productSnap.data()?.stock || 0;
        if (currentStock < (item.quantity || 1)) {
          return res.status(400).json({
            success: false,
            error: `"${item.name || 'item'}" only ${currentStock} left in stock.`,
          });
        }
        // Decrement stock
        stockReservations.push({
          ref: productRef,
          decrement: item.quantity || 1,
          name: item.name,
        });
      }
    }

    // If stock check passes, decrement
    for (const reservation of stockReservations) {
      await reservation.ref.update({
        stock: admin.firestore.FieldValue.increment(-reservation.decrement),
      });
    }

    const batch = db.batch();

    // 1. Create order document (dual: top-level + user subcollection)
    const topOrderRef = db.collection("orders").doc(orderId);
    batch.set(topOrderRef, {
      ...orderData, id: orderId,
      userId, payment: { method: "cod", status: "pending" },
      status: "Pending", createdAt: now, updatedAt: now,
    });

    const orderRef = db.collection("users").doc(userId).collection("orders").doc(orderId);
    batch.set(orderRef, {
      ...orderData, id: orderId,
      payment: { method: "cod", status: "pending" },
      status: "Pending", createdAt: now, updatedAt: now,
    });

    // 2. Create payment record
    const paymentRef = db.collection("payments").doc();
    batch.set(paymentRef, {
      method: "cod", status: "pending", amount: orderData.totalAmount || 0,
      currency: "INR", userId, orderId, createdAt: now,
    });

    // 3. Increment coupon usage
    if (couponCode) {
      const couponRef = db.collection("coupons").doc(couponCode.toUpperCase());
      batch.update(couponRef, { usedCount: FieldValue.increment(1) });
    }

    await batch.commit();
    await incrementDailyStats(orderData.totalAmount || 0);

    // After creating the order, if out of radius
    if (orderData.outOfRadius || orderData.outOfCity) {
      const config = getConfig();
      const partnerPayload = {
        orderId: topOrderRef.id,
        type: "grocery",
        serviceType: "immediate",
        sender: {
          name: config?.business?.name || "My Store",
          phone: config?.contact?.phone || "",
          address: config?.store?.location?.address || "",
          pincode: config?.store?.location?.pincode || "",
        },
        receiver: {
          name: orderData.customerName || "",
          phone: orderData.phone || "",
          address: orderData.address || "",
          pincode: orderData.pincode || "",
          coordinates: {
            lat: orderData.latitude || 0,
            lng: orderData.longitude || 0,
          },
        },
        weight: orderData.totalWeight || 1,
        paymentType: orderData.paymentMethod === "cod" ? "cod" : "prepaid",
        amountToCollect: orderData.paymentMethod === "cod" ? orderData.total : 0,
        items: (orderData.items || []).map(item => ({
          name: item.name,
          quantity: item.quantity,
          weight: item.weight || 0.5,
        })),
        createdAt: new Date().toISOString(),
      };

      // Store partner payload in order
      await topOrderRef.update({ partnerPayload });

      // Try to auto-dispatch
      try {
        const SERVER_URL = `${req.protocol}://${req.get('host')}`;
        const dispatchRes = await fetch(`${SERVER_URL}/api/dispatch-to-partner`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderId: topOrderRef.id, partnerPayload }),
        });
        const dispatchData = await dispatchRes.json();
        if (dispatchData.success) {
          await topOrderRef.update({
            thirdPartyDeliveryId: dispatchData.partnerReferenceId,
            status: "Dispatched to Partner",
          });
        }
      } catch (dispatchErr) {
        console.error("[ORDER] Auto-dispatch failed:", dispatchErr.message);
      }
    }

    logger.info(`COD order ${orderId} created for user ${userId}`);
    return res.json({ success: true, orderId });
  } catch (err) {
    logErrorToFirestore(err, req);
    return res.status(500).json({ success: false, error: err.message || "Failed to create order" });
  }
});

// 2. POST /api/razorpay/create-order — Create Razorpay order
app.post("/api/razorpay/create-order", verifyFirebaseToken, validate(createRazorpayOrderSchema), async (req, res) => {
  try {
    const { amount, receipt } = req.validated;
    const config = getConfig();
    const keyId = config?.payment?.razorpayKeyId || process.env.RAZORPAY_KEY_ID;
    const keySecret = config?.payment?.razorpayKeySecret || process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) {
      const mockId = `order_mock_${Math.random().toString(36).substring(2, 9)}`;
      return res.json({ success: true, orderId: mockId, amount, currency: "INR", message: "Mock order (Razorpay not configured)" });
    }
    const basic = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    const rpRes = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/json" },
      body: JSON.stringify({ amount: Math.round(amount * 100), currency: "INR", receipt: receipt || `receipt_${Date.now()}` }),
    });
    if (!rpRes.ok) { const t = await rpRes.text(); throw new Error(`Razorpay error: ${t}`); }
    const data = await rpRes.json();
    return res.json({ success: true, orderId: data.id, amount, currency: "INR", message: "Order initialized successfully" });
  } catch (err) {
    logErrorToFirestore(err, req);
    return res.status(500).json({ error: err.message || "Failed to initialize Razorpay order" });
  }
});

// 3. POST /api/razorpay/verify-payment — Verify signature + create order
app.post("/api/razorpay/verify-payment", verifyFirebaseToken, orderRateLimiter, validate(verifyPaymentSchema), async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, userId, orderData, couponCode } = req.validated;
    const config = getConfig();
    const secret = config?.payment?.razorpayKeySecret || process.env.RAZORPAY_KEY_SECRET;
    if (secret) {
      const hmac = crypto.createHmac("sha256", secret);
      hmac.update(`${razorpay_order_id}|${razorpay_payment_id}`);
      if (hmac.digest("hex") !== razorpay_signature) {
        return res.status(400).json({ success: false, error: "Invalid payment signature" });
      }
    }
    if (!userId || !orderData) {
      return res.status(400).json({ success: false, error: "Missing user or order data" });
    }
    const orderId = `order_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const now = new Date().toISOString();

    // Reserve stock temporarily
    const stockReservations = [];
    for (const item of orderData.items || []) {
      if (item.productId) {
        const productRef = admin.firestore().collection("products").doc(item.productId);
        const productSnap = await productRef.get();
        const currentStock = productSnap.data()?.stock || 0;
        if (currentStock < (item.quantity || 1)) {
          return res.status(400).json({
            success: false,
            error: `"${item.name || 'item'}" only ${currentStock} left in stock.`,
          });
        }
        // Decrement stock
        stockReservations.push({
          ref: productRef,
          decrement: item.quantity || 1,
          name: item.name,
        });
      }
    }

    // If stock check passes, decrement
    for (const reservation of stockReservations) {
      await reservation.ref.update({
        stock: admin.firestore.FieldValue.increment(-reservation.decrement),
      });
    }

    const writes = [
      db.collection("orders").doc(orderId).set({
        ...orderData, id: orderId, userId,
        payment: { method: "razorpay", razorpayOrderId: razorpay_order_id, razorpayPaymentId: razorpay_payment_id, status: "paid" },
        status: "Pending", createdAt: now, updatedAt: now,
      }),
      db.collection("users").doc(userId).collection("orders").doc(orderId).set({
        ...orderData, id: orderId,
        payment: { method: "razorpay", razorpayOrderId: razorpay_order_id, razorpayPaymentId: razorpay_payment_id, status: "paid" },
        status: "Pending", createdAt: now, updatedAt: now,
      }),
      db.collection("payments").add({
        razorpayOrderId: razorpay_order_id, razorpayPaymentId: razorpay_payment_id,
        method: "razorpay", status: "paid", amount: orderData.totalAmount || orderData.finalTotal || 0,
        currency: "INR", userId, orderId, createdAt: now,
      }),
    ];

    if (couponCode) {
      writes.push(db.collection("coupons").doc(couponCode.toUpperCase()).update({ usedCount: FieldValue.increment(1) }));
    }
    await Promise.all(writes);
    logger.info(`Payment verified for order ${orderId}, user ${userId}`);
    return res.json({ success: true, orderId, message: "Payment verified and order created successfully" });
  } catch (err) {
    logErrorToFirestore(err, req);
    return res.status(500).json({ success: false, error: err.message || "Verification failed" });
  }
});

// 4. POST /api/razorpay/refund — Process refund via Razorpay
app.post("/api/razorpay/refund", verifyFirebaseToken, requireOwner, async (req, res) => {
  try {
    const { paymentId, amount, reason, orderId, userId, items } = req.body;
    if (!paymentId || !amount || amount <= 0 || !orderId || !userId) {
      return res.status(400).json({ error: "Missing required parameters or invalid refund amount." });
    }
    const config = getConfig();
    const keyId = config?.payment?.razorpayKeyId || process.env.RAZORPAY_KEY_ID;
    const keySecret = config?.payment?.razorpayKeySecret || process.env.RAZORPAY_KEY_SECRET;
    let refundId;
    if (keyId && keySecret) {
      const basic = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
      const rpBody = {};
      if (amount) rpBody.amount = Math.round(amount * 100);
      if (reason) rpBody.notes = { reason };
      const rpRes = await fetch(`https://api.razorpay.com/v1/payments/${paymentId}/refund`, {
        method: "POST",
        headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/json" },
        body: JSON.stringify(rpBody),
      });
      if (!rpRes.ok) { const t = await rpRes.text(); throw new Error(`Razorpay refund error: ${t}`); }
      const data = await rpRes.json();
      refundId = data.id;
    } else {
      refundId = `rfnd_mock_${Math.random().toString(36).substring(2, 9).toUpperCase()}`;
    }
    await Promise.all([
      db.collection("refunds").add({
        orderId, userId, items: items || [], totalRefundAmount: amount,
        reason: reason || "Customer request", status: "Approved",
        createdAt: new Date().toISOString(), razorpayRefundId: refundId, processedBy: "Admin Portal",
      }),
      db.collection("users").doc(userId).collection("orders").doc(orderId).update({ isPaid: false, status: "Cancelled" }),
    ]);
    logger.info(`Refund ${refundId} processed for order ${orderId}`);
    return res.json({ success: true, refundId, amount, message: "Refund processed and logged successfully" });
  } catch (err) {
    logErrorToFirestore(err, req);
    return res.status(500).json({ error: err.message || "Failed to process refund" });
  }
});

// 5. POST /api/upload-photo — ImgBB upload proxy
app.post("/api/upload-photo", upload.single("image"), async (req, res) => {
  try {
    const config = getConfig();
    const apiKey = config?.apiKeys?.imgbb?.key || process.env.IMGBB_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ success: false, error: "ImgBB API key not configured on server" });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, error: "No image file provided" });
    }
    const b64 = req.file.buffer.toString("base64");
    const ibRes = await fetch(`https://api.imgbb.com/1/upload?key=${apiKey}`, {
      method: "POST",
      body: new URLSearchParams({ image: b64 }),
    });
    const data = await ibRes.json();
    if (!ibRes.ok || !data.success) {
      return res.status(ibRes.status).json({ success: false, error: data.error?.message || `ImgBB error: ${ibRes.status}` });
    }
    return res.json({ success: true, url: data.data.url, displayUrl: data.data.display_url, deleteUrl: data.data.delete_url });
  } catch (err) {
    logErrorToFirestore(err, req);
    return res.status(500).json({ success: false, error: err.message || "Upload failed" });
  }
});

// 6. POST /api/set-owner — Set Firebase custom claims
app.post("/api/set-owner", verifyFirebaseToken, requireOwner, async (req, res) => {
  try {
    const { uid, email } = req.body;
    if (!uid || !email) {
      return res.status(400).json({ success: false, error: "Missing uid or email" });
    }
    const config = getConfig();
    const allowedEmails = (config?.workers?.ownerEmails?.join(",") || process.env.ALLOWED_OWNER_EMAILS || "youremail@gmail.com").split(",").map(e => e.trim().toLowerCase());
    if (!allowedEmails.includes(email.toLowerCase())) {
      logger.warn(`Unauthorized owner signup attempt: ${email}`);
      return res.status(403).json({ success: false, error: "You are not authorized to be an owner" });
    }
    await admin.auth().setCustomUserClaims(uid, { role: "owner", email, claimsSetAt: new Date().toISOString() });
    await db.collection("users").doc(uid).set({ role: "owner", email, claimsSetAt: new Date().toISOString(), isOwner: true }, { merge: true });
    await db.collection("owners").doc(uid).set({ email, isOwner: true, createdAt: new Date().toISOString() }, { merge: true });
    logger.info(`Owner claims set for ${email}`);
    return res.json({ success: true, message: `Owner claims set for ${email}` });
  } catch (err) {
    logErrorToFirestore(err, req);
    return res.status(500).json({ success: false, error: "Failed to set owner claims" });
  }
});

// 7. POST /api/notify-owner — MSG91 SMS notification
app.post("/api/notify-owner", async (req, res) => {
  try {
    const { orderId, amount, customerName, customerPhone } = req.body;
    if (!orderId || !amount || !customerName) {
      return res.status(400).json({ success: false, error: "Missing required fields" });
    }
    const config = getConfig();
    const msg91AuthKey = config?.notifications?.smsApiKey || process.env.MSG91_AUTH_KEY;
    const msg91FlowId = config?.notifications?.smsFlowId || process.env.MSG91_FLOW_ID;
    const ownerPhone = config?.contactInfo?.phone || process.env.OWNER_PHONE;
    if (!msg91AuthKey || !msg91FlowId || !ownerPhone) {
      logger.warn("MSG91 not configured, skipping SMS");
      return res.json({ success: true, message: "Notification skipped (MSG91 not configured)", note: "Configure MSG91_AUTH_KEY, MSG91_FLOW_ID, and OWNER_PHONE" });
    }
    const formattedPhone = ownerPhone.startsWith("91") ? ownerPhone : "91" + ownerPhone.replace(/^0/, "");
    const payload = {
      flow_id: msg91FlowId, sender: "FRESH",
      recipients: [{ mobiles: formattedPhone, orderId, amount: `₹${Math.round(amount)}`, customerName, customerPhone: customerPhone || "N/A" }],
    };
    const mRes = await fetch("https://api.msg91.com/api/v5/flow/", {
      method: "POST",
      headers: { authkey: msg91AuthKey, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const mData = await mRes.json();
    if (!mRes.ok) {
      logger.error("MSG91 API error:", mData);
      return res.status(500).json({ success: false, error: "Failed to send SMS notification" });
    }
    logger.info(`SMS sent for order ${orderId}`);
    return res.json({ success: true, message: "SMS notification sent to owner", messageId: mData.message_id || mData.request_id });
  } catch (err) {
    logErrorToFirestore(err, req);
    return res.status(500).json({ success: false, error: "Failed to send notification" });
  }
});

// 8. POST /api/delivery-partner/request — 3rd-party delivery
app.post("/api/delivery-partner/request", async (req, res) => {
  try {
    const { orderId, partner } = req.body;
    if (!orderId || !partner) {
      return res.status(400).json({ error: "orderId and partner are required." });
    }
    const prefix = { Shiprocket: "SR", Delhivery: "DH", Shadowfax: "SF" }[partner] || "DP";
    const trackingId = `${prefix}-${Date.now()}`;
    await db.collection("delivery_partner_logs").add({
      orderId, partner, trackingId, status: "Dispatched", createdAt: FieldValue.serverTimestamp(),
    });
    logger.info(`Order ${orderId} dispatched via ${partner}, tracking: ${trackingId}`);
    return res.json({ success: true, trackingId, partner, status: "Dispatched", message: "Order submitted to partner." });
  } catch (err) {
    logErrorToFirestore(err, req);
    return res.status(500).json({ error: err.message || "Failed to delegate order" });
  }
});

// ─── Inventory Lock System ───
app.post("/api/inventory/lock", verifyFirebaseToken, async (req, res) => {
  try {
    const { items, sessionId } = req.body;
    if (!items || !Array.isArray(items) || items.length === 0 || !sessionId) {
      return res.status(400).json({ success: false, error: "Missing items array or sessionId" });
    }

    const unavailable = [];

    await db.runTransaction(async (transaction) => {
      const stockSnaps = await Promise.all(
        items.map((item) => transaction.get(db.collection("products").doc(item.productId)))
      );

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const snap = stockSnaps[i];
        if (!snap.exists) {
          unavailable.push({ productId: item.productId, reason: "Product not found" });
        } else {
          const stock = snap.data().stock ?? 0;
          if (stock < item.quantity) {
            unavailable.push({ productId: item.productId, available: stock, requested: item.quantity });
          }
        }
      }

      if (unavailable.length > 0) return;

      transaction.set(db.collection("inventoryLocks").doc(sessionId), {
        items,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        createdAt: FieldValue.serverTimestamp(),
      });
    });

    if (unavailable.length > 0) {
      return res.status(409).json({ success: false, error: "Some items are unavailable", unavailable });
    }

    logger.info(`Inventory locked for session ${sessionId} with ${items.length} item(s)`);
    return res.json({ success: true, message: "Inventory locked", expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() });
  } catch (err) {
    logErrorToFirestore(err, req);
    return res.status(500).json({ success: false, error: err.message || "Failed to lock inventory" });
  }
});

app.post("/api/inventory/release", verifyFirebaseToken, async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) {
      return res.status(400).json({ success: false, error: "Missing sessionId" });
    }
    await db.collection("inventoryLocks").doc(sessionId).delete();
    logger.info(`Inventory lock released for session ${sessionId}`);
    return res.json({ success: true, message: "Inventory lock released" });
  } catch (err) {
    logErrorToFirestore(err, req);
    return res.status(500).json({ success: false, error: err.message || "Failed to release inventory lock" });
  }
});

// ─── FCM Token Management ───
app.post("/api/fcm/register", async (req, res) => {
  try {
    const { userId, token, deviceInfo } = req.body;
    if (!userId || !token) {
      return res.status(400).json({ success: false, error: "Missing userId or token" });
    }
    await db.collection("fcmTokens").doc(userId).set({
      token,
      deviceInfo: deviceInfo || null,
      active: true,
      updatedAt: FieldValue.serverTimestamp(),
    });
    logger.info(`FCM token registered for user ${userId}`);
    return res.json({ success: true, message: "FCM token registered" });
  } catch (err) {
    logErrorToFirestore(err, req);
    return res.status(500).json({ success: false, error: err.message || "Failed to register FCM token" });
  }
});

app.post("/api/fcm/unregister", async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ success: false, error: "Missing userId" });
    }
    await db.collection("fcmTokens").doc(userId).update({
      active: false,
      updatedAt: FieldValue.serverTimestamp(),
    });
    logger.info(`FCM token deactivated for user ${userId}`);
    return res.json({ success: true, message: "FCM token deactivated" });
  } catch (err) {
    logErrorToFirestore(err, req);
    return res.status(500).json({ success: false, error: err.message || "Failed to unregister FCM token" });
  }
});

app.get("/api/fcm/status", apiKeyAuth, async (req, res) => {
  try {
    const snap = await db.collection("fcmTokens").where("active", "==", true).count().get();
    const count = snap.data().count || 0;
    return res.json({ success: true, activeTokens: count });
  } catch (err) {
    logErrorToFirestore(err, req);
    return res.status(500).json({ success: false, error: err.message || "Failed to get FCM status" });
  }
});

// ─── Auth: FCM OTP Endpoints ───
app.post("/api/auth/send-otp-fcm", validate(sendOTPFcmSchema), async (req, res) => {
  try {
    const { phoneNumber, userId } = req.body;
    
    const phone = phoneNumber.replace(/\s/g, "");
    
    // Get user's FCM token from Firestore
    const fcmTokenDoc = await admin.firestore()
      .collection("fcmTokens")
      .doc(userId)
      .get();
    
    if (!fcmTokenDoc.exists) {
      return res.status(400).json({ 
        success: false, 
        error: "FCM token not registered. Please allow notifications and try again.",
        code: "NO_FCM_TOKEN"
      });
    }
    
    const { token: fcmToken } = fcmTokenDoc.data();
    if (!fcmToken) {
      return res.status(400).json({ 
        success: false, 
        error: "FCM token not found. Please allow notifications and try again.",
        code: "NO_FCM_TOKEN"
      });
    }
    
    // Generate OTP
    const code = generateOTP();
    otpCache.set(phone, {
      code,
      userId,
      expiresAt: Date.now() + OTP_TTL,
      attempts: 0,
    });
    
    // Send OTP via FCM data message
    const message = {
      token: fcmToken,
      data: {
        type: "OTP_VERIFICATION",
        otp: code,
        title: "Your verification code",
        body: `Your OTP is ${code}. Do not share this code with anyone.`,
      },
      android: {
        priority: "high",
      },
    };
    
    try {
      await admin.messaging().send(message);
      console.log(`[OTP] Sent to ${phone} for user ${userId}`);
    } catch (fcmError) {
      console.error("[OTP] FCM send failed:", fcmError.message);
      return res.status(400).json({ 
        success: false, 
        error: "Failed to send OTP. Please check notification permissions or try again.",
        code: "FCM_FAILED",
        details: fcmError.message
      });
    }
    
    res.json({ 
      success: true, 
      message: "OTP sent successfully",
      expiresIn: OTP_TTL / 1000,
    });
    
  } catch (error) {
    console.error("[OTP] Send error:", error.message);
    res.status(500).json({ success: false, error: "Failed to send OTP" });
  }
});

app.post("/api/auth/verify-otp", validate(verifyOTPSchema), async (req, res) => {
  try {
    const { phoneNumber, otp, userId } = req.body;
    
    const phone = phoneNumber.replace(/\s/g, "");
    const entry = otpCache.get(phone);
    
    if (!entry) {
      return res.status(400).json({ 
        success: false, 
        error: "OTP expired or not found. Please request a new OTP.",
        code: "OTP_NOT_FOUND"
      });
    }
    
    if (Date.now() > entry.expiresAt) {
      otpCache.delete(phone);
      return res.status(400).json({ 
        success: false, 
        error: "OTP expired. Please request a new OTP.",
        code: "OTP_EXPIRED"
      });
    }
    
    if (entry.userId !== userId) {
      return res.status(400).json({ 
        success: false, 
        error: "OTP was sent to a different account.",
        code: "USER_MISMATCH"
      });
    }
    
    entry.attempts++;
    
    if (entry.attempts > OTP_MAX_ATTEMPTS) {
      otpCache.delete(phone);
      return res.status(400).json({ 
        success: false, 
        error: "Too many attempts. Please request a new OTP.",
        code: "MAX_ATTEMPTS"
      });
    }
    
    if (entry.code !== otp.trim()) {
      const remaining = OTP_MAX_ATTEMPTS - entry.attempts;
      return res.status(400).json({ 
        success: false, 
        error: `Wrong OTP. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`,
        code: "OTP_INCORRECT",
        attemptsRemaining: remaining
      });
    }
    
    // OTP verified - delete from cache
    otpCache.delete(phone);
    
    // Store verified phone in Firestore
    await admin.firestore().collection("users").doc(userId).set({
      phone: phone,
      phoneVerified: true,
      phoneVerifiedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    
    console.log(`[OTP] Verified for ${phone}, user ${userId}`);
    
    res.json({ 
      success: true, 
      message: "Phone number verified successfully",
    });
    
  } catch (error) {
    console.error("[OTP] Verify error:", error.message);
    res.status(500).json({ success: false, error: "Failed to verify OTP" });
  }
});

// ─── Order Cancel Endpoint ───
app.post("/api/orders/cancel", verifyFirebaseToken, async (req, res) => {
  try {
    const { orderId, userId, reason } = req.body;
    if (!orderId || !userId) {
      return res.status(400).json({ success: false, error: "orderId and userId required" });
    }

    const orderRef = admin.firestore().collection("orders").doc(orderId);
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists) {
      return res.status(404).json({ success: false, error: "Order not found" });
    }

    const order = orderSnap.data();

    // Only allow cancellation if status is Pending or Confirmed
    if (!["Pending", "Confirmed"].includes(order.status)) {
      return res.status(400).json({
        success: false,
        error: `Cannot cancel order with status "${order.status}". Only Pending or Confirmed orders can be cancelled.`,
      });
    }

    // Update order status
    await orderRef.update({
      status: "Cancelled",
      cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
      cancelledBy: userId,
      cancelReason: reason || "Customer request",
    });

    // Restore stock
    for (const item of order.items || []) {
      if (item.productId) {
        const productRef = admin.firestore().collection("products").doc(item.productId);
        await productRef.update({
          stock: admin.firestore.FieldValue.increment(item.quantity || 1),
        });
      }
    }

    // If Razorpay order, initiate refund
    if (order.paymentMethod === "online" && order.razorpayOrderId) {
      // TODO: Integrate Razorpay refund API
      console.log(`[CANCEL] Refund needed for order ${orderId}`);
    }

    res.json({ success: true, message: "Order cancelled successfully" });
  } catch (error) {
    console.error("[CANCEL] Error:", error.message);
    res.status(500).json({ success: false, error: "Failed to cancel order" });
  }
});

// ─── Soft Delete / Restore for Products ───
app.post("/api/products/archive", verifyFirebaseToken, requireOwner, async (req, res) => {
  try {
    const { productId } = req.body;
    if (!productId) return res.status(400).json({ success: false, error: "Missing productId" });
    await db.collection("products").doc(productId).update({ active: false, archivedAt: new Date().toISOString() });
    productCache.del("all_products");
    logger.info(`Product ${productId} archived (soft delete)`);
    return res.json({ success: true, message: "Product archived" });
  } catch (err) {
    logErrorToFirestore(err, req);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/products/restore", verifyFirebaseToken, requireOwner, async (req, res) => {
  try {
    const { productId } = req.body;
    if (!productId) return res.status(400).json({ success: false, error: "Missing productId" });
    await db.collection("products").doc(productId).update({ active: true, restoredAt: new Date().toISOString() });
    productCache.del("all_products");
    logger.info(`Product ${productId} restored`);
    return res.json({ success: true, message: "Product restored" });
  } catch (err) {
    logErrorToFirestore(err, req);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Analytics Daily Stats ───
app.get("/api/analytics/daily", async (req, res) => {
  try {
    const snap = await db.collection("analytics").doc("dailyStats").get();
    if (snap.exists) {
      return res.json({ id: snap.id, ...snap.data() });
    }
    return res.json({ totalOrders: 0, totalRevenue: 0, cancelledOrders: 0, cancelledRevenue: 0 });
  } catch (err) {
    logErrorToFirestore(err, req);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Cached API Routes ───

const configCache = new NodeCache({ stdTTL: 600, checkperiod: 120 }); // 10 min TTL for config

// GET /api/config — Fetch centralized app config (cached 10 min)
app.get("/api/config", async (req, res) => {
  try {
    const cached = configCache.get("app_config");
    if (cached) {
      res.set("X-Cache", "HIT");
      return res.json(cached);
    }
    let snap = await db.collection("appConfig").doc("settings").get();
    if (!snap.exists) {
      snap = await db.collection("appConfig").doc("main").get();
    }
    let config;
    if (snap.exists) {
      config = { id: snap.id, ...snap.data() };
    } else {
      config = {
        id: "main", branding: {}, store: { isOpen: true, maintenanceMode: false },
        features: {}, contact: {}, updatedAt: new Date().toISOString(),
      };
    }
    configCache.set("app_config", config);
    res.set("X-Cache", "MISS");
    return res.json(config);
  } catch (err) {
    logErrorToFirestore(err, req);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/config — Update app config (owner dashboard use, clears cache)
app.post("/api/config", verifyFirebaseToken, requireOwner, async (req, res) => {
  try {
    const { branding, store, features, seo, contact, ai } = req.body;
    const updateData = {};
    if (branding !== undefined) updateData.branding = branding;
    if (store !== undefined) updateData.store = store;
    if (features !== undefined) updateData.features = features;
    if (seo !== undefined) updateData.seo = seo;
    if (contact !== undefined) updateData.contact = contact;
    if (ai !== undefined) updateData.ai = ai;
    updateData.updatedAt = new Date().toISOString();

    await db.collection("appConfig").doc("settings").set(updateData, { merge: true });
    // Also sync to main doc for backward compat
    const mainRef = db.collection("appConfig").doc("main");
    const mainSnap = await mainRef.get();
    if (mainSnap.exists) {
      await mainRef.set(updateData, { merge: true });
    }
    configCache.del("app_config");
    productCache.flushAll();
    logger.info("App config updated");
    return res.json({ success: true, message: "Config updated" });
  } catch (err) {
    logErrorToFirestore(err, req);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/invalidate-cache — Clear config cache (owner dashboard use)
app.post("/api/invalidate-cache", async (req, res) => {
  // Accept Firebase token OR admin key
  const authHeader = req.headers.authorization;
  const adminKey = req.headers["x-admin-key"];
  const configuredAdminKey = process.env.ADMIN_KEY;

  if (authHeader && authHeader.startsWith("Bearer ")) {
    try {
      const decoded = await admin.auth().verifyIdToken(authHeader.split("Bearer ")[1]);
      const userDoc = await db.collection("users").doc(decoded.uid).get();
      if (!userDoc.exists || !userDoc.data().isOwner) {
        return res.status(403).json({ error: "Owner access required" });
      }
    } catch (e) {
      return res.status(401).json({ error: "Invalid token" });
    }
  } else if (configuredAdminKey && adminKey === configuredAdminKey) {
    // Admin key accepted for server-to-server calls
  } else {
    return res.status(401).json({ error: "Authentication required" });
  }

  configCache.del("app_config");
  configCache.del("appConfig");
  productCache.flushAll();
  logger.info("All caches cleared by dashboard");
  return res.json({ success: true, message: "Cache cleared. Changes will reflect immediately." });
});

// GET /api/products — Fetch active products with caching
app.get("/api/products", async (req, res) => {
  try {
    const cached = productCache.get("all_products");
    if (cached) {
      res.set("X-Cache", "HIT");
      return res.json(cached);
    }
    const snap = await db.collection("products").where("active", "==", true).get();
    const products = [];
    snap.forEach((doc) => {
      products.push({ id: doc.id, ...doc.data() });
    });
    productCache.set("all_products", products);
    res.set("X-Cache", "MISS");
    return res.json(products);
  } catch (err) {
    logErrorToFirestore(err, req);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/clear-cache — Clear product cache (for owner dashboard after updates)
app.post("/api/clear-cache", verifyFirebaseToken, requireOwner, async (req, res) => {
  try {
    productCache.flushAll();
    logger.info("Product cache cleared");
    return res.json({ success: true, message: "Cache cleared" });
  } catch (err) {
    logErrorToFirestore(err, req);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Delivery Partner Dispatch ───
app.post("/api/dispatch-to-partner", async (req, res) => {
  try {
    const { orderId, userId, partnerName } = req.body;
    if (!orderId || !partnerName) {
      return res.status(400).json({ success: false, error: "Missing orderId or partnerName" });
    }
    const config = getConfig();
    const credentials = config?.delivery?.partners?.[partnerName?.toLowerCase()]?.credentials;
    if (!credentials) {
      return res.status(400).json({ success: false, error: `No credentials configured for ${partnerName}` });
    }
    const ordersSnap = await db.collectionGroup("orders").where("__name__", "==", orderId).get();
    if (ordersSnap.empty) {
      return res.status(404).json({ success: false, error: "Order not found" });
    }
    const orderDoc = ordersSnap.docs[0];
    const order = { id: orderDoc.id, ...orderDoc.data() };
    const result = await dispatchToPartner(order, partnerName, credentials);
    if (!result.success) {
      return res.status(500).json({ success: false, error: result.error });
    }
    await db.collection("delivery_partner_logs").add({
      orderId, userId: userId || order.userId, partner: partnerName,
      trackingId: result.trackingId, status: "Dispatched",
      dispatchedAt: new Date().toISOString(),
    });
    logger.info(`Order ${orderId} dispatched via ${partnerName}, tracking: ${result.trackingId}`);
    return res.json({ success: true, trackingId: result.trackingId, eta: result.eta });
  } catch (err) {
    logErrorToFirestore(err, req);
    return res.status(500).json({ success: false, error: err.message || "Dispatch failed" });
  }
});

app.post("/api/partner-webhook", async (req, res) => {
  try {
    const { partner, trackingId, status, orderId } = req.body;
    if (!partner) {
      return res.status(400).json({ success: false, error: "Missing partner name" });
    }
    const result = await handleWebhook(partner, req.body);
    if (trackingId) {
      const logsSnap = await db.collection("delivery_partner_logs").where("trackingId", "==", trackingId).limit(1).get();
      if (!logsSnap.empty) {
        await logsSnap.docs[0].ref.update({
          status: status || "updated",
          updatedAt: new Date().toISOString(),
          webhookReceived: true,
        });
      }
    }
    if ((status === "Delivered" || status === "delivered") && orderId) {
      const ordersSnap = await db.collectionGroup("orders").where("__name__", "==", orderId).get();
      for (const doc of ordersSnap.docs) {
        await doc.ref.update({ status: "Delivered", deliveredAt: new Date().toISOString() });
      }
    }
    logger.info(`Webhook from ${partner}: ${trackingId} → ${status}`);
    return res.json({ success: true });
  } catch (err) {
    logErrorToFirestore(err, req);
    return res.status(500).json({ success: false, error: err.message || "Webhook processing failed" });
  }
});

app.get("/api/track-order/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;
    const logsSnap = await db.collection("delivery_partner_logs").where("orderId", "==", orderId).orderBy("createdAt", "desc").limit(1).get();
    if (logsSnap.empty) {
      return res.json({ orderId, status: "unknown", message: "No tracking information available" });
    }
    const log = { id: logsSnap.docs[0].id, ...logsSnap.docs[0].data() };
    return res.json({ orderId, trackingId: log.trackingId, partner: log.partner, status: log.status, dispatchedAt: log.dispatchedAt });
  } catch (err) {
    logErrorToFirestore(err, req);
    return res.status(500).json({ success: false, error: err.message || "Tracking lookup failed" });
  }
});

app.post("/api/refresh-config", verifyFirebaseToken, requireOwner, async (req, res) => {
  try {
    const config = await reloadConfig();
    return res.json({ success: true, message: "Config reloaded", config: config ? { business: config.business?.name, updatedAt: config.updatedAt } : null });
  } catch (err) {
    logErrorToFirestore(err, req);
    return res.status(500).json({ success: false, error: err.message || "Config reload failed" });
  }
});

app.get("/api/app-config", async (req, res) => {
  try {
    const config = getConfig();
    if (!config) {
      return res.status(503).json({ success: false, error: "Config not loaded yet" });
    }
    const safeConfig = { ...config };
    delete safeConfig.apiKeys;
    delete safeConfig.secrets;
    if (safeConfig.notifications) {
      safeConfig.notifications = { ...safeConfig.notifications };
      delete safeConfig.notifications.whatsAppApiKey;
    }
    if (safeConfig.delivery?.partners) {
      safeConfig.delivery = { ...safeConfig.delivery };
      safeConfig.delivery.partners = Object.fromEntries(
        Object.entries(safeConfig.delivery.partners).map(([name, p]) => [name, { enabled: p.enabled }])
      );
    }
    return res.json({ success: true, config: safeConfig });
  } catch (err) {
    logErrorToFirestore(err, req);
    return res.status(500).json({ success: false, error: err.message || "Failed to fetch config" });
  }
});



// ─── Delivery Location Endpoints ───

app.post("/api/validate-pincode", async (req, res) => {
  try {
    const { pincode } = req.body;
    if (!pincode || !/^\d{6}$/.test(pincode)) {
      return res.status(400).json({ valid: false, error: "Pincode must be 6 digits", pincode });
    }
    const result = await validatePincode(pincode);
    return res.json(result);
  } catch (err) {
    logErrorToFirestore(err, req);
    return res.status(500).json({ valid: false, error: "Failed to validate pincode", pincode: req.body?.pincode });
  }
});

app.post("/api/validate-location", async (req, res) => {
  try {
    const { lat, lng } = req.body;
    if (typeof lat !== "number" || typeof lng !== "number" || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ valid: false, error: "Invalid coordinates" });
    }
    const config = getConfig();
    const storeLat = config?.store?.location?.lat ?? 17.6868;
    const storeLng = config?.store?.location?.lng ?? 74.0066;
    const maxKm = config?.deliveryZones?.enabled ? 50 : 20;

    const R = 6371;
    const dLat = ((lat - storeLat) * Math.PI) / 180;
    const dLng = ((lng - storeLng) * Math.PI) / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos((storeLat * Math.PI) / 180) * Math.cos((lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distanceKm = Math.round(R * c * 10) / 10;

    const isThirdParty = distanceKm > maxKm;
    let estimatedHours = 1;
    if (isThirdParty) {
      estimatedHours = Math.max(24, Math.ceil(distanceKm / 40) * 8);
    } else if (distanceKm <= 5) {
      estimatedHours = 1;
    } else if (distanceKm <= 10) {
      estimatedHours = 2;
    } else {
      estimatedHours = Math.ceil(distanceKm / 10);
    }

    let partition = "zone_0_10";
    if (distanceKm > 10) partition = "zone_10_20";
    if (distanceKm > 20) partition = "zone_20_30";
    if (distanceKm > 30) partition = "zone_30_50";
    if (distanceKm > 50) partition = "zone_50_plus";

    return res.json({
      valid: true,
      distanceKm,
      isThirdParty,
      deliveryType: isThirdParty ? "thirdParty" : "own",
      partition,
      estimatedHours,
      maxKm,
    });
  } catch (err) {
    logErrorToFirestore(err, req);
    return res.status(500).json({ valid: false, error: "Failed to validate location" });
  }
});

app.get("/api/delivery-zones", async (req, res) => {
  try {
    const config = getConfig();
    const zones = config?.deliveryZones || {};
    return res.json({
      enabled: zones.enabled ?? true,
      localPincodes: zones.localPincodes || [],
      deliveryCharges: zones.deliveryCharges || {},
      freeDeliveryThresholds: zones.freeDeliveryThresholds || {},
      maxLocalWeightKg: zones.maxLocalWeightKg || 25,
    });
  } catch (err) {
    logErrorToFirestore(err, req);
    return res.status(500).json({ error: "Failed to fetch delivery zones" });
  }
});

// ─── Error handler (must be last middleware) ───
app.use(errorHandler);

// ─── Graceful Shutdown ───
function gracefulShutdown(signal) {
  logger.info(`${signal} received. Shutting down gracefully...`);
  listeners.forEach((unsub) => { try { unsub(); } catch (e) { /* ignore */ } });
  listeners = [];
  setTimeout(() => {
    logger.info("Shutdown complete.");
    process.exit(0);
  }, 3000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("uncaughtException", (err) => {
  logErrorToFirestore(err);
  logger.error("Uncaught exception", { message: err.message, stack: err.stack });
});
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection", { reason: reason?.message || reason });
});

// ─── Cleanup Note ───
// TODO: Deploy a Cloud Function (onFirestore or scheduled) to periodically
// delete expired inventoryLocks documents (where expiresAt < now).

// ─── Export for testing (supertest) ───
module.exports = app;

// ─── Start ───
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  startListeners();
});
