const NodeCache = require("node-cache");

const trackingCache = new NodeCache({ stdTTL: 86400 });

const providers = {};

function registerProvider(name, handler) {
  providers[name.toLowerCase()] = handler;
}

async function dispatch(order, partnerName, credentials) {
  const name = (partnerName || "").toLowerCase();
  const provider = providers[name];
  if (!provider) {
    return { success: false, error: `Unknown provider: ${partnerName}`, trackingId: null };
  }
  try {
    const result = await provider.dispatch(order, credentials);
    if (result.trackingId) {
      trackingCache.set(result.trackingId, { orderId: order.id, partner: partnerName, status: "dispatched" });
    }
    return { success: true, trackingId: result.trackingId, eta: result.eta || null };
  } catch (err) {
    return { success: false, error: err.message, trackingId: null };
  }
}

async function track(trackingId) {
  const cached = trackingCache.get(trackingId);
  if (cached) return cached;
  return { trackingId, status: "unknown" };
}

async function handleWebhook(partnerName, body) {
  const name = (partnerName || "").toLowerCase();
  const provider = providers[name];
  if (!provider || !provider.handleWebhook) return { success: false };
  return provider.handleWebhook(body);
}

registerProvider("manual", {
  dispatch: async (order) => {
    return { success: true, trackingId: `MANUAL-${order.id}-${Date.now()}`, eta: "24-48 hours" };
  },
});

const shiprocket = require("./shiprocket");
registerProvider("shiprocket", shiprocket);

const dunzo = require("./dunzo");
registerProvider("dunzo", dunzo);

const delhivery = require("./delhivery");
registerProvider("delhivery", delhivery);

const shadowfax = require("./shadowfax");
registerProvider("shadowfax", shadowfax);

module.exports = { registerProvider, dispatch, track, handleWebhook, providers };
