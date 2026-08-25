/* GZI Loading Schedule — supervisors.js (Manage > Supervisors) */

async function renderSupervisors(content) {
  setTitle('Supervisors', 'Manage the list of supervisors used on the load form');
  content.innerHTML = `
    <div class="section-title">
      <h2>${State.supervisors.length} supervisors</h2>
      <div class="actions"><button class="btn btn-orange" id="add-supervisor-btn">+ Add supervisor</button></div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Name</th><th>Shift</th><th>Status</th><th></th></tr></thead>
        <tbody id="supervisor-rows">
          ${State.supervisors.length ? State.supervisors.map(s => `
            <tr>
              <td>${esc(s.name)}</td>
              <td>${s.shift ? `<span class="badge badge-blue">Shift ${esc(s.shift)}</span>` : '<span class="muted small">—</span>'}</td>
              <td><span class="badge ${s.active ? 'badge-green' : 'badge-gray'}">${s.active ? 'Active' : 'Inactive'}</span></td>
              <td class="row-actions">
                <button class="btn btn-outline btn-sm" data-edit="${s.id}">Edit</button>
                <button class="btn btn-outline btn-sm" data-delete="${s.id}" style="color:var(--red); border-color:#f3caca;">Delete</button>
              </td>
            </tr>`).join('') : `<tr><td colspan="4" class="empty-state">No supervisors yet. Add your first one.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;

  $('#add-supervisor-btn').addEventListener('click', () => openSupervisorModal(null));
  content.querySelectorAll('[data-edit]').forEach(el => el.addEventListener('click', () => {
    openSupervisorModal(State.supervisors.find(s => s.id === el.dataset.edit));
  }));
  content.querySelectorAll('[data-delete]').forEach(el => el.addEventListener('click', async () => {
    const s = State.supervisors.find(s => s.id === el.dataset.delete);
    if (!confirm(`Delete supervisor "${s.name}"? Loads already recorded against them keep their history.`)) return;
    try {
      await DB.deleteSupervisor(s.id);
      toast('Supervisor deleted', 'ok');
      State.supervisors = await DB.getSupervisors();
      renderContent();
    } catch (err) { toast(err.message, 'err'); }
  }));
}

function openSupervisorModal(supervisor) {
  const isEdit = !!supervisor;
  openModal(`
    <div class="modal-header"><h3>${isEdit ? 'Edit supervisor' : 'Add supervisor'}</h3><button class="modal-close" id="modal-close">&times;</button></div>
    <div class="modal-body">
      <form id="supervisor-form">
        <div class="form-grid">
          <div class="field span-2"><label>Name *</label><input required id="f-name" value="${esc(supervisor?.name || '')}" /></div>
          <div class="field"><label>Shift *</label>
            <select id="f-shift" required>
              <option value="">— Select shift —</option>
              ${['A', 'B', 'C', 'D'].map(s => `<option value="${s}" ${supervisor?.shift === s ? 'selected' : ''}>Shift ${s}</option>`).join('')}
            </select>
          </div>
          <div class="field"><label>Status</label>
            <select id="f-active">
              <option value="true" ${supervisor?.active !== false ? 'selected' : ''}>Active</option>
              <option value="false" ${supervisor?.active === false ? 'selected' : ''}>Inactive</option>
            </select>
          </div>
        </div>
      </form>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" id="modal-cancel">Cancel</button>
      <button class="btn btn-primary" id="modal-save">${isEdit ? 'Save changes' : 'Add supervisor'}</button>
    </div>
  `);
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-cancel').addEventListener('click', closeModal);
  $('#modal-save').addEventListener('click', async () => {
    const name = $('#f-name').value.trim();
    const shift = $('#f-shift').value;
    if (!name) { toast('Name is required', 'err'); return; }
    if (!shift) { toast('Select a shift', 'err'); return; }
    const payload = { name, shift, active: $('#f-active').value === 'true' };
    try {
      if (isEdit) await DB.updateSupervisor(supervisor.id, payload);
      else await DB.createSupervisor({ ...payload, sort_order: State.supervisors.length });
      closeModal();
      toast(isEdit ? 'Supervisor updated' : 'Supervisor added', 'ok');
      State.supervisors = await DB.getSupervisors();
      renderContent();
    } catch (err) { toast(err.message, 'err'); }
  });
}
