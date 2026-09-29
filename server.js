require('dotenv').config();
const app = require('./app');

const PORT = process.env.PORT || 3000;

// ============================================
// SERVER STARTUP
// ============================================

async function startServer() {
  try {
    console.log('='.repeat(50));
    console.log('PDF Generation Service Starting...');
    console.log('PDF Mode: Puppeteer Service');
    console.log('='.repeat(50));

    // Start Express server
    const server = app.listen(PORT, () => {
      console.log('\n' + '='.repeat(50));
      console.log(`✓ Server running on port ${PORT}`);
      console.log(`✓ Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`✓ URL: http://localhost:${PORT}`);
      console.log(`✓ PDF Generator: Puppeteer Service`);
      console.log('='.repeat(50) + '\n');

      console.log('Available endpoints:');
      console.log(`  GET  http://localhost:${PORT}/`);
      console.log(`  GET  http://localhost:${PORT}/api/pdf/test`);
      console.log(`  POST http://localhost:${PORT}/api/pdf/razor-view-pdf`);
      console.log(`  GET  http://localhost:${PORT}/api/report/test`);
      console.log(`  POST http://localhost:${PORT}/api/report/generate-pdf`);
      console.log(`  GET  http://localhost:${PORT}/api/timesheet/test`);
      console.log(`  POST http://localhost:${PORT}/api/timesheet/generate-pdf`);
      console.log('\nServer is ready to accept requests!\n');
    });

    server.on('error', (error) => {
      console.error('Failed to start server:', error);
      process.exitCode = 1;
    });

    // Graceful shutdown
    const gracefulShutdown = async (signal) => {
      console.log(`\n${signal} received. Starting graceful shutdown...`);
      
      server.close(() => {
        console.log('HTTP server closed');
        console.log('Graceful shutdown completed');
        process.exit(0);
      });

      // Force shutdown after 10 seconds
      setTimeout(() => {
        console.error('Could not close connections in time, forcefully shutting down');
        process.exit(1);
      }, 10000);
    };

    // Handle shutdown signals
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    // Handle uncaught errors
    process.on('uncaughtException', (error) => {
      console.error('Uncaught Exception:', error);
      gracefulShutdown('UNCAUGHT_EXCEPTION');
    });

    process.on('unhandledRejection', (reason, promise) => {
      console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    });

  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Start the server
startServer();