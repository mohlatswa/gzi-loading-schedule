/* GZI Loading Schedule — app.js */

const sb = window.supabase.createClient(
  window.GZI_CONFIG.supabaseUrl,
  window.GZI_CONFIG.supabaseAnonKey
);

const STATUS_LABELS = { planned: 'Planned', loaded: 'Loaded', dispatched: 'Dispatched', cancelled: 'Cancelled' };
const STATUS_BADGE = { planned: 'badge-amber', loaded: 'badge-green', dispatched: 'badge-blue', cancelled: 'badge-gray' };

const State = {
  session: null,
  customers: [],
  route: parseHash(),
  charts: {}
};

function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const parts = h.split('/').filter(Boolean);
  if (parts[0] === 'customer' && parts[1]) return { name: 'customer', id: parts[1] };
  if (parts[0] === 'customers') return { name: 'customers' };
  return { name: 'summary' };
}

/* ---------------- utils ---------------- */
function $(sel, root = document) { return root.querySelector(sel); }
function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d + 'T00:00:00');
  if (isNaN(dt)) return d;
  return dt.toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtDateShort(d) {
  if (!d) return '';
  const dt = new Date(d + 'T00:00:00');
  if (isNaN(dt)) return d;
  return dt.toLocaleDateString('en-ZA', { weekday: 'short', day: '2-digit', month: 'short' });
}
function fmtTime(t) { return t ? t.slice(0, 5) : ''; }
function todayISO() { return new Date().toISOString().slice(0, 10); }
function addDays(iso, n) { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
function startOfWeek(iso) { const d = new Date(iso + 'T00:00:00'); const day = (d.getDay() + 6) % 7; d.setDate(d.getDate() - day); return d.toISOString().slice(0, 10); }
function startOfMonth(iso) { return iso.slice(0, 7) + '-01'; }
function endOfMonth(iso) { const d = new Date(iso.slice(0, 7) + '-01T00:00:00'); d.setMonth(d.getMonth() + 1); d.setDate(0); return d.toISOString().slice(0, 10); }
function num(v) { return v === null || v === undefined || v === '' ? 0 : Number(v); }
function nOrDash(v) { return v === null || v === undefined || v === '' ? '—' : Number(v); }

function toast(msg, kind = '') {
  let wrap = $('.toast-wrap');
  if (!wrap) { wrap = document.createElement('div'); wrap.className = 'toast-wrap'; document.body.appendChild(wrap); }
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

function openModal(html) {
  closeModal();
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.id = 'modal-backdrop';
  backdrop.innerHTML = `<div class="modal">${html}</div>`;
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) closeModal(); });
  document.body.appendChild(backdrop);
}
function closeModal() { const b = $('#modal-backdrop'); if (b) b.remove(); }

/* ---------------- data layer ---------------- */
const DB = {
  async getCustomers() {
    const { data, error } = await sb.from('customers').select('*').order('sort_order');
    if (error) throw error;
    return data;
  },
  async createCustomer(payload) {
    const { error } = await sb.from('customers').insert(payload);
    if (error) throw error;
  },
  async updateCustomer(id, payload) {
    const { error } = await sb.from('customers').update(payload).eq('id', id);
    if (error) throw error;
  },
  async deleteCustomer(id) {
    const { error } = await sb.from('customers').delete().eq('id', id);
    if (error) throw error;
  },
  async getLoads({ customerId, dateFrom, dateTo } = {}) {
    let q = sb.from('loads').select('*, customers(name, code)').order('loading_date', { ascending: true });
    if (customerId) q = q.eq('customer_id', customerId);
    if (dateFrom) q = q.gte('loading_date', dateFrom);
    if (dateTo) q = q.lte('loading_date', dateTo);
    const { data, error } = await q;
    if (error) throw error;
    return data;
  },
  async createLoad(payload) {
    const { error } = await sb.from('loads').insert(payload);
    if (error) throw error;
  },
  async updateLoad(id, payload) {
    const { error } = await sb.from('loads').update(payload).eq('id', id);
    if (error) throw error;
  },
  async deleteLoad(id) {
    const { error } = await sb.from('loads').delete().eq('id', id);
    if (error) throw error;
  },
  async getAttachments(loadId) {
    const { data, error } = await sb.from('load_attachments').select('*').eq('load_id', loadId).order('uploaded_at');
    if (error) throw error;
    return data;
  },
  async uploadAttachment(loadId, file) {
    const path = `${loadId}/${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const { error: upErr } = await sb.storage.from('load-attachments').upload(path, file);
    if (upErr) throw upErr;
    const { error } = await sb.from('load_attachments').insert({
      load_id: loadId, file_name: file.name, storage_path: path, file_size: file.size, content_type: file.type
    });
    if (error) throw error;
  },
  async deleteAttachment(att) {
    await sb.storage.from('load-attachments').remove([att.storage_path]);
    const { error } = await sb.from('load_attachments').delete().eq('id', att.id);
    if (error) throw error;
  },
  async signedUrl(path) {
    const { data, error } = await sb.storage.from('load-attachments').createSignedUrl(path, 120);
    if (error) throw error;
    return data.signedUrl;
  }
};

/* ---------------- auth ---------------- */
async function initAuth() {
  const { data: { session } } = await sb.auth.getSession();
  State.session = session;
  sb.auth.onAuthStateChange((_event, session) => {
    State.session = session;
    boot();
  });
  boot();
}

function renderLogin(mode = 'login', error = '') {
  const app = $('#app');
  app.innerHTML = `
    <div class="login-screen">
      <div class="login-card">
        <div class="login-logo">
          <div class="gzi-mark">GZ<span>I</span></div>
          <div class="login-title">Loading Schedule</div>
        </div>
        <h2>${mode === 'login' ? 'Sign in' : 'Create account'}</h2>
        <p class="sub">${mode === 'login' ? 'Warehouse loading schedule system' : 'Register with your GZI work email'}</p>
        ${error ? `<div class="login-error">${esc(error)}</div>` : ''}
        <form id="auth-form">
          <div class="field"><label>Email</label><input type="email" id="auth-email" required autocomplete="email" /></div>
          <div class="field"><label>Password</label><input type="password" id="auth-password" required autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" minlength="6" /></div>
          <button type="submit" class="btn btn-primary btn-block" id="auth-submit">${mode === 'login' ? 'Sign in' : 'Sign up'}</button>
        </form>
        <div class="login-toggle">
          ${mode === 'login'
            ? `Need an account? <a href="#" id="to-signup">Sign up</a>`
            : `Already have an account? <a href="#" id="to-login">Sign in</a>`}
        </div>
      </div>
    </div>`;

  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#auth-email').value.trim();
    const password = $('#auth-password').value;
    const btn = $('#auth-submit');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    try {
      if (mode === 'login') {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else {
        const { error } = await sb.auth.signUp({ email, password });
        if (error) throw error;
        toast('Account created. If email confirmation is required, check your inbox, then sign in.', 'ok');
        renderLogin('login');
        return;
      }
    } catch (err) {
      renderLogin(mode, err.message);
    }
  });
  const toSignup = $('#to-signup'); if (toSignup) toSignup.addEventListener('click', (e) => { e.preventDefault(); renderLogin('signup'); });
  const toLogin = $('#to-login'); if (toLogin) toLogin.addEventListener('click', (e) => { e.preventDefault(); renderLogin('login'); });
}

async function handleLogout() {
  await sb.auth.signOut();
}

/* ---------------- shell / router ---------------- */
async function boot() {
  if (!State.session) { renderLogin('login'); return; }
  try {
    State.customers = await DB.getCustomers();
  } catch (err) {
    console.error(err);
  }
  renderShell();
  window.onhashchange = () => { State.route = parseHash(); renderContent(); };
  renderContent();
}

function renderShell() {
  const app = $('#app');
  const email = State.session?.user?.email || '';
  const initials = email.slice(0, 2).toUpperCase();
  app.innerHTML = `
    <div class="sidebar">
      <div class="sidebar-logo">
        <div class="gzi-mark">GZ<span>I</span></div>
        <div class="app-name">Loading Schedule</div>
      </div>
      <div class="nav-section">Overview</div>
      <div class="nav-link" data-nav="summary"><span class="dot"></span>Summary &amp; Reports</div>
      <div class="nav-section">Customers</div>
      <div class="nav-link" data-nav="customers"><span class="dot"></span>Manage Customers</div>
      <div class="nav-customers-list" id="nav-customer-list"></div>
    </div>
    <div class="main">
      <div class="topbar">
        <div>
          <h1 id="page-title">Summary</h1>
          <div class="crumb" id="page-crumb"></div>
        </div>
        <div class="topbar-right">
          <div class="user-chip"><div class="user-avatar">${esc(initials)}</div>${esc(email)}</div>
          <button class="btn btn-outline btn-sm" id="logout-btn">Log out</button>
        </div>
      </div>
      <div class="content" id="content"></div>
    </div>`;
  $('#logout-btn').addEventListener('click', handleLogout);
  $('[data-nav="summary"]').addEventListener('click', () => { location.hash = '#/summary'; });
  $('[data-nav="customers"]').addEventListener('click', () => { location.hash = '#/customers'; });
  renderNavCustomers();
}

function renderNavCustomers() {
  const list = $('#nav-customer-list');
  if (!list) return;
  list.innerHTML = State.customers.map(c => `
    <div class="nav-link" data-nav-customer="${c.id}" style="padding-left:24px; font-size:12.5px;">
      <span class="dot"></span>${esc(c.name)}
    </div>`).join('');
  list.querySelectorAll('[data-nav-customer]').forEach(el => {
    el.addEventListener('click', () => { location.hash = '#/customer/' + el.dataset.navCustomer; });
  });
  highlightNav();
}

function highlightNav() {
  document.querySelectorAll('.nav-link').forEach(el => el.classList.remove('active'));
  if (State.route.name === 'summary') { $('[data-nav="summary"]')?.classList.add('active'); }
  else if (State.route.name === 'customers') { $('[data-nav="customers"]')?.classList.add('active'); }
  else if (State.route.name === 'customer') { $(`[data-nav-customer="${State.route.id}"]`)?.classList.add('active'); }
}

function setTitle(title, crumb = '') {
  $('#page-title').textContent = title;
  $('#page-crumb').textContent = crumb;
}

async function renderContent() {
  highlightNav();
  const content = $('#content');
  content.innerHTML = '<div class="center-loading"><span class="spinner" style="border-color: rgba(22,35,63,.25); border-top-color: var(--navy);"></span>&nbsp; Loading…</div>';
  try {
    if (State.route.name === 'summary') await renderSummary(content);
    else if (State.route.name === 'customers') await renderCustomers(content);
    else if (State.route.name === 'customer') await renderCustomerPage(content, State.route.id);
  } catch (err) {
    console.error(err);
    content.innerHTML = `<div class="card">Error loading page: ${esc(err.message)}</div>`;
  }
}

/* ================= SUMMARY PAGE ================= */
let summaryState = { period: 'week', anchor: todayISO() };

function periodRange() {
  const a = summaryState.anchor;
  if (summaryState.period === 'day') return { from: a, to: a };
  if (summaryState.period === 'week') return { from: startOfWeek(a), to: addDays(startOfWeek(a), 6) };
  if (summaryState.period === 'month') return { from: startOfMonth(a), to: endOfMonth(a) };
  return { from: summaryState.customFrom || a, to: summaryState.customTo || a };
}

async function renderSummary(content) {
  setTitle('Summary & Reports', 'Schedule overview, planned vs actioned, and deviations');
  const { from, to } = periodRange();
  const loads = await DB.getLoads({ dateFrom: from, dateTo: to });

  const totalPlanned = loads.reduce((s, l) => s + num(l.planned_pallets), 0);
  const totalActual = loads.reduce((s, l) => s + num(l.actual_pallets), 0);
  const deviations = loads.filter(l => l.status === 'loaded' && num(l.actual_pallets) !== num(l.planned_pallets));
  const totalDeviation = deviations.reduce((s, l) => s + (num(l.planned_pallets) - num(l.actual_pallets)), 0);
  const loadedCount = loads.filter(l => l.status === 'loaded').length;

  content.innerHTML = `
    <div class="filter-bar">
      <div class="tab-group" id="period-tabs">
        <button data-p="day" class="${summaryState.period === 'day' ? 'active' : ''}">Day</button>
        <button data-p="week" class="${summaryState.period === 'week' ? 'active' : ''}">Week</button>
        <button data-p="month" class="${summaryState.period === 'month' ? 'active' : ''}">Month</button>
        <button data-p="custom" class="${summaryState.period === 'custom' ? 'active' : ''}">Custom</button>
      </div>
      ${summaryState.period === 'custom' ? `
        <div class="field"><label>From</label><input type="date" id="custom-from" value="${esc(summaryState.customFrom || from)}"/></div>
        <div class="field"><label>To</label><input type="date" id="custom-to" value="${esc(summaryState.customTo || to)}"/></div>
      ` : `
        <div class="field"><label>Jump to date</label><input type="date" id="anchor-date" value="${esc(summaryState.anchor)}"/></div>
      `}
      <div style="margin-left:auto; font-size:12.5px; color:var(--text-muted); align-self:center;">
        ${fmtDate(from)} – ${fmtDate(to)}
      </div>
    </div>

    <div class="grid grid-4" style="margin-bottom:20px;">
      <div class="stat-card"><div class="stat-label">Loads in period</div><div class="stat-value">${loads.length}</div><div class="stat-sub">${loadedCount} loaded</div></div>
      <div class="stat-card"><div class="stat-label">Planned pallets</div><div class="stat-value">${totalPlanned}</div></div>
      <div class="stat-card"><div class="stat-label">Actual pallets</div><div class="stat-value">${totalActual}</div></div>
      <div class="stat-card"><div class="stat-label">Deviation</div><div class="stat-value" style="color:${totalDeviation > 0 ? 'var(--red)' : 'var(--green)'}">${totalDeviation > 0 ? '-' : ''}${Math.abs(totalDeviation)}</div><div class="stat-sub">${deviations.length} loads with a variance</div></div>
    </div>

    <div class="grid grid-2" style="margin-bottom:20px;">
      <div class="card chart-card">
        <div class="section-title"><h2>Pallets loaded per customer</h2></div>
        <canvas id="chart-customer"></canvas>
      </div>
      <div class="card chart-card">
        <div class="section-title"><h2>Deviation by day</h2></div>
        <canvas id="chart-deviation"></canvas>
      </div>
    </div>

    <div class="section-title"><h2>Schedule (${fmtDate(from)} – ${fmtDate(to)})</h2></div>
    <div class="table-wrap" style="margin-bottom:24px;">
      <table>
        <thead><tr>
          <th>Date</th><th>Customer</th><th>Transporter</th><th>PO / DN</th><th>Design</th>
          <th class="num">Planned</th><th class="num">Actual</th><th>Status</th>
        </tr></thead>
        <tbody>
          ${loads.length ? loads.map(l => `
            <tr>
              <td>${esc(fmtDateShort(l.loading_date))}</td>
              <td>${esc(l.customers?.name || '')}</td>
              <td>${esc(l.transporter || '')}</td>
              <td class="small muted">${esc(l.gzi_dn || l.gzi_po_number || '')}</td>
              <td>${esc(l.design || '')}</td>
              <td class="num">${nOrDash(l.planned_pallets)}</td>
              <td class="num">${nOrDash(l.actual_pallets)}</td>
              <td><span class="badge ${STATUS_BADGE[l.status] || 'badge-gray'}">${STATUS_LABELS[l.status] || l.status}</span></td>
            </tr>`).join('') : `<tr><td colspan="8" class="empty-state">No loads scheduled in this period.</td></tr>`}
        </tbody>
        ${loads.length ? `<tfoot><tr><td colspan="5">Totals</td><td class="num">${totalPlanned}</td><td class="num">${totalActual}</td><td></td></tr></tfoot>` : ''}
      </table>
    </div>

    <div class="section-title"><h2>Planned vs Actioned</h2></div>
    <div class="table-wrap" style="margin-bottom:24px;">
      <table>
        <thead><tr><th>Date</th><th>Customer</th><th>PO / DN</th><th class="num">Planned</th><th class="num">Actioned</th><th class="num">Variance</th><th>Status</th></tr></thead>
        <tbody>
          ${loads.length ? loads.map(l => {
            const variance = num(l.planned_pallets) - num(l.actual_pallets);
            return `<tr>
              <td>${esc(fmtDateShort(l.loading_date))}</td>
              <td>${esc(l.customers?.name || '')}</td>
              <td class="small muted">${esc(l.gzi_dn || l.gzi_po_number || '')}</td>
              <td class="num">${nOrDash(l.planned_pallets)}</td>
              <td class="num">${nOrDash(l.actual_pallets)}</td>
              <td class="num" style="color:${variance > 0 ? 'var(--red)' : variance < 0 ? 'var(--blue)' : 'inherit'}">${l.status === 'planned' ? '—' : variance}</td>
              <td><span class="badge ${STATUS_BADGE[l.status] || 'badge-gray'}">${STATUS_LABELS[l.status] || l.status}</span></td>
            </tr>`;
          }).join('') : `<tr><td colspan="7" class="empty-state">No data.</td></tr>`}
        </tbody>
      </table>
    </div>

    <div class="section-title"><h2>Deviation report</h2></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Date</th><th>Customer</th><th>PO / DN</th><th class="num">Planned</th><th class="num">Actual</th><th class="num">Deviation</th><th>Reason</th></tr></thead>
        <tbody id="deviation-rows">
          ${deviations.length ? deviations.map(l => `
            <tr>
              <td>${esc(fmtDateShort(l.loading_date))}</td>
              <td>${esc(l.customers?.name || '')}</td>
              <td class="small muted">${esc(l.gzi_dn || l.gzi_po_number || '')}</td>
              <td class="num">${nOrDash(l.planned_pallets)}</td>
              <td class="num">${nOrDash(l.actual_pallets)}</td>
              <td class="num" style="color:var(--red)">${num(l.planned_pallets) - num(l.actual_pallets)}</td>
              <td>
                <input type="text" class="deviation-reason-input" data-load="${l.id}" value="${esc(l.deviation_reason || '')}" placeholder="Add reason…" style="width:220px; padding:5px 7px; border:1px solid var(--border); border-radius:6px;" />
              </td>
            </tr>`).join('') : `<tr><td colspan="7" class="empty-state">No deviations in this period 🎉</td></tr>`}
        </tbody>
        ${deviations.length ? `<tfoot><tr><td colspan="5">Total deviation</td><td class="num" style="color:var(--red)">${totalDeviation}</td><td></td></tr></tfoot>` : ''}
      </table>
    </div>
  `;

  $('#period-tabs').querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => { summaryState.period = btn.dataset.p; renderContent(); });
  });
  const anchorInput = $('#anchor-date');
  if (anchorInput) anchorInput.addEventListener('change', () => { summaryState.anchor = anchorInput.value; renderContent(); });
  const cf = $('#custom-from'), ct = $('#custom-to');
  if (cf) cf.addEventListener('change', () => { summaryState.customFrom = cf.value; renderContent(); });
  if (ct) ct.addEventListener('change', () => { summaryState.customTo = ct.value; renderContent(); });

  content.querySelectorAll('.deviation-reason-input').forEach(inp => {
    inp.addEventListener('change', async () => {
      try { await DB.updateLoad(inp.dataset.load, { deviation_reason: inp.value }); toast('Reason saved', 'ok'); }
      catch (err) { toast(err.message, 'err'); }
    });
  });

  renderCharts(loads, from, to);
}

function renderCharts(loads, from, to) {
  Object.values(State.charts).forEach(c => c && c.destroy());

  const byCustomer = {};
  loads.forEach(l => { const n = l.customers?.name || 'Unknown'; byCustomer[n] = (byCustomer[n] || 0) + num(l.actual_pallets); });
  const custEntries = Object.entries(byCustomer).sort((a, b) => b[1] - a[1]).slice(0, 10);

  const ctx1 = $('#chart-customer');
  State.charts.customer = new Chart(ctx1, {
    type: 'bar',
    data: {
      labels: custEntries.map(e => e[0]),
      datasets: [{ label: 'Actual pallets', data: custEntries.map(e => e[1]), backgroundColor: '#2563eb', borderRadius: 4 }]
    },
    options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { ticks: { autoSkip: false, maxRotation: 40, minRotation: 20 } } } }
  });

  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) { days.push(d); if (days.length > 60) break; }
  const devByDay = {};
  days.forEach(d => devByDay[d] = 0);
  loads.forEach(l => {
    if (l.status === 'loaded' && l.loading_date && devByDay[l.loading_date] !== undefined) {
      devByDay[l.loading_date] += (num(l.planned_pallets) - num(l.actual_pallets));
    }
  });
  const ctx2 = $('#chart-deviation');
  State.charts.deviation = new Chart(ctx2, {
    type: 'bar',
    data: {
      labels: days.map(d => fmtDateShort(d)),
      datasets: [{ label: 'Deviation (pallets)', data: days.map(d => devByDay[d]), backgroundColor: days.map(d => devByDay[d] > 0 ? '#dc2626' : '#16a34a'), borderRadius: 4 }]
    },
    options: { responsive: true, plugins: { legend: { display: false } } }
  });
}

/* ================= CUSTOMERS PAGE ================= */
async function renderCustomers(content) {
  setTitle('Customers', 'All customer loading schedules');
  const loads = await DB.getLoads({});
  const loadCounts = {};
  loads.forEach(l => { loadCounts[l.customer_id] = (loadCounts[l.customer_id] || 0) + 1; });

  content.innerHTML = `
    <div class="section-title">
      <h2>${State.customers.length} customers</h2>
      <div class="actions"><button class="btn btn-orange" id="add-customer-btn">+ Add Customer</button></div>
    </div>
    <div class="grid grid-3" id="customer-grid"></div>
  `;
  const grid = $('#customer-grid');
  grid.innerHTML = State.customers.map(c => `
    <div class="customer-card" data-open="${c.id}">
      <div class="cname">${esc(c.name)}</div>
      <div class="cmeta">${esc(c.despatching_plant || 'GZI')} ${c.contact_person ? '· ' + esc(c.contact_person) : ''}</div>
      <div class="cstats"><span><b>${loadCounts[c.id] || 0}</b> loads</span><span class="badge ${c.active ? 'badge-green' : 'badge-gray'}">${c.active ? 'Active' : 'Inactive'}</span></div>
      <div class="card-actions">
        <button class="btn btn-outline btn-sm" data-edit="${c.id}">Edit</button>
        <button class="btn btn-outline btn-sm" data-delete="${c.id}" style="color:var(--red); border-color:#f3caca;">Delete</button>
      </div>
    </div>
  `).join('') || `<div class="empty-state">No customers yet. Add your first one.</div>`;

  grid.querySelectorAll('[data-open]').forEach(el => el.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    location.hash = '#/customer/' + el.dataset.open;
  }));
  grid.querySelectorAll('[data-edit]').forEach(el => el.addEventListener('click', (e) => {
    e.stopPropagation();
    openCustomerModal(State.customers.find(c => c.id === el.dataset.edit));
  }));
  grid.querySelectorAll('[data-delete]').forEach(el => el.addEventListener('click', async (e) => {
    e.stopPropagation();
    const c = State.customers.find(c => c.id === el.dataset.delete);
    if (!confirm(`Delete "${c.name}"? This will also delete all of its loads and attachments.`)) return;
    try { await DB.deleteCustomer(c.id); toast('Customer deleted', 'ok'); State.customers = await DB.getCustomers(); renderNavCustomers(); renderContent(); }
    catch (err) { toast(err.message, 'err'); }
  }));
  $('#add-customer-btn').addEventListener('click', () => openCustomerModal(null));
}

function openCustomerModal(customer) {
  const isEdit = !!customer;
  openModal(`
    <div class="modal-header"><h3>${isEdit ? 'Edit customer' : 'Add customer'}</h3><button class="modal-close" id="modal-close">&times;</button></div>
    <div class="modal-body">
      <form id="customer-form">
        <div class="form-grid">
          <div class="field span-2"><label>Customer name *</label><input required id="f-name" value="${esc(customer?.name || '')}" /></div>
          <div class="field"><label>Code</label><input id="f-code" value="${esc(customer?.code || '')}" placeholder="e.g. heineken" /></div>
          <div class="field"><label>Despatching plant</label><input id="f-plant" value="${esc(customer?.despatching_plant || 'GZI')}" /></div>
          <div class="field"><label>Contact person</label><input id="f-contact" value="${esc(customer?.contact_person || '')}" /></div>
          <div class="field"><label>Contact phone</label><input id="f-phone" value="${esc(customer?.contact_phone || '')}" /></div>
          <div class="field span-2"><label>Contact email</label><input type="email" id="f-email" value="${esc(customer?.contact_email || '')}" /></div>
          <div class="field span-2"><label>Notes</label><textarea id="f-notes" rows="2">${esc(customer?.notes || '')}</textarea></div>
          <div class="field"><label>Status</label>
            <select id="f-active">
              <option value="true" ${customer?.active !== false ? 'selected' : ''}>Active</option>
              <option value="false" ${customer?.active === false ? 'selected' : ''}>Inactive</option>
            </select>
          </div>
        </div>
      </form>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" id="modal-cancel">Cancel</button>
      <button class="btn btn-primary" id="modal-save">${isEdit ? 'Save changes' : 'Add customer'}</button>
    </div>
  `);
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-cancel').addEventListener('click', closeModal);
  $('#modal-save').addEventListener('click', async () => {
    const payload = {
      name: $('#f-name').value.trim(),
      code: $('#f-code').value.trim() || null,
      despatching_plant: $('#f-plant').value.trim() || null,
      contact_person: $('#f-contact').value.trim() || null,
      contact_phone: $('#f-phone').value.trim() || null,
      contact_email: $('#f-email').value.trim() || null,
      notes: $('#f-notes').value.trim() || null,
      active: $('#f-active').value === 'true'
    };
    if (!payload.name) { toast('Customer name is required', 'err'); return; }
    try {
      if (isEdit) await DB.updateCustomer(customer.id, payload);
      else await DB.createCustomer({ ...payload, sort_order: State.customers.length });
      closeModal();
      toast(isEdit ? 'Customer updated' : 'Customer added', 'ok');
      State.customers = await DB.getCustomers();
      renderNavCustomers();
      renderContent();
    } catch (err) { toast(err.message, 'err'); }
  });
}

/* ================= CUSTOMER SCHEDULE PAGE ================= */
async function renderCustomerPage(content, customerId) {
  const customer = State.customers.find(c => c.id === customerId);
  if (!customer) { content.innerHTML = `<div class="card">Customer not found. <a href="#/customers">Back to customers</a></div>`; return; }
  setTitle(customer.name, `${customer.despatching_plant || 'GZI'} · Customer loading schedule`);

  const loads = await DB.getLoads({ customerId });
  const totalPlanned = loads.reduce((s, l) => s + num(l.planned_pallets), 0);
  const totalActual = loads.reduce((s, l) => s + num(l.actual_pallets), 0);

  content.innerHTML = `
    <div class="card" style="margin-bottom:18px;">
      <div class="section-title" style="margin-bottom:8px;">
        <h2>${esc(customer.name)}</h2>
        <div class="actions">
          <button class="btn btn-outline btn-sm" id="edit-customer-btn">Edit customer</button>
          <button class="btn btn-orange btn-sm" id="add-load-btn">+ New load</button>
        </div>
      </div>
      <div class="cmeta">
        ${customer.contact_person ? `Contact: ${esc(customer.contact_person)} ` : ''}
        ${customer.contact_phone ? `· ${esc(customer.contact_phone)} ` : ''}
        ${customer.contact_email ? `· ${esc(customer.contact_email)}` : ''}
        ${!customer.contact_person && !customer.contact_phone && !customer.contact_email ? 'No contact details on file.' : ''}
      </div>
    </div>

    <div class="grid grid-4" style="margin-bottom:18px;">
      <div class="stat-card"><div class="stat-label">Total loads</div><div class="stat-value">${loads.length}</div></div>
      <div class="stat-card"><div class="stat-label">Planned pallets</div><div class="stat-value">${totalPlanned}</div></div>
      <div class="stat-card"><div class="stat-label">Actual pallets</div><div class="stat-value">${totalActual}</div></div>
      <div class="stat-card"><div class="stat-label">Deviation</div><div class="stat-value">${totalPlanned - totalActual}</div></div>
    </div>

    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Loading date</th><th>Offloading date</th><th>Transporter</th><th>Reg / Fleet</th><th>PO / DN</th>
          <th>Design</th><th class="num">Planned</th><th class="num">Actual</th><th>Status</th><th>Docs</th><th></th>
        </tr></thead>
        <tbody id="load-rows">
          ${loads.length ? loads.map(rowHtml).join('') : `<tr><td colspan="11" class="empty-state">No loads yet for this customer. Click "New load" to add one.</td></tr>`}
        </tbody>
        ${loads.length ? `<tfoot><tr><td colspan="6">Totals</td><td class="num">${totalPlanned}</td><td class="num">${totalActual}</td><td colspan="3"></td></tr></tfoot>` : ''}
      </table>
    </div>
  `;

  function rowHtml(l) {
    return `<tr data-row="${l.id}">
      <td>${esc(fmtDateShort(l.loading_date))}</td>
      <td>${esc(fmtDateShort(l.offloading_date))}</td>
      <td>${esc(l.transporter || '')}</td>
      <td class="small">${esc(l.reg_number || l.fleet_details || '')}</td>
      <td class="small muted">${esc(l.gzi_dn || l.gzi_po_number || '')}</td>
      <td>${esc(l.design || '')}</td>
      <td class="num">${nOrDash(l.planned_pallets)}</td>
      <td class="num">${nOrDash(l.actual_pallets)}</td>
      <td><span class="badge ${STATUS_BADGE[l.status] || 'badge-gray'}">${STATUS_LABELS[l.status] || l.status}</span></td>
      <td><span class="link-btn" data-docs="${l.id}">Attachments</span></td>
      <td class="row-actions">
        <button class="btn btn-outline btn-sm" data-edit-load="${l.id}">Edit</button>
        <button class="btn btn-outline btn-sm" data-delete-load="${l.id}" style="color:var(--red); border-color:#f3caca;">Del</button>
      </td>
    </tr>`;
  }

  $('#edit-customer-btn').addEventListener('click', () => openCustomerModal(customer));
  $('#add-load-btn').addEventListener('click', () => openLoadModal(customer, null));
  content.querySelectorAll('[data-edit-load]').forEach(el => el.addEventListener('click', () => {
    openLoadModal(customer, loads.find(l => l.id === el.dataset.editLoad));
  }));
  content.querySelectorAll('[data-delete-load]').forEach(el => el.addEventListener('click', async () => {
    if (!confirm('Delete this load?')) return;
    try { await DB.deleteLoad(el.dataset.deleteLoad); toast('Load deleted', 'ok'); renderContent(); }
    catch (err) { toast(err.message, 'err'); }
  }));
  content.querySelectorAll('[data-docs]').forEach(el => el.addEventListener('click', () => openAttachmentsModal(el.dataset.docs)));
}

function openLoadModal(customer, load) {
  const isEdit = !!load;
  const v = (f, d = '') => esc(load?.[f] ?? d);
  openModal(`
    <div class="modal-header"><h3>${isEdit ? 'Edit load' : 'New load'} — ${esc(customer.name)}</h3><button class="modal-close" id="modal-close">&times;</button></div>
    <div class="modal-body">
      <form id="load-form">
        <div class="form-grid">
          <div class="field"><label>Loading date</label><input type="date" id="f-loading-date" value="${v('loading_date')}" /></div>
          <div class="field"><label>Offloading date</label><input type="date" id="f-offloading-date" value="${v('offloading_date')}" /></div>
          <div class="field"><label>Time slot</label><input id="f-time-slot" value="${v('time_slot')}" placeholder="e.g. 07:00-16:00" /></div>
          <div class="field"><label>Despatching plant</label><input id="f-plant" value="${v('despatching_plant', customer.despatching_plant || 'GZI')}" /></div>
          <div class="field"><label>Transporter</label><input id="f-transporter" value="${v('transporter')}" /></div>
          <div class="field"><label>Fleet / driver</label><input id="f-fleet" value="${v('fleet_details')}" /></div>
          <div class="field"><label>Reg number</label><input id="f-reg" value="${v('reg_number')}" /></div>
          <div class="field"><label>GZI PO number</label><input id="f-gzipo" value="${v('gzi_po_number')}" /></div>
          <div class="field"><label>Customer PO number</label><input id="f-custpo" value="${v('customer_po_number')}" /></div>
          <div class="field"><label>GZI DN</label><input id="f-dn" value="${v('gzi_dn')}" /></div>
          <div class="field"><label>Size (ml)</label><input id="f-size" value="${v('size_ml')}" /></div>
          <div class="field"><label>Design / Description</label><input id="f-design" value="${v('design')}" /></div>
          <div class="field"><label>Planned pallets</label><input type="number" step="0.01" id="f-planned" value="${v('planned_pallets')}" /></div>
          <div class="field"><label>Actual pallets</label><input type="number" step="0.01" id="f-actual" value="${v('actual_pallets')}" /></div>
          <div class="field"><label>Status</label>
            <select id="f-status">
              ${Object.entries(STATUS_LABELS).map(([k, lbl]) => `<option value="${k}" ${load?.status === k ? 'selected' : (!load && k === 'planned') ? 'selected' : ''}>${lbl}</option>`).join('')}
            </select>
          </div>
          <div class="field"><label>Arrival time</label><input type="time" id="f-arrival" value="${v('arrival_time')}" /></div>
          <div class="field"><label>Loading bay time</label><input type="time" id="f-bay" value="${v('loading_bay_time')}" /></div>
          <div class="field"><label>Depart time</label><input type="time" id="f-depart" value="${v('depart_time')}" /></div>
          <div class="field span-2"><label>Comments</label><textarea id="f-comments" rows="2">${v('comments')}</textarea></div>
          <div class="field span-2"><label>Deviation reason <span class="muted">(if planned ≠ actual)</span></label><input id="f-deviation" value="${v('deviation_reason')}" /></div>
        </div>
      </form>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" id="modal-cancel">Cancel</button>
      <button class="btn btn-primary" id="modal-save">${isEdit ? 'Save changes' : 'Add load'}</button>
    </div>
  `);
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-cancel').addEventListener('click', closeModal);
  $('#modal-save').addEventListener('click', async () => {
    const g = (id) => { const x = $(id).value; return x === '' ? null : x; };
    const payload = {
      customer_id: customer.id,
      loading_date: g('#f-loading-date'),
      offloading_date: g('#f-offloading-date'),
      time_slot: g('#f-time-slot'),
      despatching_plant: g('#f-plant'),
      transporter: g('#f-transporter'),
      fleet_details: g('#f-fleet'),
      reg_number: g('#f-reg'),
      gzi_po_number: g('#f-gzipo'),
      customer_po_number: g('#f-custpo'),
      gzi_dn: g('#f-dn'),
      size_ml: g('#f-size'),
      design: g('#f-design'),
      planned_pallets: g('#f-planned'),
      actual_pallets: g('#f-actual'),
      status: $('#f-status').value,
      arrival_time: g('#f-arrival'),
      loading_bay_time: g('#f-bay'),
      depart_time: g('#f-depart'),
      comments: g('#f-comments'),
      deviation_reason: g('#f-deviation')
    };
    try {
      if (isEdit) await DB.updateLoad(load.id, payload);
      else await DB.createLoad(payload);
      closeModal();
      toast(isEdit ? 'Load updated' : 'Load added', 'ok');
      renderContent();
    } catch (err) { toast(err.message, 'err'); }
  });
}

async function openAttachmentsModal(loadId) {
  openModal(`
    <div class="modal-header"><h3>Supporting documents</h3><button class="modal-close" id="modal-close">&times;</button></div>
    <div class="modal-body">
      <div id="att-list">Loading…</div>
      <div style="margin-top:14px;">
        <input type="file" id="att-file" />
        <button class="btn btn-orange btn-sm" id="att-upload" style="margin-left:8px;">Upload</button>
      </div>
    </div>
    <div class="modal-footer"><button class="btn btn-outline" id="modal-cancel">Close</button></div>
  `);
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-cancel').addEventListener('click', closeModal);

  async function refresh() {
    const atts = await DB.getAttachments(loadId);
    const list = $('#att-list');
    if (!list) return;
    list.innerHTML = atts.length ? atts.map(a => `
      <div class="attachment-chip">
        <span class="link-btn" data-view="${a.id}">${esc(a.file_name)}</span>
        <button data-del="${a.id}" title="Remove">&times;</button>
      </div>`).join('') : `<div class="muted small">No documents attached yet.</div>`;
    list.querySelectorAll('[data-view]').forEach(el => el.addEventListener('click', async () => {
      const att = atts.find(a => a.id === el.dataset.view);
      try { const url = await DB.signedUrl(att.storage_path); window.open(url, '_blank'); }
      catch (err) { toast(err.message, 'err'); }
    }));
    list.querySelectorAll('[data-del]').forEach(el => el.addEventListener('click', async () => {
      const att = atts.find(a => a.id === el.dataset.del);
      if (!confirm(`Remove "${att.file_name}"?`)) return;
      try { await DB.deleteAttachment(att); refresh(); } catch (err) { toast(err.message, 'err'); }
    }));
  }
  refresh();

  $('#att-upload').addEventListener('click', async () => {
    const fileInput = $('#att-file');
    const file = fileInput.files[0];
    if (!file) { toast('Choose a file first', 'err'); return; }
    const btn = $('#att-upload');
    btn.disabled = true; btn.textContent = 'Uploading…';
    try {
      await DB.uploadAttachment(loadId, file);
      fileInput.value = '';
      toast('Document attached', 'ok');
      refresh();
    } catch (err) { toast(err.message, 'err'); }
    finally { btn.disabled = false; btn.textContent = 'Upload'; }
  });
}

/* ---------------- start ---------------- */
initAuth();
