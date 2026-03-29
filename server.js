const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Database Setup (with proper pool config) ────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: true } : false,
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
        department TEXT NOT NULL,
        start_date DATE NOT NULL,
        avatar_color TEXT DEFAULT '#00e676',
        status TEXT DEFAULT 'active',
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
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        user_type TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        message TEXT NOT NULL,
        is_read BOOLEAN DEFAULT FALSE,
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
  intern: ['active', 'completed', 'suspended'],
  task: ['todo', 'in_progress', 'review', 'completed'],
  report: ['draft', 'submitted', 'reviewed'],
  mood: ['great', 'good', 'neutral', 'struggling'],
  priority: ['low', 'medium', 'high', 'critical'],
  category: ['General', 'Development', 'Research', 'Design', 'Testing', 'Documentation', 'Meeting'],
};

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
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/session', (req, res) => {
  if (req.session.adminId) return res.json({ role: 'admin', name: req.session.adminName });
  res.json({ role: null });
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
    const tasks = await query('SELECT id, intern_id, title, description, category, priority, status, due_date, completed_at, created_at FROM tasks WHERE intern_id = $1 ORDER BY created_at DESC LIMIT 100', [req.params.id]);
    res.json(tasks);
  } catch (e) { res.status(500).json(safeError(e)); }
});

app.put('/api/interns/:internId/tasks/:taskId/status', async (req, res) => {
  try {
    if (!isPositiveInt(req.params.internId) || !isPositiveInt(req.params.taskId)) return res.status(400).json({ error: 'Invalid ID' });
    const { status } = req.body;
    if (!VALID_STATUSES.task.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const completed_at = status === 'completed' ? new Date().toISOString() : null;

    // Single query to update and return task+intern info
    const updated = await queryOne(
      `UPDATE tasks SET status=$1, completed_at=$2 WHERE id=$3 AND intern_id=$4
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
          (SELECT COUNT(*) FROM weekly_reports WHERE intern_id = $1) as total_reports
      `, [id]),
      query('SELECT id, title, category, priority, status, due_date, created_at FROM tasks WHERE intern_id = $1 ORDER BY created_at DESC LIMIT 5', [id])
    ]);

    res.json({
      totalTasks: +counts.total_tasks,
      completedTasks: +counts.completed_tasks,
      pendingTasks: +counts.pending_tasks,
      totalReports: +counts.total_reports,
      recentTasks
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
        COALESCE(r.total_reports, 0) as total_reports
      FROM interns i
      LEFT JOIN (
        SELECT intern_id, COUNT(*) as total_tasks, COUNT(*) FILTER (WHERE status = 'completed') as completed_tasks
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
    const [tasks, reports] = await Promise.all([
      query('SELECT id, title, category, priority, status, due_date, completed_at, created_at FROM tasks WHERE intern_id = $1 ORDER BY created_at DESC LIMIT 50', [req.params.id]),
      query('SELECT id, week_start, week_end, summary, mood, status, submitted_at FROM weekly_reports WHERE intern_id = $1 ORDER BY submitted_at DESC LIMIT 50', [req.params.id]),
    ]);
    res.json({ intern, tasks, reports });
  } catch (e) { res.status(500).json(safeError(e)); }
});

app.put('/api/admin/interns/:id/status', requireAdmin, async (req, res) => {
  try {
    if (!isPositiveInt(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    if (!VALID_STATUSES.intern.includes(req.body.status)) return res.status(400).json({ error: 'Invalid status' });
    await pool.query('UPDATE interns SET status = $1 WHERE id = $2', [req.body.status, req.params.id]);
    res.json({ success: true });
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
      SELECT t.id, t.intern_id, t.title, t.description, t.category, t.priority, t.status, t.due_date, t.completed_at, t.created_at,
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
    await pool.query(
      'UPDATE tasks SET intern_id=$1, title=$2, description=$3, category=$4, priority=$5, status=$6, due_date=$7, completed_at=$8 WHERE id=$9',
      [intern_id, title, description, category, priority, status, due_date || null, completed_at, req.params.id]
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
          (SELECT COUNT(*) FROM weekly_reports) as total_reports,
          (SELECT COUNT(*) FROM weekly_reports WHERE status = 'submitted') as pending_reports,
          (SELECT COUNT(*) FROM tasks) as total_tasks,
          (SELECT COUNT(*) FROM tasks WHERE status = 'completed') as completed_tasks
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
      totalReports: +counts.total_reports,
      pendingReports: +counts.pending_reports,
      totalTasks: +counts.total_tasks,
      completedTasks: +counts.completed_tasks,
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
