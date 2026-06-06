const axios = require("axios");
const { getConfig } = require("./configLoader");

let twilio = null;
try {
  twilio = require("twilio");
} catch {
  console.log("[VoiceAlert] twilio package not available — will use HTTP fallback");
}

async function callAlert(phone, message) {
  const config = getConfig();
  const accountSid = config?.notifications?.twilioAccountSid;
  const authToken = config?.notifications?.twilioAuthToken;
  const twilioPhone = config?.notifications?.twilioPhoneNumber;
  const webhookUrl = config?.notifications?.voiceWebhookUrl;

  if (accountSid && authToken && twilioPhone && twilio) {
    try {
      const client = twilio(accountSid, authToken);
      const call = await client.calls.create({
        twiml: `<Response><Say voice="alice">${message}</Say></Response>`,
        to: phone,
        from: twilioPhone,
      });
      console.log(`[VoiceAlert] Twilio call placed to ${phone}, sid: ${call.sid}`);
      return { called: true, provider: "twilio", sid: call.sid };
    } catch (err) {
      console.error(`[VoiceAlert] Twilio call failed for ${phone}:`, err.message);
      if (!webhookUrl) {
        return { called: false, reason: err.message };
      }
    }
  }

  if (webhookUrl) {
    try {
      const payload = { phoneNumber: phone, message };
      const res = await axios.post(webhookUrl, payload, {
        headers: { "Content-Type": "application/json" },
        timeout: 10000,
      });
      console.log(`[VoiceAlert] Webhook called for ${phone}, status: ${res.status}`);
      return { called: true, provider: "webhook" };
    } catch (err) {
      console.error(`[VoiceAlert] Webhook call failed for ${phone}:`, err.message);
      return { called: false, reason: err.message };
    }
  }

  console.log("[VoiceAlert] No provider configured — skipping call to", phone);
  return { called: false, reason: "no_provider_configured" };
}

async function lowStockAlert(productName, stock, phone) {
  return callAlert(phone, `Alert: ${productName} has only ${stock} units remaining. Please restock immediately.`);
}

module.exports = { callAlert, lowStockAlert };
