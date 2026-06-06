const axios = require('axios');
const { getConfig } = require('./configLoader');

class WhatsAppFreeService {
  constructor() {
    const config = getConfig();
    this.phoneNumberId = config?.notifications?.whatsAppPhoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;
    this.accessToken = config?.notifications?.whatsAppApiKey || process.env.WHATSAPP_ACCESS_TOKEN;
    this.version = 'v18.0';
  }

  async sendMessage(to, templateName, components = []) {
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

  async sendOrderConfirmation(to, orderId, total, deliveryTime) {
    return this.sendMessage(to, 'order_confirmation', [
      { type: 'body', parameters: [
        { type: 'text', text: orderId },
        { type: 'text', text: `\u20B9${total}` },
        { type: 'text', text: deliveryTime }
      ]}
    ]);
  }

  async sendDeliveryUpdate(to, orderId, status, trackingUrl = '') {
    return this.sendMessage(to, 'delivery_update', [
      { type: 'body', parameters: [
        { type: 'text', text: orderId },
        { type: 'text', text: status }
      ]}
    ]);
  }
}

module.exports = new WhatsAppFreeService();
