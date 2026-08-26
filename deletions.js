/* GZI Loading Schedule — deletions.js (Manage > Deleted loads: authorisation queue + archive) */

async function renderDeletedLoads(content) {
  setTitle('Deleted loads', 'Pending deletion requests and the deleted-loads archive');
  const [pending, deleted] = await Promise.all([DB.getDeletionRequests({ status: 'pending' }), DB.getDeletedLoads()]);
  const me = currentUserStamp();

  content.innerHTML = `
    <div class="section-title"><h2>Pending authorisation (${pending.length})</h2></div>
    <div class="table-wrap" style="margin-bottom:24px;">
      <table>
        <thead><tr><th>Requested</th><th>Load</th><th>Destination</th><th>Reason</th><th>Requested by</th><th></th></tr></thead>
        <tbody>
          ${pending.length ? pending.map(r => `
            <tr>
              <td class="small muted">${esc(fmtDateTime(r.requested_at))}</td>
              <td>${esc(fmtDateShort(r.loads?.loading_date))}</td>
              <td class="small muted">${esc(r.loads?.customers?.name || r.loads?.gzi_dn || r.loads?.gzi_po_number || '')}</td>
              <td class="small">${esc(r.reason)}</td>
              <td class="small muted">${esc(r.requested_by_email || '')}</td>
              <td class="row-actions">
                ${r.requested_by === me.by
                  ? '<span class="muted small">Awaiting another user</span>'
                  : `<button class="btn btn-primary btn-sm" data-approve="${r.id}" data-load="${r.load_id}">Approve</button>
                     <button class="btn btn-outline btn-sm" data-reject="${r.id}" style="color:var(--red); border-color:#f3caca;">Reject</button>`}
              </td>
            </tr>`).join('') : `<tr><td colspan="6" class="empty-state">No deletion requests waiting on authorisation.</td></tr>`}
        </tbody>
      </table>
    </div>

    <div class="section-title"><h2>Deleted archive (${deleted.length})</h2></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Deleted</th><th>Load date</th><th>Destination</th><th>PO / DN</th><th>Deleted by</th><th></th></tr></thead>
        <tbody>
          ${deleted.length ? deleted.map(l => `
            <tr>
              <td class="small muted">${esc(fmtDateTime(l.deleted_at))}</td>
              <td>${esc(fmtDateShort(l.loading_date))}</td>
              <td class="small muted">${esc(l.customers?.name || '')}</td>
              <td class="small muted">${esc(l.gzi_dn || l.gzi_po_number || '')}</td>
              <td class="small muted">${esc(l.deleted_by_email || '')}</td>
              <td><button class="btn btn-outline btn-sm" data-restore="${l.id}">Restore</button></td>
            </tr>`).join('') : `<tr><td colspan="6" class="empty-state">No loads have been deleted yet.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;

  content.querySelectorAll('[data-approve]').forEach(el => el.addEventListener('click', async () => {
    if (!confirm('Approve this deletion? The load will move to the deleted archive.')) return;
    try {
      await DB.decideDeletionRequest(el.dataset.approve, { status: 'approved', loadId: el.dataset.load });
      toast('Deletion approved', 'ok');
      renderContent();
    } catch (err) { toast(err.message, 'err'); }
  }));
  content.querySelectorAll('[data-reject]').forEach(el => el.addEventListener('click', () => openRejectModal(el.dataset.reject)));
  content.querySelectorAll('[data-restore]').forEach(el => el.addEventListener('click', async () => {
    if (!confirm('Restore this load back into the active schedule?')) return;
    try { await DB.restoreLoad(el.dataset.restore); toast('Load restored', 'ok'); renderContent(); }
    catch (err) { toast(err.message, 'err'); }
  }));
}

function openRejectModal(requestId) {
  openModal(`
    <div class="modal-header"><h3>Reject deletion request</h3><button class="modal-close" id="modal-close">&times;</button></div>
    <div class="modal-body">
      <div class="field"><label>Reason for rejecting</label><textarea id="f-note" rows="3" placeholder="Optional"></textarea></div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" id="modal-cancel">Cancel</button>
      <button class="btn btn-primary" id="modal-save">Reject request</button>
    </div>
  `);
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-cancel').addEventListener('click', closeModal);
  $('#modal-save').addEventListener('click', async () => {
    try {
      await DB.decideDeletionRequest(requestId, { status: 'rejected', decisionNote: $('#f-note').value.trim() });
      closeModal();
      toast('Deletion request rejected', 'ok');
      renderContent();
    } catch (err) { toast(err.message, 'err'); }
  });
}
