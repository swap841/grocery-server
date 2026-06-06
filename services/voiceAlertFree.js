class VoiceAlertFreeService {
  constructor() {
    this.admin = require('firebase-admin');
  }

  async sendVoiceAlert(userId, message, priority = 'high') {
    try {
      const userDoc = await this.admin.firestore().collection('users').doc(userId).get();
      const fcmToken = userDoc.data()?.fcmToken;

      if (!fcmToken) {
        console.log('[VoiceAlertFree] No FCM token for user:', userId);
        return { success: false, reason: 'no_token' };
      }

      const payload = {
        token: fcmToken,
        notification: {
          title: 'Critical Alert',
          body: message,
          sound: 'default'
        },
        data: {
          type: 'voice_alert',
          message: message,
          tts: 'true',
          priority: priority
        },
        android: {
          priority: 'high',
          notification: { sound: 'default', priority: 'high' }
        }
      };

      const response = await this.admin.messaging().send(payload);
      console.log(`[VoiceAlertFree] Sent to ${userId}, messageId: ${response}`);
      return { success: true, messageId: response };
    } catch (error) {
      console.error('[VoiceAlertFree] Error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async notifyLowStock(ownerId, productName, currentStock) {
    const message = `Low Stock Alert! ${productName} has only ${currentStock} units remaining. Please restock soon.`;
    return this.sendVoiceAlert(ownerId, message, 'high');
  }

  async notifyOrderDelay(ownerId, orderId, delayMinutes) {
    const message = `Order ${orderId} is delayed by ${delayMinutes} minutes. Please check delivery status.`;
    return this.sendVoiceAlert(ownerId, message, 'medium');
  }
}

module.exports = new VoiceAlertFreeService();
