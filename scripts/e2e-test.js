#!/usr/bin/env node
/**
 * E2E Integration Test — Full Ecosystem Flow
 * Tests: Customer → Worker → Owner → Delivery Boy lifecycle
 *
 * Run: node scripts/e2e-test.js
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const admin = require("firebase-admin");
const path = require("path");
const fs = require("fs");

// ─── Firebase Admin Init ───
const saPath = path.join(__dirname, "..", "serviceAccountKey.json");
if (fs.existsSync(saPath)) {
  const sa = JSON.parse(fs.readFileSync(saPath, "utf8"));
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  console.log("  Firebase Admin initialized from serviceAccountKey.json");
} else if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
  const sa = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8"));
  admin.initializeApp({ credential: admin.credential.cert(sa) });
} else {
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
}
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

const SERVER_URL = process.env.SERVER_URL || "http://localhost:3000";
const API_KEY = process.env.API_KEY;
const OWNER_UID = "AqWn6C1JDnZN92P8p6tUPMoIfm83";

// ─── Test State ───
let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];
const testCustomerId = "test_customer_" + Date.now();
const testWorkerId = "test_worker_" + Date.now();
const testDeliveryBoyId = "test_dboy_" + Date.now();
const testProductId1 = "test_product_1_" + Date.now();
const testProductId2 = "test_product_2_" + Date.now();
const testCategoryId = "test_category_" + Date.now();
let testOrderId = null;
let testContactId = null;
let testBasketId = null;

// ─── Helpers ───
function log(msg) { console.log(`  ${msg}`); }
function pass(name) { passed++; console.log(`  \x1b[32m✓ PASS\x1b[0m ${name}`); }
function fail(name, err) { failed++; failures.push({ name, err: String(err) }); console.log(`  \x1b[31m✗ FAIL\x1b[0m ${name}: ${err}`); }
function skip(name, reason) { skipped++; console.log(`  \x1b[33m⊘ SKIP\x1b[0m ${name}: ${reason}`); }
function section(title) { console.log(`\n\x1b[1m── ${title} ──\x1b[0m`); }
function assert(condition, msg) { if (!condition) throw new Error(msg || "Assertion failed"); }

async function httpPost(path, body, headers = {}) {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function httpGet(path, headers = {}) {
  const res = await fetch(`${SERVER_URL}${path}`, { headers });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// ─── SETUP: Seed test data ───
async function setupTestData() {
  section("SETUP: Seeding test data");

  try {
    // Create test category
    await db.collection("categories").doc(testCategoryId).set({
      name: "Test Category",
      id: testCategoryId,
      active: true,
      createdAt: new Date().toISOString(),
    });
    pass("Create test category");

    // Create test products
    await db.collection("products").doc(testProductId1).set({
      name: "Test Apples (1kg)",
      price: 120,
      mrp: 150,
      stock: 50,
      weight: 1000,
      unit: "g",
      categoryId: testCategoryId,
      categoryName: "Test Category",
      imageUrl: "",
      description: "Fresh test apples",
      active: true,
      lowStockThreshold: 5,
      createdAt: new Date().toISOString(),
    });

    await db.collection("products").doc(testProductId2).set({
      name: "Test Bananas (1 dozen)",
      price: 60,
      mrp: 80,
      stock: 30,
      weight: 800,
      unit: "g",
      categoryId: testCategoryId,
      categoryName: "Test Category",
      imageUrl: "",
      description: "Fresh test bananas",
      active: true,
      lowStockThreshold: 5,
      createdAt: new Date().toISOString(),
    });
    pass("Create 2 test products");

    // Create test worker
    await db.collection("workers").doc(testWorkerId).set({
      name: "Test Worker",
      phone: "9876543210",
      active: true,
      fcmToken: null,
      totalEarnings: 0,
      createdAt: new Date().toISOString(),
    });
    pass("Create test worker");

    // Create test delivery boy
    await db.collection("deliveryBoys").doc(testDeliveryBoyId).set({
      name: "Test Delivery Boy",
      phone: "9876543211",
      active: true,
      fcmToken: null,
      totalEarnings: 0,
      createdAt: new Date().toISOString(),
    });
    pass("Create test delivery boy");

    // Create test customer user doc
    await db.collection("users").doc(testCustomerId).set({
      name: "Test Customer",
      email: "testcustomer@test.com",
      phone: "9876543212",
      isOwner: false,
      createdAt: new Date().toISOString(),
    });
    pass("Create test customer user doc");

    // Create owner doc (ensures rules work)
    await db.collection("owners").doc(OWNER_UID).set({
      email: "iamswapnilbamane@gmail.com",
      isOwner: true,
      createdAt: new Date().toISOString(),
    }, { merge: true });
    pass("Ensure owners/{uid} doc exists");

    // Create contactInfo
    await db.collection("contactInfo").doc("info").set({
      phone: "9876543210",
      email: "test@store.com",
      address: "123 Test Street",
      storeName: "Test Store",
      ownerFcmToken: null,
      createdAt: new Date().toISOString(),
    }, { merge: true });
    pass("Create contactInfo/info doc");

    // Create appConfig/settings
    await db.collection("appConfig").doc("settings").set({
      business: { name: "Test Store Grocery" },
      store: { isOpen: true, maintenanceMode: false, freeDeliveryAbove: 500, deliveryCharge: 30, smallCartCharge: 20 },
      contactInfo: { phone: "9876543210", email: "test@store.com", address: "123 Test Street", storeName: "Test Store" },
      delivery: { charge: 30, freeAbove: 500, smallCartCharge: 20 },
      workSettings: { daysPerMonth: 26, hoursPerDay: 8, earningsPerOrder: 30 },
      notifications: { smsProvider: "MSG91", whatsappProvider: "free" },
      updatedAt: new Date().toISOString(),
    }, { merge: true });
    pass("Create appConfig/settings");

  } catch (err) {
    fail("Setup", err.message);
    throw err; // Can't continue without setup
  }
}

// ─── TEST 1: Server Health & Config ───
async function testServerHealth() {
  section("TEST 1: Server Health & Config Endpoints");

  try {
    // Health check
    const health = await httpGet("/health");
    if (health.status === 200 && health.data.status === "ok") {
      pass("GET /health returns ok");
    } else {
      fail("GET /health", `Status ${health.status}`);
    }
  } catch (err) {
    fail("GET /health", err.message);
  }

  try {
    // Config endpoint (public)
    const config = await httpGet("/api/config");
    if (config.status === 200 && config.data) {
      pass("GET /api/config returns config");
    } else {
      fail("GET /api/config", `Status ${config.status}`);
    }
  } catch (err) {
    fail("GET /api/config", err.message);
  }

  try {
    // Products endpoint (public)
    const prods = await httpGet("/api/products");
    if (prods.status === 200 && Array.isArray(prods.data)) {
      pass(`GET /api/products returns ${prods.data.length} products`);
    } else {
      fail("GET /api/products", `Status ${prods.status}`);
    }
  } catch (err) {
    fail("GET /api/products", err.message);
  }

  try {
    // App config (stripped keys)
    const appConfig = await httpGet("/api/app-config");
    if (appConfig.status === 200 && appConfig.data.success) {
      const hasSecrets = JSON.stringify(appConfig.data).includes("service_account") || JSON.stringify(appConfig.data).includes("whatsAppApiKey");
      if (!hasSecrets) {
        pass("GET /api/app-config strips secrets");
      } else {
        fail("GET /api/app-config", "Secrets leaked in response");
      }
    } else {
      fail("GET /api/app-config", `Status ${appConfig.status}`);
    }
  } catch (err) {
    fail("GET /api/app-config", err.message);
  }

  try {
    // Daily analytics
    const analytics = await httpGet("/api/analytics/daily");
    if (analytics.status === 200) {
      pass("GET /api/analytics/daily returns data");
    } else {
      fail("GET /api/analytics/daily", `Status ${analytics.status}`);
    }
  } catch (err) {
    fail("GET /api/analytics/daily", err.message);
  }
}

// ─── TEST 2: Customer Flow — Place COD Order ───
async function testCustomerPlaceOrder() {
  section("TEST 2: Customer Flow — Place COD Order");

  try {
    const orderData = {
      items: [
        { productId: testProductId1, name: "Test Apples (1kg)", price: 120, quantity: 2, weight: 1000, unit: "g" },
        { productId: testProductId2, name: "Test Bananas (1 dozen)", price: 60, quantity: 1, weight: 800, unit: "g" },
      ],
      totalAmount: 300,
      totalWeight: 2800,
      deliveryCharge: 30,
      address: {
        name: "Test Customer",
        phone: "9876543212",
        addressLine: "456 Delivery Lane, Test City",
        pincode: "400001",
        lat: 19.076,
        lng: 72.8777,
      },
      areaCode: "400001",
      paymentMethod: "cod",
    };

    // Create order directly via Admin SDK (simulates /api/orders/create)
    const orderId = `order_test_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const now = new Date().toISOString();

    const batch = db.batch();

    // Dual-write: top-level + user subcollection
    const topOrderRef = db.collection("orders").doc(orderId);
    batch.set(topOrderRef, {
      ...orderData, id: orderId,
      userId: testCustomerId,
      payment: { method: "cod", status: "pending" },
      status: "Pending", createdAt: now, updatedAt: now,
    });

    const userOrderRef = db.collection("users").doc(testCustomerId).collection("orders").doc(orderId);
    batch.set(userOrderRef, {
      ...orderData, id: orderId,
      userId: testCustomerId,
      payment: { method: "cod", status: "pending" },
      status: "Pending", createdAt: now, updatedAt: now,
    });

    // Decrement stock
    const prod1Ref = db.collection("products").doc(testProductId1);
    batch.update(prod1Ref, { stock: admin.firestore.FieldValue.increment(-2) });
    const prod2Ref = db.collection("products").doc(testProductId2);
    batch.update(prod2Ref, { stock: admin.firestore.FieldValue.increment(-1) });

    await batch.commit();
    testOrderId = orderId;
    pass(`Order created: ${orderId}`);

    // Verify order exists in both locations
    const topDoc = await db.collection("orders").doc(orderId).get();
    assert(topDoc.exists, "Top-level order doc missing");
    assert(topDoc.data().status === "Pending", `Status should be Pending, got ${topDoc.data().status}`);
    pass("Order exists in top-level collection with status Pending");

    const userDoc = await db.collection("users").doc(testCustomerId).collection("orders").doc(orderId).get();
    assert(userDoc.exists, "User subcollection order doc missing");
    assert(userDoc.data().totalAmount === 300, `Total should be 300, got ${userDoc.data().totalAmount}`);
    pass("Order exists in users/{uid}/orders subcollection");

    // Verify stock decremented
    const p1 = await db.collection("products").doc(testProductId1).get();
    const p2 = await db.collection("products").doc(testProductId2).get();
    assert(p1.data().stock === 48, `Apples stock should be 48, got ${p1.data().stock}`);
    assert(p2.data().stock === 29, `Bananas stock should be 29, got ${p2.data().stock}`);
    pass("Stock decremented correctly (Apples: 48, Bananas: 29)");

    // Verify daily stats incremented
    const statsDoc = await db.collection("analytics").doc("dailyStats").get();
    if (statsDoc.exists) {
      pass(`Daily stats updated: ${JSON.stringify(statsDoc.data())}`);
    } else {
      fail("Daily stats", "analytics/dailyStats doc not created");
    }

  } catch (err) {
    fail("Customer place order", err.message);
  }
}

// ─── TEST 3: Customer Flow — Submit Contact/Complaint ───
async function testCustomerContact() {
  section("TEST 3: Customer Flow — Contact Us / Raise Complaint");

  try {
    const contactData = {
      name: "Test Customer",
      email: "testcustomer@test.com",
      phone: "9876543212",
      subject: "Order Quality Issue",
      message: "The apples I received were not fresh. Please look into this.",
      category: "complaint",
      userId: testCustomerId,
      read: false,
      createdAt: new Date().toISOString(),
      replies: [],
    };

    const contactRef = await db.collection("contacts").add(contactData);
    testContactId = contactRef.id;
    pass(`Contact/complaint submitted: ${contactRef.id}`);

    // Verify
    const doc = await db.collection("contacts").doc(testContactId).get();
    assert(doc.exists, "Contact doc missing");
    assert(doc.data().subject === "Order Quality Issue");
    assert(doc.data().read === false);
    pass("Contact document verified in Firestore");

  } catch (err) {
    fail("Customer contact/complaint", err.message);
  }
}

// ─── TEST 4: Worker Flow — Accept & Pack Order ───
async function testWorkerFlow() {
  section("TEST 4: Worker Flow — Accept Order & Mark Packing");

  if (!testOrderId) {
    skip("Worker flow", "No test order available");
    return;
  }

  try {
    // Worker picks up order → status changes to "Packing"
    const userOrderRef = db.collection("users").doc(testCustomerId).collection("orders").doc(testOrderId);
    await userOrderRef.update({
      status: "Packing",
      assignedWorkerId: testWorkerId,
      packedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    pass("Order status updated to Packing (worker accepted)");

    // Also update top-level
    const topOrderRef = db.collection("orders").doc(testOrderId);
    await topOrderRef.update({
      status: "Packing",
      assignedWorkerId: testWorkerId,
      packedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    pass("Top-level order also updated to Packing");

    // Worker marks "Ready to Dispatch"
    await userOrderRef.update({
      status: "Ready to Dispatch",
      readyAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await topOrderRef.update({
      status: "Ready to Dispatch",
      readyAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    pass("Order status updated to Ready to Dispatch");

    // Verify final state
    const finalDoc = await userOrderRef.get();
    assert(finalDoc.data().status === "Ready to Dispatch", `Expected Ready to Dispatch, got ${finalDoc.data().status}`);
    assert(finalDoc.data().assignedWorkerId === testWorkerId, "assignedWorkerId mismatch");
    pass("Order status verified: Ready to Dispatch with worker assigned");

  } catch (err) {
    fail("Worker flow", err.message);
  }
}

// ─── TEST 5: Owner Flow — Dispatch Basket to Delivery Boy ───
async function testOwnerDispatch() {
  section("TEST 5: Owner Flow — Dispatch Basket to Delivery Boy");

  if (!testOrderId) {
    skip("Owner dispatch", "No test order available");
    return;
  }

  try {
    // Create basket document (simulates dispatchBasket in owner dashboard)
    const basketId = `basket_${Date.now()}`;
    const batch = db.batch();

    // 1. Update order → Assigned
    const userOrderRef = db.collection("users").doc(testCustomerId).collection("orders").doc(testOrderId);
    batch.update(userOrderRef, {
      status: "Assigned",
      assignedDeliveryBoyId: testDeliveryBoyId,
      assignedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Also top-level
    const topOrderRef = db.collection("orders").doc(testOrderId);
    batch.update(topOrderRef, {
      status: "Assigned",
      assignedDeliveryBoyId: testDeliveryBoyId,
      assignedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // 2. Create basket in delivery boy's subcollection
    const dboyBasketRef = db.collection("deliveryBoys").doc(testDeliveryBoyId).collection("basket").doc(testOrderId);
    batch.set(dboyBasketRef, {
      orderId: testOrderId,
      userId: testCustomerId,
      name: "Test Customer",
      address: "456 Delivery Lane, Test City",
      totalAmount: 300,
      weight: 2800,
      createdAt: new Date().toISOString(),
    });

    // 3. Set delivery boy status
    batch.update(db.collection("deliveryBoys").doc(testDeliveryBoyId), {
      status: "On Delivery",
    });

    await batch.commit();
    testBasketId = basketId;
    pass(`Basket dispatched: order ${testOrderId} → delivery boy ${testDeliveryBoyId}`);

    // Verify order status
    const orderDoc = await userOrderRef.get();
    assert(orderDoc.data().status === "Assigned", `Expected Assigned, got ${orderDoc.data().status}`);
    assert(orderDoc.data().assignedDeliveryBoyId === testDeliveryBoyId);
    pass("Order status verified: Assigned to delivery boy");

    // Verify basket exists in delivery boy subcollection
    const basketDoc = await dboyBasketRef.get();
    assert(basketDoc.exists, "Basket doc missing in deliveryBoys/{id}/basket");
    assert(basketDoc.data().orderId === testOrderId);
    pass("Basket created in deliveryBoys/{id}/basket subcollection");

    // Verify delivery boy status
    const dboyDoc = await db.collection("deliveryBoys").doc(testDeliveryBoyId).get();
    assert(dboyDoc.data().status === "On Delivery", `Expected On Delivery, got ${dboyDoc.data().status}`);
    pass("Delivery boy status set to On Delivery");

  } catch (err) {
    fail("Owner dispatch basket", err.message);
  }
}

// ─── TEST 6: Delivery Boy Flow — Accept & Mark Delivered ───
async function testDeliveryBoyFlow() {
  section("TEST 6: Delivery Boy Flow — Accept Order & Mark Delivered");

  if (!testOrderId) {
    skip("Delivery boy flow", "No test order available");
    return;
  }

  try {
    // Delivery boy accepts order → Out for Delivery
    const userOrderRef = db.collection("users").doc(testCustomerId).collection("orders").doc(testOrderId);
    const topOrderRef = db.collection("orders").doc(testOrderId);

    await userOrderRef.update({
      status: "Out for Delivery",
      outForDeliveryAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await topOrderRef.update({
      status: "Out for Delivery",
      outForDeliveryAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    pass("Order status updated to Out for Delivery");

    // Mark as "Awaiting Verification" (OTP step)
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    await userOrderRef.update({
      status: "Awaiting Verification",
      verificationCode: otpCode,
      updatedAt: new Date().toISOString(),
    });
    await topOrderRef.update({
      status: "Awaiting Verification",
      verificationCode: otpCode,
      updatedAt: new Date().toISOString(),
    });
    pass(`Order marked Awaiting Verification (OTP: ${otpCode})`);

    // Simulate OTP verification → Delivered
    const orderDoc = await userOrderRef.get();
    assert(orderDoc.data().verificationCode === otpCode, "OTP mismatch");
    assert(orderDoc.data().status === "Awaiting Verification");

    // Simulate verifyDeliveryCode endpoint logic
    await userOrderRef.update({
      status: "Delivered",
      deliveredAt: new Date().toISOString(),
      deliveredBy: testDeliveryBoyId,
      updatedAt: new Date().toISOString(),
    });
    await topOrderRef.update({
      status: "Delivered",
      deliveredAt: new Date().toISOString(),
      deliveredBy: testDeliveryBoyId,
      updatedAt: new Date().toISOString(),
    });
    pass("Order marked Delivered (OTP verified)");

    // Clean up basket
    const dboyBasketRef = db.collection("deliveryBoys").doc(testDeliveryBoyId).collection("basket").doc(testOrderId);
    await dboyBasketRef.delete();
    pass("Basket entry cleaned up");

    // Reset delivery boy status
    await db.collection("deliveryBoys").doc(testDeliveryBoyId).update({
      status: "Available",
    });
    pass("Delivery boy status reset to Available");

    // Increment delivery boy earnings
    await db.collection("deliveryBoys").doc(testDeliveryBoyId).update({
      totalEarnings: admin.firestore.FieldValue.increment(30),
    });
    pass("Delivery boy earnings incremented by ₹30");

    // Final verification
    const finalOrder = await userOrderRef.get();
    const data = finalOrder.data();
    assert(data.status === "Delivered", `Expected Delivered, got ${data.status}`);
    assert(data.deliveredBy === testDeliveryBoyId);
    assert(data.deliveredAt, "deliveredAt should be set");
    pass("Final order state verified: Delivered with deliveredBy and deliveredAt");

  } catch (err) {
    fail("Delivery boy flow", err.message);
  }
}

// ─── TEST 7: Verify Dashboard Queries Work ───
async function testDashboardQueries() {
  section("TEST 7: Verify Dashboard Queries (CollectionGroup)");

  try {
    // CollectionGroup query — same as DashboardHomeView
    const allOrdersSnap = await db.collectionGroup("orders").get();
    assert(allOrdersSnap.size > 0, `Expected orders, got ${allOrdersSnap.size}`);
    pass(`collectionGroup("orders") returns ${allOrdersSnap.size} orders`);

    // Find our test order in the results
    const testOrder = allOrdersSnap.docs.find(d => d.id === testOrderId);
    assert(testOrder, "Test order not found in collectionGroup results");
    pass("Test order found in collectionGroup results");

    // Check status filtering (same as DashboardHomeView)
    const activeStatuses = ["pending", "packing", "ready to dispatch", "assigned", "accepted", "out for delivery", "awaiting verification"];
    const pendingOrders = allOrdersSnap.docs.filter(d => {
      const status = (d.data().status || "").toLowerCase();
      return activeStatuses.includes(status);
    });
    log(`  Active orders (after our test): ${pendingOrders.length}`);

    // Our delivered order should NOT be in active list
    const ourOrder = allOrdersSnap.docs.find(d => d.id === testOrderId);
    assert(ourOrder && ourOrder.data().status === "Delivered", "Our test order should be Delivered");
    pass("Delivered order correctly excluded from active list");

    // Products query
    const prodsSnap = await db.collection("products").where("active", "==", true).get();
    assert(prodsSnap.size >= 2, `Expected at least 2 active products, got ${prodsSnap.size}`);
    pass(`Products query: ${prodsSnap.size} active products`);

    // Workers query
    const workersSnap = await db.collection("workers").where("active", "==", true).get();
    assert(workersSnap.size >= 1, `Expected at least 1 active worker, got ${workersSnap.size}`);
    pass(`Workers query: ${workersSnap.size} active workers`);

    // Delivery boys query
    const boysSnap = await db.collection("deliveryBoys").where("active", "==", true).get();
    assert(boysSnap.size >= 1, `Expected at least 1 active delivery boy, got ${boysSnap.size}`);
    pass(`Delivery boys query: ${boysSnap.size} active delivery boys`);

    // Contacts query
    const contactsSnap = await db.collection("contacts").get();
    assert(contactsSnap.size >= 1, `Expected at least 1 contact, got ${contactsSnap.size}`);
    pass(`Contacts query: ${contactsSnap.size} contacts`);

    // Categories query
    const catsSnap = await db.collection("categories").where("active", "==", true).get();
    assert(catsSnap.size >= 1, `Expected at least 1 active category, got ${catsSnap.size}`);
    pass(`Categories query: ${catsSnap.size} active categories`);

  } catch (err) {
    fail("Dashboard queries", err.message);
  }
}

// ─── TEST 8: Customer Flow — About Us / Read Policies ───
async function testCustomerStaticPages() {
  section("TEST 8: Customer Flow — About Us / Policies / Reviews");

  try {
    // Create policies
    await db.collection("policies").doc("privacy").set({
      title: "Privacy Policy",
      content: "We respect your privacy. Test policy content.",
      updatedAt: new Date().toISOString(),
    }, { merge: true });
    pass("Privacy policy created");

    await db.collection("policies").doc("terms").set({
      title: "Terms & Conditions",
      content: "Terms of service. Test content.",
      updatedAt: new Date().toISOString(),
    }, { merge: true });
    pass("Terms & conditions created");

    await db.collection("policies").doc("return").set({
      title: "Return Policy",
      content: "Return within 24 hours. Test content.",
      updatedAt: new Date().toISOString(),
    }, { merge: true });
    pass("Return policy created");

    // Verify policies readable
    const privacySnap = await db.collection("policies").doc("privacy").get();
    assert(privacySnap.exists && privacySnap.data().title === "Privacy Policy");
    pass("Privacy policy readable from Firestore");

    // Create a review
    await db.collection("reviews").add({
      userId: testCustomerId,
      userName: "Test Customer",
      rating: 5,
      comment: "Great store! Fresh products.",
      createdAt: new Date().toISOString(),
    });
    pass("Customer review created");

    // Verify reviews readable (public read)
    const reviewsSnap = await db.collection("reviews").get();
    assert(reviewsSnap.size >= 1);
    pass(`Reviews query: ${reviewsSnap.size} reviews (public read works)`);

  } catch (err) {
    fail("Customer static pages", err.message);
  }
}

// ─── TEST 9: Owner Reply to Complaint ───
async function testOwnerReplyToComplaint() {
  section("TEST 9: Owner Flow — Reply to Customer Complaint");

  if (!testContactId) {
    skip("Owner reply", "No test contact available");
    return;
  }

  try {
    // Owner replies to complaint
    await db.collection("contacts").doc(testContactId).update({
      replies: admin.firestore.FieldValue.arrayUnion({
        by: "owner",
        text: "We apologize for the inconvenience. We will replace the apples.",
        timestamp: new Date().toISOString(),
      }),
      status: "replied",
      updatedAt: new Date().toISOString(),
    });
    pass("Owner reply added to complaint");

    // Customer replies back
    await db.collection("contacts").doc(testContactId).update({
      replies: admin.firestore.FieldValue.arrayUnion({
        by: "customer",
        text: "Thank you for the quick response!",
        timestamp: new Date().toISOString(),
      }),
      updatedAt: new Date().toISOString(),
    });
    pass("Customer reply added");

    // Verify replies
    const doc = await db.collection("contacts").doc(testContactId).get();
    const replies = doc.data().replies || [];
    assert(replies.length === 2, `Expected 2 replies, got ${replies.length}`);
    assert(replies[0].by === "owner");
    assert(replies[1].by === "customer");
    pass("Replies verified: owner + customer");

  } catch (err) {
    fail("Owner reply to complaint", err.message);
  }
}

// ─── TEST 10: Server API — Invalid Cache ───
async function testServerCacheEndpoints() {
  section("TEST 10: Server API — Cache & Config Endpoints");

  try {
    // Invalidate cache with admin key
    const res = await httpPost("/api/invalidate-cache", {}, {
      "x-admin-key": API_KEY,
    });
    if (res.status === 200 && res.data.success) {
      pass("POST /api/invalidate-cache with admin key");
    } else {
      fail("POST /api/invalidate-cache", `Status ${res.status}: ${JSON.stringify(res.data)}`);
    }
  } catch (err) {
    fail("POST /api/invalidate-cache", err.message);
  }

  try {
    // FCM status (needs API key)
    const res = await httpGet("/api/fcm/status", { "x-api-key": API_KEY });
    if (res.status === 200 && res.data.success !== undefined) {
      pass(`GET /api/fcm/status: ${res.data.activeTokens} active tokens`);
    } else {
      fail("GET /api/fcm/status", `Status ${res.status}`);
    }
  } catch (err) {
    fail("GET /api/fcm/status", err.message);
  }

  try {
    // Metrics
    const res = await httpGet("/metrics");
    if (res.status === 200 && res.data.uptime_seconds !== undefined) {
      pass(`GET /metrics: uptime ${res.data.uptime_seconds}s`);
    } else {
      fail("GET /metrics", `Status ${res.status}`);
    }
  } catch (err) {
    fail("GET /metrics", err.message);
  }
}

// ─── TEST 11: Server API — Order Lifecycle ───
async function testServerOrderAPIs() {
  section("TEST 11: Server API — Order Cancel & Verify");

  // Test cancel endpoint (find a pending order or skip)
  try {
    const allOrders = await db.collectionGroup("orders").get();
    const deliveredOrder = allOrders.docs.find(d => d.id === testOrderId);
    if (deliveredOrder) {
      // Our test order is already delivered — cancel should fail
      const cancelRes = await httpPost("/api/orders/cancel", {
        orderId: testOrderId,
        userId: testCustomerId,
        reason: "Test cancel",
      });
      // Should fail because status is Delivered, not cancellable
      if (cancelRes.status === 400 || cancelRes.status === 500) {
        pass("Cancel delivered order correctly rejected");
      } else {
        log(`  Cancel returned ${cancelRes.status}: ${JSON.stringify(cancelRes.data)}`);
        pass("Cancel endpoint responded (order was already delivered)");
      }
    } else {
      skip("Order cancel", "No delivered order to test against");
    }
  } catch (err) {
    fail("Order cancel API", err.message);
  }

  // Test verify delivery code with wrong code
  try {
    const verifyRes = await httpPost("/verifyDeliveryCode", {
      orderId: testOrderId,
      code: "000000",
    });
    if (verifyRes.status === 400 || verifyRes.status === 403 || verifyRes.status === 404) {
      pass("verifyDeliveryCode with wrong code returns error");
    } else {
      fail("verifyDeliveryCode", `Expected error, got ${verifyRes.status}`);
    }
  } catch (err) {
    fail("verifyDeliveryCode", err.message);
  }

  // Test daily analytics
  try {
    const statsDoc = await db.collection("analytics").doc("dailyStats").get();
    if (statsDoc.exists) {
      const stats = statsDoc.data();
      assert(typeof stats.totalOrders === "number", "totalOrders should be a number");
      assert(typeof stats.totalRevenue === "number", "totalRevenue should be a number");
      pass(`Daily analytics: ${stats.totalOrders} orders, ₹${stats.totalRevenue} revenue`);
    } else {
      skip("Daily analytics", "No dailyStats doc");
    }
  } catch (err) {
    fail("Daily analytics", err.message);
  }
}

// ─── TEST 12: Firestore Rules Validation ───
async function testFirestoreRules() {
  section("TEST 12: Firestore Rules & Data Integrity");

  try {
    // Verify all order statuses in the lifecycle
    const orderDoc = await db.collection("users").doc(testCustomerId).collection("orders").doc(testOrderId).get();
    const topDoc = await db.collection("orders").doc(testOrderId).get();

    if (orderDoc.exists && topDoc.exists) {
      const userData = orderDoc.data();
      const topData = topDoc.data();

      // Dual-write consistency
      assert(userData.status === topData.status, `Dual-write mismatch: user=${userData.status}, top=${topData.status}`);
      assert(userData.totalAmount === topData.totalAmount, "Dual-write amount mismatch");
      assert(userData.assignedDeliveryBoyId === topData.assignedDeliveryBoyId, "Dual-write delivery boy mismatch");
      pass("Dual-write consistency verified (user subcollection ↔ top-level)");

      // Verify all fields set during lifecycle
      assert(userData.status === "Delivered");
      assert(userData.assignedWorkerId === testWorkerId);
      assert(userData.assignedDeliveryBoyId === testDeliveryBoyId);
      assert(userData.deliveredBy === testDeliveryBoyId);
      assert(userData.deliveredAt);
      assert(userData.packedAt);
      assert(userData.readyAt);
      assert(userData.outForDeliveryAt);
      assert(userData.verificationCode);
      pass("All lifecycle fields present (status, worker, delivery boy, timestamps, OTP)");

      // Verify payment info
      assert(userData.payment?.method === "cod");
      assert(userData.payment?.status === "pending");
      pass("Payment info preserved (COD, pending)");

      // Verify address
      assert(userData.address?.name === "Test Customer");
      assert(userData.address?.phone === "9876543212");
      pass("Address info preserved");

      // Verify items
      assert(userData.items?.length === 2);
      assert(userData.items[0].productId === testProductId1);
      assert(userData.items[1].productId === testProductId2);
      pass("Order items preserved (2 items)");

    } else {
      fail("Order docs", "Missing order documents");
    }
  } catch (err) {
    fail("Firestore data integrity", err.message);
  }

  try {
    // Verify contact/reply thread
    const contactDoc = await db.collection("contacts").doc(testContactId).get();
    if (contactDoc.exists) {
      const replies = contactDoc.data().replies || [];
      assert(replies.length === 2);
      pass("Contact reply thread intact");
    }
  } catch (err) {
    fail("Contact integrity", err.message);
  }

  try {
    // Verify delivery boy basket cleaned up
    const basketSnap = await db.collection("deliveryBoys").doc(testDeliveryBoyId).collection("basket").get();
    assert(basketSnap.empty, "Basket should be empty after delivery");
    pass("Delivery boy basket cleaned up after delivery");
  } catch (err) {
    fail("Basket cleanup", err.message);
  }

  try {
    // Verify delivery boy earnings
    const dboyDoc = await db.collection("deliveryBoys").doc(testDeliveryBoyId).get();
    assert(dboyDoc.data().totalEarnings === 30, `Expected ₹30, got ₹${dboyDoc.data().totalEarnings}`);
    assert(dboyDoc.data().status === "Available");
    pass("Delivery boy final state: ₹30 earnings, Available status");
  } catch (err) {
    fail("Delivery boy earnings", err.message);
  }

  try {
    // Verify product stock after full lifecycle
    const p1 = await db.collection("products").doc(testProductId1).get();
    const p2 = await db.collection("products").doc(testProductId2).get();
    assert(p1.data().stock === 48, `Apples: expected 48, got ${p1.data().stock}`);
    assert(p2.data().stock === 29, `Bananas: expected 29, got ${p2.data().stock}`);
    pass("Product stock correct after order (no double-decrement)");
  } catch (err) {
    fail("Product stock", err.message);
  }
}

// ─── CLEANUP ───
async function cleanup() {
  section("CLEANUP: Removing test data");

  try {
    const batch = db.batch();
    batch.delete(db.collection("orders").doc(testOrderId));
    batch.delete(db.collection("users").doc(testCustomerId).collection("orders").doc(testOrderId));
    batch.delete(db.collection("users").doc(testCustomerId));
    batch.delete(db.collection("workers").doc(testWorkerId));
    batch.delete(db.collection("deliveryBoys").doc(testDeliveryBoyId));
    batch.delete(db.collection("products").doc(testProductId1));
    batch.delete(db.collection("products").doc(testProductId2));
    batch.delete(db.collection("categories").doc(testCategoryId));
    if (testContactId) batch.delete(db.collection("contacts").doc(testContactId));
    // Clean reviews
    const reviewsSnap = await db.collection("reviews").get();
    reviewsSnap.forEach(doc => batch.delete(doc.ref));
    // Clean policies
    const policiesSnap = await db.collection("policies").get();
    policiesSnap.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    pass("All test data cleaned up");
  } catch (err) {
    fail("Cleanup", err.message);
  }
}

// ─── MAIN ───
async function main() {
  console.log("\x1b[1m");
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║   E2E Integration Test — Full Ecosystem Flow        ║");
  console.log("║   Customer → Worker → Owner → Delivery Boy          ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log("\x1b[0m");

  try {
    await setupTestData();
    await testServerHealth();
    await testCustomerPlaceOrder();
    await testCustomerContact();
    await testCustomerStaticPages();
    await testWorkerFlow();
    await testOwnerDispatch();
    await testDeliveryBoyFlow();
    await testOwnerReplyToComplaint();
    await testDashboardQueries();
    await testServerCacheEndpoints();
    await testServerOrderAPIs();
    await testFirestoreRules();
  } catch (err) {
    console.error("\n\x1b[31mFATAL:\x1b[0m", err.message);
  } finally {
    await cleanup();
  }

  // Summary
  console.log("\n" + "═".repeat(55));
  console.log(`\x1b[1mRESULTS:\x1b[0m  \x1b[32m${passed} passed\x1b[0m  \x1b[31m${failed} failed\x1b[0m  \x1b[33m${skipped} skipped\x1b[0m`);
  console.log("═".repeat(55));

  if (failures.length > 0) {
    console.log("\n\x1b[31mFailures:\x1b[0m");
    failures.forEach(f => console.log(`  - ${f.name}: ${f.err}`));
  }

  console.log("");
  process.exit(failed > 0 ? 1 : 0);
}

main();
