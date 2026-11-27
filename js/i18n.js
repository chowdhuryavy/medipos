// Bangla language layer. Switches the visible labels of every screen (including ones drawn later) without touching
// each page's code. Each person chooses on their own device; the choice is remembered in this browser.
// Text not in the dictionary stays English; numbers, names and amounts are never changed.
import { applyAppFont } from "./core.js";

const KEY = "medipos.lang";
const DICT = {
  "Dashboard": "ড্যাশবোর্ড", "Sell": "বিক্রয়", "Point of Sale": "বিক্রয় কেন্দ্র", "Cash shift": "ক্যাশ শিফট",
  "Import products": "পণ্য আমদানি", "Prescriptions": "প্রেসক্রিপশন", "Prescriptions & doctors": "প্রেসক্রিপশন ও ডাক্তার",
  "Inventory": "মজুদ", "Purchasing": "ক্রয়", "Customers": "গ্রাহক", "Customers & Suppliers": "গ্রাহক ও সরবরাহকারী",
  "Customers & suppliers": "গ্রাহক ও সরবরাহকারী", "Accounting": "হিসাব", "Reports": "প্রতিবেদন", "Administration": "প্রশাসন",
  "Staff activity": "কর্মী কার্যক্রম", "Settings": "সেটিংস", "Returns": "ফেরত", "Returns & voids": "ফেরত ও বাতিল",
  "Save": "সংরক্ষণ করুন", "Save changes": "পরিবর্তন সংরক্ষণ করুন", "Cancel": "বাতিল", "Add": "যোগ করুন",
  "Search": "খুঁজুন", "Print": "প্রিন্ট", "Delete": "মুছুন", "Edit": "সম্পাদনা", "Close": "বন্ধ করুন", "Confirm": "নিশ্চিত করুন",
  "Name": "নাম", "Price": "দাম", "Quantity": "পরিমাণ", "Total": "মোট", "Date": "তারিখ", "Status": "অবস্থা", "Phone": "ফোন",
  "Notes": "নোট", "Group": "গ্রুপ", "Sub group": "সাব-গ্রুপ", "Unit": "একক", "Charge": "পরিশোধ", "Cash": "নগদ", "Card": "কার্ড",
  "Receipt": "রসিদ", "Refund": "ফেরত", "Void": "বাতিল", "Export": "রপ্তানি", "Logout": "লগ আউট", "Sign out": "সাইন আউট",
  "Products": "পণ্য", "Product": "পণ্য", "Doctor": "ডাক্তার", "Doctors and clinics": "ডাক্তার ও ক্লিনিক", "Clinic": "ক্লিনিক",
  "Patient name": "রোগীর নাম", "Save prescription": "প্রেসক্রিপশন সংরক্ষণ করুন", "Record a prescription": "প্রেসক্রিপশন লিপিবদ্ধ করুন",
  "Register": "নিবন্ধন", "Add medicine": "ওষুধ যোগ করুন", "Add doctor": "ডাক্তার যোগ করুন", "Download template": "টেমপ্লেট ডাউনলোড",
  "Medicines on the prescription": "প্রেসক্রিপশনের ওষুধ", "No prescriptions to show.": "দেখানোর মতো প্রেসক্রিপশন নেই।",
  "No doctors yet.": "এখনো কোনো ডাক্তার নেই।", "No shifts yet.": "এখনো কোনো শিফট নেই।", "Open shift": "শিফট খুলুন",
  "Close shift": "শিফট বন্ধ করুন", "Opening cash": "শুরুর নগদ", "Cash sales": "নগদ বিক্রয়", "Cash refunds": "নগদ ফেরত",
  "Expected in drawer": "ড্রয়ারে প্রত্যাশিত", "Counted cash": "গোনা নগদ", "Recent shifts": "সাম্প্রতিক শিফট",
  "Opening stock": "শুরুর মজুদ", "Create product": "পণ্য তৈরি করুন", "New product": "নতুন পণ্য", "Add product": "পণ্য যোগ করুন",
  "Sale price": "বিক্রয় মূল্য", "Cost price": "ক্রয় মূল্য", "Expiry date": "মেয়াদের তারিখ", "VAT": "ভ্যাট",
  "Reorder level": "পুনঃক্রম স্তর", "Rack": "র‍্যাক", "Shelf": "তাক", "Barcode": "বারকোড", "SKU": "এসকেইউ",
  "Customer": "গ্রাহক", "Supplier": "সরবরাহকারী", "Notifications": "বিজ্ঞপ্তি", "Today": "আজ", "Total due": "মোট প্রদেয়",
  "Change": "ফেরতি", "Discount": "ছাড়", "Recorded by": "লিপিবদ্ধকারী", "Controlled": "নিয়ন্ত্রিত",
  "Controlled drugs only": "শুধু নিয়ন্ত্রিত ওষুধ", "Show": "দেখান", "Who": "কে", "When": "কখন", "Action": "কাজ",
  "Details": "বিবরণ", "Medicine": "ওষুধ", "Qty": "পরিমাণ", "Smallest unit": "ক্ষুদ্রতম একক", "Opening": "শুরু",
  "Expected": "প্রত্যাশিত", "Counted": "গোনা", "Difference": "পার্থক্য", "Opened": "খোলা হয়েছে", "By": "দ্বারা",
  "Closed by": "বন্ধকারী", "Shift open": "শিফট খোলা", "Note": "নোট", "Search…": "খুঁজুন…",
  "Your account": "আপনার অ্যাকাউন্ট", "Change password": "পাসওয়ার্ড পরিবর্তন", "Log in": "লগ ইন", "Sign in": "সাইন ইন", "Email": "ইমেইল", "Password": "পাসওয়ার্ড", "Users": "ব্যবহারকারী",
  "Roles": "ভূমিকা", "Branding": "ব্র্যান্ডিং", "General": "সাধারণ", "Language": "ভাষা",
  "Balance": "ব্যালেন্স", "Items": "আইটেম", "Stock": "মজুদ", "Stock value": "মজুদের মূল্য", "Expiry": "মেয়াদ",
  "Low stock": "কম মজুদ", "Expiring soon": "শিগগিরই মেয়াদ শেষ", "Purchases": "ক্রয়", "Sales": "বিক্রয়",
};
// Placeholder texts that also get translated.
const PLACEHOLDERS = { "Search…": "খুঁজুন…", "Search": "খুঁজুন", "Name, action or detail": "নাম, কাজ বা বিবরণ" };

const BN_FONTS = '"Kohinoor Bangla", "Nirmala UI", "Noto Sans Bengali", "Vrinda", system-ui, sans-serif';
let root = null;
let queued = false;
const seen = new WeakMap(); // text node → { base, out } (what the app wrote, and what we replaced it with)

export const getLang = () => (localStorage.getItem(KEY) === "bn" ? "bn" : "en");

function translateText(text) {
  const key = text.trim();
  if (!key || !(key in DICT)) return text;
  return text.replace(key, DICT[key]);
}

function paintTextNodes(scope) {
  const bn = getLang() === "bn";
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement && /^(SCRIPT|STYLE|TEXTAREA)$/.test(n.parentElement.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const prev = seen.get(node);
    // If the app wrote new text, that is the base; otherwise our last replacement is the base.
    const base = prev && node.nodeValue === prev.out ? prev.base : node.nodeValue;
    const desired = bn ? translateText(base) : base;
    if (desired !== node.nodeValue) node.nodeValue = desired;
    seen.set(node, { base, out: desired });
  }
  scope.querySelectorAll("input[placeholder], textarea[placeholder]").forEach((el) => {
    if (!el.dataset.phEn) el.dataset.phEn = el.placeholder;
    el.placeholder = bn && PLACEHOLDERS[el.dataset.phEn] ? PLACEHOLDERS[el.dataset.phEn] : el.dataset.phEn;
  });
}

// Translates the whole page by default, so dialogs and menus opened outside the app root change too.
export function applyLang(scope = document.body) {
  if (!scope) return;
  paintTextNodes(scope);
}

function scheduleApply() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => { queued = false; applyLang(); });
}

export function setLang(lang) {
  localStorage.setItem(KEY, lang === "bn" ? "bn" : "en");
  document.documentElement.lang = getLang();
  document.documentElement.dataset.lang = getLang();
  if (getLang() === "bn") document.documentElement.style.setProperty("--app-font", BN_FONTS);
  else applyAppFont();
  applyLang();
  const btn = document.getElementById("lang-btn");
  if (btn) { btn.textContent = getLang() === "bn" ? "EN" : "বাং"; btn.setAttribute("aria-label", getLang() === "bn" ? "Switch to English" : "বাংলায় পরিবর্তন"); }
}

// Call once, with the app's root element. New screens drawn later are translated automatically.
export function initLang(el) {
  root = el;
  document.documentElement.lang = getLang();
  document.documentElement.dataset.lang = getLang();
  if (getLang() === "bn") document.documentElement.style.setProperty("--app-font", BN_FONTS);
  new MutationObserver(scheduleApply).observe(document.body, { childList: true, subtree: true });
  applyLang();
}
