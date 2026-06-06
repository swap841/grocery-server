const axios = require("axios");
const { getConfig } = require("./configLoader");

async function sendTemplate(to, templateName, variables = {}) {
  const config = getConfig();
  const webhookUrl = config?.notifications?.whatsappWebhook;
  if (!webhookUrl) {
    console.log("[WhatsApp] No webhook URL configured — skipping message to", to);
    return { sent: false, reason: "no_api_key" };
  }
  const templates = config?.notifications?.whatsappTemplates || {};
  const template = templates[templateName];
  if (!template) {
    console.log("[WhatsApp] No template for:", templateName);
    return { sent: false, reason: "no_template" };
  }
  const message = Object.entries(variables).reduce(
    (msg, [key, val]) => msg.replace(`{${key}}`, String(val)),
    template
  );
  try {
    const payload = { phoneNumber: to, templateName, variables, message };
    const res = await axios.post(webhookUrl, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 10000,
    });
    console.log(`[WhatsApp] Sent to ${to}, template: ${templateName}, status: ${res.status}`);
    return { sent: true, message };
  } catch (err) {
    console.error(`[WhatsApp] Failed to send to ${to}:`, err.message);
    return { sent: false, reason: err.message };
  }
}

async function sendDailyReport(summary) {
  const config = getConfig();
  const phones = [config?.contact?.phone].filter(Boolean);
  for (const phone of phones) {
    await sendTemplate(phone, "daily_report", summary);
  }
}

async function sendOrderConfirmation(to, order) {
  await sendTemplate(to, "order_confirmation", {
    orderId: order.id?.substring(0, 8),
    amount: order.totalAmount?.toFixed(2),
    name: order.address?.name,
  });
}

module.exports = { sendTemplate, sendDailyReport, sendOrderConfirmation };
