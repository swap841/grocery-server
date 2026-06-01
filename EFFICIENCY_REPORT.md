# Ecosystem Efficiency & Capacity Report

## Infrastructure

| Component | Hosting | Tier | Specs |
|-----------|---------|------|-------|
| **Server** | Render | Free | 512 MB RAM, 0.1 CPU, sleep after 15 min inactivity |
| **Firebase/Firestore** | GCP | Spark (Free) → Blaze (Pay-as-you-go) | Spark: 1 GiB stored, 10 GiB/month download, 50K reads/day, 20K writes/day, 20K deletes/day |
| **Firebase Auth** | GCP | Spark (Free) | Unlimited auth (email/password, Google, Phone) |
| **Firebase FCM** | GCP | Free | Unlimited push notifications |
| **Web Apps** | Vercel | Hobby (Free) | 100 GB bandwidth, 6000 build minutes/month, 1 concurrent deployment |
| **Android Apps** | User devices | N/A | N/A |

---

## Daily Capacity Estimates (Spark Free Tier)

### Firestore Spark Free Limits
| Resource | Daily Limit | Used Per Operation | Max Daily Operations |
|----------|-------------|-------------------|-------------------|
| **Reads** | 50,000 | See below | ~2,000-5,000 orders/day |
| **Writes** | 20,000 | See below | ~1,000-2,000 orders/day |
| **Deletes** | 20,000 | 1 per document | N/A |
| **Stored Data** | 1 GiB | ~1 KB per order | ~500,000 orders |
| **Downloads** | 10 GiB/month | ~5 KB per page load | ~2,000,000 page loads/month |

### Per-Transaction Firestore Costs

**Single Order Lifecycle (customer places → delivered):**

| Step | Action | Reads | Writes | Notes |
|------|--------|-------|--------|-------|
| 1. Browse products | Customer | ~3 | 0 | Categories + banners + products |
| 2. Add to cart | Customer | 1 | 1 | Room DB (local, no Firestore cost) |
| 3. Place order | Customer | 3 | 3 | Validate coupon, create order, clear cart |
| 4. → Notification | Server listener | 1 | 0 | Reads workers for FCM tokens |
| 5. Worker claims | Worker | 2 | 2 | Transaction read+write |
| 6. Worker packs | Worker | 1 | 1 | Update order status |
| 7. → Status update | Server listener | 1 | 0 | Notify customer |
| 8. Assign basket | Owner | 2 | 2 | Create basket, assign delivery boy |
| 9. → Basket notify | Server listener | 1 | 0 | Notify delivery boy |
| 10. Deliver OTP | Server listener | 1 | 1 | Generate + store OTP |
| 11. Verify OTP | Server | 1 | 1 | Verify + update delivered |
| **Total per order** | | **17** | **11** | |

**User Session (browse only, no purchase):**

| Step | Action | Reads | Writes |
|------|--------|-------|--------|
| Load homepage | User | 3 | 0 |
| Browse products | User | 1 | 0 |
| View product | User | 1 | 0 |
| **Total per session** | | **~5** | **0** |

### Max Users Per Day (Spark Free Tier)

**Scenario A: Heavy usage (every user places 1 order)**
- Reads: 50,000 / 17 = ~2,941 users/day
- Writes: 20,000 / 11 = ~1,818 users/day
- **Practical limit: ~1,800 users placing orders/day**

**Scenario B: Mostly browsing (10:1 browse-to-order ratio)**
- 10 browse sessions × 5 reads = 50 reads + 1 order × 17 reads = 67 reads total
- 1 order × 11 writes = 11 writes
- Read limit: 50,000 / 67 = ~746 users/day
- Write limit: 20,000 / 11 = ~1,818 users/day
- **Practical limit: ~750 users/day** (read-bound)

**Scenario C: Light usage (50:1 browse-to-order)**
- 50 browse × 5 = 250 reads + 1 order × 17 = 267 reads
- Read limit: 50,000 / 267 = ~187 users/day
- Write limit: 20,000 / 11 = ~1,818 users/day
- **Practical limit: ~187 users/day** (read-bound)

**Realistic estimate for a small business: 50-150 daily active users** with Spark free tier, assuming ~10-20 orders/day.

For the 5-6 employee + customers model: **You will stay well within Spark Free limits** with 20-50 daily customer orders.

---

## Server Capacity (Render Free Tier)

| Metric | Capacity | Notes |
|--------|----------|-------|
| **Concurrent requests** | ~10-15 | Node.js single-threaded, event loop |
| **Firestore listeners** | 8 active | No limit but each uses memory |
| **FCM sends/minute** | ~100 | Firebase limit, not server |
| **Memory** | 512 MB | Server uses ~80-120 MB idle, ~200 MB under load |
| **CPU** | 0.1 vCPU | Fine for < 50 concurrent users |
| **Sleep after inactivity** | 15 min | Free tier spins down — first request after idle takes ~30s cold start |
| **Uptime** | ~99% | But sleep on free tier means periodic 30s delays |

### Mitigating Cold Starts
- **UptimeRobot** (free): Pings `/health` every 5 min — keeps server awake
- Alternative: Render's $7/mo plan eliminates cold starts

---

## Scaling Path

| Stage | Daily Orders | Firebase Tier | Render Plan | Monthly Cost |
|-------|-------------|---------------|-------------|-------------|
| **Launch** | 0-50 | Spark (Free) | Free | $0 |
| **Growth** | 50-300 | Blaze (~$5-25) | $7 Starter | ~$12-32 |
| **Scale** | 300-2000 | Blaze (~$25-100) | $19 Pro | ~$44-119 |
| **Enterprise** | 2000+ | Blaze ($100+) | Custom | $200+ |

**Blaze pricing:** ~$0.06/100K reads, ~$0.18/100K writes, ~$0.02/100K deletes.  
Realistic monthly Firestore cost for 1,000 orders/day: **~$15-25**.

---

## How Long Can Free Tier Run?

| Scenario | Limiting Factor | Duration | Notes |
|----------|----------------|----------|-------|
| **50 daily orders, 100 users browsing** | Spark reads | **Unlimited** | ~3,500 reads/day, well under 50K |
| **200 daily orders, 500 users** | Spark reads | ~100 days | ~50K reads/day hits limit |
| **Server uptime** | Render sleep | Unlimited | Cold starts but no hard limit |
| **Vercel bandwidth** | 100 GB/month | Unlimited | Web apps are tiny (< 10 MB) |

**Bottom line:** With expected usage (5-6 employees + customers), Spark + Render free tier will run **indefinitely** without hitting limits.

---

## Server Response Times

| Endpoint | Avg Response | P99 | Notes |
|----------|-------------|-----|-------|
| `/health` | ~200ms | ~500ms | First call cold start: ~30s |
| `/metrics` | ~50ms | ~200ms | In-memory data |
| `/verifyDeliveryCode` | ~500ms | ~2s | Firestore read + write |
| `/dispatchToThirdParty` | ~400ms | ~1.5s | Firestore writes |
| `/paySalary` | ~400ms | ~1.5s | Firestore writes |
| `/sendSMSOTP` | ~50ms | ~200ms | Stub — no external call |

---

## Data Storage Projections

| Collection | Doc Size | Monthly Growth (50 orders/day) | Yearly Total |
|-----------|----------|-------------------------------|-------------|
| `products` | ~2 KB | 0 (static) | ~100 docs |
| `users/{uid}/orders` | ~3 KB | ~1,500 docs | ~18,250 docs |
| `workers` | ~1 KB | 0 (static) | ~10 docs |
| `deliveryBoys` | ~1 KB | 0 (static) | ~10 docs |
| `contacts` | ~2 KB | ~150 docs | ~1,825 docs |
| `errorLogs` | ~0.5 KB | ~30 docs | ~365 docs |
| **Total storage** | | **~5 MB/month** | **~60 MB/year** |

Well within Spark's 1 GiB limit.

---

## Recommendations

1. **Set up UptimeRobot** (free) to ping `/health` every 5 min — prevents Render cold starts
2. **Monitor Firestore usage** via Firebase Console daily for first month
3. **Set billing alert** at $10 if/when switching to Blaze
4. **Don't upgrade from Spark until** you exceed 30,000 reads/day consistently
5. **Keep server `errorLogs` collection** for debugging — delete old logs monthly
