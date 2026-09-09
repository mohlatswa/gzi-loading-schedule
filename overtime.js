/* GZI Loading Schedule — overtime.js
   Warehouse Overtime Sheet + per-employee Summary + Manager Approvals + Warehouse-team manage page.
   Modelled on "Overtime sheet 2026 Warehouse.xlsx" (Technical Stores Overtime Sheet). */

const OT_MAX_HOURS = 44;                       // weekly / pay-month ceiling from the spreadsheet ("Hours Left to 44")
const OT_LOW_LEFT = 6;                         // amber warning when this few hours (or fewer) remain

const MONTHS3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec']; // sheet uses "Sept"

const OT_RATES = ['@1.33', '@1.5', '@2', '@2.33', 'Normal rate'];
const OT_SHIFTS = ['A - Day', 'A - Night', 'B - Day', 'B - Night', 'C - Day', 'C - Night', 'D - Day', 'D - Night', 'Day', 'Night'];
const OT_REASONS = ['Leave', 'Vacant', 'Stock count', 'Induction', 'Public holiday', 'Sick', 'Operational requirement'];
const OT_REMARKS = ['Cover shift A', 'Cover shift B', 'Cover shift C', 'Cover shift D', 'Stock count', 'HSE Induction Training'];

function otBuildPayPeriods() {
  const out = [];
  let m = 11, y = 2025;                        // start Dec 2025 (16Dec 2025 - 15Jan 2026)
  for (let i = 0; i < 13; i++) {
    const nm = (m + 1) % 12;
    const ny = m === 11 ? y + 1 : y;
    out.push(`16${MONTHS3[m]} ${y} - 15${MONTHS3[nm]} ${ny}`);
    m = nm; y = ny;
  }
  out.push('Final Pay Period');
  return out;
}
const OT_PAY_PERIODS = otBuildPayPeriods();
const OT_PAY_MONTHS = ['Dec 2025', ...MONTHS3.map(m => `${m} 2026`), 'Jan 2027'];

function otMonth3(iso) { if (!iso) return ''; const d = new Date(iso + 'T00:00:00'); return isNaN(d) ? '' : MONTHS3[d.getMonth()]; }

/* Pay period that contains a work date: runs 16th of one month → 15th of the next. */
function otPeriodForDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d)) return '';
  let sm = d.getMonth(), sy = d.getFullYear();
  if (d.getDate() < 16) { sm -= 1; if (sm < 0) { sm = 11; sy -= 1; } }
  const em = (sm + 1) % 12, ey = sm === 11 ? sy + 1 : sy;
  const label = `16${MONTHS3[sm]} ${sy} - 15${MONTHS3[em]} ${ey}`;
  return OT_PAY_PERIODS.includes(label) ? label : '';
}
/* Pay month usually named after the month the period ends in. */
function otPayMonthForPeriod(period) {
  if (!period || period === 'Final Pay Period') return '';
  const m = period.match(/- 15([A-Za-z]+) (\d{4})$/);
  if (!m) return '';
  const label = `${m[1]} ${m[2]}`;
  return OT_PAY_MONTHS.includes(label) ? label : '';
}

/* Which pay month is "current" for dashboard / default filters. */
function otCurrentPayMonth() {
  return otPayMonthForPeriod(otPeriodForDate(todayISO())) || OT_PAY_MONTHS[OT_PAY_MONTHS.length - 2];
}

const OT_STATUS_LABEL = { pending: 'Pending approval', approved: 'Approved', rejected: 'Rejected' };
const OT_STATUS_BADGE = { pending: 'badge-amber', approved: 'badge-green', rejected: 'badge-red' };

/* ---------------- data layer ---------------- */
const OT = {
  async getStaff() {
    const { data, error } = await sb.from('overtime_staff').select('*').order('sort_order').order('name');
    if (error) throw error;
    return data;
  },
  async createStaff(payload) { const { error } = await sb.from('overtime_staff').insert(payload); if (error) throw error; },
  async updateStaff(id, payload) { const { error } = await sb.from('overtime_staff').update(payload).eq('id', id); if (error) throw error; },
  async deleteStaff(id) { const { error } = await sb.from('overtime_staff').delete().eq('id', id); if (error) throw error; },

  async getEntries({ status, payMonth, staffId } = {}) {
    let q = sb.from('overtime_entries').select('*, overtime_staff(name, employee_no, shift)').order('work_date', { ascending: false }).order('created_at', { ascending: false });
    if (status) q = q.eq('status', status);
    if (payMonth) q = q.eq('pay_month', payMonth);
    if (staffId) q = q.eq('staff_id', staffId);
    const { data, error } = await q;
    if (error) throw error;
    return data;
  },
  async createEntry(payload) { const { data, error } = await sb.from('overtime_entries').insert(payload).select().single(); if (error) throw error; return data; },
  async updateEntry(id, payload) { const { error } = await sb.from('overtime_entries').update(payload).eq('id', id); if (error) throw error; },
  async deleteEntry(id) { const { error } = await sb.from('overtime_entries').delete().eq('id', id); if (error) throw error; },
  async decideEntry(id, { status, note }) {
    const stamp = currentUserStamp();
    const { error } = await sb.from('overtime_entries').update({
      status, decision_note: note || null,
      decided_by: stamp.by, decided_by_email: stamp.email, decided_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }).eq('id', id);
    if (error) throw error;
  }
};

function otStaffName(rec) { return rec.overtime_staff?.name || rec.cover_by || '—'; }
function otHours(v) { const n = Number(v); return isNaN(n) ? 0 : n; }
function otFmtH(v) { const n = otHours(v); return (Math.round(n * 100) / 100).toString(); }

/* ================= OVERTIME SHEET ================= */
let otSheetState = { payMonth: '', status: 'all', staffId: '' };

async function renderOvertimeSheet(content) {
  setTitle('Overtime sheet', 'Technical Stores overtime — capture hours, then submit for manager approval');
  const [staff, entries] = await Promise.all([
    OT.getStaff(),
    OT.getEntries({
      payMonth: otSheetState.payMonth || undefined,
      status: otSheetState.status === 'all' ? undefined : otSheetState.status,
      staffId: otSheetState.staffId || undefined
    })
  ]);

  const totalHours = entries.reduce((s, e) => s + otHours(e.hours), 0);
  const pendingCount = entries.filter(e => e.status === 'pending').length;

  content.innerHTML = `
    <div class="filter-bar">
      <div class="field"><label>Pay month</label>
        <select id="ot-f-paymonth">
          <option value="">All pay months</option>
          ${OT_PAY_MONTHS.map(m => `<option value="${esc(m)}" ${otSheetState.payMonth === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Employee</label>
        <select id="ot-f-staff">
          <option value="">All employees</option>
          ${staff.map(s => `<option value="${s.id}" ${otSheetState.staffId === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
        </select>
      </div>
      <div class="tab-group" id="ot-f-status">
        ${['all', 'pending', 'approved', 'rejected'].map(k => `<button type="button" data-s="${k}" class="${otSheetState.status === k ? 'active' : ''}">${k === 'all' ? 'All' : OT_STATUS_LABEL[k]}</button>`).join('')}
      </div>
      <div style="margin-left:auto; align-self:center;">
        <button class="btn btn-outline btn-sm" id="ot-print-btn">Print</button>
        <button class="btn btn-orange btn-sm" id="ot-add-btn">+ New overtime</button>
      </div>
    </div>

    <div class="grid grid-4" style="margin-bottom:18px;">
      <div class="stat-card"><div class="stat-label">Entries shown</div><div class="stat-value">${entries.length}</div></div>
      <div class="stat-card"><div class="stat-label">Total hours</div><div class="stat-value">${otFmtH(totalHours)}</div></div>
      <div class="stat-card"><div class="stat-label">Pending approval</div><div class="stat-value" style="color:${pendingCount ? 'var(--amber)' : 'var(--green)'}">${pendingCount}</div></div>
      <div class="stat-card"><div class="stat-label">Employees</div><div class="stat-value">${staff.length}</div><div class="stat-sub"><span class="link-btn" data-goto="overtime-staff">Manage warehouse team</span></div></div>
    </div>

    <div class="table-wrap" id="ot-print-area">
      <table>
        <thead><tr>
          <th>Date</th><th>Month</th><th>Overtime period</th><th>Pay month</th>
          <th>Cover for</th><th>Cover by</th><th>Shift</th><th class="num">Hours</th><th>Rate</th>
          <th>Remarks</th><th>Reason</th><th>Status</th><th class="no-print"></th>
        </tr></thead>
        <tbody>
          ${entries.length ? entries.map(e => {
            const locked = e.status === 'approved' && !isManager();
            return `<tr>
              <td>${esc(fmtDateShort(e.work_date))}</td>
              <td class="small muted">${esc(e.month || otMonth3(e.work_date))}</td>
              <td class="small">${esc(e.overtime_period || '')}</td>
              <td class="small">${esc(e.pay_month || '')}</td>
              <td>${esc(e.cover_for || '')}</td>
              <td>${esc(otStaffName(e))}${e.overtime_staff?.employee_no ? ` <span class="small muted">${esc(e.overtime_staff.employee_no)}</span>` : ''}</td>
              <td class="small">${esc(e.shift || '')}</td>
              <td class="num">${otFmtH(e.hours)}</td>
              <td class="small">${esc(e.overtime_rate || '')}</td>
              <td class="small">${esc(e.remarks || '')}</td>
              <td class="small">${esc(e.reason || '')}</td>
              <td>
                <span class="badge ${OT_STATUS_BADGE[e.status] || 'badge-gray'}">${OT_STATUS_LABEL[e.status] || e.status}</span>
                ${e.status === 'rejected' && e.decision_note ? `<div class="small muted" title="${esc(e.decision_note)}">${esc(e.decision_note)}</div>` : ''}
              </td>
              <td class="row-actions no-print">
                <button class="btn btn-outline btn-sm" data-edit="${e.id}" ${locked ? 'disabled' : ''}>${locked ? 'Locked' : 'Edit'}</button>
                <button class="btn btn-outline btn-sm" data-del="${e.id}" style="color:var(--red); border-color:#f3caca;" ${locked ? 'disabled' : ''}>Del</button>
              </td>
            </tr>`;
          }).join('') : `<tr><td colspan="13" class="empty-state">No overtime captured yet. Click "New overtime" to add the first entry.</td></tr>`}
        </tbody>
        ${entries.length ? `<tfoot><tr><td colspan="7">Total</td><td class="num">${otFmtH(totalHours)}</td><td colspan="5"></td></tr></tfoot>` : ''}
      </table>
    </div>
  `;

  $('#ot-f-paymonth').addEventListener('change', e => { otSheetState.payMonth = e.target.value; renderContent(); });
  $('#ot-f-staff').addEventListener('change', e => { otSheetState.staffId = e.target.value; renderContent(); });
  $('#ot-f-status').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { otSheetState.status = b.dataset.s; renderContent(); }));
  $('#ot-add-btn').addEventListener('click', () => openOvertimeModal(staff, null));
  $('#ot-print-btn').addEventListener('click', () => window.print());
  content.querySelectorAll('[data-goto]').forEach(el => el.addEventListener('click', () => { location.hash = '#/' + el.dataset.goto; }));
  content.querySelectorAll('[data-edit]:not([disabled])').forEach(el => el.addEventListener('click', () => {
    openOvertimeModal(staff, entries.find(x => x.id === el.dataset.edit));
  }));
  content.querySelectorAll('[data-del]:not([disabled])').forEach(el => el.addEventListener('click', async () => {
    const e = entries.find(x => x.id === el.dataset.del);
    if (!confirm(`Delete this overtime entry (${esc(otStaffName(e))}, ${fmtDateShort(e.work_date)}, ${otFmtH(e.hours)}h)?`)) return;
    try { await OT.deleteEntry(e.id); toast('Overtime entry deleted', 'ok'); renderContent(); }
    catch (err) { toast(err.message, 'err'); }
  }));
}

function openOvertimeModal(staff, entry) {
  const isEdit = !!entry;
  const v = (f, d = '') => esc(entry?.[f] ?? d);
  const activeStaff = staff.filter(s => s.active !== false);
  const staffOptions = (staff.length ? staff : activeStaff);

  openModal(`
    <div class="modal-header"><h3>${isEdit ? 'Edit overtime entry' : 'New overtime entry'}</h3><button class="modal-close" id="modal-close">&times;</button></div>
    <div class="modal-body">
      <form id="ot-form">
        <div class="form-grid">
          <div class="field span-2"><label>Employee (person who worked the overtime) *</label>
            <select id="ot-staff" required>
              <option value="">— Select employee —</option>
              ${staffOptions.map(s => `<option value="${s.id}" data-name="${esc(s.name)}" data-shift="${esc(s.shift || '')}" ${entry?.staff_id === s.id ? 'selected' : ''}>${esc(s.name)}${s.employee_no ? ' · ' + esc(s.employee_no) : ''}</option>`).join('')}
            </select>
          </div>
          <div class="field"><label>Date *</label><input type="date" id="ot-date" required value="${v('work_date')}" /></div>
          <div class="field"><label>Month</label><input id="ot-month" readonly value="${v('month')}" placeholder="auto from date" /></div>
          <div class="field"><label>Overtime period *</label>
            <select id="ot-period" required>
              <option value="">— Select period —</option>
              ${OT_PAY_PERIODS.map(p => `<option value="${esc(p)}" ${entry?.overtime_period === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}
            </select>
          </div>
          <div class="field"><label>Pay month *</label>
            <select id="ot-paymonth" required>
              <option value="">— Select pay month —</option>
              ${OT_PAY_MONTHS.map(m => `<option value="${esc(m)}" ${entry?.pay_month === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}
            </select>
          </div>
          <div class="field"><label>Cover for <span class="muted">(who / which shift is being covered)</span></label>
            <input id="ot-coverfor" list="ot-coverfor-list" value="${v('cover_for')}" placeholder="e.g. Shift A or a name" />
            <datalist id="ot-coverfor-list">
              ${['Shift A', 'Shift B', 'Shift C', 'Shift D', ...staff.map(s => s.name)].map(n => `<option value="${esc(n)}"></option>`).join('')}
            </datalist>
          </div>
          <div class="field"><label>Cover by <span class="muted">(person covering)</span></label><input id="ot-coverby" value="${v('cover_by')}" placeholder="defaults to the employee" /></div>
          <div class="field"><label>Shift</label>
            <select id="ot-shift">
              <option value="">—</option>
              ${OT_SHIFTS.map(s => `<option value="${esc(s)}" ${entry?.shift === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
            </select>
          </div>
          <div class="field"><label>Hours *</label><input type="number" step="0.01" min="0" id="ot-hours" required value="${v('hours')}" /></div>
          <div class="field"><label>Overtime rate</label>
            <select id="ot-rate">
              <option value="">—</option>
              ${OT_RATES.map(r => `<option value="${esc(r)}" ${entry?.overtime_rate === r ? 'selected' : ''}>${esc(r)}</option>`).join('')}
            </select>
          </div>
          <div class="field"><label>Remarks</label><input id="ot-remarks" list="ot-remarks-list" value="${v('remarks')}" />
            <datalist id="ot-remarks-list">${OT_REMARKS.map(r => `<option value="${esc(r)}"></option>`).join('')}</datalist>
          </div>
          <div class="field"><label>Reason</label><input id="ot-reason" list="ot-reason-list" value="${v('reason')}" />
            <datalist id="ot-reason-list">${OT_REASONS.map(r => `<option value="${esc(r)}"></option>`).join('')}</datalist>
          </div>
        </div>
        <p class="muted small" style="margin:12px 2px 0;">On save this entry is submitted with status <b>Pending approval</b>. A manager signs it off on the Approvals page.</p>
      </form>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" id="modal-cancel">Cancel</button>
      <button class="btn btn-primary" id="modal-save">${isEdit ? 'Save & resubmit' : 'Submit for approval'}</button>
    </div>
  `);
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-cancel').addEventListener('click', closeModal);

  const dateEl = $('#ot-date'), monthEl = $('#ot-month'), periodEl = $('#ot-period'), payEl = $('#ot-paymonth');
  const staffEl = $('#ot-staff'), coverByEl = $('#ot-coverby'), shiftEl = $('#ot-shift');

  function syncFromDate() {
    monthEl.value = otMonth3(dateEl.value);
    if (!periodEl.value) { const p = otPeriodForDate(dateEl.value); if (p) periodEl.value = p; }
    if (!payEl.value) { const pm = otPayMonthForPeriod(periodEl.value); if (pm) payEl.value = pm; }
  }
  dateEl.addEventListener('change', syncFromDate);
  periodEl.addEventListener('change', () => { if (!payEl.value) { const pm = otPayMonthForPeriod(periodEl.value); if (pm) payEl.value = pm; } });
  staffEl.addEventListener('change', () => {
    const opt = staffEl.selectedOptions[0];
    if (!opt) return;
    if (!coverByEl.value) coverByEl.value = opt.dataset.name || '';
    if (!shiftEl.value && opt.dataset.shift) {
      const match = OT_SHIFTS.find(s => s.startsWith(opt.dataset.shift + ' '));
      if (match) shiftEl.value = match;
    }
  });
  if (!isEdit) syncFromDate();

  $('#modal-save').addEventListener('click', async () => {
    const staffId = staffEl.value;
    const workDate = dateEl.value;
    const hours = $('#ot-hours').value;
    if (!staffId) { toast('Select the employee', 'err'); return; }
    if (!workDate) { toast('Pick the work date', 'err'); return; }
    if (hours === '' || isNaN(Number(hours)) || Number(hours) <= 0) { toast('Enter the hours worked', 'err'); return; }
    if (!periodEl.value) { toast('Select the overtime period', 'err'); return; }
    if (!payEl.value) { toast('Select the pay month', 'err'); return; }

    const stamp = currentUserStamp();
    const chosen = staffEl.selectedOptions[0];
    const payload = {
      staff_id: staffId,
      work_date: workDate,
      month: otMonth3(workDate),
      overtime_period: periodEl.value,
      pay_month: payEl.value,
      cover_for: $('#ot-coverfor').value.trim() || null,
      cover_by: coverByEl.value.trim() || chosen?.dataset.name || null,
      shift: shiftEl.value || null,
      hours: Number(hours),
      overtime_rate: $('#ot-rate').value || null,
      remarks: $('#ot-remarks').value.trim() || null,
      reason: $('#ot-reason').value.trim() || null,
      status: 'pending',
      decided_by: null, decided_by_email: null, decided_at: null, decision_note: null,
      updated_at: new Date().toISOString()
    };
    if (!isEdit) { payload.submitted_by = stamp.by; payload.submitted_by_email = stamp.email; }

    const btn = $('#modal-save');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    try {
      if (isEdit) await OT.updateEntry(entry.id, payload);
      else await OT.createEntry(payload);
      closeModal();
      toast('Overtime submitted for manager approval', 'ok');
      renderContent();
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false; btn.textContent = isEdit ? 'Save & resubmit' : 'Submit for approval';
    }
  });
}

/* ================= OVERTIME SUMMARY (per employee) ================= */
let otSummaryState = { payMonth: '', basis: 'approved' };  // basis: 'approved' | 'all'

async function renderOvertimeSummary(content) {
  setTitle('Overtime summary', `Overtime hours per employee, per pay month — flags anyone over the ${OT_MAX_HOURS}-hour limit`);
  if (!otSummaryState.payMonth) otSummaryState.payMonth = otCurrentPayMonth();

  const [staff, entries] = await Promise.all([
    OT.getStaff(),
    OT.getEntries({ payMonth: otSummaryState.payMonth })
  ]);

  const counted = entries.filter(e => otSummaryState.basis === 'all' ? e.status !== 'rejected' : e.status === 'approved');

  // aggregate per staff member
  const rows = staff.map(s => {
    const mine = counted.filter(e => e.staff_id === s.id);
    const bucket = { '@2': 0, '@2.33': 0, '@1.5': 0, '@1.33': 0, night: 0, other: 0 };
    let total = 0, pendingH = 0;
    entries.filter(e => e.staff_id === s.id).forEach(e => { if (e.status === 'pending') pendingH += otHours(e.hours); });
    mine.forEach(e => {
      const h = otHours(e.hours);
      total += h;
      if (bucket[e.overtime_rate] !== undefined) bucket[e.overtime_rate] += h; else bucket.other += h;
      if ((e.shift || '').toLowerCase().includes('night')) bucket.night += h;
    });
    const left = OT_MAX_HOURS - total;
    return { staff: s, bucket, total, pendingH, left, over: total > OT_MAX_HOURS, entryCount: mine.length };
  }).filter(r => r.total > 0 || r.pendingH > 0);

  const grand = rows.reduce((a, r) => {
    a.total += r.total; a.night += r.bucket.night;
    ['@2', '@2.33', '@1.5', '@1.33'].forEach(k => a[k] += r.bucket[k]);
    return a;
  }, { total: 0, night: 0, '@2': 0, '@2.33': 0, '@1.5': 0, '@1.33': 0 });

  const overCount = rows.filter(r => r.over).length;

  content.innerHTML = `
    <div class="filter-bar">
      <div class="field"><label>Pay month</label>
        <select id="ots-paymonth">
          ${OT_PAY_MONTHS.map(m => `<option value="${esc(m)}" ${otSummaryState.payMonth === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}
        </select>
      </div>
      <div class="tab-group" id="ots-basis">
        <button type="button" data-b="approved" class="${otSummaryState.basis === 'approved' ? 'active' : ''}">Approved only</button>
        <button type="button" data-b="all" class="${otSummaryState.basis === 'all' ? 'active' : ''}">Approved + pending</button>
      </div>
      <div style="margin-left:auto; align-self:center;"><button class="btn btn-outline btn-sm" id="ots-print">Print</button></div>
    </div>

    <div class="grid grid-4" style="margin-bottom:18px;">
      <div class="stat-card"><div class="stat-label">Employees with overtime</div><div class="stat-value">${rows.length}</div></div>
      <div class="stat-card"><div class="stat-label">Total overtime hours</div><div class="stat-value">${otFmtH(grand.total)}</div><div class="stat-sub">${esc(otSummaryState.payMonth)}</div></div>
      <div class="stat-card"><div class="stat-label">Over the ${OT_MAX_HOURS}h limit</div><div class="stat-value" style="color:${overCount ? 'var(--red)' : 'var(--green)'}">${overCount}</div></div>
      <div class="stat-card"><div class="stat-label">Limit per employee</div><div class="stat-value">${OT_MAX_HOURS}h</div><div class="stat-sub">per pay month</div></div>
    </div>

    <div class="table-wrap" id="ots-print-area">
      <table>
        <thead><tr>
          <th>Name</th><th>No</th><th>Pay month</th>
          <th class="num">Night shift</th><th class="num">Hrs @2</th><th class="num">Hrs @2.33</th><th class="num">Hrs @1.5</th><th class="num">Hrs @1.33</th>
          <th class="num">Total hrs</th><th>Hours left to ${OT_MAX_HOURS}</th>
        </tr></thead>
        <tbody>
          ${rows.length ? rows.map(r => `
            <tr>
              <td>${esc(r.staff.name)}</td>
              <td class="small muted">${esc(r.staff.employee_no || '')}</td>
              <td class="small">${esc(otSummaryState.payMonth)}</td>
              <td class="num">${r.bucket.night ? otFmtH(r.bucket.night) : '—'}</td>
              <td class="num">${r.bucket['@2'] ? otFmtH(r.bucket['@2']) : '—'}</td>
              <td class="num">${r.bucket['@2.33'] ? otFmtH(r.bucket['@2.33']) : '—'}</td>
              <td class="num">${r.bucket['@1.5'] ? otFmtH(r.bucket['@1.5']) : '—'}</td>
              <td class="num">${r.bucket['@1.33'] ? otFmtH(r.bucket['@1.33']) : '—'}</td>
              <td class="num"><b>${otFmtH(r.total)}</b>${r.pendingH ? `<div class="small muted">+${otFmtH(r.pendingH)} pending</div>` : ''}</td>
              <td>
                ${r.over
                  ? `<span class="badge badge-red">Hours over by ${otFmtH(r.total - OT_MAX_HOURS)}</span>`
                  : `<span class="badge ${r.left <= OT_LOW_LEFT ? 'badge-amber' : 'badge-green'}">${otFmtH(r.left)} h left before max</span>`}
              </td>
            </tr>`).join('') : `<tr><td colspan="10" class="empty-state">No ${otSummaryState.basis === 'approved' ? 'approved ' : ''}overtime for ${esc(otSummaryState.payMonth)}.</td></tr>`}
        </tbody>
        ${rows.length ? `<tfoot><tr>
          <td colspan="3">Totals</td>
          <td class="num">${otFmtH(grand.night)}</td>
          <td class="num">${otFmtH(grand['@2'])}</td>
          <td class="num">${otFmtH(grand['@2.33'])}</td>
          <td class="num">${otFmtH(grand['@1.5'])}</td>
          <td class="num">${otFmtH(grand['@1.33'])}</td>
          <td class="num">${otFmtH(grand.total)}</td>
          <td></td>
        </tr></tfoot>` : ''}
      </table>
    </div>
    <p class="muted small" style="margin-top:10px;">"Total hrs" is every overtime hour captured for the employee in the pay month. Anyone above ${OT_MAX_HOURS} h is flagged in red; otherwise the badge shows how many hours remain before the limit. Rate columns are the breakdown by overtime rate; "Night shift" totals hours worked on a night shift.</p>
  `;

  $('#ots-paymonth').addEventListener('change', e => { otSummaryState.payMonth = e.target.value; renderContent(); });
  $('#ots-basis').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { otSummaryState.basis = b.dataset.b; renderContent(); }));
  $('#ots-print').addEventListener('click', () => window.print());
}

/* ================= MANAGER APPROVALS ================= */
async function renderOvertimeApprovals(content) {
  setTitle('Overtime approvals', 'Manager sign-off for submitted overtime');
  const canDecide = isManager();
  const [pending, recent] = await Promise.all([
    OT.getEntries({ status: 'pending' }),
    (async () => {
      const { data, error } = await sb.from('overtime_entries')
        .select('*, overtime_staff(name, employee_no)')
        .in('status', ['approved', 'rejected'])
        .order('decided_at', { ascending: false })
        .limit(25);
      if (error) throw error;
      return data;
    })()
  ]);

  const pendHours = pending.reduce((s, e) => s + otHours(e.hours), 0);

  content.innerHTML = `
    ${!canDecide ? `<div class="card" style="margin-bottom:16px;"><p class="muted small" style="margin:0;">Only a <b>Manager</b> can approve or reject overtime. You can review the queue here; ask a manager to sign off.</p></div>` : ''}

    <div class="grid grid-3" style="margin-bottom:18px;">
      <div class="stat-card"><div class="stat-label">Awaiting approval</div><div class="stat-value" style="color:${pending.length ? 'var(--amber)' : 'var(--green)'}">${pending.length}</div></div>
      <div class="stat-card"><div class="stat-label">Hours awaiting approval</div><div class="stat-value">${otFmtH(pendHours)}</div></div>
      <div class="stat-card"><div class="stat-label">Decided recently</div><div class="stat-value">${recent.length}</div></div>
    </div>

    <div class="section-title"><h2>Pending queue</h2>${canDecide && pending.length ? '<div class="actions"><button class="btn btn-outline btn-sm" id="ot-approve-all">Approve all</button></div>' : ''}</div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Date</th><th>Employee</th><th>Pay month</th><th>Cover for</th><th>Shift</th><th class="num">Hours</th><th>Rate</th><th>Reason</th><th>Submitted by</th><th></th>
        </tr></thead>
        <tbody>
          ${pending.length ? pending.map(e => `
            <tr>
              <td>${esc(fmtDateShort(e.work_date))}</td>
              <td>${esc(otStaffName(e))}${e.overtime_staff?.employee_no ? ` <span class="small muted">${esc(e.overtime_staff.employee_no)}</span>` : ''}</td>
              <td class="small">${esc(e.pay_month || '')}</td>
              <td class="small">${esc(e.cover_for || '')}</td>
              <td class="small">${esc(e.shift || '')}</td>
              <td class="num">${otFmtH(e.hours)}</td>
              <td class="small">${esc(e.overtime_rate || '')}</td>
              <td class="small">${esc(e.reason || e.remarks || '')}</td>
              <td class="small muted">${esc(e.submitted_by_email || '')}</td>
              <td class="row-actions">
                ${canDecide ? `
                  <button class="btn btn-primary btn-sm" data-approve="${e.id}">Approve</button>
                  <button class="btn btn-outline btn-sm" data-reject="${e.id}" style="color:var(--red); border-color:#f3caca;">Reject</button>
                ` : '<span class="badge badge-amber">Pending</span>'}
              </td>
            </tr>`).join('') : `<tr><td colspan="10" class="empty-state">Nothing waiting for approval 🎉</td></tr>`}
        </tbody>
      </table>
    </div>

    <div class="section-title" style="margin-top:26px;"><h2>Recently decided</h2></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Decided</th><th>Employee</th><th>Date</th><th class="num">Hours</th><th>Pay month</th><th>Outcome</th><th>By</th><th>Note</th></tr></thead>
        <tbody>
          ${recent.length ? recent.map(e => `
            <tr>
              <td class="small muted">${esc(fmtDateTime(e.decided_at))}</td>
              <td>${esc(otStaffName(e))}</td>
              <td class="small">${esc(fmtDateShort(e.work_date))}</td>
              <td class="num">${otFmtH(e.hours)}</td>
              <td class="small">${esc(e.pay_month || '')}</td>
              <td><span class="badge ${OT_STATUS_BADGE[e.status]}">${OT_STATUS_LABEL[e.status]}</span></td>
              <td class="small muted">${esc(e.decided_by_email || '')}</td>
              <td class="small muted">${esc(e.decision_note || '')}</td>
            </tr>`).join('') : `<tr><td colspan="8" class="empty-state">No decisions yet.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;

  if (canDecide) {
    content.querySelectorAll('[data-approve]').forEach(el => el.addEventListener('click', async () => {
      const e = pending.find(x => x.id === el.dataset.approve);
      if (!confirm(`Approve ${otFmtH(e.hours)}h overtime for ${otStaffName(e)} on ${fmtDateShort(e.work_date)}?`)) return;
      try { await OT.decideEntry(e.id, { status: 'approved' }); toast('Overtime approved', 'ok'); renderContent(); }
      catch (err) { toast(err.message, 'err'); }
    }));
    content.querySelectorAll('[data-reject]').forEach(el => el.addEventListener('click', async () => {
      const e = pending.find(x => x.id === el.dataset.reject);
      const note = prompt(`Reject overtime for ${otStaffName(e)} (${fmtDateShort(e.work_date)}, ${otFmtH(e.hours)}h).\nReason:`);
      if (note === null) return;
      try { await OT.decideEntry(e.id, { status: 'rejected', note: note.trim() || 'Rejected' }); toast('Overtime rejected', 'ok'); renderContent(); }
      catch (err) { toast(err.message, 'err'); }
    }));
    const allBtn = $('#ot-approve-all');
    if (allBtn) allBtn.addEventListener('click', async () => {
      if (!confirm(`Approve all ${pending.length} pending entries (${otFmtH(pendHours)}h)?`)) return;
      try {
        for (const e of pending) await OT.decideEntry(e.id, { status: 'approved' });
        toast('All pending overtime approved', 'ok');
        renderContent();
      } catch (err) { toast(err.message, 'err'); }
    });
  }
}

/* ================= MANAGE: WAREHOUSE TEAM ================= */
async function renderOvertimeStaff(content) {
  setTitle('Warehouse Team', 'Employees used on the overtime sheet and summary');
  const staff = await OT.getStaff();
  content.innerHTML = `
    <div class="section-title">
      <h2>${staff.length} employees</h2>
      <div class="actions"><button class="btn btn-orange" id="add-ot-staff-btn">+ Add employee</button></div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Name</th><th>Employee no</th><th>Shift</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${staff.length ? staff.map(s => `
            <tr>
              <td>${esc(s.name)}</td>
              <td class="small muted">${esc(s.employee_no || '—')}</td>
              <td>${s.shift ? `<span class="badge badge-blue">Shift ${esc(s.shift)}</span>` : '<span class="muted small">—</span>'}</td>
              <td><span class="badge ${s.active !== false ? 'badge-green' : 'badge-gray'}">${s.active !== false ? 'Active' : 'Inactive'}</span></td>
              <td class="row-actions">
                <button class="btn btn-outline btn-sm" data-edit="${s.id}">Edit</button>
                <button class="btn btn-outline btn-sm" data-delete="${s.id}" style="color:var(--red); border-color:#f3caca;">Delete</button>
              </td>
            </tr>`).join('') : `<tr><td colspan="5" class="empty-state">No employees yet. Add your first one.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
  $('#add-ot-staff-btn').addEventListener('click', () => openOvertimeStaffModal(null, staff.length));
  content.querySelectorAll('[data-edit]').forEach(el => el.addEventListener('click', () => openOvertimeStaffModal(staff.find(s => s.id === el.dataset.edit), staff.length)));
  content.querySelectorAll('[data-delete]').forEach(el => el.addEventListener('click', async () => {
    const s = staff.find(x => x.id === el.dataset.delete);
    if (!confirm(`Delete "${s.name}"? Overtime entries already captured against them keep their history.`)) return;
    try { await OT.deleteStaff(s.id); toast('Employee deleted', 'ok'); renderContent(); }
    catch (err) { toast(err.message, 'err'); }
  }));
}

function openOvertimeStaffModal(s, count) {
  const isEdit = !!s;
  openModal(`
    <div class="modal-header"><h3>${isEdit ? 'Edit employee' : 'Add employee'}</h3><button class="modal-close" id="modal-close">&times;</button></div>
    <div class="modal-body">
      <form id="ot-staff-form">
        <div class="form-grid">
          <div class="field span-2"><label>Name *</label><input required id="f-name" value="${esc(s?.name || '')}" /></div>
          <div class="field"><label>Employee no</label><input id="f-no" value="${esc(s?.employee_no || '')}" placeholder="e.g. 00000307" /></div>
          <div class="field"><label>Shift</label>
            <select id="f-shift">
              <option value="">—</option>
              ${['A', 'B', 'C', 'D'].map(x => `<option value="${x}" ${s?.shift === x ? 'selected' : ''}>Shift ${x}</option>`).join('')}
            </select>
          </div>
          <div class="field"><label>Status</label>
            <select id="f-active">
              <option value="true" ${s?.active !== false ? 'selected' : ''}>Active</option>
              <option value="false" ${s?.active === false ? 'selected' : ''}>Inactive</option>
            </select>
          </div>
        </div>
      </form>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" id="modal-cancel">Cancel</button>
      <button class="btn btn-primary" id="modal-save">${isEdit ? 'Save changes' : 'Add employee'}</button>
    </div>
  `);
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-cancel').addEventListener('click', closeModal);
  $('#modal-save').addEventListener('click', async () => {
    const name = $('#f-name').value.trim();
    if (!name) { toast('Name is required', 'err'); return; }
    const payload = {
      name,
      employee_no: $('#f-no').value.trim() || null,
      shift: $('#f-shift').value || null,
      active: $('#f-active').value === 'true'
    };
    try {
      if (isEdit) await OT.updateStaff(s.id, payload);
      else await OT.createStaff({ ...payload, sort_order: count + 1 });
      closeModal();
      toast(isEdit ? 'Employee updated' : 'Employee added', 'ok');
      renderContent();
    } catch (err) { toast(err.message, 'err'); }
  });
}

/* ---- dashboard helper (called from dashboard.js) ---- */
async function otDashboardStats() {
  try {
    const payMonth = otCurrentPayMonth();
    const { data, error } = await sb.from('overtime_entries').select('staff_id, hours, status, pay_month');
    if (error) throw error;
    const pending = data.filter(e => e.status === 'pending');
    const thisMonth = data.filter(e => e.pay_month === payMonth && e.status !== 'rejected');
    const byStaff = {};
    thisMonth.filter(e => e.status === 'approved').forEach(e => { byStaff[e.staff_id] = (byStaff[e.staff_id] || 0) + otHours(e.hours); });
    const overLimit = Object.values(byStaff).filter(h => h > OT_MAX_HOURS).length;
    return {
      payMonth,
      pendingCount: pending.length,
      monthHours: thisMonth.reduce((s, e) => s + otHours(e.hours), 0),
      overLimit
    };
  } catch (err) {
    console.error('overtime dashboard stats failed', err);
    return null;
  }
}
