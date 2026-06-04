// ── State ─────────────────────────────────────────────────────────────────────
let pendingUrl = null;

// ── Init ──────────────────────────────────────────────────────────────────────
(async function init() {
  try {
    const res = await fetch('/api/provider');
    if (res.status === 401) { window.location.href = '/'; return; }
    const { provider } = await res.json();
    document.getElementById('provider-badge').textContent = provider === 'anthropic' ? 'Claude' : 'GPT-4o';
  } catch {
    document.getElementById('provider-badge').textContent = 'AI';
  }
})();

// Allow Enter key in the URL field
document.getElementById('url-input').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') handleSubmit();
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function show(id)   { document.getElementById(id).classList.remove('hidden'); }
function hide(id)   { document.getElementById(id).classList.add('hidden'); }
function text(id, t){ document.getElementById(id).textContent = t; }

function resetUI() {
  hide('spinner');
  hide('confirm-card');
  hide('api-error');
  hide('result-card');
  hide('url-error');
  pendingUrl = null;
}

function setLoading(msg) {
  hide('url-error');
  hide('api-error');
  hide('confirm-card');
  hide('result-card');
  text('spinner-msg', msg);
  show('spinner');
  document.getElementById('summarize-btn').disabled = true;
  document.getElementById('url-input').disabled = true;
}

function clearLoading() {
  hide('spinner');
  document.getElementById('summarize-btn').disabled = false;
  document.getElementById('url-input').disabled = false;
}

function showError(id, msg) {
  clearLoading();
  text(id, msg);
  show(id);
}

// ── Submit ─────────────────────────────────────────────────────────────────────
async function handleSubmit() {
  resetUI();
  const url = document.getElementById('url-input').value.trim();

  if (!url) {
    showError('url-error', 'Please enter a YouTube URL.');
    return;
  }

  await doSummarize(url, false);
}

async function doSummarize(url, confirmed) {
  setLoading('Fetching transcript…');

  let res, data;
  try {
    res = await fetch('/api/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, confirmed }),
    });
    data = await res.json();
  } catch {
    showError('api-error', 'Network error — please check your connection and try again.');
    return;
  }

  if (res.status === 401) { window.location.href = '/'; return; }

  if (res.status === 202 && data.requiresConfirmation) {
    clearLoading();
    pendingUrl = url;
    showConfirmation(data.message, data.durationMinutes);
    return;
  }

  if (!res.ok) {
    showError('api-error', data.error || 'Something went wrong. Please try again.');
    return;
  }

  clearLoading();
  renderResult(data.summary);
}

// ── Long-video confirmation ────────────────────────────────────────────────────
function showConfirmation(message, durationMinutes) {
  text('confirm-msg', message);
  show('confirm-card');

  const yesBtn = document.getElementById('confirm-yes');
  yesBtn.disabled = true;

  let remaining = 3;
  text('countdown-msg', `You can confirm in ${remaining} seconds…`);

  const interval = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(interval);
      yesBtn.disabled = false;
      hide('countdown-msg');
    } else {
      text('countdown-msg', `You can confirm in ${remaining} second${remaining !== 1 ? 's' : ''}…`);
    }
  }, 1000);
}

function confirmSummarize() {
  hide('confirm-card');
  if (!pendingUrl) return;
  const url = pendingUrl;
  pendingUrl = null;
  doSummarize(url, true);
}

function cancelConfirm() {
  resetUI();
  document.getElementById('summarize-btn').disabled = false;
  document.getElementById('url-input').disabled = false;
}

// ── Render ─────────────────────────────────────────────────────────────────────
function renderResult(markdown) {
  const output = document.getElementById('md-output');
  output.innerHTML = marked.parse(markdown);
  show('result-card');
  // Scroll to results on mobile
  document.getElementById('result-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
