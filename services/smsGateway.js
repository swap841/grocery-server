const { logger } = require("../middleware/logging");
const { getConfig } = require("./configLoader");

function getGatewayUrl() {
  const cfg = getConfig();
  return cfg?.notifications?.smsGatewayUrl || process.env.SMS_GATEWAY_URL || "";
}

function getGatewayApiKey() {
  const cfg = getConfig();
  return cfg?.notifications?.smsGatewayApiKey || process.env.SMS_GATEWAY_API_KEY || "";
}

function getSmsSenderId() {
  const cfg = getConfig();
  return cfg?.notifications?.smsSenderId || process.env.SMS_SENDER_ID || "MYSTR";
}

function isMsg91(url) {
  return url.includes("msg91.com") || url.includes("control.msg91.com");
}

async function sendViaGeneric(phoneNumber, message, otp, gatewayUrl, gatewayApiKey) {
  const payload = { to: phoneNumber, message, otp, apiKey: gatewayApiKey };
  const res = await fetch(gatewayUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gateway returned ${res.status}: ${text}`);
  }
  return await res.json();
}

async function sendViaMsg91Otp(phoneNumber, otp, gatewayApiKey) {
  const url = `https://control.msg91.com/api/v5/otp?authkey=${gatewayApiKey}&mobile=91${phoneNumber}&otp=${otp}&otp_expiry=5`;
  const res = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MSG91 returned ${res.status}: ${text}`);
  }
  return await res.json();
}

async function sendViaMsg91Sms(phoneNumber, message, gatewayApiKey) {
  const senderId = getSmsSenderId();
  const url = `https://api.msg91.com/api/sendhttp.php?authkey=${gatewayApiKey}&mobiles=91${phoneNumber}&message=${encodeURIComponent(message)}&sender=${senderId}&route=4&country=91`;
  const res = await fetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MSG91 SMS returned ${res.status}: ${text}`);
  }
  return await res.text();
}

async function sendSMS(phoneNumber, message, otp) {
  const gatewayUrl = getGatewayUrl();
  const gatewayApiKey = getGatewayApiKey();
  if (!gatewayUrl && !gatewayApiKey) {
    logger.warn(`SMS gateway not configured. Would send to ${phoneNumber}: ${message}`);
    return { success: true, simulated: true };
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (gatewayApiKey && (isMsg91(gatewayUrl) || (!gatewayUrl && gatewayApiKey))) {
        if (otp) {
          await sendViaMsg91Otp(phoneNumber, otp, gatewayApiKey);
        } else {
          await sendViaMsg91Sms(phoneNumber, message, gatewayApiKey);
        }
      } else if (gatewayUrl) {
        await sendViaGeneric(phoneNumber, message, otp, gatewayUrl, gatewayApiKey);
      } else {
        logger.warn(`SMS gateway not configured. Would send to ${phoneNumber}: ${message}`);
        return { success: true, simulated: true };
      }
      logger.info(`SMS sent to ${phoneNumber} (attempt ${attempt + 1})`);
      return { success: true };
    } catch (err) {
      const isLast = attempt === 2;
      logger.warn(`SMS attempt ${attempt + 1}/3 failed: ${err.message}`);
      if (isLast) {
        logger.error(`SMS gateway exhausted retries for ${phoneNumber}`);
        return { success: false, error: err.message };
      }
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

function sendOTP(phoneNumber, otp) {
  const message = `${otp} is your OTP for MyStore. Valid for 5 minutes.`;
  return sendSMS(phoneNumber, message, otp);
}

function sendNotification(phoneNumber, message) {
  return sendSMS(phoneNumber, message, "");
}

module.exports = { sendSMS, sendOTP, sendNotification };
