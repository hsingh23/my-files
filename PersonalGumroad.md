# Single-HTML Landing Pages + Checkout Integration

**Goal:** Build a Gumroad-like single-creator storefront where product landing pages can be either:

* **Mode A (Hosted HTML):** Creator uploads a single HTML file (optionally with assets). Platform serves it as the landing page.
* **Mode B (External HTML):** Creator hosts their own HTML anywhere and integrates checkout via a tiny SDK + API.

This document defines **full requirements**, **interfaces**, **SDK/button integration instructions**, and an **implementation plan** with rationale.

---

## 1) System context

* Stack constraints: **Node/Express backend**, **MySQL** available, assume **no Redis**, Stripe for payments.
* Product scale: ≤ **500 products**, ≤ **200k users**.
* Traffic: **launch spikes** expected.
* Goods: mostly **digital files** (<100MB) + **software licenses**.
* Must support:

  * Fixed price
  * Pay-what-you-want (with minimum)
  * Multiple versions (Basic/Pro)
  * Discount codes
  * Affiliate links
  * Post-purchase: license key issuance, webhooks, GitHub repo invites, email notifications
  * Online activation checks (revocable on refund)
  * Affiliate payout automation (Stripe Connect recommended)

---

## 2) Product landing page modes

### Mode A — Hosted HTML (platform serves creator HTML)

**User story:** Creator uploads an HTML file as the product landing page; platform serves it at a canonical product URL.

**Requirements:**

* Allow upload of:

  * **Single `index.html`** OR `index.html` + `assets.zip` (optional)
* Provide a publish flow:

  * Upload → validate → preview → publish
* Public URL patterns:

  * Product canonical: `https://YOUR_DOMAIN/p/{productSlug}`
  * Landing page served: either same path or `.../p/{slug}/landing`

**Integration expectation:**

* Platform automatically injects the SDK snippet and product bootstrap data into the hosted HTML **OR** requires the author to include it.
* Prefer **auto-injection** to make “upload-and-go” minimal.

### Mode B — External HTML (creator hosts, integrates checkout)

**User story:** Creator has a custom website (Next.js, static HTML, docs site) and wants “Buy” buttons that use your checkout.

**Requirements:**

* Provide a copy/paste integration snippet:

  * `<script src=".../sdk/storefront.js" defer></script>`
* Provide clear button wiring instructions (data attributes + JS API).
* Support coupon/affiliate via URL params or explicit inputs.

---

## 3) Checkout integration UX: two layers

### Layer 1 (Recommended): declarative buttons via data attributes

Creators add a button with `data-store-*` attributes. SDK binds automatically.

**Example: Fixed price, Basic version**

```html
<button
  data-store-action="checkout"
  data-store-product="my-product"
  data-store-version="basic"
  data-store-pricing="fixed">
  Buy Basic
</button>
```

**Example: Fixed price, Pro version**

```html
<button
  data-store-action="checkout"
  data-store-product="my-product"
  data-store-version="pro"
  data-store-pricing="fixed">
  Buy Pro
</button>
```

**Example: PWYW with minimum**

```html
<input id="amount" type="number" min="5" step="1" placeholder="Enter amount (USD)" />

<button
  data-store-action="checkout"
  data-store-product="my-product"
  data-store-version="pro"
  data-store-pricing="pwyw"
  data-store-pwyw-input="#amount"
  data-store-min-cents="500">
  Pay what you want
</button>
```

**Example: Coupon input**

```html
<input id="coupon" type="text" placeholder="Coupon code" />

<button
  data-store-action="checkout"
  data-store-product="my-product"
  data-store-version="basic"
  data-store-pricing="fixed"
  data-store-coupon-input="#coupon">
  Buy with coupon
</button>
```

**Example: Collect email before checkout**

```html
<input id="email" type="email" placeholder="you@domain.com" />

<button
  data-store-action="checkout"
  data-store-product="my-product"
  data-store-version="basic"
  data-store-pricing="fixed"
  data-store-email-input="#email">
  Continue to checkout
</button>
```

**Affiliate capture (automatic):** SDK reads `?aff=CODE` from URL and stores it, then includes it in checkout creation.

### Layer 2 (Optional): imperative JS API

For advanced creators who want full control.

```html
<script>
  async function buyPro() {
    const checkoutUrl = await window.Storefront.createCheckout({
      product: 'my-product',
      version: 'pro',
      pricing: 'fixed',
      coupon: document.querySelector('#coupon')?.value,
      email: document.querySelector('#email')?.value,
    });
    window.location.href = checkoutUrl;
  }
</script>

<button onclick="buyPro()">Buy Pro</button>
```

---

## 4) SDK contract (storefront.js)

### Responsibilities

* Bind click handlers to any element matching:

  * `[data-store-action="checkout"]`
* Parse attributes & inputs
* Validate required fields client-side (basic)
* Call the public API endpoint to create a Stripe Checkout session
* Redirect to returned `checkoutUrl`
* Capture and persist attribution:

  * `aff` (affiliate)
  * `coupon` (optional default)

### Global configuration

SDK supports bootstrap config from either:

1. injected inline:

```html
<script>
  window.__STOREFRONT__ = {
    apiBase: 'https://api.YOUR_DOMAIN',
    product: 'my-product',
    currency: 'USD'
  };
</script>
```

2. data attributes on script tag:

```html
<script
  src="https://api.YOUR_DOMAIN/sdk/storefront.js"
  data-api-base="https://api.YOUR_DOMAIN"
  data-product="my-product"
  defer></script>
```

SDK precedence:

1. element attributes (button)
2. window.**STOREFRONT** defaults
3. script tag defaults

### Supported `data-store-*` attributes

* `data-store-action`: must be `checkout`
* `data-store-product`: product slug (optional if default exists)
* `data-store-version`: version slug (required)
* `data-store-pricing`: `fixed | pwyw`
* `data-store-pwyw-input`: CSS selector for amount input
* `data-store-min-cents`: integer
* `data-store-coupon-input`: CSS selector
* `data-store-email-input`: CSS selector
* `data-store-success-url`: override
* `data-store-cancel-url`: override

### Input parsing

* If `pricing=pwyw`:

  * read input value as dollars, convert to cents
  * validate `>= min-cents`

### Failure UX

* SDK should surface errors in a creator-friendly way:

  * `alert()` by default
  * optionally allow `data-store-error-target="#id"` for inline errors

---

## 5) Public Checkout API

### Endpoint

`POST /v1/public/checkout/sessions`

### Request

```json
{
  "productSlug": "my-product",
  "versionSlug": "basic",
  "pricing": "fixed",
  "pwywAmountCents": 1200,
  "coupon": "NY2026",
  "affiliate": "AFF123",
  "customerEmail": "you@domain.com",
  "successUrl": "https://...",
  "cancelUrl": "https://..."
}
```

### Response

```json
{
  "checkoutUrl": "https://checkout.stripe.com/c/...",
  "checkoutSessionId": "cs_test_..."
}
```

### Server-side validation (must)

* Product/version exists and active
* Pricing:

  * if `fixed`: ignore `pwywAmountCents`
  * if `pwyw`: require `pwywAmountCents >= min`
* Coupon validation:

  * code exists
  * not expired
  * redemption limits
  * scope (product-wide or version-specific)-specific)
* Affiliate validation:

  * code exists and active
* Rate limiting:

  * per IP + product/version (launch spikes)

### Rationale

* Public endpoint allows Mode B without requiring auth cookies.
* Centralized server-side checks prevent price manipulation.
* Rate limiting protects your limited VM under spikes.

---

## 6) Stripe implementation requirements

### Refund sources

Refunds may be initiated from:

* Creator dashboard (platform UI)
* Stripe Dashboard (manual refunds)

The system must treat **Stripe webhooks as the source of truth** for refund state. Any refund, regardless of origin, is processed via webhook and triggers entitlement/license revocation and affiliate reversal logic.

### Checkout session creation

* Use Stripe Checkout Sessions
* Put authoritative identifiers in metadata:

  * `productSlug`, `versionSlug`, `internalCheckoutId`, `affiliateCode`, `couponCode`, `pricingMode`

### Webhook ingestion

* Verify signature
* Store `stripe_event_id` unique in `stripe_events`
* Enqueue job `process_stripe_event`

### Idempotency

* Enforce unique constraints:

  * `stripe_events(stripe_event_id)`
  * `orders(stripe_payment_intent_id)`

#### Checkout creation idempotency (explicit)

* SDK **must generate a `checkout_attempt_id` (UUID v4)** per button click.
* `checkout_attempt_id` is sent to the API and stored.
* Server enforces uniqueness on `(checkout_attempt_id, product, version)`.

**Rationale:** prevents duplicate Stripe Checkout Sessions caused by double-clicks, retries, or mis-bound event handlers (especially from LLM-generated HTML).

* Enforce unique constraints:

  * `stripe_events(stripe_event_id)`
  * `orders(stripe_payment_intent_id)`

### Event handling (minimum)

* `checkout.session.completed`: create order + entitlements + fulfillments
* `charge.refunded` (or equivalent): revoke entitlements/licenses, reverse affiliate commission

---

## 7) Fulfillment pipeline (jobs)

### Concurrency model (MySQL-safe)

* Jobs are claimed using:

  * `SELECT ... FOR UPDATE SKIP LOCKED`
* Each worker has a unique `worker_id`.
* Jobs have:

  * `locked_at`, `locked_by`, `attempts`, `max_attempts`
* If a job is `running` but `locked_at` exceeds a timeout, it is considered **stale** and can be retried.

**Rationale:** enables safe parallel workers without Redis and avoids double execution under load.

All slow actions are done by worker jobs stored in MySQL.

### Job types

* `send_receipt_email`
* `issue_license`
* `deliver_outbound_webhooks`
* `github_invite`
* `reverse_on_refund`
* `affiliate_compute_commission`
* `affiliate_payout`

### Why jobs?

* Keeps checkout/webhooks fast under spikes
* Enables retries with backoff
* Separates user-facing latency from external dependencies (SMTP, GitHub, webhook targets)

---

## 8) Online license activation & validation

### Stale activation pruning

* Each activation updates `last_seen_at` on validation.
* Periodic job prunes or deactivates activations not seen within a configurable window (e.g., 30–90 days).

**Rationale:** prevents permanent slot exhaustion from abandoned devices and improves UX for legitimate re-installs.

### Requirements

* License generated post-purchase
* Online activation checks are required to support revocation on refund
* Support per-device activation limit

### Tables (concept)

* `licenses(license_key, status, max_activations, ...)`
* `license_activations(license_id, device_id_hash, status, last_seen_at, ...)`

### Endpoints

* `POST /v1/licenses/activate`
* `POST /v1/licenses/validate`

### Refund logic

* On refund, mark license `revoked` and invalidate activations.

### UX recommendation

* Allow a short offline grace window (server-defined) to avoid punishing legitimate outages.

---

## 9) Affiliate tracking + payout automation

### Scope

* **Product-scoped only** (affiliates belong to a product)

### Attribution

* Capture `?aff=CODE` from URL
* Persist in localStorage (Mode B) or server-side attribution (Mode A if you inject)
* Apply last-click attribution within configurable window (e.g., 30 days)

### Commission

* Create a commission record when order is paid
* Use a holding period (e.g., 14 days) before it becomes payable

### Payout automation

* Recommended: Stripe Connect
* Scheduled job runs weekly/monthly:

  * compute available commissions
  * create Stripe transfers/payouts
  * mark commissions paid

---

## 10) Discount codes

### Scope

* **Product-scoped only** (not global across products)

### Requirements

* Single code per checkout
* Constraints:

  * percent/fixed
  * expiry
  * max redemptions
  * scope (global/product/version)

### Rationale

* Single-code design is simpler and reduces edge cases.

---

## 11) Webhooks (outbound)

### Scope

* **Product-scoped only**

### Requirements

* Creator-configurable endpoints
* Signed payloads with shared secret
* Retries with exponential backoff
* Dead-letter after max attempts

### Events

* `order.paid`
* `order.refunded`
* `license.issued`
* `license.revoked`

---

## 12) Hosted HTML: ingestion + serving

### Upload

* Accept `index.html` and optional `assets.zip`
* Store in object storage
* If zip, unpack to a folder prefix

### Serving

* Serve with appropriate caching (short TTL for HTML, long TTL for assets)
* Inject:

  * SDK script include
  * `window.__STOREFRONT__` defaults (product slug, api base)

### Rationale

* Injection makes Mode A “upload-only” and reduces integration errors.

---

## 13) External HTML: creator instructions (UI copy)

Provide a UI section “Integrate checkout” that outputs:

1. **Script include**:

```html
<script>
  window.__STOREFRONT__ = { apiBase: 'https://api.YOUR_DOMAIN', product: 'my-product' };
</script>
<script src="https://api.YOUR_DOMAIN/sdk/storefront.js" defer></script>
```

2. **Button examples** for:

* fixed price
* versions
* pwyw
* coupon input
* email input

3. **Affiliate param** convention:

* `?aff=YOURCODE`

4. **Coupon param** convention:

* `?coupon=CODE` (optional)

---

## 14) Implementation plan (phased)

### Phase 0 — Customer portal (required foundation)

* Magic-link authentication
* `/account` portal:

  * View purchases
  * Download assets
  * View license keys
  * View activation status
  * See refund/revoked status

### Phase 1 — Checkout SDK + public API

* Implement `/v1/public/checkout/sessions`
* Implement `storefront.js` auto-binding + createCheckout API
* Add UI generator that prints snippets customized per product/version

### Phase 2 — Stripe webhooks + orders

* Webhook ingestion with idempotency
* Order creation, entitlements creation

### Phase 3 — Fulfillment jobs

* MySQL job queue
* Email receipt job
* Webhook delivery job

### Phase 4 — Licenses

* Issue license on purchase
* Activate/validate endpoints
* Refund revocation

### Phase 5 — Affiliates + payouts

* Attribution + commission
* Stripe Connect onboarding + automated payouts

### Phase 6 — Hosted HTML

* Upload + storage + serving
* HTML injection of SDK + config

---

## 15) Acceptance criteria

### Mode A

* Upload HTML → public landing works
* Buttons trigger Stripe checkout correctly

### Mode B

* Any external site with script include can create checkout and redirect

### Commerce

* Fixed + PWYW + versions + coupon works
* Stripe webhook reliably creates orders under retries

### Licenses

* Key issued post-purchase
* Online activation enforces limits
* Refund revokes license and future validations fail

### Affiliate

* Affiliate links attribute correctly
* Commissions computed
* Automated payouts run on schedule

---

## 16) Open decisions (capture in UI/settings)

* Default currency per product
* PWYW min per version
* Offline grace period for license validation
* Affiliate window (days) + commission percent
* Commission holding period (days) before payable
* Webhook retry policy (max attempts, backoff)

---

## 17) Pricing lifecycle & product state

### Pre-orders

* Versions may be marked `preorder`.
* Checkout allowed before fulfillment date.
* Fulfillment jobs are delayed until release.

### Scheduled price changes

* Versions support `price_effective_at`.
* Checkout uses price active at session creation time.

### Launch pricing → regular pricing

* Implemented as scheduled price changes.
* Past orders retain original price in records.

### Retired versions

* Versions may be marked `retired`.
* New purchases blocked.
* Existing buyers retain download and license access.

---

## 18) Analytics dashboard (creator)

### Requirements

* Read-only analytics UI per product:

  * Orders over time
  * Revenue by version
  * Conversion rate (sessions → orders)
  * Refund rate
  * Affiliate performance

### MVP scope

* Table views + CSV export only (no charts required).

---

## 19) Failure observability & replay

### Job observability

* Admin UI lists:

  * failed jobs
  * last error
  * payload
* Manual retry per job.

### Stripe event replay

* Stored Stripe events can be reprocessed idempotently.

**Rationale:** eliminates manual DB edits and enables safe recovery from transient failures.

---

## 20) SDK versioning & backwards compatibility

### Versioning

* SDK URLs are versioned:

  * `/sdk/storefront.v1.js`

### Policy

* v1 remains stable indefinitely.
* New features ship in v2+.

**Rationale:** landing pages are often pasted once and never updated.

---

## 21) Abuse & fraud mitigation (beyond rate limiting)

### PWYW abuse

* Enforce minimum server-side.
* Optional per-product minimum hard floor.

### Checkout spam

* Soft CAPTCHA or proof-of-work after N attempts/IP.
* Email confirmation required for downloads.

### Affiliate fraud

* Block self-referrals (same email/domain).
* Cap commission per order.
* Detect excessive clicks from identical IP/UA hashes.

---

## 22) Data retention & deletion

### Customer deletion

* On user deletion request:

  * Anonymize PII (email)
  * Retain order/license records for accounting

### License data

* License keys retained while order exists.
* Activations pruned via `last_seen_at`.

### Affiliate data

* Click logs may be truncated or aggregated after retention window.

**Rationale:** balances compliance with operational and accounting needs.

---

## 23) Exact MySQL DDL (tables + indexes)

> Notes
>
> * Engine: InnoDB, charset: utf8mb4.
> * The platform is “single-creator” today, but schema supports a `creators` row for cleanliness.
> * "Deletion" is implemented as **PII anonymization**, not hard deletes.

```sql
-- =========================
-- Core: creators, products, versions, pricing
-- =========================
CREATE TABLE creators (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(255) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE products (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  creator_id BIGINT UNSIGNED NOT NULL,
  slug VARCHAR(128) NOT NULL,
  title VARCHAR(255) NOT NULL,
  description MEDIUMTEXT NULL,
  status ENUM('draft','active','archived') NOT NULL DEFAULT 'draft',
  default_currency CHAR(3) NOT NULL DEFAULT 'USD',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_products_creator_slug (creator_id, slug),
  KEY idx_products_creator (creator_id),
  CONSTRAINT fk_products_creator FOREIGN KEY (creator_id) REFERENCES creators(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE product_versions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id BIGINT UNSIGNED NOT NULL,
  slug VARCHAR(128) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description MEDIUMTEXT NULL,

  -- Base pricing (used if no schedule row applies)
  pricing_mode ENUM('fixed','pwyw') NOT NULL DEFAULT 'fixed',
  price_cents INT UNSIGNED NOT NULL DEFAULT 0,
  pwyw_min_cents INT UNSIGNED NULL,

  -- Lifecycle
  status ENUM('draft','active','preorder','retired') NOT NULL DEFAULT 'draft',
  preorder_release_at DATETIME NULL,

  -- License policy
  license_enabled TINYINT(1) NOT NULL DEFAULT 1,
  max_activations INT UNSIGNED NOT NULL DEFAULT 3,

  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_versions_product_slug (product_id, slug),
  KEY idx_versions_product (product_id),
  KEY idx_versions_status (status),
  CONSTRAINT fk_versions_product FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Scheduled price changes / launch pricing
CREATE TABLE version_price_schedule (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_version_id BIGINT UNSIGNED NOT NULL,
  effective_at DATETIME NOT NULL,
  pricing_mode ENUM('fixed','pwyw') NOT NULL DEFAULT 'fixed',
  price_cents INT UNSIGNED NOT NULL DEFAULT 0,
  pwyw_min_cents INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_vps_version_effective (product_version_id, effective_at DESC),
  CONSTRAINT fk_vps_version FOREIGN KEY (product_version_id) REFERENCES product_versions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Digital assets per version
CREATE TABLE product_assets (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_version_id BIGINT UNSIGNED NOT NULL,
  storage_key VARCHAR(1024) NOT NULL,
  filename VARCHAR(512) NOT NULL,
  content_type VARCHAR(255) NULL,
  size_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_assets_version (product_version_id),
  CONSTRAINT fk_assets_version FOREIGN KEY (product_version_id) REFERENCES product_versions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Hosted HTML artifacts (Mode A)
CREATE TABLE product_landing_pages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id BIGINT UNSIGNED NOT NULL,
  status ENUM('draft','published') NOT NULL DEFAULT 'draft',
  html_storage_key VARCHAR(1024) NOT NULL,
  assets_prefix VARCHAR(1024) NULL,
  published_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_landing_product (product_id),
  CONSTRAINT fk_landing_product FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =========================
-- Customers: users, auth, sessions
-- =========================
CREATE TABLE users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email VARCHAR(320) NOT NULL,
  email_normalized VARCHAR(320) NOT NULL,
  email_verified_at DATETIME NULL,
  status ENUM('active','disabled','anonymized') NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email_norm (email_normalized),
  KEY idx_users_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Magic link tokens
CREATE TABLE auth_tokens (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  purpose ENUM('magic_login') NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_auth_token_hash (token_hash),
  KEY idx_auth_user (user_id),
  KEY idx_auth_exp (expires_at),
  CONSTRAINT fk_auth_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Sessions (if you prefer server sessions over JWT)
CREATE TABLE sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  session_token_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_session_token_hash (session_token_hash),
  KEY idx_sessions_user (user_id),
  KEY idx_sessions_exp (expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =========================
-- Checkout tracking + orders
-- =========================
CREATE TABLE checkout_attempts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  checkout_attempt_id CHAR(36) NOT NULL, -- UUID v4
  product_id BIGINT UNSIGNED NOT NULL,
  product_version_id BIGINT UNSIGNED NOT NULL,
  customer_email VARCHAR(320) NULL,
  coupon_code VARCHAR(64) NULL,
  affiliate_code VARCHAR(64) NULL,
  pricing ENUM('fixed','pwyw') NOT NULL,
  pwyw_amount_cents INT UNSIGNED NULL,
  status ENUM('created','redirected','completed','expired','failed') NOT NULL DEFAULT 'created',
  stripe_checkout_session_id VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_checkout_attempt (checkout_attempt_id, product_id, product_version_id),
  UNIQUE KEY uq_checkout_stripe_session (stripe_checkout_session_id),
  KEY idx_checkout_product (product_id, created_at),
  CONSTRAINT fk_checkout_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT fk_checkout_version FOREIGN KEY (product_version_id) REFERENCES product_versions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE orders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  checkout_attempt_id CHAR(36) NULL,

  stripe_checkout_session_id VARCHAR(255) NOT NULL,
  stripe_payment_intent_id VARCHAR(255) NOT NULL,
  stripe_charge_id VARCHAR(255) NULL,

  currency CHAR(3) NOT NULL,
  subtotal_cents INT UNSIGNED NOT NULL DEFAULT 0,
  discount_cents INT UNSIGNED NOT NULL DEFAULT 0,
  total_cents INT UNSIGNED NOT NULL DEFAULT 0,

  status ENUM('pending','paid','refunded','partially_refunded','disputed','canceled') NOT NULL DEFAULT 'pending',
  paid_at DATETIME NULL,
  refunded_at DATETIME NULL,

  coupon_code VARCHAR(64) NULL,
  affiliate_code VARCHAR(64) NULL,

  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_orders_pi (stripe_payment_intent_id),
  UNIQUE KEY uq_orders_cs (stripe_checkout_session_id),
  KEY idx_orders_product (product_id, created_at),
  KEY idx_orders_user (user_id, created_at),
  KEY idx_orders_status (status),
  CONSTRAINT fk_orders_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE order_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id BIGINT UNSIGNED NOT NULL,
  product_version_id BIGINT UNSIGNED NOT NULL,
  unit_price_cents INT UNSIGNED NOT NULL,
  quantity INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_items_order (order_id),
  KEY idx_items_version (product_version_id),
  CONSTRAINT fk_items_order FOREIGN KEY (order_id) REFERENCES orders(id),
  CONSTRAINT fk_items_version FOREIGN KEY (product_version_id) REFERENCES product_versions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Entitlements drive downloads + license validity
CREATE TABLE entitlements (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  order_id BIGINT UNSIGNED NOT NULL,
  product_version_id BIGINT UNSIGNED NOT NULL,
  status ENUM('active','revoked') NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_entitlement (user_id, order_id, product_version_id),
  KEY idx_ent_user (user_id, status),
  KEY idx_ent_version (product_version_id),
  CONSTRAINT fk_ent_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_ent_order FOREIGN KEY (order_id) REFERENCES orders(id),
  CONSTRAINT fk_ent_version FOREIGN KEY (product_version_id) REFERENCES product_versions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Optional: download event logs (analytics/abuse)
CREATE TABLE download_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  order_id BIGINT UNSIGNED NOT NULL,
  product_asset_id BIGINT UNSIGNED NOT NULL,
  ip_hash CHAR(64) NULL,
  user_agent_hash CHAR(64) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_dl_product_time (product_id, created_at),
  KEY idx_dl_user_time (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =========================
-- Discounts (product-scoped)
-- =========================
CREATE TABLE discounts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id BIGINT UNSIGNED NOT NULL,
  code VARCHAR(64) NOT NULL,
  type ENUM('percent','fixed') NOT NULL,
  value_percent DECIMAL(5,2) NULL,
  value_cents INT UNSIGNED NULL,
  applies_to_version_id BIGINT UNSIGNED NULL,
  min_purchase_cents INT UNSIGNED NULL,
  max_redemptions INT UNSIGNED NULL,
  expires_at DATETIME NULL,
  status ENUM('active','disabled') NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_discount_code (product_id, code),
  KEY idx_discount_product (product_id),
  KEY idx_discount_version (applies_to_version_id),
  CONSTRAINT fk_discount_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT fk_discount_version FOREIGN KEY (applies_to_version_id) REFERENCES product_versions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE discount_redemptions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  discount_id BIGINT UNSIGNED NOT NULL,
  order_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  redeemed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_discount_order (discount_id, order_id),
  KEY idx_redemptions_user (user_id, redeemed_at),
  CONSTRAINT fk_red_discount FOREIGN KEY (discount_id) REFERENCES discounts(id),
  CONSTRAINT fk_red_order FOREIGN KEY (order_id) REFERENCES orders(id),
  CONSTRAINT fk_red_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =========================
-- Affiliates (product-scoped) + payouts
-- =========================
CREATE TABLE affiliates (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id BIGINT UNSIGNED NOT NULL,
  code VARCHAR(64) NOT NULL,
  email VARCHAR(320) NULL,
  stripe_connected_account_id VARCHAR(255) NULL,
  payout_percent DECIMAL(5,2) NOT NULL DEFAULT 10.00,
  status ENUM('active','disabled') NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_affiliate_code (product_id, code),
  KEY idx_aff_product (product_id),
  CONSTRAINT fk_aff_product FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE affiliate_clicks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  affiliate_id BIGINT UNSIGNED NOT NULL,
  landing_path VARCHAR(1024) NULL,
  ip_hash CHAR(64) NULL,
  user_agent_hash CHAR(64) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_aff_click_aff (affiliate_id, created_at),
  CONSTRAINT fk_aff_click FOREIGN KEY (affiliate_id) REFERENCES affiliates(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE affiliate_attributions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  checkout_attempt_id CHAR(36) NOT NULL,
  affiliate_id BIGINT UNSIGNED NOT NULL,
  attributed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_aff_attr_checkout (checkout_attempt_id),
  KEY idx_aff_attr_aff (affiliate_id, attributed_at),
  CONSTRAINT fk_aff_attr_aff FOREIGN KEY (affiliate_id) REFERENCES affiliates(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE affiliate_commissions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  affiliate_id BIGINT UNSIGNED NOT NULL,
  order_id BIGINT UNSIGNED NOT NULL,
  currency CHAR(3) NOT NULL,
  amount_cents INT UNSIGNED NOT NULL,
  status ENUM('pending','available','paid','reversed') NOT NULL DEFAULT 'pending',
  available_at DATETIME NULL,
  paid_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_aff_comm_order (affiliate_id, order_id),
  KEY idx_aff_comm_status (affiliate_id, status, available_at),
  CONSTRAINT fk_aff_comm_aff FOREIGN KEY (affiliate_id) REFERENCES affiliates(id),
  CONSTRAINT fk_aff_comm_order FOREIGN KEY (order_id) REFERENCES orders(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE affiliate_payouts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  affiliate_id BIGINT UNSIGNED NOT NULL,
  currency CHAR(3) NOT NULL,
  total_cents INT UNSIGNED NOT NULL,
  stripe_transfer_id VARCHAR(255) NULL,
  status ENUM('queued','processing','paid','failed') NOT NULL DEFAULT 'queued',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_aff_payout_aff (affiliate_id, created_at),
  CONSTRAINT fk_aff_payout_aff FOREIGN KEY (affiliate_id) REFERENCES affiliates(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =========================
-- Outbound webhooks (product-scoped)
-- =========================
CREATE TABLE webhook_subscriptions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id BIGINT UNSIGNED NOT NULL,
  url VARCHAR(2048) NOT NULL,
  secret VARCHAR(255) NOT NULL,
  events_json JSON NOT NULL,
  status ENUM('active','disabled') NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_webhook_product (product_id),
  CONSTRAINT fk_webhook_product FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE webhook_deliveries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  webhook_subscription_id BIGINT UNSIGNED NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  payload_json JSON NOT NULL,
  status ENUM('queued','sent','failed','dead') NOT NULL DEFAULT 'queued',
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  next_retry_at DATETIME NULL,
  last_error MEDIUMTEXT NULL,
  sent_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_delivery_sub_status (webhook_subscription_id, status, next_retry_at),
  KEY idx_delivery_status (status, next_retry_at),
  CONSTRAINT fk_delivery_sub FOREIGN KEY (webhook_subscription_id) REFERENCES webhook_subscriptions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =========================
-- Stripe events (replay source of truth)
-- =========================
CREATE TABLE stripe_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  stripe_event_id VARCHAR(255) NOT NULL,
  type VARCHAR(255) NOT NULL,
  payload_json JSON NOT NULL,
  received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at DATETIME NULL,
  status ENUM('received','processed','failed') NOT NULL DEFAULT 'received',
  last_error MEDIUMTEXT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_stripe_event (stripe_event_id),
  KEY idx_stripe_status (status, received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =========================
-- Jobs (MySQL-backed queue)
-- =========================
CREATE TABLE jobs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  type VARCHAR(64) NOT NULL,
  idempotency_key VARCHAR(128) NULL,
  payload_json JSON NOT NULL,
  status ENUM('queued','running','succeeded','failed','dead') NOT NULL DEFAULT 'queued',
  run_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts INT UNSIGNED NOT NULL DEFAULT 10,
  locked_by VARCHAR(64) NULL,
  locked_at DATETIME NULL,
  last_error MEDIUMTEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_job_idem (type, idempotency_key),
  KEY idx_jobs_run (status, run_at),
  KEY idx_jobs_lock (status, locked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =========================
-- Licenses + activations
-- =========================
CREATE TABLE licenses (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id BIGINT UNSIGNED NOT NULL,
  product_version_id BIGINT UNSIGNED NOT NULL,
  order_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  license_key VARCHAR(128) NOT NULL,
  status ENUM('active','revoked') NOT NULL DEFAULT 'active',
  max_activations INT UNSIGNED NOT NULL DEFAULT 3,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_license_key (license_key),
  KEY idx_license_user (user_id),
  KEY idx_license_order (order_id),
  KEY idx_license_product (product_id),
  CONSTRAINT fk_license_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT fk_license_version FOREIGN KEY (product_version_id) REFERENCES product_versions(id),
  CONSTRAINT fk_license_order FOREIGN KEY (order_id) REFERENCES orders(id),
  CONSTRAINT fk_license_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE license_activations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  license_id BIGINT UNSIGNED NOT NULL,
  device_id_hash CHAR(64) NOT NULL,
  status ENUM('active','revoked') NOT NULL DEFAULT 'active',
  first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_license_device (license_id, device_id_hash),
  KEY idx_activation_last_seen (license_id, status, last_seen_at),
  CONSTRAINT fk_activation_license FOREIGN KEY (license_id) REFERENCES licenses(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =========================
-- GitHub invites (optional)
-- =========================
CREATE TABLE github_invites (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id BIGINT UNSIGNED NOT NULL,
  order_id BIGINT UNSIGNED NOT NULL,
  repo VARCHAR(255) NOT NULL,
  email VARCHAR(320) NOT NULL,
  status ENUM('queued','sent','accepted','failed') NOT NULL DEFAULT 'queued',
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  last_error MEDIUMTEXT NULL,
  invited_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_gi_order (order_id),
  KEY idx_gi_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

---

## 24) SDK attribute reference table (canonical names → behavior)

| Attribute                 | Required | Type           | Behavior                                                                                              |
| ------------------------- | -------: | -------------- | ----------------------------------------------------------------------------------------------------- |
| `data-store-action`       |        ✅ | string         | Must be `checkout`. SDK binds clicks only for this value.                                             |
| `data-store-product`      |       ◻︎ | string         | Product slug. Optional if provided via `window.__STOREFRONT__.product` or script tag defaults.        |
| `data-store-version`      |        ✅ | string         | Version slug within the product.                                                                      |
| `data-store-pricing`      |        ✅ | `fixed`|`pwyw` | Pricing mode. Determines how the request is constructed.                                              |
| `data-store-pwyw-input`   |       ◻︎ | CSS selector   | Selector for amount input (required when `pwyw`). Value parsed in major units and converted to cents. |
| `data-store-min-cents`    |       ◻︎ | integer        | Client-side minimum check. Server still enforces. Recommended when `pwyw`.                            |
| `data-store-coupon-input` |       ◻︎ | CSS selector   | Reads coupon string from an input element at click time.                                              |
| `data-store-email-input`  |       ◻︎ | CSS selector   | Reads email from an input element at click time and passes to checkout creation.                      |
| `data-store-success-url`  |       ◻︎ | URL            | Overrides default success URL for this button only.                                                   |
| `data-store-cancel-url`   |       ◻︎ | URL            | Overrides default cancel URL for this button only.                                                    |
| `data-store-error-target` |       ◻︎ | CSS selector   | If present, SDK writes error text into this element instead of `alert()`.                             |
| `data-store-affiliate`    |       ◻︎ | string         | Optional explicit affiliate code override. If absent, SDK uses stored `?aff=` capture.                |
| `data-store-coupon`       |       ◻︎ | string         | Optional explicit coupon override. If absent, SDK uses input or stored `?coupon=` capture.            |

### SDK request mapping

At click time, SDK builds:

* `checkout_attempt_id`: UUID v4
* `productSlug`: from attribute or defaults
* `versionSlug`: attribute
* `pricing`: attribute
* `pwywAmountCents`: parsed from input (pwyw only)
* `coupon`: from override → input → stored param
* `affiliate`: from override → stored param
* `customerEmail`: from input
* `successUrl/cancelUrl`: optional overrides

### SDK versioning

* Use versioned URLs:

  * `/sdk/storefront.v1.js`
* Keep v1 stable; introduce breaking changes only in v2+.

---

## 25) Creator dashboard wireframe spec (screens + actions)

> This is functional IA (information architecture). No styling implied.

### 25.1 Global nav

* **Overview**
* **Products**
* **Orders**
* **Discounts**
* **Affiliates**
* **Webhooks**
* **Licenses**
* **Analytics**
* **Operations** (Jobs/Failures/Event replay)
* **Settings**

### 25.2 Overview

* KPI tiles (last 24h / 7d / 30d): revenue, orders, refund rate, conversion rate
* Alerts: failed jobs, webhook dead letters, payout failures, Stripe webhook failures

### 25.3 Products list

* Table: Product, status, revenue (30d), orders (30d), last updated
* Actions: create product, duplicate product, archive

### 25.4 Product detail (tabs)

**Tab A — Basics**

* Edit title/slug/description/status/currency

**Tab B — Versions**

* List versions (status: draft/active/preorder/retired)
* Edit base pricing: fixed or pwyw + min
* License policy: max activations, enable/disable
* Preorder settings: release_at
* Actions: create version, retire version

**Tab C — Pricing schedule**

* Upcoming price changes table
* Add schedule row (effective_at, pricing, amounts)
* Delete schedule row

**Tab D — Assets**

* Upload asset
* List assets per version
* Replace asset (new storage key) while keeping entitlement history

**Tab E — Landing page**

* Mode A: upload HTML, upload assets.zip, preview, publish
* Mode B: show integration snippet + button examples for each version
* Copy-to-clipboard blocks

**Tab F — Product-scoped Webhooks**

* Manage subscriptions (url, secret, events)

**Tab G — Product-scoped Discounts**

* Manage discounts (code, type, value, scope version/all, expiry)

**Tab H — Product-scoped Affiliates**

* Manage affiliates (code, percent, connected account status)
* Generate affiliate link

### 25.5 Orders

* Filters: product, status, date range, coupon, affiliate, email
* Table: order id, buyer email, total, status, created, paid, refunded
* Bulk export CSV

### 25.6 Order detail

* Stripe refs (checkout session, payment intent)
* Items (version)
* Applied coupon + affiliate
* Fulfillment status: email/webhook/license/github
* Actions:

  * Refund (full/partial) → triggers Stripe refund creation
  * Revoke/restore entitlements
  * Re-issue license
  * Resend email
  * Replay outbound webhooks

### 25.7 Licenses

* Search by email, license key, order
* View activations (device hash, first/last seen)
* Actions: revoke activation, revoke license, increase max activations

### 25.8 Affiliates

* List affiliates by product
* Commission ledger
* Payout runs (weekly/monthly)
* Actions: trigger payout run, retry failed payout

### 25.9 Discounts

* List discounts by product
* Redemption stats

### 25.10 Webhooks

* Delivery logs: status, attempts, last error
* Actions: resend, disable endpoint

### 25.11 Analytics

* Filters: product, version, date range
* Metrics:

  * Views (if tracked), checkout attempts, completed orders
  * Conversion rate
  * Revenue by version
  * Refund rate
  * Affiliate contribution
* Exports

### 25.12 Operations

* Jobs: queued/running/failed/dead
* Stripe events: received/processed/failed
* Actions:

  * Retry job
  * Mark dead
  * Replay Stripe event

### 25.13 Settings

* Stripe keys + webhook secret
* Stripe Connect settings (for affiliates)
* Email SMTP settings
* Default success/cancel URLs
* Data retention settings

---

## 26) What else is missing? Key edge cases & gotchas

### Payments & Stripe ordering

* **Webhook order is not guaranteed** (refund/dispute events can arrive before paid processing). Code must be event-driven + idempotent.
* **Checkout session expires**: mark attempt `expired`, don’t grant entitlements.
* **Partial refunds**: order becomes `partially_refunded`; decide whether to revoke entitlements (usually yes for single-item digital).
* **Disputes/chargebacks**: treat like refund and revoke immediately; add `disputed` state.
* **Multiple payments for same email**: user account linking by normalized email must be stable.

### Pricing schedule interactions

* **Price changes during an open checkout**: you must accept the price at session creation time; don’t retroactively change an in-flight session.
* **Preorder release time**: define timezone; release job should be idempotent and re-runnable.

### Discounts

* **Race on max redemptions** under spikes: enforce redemption counts transactionally (lock discount row or use atomic increment pattern).
* **Discount applies-to-version vs product**: precedence rules must be explicit.

### Affiliates & payouts

* **Refund after payout**: commission reversal can create negative affiliate balance. Decide policy:

  * carry negative forward
  * hold reserve
* **Connect onboarding incomplete**: commissions accrue but payout blocked.

### Licenses

* **Device hash changes** after reinstall/updates: offer "replace oldest activation" as default UX.
* **Clock skew / offline**: grace period policy should be explicit.
* **Validation storms**: apps calling validate too often; rate limit per license.

### Webhooks delivery

* **Endpoint flakiness**: retries with backoff; avoid thundering herds during outages.
* **Idempotency on receiver**: include `event_id` so receivers can dedupe.

### Job queue correctness

* **Exactly-once is not achievable**; design each job as idempotent.
* **Stale locks**: worker crash recovery must re-queue.

### Analytics quality

* **Conversion rate** requires consistent definition (views vs attempts vs paid). MVP: attempts→paid.

### Data retention

* **Anonymization must preserve referential integrity** (don’t delete user rows referenced by orders).

---

## 16) Open decisions (capture in UI/settings)

* Default currency per product
* PWYW min per version
* Offline grace period for license validation
* Affiliate window (days) + commission percent
* Commission holding period (days) before payable
* Webhook retry policy (max attempts, backoff)
* Preorder timezone + release behavior
* Partial refund policy (revoke vs keep)
* Negative affiliate balance policy
