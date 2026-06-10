const NodeCache = require("node-cache");

const cache = new NodeCache({ stdTTL: 30 * 24 * 3600, checkperiod: 3600 }); // 30 day cache
const IndiaPostApiBase = "https://api.postalpincode.in/pincode";

async function validatePincode(pincode) {
  if (!pincode || !/^\d{6}$/.test(pincode)) {
    return { valid: false, error: "Pincode must be 6 digits" };
  }

  const cached = cache.get(pincode);
  if (cached) return cached;

  try {
    const res = await fetch(`${IndiaPostApiBase}/${pincode}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      const result = { valid: false, error: "India Post API error", pincode };
      cache.set(pincode, result);
      return result;
    }
    const data = await res.json();
    if (!Array.isArray(data) || data[0]?.Status !== "Success" || !data[0]?.PostOffice?.length) {
      const result = { valid: false, error: "Invalid pincode", pincode };
      cache.set(pincode, result);
      return result;
    }
    const postOffice = data[0].PostOffice[0];
    const result = {
      valid: true,
      pincode,
      city: postOffice.District || postOffice.Division || "",
      state: postOffice.State || "",
      district: postOffice.District || "",
      country: postOffice.Country || "India",
      area: postOffice.Name || "",
    };
    cache.set(pincode, result);
    return result;
  } catch (err) {
    // Fallback: basic regex check for common Indian pincodes
    const result = {
      valid: /^\d{6}$/.test(pincode),
      pincode,
      city: "",
      state: "",
      district: "",
      country: "India",
      area: "",
      warning: "Could not verify with India Post API",
    };
    cache.set(pincode, result);
    return result;
  }
}

module.exports = { validatePincode };
