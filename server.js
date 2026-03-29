const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Database Setup ──────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
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

    // Seed default admin
    const adminCheck = await client.query('SELECT id FROM admins WHERE username = $1', ['admin']);
    if (adminCheck.rows.length === 0) {
      const hash = bcrypt.hashSync('admin123', 10);
      await client.query('INSERT INTO admins (username, password, full_name) VALUES ($1, $2, $3)', ['admin', hash, 'System Administrator']);
    }
    console.log('  ✓ Database initialized');
  } finally {
    client.release();
  }
}

// Helper: run a query and return rows
async function query(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows;
}

async function queryOne(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows[0] || null;
}

// ── Middleware ───────────────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'indic8-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  }
}));

function requireAdmin(req, res, next) {
  if (req.session && req.session.adminId) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── Admin Auth ──────────────────────────────────────────────────────────────
app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const admin = await queryOne('SELECT * FROM admins WHERE username = $1', [username]);
    if (!admin || !bcrypt.compareSync(password, admin.password)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    req.session.adminId = admin.id;
    req.session.adminName = admin.full_name;
    res.json({ success: true, name: admin.full_name });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/interns/:id', async (req, res) => {
  try {
    const intern = await queryOne("SELECT id, intern_id, full_name, email, department, start_date, avatar_color, status FROM interns WHERE id = $1", [req.params.id]);
    if (!intern) return res.status(404).json({ error: 'Intern not found' });
    res.json(intern);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/interns/:id/reports', async (req, res) => {
  try {
    const intern = await queryOne('SELECT id, full_name FROM interns WHERE id = $1', [req.params.id]);
    if (!intern) return res.status(404).json({ error: 'Intern not found' });
    const { week_start, week_end, summary, challenges, plans_next_week, hours_worked, mood, status } = req.body;
    const result = await queryOne(
      `INSERT INTO weekly_reports (intern_id, week_start, week_end, summary, challenges, plans_next_week, hours_worked, mood, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [intern.id, week_start, week_end, summary, challenges || '', plans_next_week || '', hours_worked || 0, mood || 'neutral', status || 'submitted']
    );
    if (status !== 'draft') {
      await pool.query('INSERT INTO notifications (user_type, user_id, message) VALUES ($1,$2,$3)',
        ['admin', 1, `${intern.full_name} submitted a weekly report (${week_start} to ${week_end})`]);
    }
    res.json({ success: true, id: result.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/interns/:id/reports', async (req, res) => {
  try {
    const reports = await query('SELECT * FROM weekly_reports WHERE intern_id = $1 ORDER BY submitted_at DESC', [req.params.id]);
    res.json(reports);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/interns/:id/tasks', async (req, res) => {
  try {
    const tasks = await query('SELECT * FROM tasks WHERE intern_id = $1 ORDER BY created_at DESC', [req.params.id]);
    res.json(tasks);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/interns/:internId/tasks/:taskId/status', async (req, res) => {
  try {
    const { status } = req.body;
    const allowed = ['todo', 'in_progress', 'review', 'completed'];
    if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const completed_at = status === 'completed' ? new Date().toISOString() : null;
    await pool.query('UPDATE tasks SET status=$1, completed_at=$2 WHERE id=$3 AND intern_id=$4',
      [status, completed_at, req.params.taskId, req.params.internId]);
    if (status === 'completed') {
      const task = await queryOne('SELECT title FROM tasks WHERE id = $1', [req.params.taskId]);
      const intern = await queryOne('SELECT full_name FROM interns WHERE id = $1', [req.params.internId]);
      if (intern && task) {
        await pool.query('INSERT INTO notifications (user_type, user_id, message) VALUES ($1,$2,$3)',
          ['admin', 1, `${intern.full_name} completed task: ${task.title}`]);
      }
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/interns/:id/stats', async (req, res) => {
  try {
    const id = req.params.id;
    const totalTasks = (await queryOne('SELECT COUNT(*) as c FROM tasks WHERE intern_id = $1', [id])).c;
    const completedTasks = (await queryOne("SELECT COUNT(*) as c FROM tasks WHERE intern_id = $1 AND status = 'completed'", [id])).c;
    const totalReports = (await queryOne('SELECT COUNT(*) as c FROM weekly_reports WHERE intern_id = $1', [id])).c;
    const pendingTasks = (await queryOne("SELECT COUNT(*) as c FROM tasks WHERE intern_id = $1 AND status IN ('todo','in_progress')", [id])).c;
    const recentTasks = await query('SELECT * FROM tasks WHERE intern_id = $1 ORDER BY created_at DESC LIMIT 5', [id]);
    res.json({ totalTasks: +totalTasks, completedTasks: +completedTasks, totalReports: +totalReports, pendingTasks: +pendingTasks, recentTasks });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin Routes (login required) ──────────────────────────────────────────

app.post('/api/admin/interns', requireAdmin, async (req, res) => {
  try {
    const { full_name, email, department, start_date } = req.body;
    const intern_id = 'INT-' + Date.now().toString(36).toUpperCase();
    const colors = ['#00e676','#00bcd4','#7c4dff','#ff9100','#ff5252','#64ffda'];
    const avatar_color = colors[Math.floor(Math.random() * colors.length)];
    await pool.query('INSERT INTO interns (intern_id, full_name, email, department, start_date, avatar_color) VALUES ($1,$2,$3,$4,$5,$6)',
      [intern_id, full_name, email, department, start_date, avatar_color]);
    res.json({ success: true, intern_id });
  } catch (e) {
    res.status(400).json({ error: e.message.includes('unique') || e.message.includes('duplicate') ? 'Email already registered' : e.message });
  }
});

app.get('/api/admin/interns', requireAdmin, async (req, res) => {
  try {
    const interns = await query(`
      SELECT i.*,
        (SELECT COUNT(*) FROM tasks WHERE intern_id = i.id) as total_tasks,
        (SELECT COUNT(*) FROM tasks WHERE intern_id = i.id AND status = 'completed') as completed_tasks,
        (SELECT COUNT(*) FROM weekly_reports WHERE intern_id = i.id) as total_reports
      FROM interns i ORDER BY i.created_at DESC
    `);
    res.json(interns);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/interns/:id', requireAdmin, async (req, res) => {
  try {
    const intern = await queryOne('SELECT * FROM interns WHERE id = $1', [req.params.id]);
    if (!intern) return res.status(404).json({ error: 'Not found' });
    const tasks = await query('SELECT * FROM tasks WHERE intern_id = $1 ORDER BY created_at DESC', [req.params.id]);
    const reports = await query('SELECT * FROM weekly_reports WHERE intern_id = $1 ORDER BY submitted_at DESC', [req.params.id]);
    res.json({ intern, tasks, reports });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/interns/:id/status', requireAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE interns SET status = $1 WHERE id = $2', [req.body.status, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/reports', requireAdmin, async (req, res) => {
  try {
    const reports = await query(`
      SELECT wr.*, i.full_name as intern_name, i.department, i.avatar_color
      FROM weekly_reports wr
      JOIN interns i ON wr.intern_id = i.id
      ORDER BY wr.submitted_at DESC
    `);
    res.json(reports);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/reports/:id', requireAdmin, async (req, res) => {
  try {
    const { admin_feedback, status } = req.body;
    await pool.query('UPDATE weekly_reports SET admin_feedback = $1, status = $2 WHERE id = $3', [admin_feedback, status || 'reviewed', req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/tasks', requireAdmin, async (req, res) => {
  try {
    const tasks = await query(`
      SELECT t.*, i.full_name as intern_name, i.department, i.avatar_color
      FROM tasks t
      JOIN interns i ON t.intern_id = i.id
      ORDER BY t.created_at DESC
    `);
    res.json(tasks);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/tasks', requireAdmin, async (req, res) => {
  try {
    const { intern_id, title, description, category, priority, due_date } = req.body;
    const intern = await queryOne('SELECT id, full_name FROM interns WHERE id = $1', [intern_id]);
    if (!intern) return res.status(404).json({ error: 'Intern not found' });
    const result = await queryOne(
      'INSERT INTO tasks (intern_id, title, description, category, priority, due_date) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [intern.id, title, description || '', category || 'general', priority || 'medium', due_date || null]
    );
    await pool.query('INSERT INTO notifications (user_type, user_id, message) VALUES ($1,$2,$3)',
      ['admin', 1, `Task "${title}" assigned to ${intern.full_name}`]);
    res.json({ success: true, id: result.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/tasks/:id', requireAdmin, async (req, res) => {
  try {
    const { intern_id, title, description, category, priority, status, due_date } = req.body;
    const completed_at = status === 'completed' ? new Date().toISOString() : null;
    await pool.query(
      'UPDATE tasks SET intern_id=$1, title=$2, description=$3, category=$4, priority=$5, status=$6, due_date=$7, completed_at=$8 WHERE id=$9',
      [intern_id, title, description, category, priority, status, due_date, completed_at, req.params.id]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/tasks/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const totalInterns = +(await queryOne("SELECT COUNT(*) as c FROM interns WHERE status = 'active'")).c;
    const totalReports = +(await queryOne('SELECT COUNT(*) as c FROM weekly_reports')).c;
    const pendingReports = +(await queryOne("SELECT COUNT(*) as c FROM weekly_reports WHERE status = 'submitted'")).c;
    const totalTasks = +(await queryOne('SELECT COUNT(*) as c FROM tasks')).c;
    const completedTasks = +(await queryOne("SELECT COUNT(*) as c FROM tasks WHERE status = 'completed'")).c;
    const recentReports = await query(`
      SELECT wr.*, i.full_name as intern_name, i.department, i.avatar_color
      FROM weekly_reports wr JOIN interns i ON wr.intern_id = i.id
      ORDER BY wr.submitted_at DESC LIMIT 5
    `);
    const departmentStats = await query(`
      SELECT department, COUNT(*) as count FROM interns WHERE status = 'active' GROUP BY department
    `);
    res.json({ totalInterns, totalReports, pendingReports, totalTasks, completedTasks, recentReports, departmentStats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/notifications', requireAdmin, async (req, res) => {
  try {
    const notifs = await query("SELECT * FROM notifications WHERE user_type = 'admin' ORDER BY created_at DESC LIMIT 20");
    res.json(notifs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/notifications/read', requireAdmin, async (req, res) => {
  try {
    await pool.query("UPDATE notifications SET is_read = TRUE WHERE user_type = 'admin'");
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    console.log(`  ║   http://localhost:${PORT}              ║`);
    console.log(`  ║                                      ║`);
    console.log(`  ║   Admin:  admin / admin123            ║`);
    console.log(`  ╚══════════════════════════════════════╝\n`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
