# MediPOS — Pharmacy POS, Inventory & Accounting

A web app for a medical shop: point of sale, batch and expiry tracking, purchasing, customers and suppliers, double-entry accounting, reports, and an admin panel where the owner can change almost everything without touching code.

**Stack:** plain HTML, CSS and JavaScript (ES modules, no build step) · Firebase Auth and Firestore (live database) · Google Sheets (reporting copy, via Apps Script) · GitHub (code) · Vercel (hosting).

Sign-in is **email and password only**. There is no Google sign-in anywhere in the app.

---

## 1. What is inside

| Area | What it does |
|---|---|
| **Dashboard** | Today's revenue, bills, gross profit, month revenue, 7-day chart, alerts for low stock and expiry |
| **Sell (POS)** | Product grid with categories, search and barcode/SKU scan, cart, discounts, customer, payment method, invoice and receipt. Stock is taken first-expired-first-out. Works on phones with a sticky charge bar. |
| **Inventory** | Products, stock in and out (write-offs with reasons), batches with expiry dates, reorder levels, stock value, deactivate and reactivate |
| **Purchasing** | Supplier bills with multiple lines, batch numbers and expiry dates, weighted-average cost, input VAT, credit or cash |
| **Customers & suppliers** | Balances, credit limits, receive payments from customers, pay suppliers |
| **Accounting** | Journal (auto-posted from every sale, purchase, payment and expense), manual entries, chart of accounts, expenses, Profit & Loss, Balance Sheet, Trial Balance. Every journal must balance before it is saved. |
| **Reports** | Sales (by item and payment method), stock valuation, expiry report. CSV download and a button to send to Google Sheets. |
| **Administration** | Staff accounts, shop settings, lists, payment methods, role-page access, Google Sheets connection, activity log |

### Roles (defaults, editable by the admin)

| Role | Default pages |
|---|---|
| Administrator | Everything |
| Pharmacist | Dashboard, Sell, Inventory, Purchasing, Customers, Reports |
| Cashier | Dashboard, Sell, Customers |
| Storekeeper | Inventory, Purchasing, Customers |
| Accountant | Dashboard, Accounting, Reports, Purchasing, Customers |

Data rules are enforced by `firestore.rules`, not only by the screens, so a user cannot bypass them through the browser console.

---

## 2. Everything the admin can change (no code)

Open **Administration** after signing in as admin.

- **Staff:** add staff (name, email, temporary password, role), change role, disable accounts, send password-reset emails.
- **Shop & rules:** shop name, address, phone, tax number, currency code, default VAT %, maximum discount a cashier may give, whether credit sales are allowed, invoice and purchase number prefixes, receipt footer, expiry warning days, default reorder level.
- **Lists & payments:** product categories, units, write-off reasons, and payment methods (name, which ledger account the money goes to, and whether it is an on-account method).
- **Role access:** which pages each role can open, and each role's display name.
- **Google Sheets:** the Apps Script URL and shared secret, with a test button.
- **Chart of accounts:** add accounts from the Accounting tab, or load the defaults.

Settings save to Firestore and apply after a page reload.

> **Note:** Role *page access* is customizable. The *data* permissions in `firestore.rules` use the fixed role names above. Adding a brand-new role needs a small rules change.

---

## 3. Set up Firebase (about 15 minutes)

1. Go to <https://console.firebase.google.com> → **Add project**.
2. **Build → Authentication → Get started → Sign-in method → Email/Password → Enable.** Leave Google and every other provider off.
3. **Build → Firestore Database → Create database** (production mode, pick the region closest to you).
4. **Project settings → General → Your apps → Web (`</>`)** → register the app → copy the `firebaseConfig` values into **`js/config.js`**.
5. Deploy the security rules. Either paste `firestore.rules` into the Firestore **Rules** tab and publish, or run:
   ```bash
   npm i -g firebase-tools
   firebase login
   firebase init firestore      # choose the existing project, keep firestore.rules
   firebase deploy --only firestore:rules
   ```
6. **Create the first admin (one-time, manual):**
   - Authentication → Users → **Add user** → enter the admin's email and a password.
   - Copy the new user's **User UID**.
   - Firestore → **Start collection** → ID `users` → Document ID = that UID, with fields:
     - `name` (string) = `Your Name`
     - `email` (string) = the admin's email
     - `role` (string) = `admin`
     - `active` (boolean) = `true`
7. Open the app (locally with `npx serve .` or after deploying) and sign in.
8. Go to **Administration → Shop & rules** and fill in your shop name, currency and VAT. Then go to **Lists & payments** and check the categories and payment methods.

Other staff are then added from **Administration → Staff**. The app creates their sign-in on a secondary connection, so you stay signed in as admin.

---

## 4. Connect Google Sheets (optional, reporting copy)

Firestore is the live database. Sheets is only the reporting copy. Google Sheets can't safely handle many simultaneous sales, so it is not used as the database.

1. Create or open a Google Sheet and copy its ID from the URL (`/d/<ID>/edit`).
2. Go to <https://script.google.com> → **New project**. Replace the code with `apps-script/Code.gs`.
3. **Project Settings → Script properties** → add:
   - `SHEET_ID` = the spreadsheet ID
   - `SECRET` = a long random string
4. **Deploy → New deployment → Web app** → Execute as **Me**, Who has access **Anyone** → Deploy → copy the `/exec` URL.
5. In MediPOS, go to **Administration → Google Sheets**, paste the URL and the same secret, and press **Test connection**.
6. Reports → **Send to Google Sheets** writes the Sales, Stock and Expiry tabs. Each send replaces the previous data in those tabs.

---

## 5. Put the code on GitHub

```bash
cd medipos
git init
git add .
git commit -m "MediPOS: initial version"
git branch -M main
git remote add origin https://github.com/<your-user>/medipos.git
git push -u origin main
```

Create the empty repository on GitHub first. The `js/config.js` values are not secrets, but keep the repository **private** anyway.

---

## 6. Host on Vercel

1. <https://vercel.com> → **Add New → Project** → import the GitHub repository.
2. **Framework Preset:** *Other*. **Build Command:** leave empty. **Output Directory:** leave empty (the root is served).
3. **Deploy.** Every push to `main` redeploys.
4. Add your domain under **Settings → Domains** if you have one.

`vercel.json` adds security headers and a Content-Security-Policy, which allows only Firebase and Google endpoints.

**Firebase authorised domains:** Authentication → Settings → **Authorized domains** → add your Vercel domain, otherwise sign-in will fail on the live site.

---

## 7. Accounting logic (what posts automatically)

| Event | Journal entry |
|---|---|
| Cash / card sale | Dr Cash or Bank · Cr Sales · Cr VAT Payable · Dr COGS · Cr Inventory |
| Sale on account | Dr Accounts Receivable · Cr Sales · Cr VAT Payable · Dr COGS · Cr Inventory |
| Purchase | Dr Inventory · Dr VAT Input · Cr Cash/Bank or Accounts Payable |
| Customer pays | Dr Cash/Bank · Cr Accounts Receivable |
| Supplier paid | Dr Accounts Payable · Cr Cash/Bank |
| Expense | Dr Expense account · Cr Cash/Bank |
| Stock write-off | Dr Other Expenses · Cr Inventory (at batch cost) |
| Stock in (opening/found) | Dr Inventory · Cr Owner's Equity |

Sales, stock and journal entries are written in one Firestore transaction, so either all of them are saved or none are.

---

## 8. Project layout

```
medipos/
├── index.html           app shell
├── css/styles.css       design system, animations, mobile layout, print styles
├── js/
│   ├── config.js        ← paste Firebase config here
│   ├── firebase.js      Firebase setup (Auth + Firestore)
│   ├── core.js          settings, roles, money, journal guard, FEFO, shared UI
│   ├── app.js           sign-in, navigation, role-based routing
│   ├── sheets.js        sends reports to Google Sheets
│   └── pages/           dashboard · pos · inventory · purchasing · partners ·
│                        accounting · reports · admin
├── apps-script/Code.gs  Google Sheets receiver
├── firestore.rules      database security rules
├── vercel.json          hosting and security headers
└── .gitignore
```

---

## 9. Before going live

- [ ] Firestore rules published (step 3.5) and the first admin created.
- [ ] Vercel domain added to Firebase **Authorized domains**.
- [ ] Test each role: sign in, confirm the right pages appear, and try one action the role should not be allowed to take.
- [ ] Test a sale, a purchase, a customer payment and a write-off, then check **Accounting → Trial Balance** shows equal debits and credits.
- [ ] Take regular backups: Firestore → export, or the Google Sheets reports.
- [ ] Turn on **Firebase App Check** and Firestore backups (a paid Google Cloud feature) for production.
- [ ] Keep the staff list small and disable accounts when someone leaves.

---

## 10. Known limits and next steps

- **Returns and voiding sales** are not built yet. Corrections are made with a manual journal entry plus a stock-in.
- **Multi-branch** (one database for several shops) is not built yet.
- **Offline selling** needs the internet connection. Offline mode can be added later.
- **Printed invoices** use the browser's print dialog. A thermal-printer setup can be added later.
- **Tax** is a single VAT rate per product. Multiple tax groups are not built yet.
- **Two-factor sign-in** can be enabled in Firebase Authentication if wanted.
