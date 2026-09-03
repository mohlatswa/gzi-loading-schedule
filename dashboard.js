/* GZI Loading Schedule — dashboard.js (Overview > Dashboard) */

let dashboardState = makePeriodState('month');

async function renderDashboard(content) {
  setTitle('Dashboard', 'Everything at a glance for the selected period');
  const { from, to } = periodRangeFor(dashboardState);
  const [loads, sohAll, settings] = await Promise.all([
    DB.getLoads({ dateFrom: from, dateTo: to }),
    DB.getSohMovements(),
    DB.getDashboardSettings()
  ]);

  const totalPlannedCans = loads.reduce((s, l) => s + (cansFromPallets(l.planned_pallets) || 0), 0);
  const totalActualCans = loads.reduce((s, l) => s + (cansFromPallets(l.actual_pallets) || 0), 0);
  const deviationLoads = loads.filter(l => (l.status === 'loaded' || l.status === 'dispatched') && num(l.actual_pallets) !== num(l.planned_pallets));

  const sohToDate = sohAll.filter(m => !to || m.movement_date <= to);
  const sohCansByKind = (kind) => sohToDate.filter(m => m.kind === kind).reduce((s, m) => s + (m.movement_type === 'production_receipt' ? num(m.quantity_cans_m) : -num(m.quantity_cans_m)), 0);
  const sohFgCans = sohCansByKind('FG');
  const sohHfiCans = sohCansByKind('HFI');
  const spaceUsed = sohFgCans + sohHfiCans;
  const spaceUtilPct = TOTAL_SOH_CAPACITY_M > 0 ? (spaceUsed / TOTAL_SOH_CAPACITY_M) * 100 : null;

  const aop = settings.monthly_aop;
  const aopPct = (aop && aop > 0) ? (totalActualCans / aop) * 100 : null;

  const byCustomerCans = {};
  loads.forEach(l => { const n = destLabelPlain(l); byCustomerCans[n] = (byCustomerCans[n] || 0) + (cansFromPallets(l.actual_pallets) || 0); });
  const custEntries = Object.entries(byCustomerCans).filter(e => e[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([n, v]) => [n, round2(v)]);

  const sohByCustomer = {};
  sohToDate.forEach(m => {
    const name = m.customers?.name || 'Unassigned';
    const sign = m.movement_type === 'production_receipt' ? 1 : -1;
    sohByCustomer[name] = (sohByCustomer[name] || 0) + sign * num(m.quantity_cans_m);
  });
  const sohCustEntries = Object.entries(sohByCustomer).filter(e => Math.abs(e[1]) > 0.0001).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([n, v]) => [n, round2(v)]);

  content.innerHTML = `
    ${periodFilterHtml(dashboardState, 'dash')}
    <div class="grid grid-4" style="margin-bottom:20px;">
      <div class="stat-card"><div class="stat-label">Planned / Actual (M)</div><div class="stat-value">${fmtM1(totalPlannedCans)} / ${fmtM1(totalActualCans)}</div><div class="stat-sub">planned / actual cans</div></div>
      <div class="stat-card"><div class="stat-label">MTD (m)</div><div class="stat-value">${fmtM1(totalActualCans)}</div><div class="stat-sub">planned ${fmtM1(totalPlannedCans)}</div></div>
      <div class="stat-card">
        <div class="stat-label">Monthly AOP</div>
        <div class="stat-value"><input type="number" step="0.1" min="0" class="stat-input" id="dash-aop" value="${aop ?? ''}" placeholder="—" />m</div>
        <div class="stat-sub">${aopPct === null ? 'set a monthly target' : aopPct.toFixed(0) + '% achieved (' + fmtM1(totalActualCans) + ')'}</div>
      </div>
      <div class="stat-card"><div class="stat-label">Loads with a deviation</div><div class="stat-value" style="color:${deviationLoads.length ? 'var(--red)' : 'var(--green)'}">${deviationLoads.length}</div></div>
    </div>
    <div class="grid grid-2" style="margin-bottom:20px;">
      <div class="stat-card">
        <div class="stat-label">Days cover — Local RPM</div>
        <div class="stat-value"><input type="number" step="0.1" min="0" class="stat-input" id="dash-dc-local" value="${settings.days_cover_local ?? ''}" placeholder="—" /> days</div>
        <div class="stat-sub">enter current days cover</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Days cover — Export RPM</div>
        <div class="stat-value"><input type="number" step="0.1" min="0" class="stat-input" id="dash-dc-export" value="${settings.days_cover_export ?? ''}" placeholder="—" /> days</div>
        <div class="stat-sub">enter current days cover</div>
      </div>
    </div>
    <div class="grid grid-3" style="margin-bottom:20px;">
      <div class="stat-card"><div class="stat-label">SOH FG</div><div class="stat-value">${fmtM1(sohFgCans)}</div><div class="stat-sub">as of ${fmtDate(to)}</div></div>
      <div class="stat-card"><div class="stat-label">HFI</div><div class="stat-value">${fmtM1(sohHfiCans)}</div><div class="stat-sub">as of ${fmtDate(to)}</div></div>
      <div class="stat-card"><div class="stat-label">Total space utilisation</div><div class="stat-value">${spaceUtilPct === null ? '—' : spaceUtilPct.toFixed(1) + '%'}</div><div class="stat-sub">${fmtM1(spaceUsed)} / ${TOTAL_SOH_CAPACITY_M}m capacity</div></div>
    </div>
    <div class="grid grid-2" style="margin-bottom:20px;">
      <div class="card chart-card">
        <div class="section-title"><h2>Customer breakdown (M)</h2></div>
        <canvas id="dash-chart-customers"></canvas>
      </div>
      <div class="card chart-card">
        <div class="section-title"><h2>SOH by customer (M)</h2><div class="stat-sub">balance as of ${fmtDate(to)}</div></div>
        <canvas id="dash-chart-soh-customers"></canvas>
      </div>
    </div>
  `;
  bindPeriodFilter(dashboardState, 'dash', renderContent);

  async function saveSetting(key, raw, rerender) {
    const value = raw === '' ? null : Number(raw);
    if (value !== null && (isNaN(value) || value < 0)) { toast('Enter a valid number', 'err'); return; }
    try {
      await DB.setDashboardSetting(key, value);
      toast('Saved', 'ok');
      if (rerender) renderContent();
    } catch (err) { toast(err.message, 'err'); }
  }
  $('#dash-aop').addEventListener('change', (e) => saveSetting('monthly_aop', e.target.value, true));
  $('#dash-dc-local').addEventListener('change', (e) => saveSetting('days_cover_local', e.target.value, false));
  $('#dash-dc-export').addEventListener('change', (e) => saveSetting('days_cover_export', e.target.value, false));

  Object.values(State.charts).forEach(c => c && c.destroy());
  State.charts.dashCustomers = new Chart($('#dash-chart-customers'), {
    type: 'bar',
    data: { labels: custEntries.map(e => e[0]), datasets: [{ label: 'Cans (M)', data: custEntries.map(e => e[1]), backgroundColor: '#2563eb', borderRadius: 4 }] },
    options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { ticks: { autoSkip: false, maxRotation: 40, minRotation: 20 } } } }
  });
  State.charts.dashSohCustomers = new Chart($('#dash-chart-soh-customers'), {
    type: 'bar',
    data: { labels: sohCustEntries.map(e => e[0]), datasets: [{ label: 'SOH cans (M)', data: sohCustEntries.map(e => e[1]), backgroundColor: '#16a34a', borderRadius: 4 }] },
    options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { ticks: { autoSkip: false, maxRotation: 40, minRotation: 20 } } } }
  });
}
