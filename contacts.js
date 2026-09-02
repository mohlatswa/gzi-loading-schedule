/* GZI Loading Schedule — contacts.js (Manage > Contacts) */

const CONTACT_TYPES = ['Customer', 'Transporter', 'Supplier', 'Internal / GZI', 'Other'];

function contactName(c) { return [c.first_name, c.last_name].filter(Boolean).join(' '); }

async function renderContacts(content) {
  setTitle('Contacts', 'Shared address book — customers, transporters, suppliers and internal staff');
  content.innerHTML = `
    <div class="section-title">
      <h2>${State.contacts.length} contacts</h2>
      <div class="actions"><button class="btn btn-orange" id="add-contact-btn">+ Add contact</button></div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Name</th><th>Company</th><th>Job title</th><th>Category</th><th>Email</th><th>Contact number</th><th>Status</th><th></th></tr></thead>
        <tbody id="contact-rows">
          ${State.contacts.length ? State.contacts.map(c => `
            <tr>
              <td>${esc(contactName(c)) || '<span class="muted small">—</span>'}</td>
              <td class="small">${esc(c.company || '—')}</td>
              <td class="small muted">${esc(c.job_title || '—')}</td>
              <td class="small">${c.contact_type ? `<span class="badge badge-blue">${esc(c.contact_type)}</span>` : '<span class="muted small">—</span>'}</td>
              <td class="small">${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : '<span class="muted small">—</span>'}</td>
              <td class="small muted">${esc(c.phone || c.mobile || '—')}</td>
              <td><span class="badge ${c.active ? 'badge-green' : 'badge-gray'}">${c.active ? 'Active' : 'Inactive'}</span></td>
              <td class="row-actions">
                <button class="btn btn-outline btn-sm" data-edit="${c.id}">Edit</button>
                <button class="btn btn-outline btn-sm" data-delete="${c.id}" style="color:var(--red); border-color:#f3caca;">Delete</button>
              </td>
            </tr>`).join('') : `<tr><td colspan="8" class="empty-state">No contacts yet. Add your first one.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;

  $('#add-contact-btn').addEventListener('click', () => openContactModal(null));
  content.querySelectorAll('[data-edit]').forEach(el => el.addEventListener('click', () => {
    openContactModal(State.contacts.find(c => c.id === el.dataset.edit));
  }));
  content.querySelectorAll('[data-delete]').forEach(el => el.addEventListener('click', async () => {
    const c = State.contacts.find(c => c.id === el.dataset.delete);
    if (!confirm(`Delete contact "${contactName(c) || 'this contact'}"?`)) return;
    try {
      await DB.deleteContact(c.id);
      toast('Contact deleted', 'ok');
      State.contacts = await DB.getContacts();
      renderContent();
    } catch (err) { toast(err.message, 'err'); }
  }));
}

function openContactModal(contact) {
  const isEdit = !!contact;
  openModal(`
    <div class="modal-header"><h3>${isEdit ? 'Edit contact' : 'Add contact'}</h3><button class="modal-close" id="modal-close">&times;</button></div>
    <div class="modal-body">
      <form id="contact-form">
        <div class="form-grid">
          <div class="field"><label>Name *</label><input required id="f-first" value="${esc(contact?.first_name || '')}" placeholder="First name" /></div>
          <div class="field"><label>Surname</label><input id="f-last" value="${esc(contact?.last_name || '')}" placeholder="Last name" /></div>
          <div class="field"><label>Company name</label><input id="f-company" value="${esc(contact?.company || '')}" /></div>
          <div class="field"><label>Job title</label><input id="f-title" value="${esc(contact?.job_title || '')}" /></div>
          <div class="field"><label>Category</label>
            <select id="f-type">
              <option value="">—</option>
              ${CONTACT_TYPES.map(t => `<option value="${t}" ${contact?.contact_type === t ? 'selected' : ''}>${t}</option>`).join('')}
            </select>
          </div>
          <div class="field"><label>Status</label>
            <select id="f-active">
              <option value="true" ${contact?.active !== false ? 'selected' : ''}>Active</option>
              <option value="false" ${contact?.active === false ? 'selected' : ''}>Inactive</option>
            </select>
          </div>
          <div class="field span-2"><label>Email address</label><input type="email" id="f-email" value="${esc(contact?.email || '')}" /></div>
          <div class="field"><label>Contact number</label><input id="f-phone" value="${esc(contact?.phone || '')}" /></div>
          <div class="field"><label>Alternative / mobile</label><input id="f-mobile" value="${esc(contact?.mobile || '')}" /></div>
          <div class="field span-2"><label>Notes</label><textarea id="f-notes" rows="2">${esc(contact?.notes || '')}</textarea></div>
        </div>
      </form>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" id="modal-cancel">Cancel</button>
      <button class="btn btn-primary" id="modal-save">${isEdit ? 'Save changes' : 'Add contact'}</button>
    </div>
  `);
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-cancel').addEventListener('click', closeModal);
  $('#modal-save').addEventListener('click', async () => {
    const first_name = $('#f-first').value.trim();
    if (!first_name) { toast('Name is required', 'err'); return; }
    const payload = {
      first_name,
      last_name: $('#f-last').value.trim() || null,
      company: $('#f-company').value.trim() || null,
      job_title: $('#f-title').value.trim() || null,
      contact_type: $('#f-type').value || null,
      email: $('#f-email').value.trim() || null,
      phone: $('#f-phone').value.trim() || null,
      mobile: $('#f-mobile').value.trim() || null,
      notes: $('#f-notes').value.trim() || null,
      active: $('#f-active').value === 'true'
    };
    const stamp = currentUserStamp();
    if (isEdit) { payload.updated_by = stamp.by; payload.updated_by_email = stamp.email; payload.updated_at = new Date().toISOString(); }
    else { payload.created_by = stamp.by; payload.created_by_email = stamp.email; }
    try {
      if (isEdit) await DB.updateContact(contact.id, payload);
      else await DB.createContact({ ...payload, sort_order: State.contacts.length });
      closeModal();
      toast(isEdit ? 'Contact updated' : 'Contact added', 'ok');
      State.contacts = await DB.getContacts();
      renderContent();
    } catch (err) { toast(err.message, 'err'); }
  });
}
