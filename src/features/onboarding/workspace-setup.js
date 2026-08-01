// One-time post-invite wizard: workspace name confirm + business-goal pick.
// Shown by boot.js's main() when a real 'live' tenant's business_goal is
// still null — see docs/superpowers/specs/2026-07-30-tenant-workspace-setup-design.md.
import { getCachedSession } from '../../lib/auth.js';

export function showWorkspaceSetup(tenant, onComplete) {
  const panel = document.getElementById('workspace-setup');
  const form = document.getElementById('ws-form');
  const err = document.getElementById('ws-err');
  const nameInput = document.getElementById('ws-name');
  if (!panel || !form) return;

  nameInput.value = tenant.name || '';
  panel.style.display = 'grid';

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.style.display = 'none';

    const selected = form.querySelector('input[name="ws-goal"]:checked');
    if (!selected) {
      err.textContent = 'Please choose a goal.';
      err.style.display = 'block';
      return;
    }
    const businessGoal = selected.value === '__other__'
      ? document.getElementById('ws-goal-other').value.trim()
      : selected.value;
    if (!businessGoal) {
      err.textContent = 'Please tell us your goal.';
      err.style.display = 'block';
      return;
    }

    const submitBtn = form.querySelector('.ws-cta');
    submitBtn.disabled = true;
    try {
      const session = getCachedSession();
      const r = await fetch('https://api.livinit.ai/simulator/tenant', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.accessToken}`,
        },
        body: JSON.stringify({ business_goal: businessGoal, name: nameInput.value.trim() || undefined }),
      });
      if (r.status === 403) {
        err.textContent = "You don't have permission to complete this — contact your workspace admin.";
        err.style.display = 'block';
        return;
      }
      if (!r.ok) throw new Error(`tenant update: ${r.status}`);
      const updated = await r.json();
      panel.style.display = 'none';
      onComplete({ ...tenant, businessGoal: updated.business_goal, name: updated.name });
    } catch (e2) {
      err.textContent = "Couldn't save — check your connection and try again.";
      err.style.display = 'block';
      console.error('workspace setup save failed', e2);
    } finally {
      submitBtn.disabled = false;
    }
  });
}
