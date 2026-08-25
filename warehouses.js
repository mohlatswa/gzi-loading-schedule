/* GZI Loading Schedule — warehouses.js (Manage > Warehouses + warehouse detail page) */

async function renderWarehouses(content) {
  setTitle('Warehouses', 'External warehouses — factory-to-warehouse loads and warehouse-to-customer dispatches');
  const loads = await DB.getLoads({ destinationType: 'warehouse' });
  const receivedCounts = {};
  loads.forEach(l => { receivedCounts[l.warehouse_id] = (receivedCounts[l.warehouse_id] || 0) + 1; });

  content.innerHTML = `
    <div class="section-title">
      <h2>${State.warehouses.length} warehouses</h2>
      <div class="actions"><button class="btn btn-orange" id="add-warehouse-btn">+ Add warehouse</button></div>
    </div>
    <div class="grid grid-3" id="warehouse-grid"></div>
  `;
  const grid = $('#warehouse-grid');
  grid.innerHTML = State.warehouses.map(w => `
    <div class="customer-card" data-open="${w.id}">
      <div class="cname">🏭 ${esc(w.name)}</div>
      <div class="cmeta">${esc(w.code || '')}</div>
      <div class="cstats"><span><b>${receivedCounts[w.id] || 0}</b> loads received</span><span class="badge ${w.active ? 'badge-green' : 'badge-gray'}">${w.active ? 'Active' : 'Inactive'}</span></div>
      <div class="card-actions">
        <button class="btn btn-outline btn-sm" data-edit="${w.id}">Edit</button>
        <button class="btn btn-outline btn-sm" data-delete="${w.id}" style="color:var(--red); border-color:#f3caca;">Delete</button>
      </div>
    </div>
  `).join('') || `<div class="empty-state">No warehouses yet. Add your first one.</div>`;

  grid.querySelectorAll('[data-open]').forEach(el => el.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    location.hash = '#/warehouse/' + el.dataset.open;
  }));
  grid.querySelectorAll('[data-edit]').forEach(el => el.addEventListener('click', (e) => {
    e.stopPropagation();
    openWarehouseModal(State.warehouses.find(w => w.id === el.dataset.edit));
  }));
  grid.querySelectorAll('[data-delete]').forEach(el => el.addEventListener('click', async (e) => {
    e.stopPropagation();
    const w = State.warehouses.find(w => w.id === el.dataset.delete);
    if (!confirm(`Delete warehouse "${w.name}"? Loads pointing to it will keep their history but lose the link.`)) return;
    try { await DB.deleteWarehouse(w.id); toast('Warehouse deleted', 'ok'); State.warehouses = await DB.getWarehouses(); renderContent(); }
    catch (err) { toast(err.message, 'err'); }
  }));
  $('#add-warehouse-btn').addEventListener('click', () => openWarehouseModal(null));
}

function openWarehouseModal(warehouse) {
  const isEdit = !!warehouse;
  openModal(`
    <div class="modal-header"><h3>${isEdit ? 'Edit warehouse' : 'Add warehouse'}</h3><button class="modal-close" id="modal-close">&times;</button></div>
    <div class="modal-body">
      <form id="warehouse-form">
        <div class="form-grid">
          <div class="field span-2"><label>Warehouse name *</label><input required id="f-name" value="${esc(warehouse?.name || '')}" /></div>
          <div class="field"><label>Code</label><input id="f-code" value="${esc(warehouse?.code || '')}" placeholder="e.g. jhb-ext" /></div>
          <div class="field"><label>Status</label>
            <select id="f-active">
              <option value="true" ${warehouse?.active !== false ? 'selected' : ''}>Active</option>
              <option value="false" ${warehouse?.active === false ? 'selected' : ''}>Inactive</option>
            </select>
          </div>
        </div>
      </form>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" id="modal-cancel">Cancel</button>
      <button class="btn btn-primary" id="modal-save">${isEdit ? 'Save changes' : 'Add warehouse'}</button>
    </div>
  `);
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-cancel').addEventListener('click', closeModal);
  $('#modal-save').addEventListener('click', async () => {
    const name = $('#f-name').value.trim();
    if (!name) { toast('Warehouse name is required', 'err'); return; }
    const payload = { name, code: $('#f-code').value.trim() || null, active: $('#f-active').value === 'true' };
    try {
      if (isEdit) await DB.updateWarehouse(warehouse.id, payload);
      else await DB.createWarehouse({ ...payload, sort_order: State.warehouses.length });
      closeModal();
      toast(isEdit ? 'Warehouse updated' : 'Warehouse added', 'ok');
      State.warehouses = await DB.getWarehouses();
      renderContent();
    } catch (err) { toast(err.message, 'err'); }
  });
}

/* ================= WAREHOUSE DETAIL PAGE ================= */
async function renderWarehousePage(content, warehouseId) {
  const warehouse = State.warehouses.find(w => w.id === warehouseId);
  if (!warehouse) { content.innerHTML = `<div class="card">Warehouse not found. <a href="#/warehouses">Back to warehouses</a></div>`; return; }
  setTitle('🏭 ' + warehouse.name, 'Received from factory and dispatched to customers');

  const [received, dispatches] = await Promise.all([
    DB.getLoads({ warehouseId }),
    DB.getWarehouseDispatches({ warehouseId })
  ]);
  const totalReceived = received.reduce((s, l) => s + num(l.actual_pallets), 0);
  const totalDispatched = dispatches.reduce((s, d) => s + num(d.actual_pallets), 0);

  content.innerHTML = `
    <div class="card" style="margin-bottom:18px;">
      <div class="section-title" style="margin-bottom:0;">
        <h2>🏭 ${esc(warehouse.name)}</h2>
        <div class="actions">
          <button class="btn btn-outline btn-sm" id="edit-warehouse-btn">Edit warehouse</button>
          <button class="btn btn-orange btn-sm" id="add-received-btn">+ Load to warehouse</button>
          <button class="btn btn-orange btn-sm" id="add-dispatch-btn">+ Dispatch to customer</button>
        </div>
      </div>
    </div>

    <div class="grid grid-4" style="margin-bottom:18px;">
      <div class="stat-card"><div class="stat-label">Total sent to warehouse</div><div class="stat-value">${totalReceived}</div></div>
      <div class="stat-card"><div class="stat-label">Total shipped to customers</div><div class="stat-value">${totalDispatched}</div></div>
      <div class="stat-card"><div class="stat-label">Held at warehouse</div><div class="stat-value">${totalReceived - totalDispatched}</div></div>
      <div class="stat-card"><div class="stat-label">Loads / dispatches</div><div class="stat-value">${received.length} / ${dispatches.length}</div></div>
    </div>

    <div class="section-title"><h2>Received from factory</h2></div>
    <div class="table-wrap" style="margin-bottom:24px;">
      <table>
        <thead><tr><th>Wk</th><th>Date</th><th>Transporter</th><th>PO / DN</th><th class="num">Planned</th><th class="num">Actual</th><th class="num">Cans (M)</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${received.length ? received.map(l => `
            <tr>
              <td class="small muted">${esc(fmtWeek(l.loading_date))}</td>
              <td>${esc(fmtDateShort(l.loading_date))}</td>
              <td>${esc(l.transporter || '')}</td>
              <td class="small muted">${esc(l.gzi_dn || l.gzi_po_number || '')}</td>
              <td class="num">${nOrDash(l.planned_pallets)}</td>
              <td class="num">${nOrDash(l.actual_pallets)}</td>
              <td class="num">${fmtCans(l.actual_cans_m ?? l.planned_cans_m)}</td>
              <td><span class="badge ${STATUS_BADGE[l.status] || 'badge-gray'}">${STATUS_LABELS[l.status] || l.status}</span></td>
              <td><button class="btn btn-outline btn-sm" data-edit-load="${l.id}">Edit</button></td>
            </tr>`).join('') : `<tr><td colspan="9" class="empty-state">No loads received yet.</td></tr>`}
        </tbody>
        ${received.length ? `<tfoot><tr><td colspan="4">Totals</td><td class="num">${received.reduce((s, l) => s + num(l.planned_pallets), 0)}</td><td class="num">${totalReceived}</td><td colspan="3"></td></tr></tfoot>` : ''}
      </table>
    </div>

    <div class="section-title"><h2>Dispatched to customers</h2></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Date</th><th>Customer</th><th>Transporter</th><th class="num">Planned</th><th class="num">Actual</th><th class="num">Cans (M)</th><th>Shift / Sup.</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${dispatches.length ? dispatches.map(d => `
            <tr>
              <td>${esc(fmtDateShort(d.dispatch_date))}</td>
              <td>${esc(d.customers?.name || '')}</td>
              <td>${esc(d.transporter || '')}</td>
              <td class="num">${nOrDash(d.planned_pallets)}</td>
              <td class="num">${nOrDash(d.actual_pallets)}</td>
              <td class="num">${fmtCans(d.actual_cans_m ?? d.planned_cans_m)}</td>
              <td class="small">${esc(d.shift || '')} ${d.supervisor_id ? '· ' + supervisorCell(d) : ''}</td>
              <td><span class="badge ${STATUS_BADGE[d.status] || 'badge-gray'}">${STATUS_LABELS[d.status] || d.status}</span></td>
              <td><button class="btn btn-outline btn-sm" data-edit-dispatch="${d.id}">Edit</button></td>
            </tr>`).join('') : `<tr><td colspan="9" class="empty-state">No dispatches recorded yet.</td></tr>`}
        </tbody>
        ${dispatches.length ? `<tfoot><tr><td colspan="3">Totals</td><td class="num">${dispatches.reduce((s, d) => s + num(d.planned_pallets), 0)}</td><td class="num">${totalDispatched}</td><td colspan="4"></td></tr></tfoot>` : ''}
      </table>
    </div>
  `;

  $('#edit-warehouse-btn').addEventListener('click', () => openWarehouseModal(warehouse));
  $('#add-received-btn').addEventListener('click', () => openLoadModal({ warehouse }, null));
  $('#add-dispatch-btn').addEventListener('click', () => openWarehouseDispatchModal(warehouse, null));
  content.querySelectorAll('[data-edit-load]').forEach(el => el.addEventListener('click', () => {
    openLoadModal({ warehouse }, received.find(l => l.id === el.dataset.editLoad));
  }));
  content.querySelectorAll('[data-edit-dispatch]').forEach(el => el.addEventListener('click', () => {
    openWarehouseDispatchModal(warehouse, dispatches.find(d => d.id === el.dataset.editDispatch));
  }));
}

function openWarehouseDispatchModal(warehouse, dispatch) {
  const isEdit = !!dispatch;
  const v = (f, d = '') => esc(dispatch?.[f] ?? d);
  openModal(`
    <div class="modal-header"><h3>${isEdit ? 'Edit dispatch' : 'New dispatch'} — ${esc(warehouse.name)} → customer</h3><button class="modal-close" id="modal-close">&times;</button></div>
    <div class="modal-body">
      <form id="dispatch-form">
        <div class="form-grid">
          <div class="field span-2"><label>Customer *</label>
            <select id="f-customer">
              <option value="">— Select customer —</option>
              ${State.customers.map(c => `<option value="${c.id}" ${dispatch?.customer_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
            </select>
          </div>
          <div class="field"><label>Dispatch date</label><input type="date" id="f-date" value="${v('dispatch_date')}" /></div>
          <div class="field"><label>Transporter</label><input id="f-transporter" value="${v('transporter')}" /></div>
          <div class="field"><label>Reg number</label><input id="f-reg" value="${v('reg_number')}" /></div>
          <div class="field"><label>Planned pallets</label><input type="number" step="0.01" id="f-planned" value="${v('planned_pallets')}" /></div>
          <div class="field"><label>Actual pallets</label><input type="number" step="0.01" id="f-actual" value="${v('actual_pallets')}" /></div>
          <div class="field"><label>Planned cans (M)</label><input type="number" step="0.01" id="f-planned-cans" value="${v('planned_cans_m')}" /></div>
          <div class="field"><label>Actual cans (M)</label><input type="number" step="0.01" id="f-actual-cans" value="${v('actual_cans_m')}" /></div>
          <div class="field"><label>Supervisor</label>
            <select id="f-supervisor">
              <option value="">—</option>
              ${State.supervisors.filter(s => s.active).map(s => `<option value="${s.id}" data-shift="${esc(s.shift || '')}" ${dispatch?.supervisor_id === s.id ? 'selected' : ''}>${esc(s.name)}${s.shift ? ' (Shift ' + esc(s.shift) + ')' : ''}</option>`).join('')}
            </select>
          </div>
          <div class="field"><label>Shift</label>
            <select id="f-shift">
              <option value="">—</option>
              ${['A', 'B', 'C', 'D'].map(s => `<option value="Shift ${s}" ${dispatch?.shift === 'Shift ' + s ? 'selected' : ''}>Shift ${s}</option>`).join('')}
            </select>
          </div>
          <div class="field span-2"><label>Comment <span class="muted">(if the rightful supervisor for this shift is absent)</span></label><input id="f-supervisor-note" value="${v('supervisor_note')}" /></div>
          <div class="field"><label>Status</label>
            <select id="f-status">
              ${Object.entries(STATUS_LABELS).map(([k, lbl]) => `<option value="${k}" ${dispatch?.status === k ? 'selected' : (!dispatch && k === 'planned') ? 'selected' : ''}>${lbl}</option>`).join('')}
            </select>
          </div>
          <div class="field span-2"><label>Comments</label><textarea id="f-comments" rows="2">${v('comments')}</textarea></div>
        </div>
      </form>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" id="modal-cancel">Cancel</button>
      <button class="btn btn-primary" id="modal-save">${isEdit ? 'Save changes' : 'Add dispatch'}</button>
    </div>
  `);
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-cancel').addEventListener('click', closeModal);
  $('#f-supervisor').addEventListener('change', (e) => {
    const shift = e.target.selectedOptions[0]?.dataset.shift;
    if (shift) $('#f-shift').value = 'Shift ' + shift;
  });
  $('#modal-save').addEventListener('click', async () => {
    const g = (id) => { const x = $(id).value; return x === '' ? null : x; };
    const customer_id = g('#f-customer');
    if (!customer_id) { toast('Select a customer', 'err'); return; }
    const stamp = currentUserStamp();
    const payload = {
      warehouse_id: warehouse.id,
      customer_id,
      dispatch_date: g('#f-date'),
      transporter: g('#f-transporter'),
      reg_number: g('#f-reg'),
      planned_pallets: g('#f-planned'),
      actual_pallets: g('#f-actual'),
      planned_cans_m: g('#f-planned-cans'),
      actual_cans_m: g('#f-actual-cans'),
      supervisor_id: g('#f-supervisor'),
      shift: g('#f-shift'),
      supervisor_note: g('#f-supervisor-note'),
      status: $('#f-status').value,
      comments: g('#f-comments')
    };
    if (isEdit) { payload.updated_by = stamp.by; payload.updated_by_email = stamp.email; payload.updated_at = new Date().toISOString(); }
    else { payload.created_by = stamp.by; payload.created_by_email = stamp.email; }
    try {
      if (isEdit) await DB.updateWarehouseDispatch(dispatch.id, payload);
      else await DB.createWarehouseDispatch(payload);
      closeModal();
      toast(isEdit ? 'Dispatch updated' : 'Dispatch added', 'ok');
      renderContent();
    } catch (err) { toast(err.message, 'err'); }
  });
}
