/* LocalLedger - app.js
 * Workflow:
 * 1. Read file: Multi-page text layer extraction for digital PDFs, or Tesseract.js WASM OCR for photos/scans.
 * 2. Deterministic Rules: Regex parsing for Day-First Dates, Indian GSTINs, Totals, and Combined GST (CGST+SGST+IGST).
 * 3. Local AI Layer (Ollama): Small on-device model (qwen2.5:1.5b) refines structure without cloud transmission.
 * 4. Hallucination Guardrail: LLM amounts are rejected if figures do not appear in the scanned OCR text.
 * 5. Interactive Verification & Export: In-place editable ledger table, preview modal, CSV & JSON download.
 */
(function () {
  "use strict";

  const CATEGORIES = (window.Extract && window.Extract.CATEGORIES) || [
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

  const $ = (id) => document.getElementById(id);
  const els = {
    drop: $("drop"),
    file: $("file"),
    rows: $("rows"),
    empty: $("empty"),
    btnCSV: $("btnCSV"),
    btnJSON: $("btnJSON"),
    btnClear: $("btnClear"),
    btnSampleInvoices: $("btnSampleInvoices"),
    searchDocs: $("searchDocs"),
    filterCategory: $("filterCategory"),
    filterWarnings: $("filterWarnings"),
    statTotalSpend: $("statTotalSpend"),
    statTotalGST: $("statTotalGST"),
    statDocCount: $("statDocCount"),
    statStatusBreakdown: $("statStatusBreakdown"),
    statAttentionCount: $("statAttentionCount"),
    statSubtextSpend: $("statSubtextSpend"),
    categoryPillsBar: $("categoryPillsBar"),
    categoryEmpty: $("categoryEmpty"),
    dot: $("dot"),
    statusText: $("statusText"),
    statusPill: $("statusPill"),
    themeToggle: $("themeToggle"),
    themeIcon: $("themeIcon"),
    btnSettings: $("btnSettings"),
    modalSettings: $("modalSettings"),
    btnCloseSettings: $("btnCloseSettings"),
    modalPreview: $("modalPreview"),
    btnClosePreview: $("btnClosePreview"),
    previewMedia: $("previewMedia"),
    previewData: $("previewData"),
    host: $("host"),
    modelSelect: $("modelSelect"),
    btnRefreshModels: $("btnRefreshModels"),
    useLLM: $("useLLM")
  };

  // Configure PDF.js Worker
  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }

  // State
  const docs = []; // Array of document objects
  let nextId = 1;
  let ocrWorker = null;
  let queue = Promise.resolve();
  let previewDoc = null;

  /* ---------- Theme Handling ---------- */
  function initTheme() {
    const saved = localStorage.getItem("localledger_theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const theme = saved || (prefersDark ? "dark" : "light");
    document.documentElement.setAttribute("data-theme", theme);
    els.themeIcon.textContent = theme === "dark" ? "☀️" : "🌙";
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme") || "dark";
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("localledger_theme", next);
    els.themeIcon.textContent = next === "dark" ? "☀️" : "🌙";
  }

  /* ---------- Category Filter Options ---------- */
  function initCategoryOptions() {
    els.filterCategory.innerHTML = '<option value="">All Categories</option>';
    CATEGORIES.forEach((cat) => {
      const opt = document.createElement("option");
      opt.value = cat;
      opt.textContent = cat;
      els.filterCategory.appendChild(opt);
    });
  }

  /* ---------- Ollama Service Check & Model Discovery ---------- */
  function host() {
    return els.host.value.trim().replace(/\/$/, "");
  }

  function selectedModel() {
    return els.modelSelect.value.trim();
  }

  async function checkOllama() {
    setStatus("checking", "Connecting to Ollama…");
    try {
      const r = await fetch(host() + "/api/tags", { method: "GET" });
      if (!r.ok) throw new Error("Status " + r.status);
      const data = await r.json();
      const models = data.models || [];
      const modelNames = models.map((m) => m.name);

      // Populate model dropdown
      const currVal = els.modelSelect.value;
      els.modelSelect.innerHTML = "";
      if (modelNames.length === 0) {
        const o = document.createElement("option");
        o.value = "qwen2.5:1.5b";
        o.textContent = "qwen2.5:1.5b (Not yet pulled)";
        els.modelSelect.appendChild(o);
      } else {
        modelNames.forEach((name) => {
          const opt = document.createElement("option");
          opt.value = name;
          opt.textContent = name;
          if (name === currVal || name.startsWith(currVal) || name.startsWith("qwen2.5:1.5b")) {
            opt.selected = true;
          }
          els.modelSelect.appendChild(opt);
        });
      }

      const activeModel = els.modelSelect.value;
      setStatus("ok", "Ollama connected (" + activeModel + ")");
    } catch (e) {
      setStatus("off", "Local AI disconnected — Using Rules Only");
    }
  }

  function setStatus(kind, text) {
    els.dot.className = "status-dot " + kind;
    els.statusText.textContent = text;
  }

  /* ---------- Ollama Inference with Strict Structured Output ---------- */
  async function askLLM(rawText) {
    const prompt =
      "You are a precision financial parser reading OCR text from one Indian invoice or receipt. " +
      "Return ONLY valid JSON matching this schema:\n" +
      JSON.stringify({
        vendor: "Company or Merchant Name",
        invoice_number: "Invoice or Bill identifier",
        date: "YYYY-MM-DD",
        gstin: "15-character GSTIN",
        gst_amount: 0.0,
        total: 0.0,
        category: "one of " + JSON.stringify(CATEGORIES)
      }) +
      "\nRules:\n" +
      "1. Dates in the text are day-first (e.g. 12/10/2026 -> 2026-10-12).\n" +
      "2. total is the final net payable / grand total amount paid.\n" +
      "3. gst_amount is the combined tax (CGST + SGST or IGST). If not itemized, use null.\n" +
      "4. DO NOT invent or extrapolate figures. Use null or empty string if not found.\n\n" +
      "RAW TEXT:\n" +
      rawText.slice(0, 3500);

    const r = await fetch(host() + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: selectedModel(),
        stream: false,
        format: "json",
        options: { temperature: 0, num_ctx: 4096 },
        messages: [{ role: "user", content: prompt }]
      })
    });

    if (!r.ok) throw new Error("Ollama returned status " + r.status);
    const data = await r.json();
    return JSON.parse(data.message.content);
  }

  /* ---------- OCR & Document Extraction ---------- */
  async function getWorker(progressCallback) {
    if (!ocrWorker) {
      ocrWorker = await Tesseract.createWorker("eng", 1, {
        logger: (m) => {
          if (progressCallback && m.status === "recognizing text" && typeof m.progress === "number") {
            progressCallback(Math.round(m.progress * 100));
          }
        }
      });
    }
    return ocrWorker;
  }

  async function ocrImage(source, progressCallback) {
    const w = await getWorker(progressCallback);
    const res = await w.recognize(source);
    return res.data.text || "";
  }

  async function textFromPdf(file, doc) {
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    let out = "";
    const pages = Math.min(pdf.numPages, 3);

    for (let i = 1; i <= pages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const lines = {};
      content.items.forEach((it) => {
        const y = Math.round(it.transform[5]);
        (lines[y] = lines[y] || []).push(it);
      });
      Object.keys(lines)
        .map(Number)
        .sort((a, b) => b - a)
        .forEach((y) => {
          out += lines[y].sort((a, b) => a.transform[4] - b.transform[4]).map((i) => i.str).join(" ") + "\n";
        });
    }

    // If PDF contains a rich digital text layer, return directly
    if (out.replace(/\s/g, "").length > 40) {
      doc.previewType = "pdf-text";
      return out;
    }

    // Otherwise, this is a scanned/rasterized PDF: render Page 1 to canvas and run OCR
    doc.status = "Rendering PDF scan…";
    render();
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: viewport }).promise;

    doc.renderedCanvas = canvas;
    doc.previewType = "canvas";
    return ocrImage(canvas, (pct) => {
      doc.status = `OCR Scanning (${pct}%)`;
      render();
    });
  }

  async function readFile(doc) {
    const file = doc.file;
    if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
      return textFromPdf(file, doc);
    }

    // Image file
    doc.previewType = "image";
    return ocrImage(file, (pct) => {
      doc.status = `OCR Scanning (${pct}%)`;
      render();
    });
  }

  /* ---------- Data Cleansing & Safeguards ---------- */
  function cleanAmount(v) {
    if (v == null || v === "") return null;
    const n = typeof v === "number" ? v : Extract.parseAmount(v);
    return n != null && isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
  }

  function cleanDate(v) {
    return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "";
  }

  function merge(rule, llm, rawText) {
    const out = Object.assign({}, rule);
    out.how = "Rules Only";

    if (!llm) return out;

    out.how = "AI + Rules";

    // Vendor: accept LLM if non-empty, otherwise retain rule
    if (typeof llm.vendor === "string" && llm.vendor.trim()) {
      out.vendor = llm.vendor.trim();
    }

    // Invoice number: accept LLM if valid
    if (typeof llm.invoice_number === "string" && llm.invoice_number.trim()) {
      out.invoice_number = llm.invoice_number.trim();
    }

    // Date: accept if valid ISO
    const d = cleanDate(llm.date);
    if (d) out.date = d;

    // GSTIN format check
    if (typeof llm.gstin === "string" && /^\d{2}[A-Z0-9]{13}$/i.test(llm.gstin.trim())) {
      out.gstin = llm.gstin.trim().toUpperCase();
    }

    // Number Guardrail: Verify figures actually occur in the raw OCR text
    const flat = rawText.replace(/,/g, "");
    const seen = (n) =>
      n != null &&
      (flat.indexOf(n.toFixed(2)) !== -1 ||
        flat.indexOf(String(n)) !== -1 ||
        flat.indexOf(String(Math.round(n))) !== -1);

    // Total Amount
    const llmTotal = cleanAmount(llm.total);
    const ruleTotal = cleanAmount(rule.total);
    if (llmTotal != null && seen(llmTotal)) {
      out.total = llmTotal;
    } else if (ruleTotal != null) {
      out.total = ruleTotal;
    }

    // GST Amount Safeguard:
    // If rule accurately summed CGST + SGST (e.g. 11.25 + 11.25 = 22.50), do not let
    // a single component from the LLM override the complete tax sum!
    const ruleGst = cleanAmount(rule.gst_amount);
    const llmGst = cleanAmount(llm.gst_amount);

    if (ruleGst != null && llmGst != null) {
      if (ruleGst >= llmGst) {
        out.gst_amount = ruleGst;
      } else if (seen(llmGst)) {
        out.gst_amount = llmGst;
      }
    } else if (llmGst != null && seen(llmGst)) {
      out.gst_amount = llmGst;
    } else if (ruleGst != null) {
      out.gst_amount = ruleGst;
    }

    // Category
    if (CATEGORIES.indexOf(llm.category) !== -1) {
      out.category = llm.category;
    }

    return out;
  }

  async function processDoc(doc) {
    try {
      doc.status = "Reading Document…";
      render();

      const text = await readFile(doc);
      doc.rawText = text;

      if (text.replace(/\s/g, "").length < 10) {
        throw new Error("No readable text found. Image may be blurry or blank.");
      }

      doc.status = "Analyzing with Rules…";
      render();

      const rule = Extract.extract(text);
      let llm = null;

      if (els.useLLM.checked) {
        doc.status = "Consulting Local AI…";
        render();
        try {
          llm = await askLLM(text);
        } catch (e) {
          console.warn("Local AI inference bypassed:", e);
          llm = null;
        }
      }

      Object.assign(doc, merge(rule, llm, text));
      doc.status = "done";
    } catch (e) {
      doc.status = "error";
      doc.how = String(e.message || e);
    }
    render();
  }

  function addFiles(fileList) {
    Array.from(fileList).forEach((f) => {
      const doc = {
        id: nextId++,
        file: f,
        status: "Queued",
        how: "",
        vendor: "",
        invoice_number: "",
        date: "",
        gstin: "",
        gst_amount: null,
        total: null,
        category: "Other",
        rawText: "",
        objectUrl: URL.createObjectURL(f)
      };
      docs.push(doc);
      queue = queue.then(() => processDoc(doc));
    });
    render();
  }

  /* ---------- Sample Invoices Generator / Loader ---------- */
  async function loadSampleInvoices() {
    const samples = [
      { name: "sample-swiggy-meal.png", path: "samples/sample-swiggy-meal.png" },
      { name: "sample-uber-ride.png", path: "samples/sample-uber-ride.png" },
      { name: "sample-hardware-croma.png", path: "samples/sample-hardware-croma.png" }
    ];

    try {
      const filePromises = samples.map(async (s) => {
        const res = await fetch(s.path);
        if (!res.ok) throw new Error("Could not fetch " + s.path);
        const blob = await res.blob();
        return new File([blob], s.name, { type: "image/png" });
      });

      const loadedFiles = await Promise.all(filePromises);
      addFiles(loadedFiles);
    } catch (err) {
      console.warn("Fetch failed, generating synthetic canvas samples:", err);
      // Fallback: Generate sample images client-side via canvas
      generateCanvasSampleFiles();
    }
  }

  function generateCanvasSampleFiles() {
    const sampleReceipts = [
      {
        name: "sample-swiggy-meal.png",
        lines: [
          "TAX INVOICE",
          "Bundl Technologies Pvt Ltd (Swiggy)",
          "GSTIN: 29AABCB1234F1Z5",
          "Invoice No: SW-2026-9912",
          "Date: 12/10/2026",
          "Item: Healthy Meal & Drink",
          "Subtotal: 450.00",
          "CGST: 11.25",
          "SGST: 11.25",
          "Grand Total: Rs 472.50"
        ]
      },
      {
        name: "sample-uber-ride.png",
        lines: [
          "TRIP RECEIPT - UBER",
          "Uber India Systems Pvt Ltd",
          "GSTIN: 27AAACU9329L1ZQ",
          "Receipt No: UBR-IN-88231",
          "Date: 10/10/2026",
          "Trip Fare: 320.00",
          "IGST (5%): 16.00",
          "Total Amount: Rs 336.00"
        ]
      },
      {
        name: "sample-hardware-croma.png",
        lines: [
          "RETAIL TAX INVOICE",
          "Infiniti Retail Ltd - Croma",
          "GSTIN: 29AABCI2893K1Z4",
          "Invoice No: CR-2026-4410",
          "Date: 08/10/2026",
          "Logitech MX Master Mouse",
          "Subtotal: 7194.92",
          "CGST: 647.54",
          "SGST: 647.54",
          "Total Payable: Rs 8490.00"
        ]
      }
    ];

    const generated = sampleReceipts.map((spec) => {
      const c = document.createElement("canvas");
      c.width = 600;
      c.height = 450;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, c.width, c.height);

      ctx.strokeStyle = "#333333";
      ctx.lineWidth = 3;
      ctx.strokeRect(15, 15, c.width - 30, c.height - 30);

      ctx.fillStyle = "#000000";
      ctx.font = "bold 20px monospace";
      let y = 50;
      spec.lines.forEach((line) => {
        ctx.fillText(line, 35, y);
        y += 36;
      });

      return new Promise((resolve) => {
        c.toBlob((blob) => {
          resolve(new File([blob], spec.name, { type: "image/png" }));
        }, "image/png");
      });
    });

    Promise.all(generated).then(addFiles);
  }

  /* ---------- Table Rendering & Filtering ---------- */
  function inputCell(doc, key, cls, type) {
    const td = document.createElement("td");
    if (cls) td.className = cls;

    const inp = document.createElement("input");
    inp.type = type || "text";
    if (type === "number") {
      inp.step = "0.01";
      inp.placeholder = "0.00";
    }

    const v = doc[key];
    inp.value = v == null ? "" : v;

    inp.addEventListener("input", () => {
      doc[key] = type === "number" ? (inp.value === "" ? null : parseFloat(inp.value)) : inp.value;
      if (doc.how.indexOf("Edited") === -1) {
        doc.how += " (Edited)";
      }
      renderSummary();
    });

    td.appendChild(inp);
    return td;
  }

  function render() {
    els.rows.innerHTML = "";

    const query = (els.searchDocs.value || "").trim().toLowerCase();
    const filterCat = els.filterCategory.value;
    const filterWarn = els.filterWarnings.checked;

    const filtered = docs.filter((doc) => {
      if (query) {
        const fName = (doc.file.name || "").toLowerCase();
        const vendor = (doc.vendor || "").toLowerCase();
        const inv = (doc.invoice_number || "").toLowerCase();
        if (!fName.includes(query) && !vendor.includes(query) && !inv.includes(query)) {
          return false;
        }
      }

      if (filterCat && doc.category !== filterCat) {
        return false;
      }

      if (filterWarn && doc.status === "done" && (doc.total != null && doc.date)) {
        return false;
      }

      return true;
    });

    filtered.forEach((doc) => {
      const tr = document.createElement("tr");

      if (doc.status !== "done" && doc.status !== "error") {
        tr.className = "row-working";
      } else if (doc.status === "done" && (doc.total == null || !doc.date)) {
        tr.className = "row-warn";
      }

      // Column 1: Document Filename & Preview Icon
      const tdFile = document.createElement("td");
      const fileWrap = document.createElement("div");
      fileWrap.className = "cell-file-wrap";

      const iconBadge = document.createElement("div");
      iconBadge.className = "file-icon-badge";
      iconBadge.textContent = doc.file.type.includes("pdf") ? "📄" : "🖼️";

      const nameSpan = document.createElement("span");
      nameSpan.className = "file-name-text";
      nameSpan.textContent = doc.file.name;
      nameSpan.title = doc.file.name;

      fileWrap.appendChild(iconBadge);
      fileWrap.appendChild(nameSpan);
      tdFile.appendChild(fileWrap);
      tr.appendChild(tdFile);

      // Processing state or Data inputs
      if (doc.status !== "done") {
        const tdColspan = document.createElement("td");
        tdColspan.colSpan = 8;

        if (doc.status === "error") {
          tdColspan.innerHTML = `<span style="color: var(--accent-rose); font-size: 13px;">❌ Error: ${doc.how}</span>`;
        } else {
          tdColspan.innerHTML = `
            <div class="processing-indicator">
              <div class="spinner"></div>
              <span>${doc.status}</span>
            </div>
          `;
        }
        tr.appendChild(tdColspan);
      } else {
        // Vendor
        tr.appendChild(inputCell(doc, "vendor"));

        // Invoice Number
        tr.appendChild(inputCell(doc, "invoice_number"));

        // Date
        tr.appendChild(inputCell(doc, "date", "", "date"));

        // GSTIN
        tr.appendChild(inputCell(doc, "gstin"));

        // GST Amount
        tr.appendChild(inputCell(doc, "gst_amount", "cell-num", "number"));

        // Total
        tr.appendChild(inputCell(doc, "total", "cell-num", "number"));

        // Category dropdown
        const tdCat = document.createElement("td");
        const sel = document.createElement("select");
        CATEGORIES.forEach((c) => {
          const opt = document.createElement("option");
          opt.value = c;
          opt.textContent = c;
          if (c === doc.category) opt.selected = true;
          sel.appendChild(opt);
        });
        sel.addEventListener("change", () => {
          doc.category = sel.value;
          renderSummary();
        });
        tdCat.appendChild(sel);
        tr.appendChild(tdCat);

        // Method badge
        const tdHow = document.createElement("td");
        const isAI = doc.how.indexOf("AI") !== -1;
        tdHow.innerHTML = `
          <span class="method-badge ${isAI ? "ai" : "rules"}" title="${doc.how}">
            ${isAI ? "⚡ AI + Rules" : "📐 Rules"}
          </span>
        `;
        tr.appendChild(tdHow);
      }

      // Actions Column (Preview & Delete)
      const tdActions = document.createElement("td");
      tdActions.style.textAlign = "center";

      const btnPreview = document.createElement("button");
      btnPreview.className = "btn-action-icon";
      btnPreview.textContent = "👁️";
      btnPreview.title = "Inspect document & OCR text";
      btnPreview.addEventListener("click", () => openPreviewModal(doc));

      const btnDel = document.createElement("button");
      btnDel.className = "btn-action-icon delete";
      btnDel.textContent = "🗑️";
      btnDel.title = "Remove item";
      btnDel.addEventListener("click", () => {
        const idx = docs.indexOf(doc);
        if (idx !== -1) {
          if (doc.objectUrl) URL.revokeObjectURL(doc.objectUrl);
          docs.splice(idx, 1);
          render();
        }
      });

      tdActions.appendChild(btnPreview);
      tdActions.appendChild(btnDel);
      tr.appendChild(tdActions);

      els.rows.appendChild(tr);
    });

    els.empty.style.display = docs.length === 0 ? "flex" : "none";

    const hasDone = docs.some((d) => d.status === "done");
    els.btnCSV.disabled = !hasDone;
    els.btnJSON.disabled = !hasDone;
    els.btnClear.disabled = docs.length === 0;

    renderSummary();
  }

  function fmtINR(val) {
    return "₹" + (val || 0).toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function renderSummary() {
    const done = docs.filter((d) => d.status === "done");
    const working = docs.filter((d) => d.status !== "done" && d.status !== "error");
    const attention = done.filter((d) => d.total == null || !d.date);

    const totalSpend = done.reduce((sum, d) => sum + (d.total || 0), 0);
    const totalGST = done.reduce((sum, d) => sum + (d.gst_amount || 0), 0);

    els.statTotalSpend.textContent = fmtINR(totalSpend);
    els.statSubtextSpend.textContent = `From ${done.length} completed document${done.length === 1 ? "" : "s"}`;
    els.statTotalGST.textContent = fmtINR(totalGST);
    els.statDocCount.textContent = docs.length;
    els.statStatusBreakdown.textContent = `${working.length} in progress • ${done.length} done`;
    els.statAttentionCount.textContent = attention.length;

    // Category breakdown bar
    const byCat = {};
    done.forEach((d) => {
      byCat[d.category] = (byCat[d.category] || 0) + (d.total || 0);
    });

    const catKeys = Object.keys(byCat).sort((a, b) => byCat[b] - byCat[a]);
    if (catKeys.length === 0) {
      els.categoryEmpty.style.display = "inline";
      Array.from(els.categoryPillsBar.querySelectorAll(".cat-pill")).forEach((p) => p.remove());
    } else {
      els.categoryEmpty.style.display = "none";
      Array.from(els.categoryPillsBar.querySelectorAll(".cat-pill")).forEach((p) => p.remove());
      catKeys.forEach((cat) => {
        const pill = document.createElement("span");
        pill.className = "cat-pill";
        pill.innerHTML = `<span>${cat}</span><b>${fmtINR(byCat[cat])}</b>`;
        els.categoryPillsBar.appendChild(pill);
      });
    }
  }

  /* ---------- Document Preview Modal ---------- */
  function openPreviewModal(doc) {
    previewDoc = doc;
    els.previewMedia.innerHTML = "";
    els.previewData.innerHTML = "";

    // Left pane: Display rendered canvas or image
    if (doc.renderedCanvas) {
      els.previewMedia.appendChild(doc.renderedCanvas);
    } else if (doc.file && doc.file.type.startsWith("image/")) {
      const img = document.createElement("img");
      img.src = doc.objectUrl || URL.createObjectURL(doc.file);
      els.previewMedia.appendChild(img);
    } else {
      const placeholder = document.createElement("div");
      placeholder.style.color = "var(--text-muted)";
      placeholder.style.padding = "20px";
      placeholder.textContent = "Digital PDF (Text Layer Extracted Directly)";
      els.previewMedia.appendChild(placeholder);
    }

    // Right pane: Extracted fields side-by-side
    const fields = [
      { label: "File Name", val: doc.file.name },
      { label: "Vendor", val: doc.vendor || "—" },
      { label: "Invoice Number", val: doc.invoice_number || "—" },
      { label: "Date", val: doc.date || "—" },
      { label: "GSTIN", val: doc.gstin || "—" },
      { label: "GST (CGST+SGST+IGST)", val: doc.gst_amount != null ? fmtINR(doc.gst_amount) : "—" },
      { label: "Total Payable", val: doc.total != null ? fmtINR(doc.total) : "—" },
      { label: "Category", val: doc.category || "—" },
      { label: "Extraction Pipeline", val: doc.how || "—" }
    ];

    let html = `<div style="display: flex; flex-direction: column; gap: 8px;">`;
    fields.forEach((f) => {
      html += `
        <div style="display: flex; justify-content: space-between; border-bottom: 1px solid var(--border-subtle); padding-bottom: 4px; font-size: 13px;">
          <span style="color: var(--text-muted); font-weight: 500;">${f.label}</span>
          <span style="font-weight: 600; text-align: right; max-width: 200px; overflow: hidden; text-overflow: ellipsis;">${f.val}</span>
        </div>
      `;
    });

    html += `
      <details style="margin-top: 10px; font-size: 12px;">
        <summary style="cursor: pointer; color: var(--accent-emerald);">Show Raw OCR Scanned Text</summary>
        <pre style="margin-top: 8px; background: var(--bg-input); padding: 10px; border-radius: 6px; max-height: 160px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; color: var(--text-muted); font-family: var(--font-mono);">${doc.rawText || "No text available"}</pre>
      </details>
    </div>`;

    els.previewData.innerHTML = html;
    els.modalPreview.classList.add("open");
  }

  function closeModals() {
    els.modalSettings.classList.remove("open");
    els.modalPreview.classList.remove("open");
  }

  /* ---------- CSV & JSON Export ---------- */
  function csvCell(v) {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function downloadCSV() {
    const headers = [
      "File",
      "Vendor",
      "Invoice Number",
      "Date",
      "GSTIN",
      "GST Amount (INR)",
      "Total Amount (INR)",
      "Category",
      "Extraction Method"
    ];

    const lines = [headers.join(",")];
    docs
      .filter((d) => d.status === "done")
      .forEach((d) => {
        lines.push(
          [
            d.file.name,
            d.vendor,
            d.invoice_number,
            d.date,
            d.gstin,
            d.gst_amount != null ? d.gst_amount : "",
            d.total != null ? d.total : "",
            d.category,
            d.how
          ]
            .map(csvCell)
            .join(",")
        );
      });

    // Add Excel UTF-8 Byte Order Mark (\uFEFF)
    const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "localledger-expenses-" + new Date().toISOString().slice(0, 10) + ".csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function downloadJSON() {
    const data = docs
      .filter((d) => d.status === "done")
      .map((d) => ({
        fileName: d.file.name,
        vendor: d.vendor,
        invoiceNumber: d.invoice_number,
        date: d.date,
        gstin: d.gstin,
        gstAmount: d.gst_amount,
        total: d.total,
        category: d.category,
        extractionMethod: d.how
      }));

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "localledger-ledger-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ---------- Event Listeners ---------- */
  els.drop.addEventListener("click", () => els.file.click());
  els.drop.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      els.file.click();
    }
  });

  els.file.addEventListener("change", () => {
    if (els.file.files.length) {
      addFiles(els.file.files);
      els.file.value = "";
    }
  });

  ["dragenter", "dragover"].forEach((ev) => {
    els.drop.addEventListener(ev, (e) => {
      e.preventDefault();
      els.drop.classList.add("drag-active");
    });
  });

  ["dragleave", "drop"].forEach((ev) => {
    els.drop.addEventListener(ev, (e) => {
      e.preventDefault();
      els.drop.classList.remove("drag-active");
    });
  });

  els.drop.addEventListener("drop", (e) => {
    if (e.dataTransfer.files.length) {
      addFiles(e.dataTransfer.files);
    }
  });

  els.btnSampleInvoices.addEventListener("click", loadSampleInvoices);
  els.btnCSV.addEventListener("click", downloadCSV);
  els.btnJSON.addEventListener("click", downloadJSON);

  els.btnClear.addEventListener("click", () => {
    if (confirm("Are you sure you want to clear all imported documents?")) {
      docs.forEach((d) => {
        if (d.objectUrl) URL.revokeObjectURL(d.objectUrl);
      });
      docs.length = 0;
      render();
    }
  });

  els.searchDocs.addEventListener("input", render);
  els.filterCategory.addEventListener("change", render);
  els.filterWarnings.addEventListener("change", render);

  els.themeToggle.addEventListener("click", toggleTheme);

  els.statusPill.addEventListener("click", () => {
    els.modalSettings.classList.add("open");
  });

  els.btnSettings.addEventListener("click", () => {
    els.modalSettings.classList.add("open");
  });

  els.btnCloseSettings.addEventListener("click", closeModals);
  els.btnClosePreview.addEventListener("click", closeModals);

  els.modalSettings.addEventListener("click", (e) => {
    if (e.target === els.modalSettings) closeModals();
  });

  els.modalPreview.addEventListener("click", (e) => {
    if (e.target === els.modalPreview) closeModals();
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModals();
  });

  els.host.addEventListener("change", checkOllama);
  els.btnRefreshModels.addEventListener("click", checkOllama);
  els.modelSelect.addEventListener("change", checkOllama);

  // Initialization
  initTheme();
  initCategoryOptions();
  render();
  checkOllama();
})();
