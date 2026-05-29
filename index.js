const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
require("dotenv").config();

// ─── Initialize Firebase Admin (supports both local and Render) ───
if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
  // Render deployment: load from environment variable
  const serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8")
  );
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  console.log("Firebase Admin initialized from environment variable");
} else {
  // Local development: load from JSON file
  try {
    const serviceAccount = require("./serviceAccountKey.json");
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log("Firebase Admin initialized from local JSON file");
  } catch (err) {
    console.error(
      "Failed to initialize Firebase Admin. " +
      "Provide FIREBASE_SERVICE_ACCOUNT_BASE64 env var or place serviceAccountKey.json in the server folder."
    );
    process.exit(1);
  }
}

const db = admin.firestore();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ─── Helpers ───
async function sendFCMToToken(token, title, body, data = {}) {
  if (!token) {
    console.warn("sendFCMToToken: no token provided");
    return;
  }
  try {
    await admin.messaging().send({
      token,
      notification: { title, body },
      data,
    });
    console.log(`FCM sent to token: ${token.substring(0, 10)}...`);
  } catch (err) {
    console.error("FCM send error:", err.code || err.message);
  }
}

async function sendFCMToTokens(tokens, title, body, data = {}) {
  if (tokens.length === 0) return;
  const results = await Promise.allSettled(
    tokens.map((t) => sendFCMToToken(t, title, body, data))
  );
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      console.error(`FCM multicast failed for token ${i}:`, r.reason);
    }
  });
}

// ─── Firestore Listeners ───
let listeners = [];

function startListeners() {
  // 1. New pending orders → notify all active workers
  const unsubOrders = db.collectionGroup("orders").onSnapshot(
    (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type !== "added") return;
        const order = change.doc.data();
        if (!order || order.status !== "Pending") return;

        try {
          const workersSnap = await db
            .collection("workers")
            .where("active", "==", true)
            .get();
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
          console.error("Error notifying workers:", err.message);
        }
      });
    },
    (err) => console.error("Orders listener error:", err.message)
  );
  listeners.push(unsubOrders);

  // 2. Order status changes → notify customer
  const unsubStatus = db.collectionGroup("orders").onSnapshot(
    (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type !== "modified") return;
        const order = change.doc.data();
        const newStatus = order.status;
        if (!newStatus) return;

        const triggerStatuses = ["Packing", "Out for Delivery", "Delivered"];
        if (!triggerStatuses.includes(newStatus)) return;

        const pathParts = change.doc.ref.path.split("/");
        const userId = pathParts[1];

        try {
          const userDoc = await db.collection("users").doc(userId).get();
          const fcmToken = userDoc.data()?.fcmToken;

          if (fcmToken) {
            const body =
              newStatus === "Packing"
                ? "Your order is being packed!"
                : newStatus === "Out for Delivery"
                ? "Your order is out for delivery!"
                : "Your order has been delivered!";

            await sendFCMToToken(fcmToken, "Order Update", body, {
              type: "order_status",
              orderId: change.doc.id,
              status: newStatus,
            });
          }
        } catch (err) {
          console.error("Error notifying customer:", err.message);
        }
      });
    },
    (err) => console.error("Status listener error:", err.message)
  );
  listeners.push(unsubStatus);

  // 3. Awaiting Verification → generate OTP + notify customer
  const unsubOTP = db.collectionGroup("orders").onSnapshot(
    (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type !== "modified") return;
        const order = change.doc.data();
        if (
          !order ||
          order.status !== "Awaiting Verification" ||
          order.verificationCode
        ) {
          return;
        }

        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const pathParts = change.doc.ref.path.split("/");
        const userId = pathParts[1];
        const orderId = pathParts[3];

        try {
          await change.doc.ref.update({ verificationCode: code });

          const userDoc = await db.collection("users").doc(userId).get();
          const fcmToken = userDoc.data()?.fcmToken;

          if (fcmToken) {
            await sendFCMToToken(fcmToken, "Delivery Verification", `Your OTP is: ${code}`, {
              type: "delivery_otp",
              orderId,
              code,
            });
          }
          console.log(`OTP ${code} generated for order ${orderId}`);
        } catch (err) {
          console.error("Error generating OTP:", err.message);
        }
      });
    },
    (err) => console.error("OTP listener error:", err.message)
  );
  listeners.push(unsubOTP);

  // 4. Low stock → notify owner
  const unsubStock = db.collection("products").onSnapshot(
    (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type !== "modified" && change.type !== "added") return;
        const product = change.doc.data();
        if (!product) return;

        const stock = product.stock ?? 0;
        const threshold = product.lowStockThreshold ?? 5;
        if (stock >= threshold) return;

        try {
          const infoSnap = await db.collection("contactInfo").doc("info").get();
          const ownerFcmToken = infoSnap.data()?.ownerFcmToken;
          if (ownerFcmToken) {
            await sendFCMToToken(
              ownerFcmToken,
              "Low Stock Alert",
              `${product.name || "Product"} is low (${stock} left)`,
              { type: "low_stock", productId: change.doc.id }
            );
          }
        } catch (err) {
          console.error("Error notifying owner:", err.message);
        }
      });
    },
    (err) => console.error("Stock listener error:", err.message)
  );
  listeners.push(unsubStock);

  // 5. New basket → notify delivery boy
  const unsubBasket = db.collectionGroup("basket").onSnapshot(
    (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type !== "added") return;
        const basket = change.doc.data();
        if (!basket) return;

        const pathParts = change.doc.ref.path.split("/");
        const dboyId = pathParts[1];

        try {
          const dboyDoc = await db.collection("deliveryBoys").doc(dboyId).get();
          const fcmToken = dboyDoc.data()?.fcmToken;
          if (fcmToken) {
            const orderCount = basket.orders?.length ?? 0;
            await sendFCMToToken(fcmToken, "New Delivery Basket", `${orderCount} order(s) assigned`, {
              type: "new_basket",
              basketId: change.doc.id,
            });
          }
        } catch (err) {
          console.error("Error notifying delivery boy:", err.message);
        }
      });
    },
    (err) => console.error("Basket listener error:", err.message)
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

        // Skip if we already processed this doc on initial load
        const contactId = change.doc.id;
        if (lastKnownContactIds.has(contactId)) return;
        lastKnownContactIds.add(contactId);

        try {
          const infoSnap = await db.collection("contactInfo").doc("info").get();
          const ownerFcmToken = infoSnap.data()?.ownerFcmToken;
          if (ownerFcmToken) {
            await sendFCMToToken(
              ownerFcmToken,
              "New Support Ticket",
              `${contact.name || "Customer"}: ${contact.subject || "New complaint"}`,
              { type: "new_ticket", contactId }
            );
          }
        } catch (err) {
          console.error("Error notifying owner of new ticket:", err.message);
        }
      });
    },
    (err) => console.error("New contact listener error:", err.message)
  );
  listeners.push(unsubNewContact);

  // 7. Support ticket reply → notify the other party
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
        if (!lastReply || !lastReply.by) return;

        try {
          if (lastReply.by === "owner") {
            // Owner replied → notify customer
            if (contact.userId) {
              const userDoc = await db.collection("users").doc(contact.userId).get();
              const fcmToken = userDoc.data()?.fcmToken;
              if (fcmToken) {
                await sendFCMToToken(
                  fcmToken,
                  "Owner Replied",
                  `Reply to your ticket: ${contact.subject || "Support ticket"}`,
                  { type: "ticket_reply", contactId }
                );
              }
            }
          } else if (lastReply.by === "customer") {
            // Customer replied → notify owner
            const infoSnap = await db.collection("contactInfo").doc("info").get();
            const ownerFcmToken = infoSnap.data()?.ownerFcmToken;
            if (ownerFcmToken) {
              await sendFCMToToken(
                ownerFcmToken,
                "Customer Replied",
                `${contact.name || "Customer"} replied to: ${contact.subject || "Support ticket"}`,
                { type: "ticket_reply", contactId }
              );
            }
          }
        } catch (err) {
          console.error("Error notifying of ticket reply:", err.message);
        }
      });
    },
    (err) => console.error("Contact reply listener error:", err.message)
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
          // collectionGroup path: "workers/{id}/salaryPayments/{salaryId}"
          // or "deliveryBoys/{id}/salaryPayments/{salaryId}"
          const pathParts = change.doc.ref.path.split("/");
          const collection = pathParts[0]; // "workers" or "deliveryBoys"
          const personId = pathParts[1];

          if (!["workers", "deliveryBoys"].includes(collection)) return;

          const personDoc = await db.collection(collection).doc(personId).get();
          const fcmToken = personDoc.data()?.fcmToken;
          const name = personDoc.data()?.name || "Employee";

          if (fcmToken) {
            const label = collection === "workers" ? "Worker" : "Delivery Boy";
            await sendFCMToToken(
              fcmToken,
              "Salary Paid",
              `${salary.monthYear || ""}: ₹${salary.amount} credited via ${salary.mode || "cash"}`,
              { type: "salary_paid", salaryId, collection, personId }
            );
          }
        } catch (err) {
          console.error("Error notifying salary payment:", err.message);
        }
      });
    },
    (err) => console.error("Salary listener error:", err.message)
  );
  listeners.push(unsubSalary);

  console.log("✅ All Firestore listeners started");
}

// ─── HTTP Endpoints ───

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// POST /verifyDeliveryCode
app.post("/verifyDeliveryCode", async (req, res) => {
  try {
    const { orderId, code } = req.body;
    if (!orderId || !code) {
      return res.status(400).json({ success: false, error: "orderId and code required" });
    }

    const ordersSnap = await db.collectionGroup("orders").where("__name__", "==", orderId).get();
    if (ordersSnap.empty) {
      return res.status(404).json({ success: false, error: "Order not found" });
    }

    const orderDoc = ordersSnap.docs[0];
    const order = orderDoc.data();

    if (order.status !== "Awaiting Verification") {
      return res.status(400).json({ success: false, error: "Order not awaiting verification" });
    }
    if (order.verificationCode !== code) {
      return res.status(403).json({ success: false, error: "Invalid code" });
    }

    await orderDoc.ref.update({
      status: "Delivered",
      deliveredAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ success: true, message: "Delivery verified" });
  } catch (err) {
    console.error("verifyDeliveryCode error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /dispatchToThirdParty
app.post("/dispatchToThirdParty", async (req, res) => {
  try {
    const { orderId, partner } = req.body;
    if (!orderId || !partner) {
      return res.status(400).json({ success: false, error: "orderId and partner required" });
    }

    const validPartners = ["Shiprocket", "Delhivery", "Shadowfax"];
    if (!validPartners.includes(partner)) {
      return res.status(400).json({ success: false, error: `Partner must be: ${validPartners.join(", ")}` });
    }

    const prefix = { Shiprocket: "SR", Delhivery: "DH", Shadowfax: "SF" }[partner];
    const trackingId = `${prefix}-${Date.now()}`;

    await db.collection("delivery_partner_logs").add({
      orderId,
      partner,
      trackingId,
      status: "Dispatched",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const ordersSnap = await db.collectionGroup("orders").where("__name__", "==", orderId).get();
    if (!ordersSnap.empty) {
      await ordersSnap.docs[0].ref.update({
        outOfCity: true,
        status: "Out for Delivery",
      });
    }

    return res.json({ success: true, trackingId, partner, status: "Dispatched" });
  } catch (err) {
    console.error("dispatchToThirdParty error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /thirdPartyWebhook
app.post("/thirdPartyWebhook", async (req, res) => {
  try {
    const { trackingId, status, orderId } = req.body;
    if (!trackingId || !status) {
      return res.status(400).json({ error: "trackingId and status required" });
    }

    const logsSnap = await db.collection("delivery_partner_logs").where("trackingId", "==", trackingId).limit(1).get();
    if (logsSnap.empty) {
      return res.status(404).json({ error: "Tracking ID not found" });
    }

    await logsSnap.docs[0].ref.update({
      status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (status === "Delivered" && orderId) {
      const ordersSnap = await db.collectionGroup("orders").where("__name__", "==", orderId).get();
      ordersSnap.forEach((doc) => {
        doc.ref.update({
          status: "Delivered",
          deliveredAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("thirdPartyWebhook error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// POST /paySalary
app.post("/paySalary", async (req, res) => {
  try {
    const { collection, personId, amount, monthYear, mode } = req.body;
    if (!collection || !personId || !amount || !monthYear || !mode) {
      return res.status(400).json({ success: false, error: "All fields required" });
    }
    if (!["workers", "deliveryBoys"].includes(collection)) {
      return res.status(400).json({ success: false, error: "collection must be 'workers' or 'deliveryBoys'" });
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    await db.collection(collection).doc(personId).collection("salaryPayments").add({
      amount,
      monthYear,
      paidAt: now,
      mode,
    });

    await db.collection(collection).doc(personId).update({
      totalEarnings: admin.firestore.FieldValue.increment(amount),
    });

    return res.json({ success: true, message: "Salary recorded" });
  } catch (err) {
    console.error("paySalary error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /sendSMSOTP (optional fallback)
app.post("/sendSMSOTP", async (req, res) => {
  try {
    const { phoneNumber, otp } = req.body;
    if (!phoneNumber || !otp) {
      return res.status(400).json({ success: false, error: "phoneNumber and otp required" });
    }
    console.log(`SMS OTP for ${phoneNumber}: ${otp}`);
    return res.json({ success: true, message: "FCM is primary; SMS provider not configured." });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Graceful Shutdown ───
function gracefulShutdown() {
  console.log("\nShutting down gracefully...");
  listeners.forEach((unsub) => unsub());
  process.exit(0);
}

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

// ─── Start ───
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  startListeners();
});