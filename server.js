try { require('dotenv').config(); } catch { /* dotenv optional */ }
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Database Setup (with proper pool config) ────────────────────────────────
const useSSL =
  process.env.PGSSL === 'true' ||
  (process.env.DATABASE_URL && /supabase|render|amazonaws|neon|heroku/i.test(process.env.DATABASE_URL));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
  max: 20,
  min: 2,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        full_name TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS interns (
        id SERIAL PRIMARY KEY,
        intern_id TEXT UNIQUE NOT NULL,
        full_name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT,
        department TEXT NOT NULL,
        start_date DATE NOT NULL,
        avatar_color TEXT DEFAULT '#00e676',
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS weekly_reports (
        id SERIAL PRIMARY KEY,
        intern_id INTEGER NOT NULL REFERENCES interns(id) ON DELETE CASCADE,
        week_start DATE NOT NULL,
        week_end DATE NOT NULL,
        summary TEXT NOT NULL,
        challenges TEXT,
        plans_next_week TEXT,
        hours_worked REAL DEFAULT 0,
        mood TEXT DEFAULT 'neutral',
        status TEXT DEFAULT 'submitted',
        admin_feedback TEXT,
        submitted_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id SERIAL PRIMARY KEY,
        intern_id INTEGER NOT NULL REFERENCES interns(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT,
        category TEXT DEFAULT 'general',
        priority TEXT DEFAULT 'medium',
        status TEXT DEFAULT 'todo',
        due_date DATE,
        completed_at TIMESTAMPTZ,
        score INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS score INTEGER;
      ALTER TABLE interns ADD COLUMN IF NOT EXISTS password TEXT;

      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        user_type TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        message TEXT NOT NULL,
        is_read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Password reset tokens (interns only). We store a SHA-256 hash of the
      -- token, never the token itself, so a DB leak can't be used to reset.
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id SERIAL PRIMARY KEY,
        intern_id INTEGER NOT NULL REFERENCES interns(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Create indexes for performance
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_interns_status ON interns(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_intern_id ON tasks(intern_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_intern_status ON tasks(intern_id, status);
      CREATE INDEX IF NOT EXISTS idx_reports_intern_id ON weekly_reports(intern_id);
      CREATE INDEX IF NOT EXISTS idx_reports_status ON weekly_reports(status);
      CREATE INDEX IF NOT EXISTS idx_notifications_type_user ON notifications(user_type, user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_reset_tokens_hash ON password_reset_tokens(token_hash);
      CREATE INDEX IF NOT EXISTS idx_reset_tokens_intern ON password_reset_tokens(intern_id);
    `);

    // Seed default admin (use env vars if available)
    const adminCheck = await client.query('SELECT id FROM admins WHERE username = $1', [process.env.ADMIN_USER || 'admin']);
    if (adminCheck.rows.length === 0) {
      const hash = await bcrypt.hash(process.env.ADMIN_PASS || 'admin123', 12);
      await client.query('INSERT INTO admins (username, password, full_name) VALUES ($1, $2, $3)',
        [process.env.ADMIN_USER || 'admin', hash, 'System Administrator']);
    }
    console.log('  ✓ Database initialized');
  } finally {
    client.release();
  }
}

// Helpers
async function query(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows;
}

async function queryOne(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows[0] || null;
}

function safeError(e) {
  console.error(e);
  return { error: 'Something went wrong' };
}

// ── Input Validation ────────────────────────────────────────────────────────
function sanitize(str, maxLen = 500) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, maxLen);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidDate(d) {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d));
}

function isPositiveInt(val) {
  return Number.isInteger(Number(val)) && Number(val) > 0;
}

const VALID_STATUSES = {
  intern: ['pending', 'active', 'completed', 'suspended'],
  task: ['todo', 'in_progress', 'review', 'completed'],
  report: ['draft', 'submitted', 'reviewed'],
  mood: ['great', 'good', 'neutral', 'struggling'],
  priority: ['low', 'medium', 'high', 'critical'],
  category: ['General', 'Development', 'Research', 'Design', 'Testing', 'Documentation', 'Meeting'],
};

// ── Password Reset Helpers ───────────────────────────────────────────────────
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Create a single-use reset token for an intern. Any outstanding tokens for the
// same intern are invalidated first so only the most recent link works.
async function createResetToken(internId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
  await pool.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE intern_id = $1 AND used_at IS NULL', [internId]);
  await pool.query('INSERT INTO password_reset_tokens (intern_id, token_hash, expires_at) VALUES ($1,$2,$3)', [internId, hashToken(token), expiresAt]);
  return token;
}

function resetLinkFor(req, token) {
  const base = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  return `${base.replace(/\/$/, '')}/?reset_token=${token}`;
}

// Optional SMTP mailer. Only initialised when SMTP_HOST is configured; otherwise
// the reset flow falls back to admin-assisted delivery.
let _mailer; // undefined = not tried, null/false = unavailable, object = transporter
function getMailer() {
  if (_mailer !== undefined) return _mailer;
  if (!process.env.SMTP_HOST) { _mailer = null; return _mailer; }
  try {
    const nodemailer = require('nodemailer');
    const port = parseInt(process.env.SMTP_PORT) || 587;
    _mailer = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: process.env.SMTP_SECURE === 'true' || port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  } catch (e) {
    console.warn('  ⚠ Email delivery disabled:', e.message);
    _mailer = null;
  }
  return _mailer;
}

async function sendResetEmail(to, link) {
  const mailer = getMailer();
  if (!mailer) return false;
  await mailer.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@indic8.app',
    to,
    subject: 'indic8 — Reset your password',
    text: `You requested a password reset for your indic8 intern account.\n\n`
      + `Open this link to set a new password (valid for 1 hour, single use):\n${link}\n\n`
      + `If you didn't request this, you can safely ignore this email — your password won't change.`,
  });
  return true;
}

// ── Middleware ───────────────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'indic8-dev-only-secret-' + Math.random(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    httpOnly: true,
  }
}));

// Rate limiting
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts, try again in 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, slow down' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/', apiLimiter);

function requireAdmin(req, res, next) {
  if (req.session && req.session.adminId) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── Admin Auth ──────────────────────────────────────────────────────────────
app.post('/api/admin/login', loginLimiter, async (req, res) => {
  try {
    const username = sanitize(req.body.username, 50);
    const password = req.body.password || '';
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const admin = await queryOne('SELECT id, username, password, full_name FROM admins WHERE username = $1', [username]);
    if (!admin || !(await bcrypt.compare(password, admin.password))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    req.session.adminId = admin.id;
    req.session.adminName = admin.full_name;
    res.json({ success: true, name: admin.full_name });
  } catch (e) { res.status(500).json(safeError(e)); }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {});
  res.json({ success: true });
});

app.get('/api/session', async (req, res) => {
  if (req.session.adminId) return res.json({ role: 'admin', name: req.session.adminName });
  if (req.session.internId) {
    const intern = await queryOne('SELECT id, full_name, department, avatar_color, status FROM interns WHERE id = $1', [req.session.internId]);
    if (intern) {
      return res.json({
        role: 'intern',
        id: intern.id,
        name: intern.full_name,
        department: intern.department,
        avatarColor: intern.avatar_color,
        status: intern.status,
      });
    }
  }
  res.json({ role: null });
});

// ── Intern Auth ────────────────────────────────────────────────────────────
app.post('/api/intern/signup', loginLimiter, async (req, res) => {
  try {
    const full_name = sanitize(req.body.full_name, 100);
    const email = sanitize(req.body.email, 100).toLowerCase();
    const password = req.body.password || '';
    const department = sanitize(req.body.department, 50);

    if (!full_name || full_name.length < 2) return res.status(400).json({ error: 'Valid name required (at least 2 characters)' });
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Valid email required' });
    if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (!department) return res.status(400).json({ error: 'Department required' });

    const intern_id = 'INT-' + Date.now().toString(36).toUpperCase();
    const colors = ['#00e676','#00bcd4','#7c4dff','#ff9100','#ff5252','#64ffda'];
    const avatar_color = colors[Math.floor(Math.random() * colors.length)];
    const hash = await bcrypt.hash(password, 12);
    const start_date = new Date().toISOString().slice(0, 10);

    const result = await queryOne(
      'INSERT INTO interns (intern_id, full_name, email, password, department, start_date, avatar_color, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [intern_id, full_name, email, hash, department, start_date, avatar_color, 'pending']
    );

    await pool.query('INSERT INTO notifications (user_type, user_id, message) VALUES ($1,$2,$3)',
      ['admin', 1, `New signup: ${full_name} (${department}) is awaiting approval`]);

    res.json({ success: true, message: 'Signup successful! Please wait for admin approval.' });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Email already registered' });
    res.status(500).json(safeError(e));
  }
});

app.post('/api/intern/login', loginLimiter, async (req, res) => {
  try {
    const email = sanitize(req.body.email, 100).toLowerCase();
    const password = req.body.password || '';
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const intern = await queryOne('SELECT id, intern_id, full_name, email, password, department, avatar_color, status FROM interns WHERE email = $1', [email]);
    if (!intern || !intern.password || !(await bcrypt.compare(password, intern.password))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    req.session.internId = intern.id;
    req.session.internName = intern.full_name;
    req.session.internStatus = intern.status;
    res.json({
      success: true,
      id: intern.id,
      name: intern.full_name,
      department: intern.department,
      avatarColor: intern.avatar_color,
      status: intern.status,
    });
  } catch (e) { res.status(500).json(safeError(e)); }
});

// ── Intern Password Reset (interns only — never touches admin accounts) ──────

// Step 1: intern requests a reset by email. Always responds generically so the
// endpoint can't be used to discover which emails are registered.
app.post('/api/intern/forgot-password', loginLimiter, async (req, res) => {
  try {
    const email = sanitize(req.body.email, 100).toLowerCase();
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Valid email required' });

    const emailConfigured = !!process.env.SMTP_HOST;
    const message = emailConfigured
      ? 'If an account exists for that email, a password reset link has been sent.'
      : 'If an account exists for that email, your administrator has been notified to help you reset your password.';

    // Only interns can reset here — admins are never looked up.
    const intern = await queryOne('SELECT id, full_name, email FROM interns WHERE email = $1', [email]);
    if (intern) {
      const token = await createResetToken(intern.id);
      const link = resetLinkFor(req, token);
      let emailed = false;
      try { emailed = await sendResetEmail(intern.email, link); }
      catch (err) { console.error('Reset email failed:', err.message); }
      if (!emailed) {
        // Fallback delivery: notify the admin, who can generate/hand over a link.
        await pool.query('INSERT INTO notifications (user_type, user_id, message) VALUES ($1,$2,$3)',
          ['admin', 1, `${intern.full_name} requested a password reset — open their profile to generate a reset link.`]);
        if (process.env.NODE_ENV !== 'production') console.log(`[password-reset] ${intern.email}: ${link}`);
      }
    }
    res.json({ success: true, message });
  } catch (e) { res.status(500).json(safeError(e)); }
});

// Step 2 (optional): check a token is still valid before showing the form.
app.get('/api/intern/reset-password/verify', async (req, res) => {
  try {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    if (!token) return res.json({ valid: false });
    const row = await queryOne(
      'SELECT id FROM password_reset_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()',
      [hashToken(token)]);
    res.json({ valid: !!row });
  } catch (e) { res.status(500).json(safeError(e)); }
});

// Step 3: consume the token and set the new password.
app.post('/api/intern/reset-password', loginLimiter, async (req, res) => {
  try {
    const token = typeof req.body.token === 'string' ? req.body.token : '';
    const password = req.body.password || '';
    if (!token) return res.status(400).json({ error: 'Invalid reset link' });
    if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const row = await queryOne(
      'SELECT id, intern_id FROM password_reset_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()',
      [hashToken(token)]);
    if (!row) return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });

    const hash = await bcrypt.hash(password, 12);
    await pool.query('UPDATE interns SET password = $1 WHERE id = $2', [hash, row.intern_id]);
    // Burn this and any sibling tokens for the intern so the link is single-use.
    await pool.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE intern_id = $1 AND used_at IS NULL', [row.intern_id]);
    res.json({ success: true, message: 'Your password has been reset. You can now sign in.' });
  } catch (e) { res.status(500).json(safeError(e)); }
});

// ── Public Intern Routes (no login required) ────────────────────────────────

app.get('/api/interns', async (req, res) => {
  try {
    const interns = await query("SELECT id, intern_id, full_name, department, avatar_color FROM interns WHERE status = 'active' ORDER BY full_name");
    res.json(interns);
  } catch (e) { res.status(500).json(safeError(e)); }
});

app.get('/api/interns/:id', async (req, res) => {
  try {
    if (!isPositiveInt(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const intern = await queryOne("SELECT id, intern_id, full_name, email, department, start_date, avatar_color, status FROM interns WHERE id = $1", [req.params.id]);
    if (!intern) return res.status(404).json({ error: 'Intern not found' });
    res.json(intern);
  } catch (e) { res.status(500).json(safeError(e)); }
});

app.post('/api/interns/:id/reports', async (req, res) => {
  try {
    if (!isPositiveInt(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const intern = await queryOne('SELECT id, full_name FROM interns WHERE id = $1', [req.params.id]);
    if (!intern) return res.status(404).json({ error: 'Intern not found' });

    const week_start = req.body.week_start;
    const week_end = req.body.week_end;
    const summary = sanitize(req.body.summary, 5000);
    const challenges = sanitize(req.body.challenges, 3000);
    const plans_next_week = sanitize(req.body.plans_next_week, 3000);
    const hours_worked = Math.max(0, Math.min(168, parseFloat(req.body.hours_worked) || 0));
    const mood = VALID_STATUSES.mood.includes(req.body.mood) ? req.body.mood : 'neutral';
    const status = VALID_STATUSES.report.includes(req.body.status) ? req.body.status : 'submitted';

    if (!isValidDate(week_start) || !isValidDate(week_end)) return res.status(400).json({ error: 'Invalid dates' });
    if (!summary) return res.status(400).json({ error: 'Summary is required' });

    const result = await queryOne(
      `INSERT INTO weekly_reports (intern_id, week_start, week_end, summary, challenges, plans_next_week, hours_worked, mood, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [intern.id, week_start, week_end, summary, challenges, plans_next_week, hours_worked, mood, status]
    );
    if (status !== 'draft') {
      await pool.query('INSERT INTO notifications (user_type, user_id, message) VALUES ($1,$2,$3)',
        ['admin', 1, `${intern.full_name} submitted a weekly report (${week_start} to ${week_end})`]);
    }
    res.json({ success: true, id: result.id });
  } catch (e) { res.status(500).json(safeError(e)); }
});

app.get('/api/interns/:id/reports', async (req, res) => {
  try {
    if (!isPositiveInt(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const reports = await query('SELECT id, intern_id, week_start, week_end, summary, challenges, plans_next_week, hours_worked, mood, status, admin_feedback, submitted_at FROM weekly_reports WHERE intern_id = $1 ORDER BY submitted_at DESC LIMIT 50', [req.params.id]);
    res.json(reports);
  } catch (e) { res.status(500).json(safeError(e)); }
});

app.get('/api/interns/:id/tasks', async (req, res) => {
  try {
    if (!isPositiveInt(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const tasks = await query('SELECT id, intern_id, title, description, category, priority, status, due_date, completed_at, score, created_at FROM tasks WHERE intern_id = $1 ORDER BY created_at DESC LIMIT 100', [req.params.id]);
    res.json(tasks);
  } catch (e) { res.status(500).json(safeError(e)); }
});

app.put('/api/interns/:internId/tasks/:taskId/status', async (req, res) => {
  try {
    if (!isPositiveInt(req.params.internId) || !isPositiveInt(req.params.taskId)) return res.status(400).json({ error: 'Invalid ID' });
    const { status } = req.body;
    if (!VALID_STATUSES.task.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const existing = await queryOne('SELECT status FROM tasks WHERE id = $1 AND intern_id = $2', [req.params.taskId, req.params.internId]);
    if (!existing) return res.status(404).json({ error: 'Task not found' });
    if (existing.status === 'completed') return res.status(400).json({ error: 'Completed tasks cannot be changed. Contact your admin.' });
    const completed_at = status === 'completed' ? new Date().toISOString() : null;

    // Clear score when un-completing a task (admin will re-score)
    const updated = await queryOne(
      `UPDATE tasks SET status=$1, completed_at=$2, score = CASE WHEN $1 = 'completed' THEN score ELSE NULL END WHERE id=$3 AND intern_id=$4
       RETURNING id, title, (SELECT full_name FROM interns WHERE id = $4) as intern_name`,
      [status, completed_at, req.params.taskId, req.params.internId]
    );
    if (!updated) return res.status(404).json({ error: 'Task not found' });

    if (status === 'completed') {
      await pool.query('INSERT INTO notifications (user_type, user_id, message) VALUES ($1,$2,$3)',
        ['admin', 1, `${updated.intern_name} completed task: ${updated.title}`]);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json(safeError(e)); }
});

// Intern stats — combined into 2 queries instead of 5
app.get('/api/interns/:id/stats', async (req, res) => {
  try {
    if (!isPositiveInt(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const id = req.params.id;

    const [counts, recentTasks] = await Promise.all([
      queryOne(`
        SELECT
          (SELECT COUNT(*) FROM tasks WHERE intern_id = $1) as total_tasks,
          (SELECT COUNT(*) FROM tasks WHERE intern_id = $1 AND status = 'completed') as completed_tasks,
          (SELECT COUNT(*) FROM tasks WHERE intern_id = $1 AND status IN ('todo','in_progress')) as pending_tasks,
          (SELECT COUNT(*) FROM weekly_reports WHERE intern_id = $1) as total_reports,
          (SELECT ROUND(AVG(score)) FROM tasks WHERE intern_id = $1 AND score IS NOT NULL) as avg_score
      `, [id]),
      query('SELECT id, title, category, priority, status, due_date, score, created_at FROM tasks WHERE intern_id = $1 ORDER BY created_at DESC LIMIT 5', [id])
    ]);

    res.json({
      totalTasks: +counts.total_tasks,
      completedTasks: +counts.completed_tasks,
      pendingTasks: +counts.pending_tasks,
      totalReports: +counts.total_reports,
      avgScore: counts.avg_score ? +counts.avg_score : null,
      recentTasks
    });
  } catch (e) { res.status(500).json(safeError(e)); }
});

// ── Intern Performance Analytics ───────────────────────────────────────────
app.get('/api/interns/:id/performance', async (req, res) => {
  try {
    if (!isPositiveInt(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const id = req.params.id;

    const [overview, scoredTasks, categoryStats, monthlyTrend] = await Promise.all([
      queryOne(`
        SELECT
          COUNT(*) FILTER (WHERE score IS NOT NULL) as scored_tasks,
          ROUND(AVG(score) FILTER (WHERE score IS NOT NULL)) as avg_score,
          MIN(score) FILTER (WHERE score IS NOT NULL) as lowest_score,
          MAX(score) FILTER (WHERE score IS NOT NULL) as highest_score,
          COUNT(*) FILTER (WHERE score >= 80) as above_benchmark,
          COUNT(*) FILTER (WHERE score IS NOT NULL AND score < 80) as below_benchmark
        FROM tasks WHERE intern_id = $1
      `, [id]),
      query(`
        SELECT id, title, category, priority, score, completed_at, created_at
        FROM tasks WHERE intern_id = $1 AND score IS NOT NULL
        ORDER BY completed_at DESC LIMIT 50
      `, [id]),
      query(`
        SELECT category,
          COUNT(*) as count,
          ROUND(AVG(score)) as avg_score,
          MIN(score) as min_score,
          MAX(score) as max_score
        FROM tasks WHERE intern_id = $1 AND score IS NOT NULL
        GROUP BY category ORDER BY avg_score DESC
      `, [id]),
      query(`
        SELECT
          TO_CHAR(completed_at, 'YYYY-MM') as month,
          COUNT(*) as count,
          ROUND(AVG(score)) as avg_score
        FROM tasks WHERE intern_id = $1 AND score IS NOT NULL AND completed_at IS NOT NULL
        GROUP BY TO_CHAR(completed_at, 'YYYY-MM')
        ORDER BY month ASC LIMIT 12
      `, [id]),
    ]);

    res.json({
      overview: {
        scoredTasks: +overview.scored_tasks,
        avgScore: overview.avg_score ? +overview.avg_score : null,
        lowestScore: overview.lowest_score != null ? +overview.lowest_score : null,
        highestScore: overview.highest_score != null ? +overview.highest_score : null,
        aboveBenchmark: +overview.above_benchmark,
        belowBenchmark: +overview.below_benchmark,
      },
      scoredTasks,
      categoryStats,
      monthlyTrend,
    });
  } catch (e) { res.status(500).json(safeError(e)); }
});

// ── Admin Routes (login required) ──────────────────────────────────────────

app.post('/api/admin/interns', requireAdmin, async (req, res) => {
  try {
    const full_name = sanitize(req.body.full_name, 100);
    const email = sanitize(req.body.email, 100).toLowerCase();
    const department = sanitize(req.body.department, 50);
    const start_date = req.body.start_date;

    if (!full_name || full_name.length < 2) return res.status(400).json({ error: 'Valid name required' });
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Valid email required' });
    if (!department) return res.status(400).json({ error: 'Department required' });
    if (!isValidDate(start_date)) return res.status(400).json({ error: 'Valid start date required' });

    const intern_id = 'INT-' + Date.now().toString(36).toUpperCase();
    const colors = ['#00e676','#00bcd4','#7c4dff','#ff9100','#ff5252','#64ffda'];
    const avatar_color = colors[Math.floor(Math.random() * colors.length)];
    await pool.query('INSERT INTO interns (intern_id, full_name, email, department, start_date, avatar_color) VALUES ($1,$2,$3,$4,$5,$6)',
      [intern_id, full_name, email, department, start_date, avatar_color]);
    res.json({ success: true, intern_id });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Email already registered' });
    res.status(500).json(safeError(e));
  }
});

// Admin interns list — optimized with JOINs
app.get('/api/admin/interns', requireAdmin, async (req, res) => {
  try {
    const interns = await query(`
      SELECT i.*,
        COALESCE(t.total_tasks, 0) as total_tasks,
        COALESCE(t.completed_tasks, 0) as completed_tasks,
        t.avg_score,
        COALESCE(r.total_reports, 0) as total_reports
      FROM interns i
      LEFT JOIN (
        SELECT intern_id, COUNT(*) as total_tasks,
          COUNT(*) FILTER (WHERE status = 'completed') as completed_tasks,
          ROUND(AVG(score) FILTER (WHERE score IS NOT NULL)) as avg_score
        FROM tasks GROUP BY intern_id
      ) t ON t.intern_id = i.id
      LEFT JOIN (
        SELECT intern_id, COUNT(*) as total_reports FROM weekly_reports GROUP BY intern_id
      ) r ON r.intern_id = i.id
      ORDER BY i.created_at DESC
    `);
    res.json(interns);
  } catch (e) { res.status(500).json(safeError(e)); }
});

app.get('/api/admin/interns/:id', requireAdmin, async (req, res) => {
  try {
    if (!isPositiveInt(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const intern = await queryOne('SELECT id, intern_id, full_name, email, department, start_date, avatar_color, status, created_at FROM interns WHERE id = $1', [req.params.id]);
    if (!intern) return res.status(404).json({ error: 'Not found' });
    const [tasks, reports, scoreAgg] = await Promise.all([
      query('SELECT id, title, category, priority, status, due_date, completed_at, score, created_at FROM tasks WHERE intern_id = $1 ORDER BY created_at DESC LIMIT 50', [req.params.id]),
      query('SELECT id, week_start, week_end, summary, mood, status, submitted_at FROM weekly_reports WHERE intern_id = $1 ORDER BY submitted_at DESC LIMIT 50', [req.params.id]),
      queryOne(`SELECT COUNT(*) FILTER (WHERE score IS NOT NULL) as scored_tasks, ROUND(AVG(score) FILTER (WHERE score IS NOT NULL)) as avg_score FROM tasks WHERE intern_id = $1`, [req.params.id]),
    ]);
    res.json({
      intern,
      tasks,
      reports,
      scores: {
        scoredTasks: +scoreAgg.scored_tasks,
        avgScore: scoreAgg.avg_score != null ? +scoreAgg.avg_score : null,
      },
    });
  } catch (e) { res.status(500).json(safeError(e)); }
});

app.put('/api/admin/interns/:id/status', requireAdmin, async (req, res) => {
  try {
    if (!isPositiveInt(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    if (!VALID_STATUSES.intern.includes(req.body.status)) return res.status(400).json({ error: 'Invalid status' });
    const intern = await queryOne('SELECT id, full_name, status FROM interns WHERE id = $1', [req.params.id]);
    if (!intern) return res.status(404).json({ error: 'Intern not found' });
    await pool.query('UPDATE interns SET status = $1 WHERE id = $2', [req.body.status, req.params.id]);
    if (intern.status === 'pending' && req.body.status === 'active') {
      await pool.query('INSERT INTO notifications (user_type, user_id, message) VALUES ($1,$2,$3)',
        ['intern', intern.id, 'Your account has been approved! You can now access your dashboard.']);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json(safeError(e)); }
});

// Admin-assisted password reset: generate a one-time link to hand to the intern.
// Always available (works even without email configured).
app.post('/api/admin/interns/:id/reset-link', requireAdmin, async (req, res) => {
  try {
    if (!isPositiveInt(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const intern = await queryOne('SELECT id, full_name, email FROM interns WHERE id = $1', [req.params.id]);
    if (!intern) return res.status(404).json({ error: 'Intern not found' });
    const token = await createResetToken(intern.id);
    res.json({ success: true, link: resetLinkFor(req, token), email: intern.email, expiresInMinutes: RESET_TOKEN_TTL_MS / 60000 });
  } catch (e) { res.status(500).json(safeError(e)); }
});

app.get('/api/admin/reports', requireAdmin, async (req, res) => {
  try {
    const reports = await query(`
      SELECT wr.id, wr.intern_id, wr.week_start, wr.week_end, wr.summary, wr.challenges, wr.plans_next_week,
             wr.hours_worked, wr.mood, wr.status, wr.admin_feedback, wr.submitted_at,
             i.full_name as intern_name, i.department, i.avatar_color
      FROM weekly_reports wr
      JOIN interns i ON wr.intern_id = i.id
      ORDER BY wr.submitted_at DESC
      LIMIT 200
    `);
    res.json(reports);
  } catch (e) { res.status(500).json(safeError(e)); }
});

app.put('/api/admin/reports/:id', requireAdmin, async (req, res) => {
  try {
    if (!isPositiveInt(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const admin_feedback = sanitize(req.body.admin_feedback, 5000);
    const status = VALID_STATUSES.report.includes(req.body.status) ? req.body.status : 'reviewed';
    if (!admin_feedback) return res.status(400).json({ error: 'Feedback is required' });
    await pool.query('UPDATE weekly_reports SET admin_feedback = $1, status = $2 WHERE id = $3', [admin_feedback, status, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json(safeError(e)); }
});

app.get('/api/admin/tasks', requireAdmin, async (req, res) => {
  try {
    const tasks = await query(`
      SELECT t.id, t.intern_id, t.title, t.description, t.category, t.priority, t.status, t.due_date, t.completed_at, t.score, t.created_at,
             i.full_name as intern_name, i.department, i.avatar_color
      FROM tasks t
      JOIN interns i ON t.intern_id = i.id
      ORDER BY t.created_at DESC
      LIMIT 200
    `);
    res.json(tasks);
  } catch (e) { res.status(500).json(safeError(e)); }
});

app.post('/api/admin/tasks', requireAdmin, async (req, res) => {
  try {
    const intern_id = req.body.intern_id;
    const title = sanitize(req.body.title, 200);
    const description = sanitize(req.body.description, 5000);
    const category = VALID_STATUSES.category.includes(req.body.category) ? req.body.category : 'General';
    const priority = VALID_STATUSES.priority.includes(req.body.priority) ? req.body.priority : 'medium';
    const due_date = req.body.due_date;

    if (!isPositiveInt(intern_id)) return res.status(400).json({ error: 'Invalid intern' });
    if (!title || title.length < 2) return res.status(400).json({ error: 'Title required' });
    if (due_date && !isValidDate(due_date)) return res.status(400).json({ error: 'Invalid due date' });

    const intern = await queryOne('SELECT id, full_name FROM interns WHERE id = $1', [intern_id]);
    if (!intern) return res.status(404).json({ error: 'Intern not found' });

    const result = await queryOne(
      'INSERT INTO tasks (intern_id, title, description, category, priority, due_date) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [intern.id, title, description, category, priority, due_date || null]
    );
    await pool.query('INSERT INTO notifications (user_type, user_id, message) VALUES ($1,$2,$3)',
      ['admin', 1, `Task "${title}" assigned to ${intern.full_name}`]);
    res.json({ success: true, id: result.id });
  } catch (e) { res.status(500).json(safeError(e)); }
});

app.put('/api/admin/tasks/:id', requireAdmin, async (req, res) => {
  try {
    if (!isPositiveInt(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const intern_id = req.body.intern_id;
    const title = sanitize(req.body.title, 200);
    const description = sanitize(req.body.description, 5000);
    const category = VALID_STATUSES.category.includes(req.body.category) ? req.body.category : 'General';
    const priority = VALID_STATUSES.priority.includes(req.body.priority) ? req.body.priority : 'medium';
    const status = VALID_STATUSES.task.includes(req.body.status) ? req.body.status : 'todo';
    const due_date = req.body.due_date;

    if (!isPositiveInt(intern_id)) return res.status(400).json({ error: 'Invalid intern' });
    if (!title) return res.status(400).json({ error: 'Title required' });
    if (due_date && !isValidDate(due_date)) return res.status(400).json({ error: 'Invalid due date' });

    const completed_at = status === 'completed' ? new Date().toISOString() : null;
    const score = status === 'completed' && req.body.score != null ? Math.min(100, Math.max(0, parseInt(req.body.score) || 0)) : null;
    await pool.query(
      'UPDATE tasks SET intern_id=$1, title=$2, description=$3, category=$4, priority=$5, status=$6, due_date=$7, completed_at=$8, score=$9 WHERE id=$10',
      [intern_id, title, description, category, priority, status, due_date || null, completed_at, score, req.params.id]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json(safeError(e)); }
});

app.delete('/api/admin/tasks/:id', requireAdmin, async (req, res) => {
  try {
    if (!isPositiveInt(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    await pool.query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json(safeError(e)); }
});

// Admin stats — combined into fewer queries
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const [counts, recentReports, departmentStats] = await Promise.all([
      queryOne(`
        SELECT
          (SELECT COUNT(*) FROM interns WHERE status = 'active') as total_interns,
          (SELECT COUNT(*) FROM interns WHERE status = 'pending') as pending_interns,
          (SELECT COUNT(*) FROM weekly_reports) as total_reports,
          (SELECT COUNT(*) FROM weekly_reports WHERE status = 'submitted') as pending_reports,
          (SELECT COUNT(*) FROM tasks) as total_tasks,
          (SELECT COUNT(*) FROM tasks WHERE status = 'completed') as completed_tasks,
          (SELECT ROUND(AVG(score)) FROM tasks WHERE score IS NOT NULL) as avg_score
      `),
      query(`
        SELECT wr.id, wr.week_start, wr.mood, wr.status, wr.submitted_at,
               i.full_name as intern_name, i.department, i.avatar_color
        FROM weekly_reports wr JOIN interns i ON wr.intern_id = i.id
        ORDER BY wr.submitted_at DESC LIMIT 5
      `),
      query("SELECT department, COUNT(*) as count FROM interns WHERE status = 'active' GROUP BY department"),
    ]);

    res.json({
      totalInterns: +counts.total_interns,
      pendingInterns: +counts.pending_interns,
      totalReports: +counts.total_reports,
      pendingReports: +counts.pending_reports,
      totalTasks: +counts.total_tasks,
      completedTasks: +counts.completed_tasks,
      avgScore: counts.avg_score ? +counts.avg_score : null,
      recentReports,
      departmentStats
    });
  } catch (e) { res.status(500).json(safeError(e)); }
});

app.get('/api/admin/notifications', requireAdmin, async (req, res) => {
  try {
    const notifs = await query("SELECT id, message, is_read, created_at FROM notifications WHERE user_type = 'admin' ORDER BY created_at DESC LIMIT 20");
    res.json(notifs);
  } catch (e) { res.status(500).json(safeError(e)); }
});

app.put('/api/admin/notifications/read', requireAdmin, async (req, res) => {
  try {
    await pool.query("UPDATE notifications SET is_read = TRUE WHERE user_type = 'admin' AND is_read = FALSE");
    res.json({ success: true });
  } catch (e) { res.status(500).json(safeError(e)); }
});

// ── SPA fallback ────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ───────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  ╔══════════════════════════════════════╗`);
    console.log(`  ║   indic8 — Intern Management System  ║`);
    console.log(`  ║   Running on port ${PORT}              ║`);
    console.log(`  ╚══════════════════════════════════════╝\n`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
