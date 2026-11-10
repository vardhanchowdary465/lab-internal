/**
 * App controller: wires up auth forms, the ballot, and the live results
 * view. Deliberately framework-free (vanilla DOM) to match the project's
 * "static files on S3, zero build step" deployment model.
 */

(() => {
  const $ = (sel) => document.querySelector(sel);
  const views = {
    auth: $('#view-auth'),
    ballot: $('#view-ballot'),
    receipt: $('#view-receipt'),
    results: $('#view-results'),
  };

  let resultsTimer = null;
  let pendingSignupEmail = null;
  let selectedCandidateId = null;

  function showView(name) {
    Object.entries(views).forEach(([key, el]) => (el.hidden = key !== name));
  }

  function setMsg(formName, text, state) {
    const el = document.querySelector(`[data-msg="${formName}"]`);
    el.textContent = text || '';
    if (state) el.setAttribute('data-state', state);
    else el.removeAttribute('data-state');
  }

  // ---------------- Auth: tab switching ----------------
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('is-active'));
      tab.classList.add('is-active');
      const target = tab.dataset.tab;
      $('#form-signin').hidden = target !== 'signin';
      $('#form-signup').hidden = target !== 'signup';
      $('#form-confirm').hidden = true;
    });
  });

  // ---------------- Sign in ----------------
  $('#form-signin').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    setMsg('signin', 'Signing in…');
    try {
      await Auth.signIn({ email: fd.get('email'), password: fd.get('password') });
      setMsg('signin', '');
      await enterApp();
    } catch (err) {
      setMsg('signin', err.message, 'error');
    }
  });

  // ---------------- Sign up ----------------
  $('#form-signup').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const email = fd.get('email');
    setMsg('signup', 'Creating your account…');
    try {
      await Auth.signUp({
        email,
        password: fd.get('password'),
        fullName: fd.get('fullName'),
      });
      pendingSignupEmail = email;
      $('#confirm-email').textContent = email;
      $('#form-signup').hidden = true;
      $('#form-confirm').hidden = false;
      setMsg('signup', '');
    } catch (err) {
      setMsg('signup', err.message, 'error');
    }
  });

  // ---------------- Confirm sign up ----------------
  $('#form-confirm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    setMsg('confirm', 'Verifying…');
    try {
      await Auth.confirmSignUp({ email: pendingSignupEmail, code: fd.get('code') });
      setMsg('confirm', 'Verified. Signing you in…', 'ok');
      // Note: in production, prompt the password again rather than caching it,
      // or redirect straight to the sign-in tab. Kept simple here for clarity.
      $('#form-confirm').hidden = true;
      document.querySelector('[data-tab="signin"]').click();
      setMsg('signin', 'Account verified — please sign in.', 'ok');
    } catch (err) {
      setMsg('confirm', err.message, 'error');
    }
  });

  // ---------------- Logout ----------------
  $('#btn-logout').addEventListener('click', () => {
    Auth.signOut();
    clearInterval(resultsTimer);
    $('#voter-email').textContent = '';
    $('#btn-logout').hidden = true;
    showView('auth');
  });

  // ---------------- Ballot rendering ----------------
  async function loadBallot() {
    const { electionId } = window.VOTING_CONFIG;
    const { election, candidates } = await Api.getCandidates(electionId);

    $('#ballot-title').textContent = election.title || 'Election';
    $('#ballot-status').textContent = election.status === 'OPEN' ? 'Voting open' : 'Voting closed';
    $('#ballot-window').textContent = `Opens ${formatDate(election.startTime)} · Closes ${formatDate(election.endTime)}`;

    const list = $('#form-ballot');
    list.innerHTML = '';
    candidates.forEach((c, i) => {
      const label = document.createElement('label');
      label.className = 'ballot-option';
      label.innerHTML = `
        <span class="opt-num">${String(i + 1).padStart(2, '0')}</span>
        <input type="radio" name="candidate" value="${c.candidateId}" />
        <span>
          <span class="opt-name">${escapeHtml(c.name)}</span>
          ${c.description ? `<span class="opt-desc">${escapeHtml(c.description)}</span>` : ''}
        </span>
      `;
      list.appendChild(label);
    });

    list.addEventListener('change', (e) => {
      if (e.target.name === 'candidate') {
        selectedCandidateId = e.target.value;
        $('#btn-cast-vote').disabled = false;
      }
    });

    showView('ballot');
  }

  $('#btn-cast-vote').addEventListener('click', async () => {
    if (!selectedCandidateId) return;
    const btn = $('#btn-cast-vote');
    btn.disabled = true;
    setMsg('vote', 'Submitting your vote…');
    try {
      const result = await Api.castVote(window.VOTING_CONFIG.electionId, selectedCandidateId);
      $('#receipt-election').textContent = window.VOTING_CONFIG.electionId;
      $('#receipt-time').textContent = formatDate(result.votedAt);
      showView('receipt');
    } catch (err) {
      setMsg('vote', err.message, 'error');
      btn.disabled = false;
    }
  });

  // ---------------- Results ----------------
  $('#btn-view-results').addEventListener('click', startResultsView);

  async function startResultsView() {
    showView('results');
    $('#poll-interval').textContent = Math.round(window.VOTING_CONFIG.resultsPollIntervalMs / 1000);
    await refreshResults();
    clearInterval(resultsTimer);
    resultsTimer = setInterval(refreshResults, window.VOTING_CONFIG.resultsPollIntervalMs);
  }

  async function refreshResults() {
    try {
      const data = await Api.getResults(window.VOTING_CONFIG.electionId);
      $('#results-total').textContent = data.totalVotes;
      $('#results-updated').textContent = formatDate(data.generatedAt, true);

      const max = Math.max(1, ...data.results.map((r) => r.voteCount));
      const list = $('#results-list');
      list.innerHTML = '';
      data.results.forEach((r) => {
        const pct = Math.round((r.voteCount / max) * 100);
        const row = document.createElement('div');
        row.className = 'result-row';
        row.innerHTML = `
          <span class="r-name">${escapeHtml(r.candidateName)}</span>
          <span class="r-count">${r.voteCount}</span>
          <div class="result-bar-track"><div class="result-bar-fill" style="width:${pct}%"></div></div>
        `;
        list.appendChild(row);
      });
    } catch (err) {
      console.error('Failed to refresh results', err);
    }
  }

  // ---------------- Helpers ----------------
  function formatDate(iso, withSeconds) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString(undefined, withSeconds ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : undefined);
  }

  function escapeHtml(str = '') {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ---------------- Bootstrap ----------------
  async function enterApp() {
    const claims = Auth.decodeIdToken();
    $('#voter-email').textContent = claims?.email || '';
    $('#btn-logout').hidden = false;
    await loadBallot();
  }

  (function init() {
    if (Auth.isAuthenticated()) {
      enterApp().catch((err) => {
        console.error(err);
        showView('auth');
      });
    } else {
      showView('auth');
    }
  })();
})();
