/* extract.js - Rule-based extraction engine for LocalLedger
 * Used as a zero-cloud fallback, baseline reader, and sanity layer.
 * Works both in the browser (window.Extract) and in Node.js (module.exports).
 */
(function (root) {
  "use strict";

  const MONTHS = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
  };

  const CATEGORIES = [
    "Travel",
    "Food & Meals",
    "Software & Cloud",
    "Office Supplies",
    "Internet & Utilities",
    "Professional Fees",
    "Hardware & Equipment",
    "Marketing & Ads",
    "Other"
  ];

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function toISO(y, m, d) {
    y = Number(y);
    m = Number(m);
    d = Number(d);
    if (y < 100) y += 2000;
    if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return "";
    return y + "-" + pad(m) + "-" + pad(d);
  }

  function findDate(text) {
    let m;
    // 2026-10-13 or 2026/10/13 or 2026.10.13
    m = text.match(/\b(20\d{2})[\s\-\/\.](\d{1,2})[\s\-\/\.](\d{1,2})\b/);
    if (m) {
      const r = toISO(m[1], m[2], m[3]);
      if (r) return r;
    }

    // 13/10/2026, 13-10-2026, 13.10.26 (Indian day-first format)
    m = text.match(/\b(\d{1,2})[\s\-\/\.](\d{1,2})[\s\-\/\.](\d{2,4})\b/);
    if (m) {
      const r = toISO(m[3].length === 2 ? "20" + m[3] : m[3], m[2], m[1]);
      if (r) return r;
    }

    // 13 Oct 2026 / 13 October, 2026 / 13-Oct-26
    m = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?[\s\-\/\.]+([A-Za-z]{3,9})[\s,.\-\/]+(\d{2,4})\b/);
    if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) {
      const r = toISO(m[3].length === 2 ? "20" + m[3] : m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], m[1]);
      if (r) return r;
    }

    // Oct 13, 2026 or October 13 2026
    m = text.match(/\b([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/);
    if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) {
      const r = toISO(m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], m[2]);
      if (r) return r;
    }

    return "";
  }

  function parseAmount(s) {
    if (s == null) return null;
    const cleaned = String(s)
      .replace(/[^\d.,]/g, "")
      .replace(/,(?=\d{3}\b)/g, "")
      .replace(/,/g, "");
    const n = parseFloat(cleaned);
    return isFinite(n) ? n : null;
  }

  function numbersIn(line) {
    const out = [];
    const re = /(?:₹|rs\.?|inr|\$|€|£)?\s*(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/gi;
    let m;
    while ((m = re.exec(line))) {
      const v = parseAmount(m[1]);
      if (v !== null) out.push(v);
    }
    return out;
  }

  function findTotal(text) {
    const lines = text.split(/\r?\n/);
    const strong = /(grand\s*total|total\s*amount|amount\s*(?:due|payable)|net\s*(?:amount|payable)|balance\s*due|total\s*payable|invoice\s*total|final\s*amount|bill\s*amount)/i;
    const weak = /\btotal\b/i;
    const skip = /(sub\s*total|total\s*(?:tax|gst|cgst|sgst|igst|discount|qty|quantity)|item\s*total)/i;

    let best = null;
    for (const pass of [strong, weak]) {
      const cands = [];
      for (const line of lines) {
        if (pass === weak && skip.test(line)) continue;
        if (pass.test(line)) {
          const nums = numbersIn(line.replace(pass, " "));
          if (nums.length) cands.push(nums[nums.length - 1]);
        }
      }
      if (cands.length) {
        best = Math.max.apply(null, cands);
        break;
      }
    }
    return best;
  }

  function findGST(text) {
    const lines = text.split(/\r?\n/);
    let cgst = 0, sgst = 0, igst = 0, gstGeneric = null;

    for (const line of lines) {
      const nums = numbersIn(line);
      if (!nums.length) continue;
      const last = nums[nums.length - 1];

      if (/\bcgst\b/i.test(line)) {
        cgst = Math.max(cgst, last);
      } else if (/\bsgst\b/i.test(line)) {
        sgst = Math.max(sgst, last);
      } else if (/\bigst\b/i.test(line)) {
        igst = Math.max(igst, last);
      } else if (/\b(gst|tax|vat)\b/i.test(line) && !/gstin|gst\s*no|tax\s*invoice/i.test(line)) {
        gstGeneric = last;
      }
    }

    const sum = cgst + sgst + igst;
    if (sum > 0) return Math.round(sum * 100) / 100;
    return gstGeneric != null ? Math.round(gstGeneric * 100) / 100 : null;
  }

  function findGSTIN(text) {
    // Standard Indian GSTIN: 2 digits state code + 10 char PAN + 1 entity + Z + 1 check digit
    let m = text.toUpperCase().match(/\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/);
    if (m) return m[0];

    // Relaxed match for OIDAR / international entities or slight OCR imperfections
    m = text.toUpperCase().match(/(?:GSTIN|GST\s*NO\.?|GST\s*ID)\s*[:\-#]?\s*([0-9]{2}[A-Z0-9]{13})\b/);
    if (m) return m[1];

    return "";
  }

  function findInvoiceNo(text) {
    // Explicit pattern: Invoice No / Bill No / Receipt #
    const m = text.match(/(?:tax\s*invoice|invoice|inv|bill|receipt)\s*(?:no\.?|number|num|#)\s*[:\-#]?\s*([A-Z0-9][A-Z0-9\/\-_]{2,})/i);
    if (m) return m[1].trim();

    // Secondary fallback: standalone #12345 or INV-12345
    const fallback = text.match(/\b(INV[-\/][A-Z0-9\-]+)\b/i);
    return fallback ? fallback[1].trim() : "";
  }

  function findVendor(text) {
    const lines = text.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
    const ignoreHeader = /^(tax\s*invoice|invoice|bill\s*of\s*supply|retail\s*invoice|cash\s*memo|receipt|gstin|date|original\s*for\s*recipient)/i;

    for (const l of lines.slice(0, 10)) {
      if (ignoreHeader.test(l)) continue;
      // Filter out pure numbers, dates, or contact lines
      if (/[A-Za-z]{3,}/.test(l) && !/^(tel|phone|ph|email|www\.|http|address|gst|pan|cin)/i.test(l) && l.length >= 3 && l.length < 70) {
        return l.replace(/[^\w &.'\-\/]/g, "").trim();
      }
    }
    return "";
  }

  function guessCategory(text) {
    const t = text.toLowerCase();
    const rules = [
      ["Travel", /(uber|ola|irctc|indigo|air\s*india|vistara|flight|taxi|cab|fuel|petrol|diesel|toll|fastag|train|bus\s*ticket|parking)/],
      ["Food & Meals", /(restaurant|cafe|swiggy|zomato|dining|meal|biryani|coffee|food|bakery|starbucks|mcdonalds|eatery|canteen)/],
      ["Software & Cloud", /(subscription|hosting|domain|saas|license|cloud|github|aws|amazon\s*web\s*services|google\s*workspace|adobe|vercel|heroku|openai|cursor|digitalocean|slack|figma|jetbrains|microsoft|atlassian|notion)/],
      ["Office Supplies", /(stationery|printer|paper|toner|cartridge|furniture|office\s*supplies|desk|chair|notebook)/],
      ["Internet & Utilities", /(electricity|internet|broadband|airtel|jio|vodafone|vi|act\s*fibernet|mobile\s*bill|phone\s*bill|water\s*bill|power|utility|recharge)/],
      ["Professional Fees", /(consulting|consultancy|professional\s*fee|legal|advocate|lawyer|audit|ca\s*firm|freelance|retainer|advisory)/],
      ["Hardware & Equipment", /(laptop|macbook|monitor|keyboard|mouse|camera|hardware|croma|reliance\s*digital|apple|lenovo|dell|hp|asus|ssd|ram|gadget|headphone)/],
      ["Marketing & Ads", /(meta\s*ads|facebook\s*ads|google\s*ads|linkedin\s*ads|marketing|campaign|sponsorship|flyer|banner|billboard|branding)/]
    ];

    for (const r of rules) {
      if (r[1].test(t)) return r[0];
    }
    return "Other";
  }

  function extract(text) {
    const total = findTotal(text);
    return {
      vendor: findVendor(text),
      invoice_number: findInvoiceNo(text),
      date: findDate(text),
      gstin: findGSTIN(text),
      gst_amount: findGST(text),
      total: total,
      category: guessCategory(text)
    };
  }

  const api = {
    extract: extract,
    findDate: findDate,
    findTotal: findTotal,
    findGST: findGST,
    findGSTIN: findGSTIN,
    findInvoiceNo: findInvoiceNo,
    findVendor: findVendor,
    parseAmount: parseAmount,
    guessCategory: guessCategory,
    CATEGORIES: CATEGORIES
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.Extract = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
