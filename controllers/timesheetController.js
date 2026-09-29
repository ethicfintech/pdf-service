'use strict';

const { PDFDocument } = require('pdf-lib');
const templateService = require('../services/templateService');
const pdfService = require('../services/pdfService');
const { generatePdf } = require('../services/lambdaService');
const { getReportTypeInfo } = require('../config/reportTypes');

class TimesheetController {

  // ── Transform raw work details into equipment timesheet format ──
  transformEquipmentData(rawData) {
    if (!rawData || !Array.isArray(rawData)) return [];

    const equipmentMap = new Map();
    const dayOfWeekIndex = { 0: 'sunday', 1: 'monday', 2: 'tuesday', 3: 'wednesday', 4: 'thursday', 5: 'friday', 6: 'saturday' };

    rawData.forEach(detail => {
      if (!detail.equipment_id) return;

      const key = detail.equipment_id;
      if (!equipmentMap.has(key)) {
        equipmentMap.set(key, {
          equipment_id: detail.equipment_id,
          equipment_name: detail.equipment_name || 'N/A',
          category: detail.category || 'N/A',
          location: detail.location || 'N/A',
          operator_name: detail.operator_name || 'N/A',
          status: detail.status || 'Active',
          remarks: detail.remarks || '',
          monday: 0, tuesday: 0, wednesday: 0, thursday: 0, friday: 0, saturday: 0, sunday: 0,
          total_hours: 0,
        });
      }

      const equipment = equipmentMap.get(key);

      // Parse work date and get day of week
      const workDate = new Date(detail.work_date);
      const dayIndex = workDate.getDay();
      const dayName = dayOfWeekIndex[dayIndex];

      // Get hours worked (normal_hours or total for that day)
      const hours = parseFloat(detail.normal_hours) || parseFloat(detail.day_total_hours) || 0;

      equipment[dayName] += hours;
      equipment.total_hours += hours;
    });

    return Array.from(equipmentMap.values()).sort((a, b) =>
      (a.equipment_id || '').localeCompare(b.equipment_id || '')
    );
  }

  // ── Calculate daily totals from equipment data ──
  calculateDailyTotals(equipmentData) {
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const totals = {
      total_monday: 0,
      total_tuesday: 0,
      total_wednesday: 0,
      total_thursday: 0,
      total_friday: 0,
      total_saturday: 0,
      total_sunday: 0,
      grand_total_hours: 0,
    };

    if (Array.isArray(equipmentData)) {
      equipmentData.forEach(item => {
        days.forEach((day, idx) => {
          const key = `total_${day}`;
          totals[key] += parseFloat(item[day]) || 0;
        });
        totals.grand_total_hours += parseFloat(item.total_hours) || 0;
      });
    }

    return totals;
  }

  transformTimesheetReportData(timesheet, kind) {
    const months = [];
    const codeKey = kind === 'equipment' ? 'equipment_code' : 'employee_code';
    const nameKey = kind === 'equipment' ? 'make_model' : 'employee_name';
    const personKey = kind === 'equipment' ? 'operator_driver' : 'position';

    const sumHours = (detail) =>
      parseFloat(detail.day_total_hours) || parseFloat(detail.normal_hours) || 0;

    if (Array.isArray(timesheet.report_data) && timesheet.report_data.length > 0) {
      timesheet.report_data.forEach((monthBlock) => {
        const days = (monthBlock.month_days || []).map((day) => ({
          date: day.date, day: day.day, day_name: day.day_name, is_weekend: day.is_weekend,
        }));

        let monthTotalHours = 0;
        let monthTotalAmount = 0;

        const rows = (monthBlock.timesheets || []).map((entry) => {
          const header = entry.header || {};
          const day_hours = {};
          (entry.details || []).forEach((detail) => {
            day_hours[detail.work_date] = (day_hours[detail.work_date] || 0) + sumHours(detail);
          });

          const totalHours = parseFloat(header.total_hours) || 0;
          const totalAmount = parseFloat(header.total_amount) || 0;
          monthTotalHours += totalHours;
          monthTotalAmount += totalAmount;

          return {
            timesheet_number: header.timesheet_number || '',
            code: header[codeKey] || '',
            name: header[nameKey] || '',
            person: header[personKey] || '',
            project_name: header.project_name || '',
            status: header.status || 'draft',
            day_hours,
            total_normal_hours: header.total_normal_hours || 0,
            total_overtime_hours: header.total_overtime_hours || 0,
            total_hours: header.total_hours || 0,
            hourly_rate: header.hourly_rate || 0,
            overtime_rate: header.overtime_rate || 0,
            total_amount: header.total_amount || 0,
          };
        });

        months.push({
          month_name: monthBlock.month_name,
          days,
          rows,
          total_hours: monthTotalHours,
          total_amount: monthTotalAmount,
        });
      });
    } else if (Array.isArray(timesheet.details) && timesheet.details.length > 0) {
      const header = timesheet.timesheet || {};
      const days = (timesheet.month_days || []).map((day) => ({
        date: day.date, day: day.day, day_name: day.day_name, is_weekend: day.is_weekend,
      }));

      const day_hours = {};
      timesheet.details.forEach((detail) => {
        day_hours[detail.work_date] = (day_hours[detail.work_date] || 0) + sumHours(detail);
      });

      months.push({
        month_name: (header.month && header.year) ? `${header.month}/${header.year}` : '',
        days,
        rows: [{
          timesheet_number: header.timesheet_number || '',
          code: header[codeKey] || (timesheet.details[0] && timesheet.details[0][codeKey]) || '',
          name: header[nameKey] || '',
          person: header[personKey] || '',
          project_name: header.name || '',
          status: header.status || 'draft',
          day_hours,
          total_normal_hours: header.total_normal_hours || 0,
          total_overtime_hours: header.total_overtime_hours || 0,
          total_hours: header.total_hours || 0,
          hourly_rate: header.hourly_rate || 0,
          overtime_rate: header.overtime_rate || 0,
          total_amount: header.total_amount || 0,
        }],
        total_hours: parseFloat(header.total_hours) || 0,
        total_amount: parseFloat(header.total_amount) || 0,
      });
    }

    return months;
  }

  // ── GET /api/timesheet/test ──────────────────────────────────
  async test(req, res) {
    res.json({
      message: 'Timesheet API is working',
      url: req.path,
      timestamp: new Date().toISOString(),
    });
  }

  // ── POST /api/timesheet/generate-pdf ────────────────────────
  async generateTimesheetPdf(req, res) {
    const startTime = Date.now();

    try {
      const timesheet = req.body;

      if (!timesheet) {
        return res.status(400).json({ error: 'Request body is required' });
      }

      console.log('timesheet_dataaaaaaa', timesheet);
      // PHP sends strings — parse to int
      timesheet.report_type = parseInt(timesheet.report_type, 10) || 20;
      timesheet.template_no = parseInt(timesheet.template_no, 10) || 1;

      // report_type  →  { name, label }
      // Template file = name + template_no  →  e.g. manpower_timesheet_report1.hbs
      const reportTypeInfo = getReportTypeInfo(timesheet.report_type);
      const templateFile = `${reportTypeInfo.name}${timesheet.template_no}`;
      const reportTitle = timesheet.report_title || reportTypeInfo.label;

      console.log('\n=== Timesheet PDF Generation Started ===');
      console.log(`Type: ${timesheet.report_type} (${reportTypeInfo.label}) | Template: ${templateFile}`);

      // ============================================
      // PHASE 1: PARALLEL PREPROCESSING
      // ============================================
      const tasks = [];

      // ── Watermark CSS ────────────────────────────────────
      if (timesheet.UseBGWatermark && timesheet.WatermarkUrl) {
        tasks.push(
          pdfService
            .generateWatermarkCss(timesheet.WatermarkUrl, timesheet.WatermarkOpacity || 0.7)
            .then((css) => {
              timesheet.WatermarkCss = css;
              console.log(`✓ Watermark CSS generated (opacity: ${timesheet.WatermarkOpacity || 0.7})`);
            })
            .catch((err) => console.error('✗ Watermark failed:', err.message)),
        );
      }

      // ── Company logo → base64 ────────────────────────────
      if (timesheet.Companylogo && String(timesheet.Companylogo).startsWith('http')) {
        tasks.push(
          pdfService
            .getHighQualityImageBytes(timesheet.Companylogo)
            .then((buf) => {
              if (buf) {
                timesheet.Companylogo = `data:image/jpeg;base64,${buf.toString('base64')}`;
                console.log('✓ Logo converted to base64');
              }
            })
            .catch((err) => {
              console.error('✗ Logo failed:', err.message);
              timesheet.Companylogo = '';
            }),
        );
      }

      // ── Letterhead background → base64 ──────────────────
      if (timesheet.LetterheadImageUrl && String(timesheet.LetterheadImageUrl).startsWith('http')) {
        tasks.push(
          pdfService
            .getHighQualityImageBytes(timesheet.LetterheadImageUrl)
            .then((buf) => {
              if (buf) {
                timesheet.LetterheadImageUrl = `data:image/jpeg;base64,${buf.toString('base64')}`;
                console.log('✓ Letterhead converted to base64');
              }
            })
            .catch((err) => {
              console.error('✗ Letterhead failed:', err.message);
              timesheet.LetterheadImageUrl = '';
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
      timesheet.report_title = reportTitle;
      timesheet.report_type_label = reportTypeInfo.label;

      if (timesheet.report_type === 20 || timesheet.report_type === 21) {
        const kind = timesheet.report_type === 21 ? 'equipment' : 'manpower';
        timesheet.months = this.transformTimesheetReportData(timesheet, kind);
        timesheet.grand_total_hours = timesheet.months.reduce((sum, month) => sum + (month.total_hours || 0), 0);
        timesheet.grand_total_amount = timesheet.months.reduce((sum, month) => sum + (month.total_amount || 0), 0);

        if (kind === 'equipment') {
          timesheet.total_equipment = timesheet.months.reduce((sum, month) => sum + month.rows.length, 0);
        } else {
          timesheet.total_employees = timesheet.months.reduce((sum, month) => sum + month.rows.length, 0);
        }
      }

      // ── Transform equipment data if needed ────────────────
      if (timesheet.report_type === 21) {
        const details = timesheet.details || timesheet.equipment_details || timesheet.work_details || [];
        if (Array.isArray(details) && details.length > 0) {
          const equipmentData = this.transformEquipmentData(details);
          const dailyTotals = this.calculateDailyTotals(equipmentData);

          timesheet.equipment_data = equipmentData;
          Object.assign(timesheet, dailyTotals);

          timesheet.total_equipment = equipmentData.length;
          timesheet.show_summary = true;

          console.log(`✓ Equipment data transformed: ${equipmentData.length} items | Grand total: ${dailyTotals.grand_total_hours} hrs`);
        } else {
          console.warn('⚠ No equipment details found in request');
        }
      }

      try {
        htmlContent = await templateService.renderTimesheetToString(templateFile, timesheet);
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
      const orientation = (timesheet.orientation || 'portrait').toLowerCase();
      const paperSize = timesheet.paper_size || 'A4';

      const pdfOptions = {
        printBackground: true,
        omitBackground: false,
        preferCSSPageSize: true,
        scale: 1.0,
        format: paperSize,
        landscape: orientation === 'landscape',
      };

      // ── Header / footer images (conditional) ────────────
      const useHeaderFooter = timesheet.UseHeaderFooter && timesheet.FooterImageUrl;

      if (useHeaderFooter) {
        pdfOptions.displayHeaderFooter = true;
        pdfOptions.margin = {
          top: timesheet.margin_top || '120px',
          bottom: timesheet.margin_bottom || '60px',
          left: '0px',
          right: '0px',
        };

        const hfTasks = [];

        if (timesheet.FooterImageUrl) {
          hfTasks.push(
            pdfService.footerGenerate(timesheet.FooterImageUrl).then((html) => {
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
        const company = String(timesheet.company_name || '').trim();

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
      console.log('=== Timesheet PDF Generation Completed ===\n');

      // ============================================
      // PHASE 5: SEND RESPONSE
      // ============================================
      const safeTitle = reportTitle.replace(/[ /]/g, '_');
      const timestamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];
      const fileName = `Timesheet_${safeTitle}_${timestamp}.pdf`;

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.setHeader('X-PDF-Generation-Time', totalTime.toString());
      res.setHeader('X-PDF-Size', pdfBuffer.length.toString());
      res.setHeader('X-PDF-Generator', 'Puppeteer');

      res.send(pdfBuffer);

    } catch (error) {
      console.error('✗ Unexpected error in timesheet generation:', error);
      res.status(500).json({
        error: 'Unexpected error in timesheet generation',
        details: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      });
    }
  }

}

module.exports = new TimesheetController();

///test commit
