const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const Handlebars = require('handlebars');
const pdfController = require('./controllers/pdfController');
const reportController = require('./controllers/reportController');
const timesheetController = require('./controllers/timesheetController');

const app = express();

// ============================================
// MIDDLEWARE
// ============================================

// Security headers
app.use(helmet({
  contentSecurityPolicy: false // Disable for PDF generation
}));

// CORS - allow requests from your CodeIgniter app
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
  methods: ['GET', 'POST'],
  credentials: true
}));

// Compression
app.use(compression());

// Logging
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined'));
}

// Body parsing with increased limits for large requests
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ============================================
// ROUTES
// ============================================
// ============================================

// Health check
app.get('/', (req, res) => {
  res.json({
    service: 'PDF Generation Service',
    status: 'running',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// Test endpoint
app.get('/api/pdf/test', (req, res) => pdfController.test(req, res));

// Main PDF generation endpoint
app.post('/api/pdf/razor-view-pdf', (req, res) =>
  pdfController.generatePdfWithRazorView(req, res)
);

// Browser pool cleanup
app.post('/api/pdf/cleanup-browser-pool', (req, res) =>
  pdfController.cleanupBrowserPool(req, res)
);

// ── Report routes ─────────────────────────────────────────
app.get('/api/report/test', (req, res) => reportController.test(req, res));
app.post('/api/report/generate-pdf', (req, res) => reportController.generateReportPdf(req, res));

// ── Timesheet routes ───────────────────────────────────────
app.get('/api/timesheet/test', (req, res) => timesheetController.test(req, res));
app.post('/api/timesheet/generate-pdf', (req, res) => timesheetController.generateTimesheetPdf(req, res));
// ============================================
// ERROR HANDLING
// ============================================

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.path} not found`,
    availableEndpoints: [
      'GET /',
      'GET /api/pdf/test',
      'POST /api/pdf/razor-view-pdf',
      'POST /api/pdf/cleanup-browser-pool',
      'GET /api/report/test',
      'POST /api/report/generate-pdf',
      'GET /api/timesheet/test',
      'POST /api/timesheet/generate-pdf',
    ]
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);

  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error',
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

module.exports = app;
