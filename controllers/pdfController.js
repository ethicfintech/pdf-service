const { PDFDocument } = require("pdf-lib");
const templateService = require("../services/templateService");
const { getDocTypeInfo } = require("../config/docTypes");
const qrCodeService = require("../services/qrCodeService");
const pdfService = require("../services/pdfService");
const { generatePdf } = require("../services/lambdaService");

class PdfController {
  /**
   * Test endpoint
   */
  async test(req, res) {
    try {
      res.json({
        message: "API is working fine test nows",
        url: req.path,
        environment: process.platform,
        runtime: process.version,
        nodeEnv: process.env.NODE_ENV,
        puppeteerServiceUrl: process.env.PUPPETEER_SERVICE_URL || 'http://puppeteer-service:3001',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * Generate PDF via Puppeteer service
   */
  async generatePdfWithRazorView(req, res) {
    const startTime = Date.now();

    try {
      let pdfRequest = req.body;

      if (!pdfRequest) {
        return res.status(400).json({ error: "PDF request data is required" });
      }

      // ── Parse numeric fields — PHP sends strings ──────────
      // switch/comparison uses strict equality so "201" !== 201
      pdfRequest.ReportType = parseInt(pdfRequest.ReportType, 10);
      pdfRequest.template_no = parseInt(pdfRequest.template_no, 10);
      pdfRequest.doc_type = parseInt(pdfRequest.doc_type, 10) || 1;

      const docTypeInfo = getDocTypeInfo(pdfRequest.doc_type);
      const docTypeFolder = docTypeInfo.folder;

      console.log("\n=== PDF Generation Started ===");
      console.log(
        `Template No: ${pdfRequest.template_no}, Doc Type: ${pdfRequest.doc_type} (${docTypeInfo.label})`,
      );

      // ============================================
      // PHASE 1: PARALLEL PREPROCESSING
      // ============================================
      const preprocessingTasks = [];

      // ── Task 1: QR Code ──────────────────────────────────
      // Skip QR for thermal and pre-print templates
      // The QR TLV string is a ZATCA TLV base64 string → converted to PNG QR image.
      // Source priority: cleared_qr (ZATCA-cleared) → reported_inv_qr (reported) → qrcode (basic).
      const needsQr = ![202, 211].includes(pdfRequest.template_no);

      const bd0 = pdfRequest.basicdetails?.[0] || {};
      const qrNotEmpty = (v) =>
        v !== undefined && v !== null && String(v).trim() !== "";

      // Candidates in priority order — the first one that is present AND
      // actually encodes wins, so a malformed cleared/reported QR falls back
      // to the next source instead of leaving the invoice with no QR at all.
      const qrCandidates = [
        ["cleared_qr", bd0.cleared_qr],
        ["reported_inv_qr", bd0.reported_inv_qr],
        ["qrcode", pdfRequest.qrcode],
      ].filter(([, v]) => qrNotEmpty(v));

      if (needsQr && qrCandidates.length > 0) {
        preprocessingTasks.push(
          (async () => {
            for (const [name, value] of qrCandidates) {
              try {
                console.log(`↻ Generating QR image from ${name}...`);
                pdfRequest.qrCodeBase64 =
                  await qrCodeService.generateQrCodeBase64(value);
                console.log(
                  `✓ QR image generated from ${name} (${pdfRequest.qrCodeBase64.length} chars)`,
                );
                return;
              } catch (err) {
                console.error(`✗ QR generation from ${name} failed:`, err.message);
              }
            }
            pdfRequest.qrCodeBase64 = "";
            console.error("✗ No QR source could be encoded");
          })(),
        );
      } else {
        console.log("✓ QR skipped (not required for this template)");
      }

      // ── Task 2: Watermark CSS ────────────────────────────
      if (pdfRequest.UseBGWatermark && pdfRequest.WatermarkUrl) {
        preprocessingTasks.push(
          pdfService
            .generateWatermarkCss(
              pdfRequest.WatermarkUrl,
              pdfRequest.WatermarkOpacity || 0.7,
            )
            .then((watermarkCss) => {
              pdfRequest.WatermarkCss = watermarkCss;
              console.log(
                `✓ Watermark CSS generated (opacity: ${pdfRequest.WatermarkOpacity || 0.7})`,
              );
            })
            .catch((err) =>
              console.error("✗ Watermark generation failed:", err),
            ),
        );
      }

      // ── Task 4a: MyInvois supplier seal → base64 ─────────────────
      if (
        pdfRequest.MyInvoisDocument?.supplier?.seal &&
        String(pdfRequest.MyInvoisDocument.supplier.seal).startsWith("http")
      ) {
        preprocessingTasks.push(
          pdfService
            .getHighQualityImageBytes(pdfRequest.MyInvoisDocument.supplier.seal, 1.0, true)
            .then((imgBuffer) => {
              if (imgBuffer) {
                pdfRequest.MyInvoisDocument.supplier.seal = `data:image/png;base64,${imgBuffer.toString("base64")}`;
                console.log("✓ MyInvois supplier seal converted to base64");
              }
            })
            .catch((err) => {
              console.error("✗ MyInvois supplier seal failed:", err.message);
              pdfRequest.MyInvoisDocument.supplier.seal = "";
            }),
        );
      }

      // ── Task 4b: MyInvois supplier signature → base64 ────────────
      if (
        pdfRequest.MyInvoisDocument?.supplier?.signature &&
        String(pdfRequest.MyInvoisDocument.supplier.signature).startsWith("http")
      ) {
        preprocessingTasks.push(
          pdfService
            .getHighQualityImageBytes(pdfRequest.MyInvoisDocument.supplier.signature, 1.0, true)
            .then((imgBuffer) => {
              if (imgBuffer) {
                pdfRequest.MyInvoisDocument.supplier.signature = `data:image/png;base64,${imgBuffer.toString("base64")}`;
                console.log("✓ MyInvois supplier signature converted to base64");
              }
            })
            .catch((err) => {
              console.error("✗ MyInvois supplier signature failed:", err.message);
              pdfRequest.MyInvoisDocument.supplier.signature = "";
            }),
        );
      }

      // ── Task 4: Seal → base64 ────────────────────────────────────
      if (pdfRequest.Seal && String(pdfRequest.Seal).startsWith("http")) {
        preprocessingTasks.push(
          pdfService
            .getHighQualityImageBytes(pdfRequest.Seal)
            .then((imgBuffer) => {
              if (imgBuffer) {
                pdfRequest.Seal = `data:image/jpeg;base64,${imgBuffer.toString("base64")}`;
                console.log("✓ Seal converted to base64");
              }
            })
            .catch((err) => {
              console.error("✗ Seal failed:", err.message);
              pdfRequest.Seal = "";
            }),
        );
      }

      // ── Task 5: Signature → base64 ─────────────────────────────
      if (
        pdfRequest.Signature &&
        String(pdfRequest.Signature).startsWith("http")
      ) {
        preprocessingTasks.push(
          pdfService
            .getHighQualityImageBytes(pdfRequest.Signature)
            .then((imgBuffer) => {
              if (imgBuffer) {
                pdfRequest.Signature = `data:image/jpeg;base64,${imgBuffer.toString("base64")}`;
                console.log("✓ Signature converted to base64");
              }
            })
            .catch((err) => {
              console.error("✗ Signature failed:", err.message);
              pdfRequest.Signature = "";
            }),
        );
      }

      // ── Task 6: Company logo → base64 ──────────────────────────
      if (
        pdfRequest.Companylogo &&
        String(pdfRequest.Companylogo).startsWith("http")
      ) {
        preprocessingTasks.push(
          pdfService
            .getHighQualityImageBytes(pdfRequest.Companylogo)
            .then((imgBuffer) => {
              if (imgBuffer) {
                pdfRequest.Companylogo = `data:image/jpeg;base64,${imgBuffer.toString("base64")}`;
                console.log("✓ Logo converted to base64");
              }
            })
            .catch((err) => {
              console.error("✗ Logo failed:", err.message);
              pdfRequest.Companylogo = "";
            }),
        );
      }

      // ── Task 7: Letterhead background image → base64 ───────────
      if (
        pdfRequest.LetterheadImageUrl &&
        String(pdfRequest.LetterheadImageUrl).startsWith("http")
      ) {
        preprocessingTasks.push(
          pdfService
            .getHighQualityImageBytes(pdfRequest.LetterheadImageUrl)
            .then((imgBuffer) => {
              if (imgBuffer) {
                pdfRequest.LetterheadImageUrl = `data:image/jpeg;base64,${imgBuffer.toString("base64")}`;
                console.log("✓ Letterhead image converted to base64");
              }
            })
            .catch((err) => {
              console.error("✗ Letterhead image failed:", err.message);
              pdfRequest.LetterheadImageUrl = "";
            }),
        );
      }

      // ── Task 8: Item images (itemdetails[].image1) → base64 data URI ─
      // Adds itemdetails[].image1DataUri so templates can embed product images inline.
      if (Array.isArray(pdfRequest.itemdetails) && pdfRequest.itemdetails.length) {
        pdfRequest.itemdetails.forEach((item) => {
          if (item && item.image1 && !String(item.image1).startsWith("data:")) {
            const itemImageUrl = String(item.image1).startsWith("http")
              ? item.image1
              : `https://accounts.ethicfin.com/uploads/product_images/${item.image1}`;
            preprocessingTasks.push(
              pdfService
                .getHighQualityImageBytes(itemImageUrl)
                .then((imgBuffer) => {
                  if (imgBuffer) {
                    const ext = (String(item.image1).split(".").pop() || "png").toLowerCase();
                    const mime = ext === "jpg" || ext === "jpeg" ? "jpeg" : ext;
                    item.image1DataUri = `data:image/${mime};base64,${imgBuffer.toString("base64")}`;
                  }
                })
                .catch((err) => {
                  console.error(`✗ Item image '${item.image1}' failed:`, err.message);
                  item.image1DataUri = "";
                }),
            );
          }
        });
      }

      // ── Task 3: MyInvois QR ──────────────────────────────
      if (pdfRequest.MyInvoisDocument?.myinvois) {
        const myinvois = pdfRequest.MyInvoisDocument.myinvois;
        if (!myinvois.qr_code && myinvois.uuid && myinvois.long_id) {
          preprocessingTasks.push(
            qrCodeService
              .generateMyInvoisQr(myinvois.uuid, myinvois.long_id)
              .then((qrDataUri) => {
                myinvois.qr_code = qrDataUri;
                console.log("✓ MyInvois QR generated successfully");
              })
              .catch((err) =>
                console.error("✗ MyInvois QR generation failed:", err),
              ),
          );
        }
      }

      await Promise.all(preprocessingTasks);

      const preprocessTime = Date.now();
      console.log(
        `✓ Preprocessing completed in ${preprocessTime - startTime}ms`,
      );

      // ============================================
      // PHASE 2: RENDER HTML TEMPLATE
      // ============================================
      let htmlContent;
      let viewName = "";
      let paperConfig = {};

      viewName = `template${pdfRequest.template_no}`;

      switch (pdfRequest.template_no) {
        case 201:
        case 180:
          // Thermal receipt — 80mm roll, height auto-fits content
          // Override thermal width via paper_width (e.g. '302px' for 80mm, '348px' for 88mm)
          paperConfig = {
            thermalWidth: pdfRequest.paper_width || "302px",
            useHeaderFooter: false,
          };
          break;

        case 202:
        case 211:
          // Pre-printed form — custom paper size, background image overlay
          // Override dimensions via paper_width / paper_height (e.g. '220mm' / '280mm')
          paperConfig = {
            width: pdfRequest.paper_width || "220mm",
            height: pdfRequest.paper_height || "280mm",
            useHeaderFooter: false,
          };
          if (pdfRequest.template_no === 202) {
            pdfRequest = templateService.prepareRahathData(pdfRequest);
          }
          break;

        default:
          // Standard A4 invoice with optional header/footer images
          paperConfig = { format: "A4", useHeaderFooter: true };
      }

      // console.log(`viewName: ${viewName} | paperConfig: ${JSON.stringify(paperConfig)}`);

      try {
        htmlContent = await templateService.renderToString(
          viewName,
          pdfRequest,
          docTypeFolder,
        );
        console.log(
          `✓ Template '${viewName}' rendered. HTML length: ${htmlContent.length}`,
        );
      } catch (renderError) {
        console.error("✗ Template rendering error:", renderError);
        return res.status(500).json({
          error: "Error rendering template",
          details: renderError.message,
          template: viewName,
        });
      }

      const renderTime = Date.now();
      console.log(
        `✓ HTML rendering completed in ${renderTime - preprocessTime}ms`,
      );

      // ============================================
      // PHASE 3: CONFIGURE PDF OPTIONS
      // ============================================

      // isThermal = no format, no width  → thermal roll (width driven by paper_width)
      // isCustom  = no format, has width → pre-printed custom size
      const isThermal = !paperConfig.format && !paperConfig.width;
      const isCustom = !paperConfig.format && paperConfig.width;

      if (isThermal) {
        const tw = paperConfig.thermalWidth || "302px";
        // Inject CSS + JS to auto-size page height to exact content height
        // Lambda Puppeteer ignores preferCSSPageSize — injecting into HTML is the only guarantee
        htmlContent = htmlContent.replace(
          /<head([^>]*)>/i,
          `<head$1>
    <style id="thermal-page-size">
      @page { size: ${tw} 9999px !important; margin: 0 !important; }
      html, body { width: ${tw} !important; max-width: ${tw} !important; margin: 0 !important; padding: 0 !important; }
    </style>
    <script>
      document.addEventListener('DOMContentLoaded', function() {
        var h = document.body.scrollHeight || document.documentElement.scrollHeight;
        document.getElementById('thermal-page-size').textContent =
          '@page { size: ${tw} ' + (h + 10) + 'px !important; margin: 0 !important; }' +
          'html, body { width: ${tw} !important; max-width: ${tw} !important; margin: 0 !important; padding: 0 !important; }';
      });
    </script>`,
        );
        console.log(`✓ Thermal CSS + auto-height script injected (${tw})`);
      }

      // Metadata is now handled by pdf-lib after Lambda returns the buffer
      // See Phase 4.5 below — direct binary injection, 100% reliable

      const pdfOptions = {
        printBackground: true,
        omitBackground: false,
        preferCSSPageSize: true,
        scale: 1.0,
        ...(isCustom
          ? { width: paperConfig.width, height: paperConfig.height }
          : isThermal
            ? { width: paperConfig.thermalWidth || "302px", height: "1500px" }
            : { format: paperConfig.format }),
      };

      // Header/footer images only for standard A4 templates
      const useHeaderFooter =
        paperConfig.useHeaderFooter && pdfRequest.UseHeaderFooter;

      // Page margins come from the per-doc_type datasettings REGARDLESS of
      // whether the header/footer artwork is printed. UseHeaderFooter used to
      // gate this switch as well, so a no-header print silently fell back to a
      // hardcoded 10px and the content sat on the page edge.
      const ds = pdfRequest.datasettings || {};
      const withUnit = (v, fallback) => {
        if (v === undefined || v === null || v === "") return fallback;
        return /^[\d.]+$/.test(String(v)) ? `${v}px` : String(v);
      };

      const docMargin = (() => {
          switch (pdfRequest.doc_type) {
            case 2:
              // Sales Quote
              return {
                top: withUnit(ds.d783, "120px"),
                bottom: withUnit(ds.d811, "5px"),
                left: "0px",
                right: "0px",
              };
              break;
              case 3:
              // Proforma invoice
              return {
                top: withUnit(ds.d881, "120px"),
                bottom: withUnit(ds.d882, "5px"),
                left: "0px",
                right: "0px",
              };
              break;
              case 4:
              // Sales Order
              return {
                top: withUnit(ds.d935, "120px"),
                bottom: withUnit(ds.d817, "5px"),
                left: "0px",
                right: "0px",
              };
              break;
              case 5:
              // Purchase Order
              return {
                top: withUnit(ds.d931, "120px"),
                bottom: withUnit(ds.d813, "5px"),
                left: "0px",
                right: "0px",
              };
              break;
               case 6:
              // Purchase 
              return {
                top: withUnit(ds.d932, "120px"),
                bottom: withUnit(ds.d814, "5px"),
                left: "0px",
                right: "0px",
              };
              break;
              case 7:
              // Credit note 
              return {
                top: withUnit(ds.d936, "120px"),
                bottom: withUnit(ds.d818, "5px"),
                left: "0px",
                right: "0px",
              };
              break;
              case 8:
              // Purchase Return
              return {
                top: withUnit(ds.d933, "120px"),
                bottom: withUnit(ds.d815, "5px"),
                left: "0px",
                right: "0px",
              };
              break;
              case 9:
              // Sales Return 
              return {
                top: withUnit(ds.d934, "120px"),
                bottom: withUnit(ds.d816, "5px"),
                left: "0px",
                right: "0px",
              };
              break;
              case 10:
              // Deliverynote 
              return {
                top: withUnit(ds.d803, "120px"),
                bottom: withUnit(ds.d810, "5px"),
                left: "0px",
                right: "0px",
              };
              break;
            case 1:
            default:
              // Invoice (and fallback)
              return {
                top: withUnit(ds.d74, "120px"),
                bottom: withUnit(ds.d75, "5px"),
                left: "0px",
                right: "0px",
              };
              break;
          }
      })();

      if (useHeaderFooter) {
        console.log("Configuring PDF with HEADER/FOOTER mode");
        pdfOptions.displayHeaderFooter = true;
        pdfOptions.margin = docMargin;

        console.log(
          `✓ Margins for doc_type=${pdfRequest.doc_type}:`,
          pdfOptions.margin,
          `| raw d783=${ds.d783}, d811=${ds.d811}, d9813=${ds.d813}, d931=${ds.d931}, d935=${ds.d935}, d817=${ds.d817}, d931=${ds.d931}, d813=${ds.d813}, d932=${ds.d932}, d814=${ds.d814}, d936=${ds.d936}, d818=${ds.d818}, d933=${ds.d933}, d815=${ds.d815}, d934=${ds.d934}, d816=${ds.d816}, d803=${ds.d803}, d810=${ds.d810}, d74=${ds.d74}, d75=${ds.d75}`,
        );
        // pdfOptions.margin = { top: '120px', bottom: '5px', left: '15px', right: '15px' };

        const headerFooterTasks = [];

        if (pdfRequest.HeaderImageUrl) {
          headerFooterTasks.push(
            pdfService
              .headerGenerate(pdfRequest.HeaderImageUrl)
              .then((headerHtml) => {
                pdfOptions.headerTemplate = headerHtml;
              }),
          );
        }

        if (pdfRequest.FooterImageUrl) {
          headerFooterTasks.push(
            pdfService
              .footerGenerate(pdfRequest.FooterImageUrl)
              .then((footerHtml) => {
                pdfOptions.footerTemplate = footerHtml;
              }),
          );
        }

        if (headerFooterTasks.length > 0) {
          await Promise.all(headerFooterTasks);
        }
      } else {
        const mode = isThermal
          ? "THERMAL"
          : isCustom
            ? "CUSTOM SIZE"
            : "SIMPLE";
        console.log(`Configuring PDF with ${mode} mode`);

        pdfOptions.displayHeaderFooter = false;
        // same configured margins as the header/footer path — only the artwork is
        // dropped here. Thermal / custom stock still prints edge to edge.
        pdfOptions.margin =
          isThermal || isCustom
            ? { top: "0", bottom: "0", left: "0", right: "0" }
            : docMargin;

        console.log(
          `✓ Margins for doc_type=${pdfRequest.doc_type} (no header/footer):`,
          pdfOptions.margin,
        );
      }

      const optionsTime = Date.now();
      console.log(`✓ PDF options configured in ${optionsTime - renderTime}ms`);

      // ============================================
      // PHASE 4: GENERATE PDF VIA PUPPETEER SERVICE
      // ============================================
      console.log("Calling Puppeteer service to generate PDF...");

      let pdfBuffer;

      try {
        pdfBuffer = await generatePdf(htmlContent, pdfOptions);

        const puppeteerTime = Date.now();
        console.log(
          `✓ PDF generation completed in ${puppeteerTime - optionsTime}ms`,
        );
        console.log(`✓ PDF size: ${pdfBuffer.length} bytes`);
      } catch (pdfError) {
        console.error("✗ PDF generation failed:", pdfError.message);

        if (pdfError.response) {
          console.error("Puppeteer error response:", pdfError.response.data);
          return res.status(500).json({
            error: "PDF generation failed",
            details: pdfError.response.data,
            statusCode: pdfError.response.status,
          });
        }

        return res.status(500).json({
          error: "Failed to generate PDF",
          details: pdfError.message,
        });
      }

      // ── Inject metadata via pdf-lib ──────────────────────

      try {
        const pdfDoc = await PDFDocument.load(pdfBuffer);

        const invNo_m =
          pdfRequest.basicdetails?.[0]?.inv_no ||
          pdfRequest.MyInvoisDocument?.document?.inv_no ||
          "";
        const invDate_m =
          pdfRequest.basicdetails?.[0]?.inv_date ||
          pdfRequest.MyInvoisDocument?.document?.inv_date ||
          "";
        const companyName_m = (
          pdfRequest.branch?.[0]?.name ||
          pdfRequest.MyInvoisDocument?.supplier?.name ||
          ""
        ).trim();
        const customerName_m = (
          pdfRequest.billing_address?.[0]?.name ||
          pdfRequest.MyInvoisDocument?.buyer?.name ||
          ""
        ).trim();

        if(doc_type == 2){
          pdfDoc.setTitle(`QUOTATION - ${invNo_m}`);

        }else{
          pdfDoc.setTitle(`INVOICE - ${invNo_m}`);
        }
        pdfDoc.setAuthor(companyName_m);
        pdfDoc.setSubject(`Invoice ${invNo_m} dated ${invDate_m}`);
        pdfDoc.setKeywords(["invoice", invNo_m, customerName_m, companyName_m]);
        pdfDoc.setCreator("Ethicfin");
        pdfDoc.setProducer(
          "Ethicfin - Smart Accounting Solutions | www.ethicfin.com",
        );
        pdfDoc.setCreationDate(new Date());
        pdfDoc.setModificationDate(new Date());

        pdfBuffer = Buffer.from(await pdfDoc.save());
        console.log(
          `✓ PDF metadata written via pdf-lib (${pdfBuffer.length} bytes)`,
        );
      } catch (metaErr) {
        console.error("✗ pdf-lib metadata injection failed:", metaErr.message);
        // pdfBuffer unchanged — still send original PDF
      }

      const endTime = Date.now();
      const totalTime = endTime - startTime;

      console.log(`✓ Total processing time: ${totalTime}ms`);
      console.log("=== PDF Generation Completed ===\n");

      // ============================================
      // PHASE 5: FILENAME & SEND RESPONSE
      // ============================================
      let fileName = "document.pdf";

      if (pdfRequest.MyInvoisDocument?.document?.inv_no) {
        const docType =
          pdfRequest.MyInvoisDocument?.document_info?.type_name || "Document";
        const myInvNo = pdfRequest.MyInvoisDocument.document.inv_no.replace(
          /[ /]/g,
          "_",
        );
        const selfBilled = pdfRequest.MyInvoisDocument?.document_info
          ?.is_self_billed
          ? "_SelfBilled"
          : "";
        const timestamp = new Date()
          .toISOString()
          .replace(/[-:]/g, "")
          .split(".")[0];
        fileName = `MyInvois_${docType}${selfBilled}_${myInvNo}_${timestamp}.pdf`;
      } else if (pdfRequest.basicdetails?.[0]?.inv_no) {
        const fInvNo = pdfRequest.basicdetails[0].inv_no.replace(/[ /]/g, "_");
        fileName = `Invoice_${fInvNo}_${Date.now()}.pdf`;
      }

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${fileName}"`,
      );
      res.setHeader("X-PDF-Generation-Time", totalTime.toString());
      res.setHeader("X-PDF-Size", pdfBuffer.length.toString());
      res.setHeader(
        "X-PDF-Document-Type",
        pdfRequest.MyInvoisDocument?.document_info?.type_display || "Invoice",
      );
      res.setHeader("X-PDF-Generator", "Puppeteer");

      res.send(pdfBuffer);
    } catch (error) {
      console.error("✗ Unexpected error in PDF generation:", error);
      res.status(500).json({
        error: "Unexpected error in PDF generation",
        details: error.message,
        stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
      });
    }
  }

  /**
   * Cleanup browser pool endpoint
   */
  // async cleanupBrowserPool(req, res) {
  //   res.json({
  //     message: 'Using AWS Lambda - no browser pool to cleanup',
  //     mode: 'lambda'
  //   });
  // }
}

module.exports = new PdfController();
