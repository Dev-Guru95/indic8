/* ═══════════════════════════════════════════════════════════════════════════
   indic8 — Intern Management System — Client Application
   ═══════════════════════════════════════════════════════════════════════════ */

// ── State ───────────────────────────────────────────────────────────────────
let currentRole = null;   // 'admin' | 'intern'
let currentPage = null;
let currentUser = {};      // { name, department, id } for intern; { name } for admin

// ── API Helper ──────────────────────────────────────────────────────────────
async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ── Toast ───────────────────────────────────────────────────────────────────
function toast(message, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${type === 'success' ? '✓' : '✗'}</span><span>${message}</span>`;
  document.getElementById('toastContainer').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ── Modal ───────────────────────────────────────────────────────────────────
function openModal(title, bodyHtml, footerHtml = '') {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalBody').innerHTML = bodyHtml;
  document.getElementById('modalFooter').innerHTML = footerHtml;
  document.getElementById('modalOverlay').classList.add('active');
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('active');
}

// ── Landing Screen ──────────────────────────────────────────────────────────
function switchLandingTab(tab) {
  document.querySelectorAll('.login-tab').forEach((t, i) => {
    t.classList.toggle('active', (tab === 'intern' || tab === 'signup') ? i === 0 : i === 1);
  });
  document.getElementById('internSelectPanel').classList.toggle('hidden', tab !== 'intern');
  document.getElementById('internSignupPanel').classList.toggle('hidden', tab !== 'signup');
  document.getElementById('adminLoginForm').classList.toggle('hidden', tab !== 'admin');
}

async function handleInternLogin(e) {
  e.preventDefault();
  try {
    const data = await api('/api/intern/login', {
      method: 'POST',
      body: {
        email: document.getElementById('internLoginEmail').value,
        password: document.getElementById('internLoginPass').value,
      }
    });
    currentUser = {
      id: data.id,
      name: data.name,
      department: data.department,
      avatarColor: data.avatarColor,
      status: data.status,
    };
    if (data.status === 'pending') {
      showPendingScreen();
    } else if (data.status === 'active') {
      enterApp('intern');
      toast(`Welcome back, ${data.name}!`);
    } else {
      toast('Your account is ' + data.status + '. Contact your administrator.', 'error');
    }
  } catch (err) { toast(err.message, 'error'); }
  return false;
}

async function handleInternSignup(e) {
  e.preventDefault();
  try {
    await api('/api/intern/signup', {
      method: 'POST',
      body: {
        full_name: document.getElementById('signupName').value,
        email: document.getElementById('signupEmail').value,
        password: document.getElementById('signupPass').value,
        department: document.getElementById('signupDept').value,
      }
    });
    showPendingScreen();
    toast('Signup successful! Waiting for admin approval.');
  } catch (err) { toast(err.message, 'error'); }
  return false;
}

function showPendingScreen() {
  document.getElementById('landingScreen').classList.add('hidden');
  document.getElementById('appLayout').classList.add('hidden');
  document.getElementById('pendingScreen').classList.remove('hidden');
  if (window._pendingPoll) clearInterval(window._pendingPoll);
  window._pendingPoll = setInterval(checkApprovalStatus, 5000);
}

async function checkApprovalStatus() {
  try {
    const session = await api('/api/session');
    if (session.role === 'intern' && session.status === 'active') {
      clearInterval(window._pendingPoll);
      currentUser = {
        id: session.id,
        name: session.name,
        department: session.department,
        avatarColor: session.avatarColor,
        status: session.status,
      };
      document.getElementById('pendingScreen').classList.add('hidden');
      enterApp('intern');
      toast(`Welcome, ${session.name}! Your account has been approved.`);
    }
  } catch (e) { /* silent */ }
}

function backToLogin() {
  if (window._pendingPoll) clearInterval(window._pendingPoll);
  document.getElementById('pendingScreen').classList.add('hidden');
  document.getElementById('landingScreen').classList.remove('hidden');
  api('/api/logout', { method: 'POST' }).catch(() => {});
}

// ── Password Reset (interns only) ───────────────────────────────────────────
function openForgotPassword() {
  openModal('Reset Password', `
    <p style="color:var(--text-secondary); font-size:0.88rem; margin-bottom:1rem; line-height:1.5;">
      Enter the email linked to your intern account and we'll send you a link to set a new password.
    </p>
    <form id="forgotForm" onsubmit="return submitForgotPassword(event)">
      <div class="form-group">
        <label>Email</label>
        <input type="email" class="form-input" id="forgotEmail" placeholder="your@email.com" required>
      </div>
    </form>
  `, `
    <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="document.getElementById('forgotForm').requestSubmit()">Send Reset Link</button>
  `);
}

async function submitForgotPassword(e) {
  e.preventDefault();
  try {
    const data = await api('/api/intern/forgot-password', {
      method: 'POST',
      body: { email: document.getElementById('forgotEmail').value }
    });
    closeModal();
    toast(data.message || 'If an account exists, a reset link has been sent.');
  } catch (err) { toast(err.message, 'error'); }
  return false;
}

let _resetToken = null;
async function showResetScreen(token) {
  _resetToken = token;
  ['landingScreen', 'pendingScreen', 'appLayout'].forEach(id => document.getElementById(id).classList.add('hidden'));
  document.getElementById('resetScreen').classList.remove('hidden');
  let valid = false;
  try {
    const v = await api('/api/intern/reset-password/verify?token=' + encodeURIComponent(token));
    valid = !!v.valid;
  } catch (e) { valid = false; }
  document.getElementById('resetFormWrap').classList.toggle('hidden', !valid);
  document.getElementById('resetInvalidWrap').classList.toggle('hidden', valid);
}

async function submitResetPassword(e) {
  e.preventDefault();
  const p1 = document.getElementById('resetNewPass').value;
  const p2 = document.getElementById('resetConfirmPass').value;
  if (p1 !== p2) { toast('Passwords do not match', 'error'); return false; }
  try {
    const data = await api('/api/intern/reset-password', {
      method: 'POST',
      body: { token: _resetToken, password: p1 }
    });
    toast(data.message || 'Password reset successful!');
    exitResetScreen();
  } catch (err) { toast(err.message, 'error'); }
  return false;
}

function exitResetScreen() {
  _resetToken = null;
  history.replaceState(null, '', window.location.pathname);
  document.getElementById('resetScreen').classList.add('hidden');
  document.getElementById('landingScreen').classList.remove('hidden');
  switchLandingTab('intern');
}

async function handleAdminLogin(e) {
  e.preventDefault();
  try {
    const data = await api('/api/admin/login', {
      method: 'POST',
      body: { username: document.getElementById('loginAdminUser').value, password: document.getElementById('loginAdminPass').value }
    });
    currentUser = { name: data.name };
    enterApp('admin');
    toast(`Welcome, ${data.name}!`);
  } catch (err) { toast(err.message, 'error'); }
  return false;
}

async function handleLogout() {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  currentRole = null;
  currentPage = null;
  currentUser = {};
  document.getElementById('appLayout').classList.add('hidden');
  document.getElementById('landingScreen').classList.remove('hidden');
  loadInternSelector();
}

// ── Enter App ───────────────────────────────────────────────────────────────
function enterApp(role) {
  currentRole = role;
  document.getElementById('landingScreen').classList.add('hidden');
  document.getElementById('appLayout').classList.remove('hidden');

  document.getElementById('sidebarRoleLabel').textContent = role === 'admin' ? 'Administration' : 'Intern Portal';
  document.getElementById('userName').textContent = currentUser.name;
  document.getElementById('userRole').textContent = role === 'admin' ? 'Administrator' : currentUser.department;
  document.getElementById('userAvatar').textContent = currentUser.name.charAt(0).toUpperCase();
  if (role === 'intern' && currentUser.avatarColor) {
    document.getElementById('userAvatar').style.background = currentUser.avatarColor;
  } else {
    document.getElementById('userAvatar').style.background = 'var(--green-primary)';
  }

  // Show/hide notification bell (only for admin)
  document.getElementById('notifBtn').classList.toggle('hidden', role !== 'admin');

  const navItems = role === 'admin' ? [
    { id: 'dashboard', icon: '◉', label: 'Dashboard', mobileLabel: 'Home' },
    { id: 'interns',   icon: '👥', label: 'Interns', mobileLabel: 'Interns' },
    { id: 'reports',   icon: '📋', label: 'Weekly Reports', mobileLabel: 'Reports' },
    { id: 'tasks',     icon: '✓', label: 'All Tasks', mobileLabel: 'Tasks' },
  ] : [
    { id: 'dashboard',    icon: '◉', label: 'Dashboard', mobileLabel: 'Home' },
    { id: 'performance',  icon: '★', label: 'My Performance', mobileLabel: 'Performance' },
    { id: 'tasks',        icon: '✓', label: 'My Tasks', mobileLabel: 'Tasks' },
    { id: 'reports',      icon: '📋', label: 'Weekly Reports', mobileLabel: 'Reports' },
  ];

  // Desktop sidebar nav
  document.getElementById('sidebarNav').innerHTML =
    `<div class="nav-section-label">Navigation</div>` +
    navItems.map(n => `
      <button class="nav-item" data-page="${n.id}" onclick="navigateTo('${n.id}'); closeMobileSidebar();">
        <span class="icon">${n.icon}</span> ${n.label}
      </button>
    `).join('') +
    `<div class="nav-section-label" style="margin-top:auto;"></div>
     <button class="nav-item" onclick="handleLogout(); closeMobileSidebar();">
       <span class="icon">⏻</span> Sign Out
     </button>`;

  // Mobile bottom nav
  const logoutItem = { id: 'logout', icon: '⏻', mobileLabel: 'Logout' };
  const mobileItems = [...navItems, logoutItem];
  document.getElementById('mobileBottomNav').innerHTML =
    mobileItems.map(n => n.id === 'logout'
      ? `<button class="mobile-nav-item" onclick="handleLogout()">
           <span class="mob-icon">${n.icon}</span>${n.mobileLabel}
         </button>`
      : `<button class="mobile-nav-item" data-page="${n.id}" onclick="navigateTo('${n.id}')">
           <span class="mob-icon">${n.icon}</span>${n.mobileLabel}
         </button>`
    ).join('');

  navigateTo('dashboard');
  if (role === 'admin') loadNotifications();
}

function navigateTo(page) {
  currentPage = page;
  // Update sidebar active
  document.querySelectorAll('.nav-item').forEach(n => {
    n.classList.toggle('active', n.dataset.page === page);
  });
  // Update mobile bottom nav active
  document.querySelectorAll('.mobile-nav-item').forEach(n => {
    n.classList.toggle('active', n.dataset.page === page);
  });
  // Show/hide back button (not on dashboard)
  const showBack = page !== 'dashboard';
  const mobileBack = document.getElementById('mobileBackBtn');
  const desktopBack = document.getElementById('desktopBackBtn');
  if (mobileBack) mobileBack.style.display = showBack ? 'flex' : 'none';
  if (desktopBack) desktopBack.style.display = showBack ? 'flex' : 'none';

  const renderer = currentRole === 'admin' ? adminPages : internPages;
  if (renderer[page]) renderer[page]();
}

// ── Mobile Sidebar / Navigation ─────────────────────────────────────────────
function toggleMobileSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebarOverlay').classList.toggle('active');
}

function closeMobileSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('active');
}

function handleMobileBack() {
  navigateTo('dashboard');
}

// ── Notifications (admin only) ──────────────────────────────────────────────
async function loadNotifications() {
  try {
    const notifs = await api('/api/admin/notifications');
    const unread = notifs.filter(n => !n.is_read).length;
    const badge = document.getElementById('notifBadge');
    if (unread > 0) {
      badge.textContent = unread;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
    window._notifications = notifs;
  } catch (e) { /* silent */ }
}

function toggleNotifications() {
  const notifs = window._notifications || [];
  const html = notifs.length === 0
    ? '<div class="empty-state"><p>No notifications yet</p></div>'
    : notifs.map(n => `
      <div style="padding:0.75rem 0; border-bottom:1px solid var(--border); display:flex; gap:0.75rem; align-items:start;">
        <span style="color:${n.is_read ? 'var(--text-muted)' : 'var(--green-primary)'}; font-size:0.6rem; margin-top:0.4rem;">●</span>
        <div>
          <div style="font-size:0.88rem; color:${n.is_read ? 'var(--text-secondary)' : 'var(--text-primary)'}">${escHtml(n.message)}</div>
          <div style="font-size:0.72rem; color:var(--text-muted); margin-top:0.2rem;">${timeAgo(n.created_at)}</div>
        </div>
      </div>
    `).join('');
  openModal('Notifications', html,
    `<button class="btn btn-secondary btn-sm" onclick="markAllRead()">Mark all as read</button>`
  );
}

async function markAllRead() {
  await api('/api/admin/notifications/read', { method: 'PUT' });
  document.getElementById('notifBadge').classList.add('hidden');
  closeModal();
  toast('All notifications marked as read');
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function escHtml(s) {
  const div = document.createElement('div');
  div.textContent = s || '';
  return div.innerHTML;
}

function timeAgo(dateStr) {
  const d = new Date(dateStr + (dateStr.includes('Z') ? '' : 'Z'));
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}

function formatDateTime(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + (dateStr.includes('Z') ? '' : 'Z'));
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${date}, ${time}`;
}

function moodEmoji(mood) {
  return { great: '🟢', good: '🔵', neutral: '⚪', struggling: '🔴' }[mood] || '⚪';
}

function statusBadge(status) {
  const map = {
    pending: 'badge-yellow', active: 'badge-green', completed: 'badge-blue', suspended: 'badge-red',
    todo: 'badge-gray', in_progress: 'badge-blue', review: 'badge-orange',
    submitted: 'badge-orange', reviewed: 'badge-green', draft: 'badge-gray',
    low: 'badge-gray', medium: 'badge-blue', high: 'badge-orange', critical: 'badge-red',
  };
  const label = status.replace(/_/g, ' ');
  return `<span class="badge ${map[status] || 'badge-gray'}">${label}</span>`;
}

function scoreBadge(score) {
  if (score == null) return '';
  const cls = score >= 80 ? 'badge-green' : score >= 60 ? 'badge-orange' : 'badge-red';
  return `<span class="badge ${cls}">${score}%</span>`;
}

function getCurrentWeek() {
  const now = new Date();
  const day = now.getDay();
  const mon = new Date(now);
  mon.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  return { start: mon.toISOString().slice(0, 10), end: sun.toISOString().slice(0, 10) };
}

function setPage(title, subtitle = '') {
  document.getElementById('pageTitle').textContent = title;
  document.getElementById('pageSubtitle').textContent = subtitle;
}

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
}

/* ═══════════════════════════════════════════════════════════════════════════
   INTERN PAGES (public, no login)
   ═══════════════════════════════════════════════════════════════════════════ */
const internPages = {

  async dashboard() {
    setPage('Dashboard', `Good ${getGreeting()}, ${currentUser.name}`);
    try {
      const stats = await api(`/api/interns/${currentUser.id}/stats`);
      const pct = stats.totalTasks > 0 ? Math.round(stats.completedTasks / stats.totalTasks * 100) : 0;
      document.getElementById('pageBody').innerHTML = `
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-icon green">✓</div>
            <div class="stat-value">${stats.completedTasks}</div>
            <div class="stat-label">Tasks Completed</div>
          </div>
          <div class="stat-card">
            <div class="stat-icon blue">⏳</div>
            <div class="stat-value">${stats.pendingTasks}</div>
            <div class="stat-label">Pending Tasks</div>
          </div>
          <div class="stat-card">
            <div class="stat-icon orange">📋</div>
            <div class="stat-value">${stats.totalReports}</div>
            <div class="stat-label">Reports Submitted</div>
          </div>
          <div class="stat-card">
            <div class="stat-icon green">📊</div>
            <div class="stat-value">${pct}%</div>
            <div class="stat-label">Completion Rate</div>
          </div>
          <div class="stat-card" style="cursor:pointer;" onclick="navigateTo('performance')">
            <div class="stat-icon ${stats.avgScore != null && stats.avgScore >= 80 ? 'green' : stats.avgScore != null && stats.avgScore >= 60 ? 'orange' : 'blue'}">★</div>
            <div class="stat-value">${stats.avgScore != null ? stats.avgScore + '%' : '—'}</div>
            <div class="stat-label">Avg Score <span style="font-size:0.7rem; color:var(--green-primary);">View details →</span></div>
          </div>
        </div>
        <div class="content-grid">
          <div class="card">
            <div class="card-header"><h3>Progress</h3></div>
            <div class="card-body">
              <div style="display:flex; justify-content:space-between; margin-bottom:0.5rem;">
                <span style="font-size:0.82rem; color:var(--text-secondary);">Overall completion</span>
                <span style="font-size:0.82rem; font-weight:700; color:var(--green-primary);">${pct}%</span>
              </div>
              <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
              <div style="margin-top:1.5rem;">
                <div style="display:flex; justify-content:space-between; margin-bottom:0.75rem;">
                  <span style="font-size:0.82rem; color:var(--text-secondary);">Total tasks</span>
                  <span style="font-weight:600;">${stats.totalTasks}</span>
                </div>
                <div style="display:flex; justify-content:space-between; margin-bottom:0.75rem;">
                  <span style="font-size:0.82rem; color:var(--text-secondary);">Completed</span>
                  <span style="font-weight:600; color:var(--green-primary);">${stats.completedTasks}</span>
                </div>
                <div style="display:flex; justify-content:space-between;">
                  <span style="font-size:0.82rem; color:var(--text-secondary);">In progress</span>
                  <span style="font-weight:600; color:var(--info);">${stats.pendingTasks}</span>
                </div>
              </div>
            </div>
          </div>
          <div class="card">
            <div class="card-header">
              <h3>Recent Tasks</h3>
              <button class="btn btn-secondary btn-sm" onclick="navigateTo('tasks')">View All</button>
            </div>
            <div class="card-body" style="padding:0;">
              ${stats.recentTasks.length === 0 ? '<div class="empty-state"><p>No tasks yet</p></div>' :
                `<table class="data-table"><tbody>
                  ${stats.recentTasks.map(t => `
                    <tr>
                      <td><span class="priority-dot ${t.priority}"></span>${escHtml(t.title)}</td>
                      <td class="text-right">${statusBadge(t.status)}</td>
                    </tr>
                  `).join('')}
                </tbody></table>`
              }
            </div>
          </div>
        </div>
        <div style="display:flex; gap:1rem; flex-wrap:wrap;">
          <button class="btn btn-primary" onclick="openNewReportModal()">📋 Submit Weekly Report</button>
        </div>
      `;
    } catch (err) { document.getElementById('pageBody').innerHTML = `<p>${err.message}</p>`; }
  },

  async tasks() {
    setPage('My Tasks', 'Tasks assigned to you by admin');
    try {
      const tasks = await api(`/api/interns/${currentUser.id}/tasks`);
      const cols = { todo: [], in_progress: [], review: [], completed: [] };
      tasks.forEach(t => (cols[t.status] || cols.todo).push(t));
      document.getElementById('pageBody').innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem;">
          <div style="font-size:0.88rem; color:var(--text-secondary);">${tasks.length} assigned tasks</div>
        </div>
        ${tasks.length === 0
          ? '<div class="empty-state"><div class="icon">✓</div><h3>No tasks assigned yet</h3><p>Your admin will assign tasks to you.</p></div>'
          : `
          <!-- Desktop: Kanban Board -->
          <div class="kanban-board desktop-only">
          ${['todo', 'in_progress', 'review', 'completed'].map(status => `
            <div class="kanban-column">
              <div class="kanban-column-header">
                <h4>${status.replace(/_/g, ' ')}</h4>
                <span class="kanban-count">${cols[status].length}</span>
              </div>
              <div class="kanban-items">
                ${cols[status].map(t => `
                  <div class="kanban-card" onclick="openInternTaskView(${t.id})">
                    <div class="task-title"><span class="priority-dot ${t.priority}"></span>${escHtml(t.title)}</div>
                    ${t.description ? `<div style="font-size:0.78rem; color:var(--text-secondary); margin-bottom:0.5rem; line-height:1.4;">${escHtml(t.description).substring(0, 80)}${t.description.length > 80 ? '...' : ''}</div>` : ''}
                    <div class="task-meta">
                      <span>${escHtml(t.category)}</span>
                      ${t.due_date ? `<span>Due ${t.due_date}</span>` : ''}
                      ${t.score != null ? scoreBadge(t.score) : ''}
                    </div>
                  </div>
                `).join('')}
              </div>
            </div>
          `).join('')}
          </div>

          <!-- Mobile: Task list cards -->
          <div class="mobile-only" style="display:flex; flex-direction:column; gap:0.75rem;">
            ${tasks.map(t => `
              <div class="task-list-card" onclick="openInternTaskView(${t.id})">
                <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:0.5rem;">
                  <div style="font-weight:600; font-size:0.92rem;"><span class="priority-dot ${t.priority}"></span>${escHtml(t.title)}</div>
                  ${statusBadge(t.status)}
                </div>
                ${t.description ? `<div style="font-size:0.78rem; color:var(--text-secondary); line-height:1.4; margin-bottom:0.5rem;">${escHtml(t.description).substring(0, 100)}${t.description.length > 100 ? '...' : ''}</div>` : ''}
                <div style="display:flex; align-items:center; gap:1rem; font-size:0.75rem; color:var(--text-muted);">
                  <span>${escHtml(t.category)}</span>
                  <span>${statusBadge(t.priority)}</span>
                  ${t.due_date ? `<span>Due ${t.due_date}</span>` : ''}
                  ${t.score != null ? scoreBadge(t.score) : ''}
                </div>
              </div>
            `).join('')}
          </div>`
        }
      `;
    } catch (err) { document.getElementById('pageBody').innerHTML = `<p>${err.message}</p>`; }
  },

  async performance() {
    setPage('My Performance', 'Track how your work is being scored over time');
    try {
      const data = await api(`/api/interns/${currentUser.id}/performance`);
      const o = data.overview;
      const hasData = o.scoredTasks > 0;
      const benchmarkPct = hasData ? Math.round(o.aboveBenchmark / o.scoredTasks * 100) : 0;

      // Build monthly trend bars (CSS-based chart)
      let trendHtml = '';
      if (data.monthlyTrend.length > 0) {
        const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        trendHtml = `
          <div class="card">
            <div class="card-header"><h3>Score Trend</h3></div>
            <div class="card-body">
              <div class="perf-chart">
                ${data.monthlyTrend.map(m => {
                  const [y, mo] = m.month.split('-');
                  const label = monthNames[parseInt(mo) - 1] + ' ' + y.slice(2);
                  const score = +m.avg_score;
                  const color = score >= 80 ? 'var(--green-primary)' : score >= 60 ? 'var(--warning)' : 'var(--danger)';
                  return `
                    <div class="perf-chart-bar-wrap">
                      <div class="perf-chart-value" style="color:${color}">${score}%</div>
                      <div class="perf-chart-bar-bg">
                        <div class="perf-chart-bar-fill" style="height:${score}%;background:${color}"></div>
                        <div class="perf-chart-benchmark"></div>
                      </div>
                      <div class="perf-chart-label">${label}</div>
                      <div class="perf-chart-count">${m.count} task${m.count > 1 ? 's' : ''}</div>
                    </div>`;
                }).join('')}
              </div>
              <div style="display:flex; align-items:center; gap:0.75rem; margin-top:1rem; font-size:0.75rem; color:var(--text-muted);">
                <span style="display:inline-flex; align-items:center; gap:0.3rem;"><span style="width:16px;height:2px;background:var(--warning);display:inline-block;"></span> 80% benchmark</span>
              </div>
            </div>
          </div>`;
      }

      // Category breakdown
      let categoryHtml = '';
      if (data.categoryStats.length > 0) {
        categoryHtml = `
          <div class="card">
            <div class="card-header"><h3>Performance by Category</h3></div>
            <div class="card-body" style="padding:0;">
              <table class="data-table">
                <thead><tr><th>Category</th><th>Tasks</th><th>Avg Score</th><th>Range</th></tr></thead>
                <tbody>
                  ${data.categoryStats.map(c => {
                    const avg = +c.avg_score;
                    const cls = avg >= 80 ? 'badge-green' : avg >= 60 ? 'badge-orange' : 'badge-red';
                    return `<tr>
                      <td style="font-weight:600;">${escHtml(c.category)}</td>
                      <td>${c.count}</td>
                      <td><span class="badge ${cls}">${avg}%</span></td>
                      <td style="font-size:0.82rem; color:var(--text-secondary); font-family:'JetBrains Mono',monospace;">${c.min_score}% – ${c.max_score}%</td>
                    </tr>`;
                  }).join('')}
                </tbody>
              </table>
            </div>
          </div>`;
      }

      // Scored tasks history
      let historyHtml = '';
      if (data.scoredTasks.length > 0) {
        historyHtml = `
          <div class="card">
            <div class="card-header"><h3>Score History</h3></div>
            <div class="card-body" style="padding:0;">
              <!-- Desktop table -->
              <div class="desktop-only">
                <table class="data-table">
                  <thead><tr><th>Task</th><th>Category</th><th>Priority</th><th>Score</th><th>Completed</th></tr></thead>
                  <tbody>
                    ${data.scoredTasks.map(t => `
                      <tr>
                        <td style="font-weight:600;">${escHtml(t.title)}</td>
                        <td style="font-size:0.82rem; color:var(--text-secondary);">${escHtml(t.category)}</td>
                        <td><span class="priority-dot ${t.priority}"></span>${t.priority}</td>
                        <td>${scoreBadge(t.score)}</td>
                        <td style="font-size:0.82rem; color:var(--text-muted); font-family:'JetBrains Mono',monospace;">${t.completed_at ? t.completed_at.slice(0,10) : '—'}</td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
              <!-- Mobile cards -->
              <div class="mobile-only" style="flex-direction:column; gap:0; padding:0;">
                ${data.scoredTasks.map(t => `
                  <div style="padding:0.85rem 1rem; border-bottom:1px solid var(--border);">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.3rem;">
                      <span style="font-weight:600; font-size:0.88rem;">${escHtml(t.title)}</span>
                      ${scoreBadge(t.score)}
                    </div>
                    <div style="font-size:0.75rem; color:var(--text-muted); display:flex; gap:0.75rem;">
                      <span>${escHtml(t.category)}</span>
                      <span>${t.completed_at ? t.completed_at.slice(0,10) : ''}</span>
                    </div>
                  </div>
                `).join('')}
              </div>
            </div>
          </div>`;
      }

      document.getElementById('pageBody').innerHTML = hasData ? `
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-icon ${o.avgScore >= 80 ? 'green' : o.avgScore >= 60 ? 'orange' : 'red'}">★</div>
            <div class="stat-value">${o.avgScore}%</div>
            <div class="stat-label">Average Score</div>
          </div>
          <div class="stat-card">
            <div class="stat-icon blue">✓</div>
            <div class="stat-value">${o.scoredTasks}</div>
            <div class="stat-label">Scored Tasks</div>
          </div>
          <div class="stat-card">
            <div class="stat-icon green">▲</div>
            <div class="stat-value">${o.highestScore}%</div>
            <div class="stat-label">Best Score</div>
          </div>
          <div class="stat-card">
            <div class="stat-icon ${o.lowestScore >= 80 ? 'green' : o.lowestScore >= 60 ? 'orange' : 'red'}">▼</div>
            <div class="stat-value">${o.lowestScore}%</div>
            <div class="stat-label">Lowest Score</div>
          </div>
        </div>

        <div style="margin-bottom:1.5rem;">
          <div class="card">
            <div class="card-body">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;">
                <span style="font-size:0.88rem; font-weight:600;">Benchmark Status</span>
                <span style="font-size:0.88rem; font-weight:700; color:var(--green-primary);">${benchmarkPct}% above 80%</span>
              </div>
              <div class="progress-bar" style="height:10px;">
                <div class="progress-fill" style="width:${benchmarkPct}%;"></div>
              </div>
              <div style="display:flex; justify-content:space-between; margin-top:0.75rem; font-size:0.82rem; color:var(--text-secondary);">
                <span>${o.aboveBenchmark} task${o.aboveBenchmark !== 1 ? 's' : ''} meet benchmark (80%+)</span>
                <span>${o.belowBenchmark} below</span>
              </div>
            </div>
          </div>
        </div>

        ${trendHtml}
        <div style="margin-top:1.5rem;">${categoryHtml}</div>
        <div style="margin-top:1.5rem;">${historyHtml}</div>
      ` : `
        <div class="empty-state">
          <div class="icon">★</div>
          <h3>No scores yet</h3>
          <p>Once your admin scores your completed tasks, your performance data will appear here.</p>
          <button class="btn btn-secondary btn-sm" onclick="navigateTo('tasks')" style="margin-top:1rem;">View My Tasks</button>
        </div>
      `;
    } catch (err) { document.getElementById('pageBody').innerHTML = `<p>${err.message}</p>`; }
  },

  async reports() {
    setPage('Weekly Reports', 'Your submitted reports');
    try {
      const reports = await api(`/api/interns/${currentUser.id}/reports`);
      document.getElementById('pageBody').innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.5rem;">
          <div style="font-size:0.88rem; color:var(--text-secondary);">${reports.length} reports</div>
          <button class="btn btn-primary btn-sm" onclick="openNewReportModal()">+ New Report</button>
        </div>
        ${reports.length === 0 ? '<div class="empty-state"><div class="icon">📋</div><h3>No reports yet</h3><p>Submit your first weekly report to get started.</p></div>' :
          reports.map(r => `
            <div class="report-card">
              <div class="report-header">
                <div style="display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap;">
                  <span class="report-dates">${r.week_start} → ${r.week_end}</span>
                  ${statusBadge(r.status)}
                  <span class="mood-indicator" title="${r.mood}">${moodEmoji(r.mood)}</span>
                  <span style="font-size:0.75rem; color:var(--text-muted);">${r.hours_worked}h</span>
                </div>
              </div>
              <div class="report-body">
                <h4>Summary</h4>
                <p>${escHtml(r.summary)}</p>
                ${r.challenges ? `<h4>Challenges</h4><p>${escHtml(r.challenges)}</p>` : ''}
                ${r.plans_next_week ? `<h4>Plans for Next Week</h4><p>${escHtml(r.plans_next_week)}</p>` : ''}
              </div>
              ${r.admin_feedback ? `
                <div class="report-feedback">
                  <h4>Admin Feedback</h4>
                  <p>${escHtml(r.admin_feedback)}</p>
                </div>
              ` : ''}
            </div>
          `).join('')
        }
      `;
    } catch (err) { document.getElementById('pageBody').innerHTML = `<p>${err.message}</p>`; }
  },
};

// ── Intern Modals ───────────────────────────────────────────────────────────
async function openInternTaskView(taskId) {
  const tasks = await api(`/api/interns/${currentUser.id}/tasks`);
  const t = tasks.find(x => x.id === taskId);
  if (!t) return;
  openModal('Task Details', `
    <div style="margin-bottom:1.5rem;">
      <div style="display:flex; align-items:center; gap:0.75rem; margin-bottom:1rem;">
        <span class="priority-dot ${t.priority}" style="width:10px;height:10px;"></span>
        <h3 style="font-size:1.1rem; font-weight:700;">${escHtml(t.title)}</h3>
      </div>
      ${t.description ? `<p style="color:var(--text-secondary); line-height:1.6; margin-bottom:1rem;">${escHtml(t.description)}</p>` : ''}
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:1rem;">
        <div style="padding:0.75rem; background:var(--bg-input); border-radius:var(--radius-md);">
          <div style="font-size:0.7rem; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px;">Category</div>
          <div style="font-weight:600; margin-top:0.25rem;">${escHtml(t.category)}</div>
        </div>
        <div style="padding:0.75rem; background:var(--bg-input); border-radius:var(--radius-md);">
          <div style="font-size:0.7rem; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px;">Priority</div>
          <div style="font-weight:600; margin-top:0.25rem;">${statusBadge(t.priority)}</div>
        </div>
        <div style="padding:0.75rem; background:var(--bg-input); border-radius:var(--radius-md);">
          <div style="font-size:0.7rem; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px;">Due Date</div>
          <div style="font-weight:600; margin-top:0.25rem; font-family:'JetBrains Mono',monospace;">${t.due_date || 'No deadline'}</div>
        </div>
        <div style="padding:0.75rem; background:var(--bg-input); border-radius:var(--radius-md);">
          <div style="font-size:0.7rem; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px;">Assigned</div>
          <div style="font-weight:600; margin-top:0.25rem; font-family:'JetBrains Mono',monospace;">${t.created_at ? t.created_at.slice(0,10) : '—'}</div>
        </div>
      </div>
      ${t.score != null ? `
      <div style="margin-top:1rem; padding:1rem; background:var(--bg-input); border-radius:var(--radius-md); display:flex; align-items:center; justify-content:space-between;">
        <div>
          <div style="font-size:0.7rem; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px;">Performance Score</div>
          <div style="font-weight:700; font-size:1.25rem; margin-top:0.25rem; color:${t.score >= 80 ? 'var(--green-primary)' : t.score >= 60 ? 'var(--warning)' : 'var(--danger)'};">${t.score}%</div>
        </div>
        <div style="font-size:0.78rem; color:var(--text-secondary);">${t.score >= 80 ? 'Meets benchmark' : t.score >= 60 ? 'Below benchmark' : 'Needs improvement'}</div>
      </div>` : ''}
    </div>
    ${t.status === 'completed' ? `
    <div style="padding:0.75rem 1rem; background:rgba(0,230,118,0.08); border:1px solid rgba(0,230,118,0.2); border-radius:var(--radius-md); display:flex; align-items:center; gap:0.5rem;">
      <span style="color:var(--green-primary);">✓</span>
      <span style="font-size:0.85rem; color:var(--text-secondary);">This task is completed and locked. Contact your admin for changes.</span>
    </div>
    ` : `
    <div class="form-group">
      <label>Update Progress</label>
      <select class="form-input" id="internTaskStatus">
        ${['todo','in_progress','review','completed'].map(s =>
          `<option value="${s}" ${t.status === s ? 'selected' : ''}>${s.replace(/_/g,' ')}</option>`).join('')}
      </select>
    </div>
    `}
  `, `
    <button class="btn btn-secondary" onclick="closeModal()">Close</button>
    ${t.status !== 'completed' ? `<button class="btn btn-primary" onclick="updateInternTaskStatus(${t.id})">Update Status</button>` : ''}
  `);
}

async function updateInternTaskStatus(taskId) {
  try {
    const status = document.getElementById('internTaskStatus').value;
    await api(`/api/interns/${currentUser.id}/tasks/${taskId}/status`, {
      method: 'PUT',
      body: { status }
    });
    closeModal(); toast('Status updated!'); navigateTo(currentPage);
  } catch (err) { toast(err.message, 'error'); }
}

function openNewReportModal() {
  const week = getCurrentWeek();
  openModal('Submit Weekly Report', `
    <form id="newReportForm" onsubmit="return submitReport(event)">
      <div class="form-row">
        <div class="form-group">
          <label>Week Start</label>
          <input type="date" class="form-input" id="reportStart" value="${week.start}" required>
        </div>
        <div class="form-group">
          <label>Week End</label>
          <input type="date" class="form-input" id="reportEnd" value="${week.end}" required>
        </div>
      </div>
      <div class="form-group">
        <label>Summary of Work Done</label>
        <textarea class="form-input" id="reportSummary" placeholder="Describe the tasks you completed this week, key accomplishments, and progress made..." required style="min-height:130px;"></textarea>
      </div>
      <div class="form-group">
        <label>Challenges & Blockers</label>
        <textarea class="form-input" id="reportChallenges" placeholder="Any obstacles you faced or areas where you need help..."></textarea>
      </div>
      <div class="form-group">
        <label>Plans for Next Week</label>
        <textarea class="form-input" id="reportPlans" placeholder="What do you plan to work on next week?"></textarea>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Hours Worked</label>
          <input type="number" class="form-input" id="reportHours" value="40" min="0" max="80" step="0.5">
        </div>
        <div class="form-group">
          <label>How are you feeling?</label>
          <select class="form-input" id="reportMood">
            <option value="great">🟢 Great</option><option value="good">🔵 Good</option>
            <option value="neutral" selected>⚪ Neutral</option><option value="struggling">🔴 Struggling</option>
          </select>
        </div>
      </div>
    </form>
  `, `
    <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
    <button class="btn btn-secondary" onclick="submitReportAs('draft')">Save Draft</button>
    <button class="btn btn-primary" onclick="document.getElementById('newReportForm').requestSubmit()">Submit Report</button>
  `);
}

async function submitReport(e) {
  e.preventDefault();
  await submitReportAs('submitted');
  return false;
}

async function submitReportAs(status) {
  try {
    await api(`/api/interns/${currentUser.id}/reports`, {
      method: 'POST',
      body: {
        week_start: document.getElementById('reportStart').value,
        week_end: document.getElementById('reportEnd').value,
        summary: document.getElementById('reportSummary').value,
        challenges: document.getElementById('reportChallenges').value,
        plans_next_week: document.getElementById('reportPlans').value,
        hours_worked: parseFloat(document.getElementById('reportHours').value) || 0,
        mood: document.getElementById('reportMood').value,
        status: status,
      }
    });
    closeModal();
    toast(status === 'draft' ? 'Draft saved!' : 'Report submitted!');
    navigateTo(currentPage);
  } catch (err) { toast(err.message, 'error'); }
}

/* ═══════════════════════════════════════════════════════════════════════════
   ADMIN PAGES (login required)
   ═══════════════════════════════════════════════════════════════════════════ */
const adminPages = {

  async dashboard() {
    setPage('Admin Dashboard', 'Overview of all intern activity');
    try {
      const stats = await api('/api/admin/stats');
      const taskPct = stats.totalTasks > 0 ? Math.round(stats.completedTasks / stats.totalTasks * 100) : 0;
      document.getElementById('pageBody').innerHTML = `
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-icon green">👥</div>
            <div class="stat-value">${stats.totalInterns}</div>
            <div class="stat-label">Active Interns</div>
          </div>
          <div class="stat-card">
            <div class="stat-icon orange">📋</div>
            <div class="stat-value">${stats.pendingReports}</div>
            <div class="stat-label">Pending Reviews</div>
          </div>
          ${stats.pendingInterns > 0 ? `
          <div class="stat-card" style="cursor:pointer; border:1px solid var(--warning);" onclick="navigateTo('interns')">
            <div class="stat-icon orange">⏳</div>
            <div class="stat-value">${stats.pendingInterns}</div>
            <div class="stat-label">Pending Approvals</div>
          </div>` : ''}
          <div class="stat-card">
            <div class="stat-icon blue">✓</div>
            <div class="stat-value">${stats.totalTasks}</div>
            <div class="stat-label">Total Tasks</div>
          </div>
          <div class="stat-card">
            <div class="stat-icon green">📊</div>
            <div class="stat-value">${taskPct}%</div>
            <div class="stat-label">Task Completion</div>
          </div>
          <div class="stat-card">
            <div class="stat-icon ${stats.avgScore != null && stats.avgScore >= 80 ? 'green' : stats.avgScore != null && stats.avgScore >= 60 ? 'orange' : 'blue'}">★</div>
            <div class="stat-value">${stats.avgScore != null ? stats.avgScore + '%' : '—'}</div>
            <div class="stat-label">Avg Score</div>
          </div>
        </div>
        <div class="content-grid">
          <div class="card">
            <div class="card-header">
              <h3>Recent Reports</h3>
              <button class="btn btn-secondary btn-sm" onclick="navigateTo('reports')">View All</button>
            </div>
            <div class="card-body" style="padding:0;">
              ${stats.recentReports.length === 0
                ? '<div class="empty-state"><p>No reports yet</p></div>'
                : `<table class="data-table">
                    <thead><tr><th>Intern</th><th>Week</th><th>Mood</th><th>Status</th></tr></thead>
                    <tbody>
                      ${stats.recentReports.map(r => `
                        <tr style="cursor:pointer" onclick="navigateTo('reports')">
                          <td><div style="display:flex;align-items:center;gap:0.5rem;">
                            <div class="user-avatar" style="width:28px;height:28px;font-size:0.7rem;background:${r.avatar_color}">${r.intern_name.charAt(0)}</div>
                            ${escHtml(r.intern_name)}
                          </div></td>
                          <td style="font-size:0.78rem; font-family:'JetBrains Mono',monospace;">${r.week_start}</td>
                          <td>${moodEmoji(r.mood)}</td>
                          <td>${statusBadge(r.status)}</td>
                        </tr>
                      `).join('')}
                    </tbody>
                  </table>`
              }
            </div>
          </div>
          <div class="card">
            <div class="card-header"><h3>Departments</h3></div>
            <div class="card-body">
              ${stats.departmentStats.length === 0
                ? '<div class="empty-state"><p>No interns registered yet</p></div>'
                : stats.departmentStats.map(d => `
                    <div style="display:flex; justify-content:space-between; align-items:center; padding:0.6rem 0; border-bottom:1px solid var(--border);">
                      <span style="font-size:0.9rem;">${escHtml(d.department)}</span>
                      <span class="badge badge-green">${d.count} intern${d.count > 1 ? 's' : ''}</span>
                    </div>
                  `).join('')
              }
            </div>
          </div>
        </div>
      `;
    } catch (err) { document.getElementById('pageBody').innerHTML = `<p>${err.message}</p>`; }
  },

  async interns() {
    setPage('Interns', 'Manage and register interns');
    try {
      const interns = await api('/api/admin/interns');
      document.getElementById('pageBody').innerHTML = `
        <div class="filter-bar">
          <div class="search-input">
            <input type="text" placeholder="Search interns..." oninput="filterInterns(this.value)">
          </div>
          <button class="btn btn-primary btn-sm" onclick="openAddInternModal()">+ Add Intern</button>
        </div>
        <div id="internsList">
          ${interns.length === 0
            ? '<div class="empty-state"><div class="icon">👥</div><h3>No interns yet</h3><p>Click "Add Intern" to register a new intern.</p></div>'
            : interns.map(i => `
              <div class="intern-card${i.status === 'pending' ? ' pending-card' : ''}" data-name="${escHtml(i.full_name.toLowerCase())}" onclick="viewInternDetail(${i.id})" style="${i.status === 'pending' ? 'border-left:3px solid var(--warning);' : ''}">
                <div class="user-avatar" style="background:${i.avatar_color}">${i.full_name.charAt(0)}</div>
                <div class="intern-info">
                  <div class="intern-name">${escHtml(i.full_name)}</div>
                  <div class="intern-dept">${escHtml(i.department)} · ${escHtml(i.intern_id)} · Started ${i.start_date}</div>
                </div>
                ${i.status === 'pending' ? `
                  <div class="intern-stats" style="gap:0.5rem;">
                    <button class="btn btn-primary btn-sm" onclick="event.stopPropagation(); approveIntern(${i.id})">Approve</button>
                    <button class="btn btn-danger btn-sm" onclick="event.stopPropagation(); rejectIntern(${i.id})">Reject</button>
                  </div>
                ` : `
                  <div class="intern-stats">
                    <span>📋 ${i.total_reports} reports</span>
                    <span>✓ ${i.completed_tasks}/${i.total_tasks} tasks</span>
                    <span title="Average score across all scored tasks">★ ${i.avg_score != null ? i.avg_score + '%' : 'No scores'}</span>
                  </div>
                `}
                ${statusBadge(i.status)}
              </div>
            `).join('')
          }
        </div>
      `;
    } catch (err) { document.getElementById('pageBody').innerHTML = `<p>${err.message}</p>`; }
  },

  async reports() {
    setPage('Weekly Reports', 'Review intern submissions');
    try {
      const reports = await api('/api/admin/reports');
      document.getElementById('pageBody').innerHTML = `
        <div class="filter-bar">
          <div class="search-input">
            <input type="text" placeholder="Search reports..." oninput="filterReports(this.value)">
          </div>
        </div>
        <div id="reportsList">
          ${reports.length === 0
            ? '<div class="empty-state"><div class="icon">📋</div><h3>No reports submitted yet</h3></div>'
            : reports.map(r => `
              <div class="report-card" data-search="${escHtml((r.intern_name + ' ' + r.summary).toLowerCase())}">
                <div class="report-header" style="flex-wrap:wrap; gap:0.5rem;">
                  <div class="report-author">
                    <div class="user-avatar" style="width:32px;height:32px;font-size:0.8rem;background:${r.avatar_color}">${r.intern_name.charAt(0)}</div>
                    <div>
                      <div style="font-weight:600; font-size:0.92rem;">${escHtml(r.intern_name)}</div>
                      <div style="font-size:0.75rem; color:var(--text-muted);">${escHtml(r.department)}</div>
                    </div>
                  </div>
                  <div style="display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap;">
                    <span class="mood-indicator" title="${r.mood}">${moodEmoji(r.mood)}</span>
                    <span class="report-dates">${r.week_start} → ${r.week_end}</span>
                    ${statusBadge(r.status)}
                  </div>
                </div>
                <div class="report-body">
                  <h4>Summary</h4>
                  <p>${escHtml(r.summary)}</p>
                  ${r.challenges ? `<h4>Challenges</h4><p>${escHtml(r.challenges)}</p>` : ''}
                  ${r.plans_next_week ? `<h4>Plans for Next Week</h4><p>${escHtml(r.plans_next_week)}</p>` : ''}
                </div>
                <div style="display:flex; align-items:center; justify-content:space-between; margin-top:1rem; padding-top:1rem; border-top:1px solid var(--border); flex-wrap:wrap; gap:0.5rem;">
                  <span style="font-size:0.78rem; color:var(--text-muted);">${r.hours_worked}h · Submitted: ${formatDateTime(r.submitted_at)}</span>
                  ${r.status !== 'reviewed'
                    ? `<button class="btn btn-primary btn-sm" onclick="openReviewModal(${r.id})">Review</button>`
                    : `<span class="badge badge-green">✓ Reviewed</span>`
                  }
                </div>
                ${r.admin_feedback ? `
                  <div class="report-feedback">
                    <h4>Your Feedback</h4>
                    <p>${escHtml(r.admin_feedback)}</p>
                  </div>
                ` : ''}
              </div>
            `).join('')
          }
        </div>
      `;
    } catch (err) { document.getElementById('pageBody').innerHTML = `<p>${err.message}</p>`; }
  },

  async tasks() {
    setPage('All Tasks', 'Assign and track tasks across all interns');
    try {
      const tasks = await api('/api/admin/tasks');
      document.getElementById('pageBody').innerHTML = `
        <div class="filter-bar">
          <div class="search-input">
            <input type="text" placeholder="Search tasks..." oninput="filterTasks(this.value)">
          </div>
          <button class="btn btn-primary btn-sm" onclick="openAssignTaskModal()">+ Assign Task</button>
        </div>
        <!-- Desktop: Table view -->
        <div class="card desktop-only">
          <div class="card-body" style="padding:0;">
            ${tasks.length === 0
              ? '<div class="empty-state"><div class="icon">✓</div><h3>No tasks yet</h3><p>Click "Assign Task" to give an intern work.</p></div>'
              : `<table class="data-table" id="tasksTable">
                  <thead><tr><th>Task</th><th>Assigned To</th><th>Category</th><th>Priority</th><th>Status</th><th>Score</th><th>Due</th><th>Completed At</th><th></th></tr></thead>
                  <tbody>
                    ${tasks.map(t => `
                      <tr data-search="${escHtml((t.title + ' ' + t.intern_name).toLowerCase())}">
                        <td style="font-weight:600; cursor:pointer;" onclick="openAdminTaskEdit(${t.id})">${escHtml(t.title)}</td>
                        <td><div style="display:flex;align-items:center;gap:0.5rem;">
                          <div class="user-avatar" style="width:24px;height:24px;font-size:0.65rem;background:${t.avatar_color}">${t.intern_name.charAt(0)}</div>
                          ${escHtml(t.intern_name)}
                        </div></td>
                        <td><span style="font-size:0.82rem; color:var(--text-secondary)">${escHtml(t.category)}</span></td>
                        <td><span class="priority-dot ${t.priority}"></span>${t.priority}</td>
                        <td>${statusBadge(t.status)}</td>
                        <td>${t.score != null ? scoreBadge(t.score) : '<span style="color:var(--text-muted);">—</span>'}</td>
                        <td style="font-size:0.82rem; color:var(--text-muted); font-family:'JetBrains Mono',monospace;">${t.due_date || '—'}</td>
                        <td style="font-size:0.78rem; color:${t.completed_at ? 'var(--green-primary)' : 'var(--text-muted)'}; font-family:'JetBrains Mono',monospace;">${t.completed_at ? formatDateTime(t.completed_at) : '—'}</td>
                        <td>
                          <button class="btn-ghost btn-icon" onclick="openAdminTaskEdit(${t.id})" title="Edit">✎</button>
                          <button class="btn-ghost btn-icon" onclick="deleteAdminTask(${t.id})" title="Delete" style="color:var(--danger);">✕</button>
                        </td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>`
            }
          </div>
        </div>

        <!-- Mobile: Card view -->
        <div class="mobile-only" id="tasksCards" style="display:flex; flex-direction:column; gap:0.75rem;">
          ${tasks.length === 0
            ? '<div class="empty-state"><div class="icon">✓</div><h3>No tasks yet</h3><p>Click "Assign Task" to give an intern work.</p></div>'
            : tasks.map(t => `
              <div class="task-list-card" data-search="${escHtml((t.title + ' ' + t.intern_name).toLowerCase())}" onclick="openAdminTaskEdit(${t.id})">
                <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:0.4rem;">
                  <div style="font-weight:600; font-size:0.92rem;"><span class="priority-dot ${t.priority}"></span>${escHtml(t.title)}</div>
                  ${statusBadge(t.status)}
                </div>
                <div style="display:flex; align-items:center; gap:0.5rem; margin-bottom:0.5rem;">
                  <div class="user-avatar" style="width:20px;height:20px;font-size:0.55rem;background:${t.avatar_color}">${t.intern_name.charAt(0)}</div>
                  <span style="font-size:0.8rem; color:var(--text-secondary);">${escHtml(t.intern_name)}</span>
                </div>
                <div style="display:flex; align-items:center; gap:0.75rem; font-size:0.75rem; color:var(--text-muted); flex-wrap:wrap;">
                  <span>${escHtml(t.category)}</span>
                  <span>${statusBadge(t.priority)}</span>
                  ${t.due_date ? `<span>Due ${t.due_date}</span>` : ''}
                  ${t.score != null ? scoreBadge(t.score) : ''}
                  ${t.completed_at ? `<span style="color:var(--green-primary);">✓ ${formatDateTime(t.completed_at)}</span>` : ''}
                </div>
              </div>
            `).join('')
          }
        </div>
      `;
    } catch (err) { document.getElementById('pageBody').innerHTML = `<p>${err.message}</p>`; }
  },
};

// ── Admin Modals ────────────────────────────────────────────────────────────
function openReviewModal(reportId) {
  openModal('Review Report', `
    <form id="reviewForm" onsubmit="return submitReview(event, ${reportId})">
      <div class="form-group">
        <label>Your Feedback</label>
        <textarea class="form-input" id="reviewFeedback" placeholder="Write feedback for the intern..." required style="min-height:150px;"></textarea>
      </div>
    </form>
  `, `
    <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="document.getElementById('reviewForm').requestSubmit()">Submit Review</button>
  `);
}

async function submitReview(e, id) {
  e.preventDefault();
  try {
    await api(`/api/admin/reports/${id}`, {
      method: 'PUT',
      body: { admin_feedback: document.getElementById('reviewFeedback').value, status: 'reviewed' }
    });
    closeModal(); toast('Review submitted!'); navigateTo('reports');
  } catch (err) { toast(err.message, 'error'); }
  return false;
}

async function viewInternDetail(id) {
  try {
    const data = await api(`/api/admin/interns/${id}`);
    const i = data.intern;
    const taskPct = data.tasks.length > 0
      ? Math.round(data.tasks.filter(t => t.status === 'completed').length / data.tasks.length * 100) : 0;
    const scores = data.scores || { scoredTasks: 0, avgScore: null };
    const scoredTasks = data.tasks.filter(t => t.score != null);
    openModal(`${i.full_name}`, `
      <div style="display:flex; align-items:center; gap:1rem; margin-bottom:1.5rem; padding-bottom:1.5rem; border-bottom:1px solid var(--border);">
        <div class="user-avatar" style="width:56px;height:56px;font-size:1.5rem;background:${i.avatar_color}">${i.full_name.charAt(0)}</div>
        <div style="flex:1;">
          <div style="font-size:1.1rem; font-weight:700;">${escHtml(i.full_name)}</div>
          <div style="font-size:0.82rem; color:var(--text-muted);">${escHtml(i.department)} · ${escHtml(i.intern_id)}</div>
          <div style="font-size:0.78rem; color:var(--text-muted); margin-top:0.25rem;">${escHtml(i.email)} · Started ${i.start_date}</div>
        </div>
        ${statusBadge(i.status)}
      </div>
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(80px, 1fr)); gap:0.5rem; margin-bottom:1.5rem;">
        <div style="text-align:center; padding:1rem; background:var(--bg-input); border-radius:var(--radius-md);">
          <div style="font-size:1.5rem; font-weight:800;">${data.tasks.length}</div>
          <div style="font-size:0.75rem; color:var(--text-muted);">Tasks</div>
        </div>
        <div style="text-align:center; padding:1rem; background:var(--bg-input); border-radius:var(--radius-md);">
          <div style="font-size:1.5rem; font-weight:800;">${data.reports.length}</div>
          <div style="font-size:0.75rem; color:var(--text-muted);">Reports</div>
        </div>
        <div style="text-align:center; padding:1rem; background:var(--bg-input); border-radius:var(--radius-md);">
          <div style="font-size:1.5rem; font-weight:800; color:var(--green-primary);">${taskPct}%</div>
          <div style="font-size:0.75rem; color:var(--text-muted);">Completion</div>
        </div>
        <div style="text-align:center; padding:1rem; background:var(--bg-input); border-radius:var(--radius-md);">
          <div style="font-size:1.5rem; font-weight:800; color:${scores.avgScore == null ? 'var(--text-muted)' : scores.avgScore >= 80 ? 'var(--green-primary)' : scores.avgScore >= 60 ? 'var(--warning)' : 'var(--danger)'};">${scores.avgScore != null ? scores.avgScore + '%' : '—'}</div>
          <div style="font-size:0.75rem; color:var(--text-muted);">Avg Score</div>
        </div>
      </div>

      <h4 style="font-size:0.78rem; text-transform:uppercase; letter-spacing:0.5px; color:var(--text-muted); margin-bottom:0.5rem;">Scores</h4>
      ${scoredTasks.length === 0
        ? '<p style="color:var(--text-muted); font-size:0.85rem; margin-bottom:1rem;">No scores available yet.</p>'
        : `<div style="margin-bottom:1rem;">${scoredTasks.slice(0, 8).map(t => `
            <div style="display:flex; align-items:center; justify-content:space-between; padding:0.55rem 0; border-bottom:1px solid var(--border); gap:0.75rem;">
              <div style="min-width:0;">
                <div style="font-weight:600; font-size:0.88rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escHtml(t.title)}</div>
                <div style="font-size:0.72rem; color:var(--text-muted);">${escHtml(t.category)} · ${t.completed_at ? t.completed_at.slice(0,10) : (t.created_at ? t.created_at.slice(0,10) : '—')}</div>
              </div>
              ${scoreBadge(t.score)}
            </div>
          `).join('')}${scoredTasks.length > 8 ? `<div style="font-size:0.75rem; color:var(--text-muted); padding-top:0.5rem;">+ ${scoredTasks.length - 8} more scored task${scoredTasks.length - 8 > 1 ? 's' : ''}</div>` : ''}</div>`
      }
      ${data.tasks.length > 0 ? `
        <h4 style="font-size:0.78rem; text-transform:uppercase; letter-spacing:0.5px; color:var(--text-muted); margin-bottom:0.5rem;">Recent Tasks</h4>
        ${data.tasks.slice(0, 5).map(t => `
          <div style="display:flex; align-items:center; justify-content:space-between; padding:0.6rem 0; border-bottom:1px solid var(--border);">
            <span><span class="priority-dot ${t.priority}"></span>${escHtml(t.title)}</span>
            ${statusBadge(t.status)}
          </div>
        `).join('')}
      ` : ''}
      ${data.reports.length > 0 ? `
        <h4 style="font-size:0.78rem; text-transform:uppercase; letter-spacing:0.5px; color:var(--text-muted); margin-top:1.5rem; margin-bottom:0.5rem;">Recent Reports</h4>
        ${data.reports.slice(0, 3).map(r => `
          <div style="padding:0.75rem; background:var(--bg-input); border-radius:var(--radius-md); margin-bottom:0.5rem;">
            <div style="display:flex; justify-content:space-between; margin-bottom:0.3rem;">
              <span style="font-size:0.82rem; font-family:'JetBrains Mono',monospace;">${r.week_start} → ${r.week_end}</span>
              ${statusBadge(r.status)}
            </div>
            <p style="font-size:0.82rem; color:var(--text-secondary); margin-top:0.25rem;">${escHtml(r.summary).substring(0, 150)}${r.summary.length > 150 ? '...' : ''}</p>
          </div>
        `).join('')}
      ` : ''}
    `, `
      ${i.status === 'pending'
        ? `<button class="btn btn-primary btn-sm" onclick="changeInternStatus(${i.id}, 'active')">Approve</button>
           <button class="btn btn-danger btn-sm" onclick="changeInternStatus(${i.id}, 'suspended')">Reject</button>`
        : i.status === 'active'
          ? `<button class="btn btn-danger btn-sm" onclick="changeInternStatus(${i.id}, 'suspended')">Suspend</button>`
          : `<button class="btn btn-primary btn-sm" onclick="changeInternStatus(${i.id}, 'active')">Reactivate</button>`
      }
      <button class="btn btn-secondary btn-sm" onclick="generateResetLink(${i.id})" title="Generate a one-time password reset link">🔑 Reset Link</button>
      <div style="flex:1"></div>
      <button class="btn btn-secondary" onclick="closeModal()">Close</button>
    `);
  } catch (err) { toast(err.message, 'error'); }
}

async function changeInternStatus(id, status) {
  await api(`/api/admin/interns/${id}/status`, { method: 'PUT', body: { status } });
  closeModal(); toast(`Intern ${status}`); navigateTo('interns');
}

async function generateResetLink(id) {
  try {
    const data = await api(`/api/admin/interns/${id}/reset-link`, { method: 'POST' });
    openModal('Password Reset Link', `
      <p style="color:var(--text-secondary); font-size:0.88rem; margin-bottom:1rem; line-height:1.5;">
        Share this one-time link with <strong>${escHtml(data.email)}</strong>. It expires in ${data.expiresInMinutes} minutes and can only be used once.
      </p>
      <div class="form-group">
        <input type="text" class="form-input" id="resetLinkField" value="${escHtml(data.link)}" readonly onclick="this.select()" style="font-family:'JetBrains Mono',monospace; font-size:0.78rem;">
      </div>
    `, `
      <button class="btn btn-secondary" onclick="closeModal()">Close</button>
      <button class="btn btn-primary" onclick="copyResetLink()">Copy Link</button>
    `);
  } catch (err) { toast(err.message, 'error'); }
}

function copyResetLink() {
  const field = document.getElementById('resetLinkField');
  field.select();
  const done = () => toast('Reset link copied!');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(field.value).then(done).catch(() => { document.execCommand('copy'); done(); });
  } else {
    document.execCommand('copy'); done();
  }
}

async function approveIntern(id) {
  try {
    await api(`/api/admin/interns/${id}/status`, { method: 'PUT', body: { status: 'active' } });
    toast('Intern approved!');
    navigateTo('interns');
    loadNotifications();
  } catch (err) { toast(err.message, 'error'); }
}

async function rejectIntern(id) {
  if (!confirm('Reject this intern signup? This will suspend their account.')) return;
  try {
    await api(`/api/admin/interns/${id}/status`, { method: 'PUT', body: { status: 'suspended' } });
    toast('Intern rejected');
    navigateTo('interns');
  } catch (err) { toast(err.message, 'error'); }
}

function openAddInternModal() {
  openModal('Add New Intern', `
    <form id="addInternForm" onsubmit="return submitAddIntern(event)">
      <div class="form-group">
        <label>Full Name</label>
        <input type="text" class="form-input" id="addInternName" placeholder="John Doe" required>
      </div>
      <div class="form-group">
        <label>Email</label>
        <input type="email" class="form-input" id="addInternEmail" placeholder="john@example.com" required>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Department</label>
          <select class="form-input" id="addInternDept" required>
            <option value="">Select...</option>
            <option>Junior Dev</option><option>Digital Marketer</option><option>Graphics Designer</option><option>Video Editor</option><option>Product Designer</option><option>Product Manager</option><option>Quality Assurance</option>
          </select>
        </div>
        <div class="form-group">
          <label>Start Date</label>
          <input type="date" class="form-input" id="addInternStart" required>
        </div>
      </div>
    </form>
  `, `
    <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="document.getElementById('addInternForm').requestSubmit()">Add Intern</button>
  `);
}

async function submitAddIntern(e) {
  e.preventDefault();
  try {
    const data = await api('/api/admin/interns', {
      method: 'POST',
      body: {
        full_name: document.getElementById('addInternName').value,
        email: document.getElementById('addInternEmail').value,
        department: document.getElementById('addInternDept').value,
        start_date: document.getElementById('addInternStart').value,
      }
    });
    closeModal(); toast('Intern added successfully!');
    navigateTo('interns');
  } catch (err) { toast(err.message, 'error'); }
  return false;
}

// ── Admin: Assign / Edit / Delete Tasks ─────────────────────────────────────
async function openAssignTaskModal() {
  const interns = await api('/api/interns');
  if (interns.length === 0) { toast('Add interns first before assigning tasks', 'error'); return; }
  openModal('Assign Task to Intern', `
    <form id="assignTaskForm" onsubmit="return submitAssignTask(event)">
      <div class="form-group">
        <label>Assign To</label>
        <select class="form-input" id="assignIntern" required>
          <option value="">Select intern...</option>
          ${interns.map(i => `<option value="${i.id}">${escHtml(i.full_name)} — ${escHtml(i.department)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Task Title</label>
        <input type="text" class="form-input" id="assignTitle" placeholder="What should they work on?" required>
      </div>
      <div class="form-group">
        <label>Description</label>
        <textarea class="form-input" id="assignDesc" placeholder="Detailed instructions, goals, acceptance criteria..."></textarea>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Category</label>
          <select class="form-input" id="assignCategory">
            <option>General</option><option>Development</option><option>Research</option>
            <option>Design</option><option>Testing</option><option>Documentation</option><option>Meeting</option>
          </select>
        </div>
        <div class="form-group">
          <label>Priority</label>
          <select class="form-input" id="assignPriority">
            <option value="low">Low</option><option value="medium" selected>Medium</option>
            <option value="high">High</option><option value="critical">Critical</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label>Due Date</label>
        <input type="date" class="form-input" id="assignDue">
      </div>
    </form>
  `, `
    <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="document.getElementById('assignTaskForm').requestSubmit()">Assign Task</button>
  `);
}

async function submitAssignTask(e) {
  e.preventDefault();
  try {
    await api('/api/admin/tasks', {
      method: 'POST',
      body: {
        intern_id: parseInt(document.getElementById('assignIntern').value),
        title: document.getElementById('assignTitle').value,
        description: document.getElementById('assignDesc').value,
        category: document.getElementById('assignCategory').value,
        priority: document.getElementById('assignPriority').value,
        due_date: document.getElementById('assignDue').value || null,
      }
    });
    closeModal(); toast('Task assigned!'); navigateTo('tasks');
  } catch (err) { toast(err.message, 'error'); }
  return false;
}

async function openAdminTaskEdit(taskId) {
  const tasks = await api('/api/admin/tasks');
  const t = tasks.find(x => x.id === taskId);
  if (!t) return;
  const interns = await api('/api/interns');
  openModal('Edit Task', `
    <form id="editAdminTaskForm" onsubmit="return submitAdminTaskEdit(event, ${t.id})">
      <div class="form-group">
        <label>Assigned To</label>
        <select class="form-input" id="editAdminIntern" required>
          ${interns.map(i => `<option value="${i.id}" ${i.id === t.intern_id ? 'selected' : ''}>${escHtml(i.full_name)} — ${escHtml(i.department)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Task Title</label>
        <input type="text" class="form-input" id="editAdminTitle" value="${escHtml(t.title)}" required>
      </div>
      <div class="form-group">
        <label>Description</label>
        <textarea class="form-input" id="editAdminDesc">${escHtml(t.description)}</textarea>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Category</label>
          <select class="form-input" id="editAdminCategory">
            ${['General','Development','Research','Design','Testing','Documentation','Meeting'].map(c =>
              `<option ${t.category === c ? 'selected' : ''}>${c}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Priority</label>
          <select class="form-input" id="editAdminPriority">
            ${['low','medium','high','critical'].map(p =>
              `<option value="${p}" ${t.priority === p ? 'selected' : ''}>${p}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Status</label>
          <select class="form-input" id="editAdminStatus" onchange="document.getElementById('scoreGroup').style.display = this.value === 'completed' ? '' : 'none'">
            ${['todo','in_progress','review','completed'].map(s =>
              `<option value="${s}" ${t.status === s ? 'selected' : ''}>${s.replace(/_/g,' ')}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Due Date</label>
          <input type="date" class="form-input" id="editAdminDue" value="${t.due_date || ''}">
        </div>
      </div>
      <div class="form-group" id="scoreGroup" style="display:${t.status === 'completed' ? '' : 'none'}">
        <label>Performance Score <span style="font-size:0.75rem; color:var(--text-muted);">(0–100, benchmark: 80%)</span></label>
        <input type="number" class="form-input" id="editAdminScore" min="0" max="100" value="${t.score != null ? t.score : 80}" placeholder="80">
        <div style="margin-top:0.5rem; font-size:0.75rem; color:var(--text-secondary);">
          Rate quality, speed, and overall performance. 80% = meets expectations.
        </div>
      </div>
    </form>
  `, `
    <button class="btn btn-danger btn-sm" onclick="deleteAdminTask(${t.id})">Delete</button>
    <div style="flex:1"></div>
    <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="document.getElementById('editAdminTaskForm').requestSubmit()">Save Changes</button>
  `);
}

async function submitAdminTaskEdit(e, taskId) {
  e.preventDefault();
  try {
    const taskStatus = document.getElementById('editAdminStatus').value;
    const body = {
      intern_id: parseInt(document.getElementById('editAdminIntern').value),
      title: document.getElementById('editAdminTitle').value,
      description: document.getElementById('editAdminDesc').value,
      category: document.getElementById('editAdminCategory').value,
      priority: document.getElementById('editAdminPriority').value,
      status: taskStatus,
      due_date: document.getElementById('editAdminDue').value || null,
    };
    if (taskStatus === 'completed') {
      const scoreVal = parseInt(document.getElementById('editAdminScore').value);
      body.score = isNaN(scoreVal) ? 80 : Math.min(100, Math.max(0, scoreVal));
    }
    await api(`/api/admin/tasks/${taskId}`, { method: 'PUT', body });
    closeModal(); toast('Task updated!'); navigateTo('tasks');
  } catch (err) { toast(err.message, 'error'); }
  return false;
}

async function deleteAdminTask(taskId) {
  if (!confirm('Delete this task?')) return;
  await api(`/api/admin/tasks/${taskId}`, { method: 'DELETE' });
  closeModal(); toast('Task deleted'); navigateTo('tasks');
}

// ── Filtering ───────────────────────────────────────────────────────────────
function filterInterns(q) {
  q = q.toLowerCase();
  document.querySelectorAll('.intern-card').forEach(el => {
    el.style.display = el.dataset.name.includes(q) ? '' : 'none';
  });
}

function filterReports(q) {
  q = q.toLowerCase();
  document.querySelectorAll('.report-card').forEach(el => {
    el.style.display = el.dataset.search.includes(q) ? '' : 'none';
  });
}

function filterTasks(q) {
  q = q.toLowerCase();
  // Filter desktop table
  document.querySelectorAll('#tasksTable tbody tr').forEach(el => {
    el.style.display = el.dataset.search && el.dataset.search.includes(q) ? '' : 'none';
  });
  // Filter mobile cards
  document.querySelectorAll('#tasksCards .task-list-card').forEach(el => {
    el.style.display = el.dataset.search && el.dataset.search.includes(q) ? '' : 'none';
  });
}

// ── Init ────────────────────────────────────────────────────────────────────
(async function init() {
  // Password reset links arrive as /?reset_token=... — handle before anything else.
  const resetToken = new URLSearchParams(window.location.search).get('reset_token');
  if (resetToken) { showResetScreen(resetToken); return; }
  try {
    const session = await api('/api/session');
    if (session.role === 'admin') {
      currentUser = { name: session.name };
      enterApp('admin');
      return;
    }
    if (session.role === 'intern') {
      currentUser = {
        id: session.id,
        name: session.name,
        department: session.department,
        avatarColor: session.avatarColor,
        status: session.status,
      };
      if (session.status === 'pending') {
        showPendingScreen();
        return;
      }
      if (session.status === 'active') {
        enterApp('intern');
        return;
      }
    }
  } catch (e) { /* ignore */ }
})();
