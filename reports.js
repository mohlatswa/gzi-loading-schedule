/* GZI Loading Schedule — reports.js (Overall / Deviation / Loaded totals / Supervisor / Warehouse / RPM / Stock / Missing attachments) */

/* ================= OVERALL REPORT ================= */
let overallState = makePeriodState('month');
async function renderOverallReport(content) {
  setTitle('Overall report', 'Consolidated totals for the selected period');
  const { from, to } = periodRangeFor(overallState);
  const [loads, dispatches, sohAll, localCover, exportCover] = await Promise.all([
    DB.getLoads({ dateFrom: from, dateTo: to }),
    DB.getWarehouseDispatches({ dateFrom: from, dateTo: to }),
    DB.getSohMovements(),
    computeRpmCover('local'),
    computeRpmCover('export')
  ]);

  const totalPlanned = loads.reduce((s, l) => s + num(l.planned_pallets), 0);
  const totalActual = loads.reduce((s, l) => s + num(l.actual_pallets), 0);
  const totalPlannedCans = loads.reduce((s, l) => s + (cansFromPallets(l.planned_pallets) || 0), 0);
  const totalActualCans = loads.reduce((s, l) => s + (cansFromPallets(l.actual_pallets) || 0), 0);
  const deviationLoads = loads.filter(l => (l.status === 'loaded' || l.status === 'dispatched') && num(l.actual_pallets) !== num(l.planned_pallets));
  const totalDeviation = deviationLoads.reduce((s, l) => s + (num(l.planned_pallets) - num(l.actual_pallets)), 0);
  const totalDirect = loads.filter(l => l.destination_type === 'customer').reduce((s, l) => s + num(l.actual_pallets), 0);
  const totalToWarehouse = loads.filter(l => l.destination_type === 'warehouse').reduce((s, l) => s + num(l.actual_pallets), 0);
  const totalFromWarehouse = dispatches.reduce((s, d) => s + num(d.actual_pallets), 0);

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
      <div class="stat-card"><div class="stat-label">Deviation</div><div class="stat-value" style="color:${totalDeviation > 0 ? 'var(--red)' : 'var(--green)'}">${totalDeviation}</div><div class="stat-sub">${fmtCans(cansFromPallets(Math.abs(totalDeviation)))} cans · ${deviationLoads.length} loads</div></div>
      <div class="stat-card"><div class="stat-label">Direct / To warehouse</div><div class="stat-value">${totalDirect} / ${totalToWarehouse}</div><div class="stat-sub">${totalFromWarehouse} shipped warehouse → customer</div></div>
      <div class="stat-card"><div class="stat-label">SOH balance</div><div class="stat-value">${sohBalance}</div><div class="stat-sub">pallets, as of ${fmtDate(to)}</div></div>
    </div>
    <div class="grid grid-2" style="margin-bottom:20px;">
      <div class="stat-card"><div class="stat-label">Local RPM Cover</div><div class="stat-value">${fmtCover(localCover.overall)}</div><div class="stat-sub">In Warehouse ready ÷ planned production run requirement</div></div>
      <div class="stat-card"><div class="stat-label">Export RPM Cover</div><div class="stat-value">${fmtCover(exportCover.overall)}</div><div class="stat-sub">In Warehouse ready ÷ planned production run requirement</div></div>
    </div>
    <div class="card chart-card" style="margin-bottom:20px;">
      <div class="section-title"><h2>Pallets loaded per customer</h2></div>
      <canvas id="chart-overall-customer"></canvas>
    </div>
    <div class="section-title"><h2>By week number</h2></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Week</th><th class="num">Planned</th><th class="num">Actual</th><th class="num">Deviation</th><th class="num">Cans (M)</th></tr></thead>
        <tbody>
          ${weekKeys.length ? weekKeys.map(k => { const r = byWeek[k]; const dev = r.planned - r.actual; return `<tr><td>${esc(k)}</td><td class="num">${r.planned}</td><td class="num">${r.actual}</td><td class="num">${dev}</td><td class="num">${fmtCans(cansFromPallets(Math.abs(dev)))}</td></tr>`; }).join('') : `<tr><td colspan="5" class="empty-state">No data in this period.</td></tr>`}
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

/* ================= LOADS DEVIATION REPORT ================= */
let deviationReportState = makePeriodState('month');
async function renderDeviationReport(content) {
  setTitle('Loads deviation', 'Plan date vs actual loaded date, for every load regardless of status');
  const { from, to } = periodRangeFor(deviationReportState);
  const loads = await DB.getLoads({ dateFrom: from, dateTo: to });

  const rows = loads.map(l => {
    const hasActual = l.actual_pallets !== null && l.actual_pallets !== undefined && l.actual_pallets !== '';
    const deviation = hasActual ? num(l.planned_pallets) - num(l.actual_pallets) : null;
    return { l, hasActual, deviation };
  });
  const withDeviation = rows.filter(r => r.hasActual && r.deviation !== 0);

  const byCustomer = {};
  withDeviation.forEach(r => { const n = destLabelPlain(r.l); byCustomer[n] = (byCustomer[n] || 0) + 1; });
  const byCustomerEntries = Object.entries(byCustomer).sort((a, b) => b[1] - a[1]);

  const bySupervisor = {};
  withDeviation.forEach(r => { const n = r.l.supervisor_id ? supervisorName(r.l.supervisor_id) : 'Unassigned'; bySupervisor[n] = (bySupervisor[n] || 0) + 1; });
  const bySupervisorEntries = Object.entries(bySupervisor).sort((a, b) => b[1] - a[1]);

  content.innerHTML = `
    ${periodFilterHtml(deviationReportState, 'devrep')}
    <div class="grid grid-2" style="margin-bottom:20px;">
      <div class="card chart-card">
        <div class="section-title"><h2>Deviating loads per customer</h2></div>
        <canvas id="chart-dev-customer"></canvas>
      </div>
      <div class="card chart-card">
        <div class="section-title"><h2>Deviating loads per supervisor</h2></div>
        <canvas id="chart-dev-supervisor"></canvas>
      </div>
    </div>
    <div class="grid grid-2" style="margin-bottom:20px;">
      <div class="card">
        <h3 style="margin-top:0;">By customer</h3>
        <table><thead><tr><th>Customer</th><th class="num"># loads deviating</th></tr></thead><tbody>
          ${byCustomerEntries.length ? byCustomerEntries.map(([n, c]) => `<tr><td>${esc(n)}</td><td class="num">${c}</td></tr>`).join('') : `<tr><td colspan="2" class="empty-state">No deviations in this period.</td></tr>`}
        </tbody></table>
      </div>
      <div class="card">
        <h3 style="margin-top:0;">By supervisor</h3>
        <table><thead><tr><th>Supervisor</th><th class="num"># loads deviating</th></tr></thead><tbody>
          ${bySupervisorEntries.length ? bySupervisorEntries.map(([n, c]) => `<tr><td>${esc(n)}</td><td class="num">${c}</td></tr>`).join('') : `<tr><td colspan="2" class="empty-state">No deviations in this period.</td></tr>`}
        </tbody></table>
      </div>
    </div>
    <div class="section-title"><h2>All loads — plan date vs loaded date (${loads.length})</h2></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Plan date</th><th>Loaded date</th><th>Destination</th><th>Supervisor</th><th>Shift</th><th>Day/Night</th><th class="num">Planned</th><th class="num">Actual</th><th class="num">Deviation</th><th class="num">Cans (M)</th><th>Status</th></tr></thead>
        <tbody>
          ${rows.length ? rows.map(({ l, hasActual, deviation }) => `
            <tr>
              <td>${esc(fmtDateShort(l.loading_date))}</td>
              <td>${l.actual_loaded_date ? esc(fmtDateShort(l.actual_loaded_date)) : '<span class="muted">— pending —</span>'}</td>
              <td>${destLabel(l)}</td>
              <td class="small">${supervisorCell(l)}</td>
              <td class="small">${esc(l.shift || '')}</td>
              <td class="small">${l.day_night ? esc(l.day_night === 'day' ? 'Day' : 'Night') : ''}</td>
              <td class="num">${nOrDash(l.planned_pallets)}</td>
              <td class="num">${hasActual ? l.actual_pallets : '—'}</td>
              <td class="num" style="${deviation ? 'color:var(--red)' : ''}">${hasActual ? deviation : '—'}</td>
              <td class="num" style="${deviation ? 'color:var(--red)' : ''}">${hasActual ? fmtCans(cansFromPallets(Math.abs(deviation))) : '—'}</td>
              <td><span class="badge ${STATUS_BADGE[l.status] || 'badge-gray'}">${STATUS_LABELS[l.status] || l.status}</span></td>
            </tr>`).join('') : `<tr><td colspan="11" class="empty-state">No loads in this period.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
  bindPeriodFilter(deviationReportState, 'devrep', renderContent);

  Object.values(State.charts).forEach(c => c && c.destroy());
  State.charts.devCustomer = new Chart($('#chart-dev-customer'), {
    type: 'bar',
    data: { labels: byCustomerEntries.map(e => e[0]), datasets: [{ label: '# deviating loads', data: byCustomerEntries.map(e => e[1]), backgroundColor: '#dc2626', borderRadius: 4 }] },
    options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { ticks: { autoSkip: false, maxRotation: 40, minRotation: 20 } } } }
  });
  State.charts.devSupervisor = new Chart($('#chart-dev-supervisor'), {
    type: 'bar',
    data: { labels: bySupervisorEntries.map(e => e[0]), datasets: [{ label: '# deviating loads', data: bySupervisorEntries.map(e => e[1]), backgroundColor: '#d97706', borderRadius: 4 }] },
    options: { responsive: true, plugins: { legend: { display: false } } }
  });
}

/* ================= LOADED TOTALS REPORT ================= */
let loadedTotalsState = makePeriodState('month');
let loadedTotalsGroupBy = 'supervisor';
async function renderLoadedTotalsReport(content) {
  setTitle('Loaded totals', 'Loaded/dispatched loads — totals grouped by supervisor, day, week or month');
  const { from, to } = periodRangeFor(loadedTotalsState);
  const loads = (await DB.getLoads({ dateFrom: from, dateTo: to })).filter(l => l.status === 'loaded' || l.status === 'dispatched');

  function groupKey(l) {
    if (loadedTotalsGroupBy === 'supervisor') return l.supervisor_id ? supervisorName(l.supervisor_id) : 'Unassigned';
    if (loadedTotalsGroupBy === 'day') return fmtDateShort(l.loading_date);
    if (loadedTotalsGroupBy === 'week') { const w = isoWeek(l.loading_date); return w ? `${w.year} · W${w.week}` : 'Unknown'; }
    return l.loading_date ? l.loading_date.slice(0, 7) : 'Unknown';
  }
  const groups = {};
  loads.forEach(l => {
    const key = groupKey(l);
    groups[key] = groups[key] || { count: 0, pallets: 0, cans: 0 };
    groups[key].count += 1;
    groups[key].pallets += num(l.actual_pallets);
    groups[key].cans += cansFromPallets(l.actual_pallets) || 0;
  });
  const entries = Object.entries(groups).sort((a, b) => a[0] < b[0] ? -1 : 1);
  const groupLabel = { supervisor: 'Supervisor', day: 'Day', week: 'Week', month: 'Month' }[loadedTotalsGroupBy];

  content.innerHTML = `
    ${periodFilterHtml(loadedTotalsState, 'loadedtot')}
    <div class="tab-group" id="loadedtot-groupby" style="margin-bottom:14px;">
      <button type="button" data-g="supervisor" class="${loadedTotalsGroupBy === 'supervisor' ? 'active' : ''}">By supervisor</button>
      <button type="button" data-g="day" class="${loadedTotalsGroupBy === 'day' ? 'active' : ''}">By day</button>
      <button type="button" data-g="week" class="${loadedTotalsGroupBy === 'week' ? 'active' : ''}">By week</button>
      <button type="button" data-g="month" class="${loadedTotalsGroupBy === 'month' ? 'active' : ''}">By month</button>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>${groupLabel}</th><th class="num">Loads</th><th class="num">Total pallets</th><th class="num">Total cans (M)</th></tr></thead>
        <tbody>
          ${entries.length ? entries.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${v.count}</td><td class="num">${v.pallets}</td><td class="num">${fmtCans(v.cans)}</td></tr>`).join('') : `<tr><td colspan="4" class="empty-state">No loaded/dispatched loads in this period.</td></tr>`}
        </tbody>
        ${entries.length ? `<tfoot><tr><td>Total</td><td class="num">${loads.length}</td><td class="num">${entries.reduce((s, [, v]) => s + v.pallets, 0)}</td><td class="num">${fmtCans(entries.reduce((s, [, v]) => s + v.cans, 0))}</td></tr></tfoot>` : ''}
      </table>
    </div>
  `;
  bindPeriodFilter(loadedTotalsState, 'loadedtot', renderContent);
  $('#loadedtot-groupby').querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => { loadedTotalsGroupBy = btn.dataset.g; renderContent(); });
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
        <thead><tr><th>Supervisor</th><th>Shift</th><th class="num">Loads</th><th class="num">Planned</th><th class="num">Actual</th><th class="num">Deviation</th><th class="num">Cans (M)</th></tr></thead>
        <tbody>
          ${rows.length ? rows.map(r => {
            const dev = r.planned - r.actual;
            return `
            <tr>
              <td>${esc(r.supervisor)}</td>
              <td>${esc(r.shift)}</td>
              <td class="num">${r.count}</td>
              <td class="num">${r.planned}</td>
              <td class="num">${r.actual}</td>
              <td class="num" style="color:${dev > 0 ? 'var(--red)' : 'inherit'}">${dev}</td>
              <td class="num" style="color:${dev > 0 ? 'var(--red)' : 'inherit'}">${fmtCans(cansFromPallets(Math.abs(dev)))}</td>
            </tr>`;
          }).join('') : `<tr><td colspan="7" class="empty-state">No loads in this period.</td></tr>`}
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
  setTitle('RPM report', 'Returnable packaging material — pallets, top frames and layer cards');
  const { from, to } = periodRangeFor(rpmReportState);
  const all = await DB.getRpmMovements();
  const inPeriod = all.filter(r => (!from || r.movement_date >= from) && (!to || r.movement_date <= to));
  const toDate = all.filter(r => !to || r.movement_date <= to);

  function balanceFor(entityType, entityId) {
    const rows = toDate.filter(r => r.entity_type === entityType && r.entity_id === entityId);
    const dir = (d, field) => rows.filter(r => r.direction === d).reduce((s, r) => s + num(r[field]), 0);
    return {
      pallets: dir('sent', 'quantity_pallets') - dir('returned', 'quantity_pallets'),
      frames: dir('sent', 'quantity_frames') - dir('returned', 'quantity_frames'),
      layercards: dir('sent', 'quantity_layercards') - dir('returned', 'quantity_layercards')
    };
  }
  const customersWithMovement = new Set(all.filter(r => r.entity_type === 'customer').map(r => r.entity_id));
  const warehousesWithMovement = new Set(all.filter(r => r.entity_type === 'warehouse').map(r => r.entity_id));
  const customerRows = State.customers.filter(c => customersWithMovement.has(c.id)).map(c => ({ name: c.name, ...balanceFor('customer', c.id) }));
  const warehouseRows = State.warehouses.filter(w => warehousesWithMovement.has(w.id)).map(w => ({ name: w.name, ...balanceFor('warehouse', w.id) }));

  const sentTotals = { pallets: 0, frames: 0, layercards: 0 };
  const returnedTotals = { pallets: 0, frames: 0, layercards: 0 };
  inPeriod.forEach(r => {
    const bucket = r.direction === 'sent' ? sentTotals : returnedTotals;
    bucket.pallets += num(r.quantity_pallets); bucket.frames += num(r.quantity_frames); bucket.layercards += num(r.quantity_layercards);
  });

  const [localCover, exportCover] = await Promise.all([computeRpmCover('local'), computeRpmCover('export')]);

  function inWarehouseTableHtml(market, cover) {
    return `
      <div class="card">
        <h3 style="margin-top:0; text-transform:capitalize;">${esc(market)} — In Warehouse</h3>
        <div class="field" style="max-width:260px;">
          <label>Planned production run (cans)</label>
          <div style="display:flex; gap:6px;">
            <input type="number" step="1" id="plan-${market}" value="${cover.planQty ?? ''}" />
            <button class="btn btn-outline btn-sm" data-save-plan="${market}">Save</button>
          </div>
        </div>
        <div class="stat-sub" style="margin:10px 0;">Cover (Ready ÷ requirement from the plan above): <b>${fmtCover(cover.overall)}</b></div>
        <table>
          <thead><tr><th>Item</th><th class="num">To be sorted</th><th class="num">Ready</th><th class="num">Required</th><th class="num">Cover</th></tr></thead>
          <tbody>
            <tr><td>Pallets</td><td class="num">${cover.balances.pallet.toSort}</td><td class="num">${cover.balances.pallet.ready}</td><td class="num">${cover.required.pallets.toFixed(2)}</td><td class="num">${fmtCover(cover.coverPallets)}</td></tr>
            <tr><td>Frames</td><td class="num">${cover.balances.frame.toSort}</td><td class="num">${cover.balances.frame.ready}</td><td class="num">${cover.required.frames.toFixed(2)}</td><td class="num">${fmtCover(cover.coverFrames)}</td></tr>
            <tr><td>Layer cards</td><td class="num">${cover.balances.layercard.toSort}</td><td class="num">${cover.balances.layercard.ready}</td><td class="num">${cover.required.layercards}</td><td class="num">${fmtCover(cover.coverCards)}</td></tr>
          </tbody>
        </table>
      </div>`;
  }

  content.innerHTML = `
    ${periodFilterHtml(rpmReportState, 'rpm')}
    <div class="section-title"><h2>Outstanding RPM (as of ${fmtDate(to)})</h2><div class="actions"><button class="btn btn-orange btn-sm" id="log-rpm-btn">+ Log RPM movement</button></div></div>
    <div class="grid grid-2" style="margin-bottom:20px;">
      <div class="card">
        <h3 style="margin-top:0;">Per customer</h3>
        <table><thead><tr><th>Customer</th><th class="num">Pallets</th><th class="num">Frames</th><th class="num">Layer cards</th></tr></thead><tbody>
          ${customerRows.length ? customerRows.map(r => `<tr><td>${esc(r.name)}</td><td class="num">${r.pallets}</td><td class="num">${r.frames}</td><td class="num">${r.layercards}</td></tr>`).join('') : `<tr><td colspan="4" class="empty-state">No RPM logged yet.</td></tr>`}
        </tbody></table>
      </div>
      <div class="card">
        <h3 style="margin-top:0;">Per warehouse (external)</h3>
        <table><thead><tr><th>Warehouse</th><th class="num">Pallets</th><th class="num">Frames</th><th class="num">Layer cards</th></tr></thead><tbody>
          ${warehouseRows.length ? warehouseRows.map(r => `<tr><td>${esc(r.name)}</td><td class="num">${r.pallets}</td><td class="num">${r.frames}</td><td class="num">${r.layercards}</td></tr>`).join('') : `<tr><td colspan="4" class="empty-state">No RPM logged yet.</td></tr>`}
        </tbody></table>
      </div>
    </div>

    <div class="section-title"><h2>Sent vs Returned (in period)</h2><div class="actions"><button class="btn btn-outline btn-sm" id="log-instock-btn">+ Log In-Warehouse movement</button></div></div>
    <div class="grid grid-2" style="margin-bottom:20px;">
      <div class="card">
        <h3 style="margin-top:0;">Sent</h3>
        <table><tbody>
          <tr><td>Pallets</td><td class="num">${sentTotals.pallets}</td></tr>
          <tr><td>Frames</td><td class="num">${sentTotals.frames}</td></tr>
          <tr><td>Layer cards</td><td class="num">${sentTotals.layercards}</td></tr>
        </tbody></table>
      </div>
      <div class="card">
        <h3 style="margin-top:0;">Returned</h3>
        <table><tbody>
          <tr><td>Pallets</td><td class="num">${returnedTotals.pallets}</td></tr>
          <tr><td>Frames</td><td class="num">${returnedTotals.frames}</td></tr>
          <tr><td>Layer cards</td><td class="num">${returnedTotals.layercards}</td></tr>
        </tbody></table>
      </div>
    </div>

    <div class="section-title"><h2>In Warehouse (GZI internal — pallets, layer pads, frames)</h2></div>
    <div class="grid grid-2" style="margin-bottom:20px;">
      ${inWarehouseTableHtml('local', localCover)}
      ${inWarehouseTableHtml('export', exportCover)}
    </div>

    <div class="section-title"><h2>Movements in period</h2></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Date</th><th>Entity</th><th>Direction</th><th>Market</th><th class="num">Pallets</th><th class="num">Frames</th><th class="num">Layer cards</th><th>Comments</th><th>By</th></tr></thead>
        <tbody>
          ${inPeriod.length ? inPeriod.slice().sort((a, b) => a.movement_date < b.movement_date ? 1 : -1).map(r => `
            <tr>
              <td>${esc(fmtDateShort(r.movement_date))}</td>
              <td>${r.entity_type === 'customer' ? esc(State.customers.find(c => c.id === r.entity_id)?.name || '—') : '🏭 ' + esc(State.warehouses.find(w => w.id === r.entity_id)?.name || '—')}</td>
              <td><span class="badge ${r.direction === 'sent' ? 'badge-blue' : 'badge-green'}">${r.direction}</span></td>
              <td class="small">${r.market ? esc(r.market === 'local' ? 'Local' : 'Export') : ''}</td>
              <td class="num">${nOrDash(r.quantity_pallets)}</td>
              <td class="num">${nOrDash(r.quantity_frames)}</td>
              <td class="num">${nOrDash(r.quantity_layercards)}</td>
              <td class="small muted">${esc(r.comments || '')}</td>
              <td class="small muted">${esc(r.created_by_email || '')}</td>
            </tr>`).join('') : `<tr><td colspan="9" class="empty-state">No RPM movements in this period.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
  bindPeriodFilter(rpmReportState, 'rpm', renderContent);
  $('#log-rpm-btn').addEventListener('click', () => openRpmModal());
  $('#log-instock-btn').addEventListener('click', () => openRpmInternalStockModal());
  content.querySelectorAll('[data-save-plan]').forEach(btn => btn.addEventListener('click', async () => {
    const market = btn.dataset.savePlan;
    const qty = $(`#plan-${market}`).value;
    try {
      await DB.setRpmProductionPlan(market, qty === '' ? null : qty);
      toast('Planned production run saved', 'ok');
      renderContent();
    } catch (err) { toast(err.message, 'err'); }
  }));
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
          <div class="field"><label>Market</label>
            <select id="f-market"><option value="">—</option><option value="local">Local</option><option value="export">Export</option></select>
          </div>
          <div class="field"><label>Pallets *</label><input type="number" step="0.01" id="f-qty" /></div>
          <div class="field"><label>Frames <span class="muted">(auto)</span></label><input type="number" id="f-frames" disabled /></div>
          <div class="field"><label>Layer cards <span class="muted">(auto)</span></label><input type="number" id="f-cards" disabled /></div>
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
  $('#f-qty').addEventListener('input', () => {
    const pallets = Number($('#f-qty').value) || 0;
    $('#f-frames').value = pallets ? pallets * RPM_RATIO.frames : '';
    $('#f-cards').value = pallets ? pallets * RPM_RATIO.layercards : '';
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
        quantity_pallets: qty, quantity_frames: Number(qty) * RPM_RATIO.frames, quantity_layercards: Number(qty) * RPM_RATIO.layercards,
        market: $('#f-market').value || null,
        movement_date: $('#f-date').value || todayISO(),
        comments: $('#f-comments').value.trim() || null,
        created_by: stamp.by, created_by_email: stamp.email
      });
      closeModal();
      toast('RPM movement logged', 'ok');
      renderContent();
    } catch (err) { toast(err.message, 'err'); }
  });
}

function openRpmInternalStockModal() {
  openModal(`
    <div class="modal-header"><h3>Log In-Warehouse RPM</h3><button class="modal-close" id="modal-close">&times;</button></div>
    <div class="modal-body">
      <form id="instock-form">
        <div class="form-grid">
          <div class="field"><label>Add to</label>
            <select id="f-bucket">
              <option value="to_be_sorted">To be sorted</option>
              <option value="ready">Ready</option>
            </select>
          </div>
          <div class="field"><label>Market</label>
            <select id="f-market"><option value="local">Local</option><option value="export">Export</option></select>
          </div>
          <div class="field"><label>Pallets *</label><input type="number" step="0.01" id="f-qty" /></div>
          <div class="field"><label>Date</label><input type="date" id="f-date" value="${todayISO()}" /></div>
          <div class="field span-2"><label class="muted">Frames = same as pallets, Layer cards = pallets × ${RPM_RATIO.layercards} — added automatically.</label></div>
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
  $('#modal-save').addEventListener('click', async () => {
    const qty = $('#f-qty').value;
    if (!qty) { toast('Enter a pallet quantity', 'err'); return; }
    try {
      await DB.logRpmInternalMovement({
        bucket: $('#f-bucket').value, market: $('#f-market').value, quantityPallets: qty,
        date: $('#f-date').value || todayISO(), comments: $('#f-comments').value.trim() || null
      });
      closeModal();
      toast('In-Warehouse movement logged', 'ok');
      renderContent();
    } catch (err) { toast(err.message, 'err'); }
  });
}

/* ================= STOCK (SOH FG / HFI) REPORT ================= */
let stockReportState = makePeriodState('month');
let stockReportKind = 'FG';
function stockKindLabel(k) { return k === 'HFI' ? 'HFI' : 'FG'; }
async function renderStockReport(content) {
  setTitle('Stock (SOH)', 'Finished Goods (FG) and Held For Inspection (HFI) stock — receipts vs dispatches and per-design counts');
  const { from, to } = periodRangeFor(stockReportState);
  const [all, designRecords] = await Promise.all([DB.getSohMovements(stockReportKind), DB.getSohDesignRecords(stockReportKind)]);
  const toDate = all.filter(m => !to || m.movement_date <= to);
  const inPeriod = all.filter(m => (!from || m.movement_date >= from) && (!to || m.movement_date <= to));
  const balancePallets = toDate.reduce((s, m) => s + (m.movement_type === 'production_receipt' ? num(m.quantity_pallets) : -num(m.quantity_pallets)), 0);
  const balanceCans = toDate.reduce((s, m) => s + (m.movement_type === 'production_receipt' ? num(m.quantity_cans_m) : -num(m.quantity_cans_m)), 0);
  const receivedInPeriod = inPeriod.filter(m => m.movement_type === 'production_receipt').reduce((s, m) => s + num(m.quantity_pallets), 0);
  const dispatchedInPeriod = inPeriod.filter(m => m.movement_type === 'dispatch').reduce((s, m) => s + num(m.quantity_pallets), 0);
  const openVariances = designRecords.filter(d => !d.resolved_at);

  content.innerHTML = `
    <div style="display:flex; align-items:center; gap:12px; margin-bottom:14px;">
      <strong style="font-size:14px;">Stock (SOH)</strong>
      <div class="tab-group" id="stock-kind-tabs">
        <button type="button" data-k="FG" class="${stockReportKind === 'FG' ? 'active' : ''}">(FG)</button>
        <button type="button" data-k="HFI" class="${stockReportKind === 'HFI' ? 'active' : ''}">(HFI)</button>
      </div>
    </div>
    ${periodFilterHtml(stockReportState, 'stock')}
    <div class="section-title"><h2>Stock (SOH) (${stockKindLabel(stockReportKind)}) balance as of ${fmtDate(to)}</h2><div class="actions"><button class="btn btn-orange btn-sm" id="add-receipt-btn">+ Record production receipt</button></div></div>
    <div class="grid grid-4" style="margin-bottom:20px;">
      <div class="stat-card"><div class="stat-label">(${stockKindLabel(stockReportKind)}) balance</div><div class="stat-value">${balancePallets}</div><div class="stat-sub">${fmtM1(balanceCans)} cans</div></div>
      <div class="stat-card"><div class="stat-label">Received in period</div><div class="stat-value">${receivedInPeriod}</div></div>
      <div class="stat-card"><div class="stat-label">Dispatched in period</div><div class="stat-value">${dispatchedInPeriod}</div></div>
      <div class="stat-card"><div class="stat-label">Open design variances</div><div class="stat-value" style="color:${openVariances.length ? 'var(--red)' : 'var(--green)'}">${openVariances.length}</div></div>
    </div>
    <div class="section-title"><h2>Receive vs dispatch ledger</h2></div>
    <div class="table-wrap" style="margin-bottom:24px;">
      <table>
        <thead><tr><th>Date</th><th>Type</th><th class="num">Pallets</th><th class="num">Cans (M)</th><th>Description</th><th>By</th></tr></thead>
        <tbody>
          ${inPeriod.length ? inPeriod.slice().sort((a, b) => a.movement_date < b.movement_date ? 1 : -1).map(m => `
            <tr>
              <td>${esc(fmtDateShort(m.movement_date))}</td>
              <td><span class="badge ${m.movement_type === 'production_receipt' ? 'badge-green' : 'badge-blue'}">${m.movement_type === 'production_receipt' ? 'Receipt' : 'Dispatch'}</span></td>
              <td class="num">${nOrDash(m.quantity_pallets)}</td>
              <td class="num">${fmtM1(m.quantity_cans_m)}</td>
              <td class="small muted">${esc(m.description || '')}</td>
              <td class="small muted">${esc(m.created_by_email || (m.movement_type === 'dispatch' ? 'auto' : ''))}</td>
            </tr>`).join('') : `<tr><td colspan="6" class="empty-state">No stock movements in this period.</td></tr>`}
        </tbody>
      </table>
    </div>

    <div class="section-title"><h2>Design stock counts (SAP vs Counted)</h2><div class="actions"><button class="btn btn-orange btn-sm" id="add-count-btn">+ Record stock count</button></div></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Design</th><th>Bin</th><th>Market</th><th>Production date</th><th class="num">SAP qty</th><th class="num">Counted qty</th><th class="num">Variance</th><th>Resolved</th><th></th></tr></thead>
        <tbody>
          ${designRecords.length ? designRecords.map(d => {
            const variance = num(d.counted_quantity) - num(d.sap_quantity);
            return `<tr>
              <td>${esc(d.design)}</td>
              <td class="small muted">${esc(d.bin_location || '')}</td>
              <td class="small">${d.market ? esc(d.market === 'local' ? 'Local' : 'Export') : ''}</td>
              <td>${esc(fmtDateShort(d.production_date))}</td>
              <td class="num">${nOrDash(d.sap_quantity)}</td>
              <td class="num">${nOrDash(d.counted_quantity)}</td>
              <td class="num" style="color:${variance !== 0 ? 'var(--red)' : 'inherit'}">${variance}</td>
              <td>${d.resolved_at ? `<span class="badge badge-green">Resolved ${esc(fmtDateShort(d.resolved_at))}</span>` : '<span class="badge badge-amber">Open</span>'}</td>
              <td>${!d.resolved_at ? `<button class="btn btn-outline btn-sm" data-resolve="${d.id}">Resolve</button>` : ''}</td>
            </tr>`;
          }).join('') : `<tr><td colspan="9" class="empty-state">No stock counts recorded yet.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
  bindPeriodFilter(stockReportState, 'stock', renderContent);
  $('#stock-kind-tabs').querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => { stockReportKind = btn.dataset.k; renderContent(); });
  });
  $('#add-receipt-btn').addEventListener('click', () => openReceiptModal(stockReportKind));
  $('#add-count-btn').addEventListener('click', () => openSohDesignModal(stockReportKind));
  content.querySelectorAll('[data-resolve]').forEach(el => el.addEventListener('click', () => openResolveVarianceModal(el.dataset.resolve)));
}

function openReceiptModal(kind) {
  openModal(`
    <div class="modal-header"><h3>Record Stock (SOH) (${stockKindLabel(kind)}) production receipt</h3><button class="modal-close" id="modal-close">&times;</button></div>
    <div class="modal-body">
      <form id="receipt-form">
        <div class="form-grid">
          <div class="field"><label>Date</label><input type="date" id="f-date" value="${todayISO()}" /></div>
          <div class="field"><label>Pallets *</label><input type="number" step="0.01" id="f-pallets" /></div>
          <div class="field"><label>Cans (M)</label><input type="number" step="0.01" id="f-cans" placeholder="auto: pallets × 5446 ÷ 1M" /></div>
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
  $('#f-pallets').addEventListener('input', () => {
    const pallets = $('#f-pallets').value;
    $('#f-cans').value = pallets ? cansFromPallets(pallets).toFixed(2) : '';
  });
  $('#modal-save').addEventListener('click', async () => {
    const pallets = $('#f-pallets').value;
    if (!pallets) { toast('Enter a pallet quantity', 'err'); return; }
    const stamp = currentUserStamp();
    try {
      await DB.createSohMovement({
        movement_type: 'production_receipt',
        kind,
        quantity_pallets: pallets,
        quantity_cans_m: $('#f-cans').value || cansFromPallets(pallets),
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

function openSohDesignModal(kind) {
  openModal(`
    <div class="modal-header"><h3>Record Stock (SOH) (${stockKindLabel(kind)}) stock count</h3><button class="modal-close" id="modal-close">&times;</button></div>
    <div class="modal-body">
      <form id="design-form">
        <div class="form-grid">
          <div class="field span-2"><label>Design *</label><input id="f-design" required /></div>
          <div class="field"><label>Bin location</label><input id="f-bin" placeholder="e.g. A-12" /></div>
          <div class="field"><label>Market</label>
            <select id="f-market"><option value="">—</option><option value="local">Local</option><option value="export">Export</option></select>
          </div>
          <div class="field"><label>Production date</label><input type="date" id="f-prod-date" /></div>
          <div class="field"><label>SAP quantity *</label><input type="number" step="0.01" id="f-sap" /></div>
          <div class="field"><label>Counted quantity *</label><input type="number" step="0.01" id="f-counted" /></div>
        </div>
      </form>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" id="modal-cancel">Cancel</button>
      <button class="btn btn-primary" id="modal-save">Record count</button>
    </div>
  `);
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-cancel').addEventListener('click', closeModal);
  $('#modal-save').addEventListener('click', async () => {
    const design = $('#f-design').value.trim();
    const sap = $('#f-sap').value, counted = $('#f-counted').value;
    if (!design) { toast('Design is required', 'err'); return; }
    if (sap === '' || counted === '') { toast('SAP and counted quantities are required', 'err'); return; }
    const stamp = currentUserStamp();
    try {
      await DB.createSohDesignRecord({
        design, kind, bin_location: $('#f-bin').value.trim() || null, market: $('#f-market').value || null, production_date: $('#f-prod-date').value || null,
        sap_quantity: sap, counted_quantity: counted,
        created_by: stamp.by, created_by_email: stamp.email
      });
      closeModal();
      toast('Stock count recorded', 'ok');
      renderContent();
    } catch (err) { toast(err.message, 'err'); }
  });
}

function openResolveVarianceModal(id) {
  openModal(`
    <div class="modal-header"><h3>Resolve variance</h3><button class="modal-close" id="modal-close">&times;</button></div>
    <div class="modal-body">
      <form id="resolve-form">
        <div class="field"><label>Date resolved</label><input type="date" id="f-resolved-date" value="${todayISO()}" /></div>
        <div class="field"><label>Notes</label><textarea id="f-notes" rows="3" placeholder="What caused it, how it was closed"></textarea></div>
      </form>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" id="modal-cancel">Cancel</button>
      <button class="btn btn-primary" id="modal-save">Mark resolved</button>
    </div>
  `);
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-cancel').addEventListener('click', closeModal);
  $('#modal-save').addEventListener('click', async () => {
    try {
      await DB.resolveSohDesignRecord(id, { resolvedAt: $('#f-resolved-date').value || todayISO(), resolutionNotes: $('#f-notes').value.trim() });
      closeModal();
      toast('Variance resolved', 'ok');
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
        <thead><tr><th>Date</th><th>Destination</th><th>PO / DN</th><th class="num">Actual pallets</th><th>Loaded by</th><th>Shift</th><th>Day/Night</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${missing.length ? missing.map(l => `
            <tr>
              <td>${esc(fmtDateShort(l.loading_date))}</td>
              <td>${destLabel(l)}</td>
              <td class="small muted">${esc(l.gzi_dn || l.gzi_po_number || '')}</td>
              <td class="num">${nOrDash(l.actual_pallets)}</td>
              <td class="small">${supervisorCell(l)}</td>
              <td class="small">${esc(l.shift || '')}</td>
              <td class="small">${l.day_night ? esc(l.day_night === 'day' ? 'Day' : 'Night') : ''}</td>
              <td><span class="badge ${STATUS_BADGE[l.status] || 'badge-gray'}">${STATUS_LABELS[l.status] || l.status}</span></td>
              <td><span class="link-btn" data-docs="${l.id}">Add document</span></td>
            </tr>`).join('') : `<tr><td colspan="9" class="empty-state">Every loaded/dispatched load has a document attached 🎉</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
  content.querySelectorAll('[data-docs]').forEach(el => el.addEventListener('click', () => openAttachmentsModal(el.dataset.docs)));
}
