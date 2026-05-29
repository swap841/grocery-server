# Grocery Ecosystem Server

Standalone Node.js server replacing Firebase Cloud Functions. Handles FCM push notifications, OTP generation, and HTTP API endpoints.

## Setup

### 1. Get Service Account Key

1. Go to [Firebase Console](https://console.firebase.google.com) → Project Settings → Service Accounts
2. Click **Generate New Private Key**
3. Save the downloaded JSON as `serviceAccountKey.json` in this folder

### 2. Environment

```bash
cp .env.example .env
# Edit PORT if needed (default: 3000)
```

### 3. Install & Run

```bash
npm install
npm start        # or: node index.js
npm run dev      # watch mode (Node >=18)
```

## Deploy to Cyclic

1. Push this folder to a GitHub repo
2. Go to [cyclic.sh](https://cyclic.sh) → Login with GitHub → Link repo
3. Build command: `cd server && npm install`
4. Start command: `cd server && node index.js`
5. Add `serviceAccountKey.json` content as Cyclic secret `SERVICE_ACCOUNT` (or commit it — keep private repo)

## Deploy to Render

1. Create a new Web Service on [render.com](https://render.com)
2. Root directory: `server`
3. Build command: `npm install`
4. Start command: `node index.js`
5. Add `serviceAccountKey.json` content as secret file

## Prevent Sleeping (Free Tiers)

Use [UptimeRobot](https://uptimerobot.com) (free) to ping `/health` every 5 minutes:
```
https://server-qtp4.onrender.com/health
```

## API Endpoints

| Endpoint | Method | Body | Description |
|----------|--------|------|-------------|
| `/health` | GET | — | Health check |
| `/verifyDeliveryCode` | POST | `{ orderId, code }` | Verify delivery OTP |
| `/dispatchToThirdParty` | POST | `{ orderId, partner }` | Dispatch to Shiprocket/Delhivery/Shadowfax |
| `/thirdPartyWebhook` | POST | `{ trackingId, status, orderId }` | Partner status update |
| `/paySalary` | POST | `{ collection, personId, amount, monthYear, mode }` | Record salary payment |
| `/sendSMSOTP` | POST | `{ phoneNumber, otp, orderId }` | Optional SMS fallback |

## Firestore Listeners (Automatic)

The server listens for these changes and sends FCM notifications:

| Collection | Change | Notification |
|-----------|--------|-------------|
| `orders` (new, status=Pending) | Added | New order → all active workers |
| `orders` (status change) | Modified | Status update → customer |
| `orders` (status=Awaiting Verification) | Modified | Generate OTP → customer |
| `products` (stock < threshold) | Modified | Low stock → owner |
| `deliveryBoys/{id}/basket` (new) | Added | New basket → assigned delivery boy |

## Required: Add `ownerFcmToken` to contactInfo

Add this field to Firestore so low-stock alerts reach you:

```bash
# In Firebase Console → Firestore → contactInfo/info
# Add field: ownerFcmToken = "your-device-fcm-token"
```

## App Configuration

After deploying, set the server URL in each app:

- **Web apps**: `NEXT_PUBLIC_SERVER_URL=https://server-qtp4.onrender.com`
- **Android apps**: `BuildConfig.SERVER_URL` already set to `https://server-qtp4.onrender.com`
