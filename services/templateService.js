"use strict";
const Handlebars = require("handlebars");
const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const qrCodeService = require("./qrCodeService");
const QRCode = require("qrcode");

// ── Currency symbols ───────────────────────────────────────
const CURRENCY_SYMBOLS = {
  AED: "AED",
  USD: "$",
  EUR: "€",
  GBP: "£",
  QAR: "QAR",
  KWD: "KWD",
  BHD: "BHD",
  OMR: "OMR",
  MYR: "RM",
  INR: "₹",
  JPY: "¥",
  CNY: "¥",
  AUD: "A$",
  CAD: "C$",
};

// ── SVG helper — generic loader ────────────────────────────
function findSvgPath(filename) {
  const candidates = [
    path.join(__dirname, "..", "assets", filename),
    path.join(__dirname, "..", "public", "assets", filename),
    path.join(process.cwd(), "src", "assets", filename),
    path.join(process.cwd(), "assets", filename),
  ];
  return (
    candidates.find((p) => {
      try {
        return fsSync.existsSync(p);
      } catch {
        return false;
      }
    }) || null
  );
}

// Ink-tight viewBox per file (measured once by rasterising the artwork). Some
// files are drawn on a padded canvas — sar.svg is a square with ~12% empty on
// each side — which made the glyph occupy more room than a text code like BHD.
// Re-cropping the viewBox at load removes that padding.
const SVG_INK_VIEWBOX = {
  "sar.svg": "31.09 19.62 202.41 225.12",
  // aed.svg is already cropped tight (0 0 184 161)
};

function loadCurrencySvg(filename, fallbackText, height = "0.75em") {
  const svgPath = findSvgPath(filename);
  const result = { inline: "", dataUri: "" };


  if (!svgPath) {
    console.warn(
      `⚠ ${filename} not found. Falling back to text: ${fallbackText}`,
    );
    result.inline = `<span style="font-family:Arial;">${fallbackText}</span>`;
    return result;
  }

  try {
    const raw = fsSync.readFileSync(svgPath, "utf-8");

    const inkViewBox = SVG_INK_VIEWBOX[filename];

    result.inline = raw
      .replace(/<\?xml[^?]*\?>/gi, "")
      .trim()
      .replace(/<svg([^>]*)>/i, (match, attrs) => {
        let cleaned = attrs
          .replace(/\s*width\s*=\s*["'][^"']*["']/gi, "")
          .replace(/\s*height\s*=\s*["'][^"']*["']/gi, "");

        if (inkViewBox) {
          cleaned = cleaned.replace(
            /\s*viewBox\s*=\s*["'][^"']*["']/i,
            ` viewBox="${inkViewBox}"`,
          );
        }

        // margin in em, not px — the gap before the amount then scales with the
        // template's font-size, matching the spacing after a text code.
        return `<svg${cleaned} style="height:${height};width:auto;vertical-align:middle;display:inline-block;margin-right:0.08em;">`;
      });

    result.dataUri = `data:image/svg+xml;base64,${Buffer.from(raw).toString("base64")}`;
    console.log(`✓ ${filename} loaded from: ${svgPath}`);
  } catch (err) {
    console.warn(
      `⚠ Could not read ${filename}: ${err.message}. Falling back to text.`,
    );
    result.inline = `<span style="font-family:Arial;">${fallbackText}</span>`;
  }

  return result;
}

// ── Currency glyph sizing ─────────────────────────────────
// Heights are always in `em`, so a glyph scales with whatever font-size the
// template puts it in — no per-template numbers to keep in sync.
//
// Two measured constants decide the em value (measured by rasterising at
// font-size:100px and reading the ink bounds):
//   TEXT_INK_EM  — height of digits/capitals in the body font (0.73em)
//   SVG_INK_EM   — ink height of each SVG when its box is 1em. Both files are
//                  cropped to their ink at load (see SVG_INK_VIEWBOX), so the
//                  ink fills the box and the factor is 1.
// height = TEXT_INK_EM / SVG_INK_EM makes the glyph's ink the same height as
// the digits next to it.
const TEXT_INK_EM = 0.73;
const SVG_INK_EM = { SAR: 1.0, AED: 1.0 };

const glyphHeight = (iso, targetInkEm = TEXT_INK_EM) =>
  `${+(targetInkEm / (SVG_INK_EM[iso] || 1)).toFixed(3)}em`;

// ── Load SAR + AED SVGs at startup ────────────────────────
let sarSvg = loadCurrencySvg("sar.svg", "SAR", glyphHeight("SAR"));
let aedSvg = loadCurrencySvg("aed.svg", "AED", glyphHeight("AED"));

// Map iso → svg object for easy lookup
const SVG_CURRENCY_MAP = {
  SAR: () => sarSvg,
  AED: () => aedSvg,
};

// ── Bootstrap CSS — loaded once at startup ─────────────────
// Tries multiple path candidates — works on any server structure
// process.cwd() = app root on cPanel (most reliable)
let bootstrapCss = "";

const BOOTSTRAP_FILE = path.join(
  "bootstrap",
  "dist",
  "css",
  "bootstrap.min.css",
);
const bootstrapCandidates = [
  path.join(process.cwd(), "node_modules", BOOTSTRAP_FILE), // cPanel app root ✅
  path.join(__dirname, "..", "..", "node_modules", BOOTSTRAP_FILE), // services/src/root
  path.join(__dirname, "..", "node_modules", BOOTSTRAP_FILE), // src/root
  path.join(__dirname, "..", "..", "..", "node_modules", BOOTSTRAP_FILE), // deep nesting
  path.join(__dirname, "node_modules", BOOTSTRAP_FILE), // same folder
];

for (const candidate of bootstrapCandidates) {
  try {
    if (fsSync.existsSync(candidate)) {
      bootstrapCss = fsSync.readFileSync(candidate, "utf-8");
      console.log(
        "[Bootstrap] ✓ Loaded from:",
        candidate,
        "| Length:",
        bootstrapCss.length,
      );
      break;
    }
  } catch (err) {
    // try next candidate
  }
}

if (!bootstrapCss) {
  console.warn("[Bootstrap] ✗ Not found. Run: npm install bootstrap");
  console.warn("[Bootstrap] Tried paths:", bootstrapCandidates);
}

// ── IBM Plex Sans Arabic fonts — loaded once at startup ────
// Embedded as base64 @font-face so `font-family: ibmplexsansarabic` works in
// Puppeteer/Lambda (no system font install needed, no external request).
function loadFontBase64(filename) {
  const p = findSvgPath(filename); // searches assets/ (and other candidates)
  if (!p) {
    console.warn(`[Fonts] ✗ ${filename} not found`);
    return "";
  }
  try {
    return fsSync.readFileSync(p).toString("base64");
  } catch (err) {
    console.warn(`[Fonts] ✗ Could not read ${filename}: ${err.message}`);
    return "";
  }
}

const ibmRegularB64 = loadFontBase64("IBMPlexSansArabic-Regular.ttf");
const ibmBoldB64 = loadFontBase64("IBMPlexSansArabic-Bold.ttf");

let fontFaceCss = "";
{
  const faces = [];
  if (ibmRegularB64) {
    faces.push(
      `@font-face{font-family:'ibmplexsansarabic';font-style:normal;font-weight:400;` +
        `src:url(data:font/ttf;base64,${ibmRegularB64}) format('truetype');}`,
    );
  }
  if (ibmBoldB64) {
    faces.push(
      `@font-face{font-family:'ibmplexsansarabic';font-style:normal;font-weight:700;` +
        `src:url(data:font/ttf;base64,${ibmBoldB64}) format('truetype');}`,
    );
  }
  fontFaceCss = faces.join("");
  if (fontFaceCss) {
    console.log(
      `[Fonts] ✓ IBM Plex Sans Arabic loaded (reg:${ibmRegularB64.length}, bold:${ibmBoldB64.length} b64 chars)`,
    );
  } else {
    console.warn("[Fonts] ✗ IBM Plex Sans Arabic not loaded — check assets/");
  }
}

// "The Coastal" script font (Thank You text). Only embedded into pages that
// reference `font-family: thecoastal`, so other PDFs don't carry the extra weight.
const coastalB64 = loadFontBase64("TheCoastal.ttf");
const coastalFaceCss = coastalB64
  ? `@font-face{font-family:'thecoastal';font-style:normal;font-weight:400;` +
    `src:url(data:font/ttf;base64,${coastalB64}) format('truetype');}`
  : "";

// Inject the @font-face CSS into a rendered HTML string's <head>.
function injectFonts(html) {
  const css =
    fontFaceCss + (coastalFaceCss && html.includes("thecoastal") ? coastalFaceCss : "");
  if (!css) return html;
  const style = `<style>${css}</style>`;
  if (html.includes("</head>")) return html.replace("</head>", `${style}</head>`);
  return style + html;
}

class TemplateService {
  constructor() {
    this.compiledTemplates = new Map();
    this.registerHelpers();
    this.registerPartials();
  }

  // ── PARTIALS ──────────────────────────────────────────────
  registerPartials() {
    const partialsDir = path.join(__dirname, "..", "templates", "partials");
    try {
      if (fsSync.existsSync(partialsDir)) {

        fsSync.readdirSync(partialsDir)
          .filter(f => f.endsWith('.hbs'))
          .forEach(file => {
            const name = file.replace('.hbs', '');
            const source = fsSync.readFileSync(path.join(partialsDir, file), 'utf-8');
            Handlebars.registerPartial(name, source);
            console.log(`Partial registered: ${name}`);
          });
      }
    } catch (err) {
      console.warn("Could not load partials directory:", err.message);
    }
  }

  // ── HELPERS ───────────────────────────────────────────────
  registerHelpers() {
    // ── Date / Currency formatting ─────────────────────────

    Handlebars.registerHelper('formatDate', function (dateStr) {
      if (!dateStr) return '----';
      try {
        const d = new Date(dateStr);
        return d
          .toLocaleDateString("en-GB", {
            day: "2-digit",
            month: "short",
            year: "numeric",
          })
          .replace(/ /g, "-");
      } catch {
        return dateStr;
      }
    });

    Handlebars.registerHelper("formatCurrency", function (value) {
      if (typeof value !== "number") value = parseFloat(value) || 0;
      return value.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    });

    Handlebars.registerHelper("formatAmount", function (value, decimals) {
      const dp = typeof decimals === "number" ? decimals : 2;
      const num = parseFloat(String(value || "0").replace(/,/g, "")) || 0;
      return num.toLocaleString("en-US", {

        minimumFractionDigits: dp,
        maximumFractionDigits: dp,
      });
    });

    // ── String helpers ─────────────────────────────────────
    Handlebars.registerHelper("upper", (str) => (str ? str.toUpperCase() : ""));
    Handlebars.registerHelper("default", (v, d) => v || d);

    // ── Fullwidth / CJK punctuation → ASCII ────────────────
    // Clients paste part descriptions containing fullwidth forms (U+FF01-FF5E)
    // and CJK punctuation, e.g. "Lower bumper grille，LEFT" with U+FF0C. The
    // only font the PDF is guaranteed to have is the injected IBM Plex Sans
    // Arabic, which has no Fullwidth Forms block, so those characters print as
    // tofu boxes. Fold them to their ASCII equivalents.
    // Additive helper — opt in per template; nothing existing changes.
    const CJK_PUNCT = {
      "、": ", ", "。": ". ", "〈": "<", "〉": ">",
      "《": "<<", "》": ">>", "「": '"', "」": '"',
      "『": '"', "』": '"', "【": "[", "】": "]",
      "‘": "'", "’": "'", "“": '"', "”": '"',
      "　": " ",
    };
    Handlebars.registerHelper("asciiPunct", function (text) {
      if (text === null || text === undefined || text === "") return "";
      return String(text)
        // Fullwidth ASCII block maps 1:1 onto U+0021-007E
        .replace(/[！-～]/g, (ch) =>
          String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
        )
        .replace(/[、。〈-】　‘’“”]/g,
          (ch) => CJK_PUNCT[ch] || ch);
    });
    Handlebars.registerHelper("json", (ctx) => JSON.stringify(ctx, null, 2));
    Handlebars.registerHelper("nl2br", (text) =>
      text ? new Handlebars.SafeString(text.replace(/\n/g, "<br/>")) : "",
    );
    //Handlebars.registerHelper('nl2br', (text) => { if (!text) return ''; new Handlebars.SafeString(text.replace(/\r\n|\n|\r/g, '<br/>'));});

    // ── Comparison helpers ─────────────────────────────────
    Handlebars.registerHelper("eq", (a, b) => a === b);
    Handlebars.registerHelper("neq", (a, b) => a !== b);
    // true when any argument is non-blank, e.g. {{#if (or name vat)}}
    Handlebars.registerHelper("or", (...args) =>
      args.slice(0, -1).some((v) => v !== undefined && v !== null && String(v).trim() !== ""),
    );
    Handlebars.registerHelper(
      "gt",
      (a, b) =>
        (parseFloat(String(a || 0).replace(/,/g, "")) || 0) >
        (parseFloat(String(b || 0).replace(/,/g, "")) || 0),
    );
    Handlebars.registerHelper(
      "lt",
      (a, b) =>
        (parseFloat(String(a || 0).replace(/,/g, "")) || 0) <
        (parseFloat(String(b || 0).replace(/,/g, "")) || 0),
    );

    // ── Math helpers — all strip commas before parsing ─────
    Handlebars.registerHelper(
      "add",
      (a, b) =>
        (parseFloat(String(a || 0).replace(/,/g, "")) || 0) +
        (parseFloat(String(b || 0).replace(/,/g, "")) || 0),

    );
    Handlebars.registerHelper(
      "subtract",
      (a, b) =>
        (parseFloat(String(a || 0).replace(/,/g, "")) || 0) -
        (parseFloat(String(b || 0).replace(/,/g, "")) || 0),
    );
    Handlebars.registerHelper(
      "multiply",
      (a, b) =>
        (parseFloat(String(a || 0).replace(/,/g, "")) || 0) *
        (parseFloat(String(b || 0).replace(/,/g, "")) || 0),
    );
    Handlebars.registerHelper(
      "divide",
      (a, b) =>
        (parseFloat(String(a || 0).replace(/,/g, "")) || 0) /
        (parseFloat(String(b || 1).replace(/,/g, "")) || 1),
    );
    Handlebars.registerHelper(
      "or",
      (a, b) => a || b
    );
    Handlebars.registerHelper("tripCount", (arr) => {
      if (!Array.isArray(arr)) return 0;

      return arr.filter(
        item => String(item.unit || "").trim().toLowerCase() === "trip"
      ).length;
    });
    // ── Array / misc helpers ───────────────────────────────
    Handlebars.registerHelper("length", (arr) => (arr ? arr.length : 0));
    Handlebars.registerHelper("inc", (val) => parseInt(val) + 1);
    Handlebars.registerHelper("addOne", (val) => parseInt(val, 10) + 1);
    Handlebars.registerHelper("sumProperty", (arr, prop) => {
      if (!Array.isArray(arr)) return 0;
      return arr.reduce(
        (s, it) =>
          s + (parseFloat(String(it?.[prop] ?? 0).replace(/,/g, "")) || 0),
        0,
      );
    });
    Handlebars.registerHelper(
      "addOffset",
      (index, offset) => parseInt(index, 10) + parseInt(offset, 10) + 1,
    );
    Handlebars.registerHelper(
      "notEmpty",
      (val) =>
        val !== null &&
        val !== undefined &&
        val !== "" &&
        val !== "0" &&
        val !== 0,
    );

    Handlebars.registerHelper("pageDisplay", function (pageNumber, totalPages) {

      // If values are passed manually, use them
      if (pageNumber !== undefined && totalPages !== undefined) {
        return `${pageNumber}/${totalPages}`;
      }

      // Automatic page numbering inside body using CSS counters
      return new Handlebars.SafeString(
        '<span class="page-counter"></span>/<span class="page-total"></span>',
      );
    });
    // ── Invoice-specific helpers ───────────────────────────
    Handlebars.registerHelper("ifFlag", function (settings, key, options) {
      if (!settings || typeof settings !== "object")
        return options.inverse(this);

      const val = settings[key];
      const isTrue = val === 1 || val === "1" || val === true || val === "true";
      return isTrue ? options.fn(this) : options.inverse(this);
    });

    Handlebars.registerHelper("ifZatca", function (settings, options) {
      return settings && (settings.d51 == "154" || settings.d51 === 154)
        ? options.fn(this)
        : options.inverse(this);
    });

    // Handlebars.registerHelper("joinAddress", function (addr, separator) {
    //   const sep = typeof separator === "string" ? separator : ", ";
    //   if (!addr || typeof addr !== "object") return "";

    //   return [
    //     addr.address_line1,
    //     addr.address_line2,
    //     addr.address_line3,
    //     addr.address_line4,
    //     addr.address_line5,
    //     addr.address_code,
    //   ]
    //     .filter(Boolean)
    //     .join(sep);
    // });
    Handlebars.registerHelper("joinAddress", function (addr, separator) {
    const sep = typeof separator === "string" ? separator : ", ";

    if (!addr || typeof addr !== "object") {
        return "";
    }

    const address = [
        addr.address_line1,
        addr.address_line2,
        addr.address_line3,
        addr.address_line4,
        addr.address_line5,
        addr.address_code,
    ]
    .filter(v => v && String(v).trim() !== "")
    .join(sep);

    // Return SafeString only if separator contains HTML
    if (sep.includes("<")) {
        return new Handlebars.SafeString(address);
    }

    return address;
});

    // ── Currency symbol helpers ────────────────────────────
    // SVG currencies (SAR, AED) already default to the height that matches the
    // digits beside them, at whatever font-size the template uses — nothing to
    // pass. The optional 2nd arg scales that: 1 = match the text (default),
    // 1.2 = 20% bigger, 0.8 = smaller. Text currencies (BHD, KWD…) are font
    // glyphs, so they match by definition.
    Handlebars.registerHelper("currencySymbol", function (currency_isocode, scale) {
      const iso = (currency_isocode || "SAR").toUpperCase().trim();
      const factor = parseFloat(scale) > 0 ? parseFloat(scale) : 1;

      if (SVG_CURRENCY_MAP[iso]) {
        const svg = SVG_CURRENCY_MAP[iso]();
        if (svg.inline) {
          const inline =
            factor === 1
              ? svg.inline
              : svg.inline.replace(
                  /height\s*:\s*[^;"]+/i,
                  `height:${glyphHeight(iso, TEXT_INK_EM * factor)}`,
                );

          return new Handlebars.SafeString(inline);
        }
      }

      return new Handlebars.SafeString(
        `<span>${CURRENCY_SYMBOLS[iso] || iso}</span>`,
      );
    });

    Handlebars.registerHelper("currencyImg", function (isocode, size) {
      const iso = (isocode || "SAR").toUpperCase().trim();
      const height = typeof size === "string" ? size : "8px";


      if (SVG_CURRENCY_MAP[iso]) {
        const svg = SVG_CURRENCY_MAP[iso]();
        if (svg.dataUri) {
          return new Handlebars.SafeString(
            `<img src="${svg.dataUri}" ` +
              `style="height:${height};width:auto;vertical-align:middle;margin-right:2px;" alt="${iso}">`,
          );
        }
      }

      return new Handlebars.SafeString(
        `<span>${CURRENCY_SYMBOLS[iso] || iso}</span>`,
      );
    });

    Handlebars.registerHelper("qrDataUri", function (qrCodeBase64) {

      if (qrCodeBase64 && String(qrCodeBase64).length > 20) {
        return new Handlebars.SafeString(
          `<img src="data:image/png;base64,${qrCodeBase64}" ` +
            `width="130" height="130" style="display:block;" alt="QR Code">`,
        );
      }
      return new Handlebars.SafeString(
        `<span style="font-size:9px;color:#999;">QR unavailable</span>`,
      );
    });

    // Renders a QR code that encodes arbitrary text/a URL directly (unlike
    // qrDataUri, which just embeds an already-generated ZATCA payload image).
    // Built synchronously as inline SVG since Handlebars helpers can't await.
    Handlebars.registerHelper("qrCodeUrl", function (text, size) {
      const px = parseInt(size, 10) > 0 ? parseInt(size, 10) : 130;
      if (!text || !String(text).trim()) {
        return new Handlebars.SafeString(
          `<span style="font-size:9px;color:#999;">QR unavailable</span>`,
        );
      }
      try {
        const qr = QRCode.create(String(text).trim(), {
          errorCorrectionLevel: "M",
        });
        const n = qr.modules.size;
        let rects = "";
        for (let row = 0; row < n; row++) {
          for (let col = 0; col < n; col++) {
            if (qr.modules.get(row, col)) {
              rects += `<rect x="${col}" y="${row}" width="1" height="1"/>`;
            }
          }
        }
        return new Handlebars.SafeString(
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" ` +
            `width="${px}" height="${px}" shape-rendering="crispEdges" style="display:block;">` +
            `<rect x="0" y="0" width="${n}" height="${n}" fill="#fff"/>` +
            `<g fill="#000">${rects}</g></svg>`,
        );
      } catch (err) {
        console.error("Error generating qrCodeUrl:", err);
        return new Handlebars.SafeString(
          `<span style="font-size:9px;color:#999;">QR unavailable</span>`,
        );
      }
    });

    Handlebars.registerHelper("hasVat", function (items, options) {
      const hasVat = (items || []).some((i) => parseFloat(i.vat_amt) > 0);

      return hasVat ? options.fn(this) : options.inverse(this);
    });
    
    Handlebars.registerHelper("hasRemarks", function (items, options) {
      const hasRemarks = (items || []).some(
        (i) => i.remark && String(i.remark).trim() !== "",
      );
      return hasRemarks ? options.fn(this) : options.inverse(this);
    });

    Handlebars.registerHelper("hasDiscount", function (items, options) {
      const hasDiscount = (items || []).some(
        (i) => (parseFloat(String(i.disc_amt || 0).replace(/,/g, "")) || 0) > 0,
      );

      return hasDiscount ? options.fn(this) : options.inverse(this);
    });

    Handlebars.registerHelper("hasItemCode", function (items, options) {
    const hasItemCode = (items || []).some(
            (i) => i.item_code && String(i.item_code).trim() !== ""
        );

        return hasItemCode ? options.fn(this) : options.inverse(this);
    });

    // ✅ ADDED: Register Handlebars helpers (lines 2-14)
    Handlebars.registerHelper('if_gt', function (a, b, options) {
      return parseFloat(a) > parseFloat(b) ? options.fn(this) : options.inverse(this);
    });

    Handlebars.registerHelper('unless_gt', function (a, b, options) {
      return parseFloat(a) <= parseFloat(b) ? options.fn(this) : options.inverse(this);
    });

    Handlebars.registerHelper('formatNumber', function (val) {
      return parseFloat(val || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    });

    Handlebars.registerHelper('formatMonthYear', function (dateStr) {
      if (!dateStr) return '';
      try {
        const d = new Date(dateStr);
        return d.toLocaleDateString('en-MY', { month: 'long', year: 'numeric' });
      } catch {
        return dateStr;
      }
    });
    Handlebars.registerHelper('amountInWords', function (amount) {
      const num = parseFloat(String(amount || 0).replace(/,/g, '')) || 0;
      const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
        'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
        'Seventeen', 'Eighteen', 'Nineteen'];
      const tensW = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

      function convertHundreds(n) {
        if (n === 0) return '';
        if (n < 20) return ones[n];
        if (n < 100) return tensW[Math.floor(n / 10)] + (n % 10 !== 0 ? ' ' + ones[n % 10] : '');
        return ones[Math.floor(n / 100)] + ' Hundred' + (n % 100 !== 0 ? ' and ' + convertHundreds(n % 100) : '');
      }

      function toWords(n) {
        if (n === 0) return 'Zero';
        let result = '';
        if (n >= 1000000) { result += convertHundreds(Math.floor(n / 1000000)) + ' Million '; n %= 1000000; }
        if (n >= 1000) { result += convertHundreds(Math.floor(n / 1000)) + ' Thousand '; n %= 1000; }
        if (n > 0) result += convertHundreds(n);
        return result.trim();
      }

      const intPart = Math.floor(num);
      const cents = Math.round((num - intPart) * 100);
      let words = 'Ringgit Malaysia ' + toWords(intPart);
      if (cents > 0) words += ' and ' + toWords(cents) + ' Cents';
      return words + ' Only';
    });
    // Latin digits → Arabic-Indic digits (٠١٢٣٤٥٦٧٨٩), separators kept as-is.
    // Used by bilingual templates that print the same figure twice.
    Handlebars.registerHelper('arabicDigits', function (val) {
      if (val === null || val === undefined) return '';
      const ar = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
      return String(val).replace(/[0-9]/g, (d) => ar[d]);
    });
    // Splits a bilingual setting value into separate lines so each language can
    // be styled on its own row. Existing line breaks are honoured first; a line
    // holding both scripts is cut at the Arabic ↔ Latin boundary (digits,
    // spaces and punctuation stay with the run they follow).
    // Returns [{ lang: 'ar' | 'en', text }] — empty array when there is nothing.
    Handlebars.registerHelper('langParts', function (text) {
      if (!text) return [];
      const AR = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
      const LAT = /[A-Za-z]/;
      const parts = [];

      String(text).split(/\r\n|\n|\r/).forEach((line) => {
        let buf = '';
        let lang = null;
        const push = () => {
          const t = buf.trim();
          if (t) parts.push({ lang: lang || 'en', text: t });
          buf = '';
        };

        for (const ch of line) {
          const chLang = AR.test(ch) ? 'ar' : LAT.test(ch) ? 'en' : null;
          if (chLang && lang && chLang !== lang) {
            push();
            lang = chLang;
          } else if (chLang && !lang) {
            lang = chLang;
          }
          buf += ch;
        }
        push();
      });

      return parts;
    });
    // ✅ END OF ADDED LINES

  }

  // ── DATA PREPARATION ──────────────────────────────────────
  prepareTemplateData(data) {
    // Credit notes send basicdetails as a single object rather than a
    // one-element array; normalise so every template can use basicdetails.[0]
    if (
      data.basicdetails &&
      typeof data.basicdetails === "object" &&
      !Array.isArray(data.basicdetails)
    ) {
      data.basicdetails = [data.basicdetails];
    }

    const basic = (data.basicdetails && data.basicdetails[0]) || {};

    const iso = (basic.isocode || "SAR").toUpperCase().trim();

    data.isocode = iso;
    data.isSAR = iso === "SAR";
    data.isAED = iso === "AED";


    const countryIso = (
      basic.base_country_isocode ||
      basic.isocode ||
      "SAR"
    ).toUpperCase();

    data.tax_label = countryIso === "AED" ? "TRN" : "VAT Number";

    data.tax_label_ar = countryIso === "AED" ? "رقم التسجيل" : "رقم ضريبة";

    const taxRateMap = { SAR: 15, AED: 5, OMR: 5, BHD: 10 };
    const rate = taxRateMap[countryIso] || 15;
    data.tax_label_in_item =
      countryIso === "AED"
        ? "VAT (5%)"
        : `VAT (${rate}%)`;


    data.tax_label_in_total_section = countryIso === "AED" ? "Total TAX" : "Total VAT";

    data.tax_label_ar_in_total_section = countryIso === "AED" ? "قيمة الضريبة" : "ضريبة القيمة المضافة";

    data.ccrate =
      parseFloat(String(data.ccrate || basic.ccrate || 1).replace(/,/g, "")) ||
      1;

    data.bcdp = parseInt(data.bcdp || basic.bcdp || 2);

    return data;
  }

  // ── RENDER ────────────────────────────────────────────────
  async renderToString(templateName, data, docTypeFolder = "invoice") {
    try {
      const templateData = this.prepareTemplateData(data);

      const cacheKey = `${docTypeFolder}/${templateName}`;
      if (!this.compiledTemplates.has(cacheKey)) {
        const templatePath = path.join(
          __dirname,
          "..",
          "templates",
          docTypeFolder,
          `${templateName}.hbs`,
        );
        console.log(`Loading template: ${templatePath}`);
        const source = await fs.readFile(templatePath, "utf-8");
        this.compiledTemplates.set(cacheKey, Handlebars.compile(source));
      }

      let html = this.compiledTemplates.get(cacheKey)(templateData);

      // ── Font injection (IBM Plex Sans Arabic @font-face) ──
      html = injectFonts(html);

      // ── Bootstrap CSS injection ──────────────────────────
      // Replaces CDN link with inline styles — no network call needed
      if (bootstrapCss && html.includes("cdn.jsdelivr.net")) {
        html = html.replace(
          /<link[^<]*bootstrap[^<]*>/gi,
          `<style>${bootstrapCss}</style>`,
        );
        console.log("[Bootstrap] ✓ Injected into template:", templateName);
      }

      console.log(`Template rendered: ${cacheKey} (${html.length} chars)`);
      return html;
    } catch (error) {
      console.error(`Error rendering template ${templateName}:`, error);
      throw new Error(`Template rendering failed: ${error.message}`);
    }
  }

  // ── RENDER REPORT ─────────────────────────────────────────
  // Reads from /reports/<templateName>.hbs (separate from /templates/)
  async renderReportToString(templateName, data) {
    try {
      const cacheKey = `reports/${templateName}`;

      if (!this.compiledTemplates.has(cacheKey)) {
        const templatePath = path.join(
          __dirname,
          "..",
          "reports",
          `${templateName}.hbs`,
        );
        console.log(`Loading report template: ${templatePath}`);
        let source;
        try {
          source = await fs.readFile(templatePath, "utf-8");
        } catch (error) {
          if (
            error.code !== "ENOENT" ||
            !/^(equipment|manpower)_timesheet_report\d+$/.test(templateName)
          ) {
            throw error;
          }

          const timesheetTemplatePath = path.join(
            __dirname,
            "..",
            "templates",
            "timesheet",
            `${templateName}.hbs`,
          );
          console.log(`Loading timesheet template: ${timesheetTemplatePath}`);
          source = await fs.readFile(timesheetTemplatePath, "utf-8");
        }
        this.compiledTemplates.set(cacheKey, Handlebars.compile(source));
      }

      let html = this.compiledTemplates.get(cacheKey)(data);

      html = injectFonts(html);

      if (bootstrapCss && html.includes("cdn.jsdelivr.net")) {
        html = html.replace(
          /<link[^<]*bootstrap[^<]*>/gi,
          `<style>${bootstrapCss}</style>`,
        );
        console.log(
          "[Bootstrap] ✓ Injected into report template:",
          templateName,
        );
      }

      console.log(
        `Report template rendered: ${cacheKey} (${html.length} chars)`,
      );
      return html;
    } catch (error) {
      console.error(`Error rendering report template ${templateName}:`, error);
      throw new Error(`Report template rendering failed: ${error.message}`);
    }
  }

  // ── CACHE ─────────────────────────────────────────────────
  clearCache() {
    this.compiledTemplates.clear();
    sarSvg = loadCurrencySvg("sar.svg", "SAR");
    aedSvg = loadCurrencySvg("aed.svg", "AED");
    console.log("Template cache cleared");
  }

  async precompileTemplates() {
    const templatesDir = path.join(__dirname, "..", "templates");
    try {
      const files = await fs.readdir(templatesDir);

      for (const file of files.filter((f) => f.endsWith(".hbs"))) {
        const name = file.replace(".hbs", "");
        const src = await fs.readFile(path.join(templatesDir, file), "utf-8");

        this.compiledTemplates.set(name, Handlebars.compile(src));
        console.log(`Precompiled: ${name}`);
      }
      console.log("All templates precompiled successfully");
    } catch (error) {
      console.error("Error precompiling templates:", error);
      throw error;
    }
  }

  // ── RENDER TIMESHEET ─────────────────────────────────────
  // Reads from /templates/timesheet/<templateName>.hbs
  async renderTimesheetToString(templateName, data) {
    try {
      const cacheKey = `timesheet/${templateName}`;

      if (!this.compiledTemplates.has(cacheKey)) {
        const templatePath = path.join(
          __dirname,
          "..",
          "templates",
          "timesheet",
          `${templateName}.hbs`,
        );
        console.log(`Loading timesheet template: ${templatePath}`);
        const source = await fs.readFile(templatePath, "utf-8");
        this.compiledTemplates.set(cacheKey, Handlebars.compile(source));
      }

      let html = this.compiledTemplates.get(cacheKey)(data);

      html = injectFonts(html);

      if (bootstrapCss && html.includes("cdn.jsdelivr.net")) {
        html = html.replace(
          /<link[^<]*bootstrap[^<]*>/gi,
          `<style>${bootstrapCss}</style>`,
        );
        console.log(
          "[Bootstrap] ✓ Injected into timesheet template:",
          templateName,
        );
      }

      console.log(
        `Timesheet template rendered: ${cacheKey} (${html.length} chars)`,
      );
      return html;
    } catch (error) {
      console.error(`Error rendering timesheet template ${templateName}:`, error);
      throw new Error(`Report template rendering failed: ${error.message}`);
    }
  }

  // ── RAHATH PAGINATION ─────────────────────────────────────
  prepareRahathData(data, maxRowsPerPage = 22) {
    const items = data.itemdetails || [];
    const pages = [];

    for (let i = 0; i < items.length; i += maxRowsPerPage) {
      pages.push({ items: items.slice(i, i + maxRowsPerPage), startIndex: i });
    }

    if (pages.length === 0) pages.push({ items: [], startIndex: 0 });

    data.pageItems = pages[0].items;
    data.startIndex = pages[0].startIndex;
    data.isLastPage = pages.length === 1;

    data.extraPages = pages.slice(1).map((page, idx) => ({
      pageItems: page.items,
      startIndex: page.startIndex,
      isLastPage: idx === pages.length - 2,
    }));

    return data;
  }
}

module.exports = new TemplateService();
