require("dotenv").config();

const express = require("express");
const compression = require("compression");
const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");

const {
  corsMiddleware,
  helmetMiddleware,
  generalLimiter,
  apiKeyAuth,
  inputSanitizer,
} = require("./middleware/security");

const {
  validate,
  verifyDeliveryCodeSchema,
  dispatchToThirdPartySchema,
  thirdPartyWebhookSchema,
  paySalarySchema,
  sendSMSOTPSchema,
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

  // 2. Order status changes → notify customer
  const unsubStatus = db.collectionGroup("orders").onSnapshot(
    (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type !== "modified") return;
        const order = change.doc.data();
        const newStatus = order?.status;
        if (!newStatus) return;
        const triggerStatuses = ["Packing", "Out for Delivery", "Delivered"];
        if (!triggerStatuses.includes(newStatus)) return;
        const userId = change.doc.ref.path.split("/")[1];
        try {
          const userDoc = await db.collection("users").doc(userId).get();
          const fcmToken = userDoc.data()?.fcmToken;
          if (fcmToken) {
            const body = newStatus === "Packing" ? "Your order is being packed!"
              : newStatus === "Out for Delivery" ? "Your order is out for delivery!"
              : "Your order has been delivered!";
            await sendFCMToTokenWithRetry(fcmToken, "Order Update", body, {
              type: "order_status", orderId: change.doc.id, status: newStatus,
            });
          }
        } catch (err) {
          logErrorToFirestore(err);
        }
      });
    },
    (err) => logger.error("Status listener error:", err)
  );
  listeners.push(unsubStatus);

  // 3. Awaiting Verification → generate OTP
  const unsubOTP = db.collectionGroup("orders").onSnapshot(
    (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type !== "modified") return;
        const order = change.doc.data();
        if (!order || order.status !== "Awaiting Verification" || order.verificationCode) return;
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const [userId, , orderId] = change.doc.ref.path.split("/").filter(Boolean);
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
      });
    },
    (err) => logger.error("OTP listener error:", err)
  );
  listeners.push(unsubOTP);

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

app.post("/paySalary", validate(paySalarySchema), async (req, res) => {
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

app.post("/sendSMSOTP", validate(sendSMSOTPSchema), async (req, res) => {
  try {
    const { phoneNumber, otp } = req.body;
    logger.info(`SMS OTP for ${phoneNumber}: ${otp}`);
    return res.json({ success: true, message: "FCM is primary; SMS provider not configured." });
  } catch (err) {
    logErrorToFirestore(err, req);
    return res.status(500).json({ success: false, error: err.message });
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

// ─── Start ───
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  startListeners();
});
