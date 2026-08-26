/* GZI Loading Schedule — dashboard.js (Overview > Dashboard) */

let dashboardState = makePeriodState('month');

async function renderDashboard(content) {
  setTitle('Dashboard', 'Everything at a glance for the selected period');
  const { from, to } = periodRangeFor(dashboardState);
  const [loads, dispatches, rpmAll, sohAll, attachmentIds] = await Promise.all([
    DB.getLoads({ dateFrom: from, dateTo: to }),
    DB.getWarehouseDispatches({ dateFrom: from, dateTo: to }),
    DB.getRpmMovements(),
    DB.getSohMovements(),
    DB.getAllAttachmentLoadIds()
  ]);

  const totalPlanned = loads.reduce((s, l) => s + num(l.planned_pallets), 0);
  const totalActual = loads.reduce((s, l) => s + num(l.actual_pallets), 0);
  const totalPlannedCans = loads.reduce((s, l) => s + (cansFromPallets(l.planned_pallets) || 0), 0);
  const totalActualCans = loads.reduce((s, l) => s + (cansFromPallets(l.actual_pallets) || 0), 0);
  const deviationLoads = loads.filter(l => (l.status === 'loaded' || l.status === 'dispatched') && num(l.actual_pallets) !== num(l.planned_pallets));
  const missing = loads.filter(l => (l.status === 'loaded' || l.status === 'dispatched') && !attachmentIds.has(l.id));

  const rpmToDate = rpmAll.filter(r => !to || r.movement_date <= to);
  const rpmOutstanding = rpmToDate.reduce((s, r) => s + (r.direction === 'sent' ? num(r.quantity_pallets) : -num(r.quantity_pallets)), 0);
  const sohToDate = sohAll.filter(m => !to || m.movement_date <= to);
  const sohCansByKind = (kind) => sohToDate.filter(m => m.kind === kind).reduce((s, m) => s + (m.movement_type === 'production_receipt' ? num(m.quantity_cans_m) : -num(m.quantity_cans_m)), 0);
  const sohFgCans = sohCansByKind('FG');
  const sohHfiCans = sohCansByKind('HFI');
  const spaceUsed = sohFgCans + sohHfiCans;
  const spaceUtilPct = TOTAL_SOH_CAPACITY_M > 0 ? (spaceUsed / TOTAL_SOH_CAPACITY_M) * 100 : null;

  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) { days.push(d); if (days.length > 60) break; }
  const plannedByDay = {}, actualByDay = {};
  days.forEach(d => { plannedByDay[d] = 0; actualByDay[d] = 0; });
  loads.forEach(l => {
    if (l.loading_date && plannedByDay[l.loading_date] !== undefined) {
      plannedByDay[l.loading_date] += num(l.planned_pallets);
      actualByDay[l.loading_date] += num(l.actual_pallets);
    }
  });

  const byCustomer = {};
  loads.forEach(l => { const n = destLabelPlain(l); byCustomer[n] = (byCustomer[n] || 0) + num(l.actual_pallets); });
  const custEntries = Object.entries(byCustomer).sort((a, b) => b[1] - a[1]).slice(0, 8);

  const whRows = State.warehouses.map(w => ({
    name: w.name,
    sent: loads.filter(l => l.destination_type === 'warehouse' && l.warehouse_id === w.id).reduce((s, l) => s + num(l.actual_pallets), 0),
    shipped: dispatches.filter(d => d.warehouse_id === w.id).reduce((s, d) => s + num(d.actual_pallets), 0)
  }));

  content.innerHTML = `
    ${periodFilterHtml(dashboardState, 'dash')}
    <div class="grid grid-4" style="margin-bottom:20px;">
      <div class="stat-card"><div class="stat-label">Planned / Actual pallets</div><div class="stat-value">${totalPlanned} / ${totalActual}</div></div>
      <div class="stat-card"><div class="stat-label">Cans (M)</div><div class="stat-value">${fmtM1(totalActualCans)} (${fmtM1(totalPlannedCans)})</div><div class="stat-sub">actual (planned)</div></div>
      <div class="stat-card"><div class="stat-label">Loads with a deviation</div><div class="stat-value" style="color:${deviationLoads.length ? 'var(--red)' : 'var(--green)'}">${deviationLoads.length}</div></div>
      <div class="stat-card"><div class="stat-label">RPM outstanding</div><div class="stat-value">${rpmOutstanding}</div><div class="stat-sub">pallets</div></div>
    </div>
    <div class="grid grid-3" style="margin-bottom:20px;">
      <div class="stat-card"><div class="stat-label">SOH FG</div><div class="stat-value">${fmtM1(sohFgCans)}</div><div class="stat-sub">as of ${fmtDate(to)}</div></div>
      <div class="stat-card"><div class="stat-label">HFI</div><div class="stat-value">${fmtM1(sohHfiCans)}</div><div class="stat-sub">as of ${fmtDate(to)}</div></div>
      <div class="stat-card"><div class="stat-label">Total space utilisation</div><div class="stat-value">${spaceUtilPct === null ? '—' : spaceUtilPct.toFixed(1) + '%'}</div><div class="stat-sub">${fmtM1(spaceUsed)} / ${TOTAL_SOH_CAPACITY_M}m capacity</div></div>
    </div>
    <div class="grid grid-2" style="margin-bottom:20px;">
      <div class="card chart-card">
        <div class="section-title"><h2>Planned vs actual pallets</h2></div>
        <canvas id="dash-chart-trend"></canvas>
      </div>
      <div class="card chart-card">
        <div class="section-title"><h2>Top customers (actual pallets)</h2></div>
        <canvas id="dash-chart-customers"></canvas>
      </div>
    </div>
    <div class="grid grid-2" style="margin-bottom:20px;">
      <div class="card chart-card">
        <div class="section-title"><h2>Warehouse: sent vs shipped</h2></div>
        <canvas id="dash-chart-warehouse"></canvas>
      </div>
      <div class="card">
        <div class="section-title"><h2>Attention needed</h2></div>
        <div class="stat-card" style="margin-bottom:10px;"><div class="stat-label">Missing attachments</div><div class="stat-value">${missing.length}</div></div>
        <div class="stat-card"><div class="stat-label">Loads with a deviation</div><div class="stat-value">${deviationLoads.length}</div></div>
      </div>
    </div>
  `;
  bindPeriodFilter(dashboardState, 'dash', renderContent);

  Object.values(State.charts).forEach(c => c && c.destroy());
  State.charts.dashTrend = new Chart($('#dash-chart-trend'), {
    type: 'line',
    data: {
      labels: days.map(d => fmtDateShort(d)),
      datasets: [
        { label: 'Planned', data: days.map(d => plannedByDay[d]), borderColor: '#94a3b8', backgroundColor: 'transparent', tension: 0.25 },
        { label: 'Actual', data: days.map(d => actualByDay[d]), borderColor: '#2563eb', backgroundColor: 'transparent', tension: 0.25 }
      ]
    },
    options: { responsive: true, plugins: { legend: { display: true }, datalabels: { display: false } } }
  });
  State.charts.dashCustomers = new Chart($('#dash-chart-customers'), {
    type: 'bar',
    data: { labels: custEntries.map(e => e[0]), datasets: [{ label: 'Actual pallets', data: custEntries.map(e => e[1]), backgroundColor: '#2563eb', borderRadius: 4 }] },
    options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { ticks: { autoSkip: false, maxRotation: 40, minRotation: 20 } } } }
  });
  State.charts.dashWarehouse = new Chart($('#dash-chart-warehouse'), {
    type: 'bar',
    data: {
      labels: whRows.map(r => r.name),
      datasets: [
        { label: 'Sent to warehouse', data: whRows.map(r => r.sent), backgroundColor: '#2563eb', borderRadius: 4 },
        { label: 'Shipped to customers', data: whRows.map(r => r.shipped), backgroundColor: '#16a34a', borderRadius: 4 }
      ]
    },
    options: { responsive: true, plugins: { legend: { display: true } } }
  });
}
