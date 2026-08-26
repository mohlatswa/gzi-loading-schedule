/* GZI Loading Schedule — app.js */

const sb = window.supabase.createClient(
  window.GZI_CONFIG.supabaseUrl,
  window.GZI_CONFIG.supabaseAnonKey
);

if (window.ChartDataLabels) {
  Chart.register(window.ChartDataLabels);
  Chart.defaults.set('plugins.datalabels', {
    display: (ctx) => ctx.dataset.data.length <= 20,
    anchor: 'end', align: 'top', font: { size: 10, weight: '600' }, color: '#374151',
    formatter: (v) => (v === 0 ? '' : v)
  });
}

const RPM_RATIO = { frames: 1, layercards: 15 };
const SET_LAYERCARDS = 15;

const STATUS_LABELS = { planned: 'Planned', loaded: 'Loaded', dispatched: 'Dispatched', cancelled: 'Cancelled' };
const STATUS_BADGE = { planned: 'badge-amber', loaded: 'badge-green', dispatched: 'badge-blue', cancelled: 'badge-gray' };
const ROLE_LABELS = { manager: 'Manager', supervisor: 'Supervisor', warehouse_admin: 'Warehouse Admin' };
function roleLabel(r) { return ROLE_LABELS[r] || r; }

const State = {
  session: null,
  customers: [],
  warehouses: [],
  supervisors: [],
  myRole: null,
  route: parseHash(),
  charts: {}
};
function canAuthoriseDeletions() { return State.myRole === 'manager' || State.myRole === 'supervisor'; }
function isManager() { return State.myRole === 'manager'; }

function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const parts = h.split('/').filter(Boolean);
  if (parts[0] === 'customer' && parts[1]) return { name: 'customer', id: parts[1] };
  if (parts[0] === 'warehouse' && parts[1]) return { name: 'warehouse', id: parts[1] };
  const known = ['dashboard', 'summary', 'customers', 'warehouses', 'supervisors', 'deleted-loads', 'users',
    'report-overall', 'report-supervisor', 'report-warehouse', 'report-rpm', 'report-stock', 'report-missing',
    'report-loaded-totals', 'report-deviation'];
  if (known.includes(parts[0])) return { name: parts[0] };
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
function fmtDateTime(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt)) return d;
  return dt.toLocaleString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtTime(t) { return t ? t.slice(0, 5) : ''; }
function todayISO() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function addDays(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function startOfWeek(iso) { const d = new Date(iso + 'T00:00:00Z'); const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day); return d.toISOString().slice(0, 10); }
function startOfMonth(iso) { return iso.slice(0, 7) + '-01'; }
function endOfMonth(iso) { const d = new Date(iso.slice(0, 7) + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return d.toISOString().slice(0, 10); }
function num(v) { return v === null || v === undefined || v === '' ? 0 : Number(v); }
function nOrDash(v) { return v === null || v === undefined || v === '' ? '—' : Number(v); }
function fmtCans(v) { return (v === null || v === undefined || v === '') ? '—' : Number(v).toFixed(2) + 'M'; }

function isoWeek(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  const target = new Date(d.valueOf());
  const dayNr = (d.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNr + 3);
  const firstThursday = target.valueOf();
  target.setMonth(0, 1);
  if (target.getDay() !== 4) target.setMonth(0, 1 + ((4 - target.getDay()) + 7) % 7);
  const week = 1 + Math.round((firstThursday - target) / 604800000);
  return { week, year: d.getFullYear() };
}
function fmtWeek(dateStr) { const w = isoWeek(dateStr); return w ? `W${w.week}` : ''; }

function computeTAT(arrival, depart) {
  if (!arrival || !depart) return null;
  const [ah, am] = arrival.split(':').map(Number);
  const [dh, dm] = depart.split(':').map(Number);
  let mins = (dh * 60 + dm) - (ah * 60 + am);
  if (mins < 0) mins += 24 * 60;
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

async function copyText(str) {
  try { await navigator.clipboard.writeText(str); toast('Copied to clipboard', 'ok'); }
  catch (err) { toast('Copy failed: ' + err.message, 'err'); }
}

function currentUserStamp() {
  const u = State.session?.user;
  return { by: u?.id || null, email: u?.email || null };
}

async function logLoadAudit(loadId, action, payload) {
  const stamp = currentUserStamp();
  try {
    await sb.from('load_audit_log').insert({ load_id: loadId, action, changed_by: stamp.by, changed_by_email: stamp.email, snapshot: payload });
  } catch (err) { console.error('audit log failed', err); }
}

async function syncSohForLoad(load) {
  try {
    await sb.from('soh_movements').delete().eq('load_id', load.id).eq('movement_type', 'dispatch');
    const isDispatched = load.status === 'loaded' || load.status === 'dispatched';
    const hasQty = num(load.actual_pallets) > 0 || num(load.actual_cans_m) > 0;
    if (isDispatched && hasQty) {
      const stamp = currentUserStamp();
      await sb.from('soh_movements').insert({
        movement_type: 'dispatch',
        quantity_pallets: load.actual_pallets || null,
        quantity_cans_m: load.actual_cans_m || null,
        movement_date: load.loading_date || todayISO(),
        description: 'Auto: load dispatched',
        load_id: load.id,
        created_by: stamp.by,
        created_by_email: stamp.email
      });
    }
  } catch (err) { console.error('SOH sync failed', err); }
}

async function syncRpmForLoad(load) {
  try {
    await sb.from('rpm_movements').delete().eq('load_id', load.id);
    const isDispatched = load.status === 'loaded' || load.status === 'dispatched';
    const pallets = num(load.actual_pallets);
    if (isDispatched && pallets > 0) {
      const stamp = currentUserStamp();
      await sb.from('rpm_movements').insert({
        entity_type: load.destination_type,
        entity_id: load.destination_type === 'warehouse' ? load.warehouse_id : load.customer_id,
        direction: 'sent',
        quantity_pallets: pallets,
        quantity_frames: pallets * RPM_RATIO.frames,
        quantity_layercards: pallets * RPM_RATIO.layercards,
        market: load.market || null,
        movement_date: load.loading_date || todayISO(),
        load_id: load.id,
        comments: 'Auto: from load',
        created_by: stamp.by,
        created_by_email: stamp.email
      });
    }
  } catch (err) { console.error('RPM sync failed', err); }
}

async function copyCanvasImage(canvasEl) {
  try {
    const blob = await new Promise((resolve, reject) => canvasEl.toBlob(b => b ? resolve(b) : reject(new Error('Could not render image')), 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('Chart image copied to clipboard', 'ok');
  } catch (err) { toast('Copy image failed: ' + err.message, 'err'); }
}

function computeInternalStockBalances(stock, market) {
  const items = ['pallet', 'frame', 'layercard'];
  const result = {};
  items.forEach(item => {
    const rows = stock.filter(s => s.item_type === item && (!market || s.market === market));
    const received = rows.filter(r => r.movement_type === 'receive_unsorted').reduce((s, r) => s + num(r.quantity), 0);
    const sorted = rows.filter(r => r.movement_type === 'mark_sorted').reduce((s, r) => s + num(r.quantity), 0);
    const issued = rows.filter(r => r.movement_type === 'issue_ready').reduce((s, r) => s + num(r.quantity), 0);
    result[item] = { toSort: received - sorted, ready: sorted - issued };
  });
  return result;
}

async function computeRpmDaysCover(market) {
  const to = todayISO();
  const from = addDays(to, -30);
  const [loads, stock] = await Promise.all([DB.getLoads({ dateFrom: from, dateTo: to }), DB.getRpmInternalStock()]);
  const relevant = loads.filter(l => (l.status === 'loaded' || l.status === 'dispatched') && (!market || l.market === market));
  const avgDaily = relevant.reduce((s, l) => s + num(l.actual_pallets), 0) / 30;
  const balances = computeInternalStockBalances(stock, market);
  const dPallets = avgDaily > 0 ? balances.pallet.ready / avgDaily : null;
  const dFrames = avgDaily > 0 ? balances.frame.ready / avgDaily : null;
  const dCards = avgDaily > 0 ? balances.layercard.ready / (avgDaily * SET_LAYERCARDS) : null;
  const values = [dPallets, dFrames, dCards].filter(v => v !== null);
  return { avgDaily, balances, dPallets, dFrames, dCards, overall: values.length ? Math.min(...values) : null };
}
function fmtDays(v) { return v === null || v === undefined ? '—' : `${v.toFixed(1)}d`; }

function supervisorName(id) { return State.supervisors.find(s => s.id === id)?.name || ''; }
function supervisorCell(rec) {
  const name = esc(supervisorName(rec.supervisor_id));
  if (!rec.supervisor_note) return name;
  return `${name} <span class="badge badge-amber" title="${esc(rec.supervisor_note)}">note</span>`;
}
function warehouseName(id) { return State.warehouses.find(w => w.id === id)?.name || ''; }
function destLabel(l) {
  if (l.destination_type === 'warehouse') return `🏭 ${esc(warehouseName(l.warehouse_id))}`;
  return esc(l.customers?.name || '');
}

/* -------- generic period filter (used by Summary + all report pages) -------- */
function makePeriodState(defaultPeriod = 'month') { return { period: defaultPeriod, anchor: todayISO() }; }
function periodRangeFor(state) {
  const a = state.anchor;
  if (state.period === 'day') return { from: a, to: a };
  if (state.period === 'week') return { from: startOfWeek(a), to: addDays(startOfWeek(a), 6) };
  if (state.period === 'month') return { from: startOfMonth(a), to: endOfMonth(a) };
  return { from: state.customFrom || a, to: state.customTo || a };
}
function periodFilterHtml(state, idPrefix) {
  const { from, to } = periodRangeFor(state);
  return `<div class="filter-bar">
    <div class="tab-group" id="${idPrefix}-tabs">
      <button type="button" data-p="day" class="${state.period === 'day' ? 'active' : ''}">Day</button>
      <button type="button" data-p="week" class="${state.period === 'week' ? 'active' : ''}">Week</button>
      <button type="button" data-p="month" class="${state.period === 'month' ? 'active' : ''}">Month</button>
      <button type="button" data-p="custom" class="${state.period === 'custom' ? 'active' : ''}">Custom</button>
    </div>
    ${state.period === 'custom' ? `
      <div class="field"><label>From</label><input type="date" id="${idPrefix}-from" value="${esc(state.customFrom || from)}"/></div>
      <div class="field"><label>To</label><input type="date" id="${idPrefix}-to" value="${esc(state.customTo || to)}"/></div>
    ` : `<div class="field"><label>Jump to date</label><input type="date" id="${idPrefix}-anchor" value="${esc(state.anchor)}"/></div>`}
    <div style="margin-left:auto; font-size:12.5px; color:var(--text-muted); align-self:center;">${fmtDate(from)} – ${fmtDate(to)}</div>
  </div>`;
}
function bindPeriodFilter(state, idPrefix, rerender) {
  $(`#${idPrefix}-tabs`).querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => { state.period = btn.dataset.p; rerender(); });
  });
  const a = $(`#${idPrefix}-anchor`); if (a) a.addEventListener('change', () => { state.anchor = a.value; rerender(); });
  const cf = $(`#${idPrefix}-from`), ct = $(`#${idPrefix}-to`);
  if (cf) cf.addEventListener('change', () => { state.customFrom = cf.value; rerender(); });
  if (ct) ct.addEventListener('change', () => { state.customTo = ct.value; rerender(); });
}

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
  async getLoads({ customerId, warehouseId, destinationType, dateFrom, dateTo, includeDeleted = false } = {}) {
    let q = sb.from('loads').select('*, customers(name, code)').order('loading_date', { ascending: true });
    if (!includeDeleted) q = q.is('deleted_at', null);
    if (customerId) q = q.eq('customer_id', customerId);
    if (warehouseId) q = q.eq('warehouse_id', warehouseId);
    if (destinationType) q = q.eq('destination_type', destinationType);
    if (dateFrom) q = q.gte('loading_date', dateFrom);
    if (dateTo) q = q.lte('loading_date', dateTo);
    const { data, error } = await q;
    if (error) throw error;
    return data;
  },
  async getDeletedLoads() {
    const { data, error } = await sb.from('loads').select('*, customers(name, code)').not('deleted_at', 'is', null).order('deleted_at', { ascending: false });
    if (error) throw error;
    return data;
  },
  async restoreLoad(id) {
    const { error } = await sb.from('loads').update({ deleted_at: null, deleted_by: null, deleted_by_email: null }).eq('id', id);
    if (error) throw error;
  },
  async createLoad(payload) {
    const { data, error } = await sb.from('loads').insert(payload).select().single();
    if (error) throw error;
    return data;
  },
  async updateLoad(id, payload) {
    const { data, error } = await sb.from('loads').update(payload).eq('id', id).select().single();
    if (error) throw error;
    return data;
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
  async getAllAttachmentLoadIds() {
    const { data, error } = await sb.from('load_attachments').select('load_id');
    if (error) throw error;
    return new Set(data.map(r => r.load_id));
  },
  async getAttachmentsByCustomer(customerId) {
    const { data, error } = await sb.from('load_attachments')
      .select('*, loads!inner(loading_date, gzi_dn, gzi_po_number, customer_id)')
      .eq('loads.customer_id', customerId)
      .order('uploaded_at', { ascending: false });
    if (error) throw error;
    return data;
  },
  async uploadAttachment(loadId, file) {
    const path = `${loadId}/${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const { error: upErr } = await sb.storage.from('load-attachments').upload(path, file);
    if (upErr) throw upErr;
    const stamp = currentUserStamp();
    const { error } = await sb.from('load_attachments').insert({
      load_id: loadId, file_name: file.name, storage_path: path, file_size: file.size, content_type: file.type,
      uploaded_by: stamp.by, uploaded_by_email: stamp.email
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
  },

  /* ---- warehouses ---- */
  async getWarehouses() {
    const { data, error } = await sb.from('warehouses').select('*').order('sort_order');
    if (error) throw error;
    return data;
  },
  async createWarehouse(payload) { const { error } = await sb.from('warehouses').insert(payload); if (error) throw error; },
  async updateWarehouse(id, payload) { const { error } = await sb.from('warehouses').update(payload).eq('id', id); if (error) throw error; },
  async deleteWarehouse(id) { const { error } = await sb.from('warehouses').delete().eq('id', id); if (error) throw error; },

  /* ---- supervisors ---- */
  async getSupervisors() {
    const { data, error } = await sb.from('supervisors').select('*').order('sort_order');
    if (error) throw error;
    return data;
  },
  async createSupervisor(payload) { const { error } = await sb.from('supervisors').insert(payload); if (error) throw error; },
  async updateSupervisor(id, payload) { const { error } = await sb.from('supervisors').update(payload).eq('id', id); if (error) throw error; },
  async deleteSupervisor(id) { const { error } = await sb.from('supervisors').delete().eq('id', id); if (error) throw error; },

  /* ---- warehouse dispatches (warehouse -> customer) ---- */
  async getWarehouseDispatches({ warehouseId, dateFrom, dateTo } = {}) {
    let q = sb.from('warehouse_dispatches').select('*, warehouses(name), customers(name)').order('dispatch_date', { ascending: true });
    if (warehouseId) q = q.eq('warehouse_id', warehouseId);
    if (dateFrom) q = q.gte('dispatch_date', dateFrom);
    if (dateTo) q = q.lte('dispatch_date', dateTo);
    const { data, error } = await q;
    if (error) throw error;
    return data;
  },
  async createWarehouseDispatch(payload) {
    const { data, error } = await sb.from('warehouse_dispatches').insert(payload).select().single();
    if (error) throw error;
    return data;
  },
  async updateWarehouseDispatch(id, payload) {
    const { data, error } = await sb.from('warehouse_dispatches').update(payload).eq('id', id).select().single();
    if (error) throw error;
    return data;
  },
  async deleteWarehouseDispatch(id) { const { error } = await sb.from('warehouse_dispatches').delete().eq('id', id); if (error) throw error; },

  /* ---- RPM ---- */
  async getRpmMovements() {
    const { data, error } = await sb.from('rpm_movements').select('*').order('movement_date', { ascending: false });
    if (error) throw error;
    return data;
  },
  async createRpmMovement(payload) { const { error } = await sb.from('rpm_movements').insert(payload); if (error) throw error; },

  /* ---- Stock on hand ---- */
  async getSohMovements() {
    const { data, error } = await sb.from('soh_movements').select('*').order('movement_date', { ascending: true });
    if (error) throw error;
    return data;
  },
  async createSohMovement(payload) { const { error } = await sb.from('soh_movements').insert(payload); if (error) throw error; },

  /* ---- Audit ---- */
  async getLoadAuditLog(loadId) {
    const { data, error } = await sb.from('load_audit_log').select('*').eq('load_id', loadId).order('changed_at', { ascending: false });
    if (error) throw error;
    return data;
  },

  /* ---- User roles ---- */
  async getMyProfile() {
    const uid = State.session?.user?.id;
    if (!uid) return null;
    const { data, error } = await sb.from('profiles').select('*').eq('id', uid).maybeSingle();
    if (error) throw error;
    return data;
  },
  async getProfiles() {
    const { data, error } = await sb.from('profiles').select('*').order('email');
    if (error) throw error;
    return data;
  },
  async updateProfileRole(id, role) { const { error } = await sb.from('profiles').update({ role }).eq('id', id); if (error) throw error; },

  /* ---- Load deletion requests ---- */
  async createDeletionRequest(payload) { const { error } = await sb.from('load_deletion_requests').insert(payload); if (error) throw error; },
  async getDeletionRequests({ status } = {}) {
    let q = sb.from('load_deletion_requests').select('*, loads(loading_date, gzi_dn, gzi_po_number, customer_id, customers(name))').order('requested_at', { ascending: false });
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw error;
    return data;
  },
  async decideDeletionRequest(id, { status, decisionNote, loadId }) {
    const stamp = currentUserStamp();
    const { error } = await sb.from('load_deletion_requests').update({
      status, decision_note: decisionNote || null, decided_by: stamp.by, decided_by_email: stamp.email, decided_at: new Date().toISOString()
    }).eq('id', id);
    if (error) throw error;
    if (status === 'approved') {
      const { error: delErr } = await sb.from('loads').update({ deleted_at: new Date().toISOString(), deleted_by: stamp.by, deleted_by_email: stamp.email }).eq('id', loadId);
      if (delErr) throw delErr;
    }
  },

  /* ---- RPM internal ("In Warehouse") stock ---- */
  async getRpmInternalStock() {
    const { data, error } = await sb.from('rpm_internal_stock').select('*').order('movement_date', { ascending: false });
    if (error) throw error;
    return data;
  },
  async createRpmInternalStock(payload) { const { error } = await sb.from('rpm_internal_stock').insert(payload); if (error) throw error; },

  /* ---- SOH per-design stock counts ---- */
  async getSohDesignRecords() {
    const { data, error } = await sb.from('soh_design_records').select('*').order('production_date', { ascending: false });
    if (error) throw error;
    return data;
  },
  async createSohDesignRecord(payload) { const { error } = await sb.from('soh_design_records').insert(payload); if (error) throw error; },
  async resolveSohDesignRecord(id, { resolvedAt, resolutionNotes }) {
    const { error } = await sb.from('soh_design_records').update({ resolved_at: resolvedAt, resolution_notes: resolutionNotes || null }).eq('id', id);
    if (error) throw error;
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
          <img class="logo-img" src="assets/logo.webp" alt="GZI" />
          <div class="login-title">Loading Schedule</div>
        </div>
        <h2>${mode === 'login' ? 'Sign in' : 'Create account'}</h2>
        <p class="sub">${mode === 'login' ? 'Warehouse loading schedule system' : 'Register with your GZI work email'}</p>
        ${error ? `<div class="login-error">${esc(error)}</div>` : ''}
        <button type="button" class="btn btn-outline btn-block ms-signin-btn" id="ms-signin-btn">
          <svg width="16" height="16" viewBox="0 0 21 21" style="flex:none;"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg>
          Sign in with Microsoft
        </button>
        <div class="or-divider"><span>or</span></div>
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

  $('#ms-signin-btn').addEventListener('click', async () => {
    const btn = $('#ms-signin-btn');
    btn.disabled = true;
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'azure',
      options: { scopes: 'email openid profile', redirectTo: window.location.origin + window.location.pathname }
    });
    if (error) { btn.disabled = false; renderLogin(mode, error.message); }
  });

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
        const { data, error } = await sb.auth.signUp({ email, password });
        if (error) throw error;
        if (data.user) {
          try { await sb.from('profiles').insert({ id: data.user.id, email: data.user.email, role: 'warehouse_admin' }); }
          catch (profileErr) { console.error('profile creation failed', profileErr); }
        }
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
async function fetchWithRetry(fn, retries = 2, delayMs = 700) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (err) {
      if (attempt >= retries) throw err;
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

let bootInFlight = null;
async function boot() {
  if (!State.session) { renderLogin('login'); return; }
  if (bootInFlight) await bootInFlight;
  bootInFlight = bootOnce();
  await bootInFlight;
  bootInFlight = null;
}
async function bootOnce() {
  const results = await Promise.allSettled([
    fetchWithRetry(() => DB.getCustomers()),
    fetchWithRetry(() => DB.getWarehouses()),
    fetchWithRetry(() => DB.getSupervisors()),
    fetchWithRetry(() => DB.getMyProfile())
  ]);
  const [customers, warehouses, supervisors, myProfile] = results;
  if (customers.status === 'fulfilled') State.customers = customers.value; else console.error(customers.reason);
  if (warehouses.status === 'fulfilled') State.warehouses = warehouses.value; else console.error(warehouses.reason);
  if (supervisors.status === 'fulfilled') State.supervisors = supervisors.value; else console.error(supervisors.reason);
  if (myProfile.status === 'fulfilled') State.myRole = myProfile.value?.role || null; else console.error(myProfile.reason);
  if (!State.myRole && State.session?.user) {
    try {
      await sb.from('profiles').insert({ id: State.session.user.id, email: State.session.user.email, role: 'warehouse_admin' });
      State.myRole = 'warehouse_admin';
    } catch (err) { console.error('auto profile creation failed', err); }
  }
  renderShell();
  window.onhashchange = () => { State.route = parseHash(); renderContent(); };
  await renderContent();
}

function renderShell() {
  const app = $('#app');
  const email = State.session?.user?.email || '';
  const initials = email.slice(0, 2).toUpperCase();
  app.innerHTML = `
    <div class="sidebar">
      <div class="sidebar-logo">
        <img class="logo-img" src="assets/logo.webp" alt="GZI" />
        <div class="app-name">Loading Schedule</div>
      </div>
      <div class="nav-section">Overview</div>
      <div class="nav-link" data-nav="dashboard"><span class="dot"></span>Dashboard</div>
      <div class="nav-link" data-nav="summary"><span class="dot"></span>Schedule</div>
      <div class="nav-section">Reports</div>
      <div class="nav-link" data-nav="report-overall"><span class="dot"></span>Overall report</div>
      <div class="nav-link" data-nav="report-deviation"><span class="dot"></span>Loads deviation</div>
      <div class="nav-link" data-nav="report-loaded-totals"><span class="dot"></span>Loaded totals</div>
      <div class="nav-link" data-nav="report-supervisor"><span class="dot"></span>Planned vs Supervisor</div>
      <div class="nav-link" data-nav="report-warehouse"><span class="dot"></span>Warehouse report</div>
      <div class="nav-link" data-nav="report-rpm"><span class="dot"></span>RPM report</div>
      <div class="nav-link" data-nav="report-stock"><span class="dot"></span>Stock (SOH)</div>
      <div class="nav-link" data-nav="report-missing"><span class="dot"></span>Missing attachments</div>
      <div class="nav-section">Manage</div>
      <div class="nav-link" data-nav="customers"><span class="dot"></span>Customers</div>
      <div class="nav-customers-list" id="nav-customer-list"></div>
      <div class="nav-link" data-nav="warehouses"><span class="dot"></span>Warehouses</div>
      <div class="nav-link" data-nav="supervisors"><span class="dot"></span>Supervisors</div>
      <div class="nav-link" data-nav="deleted-loads"><span class="dot"></span>Deleted loads</div>
      <div class="nav-link" data-nav="users"><span class="dot"></span>Users &amp; roles</div>
    </div>
    <div class="main">
      <div class="topbar">
        <div>
          <h1 id="page-title">Summary</h1>
          <div class="crumb" id="page-crumb"></div>
        </div>
        <div class="topbar-right">
          <div class="user-chip"><div class="user-avatar">${esc(initials)}</div>${esc(email)} ${State.myRole ? `<span class="badge badge-blue">${esc(roleLabel(State.myRole))}</span>` : ''}</div>
          <button class="btn btn-outline btn-sm" id="logout-btn">Log out</button>
        </div>
      </div>
      <div class="content" id="content"></div>
    </div>`;
  $('#logout-btn').addEventListener('click', handleLogout);
  document.querySelectorAll('[data-nav]').forEach(el => {
    el.addEventListener('click', () => { location.hash = '#/' + el.dataset.nav; });
  });
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
  const r = State.route.name;
  if (r === 'customer') { $(`[data-nav-customer="${State.route.id}"]`)?.classList.add('active'); return; }
  const key = r === 'warehouse' ? 'warehouses' : r;
  $(`[data-nav="${key}"]`)?.classList.add('active');
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
    if (State.route.name === 'dashboard') await renderDashboard(content);
    else if (State.route.name === 'summary') await renderSummary(content);
    else if (State.route.name === 'customers') await renderCustomers(content);
    else if (State.route.name === 'customer') await renderCustomerPage(content, State.route.id);
    else if (State.route.name === 'warehouses') await renderWarehouses(content);
    else if (State.route.name === 'warehouse') await renderWarehousePage(content, State.route.id);
    else if (State.route.name === 'supervisors') await renderSupervisors(content);
    else if (State.route.name === 'deleted-loads') await renderDeletedLoads(content);
    else if (State.route.name === 'users') await renderUsers(content);
    else if (State.route.name === 'report-overall') await renderOverallReport(content);
    else if (State.route.name === 'report-deviation') await renderDeviationReport(content);
    else if (State.route.name === 'report-loaded-totals') await renderLoadedTotalsReport(content);
    else if (State.route.name === 'report-supervisor') await renderSupervisorReport(content);
    else if (State.route.name === 'report-warehouse') await renderWarehouseReport(content);
    else if (State.route.name === 'report-rpm') await renderRpmReport(content);
    else if (State.route.name === 'report-stock') await renderStockReport(content);
    else if (State.route.name === 'report-missing') await renderMissingAttachmentsReport(content);
  } catch (err) {
    console.error(err);
    content.innerHTML = `<div class="card">Error loading page: ${esc(err.message)}</div>`;
  }
}

/* ================= SUMMARY PAGE ================= */
let summaryState = { period: 'week', anchor: todayISO(), tab: 'schedule' };

async function renderSummary(content) {
  setTitle('Schedule', 'Schedule, planned vs actual, and deviations');
  const { from, to } = periodRangeFor(summaryState);
  const [loads, attachmentIds] = await Promise.all([
    DB.getLoads({ dateFrom: from, dateTo: to }),
    DB.getAllAttachmentLoadIds()
  ]);

  const totalPlanned = loads.reduce((s, l) => s + num(l.planned_pallets), 0);
  const totalActual = loads.reduce((s, l) => s + num(l.actual_pallets), 0);
  const totalPlannedCans = loads.reduce((s, l) => s + num(l.planned_cans_m), 0);
  const totalActualCans = loads.reduce((s, l) => s + num(l.actual_cans_m), 0);
  const deviations = loads.filter(l => (l.status === 'loaded' || l.status === 'dispatched') && num(l.actual_pallets) !== num(l.planned_pallets));
  const totalDeviation = deviations.reduce((s, l) => s + (num(l.planned_pallets) - num(l.actual_pallets)), 0);
  const loadedCount = loads.filter(l => l.status === 'loaded' || l.status === 'dispatched').length;

  content.innerHTML = `
    ${periodFilterHtml(summaryState, 'summary')}

    <div class="grid grid-4" style="margin-bottom:20px;">
      <div class="stat-card"><div class="stat-label">Loads in period</div><div class="stat-value">${loads.length}</div><div class="stat-sub">${loadedCount} loaded/dispatched</div></div>
      <div class="stat-card"><div class="stat-label">Planned pallets</div><div class="stat-value">${totalPlanned}</div><div class="stat-sub">${fmtCans(totalPlannedCans)} cans</div></div>
      <div class="stat-card"><div class="stat-label">Actual pallets</div><div class="stat-value">${totalActual}</div><div class="stat-sub">${fmtCans(totalActualCans)} cans</div></div>
      <div class="stat-card"><div class="stat-label">Deviation</div><div class="stat-value" style="color:${totalDeviation > 0 ? 'var(--red)' : 'var(--green)'}">${totalDeviation > 0 ? '-' : ''}${Math.abs(totalDeviation)}</div><div class="stat-sub">${deviations.length} loads with a variance</div></div>
    </div>

    <div class="grid grid-2" style="margin-bottom:20px;">
      <div class="card chart-card">
        <div class="section-title"><h2>Pallets loaded per customer</h2><div class="actions">
          <button class="btn btn-outline btn-sm" id="copy-customer-chart">Copy data</button>
          <button class="btn btn-outline btn-sm" id="copy-customer-chart-img">Copy image</button>
        </div></div>
        <canvas id="chart-customer"></canvas>
      </div>
      <div class="card chart-card">
        <div class="section-title"><h2>Deviation by day</h2><div class="actions">
          <button class="btn btn-outline btn-sm" id="copy-deviation-chart-img">Copy image</button>
        </div></div>
        <canvas id="chart-deviation"></canvas>
      </div>
    </div>

    <div class="tab-group" id="summary-view-tabs" style="margin-bottom:14px;">
      <button type="button" data-t="schedule" class="${summaryState.tab === 'schedule' ? 'active' : ''}">Schedule</button>
      <button type="button" data-t="planned" class="${summaryState.tab === 'planned' ? 'active' : ''}">Planned vs Actual</button>
      <button type="button" data-t="deviations" class="${summaryState.tab === 'deviations' ? 'active' : ''}">Deviations</button>
    </div>
    <div id="summary-tab-body"></div>
  `;

  bindPeriodFilter(summaryState, 'summary', renderContent);
  $('#summary-view-tabs').querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => { summaryState.tab = btn.dataset.t; renderContent(); });
  });
  $('#copy-customer-chart').addEventListener('click', () => {
    const byCustomer = {};
    loads.forEach(l => { const n = destLabelPlain(l); byCustomer[n] = (byCustomer[n] || 0) + num(l.actual_pallets); });
    const lines = Object.entries(byCustomer).sort((a, b) => b[1] - a[1]).map(([n, v]) => `${n}\t${v}`);
    copyText(lines.join('\n'));
  });
  $('#copy-customer-chart-img').addEventListener('click', () => copyCanvasImage($('#chart-customer')));
  $('#copy-deviation-chart-img').addEventListener('click', () => copyCanvasImage($('#chart-deviation')));

  const body = $('#summary-tab-body');
  if (summaryState.tab === 'schedule') body.innerHTML = scheduleTabHtml(loads, attachmentIds, { from, to, totalPlanned, totalActual, totalPlannedCans, totalActualCans });
  else if (summaryState.tab === 'planned') body.innerHTML = plannedTabHtml(loads, { totalPlanned, totalActual });
  else body.innerHTML = deviationsTabHtml(deviations, totalDeviation);

  bindScheduleTabEvents(body);
  renderCharts(loads, from, to);
}

function destLabelPlain(l) {
  if (l.destination_type === 'warehouse') return `🏭 ${warehouseName(l.warehouse_id)}`;
  return l.customers?.name || 'Unknown';
}

function scheduleTabHtml(loads, attachmentIds, totals) {
  return `
    <div class="section-title"><h2>Schedule (${fmtDate(totals.from)} – ${fmtDate(totals.to)})</h2></div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Wk</th><th>Date</th><th>Destination</th><th>Transporter</th><th>PO / DN</th><th>Design</th>
          <th class="num">Planned</th><th class="num">Actual</th><th class="num">Cans (M)</th><th>Shift</th><th>Supervisor</th><th>TAT</th><th>Status</th><th>Docs</th><th>Last edit</th>
        </tr></thead>
        <tbody>
          ${loads.length ? loads.map(l => `
            <tr>
              <td class="small muted">${esc(fmtWeek(l.loading_date))}</td>
              <td>${esc(fmtDateShort(l.loading_date))}</td>
              <td>${destLabel(l)}</td>
              <td>${esc(l.transporter || '')}</td>
              <td class="small muted">${esc(l.gzi_dn || l.gzi_po_number || '')}</td>
              <td>${esc(l.design || '')}</td>
              <td class="num">${nOrDash(l.planned_pallets)}</td>
              <td class="num">${nOrDash(l.actual_pallets)}</td>
              <td class="num">${fmtCans(l.actual_cans_m ?? l.planned_cans_m)}</td>
              <td class="small">${esc(l.shift || '')}</td>
              <td class="small">${supervisorCell(l)}</td>
              <td class="small muted">${esc(l.tat || '')}</td>
              <td><span class="badge ${STATUS_BADGE[l.status] || 'badge-gray'}">${STATUS_LABELS[l.status] || l.status}</span></td>
              <td>
                ${(l.status === 'loaded' || l.status === 'dispatched') && !attachmentIds.has(l.id) ? '<span class="badge badge-red">No doc</span> ' : ''}
                <span class="link-btn" data-docs="${l.id}">Docs</span>
              </td>
              <td class="small muted">${esc(l.updated_by_email || l.created_by_email || '')}<br>${esc(fmtDateTime(l.updated_at || l.created_at))}</td>
            </tr>`).join('') : `<tr><td colspan="15" class="empty-state">No loads scheduled in this period.</td></tr>`}
        </tbody>
        ${loads.length ? `<tfoot><tr><td colspan="6">Totals</td><td class="num">${totals.totalPlanned}</td><td class="num">${totals.totalActual}</td><td class="num">${fmtCans(totals.totalActualCans)}</td><td colspan="6"></td></tr></tfoot>` : ''}
      </table>
    </div>`;
}

function plannedTabHtml(loads, totals) {
  return `
    <div class="section-title"><h2>Planned vs Actioned</h2></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Date</th><th>Destination</th><th>PO / DN</th><th class="num">Planned</th><th class="num">Actioned</th><th class="num">Cans (M)</th><th class="num">Deviation</th><th>Status</th></tr></thead>
        <tbody>
          ${loads.length ? loads.map(l => {
            const variance = num(l.planned_pallets) - num(l.actual_pallets);
            return `<tr>
              <td>${esc(fmtDateShort(l.loading_date))}</td>
              <td>${destLabel(l)}</td>
              <td class="small muted">${esc(l.gzi_dn || l.gzi_po_number || '')}</td>
              <td class="num">${nOrDash(l.planned_pallets)}</td>
              <td class="num">${nOrDash(l.actual_pallets)}</td>
              <td class="num">${fmtCans(l.actual_cans_m ?? l.planned_cans_m)}</td>
              <td class="num" style="color:${variance > 0 ? 'var(--red)' : variance < 0 ? 'var(--blue)' : 'inherit'}">${l.status === 'planned' ? '—' : variance}</td>
              <td><span class="badge ${STATUS_BADGE[l.status] || 'badge-gray'}">${STATUS_LABELS[l.status] || l.status}</span></td>
            </tr>`;
          }).join('') : `<tr><td colspan="8" class="empty-state">No data.</td></tr>`}
        </tbody>
      </table>
    </div>`;
}

function deviationsTabHtml(deviations, totalDeviation) {
  return `
    <div class="section-title"><h2>Deviation report</h2></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Date</th><th>Destination</th><th>PO / DN</th><th class="num">Planned</th><th class="num">Actual</th><th class="num">Deviation</th><th>Comment</th></tr></thead>
        <tbody id="deviation-rows">
          ${deviations.length ? deviations.map(l => `
            <tr>
              <td>${esc(fmtDateShort(l.loading_date))}</td>
              <td>${destLabel(l)}</td>
              <td class="small muted">${esc(l.gzi_dn || l.gzi_po_number || '')}</td>
              <td class="num">${nOrDash(l.planned_pallets)}</td>
              <td class="num">${nOrDash(l.actual_pallets)}</td>
              <td class="num" style="color:var(--red)">${num(l.planned_pallets) - num(l.actual_pallets)}</td>
              <td>
                <input type="text" class="deviation-reason-input" data-load="${l.id}" value="${esc(l.deviation_reason || '')}" placeholder="Add comment…" style="width:220px; padding:5px 7px; border:1px solid var(--border); border-radius:6px;" />
              </td>
            </tr>`).join('') : `<tr><td colspan="7" class="empty-state">No deviations in this period 🎉</td></tr>`}
        </tbody>
        ${deviations.length ? `<tfoot><tr><td colspan="5">Total deviation</td><td class="num" style="color:var(--red)">${totalDeviation}</td><td></td></tr></tfoot>` : ''}
      </table>
    </div>`;
}

function bindScheduleTabEvents(root) {
  root.querySelectorAll('[data-docs]').forEach(el => el.addEventListener('click', () => openAttachmentsModal(el.dataset.docs)));
  root.querySelectorAll('.deviation-reason-input').forEach(inp => {
    inp.addEventListener('change', async () => {
      try {
        const stamp = currentUserStamp();
        await DB.updateLoad(inp.dataset.load, { deviation_reason: inp.value, updated_by: stamp.by, updated_by_email: stamp.email, updated_at: new Date().toISOString() });
        toast('Comment saved', 'ok');
      }
      catch (err) { toast(err.message, 'err'); }
    });
  });
}

function renderCharts(loads, from, to) {
  Object.values(State.charts).forEach(c => c && c.destroy());

  const byCustomer = {};
  loads.forEach(l => { const n = destLabelPlain(l); byCustomer[n] = (byCustomer[n] || 0) + num(l.actual_pallets); });
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
    if ((l.status === 'loaded' || l.status === 'dispatched') && l.loading_date && devByDay[l.loading_date] !== undefined) {
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
  loads.forEach(l => { if (l.customer_id) loadCounts[l.customer_id] = (loadCounts[l.customer_id] || 0) + 1; });

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
    const stamp = currentUserStamp();
    if (isEdit) { payload.updated_by = stamp.by; payload.updated_by_email = stamp.email; payload.updated_at = new Date().toISOString(); }
    else { payload.created_by = stamp.by; payload.created_by_email = stamp.email; }
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

  const [loads, attachmentIds, allDocs, pendingRequests] = await Promise.all([
    DB.getLoads({ customerId }), DB.getAllAttachmentLoadIds(), DB.getAttachmentsByCustomer(customerId), DB.getDeletionRequests({ status: 'pending' })
  ]);
  const totalPlanned = loads.reduce((s, l) => s + num(l.planned_pallets), 0);
  const totalActual = loads.reduce((s, l) => s + num(l.actual_pallets), 0);
  const pendingLoadIds = new Set(pendingRequests.filter(r => r.loads?.customer_id === customerId).map(r => r.load_id));
  const editedBy = customer.updated_by_email || customer.created_by_email;
  const editedAt = customer.updated_at || customer.created_at;

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
      ${editedBy ? `<div class="small muted" style="margin-top:6px;">Last edited by ${esc(editedBy)} on ${esc(fmtDateTime(editedAt))}</div>` : ''}
    </div>

    <div class="grid grid-4" style="margin-bottom:18px;">
      <div class="stat-card"><div class="stat-label">Total loads</div><div class="stat-value">${loads.length}</div></div>
      <div class="stat-card"><div class="stat-label">Planned pallets</div><div class="stat-value">${totalPlanned}</div></div>
      <div class="stat-card"><div class="stat-label">Actual pallets</div><div class="stat-value">${totalActual}</div></div>
      <div class="stat-card"><div class="stat-label">Deviation</div><div class="stat-value">${totalPlanned - totalActual}</div></div>
    </div>

    <div class="table-wrap" style="margin-bottom:24px;">
      <table>
        <thead><tr>
          <th>Wk</th><th>Loading date</th><th>Transporter</th><th>Reg / Fleet</th><th>PO / DN</th>
          <th>Design</th><th class="num">Planned</th><th class="num">Actual</th><th class="num">Cans (M)</th><th>Shift</th><th>Supervisor</th><th>Status</th><th>Docs</th><th></th>
        </tr></thead>
        <tbody id="load-rows">
          ${loads.length ? loads.map(rowHtml).join('') : `<tr><td colspan="14" class="empty-state">No loads yet for this customer. Click "New load" to add one.</td></tr>`}
        </tbody>
        ${loads.length ? `<tfoot><tr><td colspan="6">Totals</td><td class="num">${totalPlanned}</td><td class="num">${totalActual}</td><td colspan="5"></td></tr></tfoot>` : ''}
      </table>
    </div>

    <div class="section-title"><h2>All documents (${allDocs.length})</h2></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Load date</th><th>PO / DN</th><th>File</th><th>Uploaded by</th><th>Uploaded</th><th></th></tr></thead>
        <tbody>
          ${allDocs.length ? allDocs.map(a => `
            <tr>
              <td>${esc(fmtDateShort(a.loads?.loading_date))}</td>
              <td class="small muted">${esc(a.loads?.gzi_dn || a.loads?.gzi_po_number || '')}</td>
              <td><span class="link-btn" data-view-doc="${a.id}">${esc(a.file_name)}</span></td>
              <td class="small muted">${esc(a.uploaded_by_email || '')}</td>
              <td class="small muted">${esc(fmtDateTime(a.uploaded_at))}</td>
              <td><span class="link-btn" data-docs="${a.load_id}">Open load docs</span></td>
            </tr>`).join('') : `<tr><td colspan="6" class="empty-state">No documents attached to any load for this customer yet.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;

  function rowHtml(l) {
    const pending = pendingLoadIds.has(l.id);
    return `<tr data-row="${l.id}">
      <td class="small muted">${esc(fmtWeek(l.loading_date))}</td>
      <td>${esc(fmtDateShort(l.loading_date))}</td>
      <td>${esc(l.transporter || '')}</td>
      <td class="small">${esc(l.reg_number || l.fleet_details || '')}</td>
      <td class="small muted">${esc(l.gzi_dn || l.gzi_po_number || '')}</td>
      <td>${esc(l.design || '')}</td>
      <td class="num">${nOrDash(l.planned_pallets)}</td>
      <td class="num">${nOrDash(l.actual_pallets)}</td>
      <td class="num">${fmtCans(l.actual_cans_m ?? l.planned_cans_m)}</td>
      <td class="small">${esc(l.shift || '')}</td>
      <td class="small">${supervisorCell(l)}</td>
      <td>
        <span class="badge ${STATUS_BADGE[l.status] || 'badge-gray'}">${STATUS_LABELS[l.status] || l.status}</span>
        ${pending ? '<span class="badge badge-amber" style="margin-left:4px;">Pending deletion</span>' : ''}
      </td>
      <td>
        ${(l.status === 'loaded' || l.status === 'dispatched') && !attachmentIds.has(l.id) ? '<span class="badge badge-red">No doc</span> ' : ''}
        <span class="link-btn" data-docs="${l.id}">Docs</span>
      </td>
      <td class="row-actions">
        <button class="btn btn-outline btn-sm" data-edit-load="${l.id}">Edit</button>
        <button class="btn btn-outline btn-sm" data-history="${l.id}">History</button>
        <button class="btn btn-outline btn-sm" data-delete-load="${l.id}" style="color:var(--red); border-color:#f3caca;" ${pending ? 'disabled' : ''}>${pending ? 'Pending' : 'Del'}</button>
      </td>
    </tr>`;
  }

  $('#edit-customer-btn').addEventListener('click', () => openCustomerModal(customer));
  $('#add-load-btn').addEventListener('click', () => openLoadModal({ customer }, null));
  content.querySelectorAll('[data-edit-load]').forEach(el => el.addEventListener('click', () => {
    openLoadModal({ customer }, loads.find(l => l.id === el.dataset.editLoad));
  }));
  content.querySelectorAll('[data-history]').forEach(el => el.addEventListener('click', () => openLoadHistoryModal(el.dataset.history)));
  content.querySelectorAll('[data-delete-load]:not([disabled])').forEach(el => el.addEventListener('click', () => openDeletionRequestModal(el.dataset.deleteLoad)));
  content.querySelectorAll('[data-docs]').forEach(el => el.addEventListener('click', () => openAttachmentsModal(el.dataset.docs)));
  content.querySelectorAll('[data-view-doc]').forEach(el => el.addEventListener('click', async () => {
    const att = allDocs.find(a => a.id === el.dataset.viewDoc);
    try { const url = await DB.signedUrl(att.storage_path); window.open(url, '_blank'); }
    catch (err) { toast(err.message, 'err'); }
  }));
}

function openDeletionRequestModal(loadId) {
  openModal(`
    <div class="modal-header"><h3>Request deletion</h3><button class="modal-close" id="modal-close">&times;</button></div>
    <div class="modal-body">
      <p class="muted small">This load won't be deleted immediately — another signed-in user will need to authorise it. It will show as "Pending deletion" until then.</p>
      <div class="field"><label>Reason for deletion *</label><textarea id="f-reason" rows="3" placeholder="Why should this load be deleted?"></textarea></div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" id="modal-cancel">Cancel</button>
      <button class="btn btn-primary" id="modal-save">Submit for authorisation</button>
    </div>
  `);
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-cancel').addEventListener('click', closeModal);
  $('#modal-save').addEventListener('click', async () => {
    const reason = $('#f-reason').value.trim();
    if (!reason) { toast('A reason is required', 'err'); return; }
    const stamp = currentUserStamp();
    try {
      await DB.createDeletionRequest({ load_id: loadId, reason, requested_by: stamp.by, requested_by_email: stamp.email });
      closeModal();
      toast('Deletion request submitted for authorisation', 'ok');
      renderContent();
    } catch (err) { toast(err.message, 'err'); }
  });
}

/* ================= LOAD MODAL (shared: customer-destined or warehouse-destined) ================= */
function openLoadModal(ctx, load) {
  const isEdit = !!load;
  const v = (f, d = '') => esc(load?.[f] ?? d);
  let destType = load?.destination_type || (ctx.warehouse ? 'warehouse' : 'customer');
  const selectedCustomerId = load?.customer_id || ctx.customer?.id || '';
  const selectedWarehouseId = load?.warehouse_id || ctx.warehouse?.id || '';

  const titleTarget = destType === 'warehouse'
    ? (State.warehouses.find(w => w.id === selectedWarehouseId)?.name || '')
    : (ctx.customer?.name || State.customers.find(c => c.id === selectedCustomerId)?.name || '');

  openModal(`
    <div class="modal-header"><h3 id="load-modal-title">${isEdit ? 'Edit load' : 'New load'} — ${esc(titleTarget)}</h3><button class="modal-close" id="modal-close">&times;</button></div>
    <div class="modal-body">
      <form id="load-form">
        <div class="form-grid">
          <div class="field span-2"><label>Destination</label>
            <div class="tab-group" id="f-dest-type">
              <button type="button" data-d="customer" class="${destType === 'customer' ? 'active' : ''}">Customer</button>
              <button type="button" data-d="warehouse" class="${destType === 'warehouse' ? 'active' : ''}">Warehouse</button>
            </div>
          </div>
          <div class="field span-2" id="f-dest-customer-wrap" style="${destType === 'warehouse' ? 'display:none;' : ''}">
            <label>Customer</label>
            <select id="f-dest-customer">
              <option value="">— Select customer —</option>
              ${State.customers.map(c => `<option value="${c.id}" ${selectedCustomerId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
            </select>
          </div>
          <div class="field span-2" id="f-dest-warehouse-wrap" style="${destType === 'customer' ? 'display:none;' : ''}">
            <label>Warehouse</label>
            <select id="f-dest-warehouse">
              <option value="">— Select warehouse —</option>
              ${State.warehouses.map(w => `<option value="${w.id}" ${selectedWarehouseId === w.id ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}
            </select>
          </div>
          <div class="field"><label>Loading date <span class="muted">(plan date)</span></label><input type="date" id="f-loading-date" value="${v('loading_date')}" /></div>
          <div class="field"><label>Actual loaded date</label><input type="date" id="f-actual-loaded-date" value="${v('actual_loaded_date')}" /></div>
          <div class="field"><label>Offloading date</label><input type="date" id="f-offloading-date" value="${v('offloading_date')}" /></div>
          <div class="field"><label>Time slot</label><input id="f-time-slot" value="${v('time_slot')}" placeholder="e.g. 07:00-16:00" /></div>
          <div class="field"><label>Market</label>
            <select id="f-market">
              <option value="">—</option>
              <option value="local" ${load?.market === 'local' ? 'selected' : ''}>Local</option>
              <option value="export" ${load?.market === 'export' ? 'selected' : ''}>Export</option>
            </select>
          </div>
          <div class="field"><label>Day / Night</label>
            <select id="f-day-night">
              <option value="">—</option>
              <option value="day" ${load?.day_night === 'day' ? 'selected' : ''}>Day shift</option>
              <option value="night" ${load?.day_night === 'night' ? 'selected' : ''}>Night shift</option>
            </select>
          </div>
          <div class="field"><label>Despatching plant</label><input id="f-plant" value="${v('despatching_plant', ctx.customer?.despatching_plant || 'GZI')}" /></div>
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
          <div class="field"><label>Planned cans (M)</label><input type="number" step="0.01" id="f-planned-cans" value="${v('planned_cans_m')}" /></div>
          <div class="field"><label>Actual cans (M)</label><input type="number" step="0.01" id="f-actual-cans" value="${v('actual_cans_m')}" /></div>
          <div class="field"><label>Supervisor</label>
            <select id="f-supervisor">
              <option value="">—</option>
              ${State.supervisors.filter(s => s.active).map(s => `<option value="${s.id}" data-shift="${esc(s.shift || '')}" ${load?.supervisor_id === s.id ? 'selected' : ''}>${esc(s.name)}${s.shift ? ' (Shift ' + esc(s.shift) + ')' : ''}</option>`).join('')}
            </select>
          </div>
          <div class="field"><label>Shift</label>
            <select id="f-shift">
              <option value="">—</option>
              ${['A', 'B', 'C', 'D'].map(s => `<option value="Shift ${s}" ${load?.shift === 'Shift ' + s ? 'selected' : ''}>Shift ${s}</option>`).join('')}
            </select>
          </div>
          <div class="field span-2"><label>Comment <span class="muted">(if the rightful supervisor for this shift is absent)</span></label><input id="f-supervisor-note" value="${v('supervisor_note')}" placeholder="e.g. covering for Shift B while J. Dlamini is on leave" /></div>
          <div class="field"><label>Status</label>
            <select id="f-status">
              ${Object.entries(STATUS_LABELS).map(([k, lbl]) => `<option value="${k}" ${load?.status === k ? 'selected' : (!load && k === 'planned') ? 'selected' : ''}>${lbl}</option>`).join('')}
            </select>
          </div>
          <div class="field"><label>Arrival time</label><input type="time" id="f-arrival" value="${v('arrival_time')}" /></div>
          <div class="field"><label>Loading bay time</label><input type="time" id="f-bay" value="${v('loading_bay_time')}" /></div>
          <div class="field"><label>Depart time</label><input type="time" id="f-depart" value="${v('depart_time')}" /></div>
          <div class="field span-2"><label>Comments</label><textarea id="f-comments" rows="2">${v('comments')}</textarea></div>
          <div class="field span-2"><label>Deviation comment <span class="muted">(if planned ≠ actual)</span></label><input id="f-deviation" value="${v('deviation_reason')}" /></div>
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

  $('#f-dest-type').querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      destType = btn.dataset.d;
      $('#f-dest-type').querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
      $('#f-dest-customer-wrap').style.display = destType === 'customer' ? '' : 'none';
      $('#f-dest-warehouse-wrap').style.display = destType === 'warehouse' ? '' : 'none';
    });
  });

  $('#f-supervisor').addEventListener('change', (e) => {
    const shift = e.target.selectedOptions[0]?.dataset.shift;
    if (shift) $('#f-shift').value = 'Shift ' + shift;
  });

  $('#modal-save').addEventListener('click', async () => {
    const g = (id) => { const x = $(id).value; return x === '' ? null : x; };
    const customer_id = destType === 'customer' ? g('#f-dest-customer') : null;
    const warehouse_id = destType === 'warehouse' ? g('#f-dest-warehouse') : null;
    if (destType === 'customer' && !customer_id) { toast('Select a customer', 'err'); return; }
    if (destType === 'warehouse' && !warehouse_id) { toast('Select a warehouse', 'err'); return; }

    const arrival = g('#f-arrival'), depart = g('#f-depart');
    const status = $('#f-status').value;
    const loadingDate = g('#f-loading-date');
    let actualLoadedDate = g('#f-actual-loaded-date');
    if (!actualLoadedDate && (status === 'loaded' || status === 'dispatched')) actualLoadedDate = loadingDate;
    const stamp = currentUserStamp();
    const payload = {
      destination_type: destType,
      customer_id, warehouse_id,
      loading_date: loadingDate,
      actual_loaded_date: actualLoadedDate,
      offloading_date: g('#f-offloading-date'),
      time_slot: g('#f-time-slot'),
      market: g('#f-market'),
      day_night: g('#f-day-night'),
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
      planned_cans_m: g('#f-planned-cans'),
      actual_cans_m: g('#f-actual-cans'),
      supervisor_id: g('#f-supervisor'),
      shift: g('#f-shift'),
      supervisor_note: g('#f-supervisor-note'),
      status,
      arrival_time: arrival,
      loading_bay_time: g('#f-bay'),
      depart_time: depart,
      tat: computeTAT(arrival, depart),
      comments: g('#f-comments'),
      deviation_reason: g('#f-deviation')
    };
    if (isEdit) { payload.updated_by = stamp.by; payload.updated_by_email = stamp.email; payload.updated_at = new Date().toISOString(); }
    else { payload.created_by = stamp.by; payload.created_by_email = stamp.email; }

    try {
      let saved;
      if (isEdit) saved = await DB.updateLoad(load.id, payload);
      else saved = await DB.createLoad(payload);
      await logLoadAudit(saved.id, isEdit ? 'update' : 'insert', payload);
      await syncSohForLoad(saved);
      await syncRpmForLoad(saved);
      closeModal();
      toast(isEdit ? 'Load updated' : 'Load added', 'ok');
      renderContent();
    } catch (err) { toast(err.message, 'err'); }
  });
}

async function openLoadHistoryModal(loadId) {
  openModal(`
    <div class="modal-header"><h3>Edit history</h3><button class="modal-close" id="modal-close">&times;</button></div>
    <div class="modal-body"><div id="history-list">Loading…</div></div>
    <div class="modal-footer"><button class="btn btn-outline" id="modal-cancel">Close</button></div>
  `);
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-cancel').addEventListener('click', closeModal);
  try {
    const rows = await DB.getLoadAuditLog(loadId);
    $('#history-list').innerHTML = rows.length ? `<div class="audit-list">${rows.map(r => `
      <div class="audit-entry">
        <div><b>${r.action === 'insert' ? 'Created' : 'Edited'}</b> by ${esc(r.changed_by_email || 'unknown')}</div>
        <div class="muted small">${esc(fmtDateTime(r.changed_at))}</div>
      </div>`).join('')}</div>` : `<div class="muted small">No history recorded yet.</div>`;
  } catch (err) { $('#history-list').innerHTML = `<div class="login-error">${esc(err.message)}</div>`; }
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

/* ================= USERS & ROLES ================= */
async function renderUsers(content) {
  setTitle('Users & roles', 'Manager or Supervisor role is required to authorise load deletions');
  const profiles = await DB.getProfiles();
  const canEdit = isManager();

  content.innerHTML = `
    ${!canEdit ? `<div class="card" style="margin-bottom:16px;"><p class="muted small" style="margin:0;">You can view roles here, but only a Manager can change them.</p></div>` : ''}
    <div class="table-wrap">
      <table>
        <thead><tr><th>Email</th><th>Role</th>${canEdit ? '<th></th>' : ''}</tr></thead>
        <tbody>
          ${profiles.length ? profiles.map(p => `
            <tr>
              <td>${esc(p.email)} ${p.id === State.session?.user?.id ? '<span class="muted small">(you)</span>' : ''}</td>
              <td>
                ${canEdit
                  ? `<select data-role="${p.id}">
                      ${Object.entries(ROLE_LABELS).map(([k, lbl]) => `<option value="${k}" ${p.role === k ? 'selected' : ''}>${lbl}</option>`).join('')}
                     </select>`
                  : `<span class="badge badge-blue">${esc(roleLabel(p.role))}</span>`}
              </td>
              ${canEdit ? `<td><button class="btn btn-outline btn-sm" data-save-role="${p.id}">Save</button></td>` : ''}
            </tr>`).join('') : `<tr><td colspan="3" class="empty-state">No user profiles yet.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;

  content.querySelectorAll('[data-save-role]').forEach(btn => btn.addEventListener('click', async () => {
    const id = btn.dataset.saveRole;
    const role = content.querySelector(`[data-role="${id}"]`).value;
    try {
      await DB.updateProfileRole(id, role);
      toast('Role updated', 'ok');
      if (id === State.session?.user?.id) State.myRole = role;
      renderContent();
    } catch (err) { toast(err.message, 'err'); }
  }));
}

/* ---------------- start ---------------- */
initAuth();
