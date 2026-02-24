const path = require('path');
const fs = require('fs');

// Load .env only if it exists (useful for local dev)
const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
}
const http = require('http');
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const passport = require('passport');
const mongoose = require('mongoose');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');



// const { initSocket } = require('./socket'); // Disabled for Vercel 500 debugging

// ---------- BASIC INIT ----------
const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
// Bind to 0.0.0.0 by default so cloud hosts (Render, Heroku, etc.) can reach the server
const HOST = process.env.HOST || '0.0.0.0';

console.log('[Startup] Environment:', process.env.NODE_ENV || 'development');
console.log('[Startup] Vercel detected:', !!process.env.VERCEL);

// If running behind a reverse proxy (Render, Railway, Nginx, etc.),
// trust the proxy so secure cookies work correctly.
// Set TRUST_PROXY=1 in production if needed.
if (process.env.TRUST_PROXY === '1') {
  app.set('trust proxy', 1);
}

// ---------- DATABASE ----------
// In a serverless environment (like Vercel), we want to avoid top-level process.exit
// and ensure the connection is handled gracefully across function invocations.
let isConnected = false;
const connectDB = async () => {
  if (isConnected) return;
  try {
    if (!process.env.MONGODB_URI) {
      console.error('❌ MONGODB_URI not set');
      return;
    }
    await mongoose.connect(process.env.MONGODB_URI, { maxPoolSize: 10 });
    isConnected = true;
    console.log('MongoDB Atlas connected');
  } catch (err) {
    console.error('MongoDB connection failed:', err.message);
  }
};

// Initiate connection but don't block/exit
connectDB();

// ---------- PASSPORT CONFIG ----------
require('./config/passport')(passport);

// ---------- VIEW ENGINE ----------
app.set('view engine', 'ejs');
const viewsPath = path.join(__dirname, 'views');
console.log('[Startup] Views path:', viewsPath);
app.set('views', viewsPath);

// ---------- SECURITY MIDDLEWARE ----------
// Helmet adds security headers
app.use(helmet({
  contentSecurityPolicy: false, // Disable CSP for Monaco Editor CDN
  crossOriginEmbedderPolicy: false // Allow external resources
}));

// Rate limiting for authentication routes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 requests per windowMs
  message: 'Too many authentication attempts, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

// General API rate limiter
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // Limit each IP to 100 requests per minute
  message: 'Too many requests, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

// ---------- CORE MIDDLEWARE ----------
app.use((req, _res, next) => {
  next();
});
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '1mb' }));
app.use(cors());

// ---------- SESSION ----------
if (!process.env.SESSION_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('❌ SECURITY ERROR: SESSION_SECRET must be set in production');
    // For Vercel, we can't exit, but we should log clearly.
  } else {
    console.warn('⚠️  WARNING: Using insecure default SESSION_SECRET in development');
  }
}

const sessionConfig = {
  secret: process.env.SESSION_SECRET || 'dev-insecure-session-secret',
  resave: false,
  saveUninitialized: false,
  name: 'editSessionId',
  proxy: process.env.TRUST_PROXY === '1',
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
};
if (process.env.MONGODB_URI) {
  try {
    sessionConfig.store = MongoStore.create({
      mongoUrl: process.env.MONGODB_URI,
      touchAfter: 24 * 3600,
      crypto: {
        secret: process.env.SESSION_SECRET || 'dev-insecure-session-secret'
      }
    });
  } catch (err) {
    console.error('Failed to create MongoStore:', err.message);
  }
}
const sessionMiddleware = session(sessionConfig);
app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());

// ---------- LOCALS ----------
app.use((req, res, next) => {
  res.locals.user = req.user || null;
  res.locals.isAuthenticated = req.isAuthenticated && req.isAuthenticated();
  res.locals.appName = process.env.APP_NAME || 'Edit - Code Editor';
  res.locals.author = 'AtikshaRana';
  res.locals.currentYear = new Date().getFullYear();
  next();
});

// ---------- ROUTES (BEFORE STATIC) ----------
app.use('/', require('./routes/index'));
app.use('/auth', authLimiter, require('./routes/auth')); // Apply rate limiting to auth routes
app.use('/api/code', apiLimiter, require('./routes/api/code'));
app.use('/api/ai', apiLimiter, require('./routes/api/ai'));
app.use('/profile', apiLimiter, require('./routes/api/profile'));
app.use('/api/editor', apiLimiter, require('./routes/api/editor'));

// ---------- STATIC (AFTER PROTECTION) ----------
const staticPath = path.join(__dirname, '../public');
console.log('[Startup] Static path:', staticPath);
app.use(express.static(staticPath));

// Health check for Vercel deployment verification
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV
  });
});

// ---------- SOCKET.IO ----------
// initSocket(server, { sessionMiddleware }); // Disabled for Vercel

// ---------- 404 ----------
app.use((req, res) => {
  res.status(404).render('404', {
    title: 'Page Not Found',
    url: req.originalUrl
  });
});

// ---------- ERROR HANDLER ----------
app.use((err, req, res, _next) => {
  console.error('[Error Handler] Caught error:', err.message);

  const status = err.status || 500;
  const context = {
    title: 'Error',
    message: err.message || 'An unexpected error occurred.',
    error: process.env.NODE_ENV === 'development' ? err : {}
  };

  res.status(status);

  // Try to render the error page, but if EJS fails (e.g. missing file), fallback to JSON/Text
  res.render('error', context, (renderErr, html) => {
    if (renderErr) {
      console.warn('[Error Handler] Failed to render error view:', renderErr.message);
      return res.send(`<h1>Error ${status}</h1><p>${context.message}</p>`);
    }
    res.send(html);
  });
});

// ---------- EXPORT / START ----------
// Export app for Vercel
module.exports = app;

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log('=====================================');
    console.log(`🌐 Listening on port ${PORT} (bound to ${HOST})`);
    if (process.env.APP_URL) console.log(`🔗 Public URL: ${process.env.APP_URL}`);
    console.log(`👤 Author: AtikshaRana`);
    console.log('=====================================');
  });
}