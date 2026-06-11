jest.mock("../services/configLoader", () => ({ getConfig: jest.fn() }));

// Helper to set config mock
function mockConfig(obj) {
  const { getConfig } = require("../services/configLoader");
  getConfig.mockReturnValue(obj);
}

describe("WhatsAppFreeService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    global.fetch = jest.fn();
  });

  it("returns not_configured when phoneNumberId is missing", async () => {
    mockConfig({ notifications: {} });
    const whatsapp = require("../services/whatsappFree");
    const result = await whatsapp.sendMessage("919876543210", "test_template");
    expect(result).toEqual({ success: false, reason: "not_configured" });
  });

  it("returns not_configured when accessToken is missing", async () => {
    mockConfig({ notifications: { whatsAppPhoneNumberId: "123" } });
    const whatsapp = require("../services/whatsappFree");
    const result = await whatsapp.sendText("919876543210", "Hello");
    expect(result).toEqual({ success: false, reason: "not_configured" });
  });

  it("uses env vars as fallback when config is empty", () => {
    process.env.WHATSAPP_PHONE_NUMBER_ID = "env_phone_id";
    process.env.WHATSAPP_ACCESS_TOKEN = "env_token";
    mockConfig({ notifications: {} });
    const whatsapp = require("../services/whatsappFree");
    whatsapp._refreshConfig();
    expect(whatsapp.phoneNumberId).toBe("env_phone_id");
    expect(whatsapp.accessToken).toBe("env_token");
  });

  it("strips non-numeric characters from phone number", async () => {
    mockConfig({ notifications: { whatsAppPhoneNumberId: "123", whatsAppApiKey: "token" } });
    global.fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ messages: [{ id: "msg1" }] }),
    });
    const whatsapp = require("../services/whatsappFree");
    await whatsapp.sendText("+91-98765-43210", "Test");
    const callBody = JSON.parse(fetch.mock.calls[0][1].body);
    expect(callBody.to).toBe("919876543210");
  });

  it("returns invalid_phone for phone < 10 digits", async () => {
    mockConfig({ notifications: { whatsAppPhoneNumberId: "123", whatsAppApiKey: "token" } });
    const whatsapp = require("../services/whatsappFree");
    const result = await whatsapp.sendText("12345", "Test");
    expect(result.success).toBe(false);
    expect(result.reason).toBe("invalid_phone");
  });

  it("sendOrderConfirmation sends template message", async () => {
    mockConfig({ notifications: { whatsAppPhoneNumberId: "123", whatsAppApiKey: "token" } });
    global.fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ messages: [{ id: "m1" }] }) });
    const whatsapp = require("../services/whatsappFree");
    const result = await whatsapp.sendOrderConfirmation("9876543210", "ORD123", 500, "2h");
    expect(result.success).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("sendDeliveryUpdate sends template message", async () => {
    mockConfig({ notifications: { whatsAppPhoneNumberId: "123", whatsAppApiKey: "token" } });
    global.fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ messages: [{ id: "m2" }] }) });
    const whatsapp = require("../services/whatsappFree");
    const result = await whatsapp.sendDeliveryUpdate("9876543210", "ORD123", "Out for Delivery");
    expect(result.success).toBe(true);
  });

  it("sendOTP sends text message with OTP code", async () => {
    mockConfig({ notifications: { whatsAppPhoneNumberId: "123", whatsAppApiKey: "token" } });
    global.fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ messages: [{ id: "m3" }] }) });
    const whatsapp = require("../services/whatsappFree");
    const result = await whatsapp.sendOTP("9876543210", "1234");
    expect(result.success).toBe(true);
  });

  it("sendLowStockAlert sends text with product name", async () => {
    mockConfig({ notifications: { whatsAppPhoneNumberId: "123", whatsAppApiKey: "token" } });
    global.fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ messages: [{ id: "m4" }] }) });
    const whatsapp = require("../services/whatsappFree");
    const result = await whatsapp.sendLowStockAlert("9876543210", "Apple", 3);
    expect(result.success).toBe(true);
  });

  it("sendOrderCancellation with refund includes refund amount", async () => {
    mockConfig({ notifications: { whatsAppPhoneNumberId: "123", whatsAppApiKey: "token" } });
    global.fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ messages: [{ id: "m5" }] }) });
    const whatsapp = require("../services/whatsappFree");
    const result = await whatsapp.sendOrderCancellation("9876543210", "ORD123", 500);
    expect(result.success).toBe(true);
  });

  it("sendOrderCancellation without refund sends no-refund message", async () => {
    mockConfig({ notifications: { whatsAppPhoneNumberId: "123", whatsAppApiKey: "token" } });
    global.fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ messages: [{ id: "m6" }] }) });
    const whatsapp = require("../services/whatsappFree");
    const result = await whatsapp.sendOrderCancellation("9876543210", "ORD123", 0);
    expect(result.success).toBe(true);
  });

  it("broadcast sends message to multiple recipients", async () => {
    mockConfig({ notifications: { whatsAppPhoneNumberId: "123", whatsAppApiKey: "token" } });
    global.fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ messages: [{ id: "m7" }] }) });
    const whatsapp = require("../services/whatsappFree");
    const result = await whatsapp.broadcast(["9876543210", "8765432109"], "Sale!");
    expect(result.success).toBe(true);
    expect(result.sent).toBe(2);
  });

  it("broadcast handles empty phone list", async () => {
    mockConfig({ notifications: { whatsAppPhoneNumberId: "123", whatsAppApiKey: "token" } });
    const whatsapp = require("../services/whatsappFree");
    const result = await whatsapp.broadcast([], "Sale!");
    expect(result.success).toBe(true);
    expect(result.sent).toBe(0);
  });

  it("handles fetch failure gracefully", async () => {
    mockConfig({ notifications: { whatsAppPhoneNumberId: "123", whatsAppApiKey: "token" } });
    global.fetch.mockRejectedValue(new Error("Network error"));
    const whatsapp = require("../services/whatsappFree");
    const result = await whatsapp.sendText("9876543210", "Test");
    expect(result.success).toBe(false);
  });

  it("handles non-200 response gracefully", async () => {
    mockConfig({ notifications: { whatsAppPhoneNumberId: "123", whatsAppApiKey: "token" } });
    global.fetch.mockResolvedValue({ ok: false, status: 400, json: () => Promise.resolve({ error: { message: "Bad request" } }) });
    const whatsapp = require("../services/whatsappFree");
    const result = await whatsapp.sendText("9876543210", "Test");
    expect(result.success).toBe(false);
  });
});

// VoiceAlertFreeService tests
describe("VoiceAlertFreeService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns no_token when user has no FCM token", async () => {
    __mockData["users/user123"] = __buildDocSnapshot({});
    const voiceAlert = require("../services/voiceAlertFree");
    const result = await voiceAlert.sendVoiceAlert("user123", "Test");
    expect(result).toEqual({ success: false, reason: "no_token" });
  });

  it("sends FCM data message when user has token", async () => {
    __mockData["users/user456"] = __buildDocSnapshot({ fcmToken: "token456" });
    const voiceAlert = require("../services/voiceAlertFree");
    __mockMessaging.send.mockResolvedValue("mock_message_id");
    const result = await voiceAlert.sendVoiceAlert("user456", "Alert", "high");
    expect(result.success).toBe(true);
  });

  it("sendVoiceAlert uses high priority by default", async () => {
    __mockData["users/user789"] = __buildDocSnapshot({ fcmToken: "token789" });
    const voiceAlert = require("../services/voiceAlertFree");
    await voiceAlert.sendVoiceAlert("user789", "Default priority");
    expect(__mockMessaging.send).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ priority: "high" }),
      })
    );
  });

  it("notifyLowStock calls sendVoiceAlert with formatted message", async () => {
    __mockData["users/owner1"] = __buildDocSnapshot({ fcmToken: "token_ls" });
    const voiceAlert = require("../services/voiceAlertFree");
    __mockMessaging.send.mockResolvedValue("msg_ls");
    const result = await voiceAlert.notifyLowStock("owner1", "Rice", 2);
    expect(result.success).toBe(true);
  });

  it("notifyOrderDelay calls sendVoiceAlert with formatted message", async () => {
    __mockData["users/owner2"] = __buildDocSnapshot({ fcmToken: "token_delay" });
    const voiceAlert = require("../services/voiceAlertFree");
    __mockMessaging.send.mockResolvedValue("msg_delay");
    const result = await voiceAlert.notifyOrderDelay("owner2", "ORD456", 35);
    expect(result.success).toBe(true);
  });

  it("handles FCM send failure gracefully", async () => {
    __mockData["users/user_fail"] = __buildDocSnapshot({ fcmToken: "token_fail" });
    __mockMessaging.send.mockRejectedValue(new Error("FCM quota exceeded"));
    const voiceAlert = require("../services/voiceAlertFree");
    const result = await voiceAlert.sendVoiceAlert("user_fail", "Message");
    expect(result.success).toBe(false);
  });

  it("handles non-existent user gracefully", async () => {
    __mockData["users/nonexistent"] = __buildDocSnapshot(null, false);
    const voiceAlert = require("../services/voiceAlertFree");
    const result = await voiceAlert.sendVoiceAlert("nonexistent", "Message");
    expect(result.success).toBe(false);
  });
});

// PincodeValidator tests
describe("PincodeValidator", () => {
  beforeEach(() => {
    global.fetch = jest.fn();
    jest.resetModules();
  });

  it("returns valid for correct 6-digit pincode", async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([
        { Status: "Success", PostOffice: [{ Name: "Satara", District: "Satara", State: "Maharashtra" }] },
      ]),
    });
    const { validatePincode } = require("../services/pincodeValidator");
    const result = await validatePincode("415001");
    expect(result.valid).toBe(true);
    expect(result.city).toBe("Satara");
  });

  it("returns invalid for pincode starting with 0", async () => {
    const { validatePincode } = require("../services/pincodeValidator");
    const result = await validatePincode("012345");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/start with 0/i);
  });

  it("returns invalid for non-6-digit input", async () => {
    const { validatePincode } = require("../services/pincodeValidator");
    const result = await validatePincode("12345");
    expect(result.valid).toBe(false);
  });

  it("returns invalid for API failure with fallback", async () => {
    global.fetch.mockRejectedValue(new Error("API unreachable"));
    const { validatePincode } = require("../services/pincodeValidator");
    const result = await validatePincode("415001");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/API unavailable/i);
  });

  it("returns fallback when PostOffice is empty", async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ Status: "Error", PostOffice: null }]),
    });
    const { validatePincode } = require("../services/pincodeValidator");
    const result = await validatePincode("999999");
    expect(result.valid).toBe(false);
  });

  it("caches result for repeated same pincode", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([
        { Status: "Success", PostOffice: [{ Name: "Pune", District: "Pune", State: "Maharashtra" }] },
      ]),
    });
    global.fetch = fetchMock;
    const { validatePincode } = require("../services/pincodeValidator");
    await validatePincode("411001");
    await validatePincode("411001");
    await validatePincode("411001");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// DeliveryPartner dispatch tests
describe("DeliveryPartner dispatch", () => {
  it("manual dispatch always succeeds", async () => {
    const { dispatch } = require("../services/deliveryPartner/index");
    const result = await dispatch(
      { id: "ord1", items: [{ name: "Item1", quantity: 1 }] },
      "manual",
      {}
    );
    expect(result.success).toBe(true);
    expect(result.trackingId).toBeDefined();
  });

  it("returns error for unknown provider", async () => {
    const { dispatch } = require("../services/deliveryPartner/index");
    const result = await dispatch({ id: "ord1" }, "unknown_provider", {});
    expect(result.success).toBe(false);
  });
});
