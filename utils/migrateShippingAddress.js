#!/usr/bin/env node
/**
 * Migration: Migrate existing user addresses to single shippingAddress format
 * 
 * Reads users/{uid}/addresses subcollection (old multi-address format)
 * and creates a single users/{uid}/shippingAddress document.
 * 
 * Usage: node utils/migrateShippingAddress.js [--dry-run]
 */

const admin = require("firebase-admin");

// Initialize Firebase Admin
if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
  const serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8")
  );
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
} else {
  try {
    const serviceAccount = require("./serviceAccountKey.json");
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  } catch (err) {
    console.error("Failed to initialize Firebase Admin.");
    process.exit(1);
  }
}

const db = admin.firestore();
const isDryRun = process.argv.includes("--dry-run");

async function migrate() {
  console.log(`\n=== Shipping Address Migration ${isDryRun ? "(DRY RUN)" : ""} ===\n`);

  const usersSnap = await db.collection("users").get();
  let migrated = 0;
  let skipped = 0;
  let errors = 0;

  for (const userDoc of usersSnap.docs) {
    const userId = userDoc.id;
    const userData = userDoc.data();

    // Check if shippingAddress already exists
    if (userData.shippingAddress) {
      skipped++;
      continue;
    }

    // Get addresses subcollection
    const addressesSnap = await db.collection("users").doc(userId).collection("addresses").orderBy("usedAt", "desc").limit(5).get();

    if (addressesSnap.empty) {
      skipped++;
      continue;
    }

    // Pick the most recently used address
    const latestAddress = addressesSnap.docs[0].data();

    const shippingAddress = {
      address: latestAddress.address || "",
      pincode: (latestAddress.address || "").match(/\b\d{6}\b/)?.[0] || "",
      lat: latestAddress.lat || null,
      lng: latestAddress.lng || null,
      geoHash: "",
      label: latestAddress.label || "Home",
      createdAt: latestAddress.usedAt || admin.firestore.FieldValue.serverTimestamp(),
    };

    if (isDryRun) {
      console.log(`[DRY RUN] Would migrate user ${userId}:`, shippingAddress.address?.substring(0, 50));
    } else {
      try {
        await db.collection("users").doc(userId).set(
          { shippingAddress },
          { merge: true }
        );
        console.log(`Migrated user ${userId}: ${shippingAddress.address?.substring(0, 50)}...`);
      } catch (err) {
        console.error(`Error migrating user ${userId}:`, err.message);
        errors++;
        continue;
      }
    }
    migrated++;
  }

  console.log(`\n=== Migration Complete ===`);
  console.log(`Total users: ${usersSnap.docs.length}`);
  console.log(`Migrated: ${migrated}`);
  console.log(`Skipped (already has shippingAddress): ${skipped}`);
  console.log(`Errors: ${errors}`);
}

migrate().catch(console.error);
