# Deployment Guide — Grocery Ecosystem

## Prerequisites
- GitHub repos already created: `swap841/grocery-server`, `swap841/owner-dashboard`, `swap841/customer-website`
- All code already pushed to each repo
- Server already running at `https://server-qtp4.onrender.com`
- Firebase project: `my-store-51b02`

---

## 1. Deploy Owner Dashboard → Vercel

1. Go to https://vercel.com → **Add New** → **Project**
2. Import `swap841/owner-dashboard`
3. Framework: **Next.js** (auto-detected)
4. Environment Variables:

| Key | Value |
|-----|-------|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | `AIzaSyBfAjJ6fuxnFe2qG-kBgIT8gmLKl3W75sI` |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | `my-store-51b02.firebaseapp.com` |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | `my-store-51b02` |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | `my-store-51b02.firebasestorage.app` |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | `240390353694` |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | `1:240390353694:web:19c5edc8e118c77c34fef8` |
| `NEXT_PUBLIC_SERVER_URL` | `https://server-qtp4.onrender.com` |
| `NEXT_PUBLIC_IMG_BB_API_KEY` | `272679250cc11337bf042d02a2ddcfaf` |

5. Click **Deploy**

---

## 2. Deploy Customer Website → Vercel

1. **Add New** → **Project** → Import `swap841/customer-website`
2. Framework: **Next.js**
3. Environment Variables — **same Firebase vars as above, plus**:

| Key | Value |
|-----|-------|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | `AIzaSyBfAjJ6fuxnFe2qG-kBgIT8gmLKl3W75sI` |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | `my-store-51b02.firebaseapp.com` |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | `my-store-51b02` |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | `my-store-51b02.firebasestorage.app` |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | `240390353694` |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | `1:240390353694:web:19c5edc8e118c77c34fef8` |
| `NEXT_PUBLIC_RAZORPAY_KEY_ID` | `rzp_test_xxxx` (replace when live) |
| `NEXT_PUBLIC_GOOGLE_WEB_CLIENT_ID` | `240390353694-pofcc35ialvsmo5g97emicj5r4v8qpfp.apps.googleusercontent.com` |
| `NEXT_PUBLIC_SERVER_URL` | `https://server-qtp4.onrender.com` |
| `NEXT_PUBLIC_IMG_BB_API_KEY` | `272679250cc11337bf042d02a2ddcfaf` |
| `FIREBASE_PRIVATE_KEY` | (from Firebase Admin — paste with `\n` for newlines) |
| `FIREBASE_CLIENT_EMAIL` | `firebase-adminsdk-fbsvc@my-store-51b02.iam.gserviceaccount.com` |
| `FIREBASE_PROJECT_ID` | `my-store-51b02` |

4. Click **Deploy**

---

## 3. Prevent Server Sleep

1. Go to https://uptimerobot.com → Sign up (free)
2. Add monitor: `https://server-qtp4.onrender.com/health` — 5 min interval
3. Server stays awake 24/7

---

## 4. Android APKs

```powershell
cd customer-android
.\gradlew assembleDebug
# → app\build\outputs\apk\debug\app-debug.apk

cd ..\worker-android
.\gradlew assembleDebug

cd ..\delivery-boy-android
.\gradlew assembleDebug
```

---

## 5. Verify

- [ ] `https://owner-dashboard.vercel.app` loads
- [ ] `https://customer-website.vercel.app` loads
- [ ] Google Sign-In works on both web apps
- [ ] COD order flow works end-to-end
