require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const admin = require('firebase-admin');

if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
  const serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8')
  );
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
} else {
  try {
    const serviceAccount = require('../serviceAccountKey.json');
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  } catch (err) {
    console.error('Failed to initialize Firebase Admin. Provide FIREBASE_SERVICE_ACCOUNT_BASE64 or serviceAccountKey.json');
    process.exit(1);
  }
}

const db = admin.firestore();

const config = {
  branding: {
    storeName: 'My Store Grocery',
    logoUrl: 'https://via.placeholder.com/200x60?text=My+Store',
    faviconUrl: 'https://via.placeholder.com/32x32',
    primaryColor: '#059669',
    secondaryColor: '#0d9488',
    accentColor: '#f59e0b',
    fontFamily: 'Inter',
  },
  store: {
    isOpen: true,
    maintenanceMode: false,
    closedMessage: 'We are closed. Opening at 8 AM tomorrow!',
    minOrderValue: 49,
    deliveryCharge: 29,
    freeDeliveryAbove: 299,
    taxPercentage: 5,
    deliveryRadiusKm: 10,
  },
  features: {
    wishlist: true,
    coupons: true,
    chatbot: true,
    reviews: true,
    voiceSearch: true,
    loyaltyPoints: false,
  },
  seo: {
    metaTitle: 'Fresh Groceries Delivered Fast',
    metaDescription: 'Order fresh vegetables, fruits, and daily essentials online for same-day delivery.',
    metaKeywords: 'grocery, fresh vegetables, online shopping',
  },
  contact: {
    phone: '+91 9876543210',
    email: 'support@mystore.com',
    address: 'Main Road, Satara, Maharashtra',
    whatsappNumber: '+91 9876543210',
  },
  updatedAt: '2026-06-01T00:00:00Z',
};

async function main() {
  try {
    await db.collection('appConfig').doc('main').set(config, { merge: true });
    console.log('appConfig/main document created successfully!');
    console.log(JSON.stringify(config, null, 2));
    process.exit(0);
  } catch (err) {
    console.error('Failed to create appConfig:', err);
    process.exit(1);
  }
}

main();
