const { getConfig } = require('./configLoader');

class WhatsAppFreeService {
  constructor() {
    this._refreshConfig();
  }

  _refreshConfig() {
    const config = getConfig();
    this.phoneNumberId = config?.notifications?.whatsAppPhoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;
    this.accessToken = config?.notifications?.whatsAppApiKey || process.env.WHATSAPP_ACCESS_TOKEN;
    this.version = 'v18.0';
  }

  async _post(path, body) {
    const url = `https://graph.facebook.com/${this.version}/${this.phoneNumberId}/messages`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    if (!res.ok) return { success: false, error: data.error?.message || `HTTP ${res.status}` };
    return { success: true, messageId: data.messages?.[0]?.id };
  }

  async sendMessage(to, templateName, components = []) {
    this._refreshConfig();
    if (!this.phoneNumberId || !this.accessToken) {
      console.log('[WhatsAppFree] Not configured — skipping message to:', to);
      return { success: false, reason: 'not_configured' };
    }
    try {
      const phone = to.replace(/[^0-9]/g, '');
      if (phone.length < 10) return { success: false, reason: 'invalid_phone' };
      return await this._post('messages', {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'template',
        template: { name: templateName, language: { code: 'en' }, components },
      });
    } catch (error) {
      console.error('[WhatsAppFree] Error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async sendText(to, text) {
    this._refreshConfig();
    if (!this.phoneNumberId || !this.accessToken) return { success: false, reason: 'not_configured' };
    try {
      const phone = to.replace(/[^0-9]/g, '');
      if (phone.length < 10) return { success: false, reason: 'invalid_phone' };
      return await this._post('messages', {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'text',
        text: { body: text },
      });
    } catch (error) {
      console.error('[WhatsAppFree] sendText error:', error.message);
      return { success: false, error: error.message };
    }
  }

  sendOrderConfirmation(to, orderId, total, deliveryTime) {
    return this.sendMessage(to, 'order_confirmation', [
      { type: 'body', parameters: [
        { type: 'text', text: orderId },
        { type: 'text', text: `\u20B9${total}` },
        { type: 'text', text: deliveryTime },
      ]},
    ]);
  }

  sendDeliveryUpdate(to, orderId, status) {
    return this.sendMessage(to, 'delivery_update', [
      { type: 'body', parameters: [
        { type: 'text', text: orderId },
        { type: 'text', text: status },
      ]},
    ]);
  }

  sendOTP(to, otpCode) {
    return this.sendText(to, `Your verification code is: ${otpCode}. Valid for 10 minutes.`);
  }

  sendLowStockAlert(to, productName, stock) {
    return this.sendText(to, `Low Stock Alert: ${productName} has only ${stock} units left. Please restock soon.`);
  }

  sendOrderCancellation(to, orderId, refundAmount) {
    const msg = refundAmount > 0
      ? `Order #${orderId.slice(-8)} has been cancelled. Refund of \u20B9${refundAmount} will be processed within 5-7 business days.`
      : `Order #${orderId.slice(-8)} has been cancelled. No payment was deducted.`;
    return this.sendText(to, msg);
  }

  async broadcast(toList, message) {
    let sent = 0, failed = 0;
    for (const phone of toList) {
      const result = await this.sendText(phone, message);
      if (result.success) sent++; else failed++;
    }
    return { success: true, sent, failed };
  }
}

module.exports = new WhatsAppFreeService();
