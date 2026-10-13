# LocalLedger 🛡️

**Private On-Device Invoice & Receipt Sorter for Freelancers and Tiny Agencies**
   > Built October 13-18, 2026 for the [DEV Hacktoberfest Open-Source AI Challenge, Week 2 (Side Hustle)](https://dev.to/challenges/hacktoberfest-week2-2026-10-12)

Drop in photos or PDFs of receipts and invoices. LocalLedger reads them directly on your machine and generates a clean, editable ledger with Vendor, Invoice Number, Date, GSTIN, GST (CGST+SGST/IGST), Total, and Category, ready to download as a tidy CSV or JSON for tax season.

> **100% On-Device Privacy:** Financial documents never leave your laptop. OCR runs inside your browser via WebAssembly (Tesseract.js & PDF.js), and local AI inference runs on your own machine through [Ollama](https://ollama.com). Zero telemetry, zero cloud uploads.

**DEV Hacktoberfest Open-Source AI Challenge, Week 2 (Side Hustle Track)**.

---

## Architecture & How It Works

```
┌────────────────────────────────────────────────────────┐
│                   YOUR LAPTOP ONLY                     │
│                                                        │
│  [ Receipts / Invoices ] (PDF, PNG, JPG, WEBP)         │
│          │                                             │
│          ▼                                             │
│  [ In-Browser OCR Layer ]                              │
│    • PDF.js (Native text layer extraction)             │
│    • Tesseract.js (WASM client-side optical scan)      │
│          │                                             │
│          ▼                                             │
│  [ Deterministic Rule Engine ] (extract.js)            │
│    • Regex for Indian Day-First Dates (DD/MM/YYYY)     │
│    • 15-character GSTIN & OIDAR detection              │
│    • CGST + SGST + IGST combined tax aggregation       │
│          │                                             │
│          ▼                                             │
│  [ Local AI Layer ] (Ollama: qwen2.5:1.5b)             │
│    • Structured JSON extraction & semantic parsing     │
│    • Vendor & invoice normalization                    │
│          │                                             │
│          ▼                                             │
│  [ Anti-Hallucination Guardrail ]                      │
│    • Verifies all numbers appear in scanned text       │
│    • Rejects hallucinated model amounts                │
│          │                                             │
│          ▼                                             │
│  [ Interactive Ledger & Review UI ]                    │
│    • In-place cell editing                             │
│    • Side-by-side document preview verification        │
│    • Real-time ITC / GST & spend metric totals         │
│    • 1-Click Excel CSV & JSON export                   │
└────────────────────────────────────────────────────────┘
```

---

## Features

- **🛡️ 100% Private & Offline-Capable:** No servers, no APIs, no subscription fees. Your receipts stay in memory.
- **⚡ Instant Demo:** Built-in "Load 3 Sample Invoices" button to test the entire OCR & AI pipeline with one click.
- **🤖 Dual-Layer Extraction:**
  - **Deterministic Rules (`extract.js`):** Fast regex parser for dates, totals, and Indian GST rules.
  - **Local Model (`qwen2.5:1.5b`):** 1.5B parameter open-weight model via Ollama for semantic understanding.
- **🛡️ Anti-Hallucination Guardrail:** The app only accepts the model's figures if the exact numbers appear in the scanned OCR text.
- **🔍 Side-by-Side Document Preview:** Click the 👁️ icon on any row to inspect the original receipt alongside extracted metadata and raw OCR text.
- **📊 Real-time Freelancer Metrics:** Instant totals for Spend, Claimable GST (Input Tax Credit), and category breakdowns.
- **📥 One-Click Export:** Download tidy CSV formatted with Excel UTF-8 BOM or export raw JSON.
- **🌓 Dark & Light Mode:** Curated financial slate and emerald theme with automatic system preference detection.

---

## Quickstart

### Prerequisites
1. Install [Ollama](https://ollama.com).
2. Pull the recommended lightweight model (~1 GB):
   ```bash
   ollama pull qwen2.5:1.5b
   ```

### 1. Allow Browser Access to Ollama (CORS)
Ollama needs to accept HTTP requests from your browser:

- **Windows (PowerShell):**
  ```powershell
  setx OLLAMA_ORIGINS "*"
  ```
  *(Restart Ollama from the system tray or terminal after running this)*

- **macOS / Linux:**
  ```bash
  OLLAMA_ORIGINS="*" ollama serve
  ```

### 2. Serve and Open LocalLedger
In the project folder, start any local HTTP server:

```bash
# Python 3 / py launcher:
py -m http.server 8080
# or:
python -m http.server 8080
# or Node:
npx serve -l 8080
```

Open **`http://localhost:8080`** in your browser.

> **Note on Port 8000:** If port 8000 is occupied by another local service on your machine, using port 8080 or 5000 avoids port collisions.

---

## File Structure

| File | Purpose |
|---|---|
| `index.html` | Semantic, accessible UI with drag-and-drop zone, metric cards, preview modal, and controls |
| `style.css` | Modern financial UI design system with dark/light mode, glassmorphism, and responsive tables |
| `app.js` | In-browser file loader, PDF text layer extractor, Tesseract OCR runner, Ollama caller, safe merge logic, and CSV exporter |
| `extract.js` | Isomorphic rule-based extractor (usable in browser and in Node.js for CLI/unit testing) |
| `samples/` | Sample test receipt images (`sample-swiggy-meal.png`, `sample-uber-ride.png`, `sample-hardware-croma.png`) |

---

## Testing & Verification

You can verify the rule extraction and Ollama local model pipeline via Node.js:

```bash
node -e "const { extract } = require('./extract.js'); console.log(extract('Bundl Technologies (Swiggy)\nDate: 12/10/2026\nGSTIN: 29AABCB1234F1Z5\nGrand Total: 472.50'));"
```

---

## License & Notes

- **Dates:** Read as day-first (`13/10/2026` = October 13, 2026).
- **GST Taxes:** Automatically computes combined CGST + SGST + IGST for accurate Input Tax Credit (ITC) claiming.
- This application is an open-source productivity helper for freelancers, not professional tax advice. Always review your ledger before filing.
