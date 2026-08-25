/* GZI Loading Schedule — reports.js (Overall / Supervisor / Warehouse / RPM / Stock / Missing attachments) */

/* ================= OVERALL REPORT ================= */
let overallState = makePeriodState('month');
async function renderOverallReport(content) {
  setTitle('Overall report', 'Consolidated totals for the selected period');
  const { from, to } = periodRangeFor(overallState);
  const [loads, dispatches, rpmAll, sohAll] = await Promise.all([
    DB.getLoads({ dateFrom: from, dateTo: to }),
    DB.getWarehouseDispatches({ dateFrom: from, dateTo: to }),
    DB.getRpmMovements(),
    DB.getSohMovements()
  ]);

  const totalPlanned = loads.reduce((s, l) => s + num(l.planned_pallets), 0);
  const totalActual = loads.reduce((s, l) => s + num(l.actual_pallets), 0);
  const totalPlannedCans = loads.reduce((s, l) => s + num(l.planned_cans_m), 0);
  const totalActualCans = loads.reduce((s, l) => s + num(l.actual_cans_m), 0);
  const deviationLoads = loads.filter(l => (l.status === 'loaded' || l.status === 'dispatched') && num(l.actual_pallets) !== num(l.planned_pallets));
  const totalDeviation = deviationLoads.reduce((s, l) => s + (num(l.planned_pallets) - num(l.actual_pallets)), 0);
  const totalDirect = loads.filter(l => l.destination_type === 'customer').reduce((s, l) => s + num(l.actual_pallets), 0);
  const totalToWarehouse = loads.filter(l => l.destination_type === 'warehouse').reduce((s, l) => s + num(l.actual_pallets), 0);
  const totalFromWarehouse = dispatches.reduce((s, d) => s + num(d.actual_pallets), 0);

  const rpmToDate = rpmAll.filter(r => !to || r.movement_date <= to);
  const rpmOutstanding = rpmToDate.reduce((s, r) => s + (r.direction === 'sent' ? num(r.quantity_pallets) : -num(r.quantity_pallets)), 0);

  const sohToDate = sohAll.filter(m => !to || m.movement_date <= to);
  const sohBalance = sohToDate.reduce((s, m) => s + (m.movement_type === 'production_receipt' ? num(m.quantity_pallets) : -num(m.quantity_pallets)), 0);

  const byWeek = {};
  loads.forEach(l => {
    const w = isoWeek(l.loading_date); if (!w) return;
    const key = `${w.year} · W${w.week}`;
    byWeek[key] = byWeek[key] || { planned: 0, actual: 0 };
    byWeek[key].planned += num(l.planned_pallets);
    byWeek[key].actual += num(l.actual_pallets);
  });
  const weekKeys = Object.keys(byWeek).sort();

  const byCustomer = {};
  loads.forEach(l => { const n = destLabelPlain(l); byCustomer[n] = (byCustomer[n] || 0) + num(l.actual_pallets); });
  const custEntries = Object.entries(byCustomer).sort((a, b) => b[1] - a[1]).slice(0, 10);

  content.innerHTML = `
    ${periodFilterHtml(overallState, 'overall')}
    <div class="grid grid-4" style="margin-bottom:20px;">
      <div class="stat-card"><div class="stat-label">Planned / Actual pallets</div><div class="stat-value">${totalPlanned} / ${totalActual}</div><div class="stat-sub">${fmtCans(totalPlannedCans)} / ${fmtCans(totalActualCans)} cans</div></div>
      <div class="stat-card"><div class="stat-label">Deviation</div><div class="stat-value" style="color:${totalDeviation > 0 ? 'var(--red)' : 'var(--green)'}">${totalDeviation}</div><div class="stat-sub">${deviationLoads.length} loads with a variance</div></div>
      <div class="stat-card"><div class="stat-label">Direct / To warehouse</div><div class="stat-value">${totalDirect} / ${totalToWarehouse}</div><div class="stat-sub">${totalFromWarehouse} shipped warehouse → customer</div></div>
      <div class="stat-card"><div class="stat-label">RPM outstanding</div><div class="stat-value">${rpmOutstanding}</div><div class="stat-sub">SOH balance: ${sohBalance} pallets (as of ${fmtDate(to)})</div></div>
    </div>
    <div class="card chart-card" style="margin-bottom:20px;">
      <div class="section-title"><h2>Pallets loaded per customer</h2></div>
      <canvas id="chart-overall-customer"></canvas>
    </div>
    <div class="section-title"><h2>By week number</h2></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Week</th><th class="num">Planned</th><th class="num">Actual</th><th class="num">Variance</th></tr></thead>
        <tbody>
          ${weekKeys.length ? weekKeys.map(k => { const r = byWeek[k]; return `<tr><td>${esc(k)}</td><td class="num">${r.planned}</td><td class="num">${r.actual}</td><td class="num">${r.planned - r.actual}</td></tr>`; }).join('') : `<tr><td colspan="4" class="empty-state">No data in this period.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
  bindPeriodFilter(overallState, 'overall', renderContent);

  Object.values(State.charts).forEach(c => c && c.destroy());
  const ctx = $('#chart-overall-customer');
  State.charts.overallCustomer = new Chart(ctx, {
    type: 'bar',
    data: { labels: custEntries.map(e => e[0]), datasets: [{ label: 'Actual pallets', data: custEntries.map(e => e[1]), backgroundColor: '#2563eb', borderRadius: 4 }] },
    options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { ticks: { autoSkip: false, maxRotation: 40, minRotation: 20 } } } }
  });
}

/* ================= PLANNED VS SUPERVISOR REPORT ================= */
let supervisorReportState = makePeriodState('month');
async function renderSupervisorReport(content) {
  setTitle('Planned vs Supervisor', 'Planned vs actual pallets grouped by supervisor and shift');
  const { from, to } = periodRangeFor(supervisorReportState);
  const loads = await DB.getLoads({ dateFrom: from, dateTo: to });

  const groups = {};
  loads.forEach(l => {
    const key = (l.supervisor_id || 'none') + '|' + (l.shift || '—');
    groups[key] = groups[key] || { supervisor: l.supervisor_id ? supervisorName(l.supervisor_id) : 'Unassigned', shift: l.shift || '—', planned: 0, actual: 0, count: 0 };
    groups[key].planned += num(l.planned_pallets);
    groups[key].actual += num(l.actual_pallets);
    groups[key].count += 1;
  });
  const rows = Object.values(groups).sort((a, b) => b.actual - a.actual);

  content.innerHTML = `
    ${periodFilterHtml(supervisorReportState, 'supr')}
    <div class="table-wrap">
      <table>
        <thead><tr><th>Supervisor</th><th>Shift</th><th class="num">Loads</th><th class="num">Planned</th><th class="num">Actual</th><th class="num">Variance</th></tr></thead>
        <tbody>
          ${rows.length ? rows.map(r => `
            <tr>
              <td>${esc(r.supervisor)}</td>
              <td>${esc(r.shift)}</td>
              <td class="num">${r.count}</td>
              <td class="num">${r.planned}</td>
              <td class="num">${r.actual}</td>
              <td class="num" style="color:${r.planned - r.actual > 0 ? 'var(--red)' : 'inherit'}">${r.planned - r.actual}</td>
            </tr>`).join('') : `<tr><td colspan="6" class="empty-state">No loads in this period.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
  bindPeriodFilter(supervisorReportState, 'supr', renderContent);
}

/* ================= WAREHOUSE REPORT ================= */
let warehouseReportState = makePeriodState('month');
async function renderWarehouseReport(content) {
  setTitle('Warehouse report', 'Sent to warehouse vs shipped to customers, per warehouse');
  const { from, to } = periodRangeFor(warehouseReportState);
  const [loads, dispatches] = await Promise.all([
    DB.getLoads({ destinationType: 'warehouse', dateFrom: from, dateTo: to }),
    DB.getWarehouseDispatches({ dateFrom: from, dateTo: to })
  ]);
  const rows = State.warehouses.map(w => {
    const sent = loads.filter(l => l.warehouse_id === w.id).reduce((s, l) => s + num(l.actual_pallets), 0);
    const shipped = dispatches.filter(d => d.warehouse_id === w.id).reduce((s, d) => s + num(d.actual_pallets), 0);
    return { id: w.id, name: w.name, sent, shipped, held: sent - shipped };
  });

  content.innerHTML = `
    ${periodFilterHtml(warehouseReportState, 'wh-rep')}
    <div class="table-wrap">
      <table>
        <thead><tr><th>Warehouse</th><th class="num">Sent to warehouse</th><th class="num">Shipped to customers</th><th class="num">Held (period)</th><th></th></tr></thead>
        <tbody>
          ${rows.length ? rows.map(r => `
            <tr>
              <td>${esc(r.name)}</td>
              <td class="num">${r.sent}</td>
              <td class="num">${r.shipped}</td>
              <td class="num">${r.held}</td>
              <td><a href="#/warehouse/${r.id}" class="link-btn">Open</a></td>
            </tr>`).join('') : `<tr><td colspan="5" class="empty-state">No warehouses yet. Add one under Manage → Warehouses.</td></tr>`}
        </tbody>
        ${rows.length ? `<tfoot><tr><td>Total</td><td class="num">${rows.reduce((s, r) => s + r.sent, 0)}</td><td class="num">${rows.reduce((s, r) => s + r.shipped, 0)}</td><td class="num">${rows.reduce((s, r) => s + r.held, 0)}</td><td></td></tr></tfoot>` : ''}
      </table>
    </div>
  `;
  bindPeriodFilter(warehouseReportState, 'wh-rep', renderContent);
}

/* ================= RPM REPORT ================= */
let rpmReportState = makePeriodState('month');
async function renderRpmReport(content) {
  setTitle('RPM report', 'Returnable packaging material — sent, returned and outstanding (pallets)');
  const { from, to } = periodRangeFor(rpmReportState);
  const all = await DB.getRpmMovements();
  const inPeriod = all.filter(r => (!from || r.movement_date >= from) && (!to || r.movement_date <= to));
  const toDate = all.filter(r => !to || r.movement_date <= to);

  function balanceFor(entityType, entityId) {
    return toDate.filter(r => r.entity_type === entityType && r.entity_id === entityId)
      .reduce((s, r) => s + (r.direction === 'sent' ? num(r.quantity_pallets) : -num(r.quantity_pallets)), 0);
  }
  const customersWithMovement = new Set(all.filter(r => r.entity_type === 'customer').map(r => r.entity_id));
  const warehousesWithMovement = new Set(all.filter(r => r.entity_type === 'warehouse').map(r => r.entity_id));
  const customerRows = State.customers.filter(c => customersWithMovement.has(c.id)).map(c => ({ name: c.name, balance: balanceFor('customer', c.id) }));
  const warehouseRows = State.warehouses.filter(w => warehousesWithMovement.has(w.id)).map(w => ({ name: w.name, balance: balanceFor('warehouse', w.id) }));

  content.innerHTML = `
    ${periodFilterHtml(rpmReportState, 'rpm')}
    <div class="section-title"><h2>Outstanding RPM (as of ${fmtDate(to)})</h2><div class="actions"><button class="btn btn-orange btn-sm" id="log-rpm-btn">+ Log RPM movement</button></div></div>
    <div class="grid grid-2" style="margin-bottom:20px;">
      <div class="card">
        <h3 style="margin-top:0;">Per customer</h3>
        <table><thead><tr><th>Customer</th><th class="num">Outstanding pallets</th></tr></thead><tbody>
          ${customerRows.length ? customerRows.map(r => `<tr><td>${esc(r.name)}</td><td class="num">${r.balance}</td></tr>`).join('') : `<tr><td colspan="2" class="empty-state">No RPM logged yet.</td></tr>`}
        </tbody></table>
      </div>
      <div class="card">
        <h3 style="margin-top:0;">Per warehouse</h3>
        <table><thead><tr><th>Warehouse</th><th class="num">Outstanding pallets</th></tr></thead><tbody>
          ${warehouseRows.length ? warehouseRows.map(r => `<tr><td>${esc(r.name)}</td><td class="num">${r.balance}</td></tr>`).join('') : `<tr><td colspan="2" class="empty-state">No RPM logged yet.</td></tr>`}
        </tbody></table>
      </div>
    </div>
    <div class="section-title"><h2>Movements in period</h2></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Date</th><th>Entity</th><th>Direction</th><th class="num">Pallets</th><th>Comments</th><th>By</th></tr></thead>
        <tbody>
          ${inPeriod.length ? inPeriod.slice().sort((a, b) => a.movement_date < b.movement_date ? 1 : -1).map(r => `
            <tr>
              <td>${esc(fmtDateShort(r.movement_date))}</td>
              <td>${r.entity_type === 'customer' ? esc(State.customers.find(c => c.id === r.entity_id)?.name || '—') : '🏭 ' + esc(State.warehouses.find(w => w.id === r.entity_id)?.name || '—')}</td>
              <td><span class="badge ${r.direction === 'sent' ? 'badge-blue' : 'badge-green'}">${r.direction}</span></td>
              <td class="num">${nOrDash(r.quantity_pallets)}</td>
              <td class="small muted">${esc(r.comments || '')}</td>
              <td class="small muted">${esc(r.created_by_email || '')}</td>
            </tr>`).join('') : `<tr><td colspan="6" class="empty-state">No RPM movements in this period.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
  bindPeriodFilter(rpmReportState, 'rpm', renderContent);
  $('#log-rpm-btn').addEventListener('click', () => openRpmModal());
}

function openRpmModal() {
  let entityType = 'customer';
  openModal(`
    <div class="modal-header"><h3>Log RPM movement</h3><button class="modal-close" id="modal-close">&times;</button></div>
    <div class="modal-body">
      <form id="rpm-form">
        <div class="form-grid">
          <div class="field span-2"><label>Entity type</label>
            <div class="tab-group" id="f-entity-type">
              <button type="button" data-e="customer" class="active">Customer</button>
              <button type="button" data-e="warehouse">Warehouse</button>
            </div>
          </div>
          <div class="field span-2" id="f-entity-customer-wrap">
            <label>Customer</label>
            <select id="f-entity-customer"><option value="">— Select —</option>${State.customers.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
          </div>
          <div class="field span-2" id="f-entity-warehouse-wrap" style="display:none;">
            <label>Warehouse</label>
            <select id="f-entity-warehouse"><option value="">— Select —</option>${State.warehouses.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select>
          </div>
          <div class="field"><label>Direction</label>
            <select id="f-direction"><option value="sent">Sent</option><option value="returned">Returned</option></select>
          </div>
          <div class="field"><label>Pallets *</label><input type="number" step="0.01" id="f-qty" /></div>
          <div class="field"><label>Date</label><input type="date" id="f-date" value="${todayISO()}" /></div>
          <div class="field span-2"><label>Comments</label><textarea id="f-comments" rows="2"></textarea></div>
        </div>
      </form>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" id="modal-cancel">Cancel</button>
      <button class="btn btn-primary" id="modal-save">Log movement</button>
    </div>
  `);
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-cancel').addEventListener('click', closeModal);
  $('#f-entity-type').querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      entityType = btn.dataset.e;
      $('#f-entity-type').querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
      $('#f-entity-customer-wrap').style.display = entityType === 'customer' ? '' : 'none';
      $('#f-entity-warehouse-wrap').style.display = entityType === 'warehouse' ? '' : 'none';
    });
  });
  $('#modal-save').addEventListener('click', async () => {
    const entityId = entityType === 'customer' ? $('#f-entity-customer').value : $('#f-entity-warehouse').value;
    const qty = $('#f-qty').value;
    if (!entityId) { toast('Select an entity', 'err'); return; }
    if (!qty) { toast('Enter a pallet quantity', 'err'); return; }
    const stamp = currentUserStamp();
    try {
      await DB.createRpmMovement({
        entity_type: entityType, entity_id: entityId, direction: $('#f-direction').value,
        quantity_pallets: qty, movement_date: $('#f-date').value || todayISO(),
        comments: $('#f-comments').value.trim() || null,
        created_by: stamp.by, created_by_email: stamp.email
      });
      closeModal();
      toast('RPM movement logged', 'ok');
      renderContent();
    } catch (err) { toast(err.message, 'err'); }
  });
}

/* ================= STOCK (SOH) REPORT ================= */
let stockReportState = makePeriodState('month');
async function renderStockReport(content) {
  setTitle('Stock (SOH)', 'Production receipts vs dispatches — running stock-on-hand balance');
  const { from, to } = periodRangeFor(stockReportState);
  const all = await DB.getSohMovements();
  const toDate = all.filter(m => !to || m.movement_date <= to);
  const inPeriod = all.filter(m => (!from || m.movement_date >= from) && (!to || m.movement_date <= to));
  const balancePallets = toDate.reduce((s, m) => s + (m.movement_type === 'production_receipt' ? num(m.quantity_pallets) : -num(m.quantity_pallets)), 0);
  const balanceCans = toDate.reduce((s, m) => s + (m.movement_type === 'production_receipt' ? num(m.quantity_cans_m) : -num(m.quantity_cans_m)), 0);
  const receivedInPeriod = inPeriod.filter(m => m.movement_type === 'production_receipt').reduce((s, m) => s + num(m.quantity_pallets), 0);
  const dispatchedInPeriod = inPeriod.filter(m => m.movement_type === 'dispatch').reduce((s, m) => s + num(m.quantity_pallets), 0);

  content.innerHTML = `
    ${periodFilterHtml(stockReportState, 'stock')}
    <div class="section-title"><h2>Stock on hand — balance as of ${fmtDate(to)}</h2><div class="actions"><button class="btn btn-orange btn-sm" id="add-receipt-btn">+ Record production receipt</button></div></div>
    <div class="grid grid-4" style="margin-bottom:20px;">
      <div class="stat-card"><div class="stat-label">SOH balance</div><div class="stat-value">${balancePallets}</div><div class="stat-sub">${fmtCans(balanceCans)} cans</div></div>
      <div class="stat-card"><div class="stat-label">Received in period</div><div class="stat-value">${receivedInPeriod}</div></div>
      <div class="stat-card"><div class="stat-label">Dispatched in period</div><div class="stat-value">${dispatchedInPeriod}</div></div>
      <div class="stat-card"><div class="stat-label">Net movement</div><div class="stat-value">${receivedInPeriod - dispatchedInPeriod}</div></div>
    </div>
    <div class="section-title"><h2>Receive vs dispatch ledger</h2></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Date</th><th>Type</th><th class="num">Pallets</th><th class="num">Cans (M)</th><th>Description</th><th>By</th></tr></thead>
        <tbody>
          ${inPeriod.length ? inPeriod.slice().sort((a, b) => a.movement_date < b.movement_date ? 1 : -1).map(m => `
            <tr>
              <td>${esc(fmtDateShort(m.movement_date))}</td>
              <td><span class="badge ${m.movement_type === 'production_receipt' ? 'badge-green' : 'badge-blue'}">${m.movement_type === 'production_receipt' ? 'Receipt' : 'Dispatch'}</span></td>
              <td class="num">${nOrDash(m.quantity_pallets)}</td>
              <td class="num">${fmtCans(m.quantity_cans_m)}</td>
              <td class="small muted">${esc(m.description || '')}</td>
              <td class="small muted">${esc(m.created_by_email || (m.movement_type === 'dispatch' ? 'auto' : ''))}</td>
            </tr>`).join('') : `<tr><td colspan="6" class="empty-state">No stock movements in this period.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
  bindPeriodFilter(stockReportState, 'stock', renderContent);
  $('#add-receipt-btn').addEventListener('click', () => openReceiptModal());
}

function openReceiptModal() {
  openModal(`
    <div class="modal-header"><h3>Record production receipt</h3><button class="modal-close" id="modal-close">&times;</button></div>
    <div class="modal-body">
      <form id="receipt-form">
        <div class="form-grid">
          <div class="field"><label>Date</label><input type="date" id="f-date" value="${todayISO()}" /></div>
          <div class="field"><label>Pallets *</label><input type="number" step="0.01" id="f-pallets" /></div>
          <div class="field"><label>Cans (M)</label><input type="number" step="0.01" id="f-cans" /></div>
          <div class="field span-2"><label>Description</label><input id="f-desc" placeholder="e.g. New production run — Design X" /></div>
        </div>
      </form>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" id="modal-cancel">Cancel</button>
      <button class="btn btn-primary" id="modal-save">Record receipt</button>
    </div>
  `);
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-cancel').addEventListener('click', closeModal);
  $('#modal-save').addEventListener('click', async () => {
    const pallets = $('#f-pallets').value;
    if (!pallets) { toast('Enter a pallet quantity', 'err'); return; }
    const stamp = currentUserStamp();
    try {
      await DB.createSohMovement({
        movement_type: 'production_receipt',
        quantity_pallets: pallets,
        quantity_cans_m: $('#f-cans').value || null,
        movement_date: $('#f-date').value || todayISO(),
        description: $('#f-desc').value.trim() || 'Production receipt',
        created_by: stamp.by, created_by_email: stamp.email
      });
      closeModal();
      toast('Receipt recorded', 'ok');
      renderContent();
    } catch (err) { toast(err.message, 'err'); }
  });
}

/* ================= MISSING ATTACHMENTS REPORT ================= */
async function renderMissingAttachmentsReport(content) {
  setTitle('Missing attachments', 'Loads marked loaded/dispatched with no supporting document');
  const [loads, attachmentIds] = await Promise.all([DB.getLoads({}), DB.getAllAttachmentLoadIds()]);
  const missing = loads.filter(l => (l.status === 'loaded' || l.status === 'dispatched') && !attachmentIds.has(l.id));

  content.innerHTML = `
    <div class="section-title"><h2>${missing.length} load(s) missing a supporting document</h2></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Date</th><th>Destination</th><th>PO / DN</th><th class="num">Actual pallets</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${missing.length ? missing.map(l => `
            <tr>
              <td>${esc(fmtDateShort(l.loading_date))}</td>
              <td>${destLabel(l)}</td>
              <td class="small muted">${esc(l.gzi_dn || l.gzi_po_number || '')}</td>
              <td class="num">${nOrDash(l.actual_pallets)}</td>
              <td><span class="badge ${STATUS_BADGE[l.status] || 'badge-gray'}">${STATUS_LABELS[l.status] || l.status}</span></td>
              <td><span class="link-btn" data-docs="${l.id}">Add document</span></td>
            </tr>`).join('') : `<tr><td colspan="6" class="empty-state">Every loaded/dispatched load has a document attached 🎉</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
  content.querySelectorAll('[data-docs]').forEach(el => el.addEventListener('click', () => openAttachmentsModal(el.dataset.docs)));
}
