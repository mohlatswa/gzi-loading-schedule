/* GZI Loading Schedule — leave.js
   Leave Schedule: book/request leave, manager approval, auto cover-person overtime
   (pending), plus queued email — decision notice to the employee and 08:00 SAST
   reminders to the cover person on the two days before each covered working day.
   Companion to overtime.js (shares OT, pay-period helpers, OT_SHIFTS). */

const LEAVE_STATUS_LABEL = { pending: 'Pending approval', approved: 'Approved', rejected: 'Declined' };
const LEAVE_STATUS_BADGE = { pending: 'badge-amber', approved: 'badge-green', rejected: 'badge-red' };

/* ---------------- data layer ---------------- */
const LV = {
  async getTypes() {
    const { data, error } = await sb.from('leave_types').select('*').order('sort_order').order('name');
    if (error) throw error;
    return data;
  },
  async createType(payload) { const { error } = await sb.from('leave_types').insert(payload); if (error) throw error; },
  async updateType(id, payload) { const { error } = await sb.from('leave_types').update(payload).eq('id', id); if (error) throw error; },
  async deleteType(id) { const { error } = await sb.from('leave_types').delete().eq('id', id); if (error) throw error; },

  async getRequests() {
    const { data, error } = await sb.from('leave_requests').select('*')
      .order('start_date', { ascending: false }).order('created_at', { ascending: false });
    if (error) throw error;
    return data;
  },
  async createRequest(payload) { const { data, error } = await sb.from('leave_requests').insert(payload).select().single(); if (error) throw error; return data; },
  async updateRequest(id, payload) { const { error } = await sb.from('leave_requests').update(payload).eq('id', id); if (error) throw error; },
  async deleteRequest(id) { const { error } = await sb.from('leave_requests').delete().eq('id', id); if (error) throw error; }
};

async function lvQueueEmail(row) {
  const { error } = await sb.from('email_outbox').insert(row);
  if (error) throw error;
}

/* ---------------- date helpers (SAST = UTC+2, no DST) ---------------- */
function lvISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function lvAddDaysISO(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return lvISO(d);
}
/* Mon–Fri ISO dates in [startISO, endISO] inclusive. */
function lvWorkingDays(startISO, endISO) {
  const out = [];
  if (!startISO || !endISO) return out;
  const d = new Date(startISO + 'T00:00:00');
  const end = new Date(endISO + 'T00:00:00');
  if (isNaN(d) || isNaN(end) || d > end) return out;
  let guard = 0;
  while (d <= end && guard++ < 400) {
    const dow = d.getDay();
    if (dow >= 1 && dow <= 5) out.push(lvISO(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}
/* ISO timestamp for 08:00 SAST on the given calendar date. */
function lvSastSendAfterISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 6, 0, 0)).toISOString();
}
function lvCoverShiftFor(letter) {
  if (!letter) return '';
  const match = (typeof OT_SHIFTS !== 'undefined' ? OT_SHIFTS : []).find(s => s.startsWith(letter + ' '));
  return match || '';
}

/* ---------------- email bodies ---------------- */
function lvEmailShell(heading, lines) {
  const body = lines.map(l => `<p style="margin:0 0 10px;">${l}</p>`).join('');
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#16233f;">
    <h2 style="margin:0 0 14px;font-size:17px;">${heading}</h2>
    ${body}
    <p style="margin:18px 0 0;font-size:12px;color:#888;">GZI Loading Schedule — Technical Stores. This is an automated message.</p>
  </div>`;
}
function lvTextFrom(lines) { return lines.map(l => l.replace(/<[^>]+>/g, '')).join('\n'); }

/* ================= LEAVE SCHEDULE ================= */
let leaveState = { status: 'all', typeId: '', staffId: '' };

async function renderLeaveSchedule(content) {
  setTitle('Leave schedule', 'Book leave for a warehouse employee, then submit for manager approval');
  const [staff, types, requests] = await Promise.all([OT.getStaff(), LV.getTypes(), LV.getRequests()]);
  const staffById = Object.fromEntries(staff.map(s => [s.id, s]));
  const typeById = Object.fromEntries(types.map(t => [t.id, t]));

  let rows = requests;
  if (leaveState.status !== 'all') rows = rows.filter(r => r.status === leaveState.status);
  if (leaveState.typeId) rows = rows.filter(r => r.leave_type_id === leaveState.typeId);
  if (leaveState.staffId) rows = rows.filter(r => r.staff_id === leaveState.staffId);

  const pendingCount = requests.filter(r => r.status === 'pending').length;
  const today = todayISO();
  const onLeaveNow = requests.filter(r => r.status === 'approved' && r.start_date <= today && r.end_date >= today).length;

  content.innerHTML = `
    <div class="filter-bar">
      <div class="field"><label>Leave type</label>
        <select id="lv-f-type">
          <option value="">All types</option>
          ${types.map(t => `<option value="${t.id}" ${leaveState.typeId === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Employee</label>
        <select id="lv-f-staff">
          <option value="">All employees</option>
          ${staff.map(s => `<option value="${s.id}" ${leaveState.staffId === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
        </select>
      </div>
      <div class="tab-group" id="lv-f-status">
        ${['all', 'pending', 'approved', 'rejected'].map(k => `<button type="button" data-s="${k}" class="${leaveState.status === k ? 'active' : ''}">${k === 'all' ? 'All' : LEAVE_STATUS_LABEL[k]}</button>`).join('')}
      </div>
      <div style="margin-left:auto; align-self:center;">
        <button class="btn btn-orange btn-sm" id="lv-add-btn">+ Request leave</button>
      </div>
    </div>

    <div class="grid grid-3" style="margin-bottom:18px;">
      <div class="stat-card"><div class="stat-label">Requests shown</div><div class="stat-value">${rows.length}</div></div>
      <div class="stat-card"><div class="stat-label">Pending approval</div><div class="stat-value" style="color:${pendingCount ? 'var(--amber)' : 'var(--green)'}">${pendingCount}</div><div class="stat-sub"><span class="link-btn" data-goto="leave-approvals">go to approvals</span></div></div>
      <div class="stat-card"><div class="stat-label">On approved leave today</div><div class="stat-value">${onLeaveNow}</div></div>
    </div>

    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Employee</th><th>Leave type</th><th>From</th><th>To</th><th class="num">Working days</th>
          <th>Cover person</th><th>Status</th><th></th>
        </tr></thead>
        <tbody>
          ${rows.length ? rows.map(r => {
            const editable = r.status === 'pending' || r.status === 'rejected';
            return `<tr>
              <td>${esc(staffById[r.staff_id]?.name || '—')}</td>
              <td class="small">${esc(typeById[r.leave_type_id]?.name || '—')}</td>
              <td class="small">${esc(fmtDateShort(r.start_date))}</td>
              <td class="small">${esc(fmtDateShort(r.end_date))}</td>
              <td class="num">${r.days ?? lvWorkingDays(r.start_date, r.end_date).length}</td>
              <td class="small">${esc(r.cover_staff_id ? (staffById[r.cover_staff_id]?.name || '—') : '—')}${r.cover_shift ? ` <span class="muted">(${esc(r.cover_shift)})</span>` : ''}</td>
              <td>
                <span class="badge ${LEAVE_STATUS_BADGE[r.status] || 'badge-gray'}">${LEAVE_STATUS_LABEL[r.status] || r.status}</span>
                ${r.status === 'rejected' && r.decision_note ? `<div class="small muted">${esc(r.decision_note)}</div>` : ''}
                ${r.status === 'approved' && r.overtime_generated ? `<div class="small muted">cover overtime created (pending)</div>` : ''}
              </td>
              <td class="row-actions">
                <button class="btn btn-outline btn-sm" data-edit="${r.id}" ${editable ? '' : 'disabled'}>${editable ? 'Edit' : 'Locked'}</button>
                <button class="btn btn-outline btn-sm" data-del="${r.id}" style="color:var(--red); border-color:#f3caca;" ${editable ? '' : 'disabled'}>Del</button>
              </td>
            </tr>`;
          }).join('') : `<tr><td colspan="8" class="empty-state">No leave requests. Click "Request leave" to add one.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;

  $('#lv-f-type').addEventListener('change', e => { leaveState.typeId = e.target.value; renderContent(); });
  $('#lv-f-staff').addEventListener('change', e => { leaveState.staffId = e.target.value; renderContent(); });
  $('#lv-f-status').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { leaveState.status = b.dataset.s; renderContent(); }));
  $('#lv-add-btn').addEventListener('click', () => openLeaveModal(staff, types, null));
  content.querySelectorAll('[data-goto]').forEach(el => el.addEventListener('click', () => { location.hash = '#/' + el.dataset.goto; }));
  content.querySelectorAll('[data-edit]:not([disabled])').forEach(el => el.addEventListener('click', () => {
    openLeaveModal(staff, types, requests.find(x => x.id === el.dataset.edit));
  }));
  content.querySelectorAll('[data-del]:not([disabled])').forEach(el => el.addEventListener('click', async () => {
    const r = requests.find(x => x.id === el.dataset.del);
    if (!confirm(`Delete this leave request for ${staffById[r.staff_id]?.name || 'employee'} (${fmtDateShort(r.start_date)}–${fmtDateShort(r.end_date)})?`)) return;
    try { await LV.deleteRequest(r.id); toast('Leave request deleted', 'ok'); renderContent(); }
    catch (err) { toast(err.message, 'err'); }
  }));
}

function openLeaveModal(staff, types, req) {
  const isEdit = !!req;
  const activeStaff = staff.filter(s => s.active !== false);
  const staffOpts = (staff.length ? staff : activeStaff);
  const activeTypes = types.filter(t => t.active !== false);
  const typeOpts = (activeTypes.length ? activeTypes : types);

  openModal(`
    <div class="modal-header"><h3>${isEdit ? 'Edit leave request' : 'Request leave'}</h3><button class="modal-close" id="modal-close">&times;</button></div>
    <div class="modal-body">
      <form id="lv-form">
        <div class="form-grid">
          <div class="field span-2"><label>Employee (person taking leave) *</label>
            <select id="lv-staff" required>
              <option value="">— Select employee —</option>
              ${staffOpts.map(s => `<option value="${s.id}" data-email="${esc(s.email || '')}" ${req?.staff_id === s.id ? 'selected' : ''}>${esc(s.name)}${s.employee_no ? ' · ' + esc(s.employee_no) : ''}</option>`).join('')}
            </select>
          </div>
          <div class="field span-2"><label>Leave type *</label>
            <select id="lv-type" required>
              <option value="">— Select leave type —</option>
              ${typeOpts.map(t => `<option value="${t.id}" ${req?.leave_type_id === t.id ? 'selected' : ''}>${esc(t.name)}${t.paid === false ? ' (unpaid)' : ''}</option>`).join('')}
            </select>
          </div>
          <div class="field"><label>From *</label><input type="date" id="lv-start" required value="${esc(req?.start_date || '')}" /></div>
          <div class="field"><label>To *</label><input type="date" id="lv-end" required value="${esc(req?.end_date || '')}" /></div>
          <div class="field"><label>Working days</label><input id="lv-days" readonly value="${req?.days ?? ''}" placeholder="auto (Mon–Fri)" /></div>
          <div class="field"><label>Cover person *</label>
            <select id="lv-cover" required>
              <option value="">— Select cover person —</option>
              ${staffOpts.map(s => `<option value="${s.id}" data-shift="${esc(s.shift || '')}" data-email="${esc(s.email || '')}" ${req?.cover_staff_id === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
            </select>
          </div>
          <div class="field"><label>Cover shift</label>
            <select id="lv-cover-shift">
              <option value="">—</option>
              ${(typeof OT_SHIFTS !== 'undefined' ? OT_SHIFTS : []).map(s => `<option value="${esc(s)}" ${req?.cover_shift === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
            </select>
          </div>
          <div class="field span-2"><label>Reason / notes</label><textarea id="lv-reason" rows="2">${esc(req?.reason || '')}</textarea></div>
        </div>
        <p class="muted small" id="lv-email-warn" style="margin:10px 2px 0; color:var(--amber); display:none;"></p>
        <p class="muted small" style="margin:10px 2px 0;">On save the request is submitted with status <b>Pending approval</b>. A manager signs it off on the Leave approvals page; approval then creates the cover person's overtime (pending) and schedules their reminders.</p>
      </form>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" id="modal-cancel">Cancel</button>
      <button class="btn btn-primary" id="modal-save">${isEdit ? 'Save & resubmit' : 'Submit for approval'}</button>
    </div>
  `);
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-cancel').addEventListener('click', closeModal);

  const staffEl = $('#lv-staff'), startEl = $('#lv-start'), endEl = $('#lv-end'), daysEl = $('#lv-days');
  const coverEl = $('#lv-cover'), coverShiftEl = $('#lv-cover-shift'), warnEl = $('#lv-email-warn');

  function recalcDays() {
    if (startEl.value && !endEl.value) endEl.value = startEl.value;
    if (startEl.value && endEl.value && endEl.value < startEl.value) endEl.value = startEl.value;
    daysEl.value = (startEl.value && endEl.value) ? lvWorkingDays(startEl.value, endEl.value).length : '';
  }
  function refreshWarn() {
    const missing = [];
    const so = staffEl.selectedOptions[0];
    if (so && so.value && !so.dataset.email) missing.push('the employee');
    const co = coverEl.selectedOptions[0];
    if (co && co.value && !co.dataset.email) missing.push('the cover person');
    if (missing.length) {
      warnEl.textContent = `No email on file for ${missing.join(' and ')}. Add it on Manage → Warehouse Team so notices/reminders can be sent.`;
      warnEl.style.display = '';
    } else {
      warnEl.style.display = 'none';
    }
  }
  startEl.addEventListener('change', recalcDays);
  endEl.addEventListener('change', recalcDays);
  staffEl.addEventListener('change', refreshWarn);
  coverEl.addEventListener('change', () => {
    const opt = coverEl.selectedOptions[0];
    if (opt && opt.dataset.shift && !coverShiftEl.value) {
      const m = lvCoverShiftFor(opt.dataset.shift);
      if (m) coverShiftEl.value = m;
    }
    refreshWarn();
  });
  if (!isEdit) recalcDays();
  refreshWarn();

  $('#modal-save').addEventListener('click', async () => {
    const staffId = staffEl.value;
    const typeId = $('#lv-type').value;
    const start = startEl.value, end = endEl.value;
    if (!staffId) { toast('Select the employee', 'err'); return; }
    if (!typeId) { toast('Select the leave type', 'err'); return; }
    if (!coverEl.value) { toast('Select the cover person', 'err'); return; }
    if (!start || !end) { toast('Pick the leave dates', 'err'); return; }
    if (end < start) { toast('End date is before the start date', 'err'); return; }
    const workingDays = lvWorkingDays(start, end).length;
    if (workingDays === 0) { toast('That range has no working days (Mon–Fri)', 'err'); return; }

    const stamp = currentUserStamp();
    const payload = {
      staff_id: staffId,
      leave_type_id: typeId,
      start_date: start,
      end_date: end,
      days: workingDays,
      cover_staff_id: coverEl.value || null,
      cover_shift: coverShiftEl.value || null,
      reason: $('#lv-reason').value.trim() || null,
      status: 'pending',
      overtime_generated: false,
      decided_by: null, decided_by_email: null, decided_at: null, decision_note: null,
      employee_notified_at: null,
      updated_at: new Date().toISOString()
    };
    if (!isEdit) { payload.submitted_by = stamp.by; payload.submitted_by_email = stamp.email; }

    const btn = $('#modal-save');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    try {
      if (isEdit) await LV.updateRequest(req.id, payload);
      else await LV.createRequest(payload);
      closeModal();
      toast('Leave request submitted for approval', 'ok');
      renderContent();
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false; btn.textContent = isEdit ? 'Save & resubmit' : 'Submit for approval';
    }
  });
}

/* ================= LEAVE APPROVALS ================= */
async function renderLeaveApprovals(content) {
  setTitle('Leave approvals', 'Manager sign-off for leave requests');
  const canDecide = isManager();
  const [staff, types, requests] = await Promise.all([OT.getStaff(), LV.getTypes(), LV.getRequests()]);
  const staffById = Object.fromEntries(staff.map(s => [s.id, s]));
  const typeById = Object.fromEntries(types.map(t => [t.id, t]));

  const pending = requests.filter(r => r.status === 'pending');
  const pendDays = pending.reduce((s, r) => s + (r.days ?? lvWorkingDays(r.start_date, r.end_date).length), 0);
  const today = todayISO();
  const onLeaveNow = new Set(requests.filter(r => r.status === 'approved' && r.start_date <= today && r.end_date >= today).map(r => r.staff_id)).size;

  content.innerHTML = `
    ${!canDecide ? `<div class="card" style="margin-bottom:16px;"><p class="muted small" style="margin:0;">Only a <b>Manager</b> can approve or decline leave. You can review the queue here; ask a manager to sign off.</p></div>` : ''}

    <div class="grid grid-3" style="margin-bottom:18px;">
      <div class="stat-card"><div class="stat-label">Awaiting approval</div><div class="stat-value" style="color:${pending.length ? 'var(--amber)' : 'var(--green)'}">${pending.length}</div></div>
      <div class="stat-card"><div class="stat-label">Working days awaiting</div><div class="stat-value">${pendDays}</div></div>
      <div class="stat-card"><div class="stat-label">Employees on leave today</div><div class="stat-value">${onLeaveNow}</div></div>
    </div>

    <div class="section-title"><h2>Pending queue</h2></div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Employee</th><th>Leave type</th><th>From</th><th>To</th><th class="num">Working days</th>
          <th>Cover person</th><th>Reason</th><th>Submitted by</th><th></th>
        </tr></thead>
        <tbody>
          ${pending.length ? pending.map(r => {
            const cover = r.cover_staff_id ? staffById[r.cover_staff_id] : null;
            return `<tr>
              <td>${esc(staffById[r.staff_id]?.name || '—')}</td>
              <td class="small">${esc(typeById[r.leave_type_id]?.name || '—')}</td>
              <td class="small">${esc(fmtDateShort(r.start_date))}</td>
              <td class="small">${esc(fmtDateShort(r.end_date))}</td>
              <td class="num">${r.days ?? lvWorkingDays(r.start_date, r.end_date).length}</td>
              <td class="small">${cover ? esc(cover.name) : '<span class="muted">none</span>'}${r.cover_shift ? ` <span class="muted">(${esc(r.cover_shift)})</span>` : ''}${cover && !cover.email ? ' <span class="badge badge-amber">no email</span>' : ''}</td>
              <td class="small">${esc(r.reason || '')}</td>
              <td class="small muted">${esc(r.submitted_by_email || '')}</td>
              <td class="row-actions">
                ${canDecide ? `
                  <button class="btn btn-primary btn-sm" data-approve="${r.id}">Approve</button>
                  <button class="btn btn-outline btn-sm" data-reject="${r.id}" style="color:var(--red); border-color:#f3caca;">Decline</button>
                ` : '<span class="badge badge-amber">Pending</span>'}
              </td>
            </tr>`;
          }).join('') : `<tr><td colspan="9" class="empty-state">Nothing waiting for approval 🎉</td></tr>`}
        </tbody>
      </table>
    </div>
    <p class="muted small" style="margin-top:10px;">Approving a request creates one <b>pending</b> overtime entry per working day for the cover person (they still need overtime sign-off on the Overtime approvals page), emails the employee, and schedules a reminder to the cover person at 08:00 on each of the two days before every covered working day.</p>
  `;

  if (!canDecide) return;

  content.querySelectorAll('[data-approve]').forEach(el => el.addEventListener('click', () => {
    decideLeave(requests.find(x => x.id === el.dataset.approve), staffById, typeById, 'approved');
  }));
  content.querySelectorAll('[data-reject]').forEach(el => el.addEventListener('click', () => {
    const r = requests.find(x => x.id === el.dataset.reject);
    const note = prompt(`Decline leave for ${staffById[r.staff_id]?.name || 'employee'} (${fmtDateShort(r.start_date)}–${fmtDateShort(r.end_date)}).\nReason:`);
    if (note === null) return;
    decideLeave(r, staffById, typeById, 'rejected', note.trim() || 'Declined');
  }));
}

async function decideLeave(req, staffById, typeById, status, note) {
  if (!req) return;
  const employee = staffById[req.staff_id];
  const cover = req.cover_staff_id ? staffById[req.cover_staff_id] : null;
  const typeName = typeById[req.leave_type_id]?.name || 'Leave';
  const span = `${fmtDate(req.start_date)} – ${fmtDate(req.end_date)}`;
  const stamp = currentUserStamp();

  if (status === 'approved' && !confirm(
    `Approve ${typeName} leave for ${employee?.name || 'employee'} (${span})?` +
    (cover ? `\n\nThis creates ${lvWorkingDays(req.start_date, req.end_date).length} pending overtime entr${lvWorkingDays(req.start_date, req.end_date).length === 1 ? 'y' : 'ies'} for ${cover.name} and schedules their reminders.` : '\n\nNo cover person is set — no overtime will be created.')
  )) return;

  try {
    // 1. decide the request
    await LV.updateRequest(req.id, {
      status,
      decision_note: note || null,
      decided_by: stamp.by, decided_by_email: stamp.email, decided_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });

    const workDays = lvWorkingDays(req.start_date, req.end_date);

    if (status === 'approved') {
      // 2. cover person -> pending overtime, one row per working day
      if (cover && !req.overtime_generated) {
        for (const d of workDays) {
          const period = (typeof otPeriodForDate === 'function' ? otPeriodForDate(d) : '');
          await OT.createEntry({
            staff_id: cover.id,
            work_date: d,
            month: (typeof otMonth3 === 'function' ? otMonth3(d) : ''),
            overtime_period: period || null,
            pay_month: (typeof otPayMonthForPeriod === 'function' ? otPayMonthForPeriod(period) : '') || null,
            cover_for: employee?.name || null,
            cover_by: cover.name,
            shift: req.cover_shift || null,
            hours: 0,
            overtime_rate: null,
            remarks: req.cover_shift ? `Cover ${req.cover_shift}` : 'Leave cover',
            reason: 'Leave',
            status: 'pending',
            source_leave_id: req.id,
            submitted_by: stamp.by, submitted_by_email: stamp.email,
            decided_by: null, decided_by_email: null, decided_at: null, decision_note: null,
            updated_at: new Date().toISOString()
          });
        }
        await LV.updateRequest(req.id, { overtime_generated: true, updated_at: new Date().toISOString() });
      }

      // 3. decision email to the employee
      if (employee?.email) {
        const lines = [
          `Hi ${esc(employee.name)},`,
          `Your <b>${esc(typeName)}</b> leave request for <b>${esc(span)}</b> (${workDays.length} working day${workDays.length === 1 ? '' : 's'}) has been <b>approved</b>.`,
          cover ? `Cover has been arranged with <b>${esc(cover.name)}</b>${req.cover_shift ? ` on ${esc(req.cover_shift)}` : ''}.` : `No cover person was recorded for this leave.`,
          req.decision_note ? `Note: ${esc(req.decision_note)}` : ''
        ].filter(Boolean);
        await lvQueueEmail({
          to_email: employee.email, to_name: employee.name,
          subject: `Leave approved: ${typeName} ${req.start_date} to ${req.end_date}`,
          body_html: lvEmailShell('Leave approved', lines), body_text: lvTextFrom(lines),
          kind: 'leave_decision', related_leave_id: req.id, send_after: new Date().toISOString()
        });
        await LV.updateRequest(req.id, { employee_notified_at: new Date().toISOString() });
      }

      // 4. cover-person reminders: 08:00 SAST on each of the two days before each covered day
      if (cover?.email && !req.overtime_generated) {
        const now = Date.now();
        for (const d of workDays) {
          const rlines = (rday) => ([
            `Hi ${esc(cover.name)},`,
            `Reminder: you are covering for <b>${esc(employee?.name || 'a colleague')}</b> on <b>${esc(fmtDate(d))}</b>${req.cover_shift ? ` (${esc(req.cover_shift)})` : ''}.`,
            rday ? `` : `This working day is within the next two days.`,
            `Please confirm your overtime hours on the Overtime sheet.`
          ].filter(Boolean));
          let queuedAny = false;
          for (const off of [2, 1]) {
            const rday = lvAddDaysISO(d, -off);
            const sendAfter = lvSastSendAfterISO(rday);
            if (new Date(sendAfter).getTime() > now) {
              const ls = rlines(rday);
              await lvQueueEmail({
                to_email: cover.email, to_name: cover.name,
                subject: `Reminder: covering ${employee?.name || 'a colleague'} on ${d}`,
                body_html: lvEmailShell('Cover reminder', ls), body_text: lvTextFrom(ls),
                kind: 'cover_reminder', related_leave_id: req.id, send_after: sendAfter
              });
              queuedAny = true;
            }
          }
          if (!queuedAny) {
            const ls = rlines(null);
            await lvQueueEmail({
              to_email: cover.email, to_name: cover.name,
              subject: `Reminder: covering ${employee?.name || 'a colleague'} on ${d}`,
              body_html: lvEmailShell('Cover reminder', ls), body_text: lvTextFrom(ls),
              kind: 'cover_reminder', related_leave_id: req.id, send_after: new Date().toISOString()
            });
          }
        }
      }

      toast(cover ? 'Leave approved — cover overtime created (pending)' : 'Leave approved', 'ok');
    } else {
      // rejected: undo any generated pending cover overtime
      if (req.overtime_generated) {
        await sb.from('overtime_entries').delete().eq('source_leave_id', req.id).eq('status', 'pending');
        await LV.updateRequest(req.id, { overtime_generated: false, updated_at: new Date().toISOString() });
      }
      if (employee?.email) {
        const lines = [
          `Hi ${esc(employee.name)},`,
          `Your <b>${esc(typeName)}</b> leave request for <b>${esc(span)}</b> has been <b>declined</b>.`,
          note ? `Reason: ${esc(note)}` : '',
          `Please speak to your manager if you have questions.`
        ].filter(Boolean);
        await lvQueueEmail({
          to_email: employee.email, to_name: employee.name,
          subject: `Leave declined: ${typeName} ${req.start_date} to ${req.end_date}`,
          body_html: lvEmailShell('Leave declined', lines), body_text: lvTextFrom(lines),
          kind: 'leave_decision', related_leave_id: req.id, send_after: new Date().toISOString()
        });
        await LV.updateRequest(req.id, { employee_notified_at: new Date().toISOString() });
      }
      toast('Leave declined', 'ok');
    }

    if (!employee?.email) toast('Saved, but no email on file for the employee — no notice sent', 'err');
    renderContent();
  } catch (err) {
    console.error(err);
    toast(err.message || 'Could not complete the decision', 'err');
  }
}

/* ================= MANAGE: LEAVE TYPES ================= */
async function renderLeaveTypes(content) {
  setTitle('Leave types', 'The list employees pick from when booking leave');
  const types = await LV.getTypes();
  content.innerHTML = `
    <div class="section-title">
      <h2>${types.length} leave type${types.length === 1 ? '' : 's'}</h2>
      <div class="actions"><button class="btn btn-orange" id="add-lt-btn">+ Add leave type</button></div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Name</th><th>Code</th><th>Paid</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${types.length ? types.map(t => `
            <tr>
              <td>${esc(t.name)}</td>
              <td class="small muted">${esc(t.code || '—')}</td>
              <td>${t.paid === false ? '<span class="badge badge-gray">Unpaid</span>' : '<span class="badge badge-green">Paid</span>'}</td>
              <td><span class="badge ${t.active !== false ? 'badge-green' : 'badge-gray'}">${t.active !== false ? 'Active' : 'Inactive'}</span></td>
              <td class="row-actions">
                <button class="btn btn-outline btn-sm" data-edit="${t.id}">Edit</button>
                <button class="btn btn-outline btn-sm" data-delete="${t.id}" style="color:var(--red); border-color:#f3caca;">Delete</button>
              </td>
            </tr>`).join('') : `<tr><td colspan="5" class="empty-state">No leave types yet. Add your first one.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
  $('#add-lt-btn').addEventListener('click', () => openLeaveTypeModal(null, types.length));
  content.querySelectorAll('[data-edit]').forEach(el => el.addEventListener('click', () => openLeaveTypeModal(types.find(x => x.id === el.dataset.edit), types.length)));
  content.querySelectorAll('[data-delete]').forEach(el => el.addEventListener('click', async () => {
    const t = types.find(x => x.id === el.dataset.delete);
    if (!confirm(`Delete "${t.name}"? Existing leave requests keep their history.`)) return;
    try { await LV.deleteType(t.id); toast('Leave type deleted', 'ok'); renderContent(); }
    catch (err) { toast(err.message, 'err'); }
  }));
}

function openLeaveTypeModal(t, count) {
  const isEdit = !!t;
  openModal(`
    <div class="modal-header"><h3>${isEdit ? 'Edit leave type' : 'Add leave type'}</h3><button class="modal-close" id="modal-close">&times;</button></div>
    <div class="modal-body">
      <form id="lt-form">
        <div class="form-grid">
          <div class="field span-2"><label>Name *</label><input required id="f-name" value="${esc(t?.name || '')}" /></div>
          <div class="field"><label>Code</label><input id="f-code" value="${esc(t?.code || '')}" placeholder="e.g. ANN" /></div>
          <div class="field"><label>Paid</label>
            <select id="f-paid">
              <option value="true" ${t?.paid !== false ? 'selected' : ''}>Paid</option>
              <option value="false" ${t?.paid === false ? 'selected' : ''}>Unpaid</option>
            </select>
          </div>
          <div class="field"><label>Status</label>
            <select id="f-active">
              <option value="true" ${t?.active !== false ? 'selected' : ''}>Active</option>
              <option value="false" ${t?.active === false ? 'selected' : ''}>Inactive</option>
            </select>
          </div>
        </div>
      </form>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" id="modal-cancel">Cancel</button>
      <button class="btn btn-primary" id="modal-save">${isEdit ? 'Save changes' : 'Add leave type'}</button>
    </div>
  `);
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-cancel').addEventListener('click', closeModal);
  $('#modal-save').addEventListener('click', async () => {
    const name = $('#f-name').value.trim();
    if (!name) { toast('Name is required', 'err'); return; }
    const payload = {
      name,
      code: $('#f-code').value.trim() || null,
      paid: $('#f-paid').value === 'true',
      active: $('#f-active').value === 'true'
    };
    try {
      if (isEdit) await LV.updateType(t.id, payload);
      else await LV.createType({ ...payload, sort_order: count + 1 });
      closeModal();
      toast(isEdit ? 'Leave type updated' : 'Leave type added', 'ok');
      renderContent();
    } catch (err) { toast(err.message, 'err'); }
  });
}
