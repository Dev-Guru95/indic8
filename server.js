const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Database Setup ──────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'indic8.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    full_name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS interns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    intern_id TEXT UNIQUE NOT NULL,
    full_name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    department TEXT NOT NULL,
    start_date DATE NOT NULL,
    avatar_color TEXT DEFAULT '#00e676',
    status TEXT DEFAULT 'active' CHECK(status IN ('active','completed','suspended')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS weekly_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    intern_id INTEGER NOT NULL REFERENCES interns(id) ON DELETE CASCADE,
    week_start DATE NOT NULL,
    week_end DATE NOT NULL,
    summary TEXT NOT NULL,
    challenges TEXT,
    plans_next_week TEXT,
    hours_worked REAL DEFAULT 0,
    mood TEXT DEFAULT 'neutral' CHECK(mood IN ('great','good','neutral','struggling')),
    status TEXT DEFAULT 'submitted' CHECK(status IN ('draft','submitted','reviewed')),
    admin_feedback TEXT,
    submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    intern_id INTEGER NOT NULL REFERENCES interns(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    category TEXT DEFAULT 'general',
    priority TEXT DEFAULT 'medium' CHECK(priority IN ('low','medium','high','critical')),
    status TEXT DEFAULT 'todo' CHECK(status IN ('todo','in_progress','review','completed')),
    due_date DATE,
    completed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_type TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    message TEXT NOT NULL,
    is_read INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Seed default admin
const adminExists = db.prepare('SELECT id FROM admins WHERE username = ?').get('admin');
if (!adminExists) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare('INSERT INTO admins (username, password, full_name) VALUES (?, ?, ?)').run('admin', hash, 'System Administrator');
}

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: 'indic8-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

function requireAdmin(req, res, next) {
  if (req.session && req.session.adminId) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── Admin Auth ──────────────────────────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  if (!admin || !bcrypt.compareSync(password, admin.password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  req.session.adminId = admin.id;
  req.session.adminName = admin.full_name;
  res.json({ success: true, name: admin.full_name });
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

// Get list of all active interns (for the intern selector dropdown)
app.get('/api/interns', (req, res) => {
  const interns = db.prepare("SELECT id, intern_id, full_name, department, avatar_color FROM interns WHERE status = 'active' ORDER BY full_name").all();
  res.json(interns);
});

// Get a single intern's profile
app.get('/api/interns/:id', (req, res) => {
  const intern = db.prepare("SELECT id, intern_id, full_name, email, department, start_date, avatar_color, status FROM interns WHERE id = ?").get(req.params.id);
  if (!intern) return res.status(404).json({ error: 'Intern not found' });
  res.json(intern);
});

// Submit weekly report
app.post('/api/interns/:id/reports', (req, res) => {
  const intern = db.prepare('SELECT id, full_name FROM interns WHERE id = ?').get(req.params.id);
  if (!intern) return res.status(404).json({ error: 'Intern not found' });
  const { week_start, week_end, summary, challenges, plans_next_week, hours_worked, mood, status } = req.body;
  const result = db.prepare(`
    INSERT INTO weekly_reports (intern_id, week_start, week_end, summary, challenges, plans_next_week, hours_worked, mood, status)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(intern.id, week_start, week_end, summary, challenges || '', plans_next_week || '', hours_worked || 0, mood || 'neutral', status || 'submitted');
  if (status !== 'draft') {
    db.prepare('INSERT INTO notifications (user_type, user_id, message) VALUES (?,?,?)')
      .run('admin', 1, `${intern.full_name} submitted a weekly report (${week_start} to ${week_end})`);
  }
  res.json({ success: true, id: result.lastInsertRowid });
});

// Get intern's reports
app.get('/api/interns/:id/reports', (req, res) => {
  const reports = db.prepare('SELECT * FROM weekly_reports WHERE intern_id = ? ORDER BY submitted_at DESC').all(req.params.id);
  res.json(reports);
});

// Get intern's assigned tasks (public)
app.get('/api/interns/:id/tasks', (req, res) => {
  const tasks = db.prepare('SELECT * FROM tasks WHERE intern_id = ? ORDER BY created_at DESC').all(req.params.id);
  res.json(tasks);
});

// Intern updates task status only (progress tracking)
app.put('/api/interns/:internId/tasks/:taskId/status', (req, res) => {
  const { status } = req.body;
  const allowed = ['todo', 'in_progress', 'review', 'completed'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const completed_at = status === 'completed' ? new Date().toISOString() : null;
  db.prepare('UPDATE tasks SET status=?, completed_at=? WHERE id=? AND intern_id=?')
    .run(status, completed_at, req.params.taskId, req.params.internId);
  if (status === 'completed') {
    const task = db.prepare('SELECT title FROM tasks WHERE id = ?').get(req.params.taskId);
    const intern = db.prepare('SELECT full_name FROM interns WHERE id = ?').get(req.params.internId);
    if (intern && task) {
      db.prepare('INSERT INTO notifications (user_type, user_id, message) VALUES (?,?,?)')
        .run('admin', 1, `${intern.full_name} completed task: ${task.title}`);
    }
  }
  res.json({ success: true });
});

// Intern dashboard stats
app.get('/api/interns/:id/stats', (req, res) => {
  const id = req.params.id;
  const totalTasks = db.prepare('SELECT COUNT(*) as c FROM tasks WHERE intern_id = ?').get(id).c;
  const completedTasks = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE intern_id = ? AND status = 'completed'").get(id).c;
  const totalReports = db.prepare('SELECT COUNT(*) as c FROM weekly_reports WHERE intern_id = ?').get(id).c;
  const pendingTasks = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE intern_id = ? AND status IN ('todo','in_progress')").get(id).c;
  const recentTasks = db.prepare('SELECT * FROM tasks WHERE intern_id = ? ORDER BY created_at DESC LIMIT 5').all(id);
  res.json({ totalTasks, completedTasks, totalReports, pendingTasks, recentTasks });
});

// ── Admin Routes (login required) ──────────────────────────────────────────

// Register a new intern
app.post('/api/admin/interns', requireAdmin, (req, res) => {
  const { full_name, email, department, start_date } = req.body;
  const intern_id = 'INT-' + Date.now().toString(36).toUpperCase();
  const colors = ['#00e676','#00bcd4','#7c4dff','#ff9100','#ff5252','#64ffda'];
  const avatar_color = colors[Math.floor(Math.random() * colors.length)];
  try {
    db.prepare('INSERT INTO interns (intern_id, full_name, email, department, start_date, avatar_color) VALUES (?,?,?,?,?,?)')
      .run(intern_id, full_name, email, department, start_date, avatar_color);
    res.json({ success: true, intern_id });
  } catch (e) {
    res.status(400).json({ error: e.message.includes('UNIQUE') ? 'Email already registered' : e.message });
  }
});

// All interns
app.get('/api/admin/interns', requireAdmin, (req, res) => {
  const interns = db.prepare(`
    SELECT i.*,
      (SELECT COUNT(*) FROM tasks WHERE intern_id = i.id) as total_tasks,
      (SELECT COUNT(*) FROM tasks WHERE intern_id = i.id AND status = 'completed') as completed_tasks,
      (SELECT COUNT(*) FROM weekly_reports WHERE intern_id = i.id) as total_reports
    FROM interns i ORDER BY i.created_at DESC
  `).all();
  res.json(interns);
});

// Single intern detail
app.get('/api/admin/interns/:id', requireAdmin, (req, res) => {
  const intern = db.prepare('SELECT * FROM interns WHERE id = ?').get(req.params.id);
  if (!intern) return res.status(404).json({ error: 'Not found' });
  const tasks = db.prepare('SELECT * FROM tasks WHERE intern_id = ? ORDER BY created_at DESC').all(req.params.id);
  const reports = db.prepare('SELECT * FROM weekly_reports WHERE intern_id = ? ORDER BY submitted_at DESC').all(req.params.id);
  res.json({ intern, tasks, reports });
});

// Update intern status
app.put('/api/admin/interns/:id/status', requireAdmin, (req, res) => {
  db.prepare('UPDATE interns SET status = ? WHERE id = ?').run(req.body.status, req.params.id);
  res.json({ success: true });
});

// All reports (admin)
app.get('/api/admin/reports', requireAdmin, (req, res) => {
  const reports = db.prepare(`
    SELECT wr.*, i.full_name as intern_name, i.department, i.avatar_color
    FROM weekly_reports wr
    JOIN interns i ON wr.intern_id = i.id
    ORDER BY wr.submitted_at DESC
  `).all();
  res.json(reports);
});

// Review report / add feedback
app.put('/api/admin/reports/:id', requireAdmin, (req, res) => {
  const { admin_feedback, status } = req.body;
  db.prepare('UPDATE weekly_reports SET admin_feedback = ?, status = ? WHERE id = ?').run(admin_feedback, status || 'reviewed', req.params.id);
  res.json({ success: true });
});

// All tasks (admin view)
app.get('/api/admin/tasks', requireAdmin, (req, res) => {
  const tasks = db.prepare(`
    SELECT t.*, i.full_name as intern_name, i.department, i.avatar_color
    FROM tasks t
    JOIN interns i ON t.intern_id = i.id
    ORDER BY t.created_at DESC
  `).all();
  res.json(tasks);
});

// Admin assigns a task to an intern
app.post('/api/admin/tasks', requireAdmin, (req, res) => {
  const { intern_id, title, description, category, priority, due_date } = req.body;
  const intern = db.prepare('SELECT id, full_name FROM interns WHERE id = ?').get(intern_id);
  if (!intern) return res.status(404).json({ error: 'Intern not found' });
  const result = db.prepare('INSERT INTO tasks (intern_id, title, description, category, priority, due_date) VALUES (?,?,?,?,?,?)')
    .run(intern.id, title, description || '', category || 'general', priority || 'medium', due_date || null);
  db.prepare('INSERT INTO notifications (user_type, user_id, message) VALUES (?,?,?)')
    .run('admin', 1, `Task "${title}" assigned to ${intern.full_name}`);
  res.json({ success: true, id: result.lastInsertRowid });
});

// Admin updates a task
app.put('/api/admin/tasks/:id', requireAdmin, (req, res) => {
  const { intern_id, title, description, category, priority, status, due_date } = req.body;
  const completed_at = status === 'completed' ? new Date().toISOString() : null;
  db.prepare('UPDATE tasks SET intern_id=?, title=?, description=?, category=?, priority=?, status=?, due_date=?, completed_at=? WHERE id=?')
    .run(intern_id, title, description, category, priority, status, due_date, completed_at, req.params.id);
  res.json({ success: true });
});

// Admin deletes a task
app.delete('/api/admin/tasks/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Admin dashboard stats
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const totalInterns = db.prepare("SELECT COUNT(*) as c FROM interns WHERE status = 'active'").get().c;
  const totalReports = db.prepare('SELECT COUNT(*) as c FROM weekly_reports').get().c;
  const pendingReports = db.prepare("SELECT COUNT(*) as c FROM weekly_reports WHERE status = 'submitted'").get().c;
  const totalTasks = db.prepare('SELECT COUNT(*) as c FROM tasks').get().c;
  const completedTasks = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status = 'completed'").get().c;
  const recentReports = db.prepare(`
    SELECT wr.*, i.full_name as intern_name, i.department, i.avatar_color
    FROM weekly_reports wr JOIN interns i ON wr.intern_id = i.id
    ORDER BY wr.submitted_at DESC LIMIT 5
  `).all();
  const departmentStats = db.prepare(`
    SELECT department, COUNT(*) as count FROM interns WHERE status = 'active' GROUP BY department
  `).all();
  res.json({ totalInterns, totalReports, pendingReports, totalTasks, completedTasks, recentReports, departmentStats });
});

// Admin notifications
app.get('/api/admin/notifications', requireAdmin, (req, res) => {
  const notifs = db.prepare("SELECT * FROM notifications WHERE user_type = 'admin' ORDER BY created_at DESC LIMIT 20").all();
  res.json(notifs);
});

app.put('/api/admin/notifications/read', requireAdmin, (req, res) => {
  db.prepare("UPDATE notifications SET is_read = 1 WHERE user_type = 'admin'").run();
  res.json({ success: true });
});

// ── SPA fallback ────────────────────────────────────────────────────────────
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ╔══════════════════════════════════════╗`);
  console.log(`  ║   indic8 — Intern Management System  ║`);
  console.log(`  ║   http://localhost:${PORT}              ║`);
  console.log(`  ║                                      ║`);
  console.log(`  ║   Admin:  admin / admin123            ║`);
  console.log(`  ╚══════════════════════════════════════╝\n`);
});
