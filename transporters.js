/* GZI Loading Schedule — transporters.js (Manage > Transporters) */

async function renderTransporters(content) {
  setTitle('Transporters', 'Manage the list of transporters used on the load form');
  content.innerHTML = `
    <div class="section-title">
      <h2>${State.transporters.length} transporters</h2>
      <div class="actions"><button class="btn btn-orange" id="add-transporter-btn">+ Add transporter</button></div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Name</th><th>Code</th><th>Contact</th><th>Phone</th><th>Status</th><th></th></tr></thead>
        <tbody id="transporter-rows">
          ${State.transporters.length ? State.transporters.map(t => `
            <tr>
              <td>${esc(t.name)}</td>
              <td class="small muted">${esc(t.code || '—')}</td>
              <td class="small">${esc(t.contact_person || '—')}</td>
              <td class="small muted">${esc(t.contact_phone || '—')}</td>
              <td><span class="badge ${t.active ? 'badge-green' : 'badge-gray'}">${t.active ? 'Active' : 'Inactive'}</span></td>
              <td class="row-actions">
                <button class="btn btn-outline btn-sm" data-edit="${t.id}">Edit</button>
                <button class="btn btn-outline btn-sm" data-delete="${t.id}" style="color:var(--red); border-color:#f3caca;">Delete</button>
              </td>
            </tr>`).join('') : `<tr><td colspan="6" class="empty-state">No transporters yet. Add your first one.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;

  $('#add-transporter-btn').addEventListener('click', () => openTransporterModal(null));
  content.querySelectorAll('[data-edit]').forEach(el => el.addEventListener('click', () => {
    openTransporterModal(State.transporters.find(t => t.id === el.dataset.edit));
  }));
  content.querySelectorAll('[data-delete]').forEach(el => el.addEventListener('click', async () => {
    const t = State.transporters.find(t => t.id === el.dataset.delete);
    if (!confirm(`Delete transporter "${t.name}"? Loads already recorded against them keep their history.`)) return;
    try {
      await DB.deleteTransporter(t.id);
      toast('Transporter deleted', 'ok');
      State.transporters = await DB.getTransporters();
      renderContent();
    } catch (err) { toast(err.message, 'err'); }
  }));
}

function openTransporterModal(transporter) {
  const isEdit = !!transporter;
  openModal(`
    <div class="modal-header"><h3>${isEdit ? 'Edit transporter' : 'Add transporter'}</h3><button class="modal-close" id="modal-close">&times;</button></div>
    <div class="modal-body">
      <form id="transporter-form">
        <div class="form-grid">
          <div class="field span-2"><label>Name *</label><input required id="f-name" value="${esc(transporter?.name || '')}" /></div>
          <div class="field"><label>Code</label><input id="f-code" value="${esc(transporter?.code || '')}" placeholder="e.g. abc-logistics" /></div>
          <div class="field"><label>Status</label>
            <select id="f-active">
              <option value="true" ${transporter?.active !== false ? 'selected' : ''}>Active</option>
              <option value="false" ${transporter?.active === false ? 'selected' : ''}>Inactive</option>
            </select>
          </div>
          <div class="field"><label>Contact person</label><input id="f-contact" value="${esc(transporter?.contact_person || '')}" /></div>
          <div class="field"><label>Contact phone</label><input id="f-phone" value="${esc(transporter?.contact_phone || '')}" /></div>
          <div class="field span-2"><label>Contact email</label><input type="email" id="f-email" value="${esc(transporter?.contact_email || '')}" /></div>
          <div class="field span-2"><label>Notes</label><textarea id="f-notes" rows="2">${esc(transporter?.notes || '')}</textarea></div>
        </div>
      </form>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" id="modal-cancel">Cancel</button>
      <button class="btn btn-primary" id="modal-save">${isEdit ? 'Save changes' : 'Add transporter'}</button>
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
      contact_person: $('#f-contact').value.trim() || null,
      contact_phone: $('#f-phone').value.trim() || null,
      contact_email: $('#f-email').value.trim() || null,
      notes: $('#f-notes').value.trim() || null,
      active: $('#f-active').value === 'true'
    };
    const stamp = currentUserStamp();
    if (isEdit) { payload.updated_by = stamp.by; payload.updated_by_email = stamp.email; payload.updated_at = new Date().toISOString(); }
    else { payload.created_by = stamp.by; payload.created_by_email = stamp.email; }
    try {
      if (isEdit) await DB.updateTransporter(transporter.id, payload);
      else await DB.createTransporter({ ...payload, sort_order: State.transporters.length });
      closeModal();
      toast(isEdit ? 'Transporter updated' : 'Transporter added', 'ok');
      State.transporters = await DB.getTransporters();
      renderContent();
    } catch (err) { toast(err.message, 'err'); }
  });
}
