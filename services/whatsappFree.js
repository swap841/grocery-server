const axios = require('axios');
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

  async sendMessage(to, templateName, components = []) {
    this._refreshConfig();
    if (!this.phoneNumberId || !this.accessToken) {
      console.log('[WhatsAppFree] Not configured — skipping message to:', to);
      return { success: false, reason: 'not_configured' };
    }

    try {
      const response = await axios.post(
        `https://graph.facebook.com/${this.version}/${this.phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          to: to.replace(/[^0-9]/g, ''),
          type: 'template',
          template: { name: templateName, language: { code: 'en' }, components }
        },
        {
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );
      console.log(`[WhatsAppFree] Sent template ${templateName} to ${to}, id: ${response.data.messages?.[0]?.id}`);
      return { success: true, messageId: response.data.messages?.[0]?.id };
    } catch (error) {
      console.error('[WhatsAppFree] Error:', error.response?.data || error.message);
      return { success: false, error: error.message };
    }
  }

  async sendText(to, text) {
    this._refreshConfig();
    if (!this.phoneNumberId || !this.accessToken) {
      return { success: false, reason: 'not_configured' };
    }
    try {
      const response = await axios.post(
        `https://graph.facebook.com/${this.version}/${this.phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          to: to.replace(/[^0-9]/g, ''),
          type: 'text',
          text: { body: text }
        },
        {
          headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/json' },
          timeout: 10000
        }
      );
      return { success: true, messageId: response.data.messages?.[0]?.id };
    } catch (error) {
      console.error('[WhatsAppFree] sendText error:', error.response?.data || error.message);
      return { success: false, error: error.message };
    }
  }

  async sendOrderConfirmation(to, orderId, total, deliveryTime) {
    return this.sendMessage(to, 'order_confirmation', [
      { type: 'body', parameters: [
        { type: 'text', text: orderId },
        { type: 'text', text: `\u20B9${total}` },
        { type: 'text', text: deliveryTime }
      ]}
    ]);
  }

  async sendDeliveryUpdate(to, orderId, status) {
    return this.sendMessage(to, 'delivery_update', [
      { type: 'body', parameters: [
        { type: 'text', text: orderId },
        { type: 'text', text: status }
      ]}
    ]);
  }

  async sendOTP(to, otpCode) {
    return this.sendText(to, `Your verification code is: ${otpCode}. Valid for 10 minutes.`);
  }

  async sendLowStockAlert(to, productName, stock) {
    return this.sendText(to, `⚠️ Low Stock Alert: ${productName} has only ${stock} units left. Please restock soon.`);
  }

  async sendOrderCancellation(to, orderId, refundAmount) {
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
