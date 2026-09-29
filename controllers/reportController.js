'use strict';

const { PDFDocument } = require('pdf-lib');
const templateService = require('../services/templateService');
const pdfService = require('../services/pdfService');
const { generatePdf } = require('../services/lambdaService');
const { getReportTypeInfo } = require('../config/reportTypes');

class ReportController {

  // ── GET /api/report/test ──────────────────────────────────
  async test(req, res) {
    res.json({
      message: 'Report API is working',
      url: req.path,
      timestamp: new Date().toISOString(),
    });
  }

  // ── New Comment Addded────────────────────────
  // ── By Sreedevi ────────────────────────
  // ── By Sreedevi ────────────────────────
  // ── By Sreedevi ────────────────────────

  // ── POST /api/report/generate-pdf ────────────────────────
  async generateReportPdf(req, res) {
    const startTime = Date.now();

    try {
      const report = req.body;

      if (!report) {
        return res.status(400).json({ error: 'Request body is required' });
      }

      console.log('report_dataaaaaaa', report);
      // PHP sends strings — parse to int
      report.report_type = parseInt(report.report_type, 10) || 1;
      report.template_no = parseInt(report.template_no, 10) || 1;

      // report_type  →  { name, label }
      // Template file = name + template_no  →  e.g. project_report1.hbs
      const reportTypeInfo = getReportTypeInfo(report.report_type);
      const templateFile = `${reportTypeInfo.name}${report.template_no}`;
      const reportTitle = report.report_title || reportTypeInfo.label;

      console.log('\n=== Report PDF Generation Started ===');
      console.log(`Type: ${report.report_type} (${reportTypeInfo.label}) | Template: ${templateFile}`);

      // ============================================
      // PHASE 1: PARALLEL PREPROCESSING
      // ============================================
      const tasks = [];

      // ── Watermark CSS ────────────────────────────────────
      if (report.UseBGWatermark && report.WatermarkUrl) {
        tasks.push(
          pdfService
            .generateWatermarkCss(report.WatermarkUrl, report.WatermarkOpacity || 0.7)
            .then((css) => {
              report.WatermarkCss = css;
              console.log(`✓ Watermark CSS generated (opacity: ${report.WatermarkOpacity || 0.7})`);
            })
            .catch((err) => console.error('✗ Watermark failed:', err.message)),
        );
      }

      // ── Company logo → base64 ────────────────────────────
      if (report.Companylogo && String(report.Companylogo).startsWith('http')) {
        tasks.push(
          pdfService
            .getHighQualityImageBytes(report.Companylogo)
            .then((buf) => {
              if (buf) {
                report.Companylogo = `data:image/jpeg;base64,${buf.toString('base64')}`;
                console.log('✓ Logo converted to base64');
              }
            })
            .catch((err) => {
              console.error('✗ Logo failed:', err.message);
              report.Companylogo = '';
            }),
        );
      }

      // ── Letterhead background → base64 ──────────────────
      if (report.LetterheadImageUrl && String(report.LetterheadImageUrl).startsWith('http')) {
        tasks.push(
          pdfService
            .getHighQualityImageBytes(report.LetterheadImageUrl)
            .then((buf) => {
              if (buf) {
                report.LetterheadImageUrl = `data:image/jpeg;base64,${buf.toString('base64')}`;
                console.log('✓ Letterhead converted to base64');
              }
            })
            .catch((err) => {
              console.error('✗ Letterhead failed:', err.message);
              report.LetterheadImageUrl = '';
            }),
        );
      }

      await Promise.all(tasks);
      console.log(`✓ Preprocessing done in ${Date.now() - startTime}ms`);

      // ============================================
      // PHASE 2: RENDER HTML TEMPLATE
      // ============================================
      let htmlContent;

      // Inject resolved meta so templates can use {{report_title}}, {{report_type_label}}
      report.report_title = reportTitle;
      report.report_type_label = reportTypeInfo.label;

      try {
        htmlContent = await templateService.renderReportToString(templateFile, report);
        console.log(`✓ Template '${templateFile}' rendered (${htmlContent.length} chars)`);
      } catch (err) {
        return res.status(500).json({
          error: 'Template rendering failed',
          details: err.message,
          template: templateFile,
        });
      }

      const renderTime = Date.now();

      // ============================================
      // PHASE 3: PDF OPTIONS
      // ============================================
      const orientation = (report.orientation || 'portrait').toLowerCase();
      const paperSize = report.paper_size || 'A4';

      const pdfOptions = {
        printBackground: true,
        omitBackground: false,
        preferCSSPageSize: true,
        scale: 1.0,
        format: paperSize,
        landscape: orientation === 'landscape',
      };

      // ── Header / footer images (conditional) ────────────
      const useHeaderFooter = report.UseHeaderFooter && (report.HeaderImageUrl || report.FooterImageUrl);

      if (useHeaderFooter) {
        pdfOptions.displayHeaderFooter = true;
        pdfOptions.margin = {
          top: report.margin_top || '120px',
          bottom: report.margin_bottom || '60px',
          left: '0px',
          right: '0px',
        };

        const hfTasks = [];

        if (report.HeaderImageUrl) {
          hfTasks.push(
            pdfService.headerGenerate(report.HeaderImageUrl).then((html) => {
              pdfOptions.headerTemplate = html;
            }),
          );
        }

        if (report.FooterImageUrl) {
          hfTasks.push(
            pdfService.footerGenerate(report.FooterImageUrl).then((html) => {
              pdfOptions.footerTemplate = html;
            }),
          );
        }

        if (hfTasks.length) await Promise.all(hfTasks);
        console.log('✓ Header/footer configured');
      } else {
        pdfOptions.displayHeaderFooter = false;
        pdfOptions.margin = {
          top: '10px', bottom: '10px', left: '10px', right: '10px',
        };
      }

      console.log(`✓ PDF options configured in ${Date.now() - renderTime}ms`);

      // ============================================
      // PHASE 4: GENERATE PDF
      // ============================================
      console.log('Calling Puppeteer service...');
      let pdfBuffer;

      try {
        pdfBuffer = await generatePdf(htmlContent, pdfOptions);
        console.log(`✓ PDF generated. Size: ${pdfBuffer.length} bytes`);
      } catch (err) {
        console.error('✗ PDF generation failed:', err.message);

        if (err.response) {
          return res.status(500).json({
            error: 'PDF generation failed',
            details: err.response.data,
            statusCode: err.response.status,
          });
        }

        return res.status(500).json({
          error: 'Failed to generate PDF',
          details: err.message,
        });
      }

      // ── Inject PDF metadata ──────────────────────────────
      try {
        const pdfDoc = await PDFDocument.load(pdfBuffer);
        const title = reportTitle;
        const company = String(report.company_name || '').trim();

        pdfDoc.setTitle(title);
        pdfDoc.setAuthor(company);
        pdfDoc.setSubject(title);
        pdfDoc.setCreator('Ethicfin');
        pdfDoc.setProducer('Ethicfin - Smart Accounting Solutions | www.ethicfin.com');
        pdfDoc.setCreationDate(new Date());
        pdfDoc.setModificationDate(new Date());

        pdfBuffer = Buffer.from(await pdfDoc.save());
        console.log(`✓ Metadata written (${pdfBuffer.length} bytes)`);
      } catch (err) {
        console.error('✗ Metadata injection failed:', err.message);
      }

      const totalTime = Date.now() - startTime;
      console.log(`✓ Total: ${totalTime}ms`);
      console.log('=== Report PDF Generation Completed ===\n');

      // ============================================
      // PHASE 5: SEND RESPONSE
      // ============================================
      const safeTitle = reportTitle.replace(/[ /]/g, '_');
      const timestamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];
      const fileName = `Report_${safeTitle}_${timestamp}.pdf`;

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.setHeader('X-PDF-Generation-Time', totalTime.toString());
      res.setHeader('X-PDF-Size', pdfBuffer.length.toString());
      res.setHeader('X-PDF-Generator', 'Puppeteer');

      res.send(pdfBuffer);

    } catch (error) {
      console.error('✗ Unexpected error in report generation:', error);
      res.status(500).json({
        error: 'Unexpected error in report generation',
        details: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      });
    }
  }

}

module.exports = new ReportController();
