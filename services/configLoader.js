const { getFirestore } = require("firebase-admin/firestore");
const NodeCache = require("node-cache");

const db = getFirestore();
const configCache = new NodeCache({ stdTTL: 3600, checkperiod: 120 });

let currentConfig = null;
let loadCount = 0;

async function loadConfig() {
  try {
    // Primary: appConfig/settings (what owner dashboard writes to)
    let snap = await db.collection("appConfig").doc("settings").get();
    if (!snap.exists) {
      // Fallback: config/appConfig (alternate path)
      snap = await db.collection("config").doc("appConfig").get();
    }
    if (!snap.exists) {
      // Fallback: appConfig/main (oldest path)
      snap = await db.collection("appConfig").doc("main").get();
    }
    if (snap.exists) {
      currentConfig = { id: snap.id, ...snap.data() };
      configCache.set("appConfig", currentConfig);
      loadCount++;
      console.log(`[ConfigLoader] Config loaded (#${loadCount}):`, currentConfig.business?.name || "Unnamed");
      return currentConfig;
    }
    console.warn("[ConfigLoader] No appConfig document found");
    return null;
  } catch (err) {
    console.error("[ConfigLoader] Failed to load config:", err.message);
    return currentConfig;
  }
}

function getConfig() {
  return configCache.get("appConfig") || currentConfig;
}

loadConfig();
setInterval(loadConfig, 3600000);

module.exports = { loadConfig, getConfig };
