const byId = id => document.getElementById(id);
const root = document.documentElement;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const storyZones = [...document.querySelectorAll('.story-zone')];
const storyVideos = storyZones.map(zone => zone.querySelector('.story-video'));
const ambientVideo = document.querySelector('.dashboard-ambient');
const dashboardView = byId('dashboardView');
const transitionLayer = byId('viewTransition');
const transitionVideo = transitionLayer.querySelector('video');

let selectedBranch = null;
let latestState = null;
let scrollFrame = 0;
let transitionBusy = false;
let lastRenderedSignature = '';
let pollInFlight = false;
let noticeTimer = 0;

function esc(value) {
  const escapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value ?? '').replace(/[&<>"']/g, character => escapeMap[character]);
}

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

function whyText(branch) {
  const verdict = branch.verdict;
  if (!verdict) return branch.patchLuau ? 'Patch proposed; awaiting verification.' : 'Waiting for a patch.';
  if (verdict.error) return `Engine error: ${verdict.error.slice(0, 100)}`;
  if (verdict.inert) return 'Treatment and control were identical. The patch had no causal effect.';
  const reasons = [];
  if (verdict.missing?.length) reasons.push(`missing ${verdict.missing.join(', ')}`);
  if (verdict.collateral?.length) reasons.push(`collateral movement in ${verdict.collateral.join(', ')}`);
  if (reasons.length === 0) return 'Every required effect occurred and nothing else moved.';
  return reasons.join('; ');
}

function verdictClass(branch) {
  if (!branch.verdict) return 'pending';
  return branch.verdict.accepted ? 'accept' : 'reject';
}

function updateStory() {
  scrollFrame = 0;
  if (root.dataset.view !== 'landing') return;

  let closest = storyZones[0];
  let closestDistance = Number.POSITIVE_INFINITY;

  storyZones.forEach((zone, index) => {
    const rect = zone.getBoundingClientRect();
    const range = Math.max(1, zone.offsetHeight - window.innerHeight);
    const progress = clamp(-rect.top / range, 0, 1);
    const distance = Math.abs(rect.top + rect.height / 2 - window.innerHeight / 2);
    if (distance < closestDistance) {
      closestDistance = distance;
      closest = zone;
    }

    const video = storyVideos[index];
    if (!reducedMotion.matches && video?.duration && rect.bottom > -window.innerHeight && rect.top < window.innerHeight * 2) {
      const targetTime = progress * Math.max(0, video.duration - .035);
      if (Math.abs(video.currentTime - targetTime) > .035) video.currentTime = targetTime;
    }
  });

  storyZones.forEach(zone => zone.classList.toggle('is-active', zone === closest));
  document.querySelectorAll('[data-depth]').forEach(link => {
    link.classList.toggle('is-active', link.dataset.depth === closest.dataset.zone);
  });

  // Scrubbed by scroll, never self-playing.
  //
  // These were also `loop = true` and `play()`d whenever their zone was the
  // closest one, while the block above simultaneously drove `currentTime` from
  // scroll progress. The two fight: the video runs on its own clock and loops
  // forever whether or not the reader is scrolling, which is exactly the
  // "videos play repeatedly even without scrolling" complaint. Playback is the
  // scroll position; there is nothing else for it to be.
  storyVideos.forEach(video => {
    video.loop = false;
    if (!video.paused) video.pause();
  });
}

function scheduleStoryUpdate() {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(updateStory);
}

function seekWhenReady(video, time) {
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      resolve();
    };
    const apply = () => {
      try {
        video.currentTime = clamp(time, 0, Math.max(0, video.duration || time));
      } catch {
        finish();
        return;
      }
      if (video.readyState >= 2) finish();
      else video.addEventListener('canplay', finish, { once: true });
    };
    const timeout = window.setTimeout(finish, 1800);
    if (Number.isFinite(video.duration)) apply();
    else video.addEventListener('loadedmetadata', apply, { once: true });
  });
}

function waitForVideoEnd(video) {
  return new Promise(resolve => {
    const fallback = window.setTimeout(resolve, 5200);
    video.addEventListener('ended', () => {
      window.clearTimeout(fallback);
      resolve();
    }, { once: true });
  });
}

async function scrubVideoReverse(video) {
  await seekWhenReady(video, video.duration || 4);
  const duration = video.duration || 4;
  const started = performance.now();
  return new Promise(resolve => {
    const frame = now => {
      const progress = clamp((now - started) / (duration * 1000), 0, 1);
      video.currentTime = duration * (1 - progress);
      if (progress < 1) requestAnimationFrame(frame);
      else resolve();
    };
    requestAnimationFrame(frame);
  });
}

async function fadeTransitionAway() {
  transitionLayer.classList.add('is-fading');
  await new Promise(resolve => window.setTimeout(resolve, 360));
  transitionLayer.hidden = true;
  transitionLayer.classList.remove('is-fading');
}

function setDashboardVisible(pushHistory) {
  root.dataset.view = 'dashboard';
  storyVideos.forEach(video => video.pause());
  dashboardView.hidden = false;
  document.querySelector('.landing-view').setAttribute('aria-hidden', 'true');
  byId('skipLink').href = '#dashboardMain';
  byId('skipLink').textContent = 'Skip to console';
  if (pushHistory && location.pathname !== '/console') history.pushState({ view: 'dashboard' }, '', '/console');
  if (!reducedMotion.matches) ambientVideo.play().catch(() => {});
  window.scrollTo(0, 0);
  pollState();
}

function scrollInstantly(target) {
  if (!target) return;
  const previousBehavior = root.style.scrollBehavior;
  root.style.scrollBehavior = 'auto';
  target.scrollIntoView({ block: 'start' });
  root.style.scrollBehavior = previousBehavior;
}

function setLandingVisible(pushHistory, atCore = false) {
  root.dataset.view = 'landing';
  dashboardView.hidden = true;
  document.querySelector('.landing-view').removeAttribute('aria-hidden');
  byId('skipLink').href = '#story';
  byId('skipLink').textContent = 'Skip to story';
  ambientVideo.pause();
  if (pushHistory && location.pathname !== '/') history.pushState({ view: 'landing' }, '', '/');
  if (atCore) {
    scrollInstantly(byId('integrity'));
  } else if (location.hash) {
    requestAnimationFrame(() => scrollInstantly(document.querySelector(location.hash)));
  } else {
    window.scrollTo(0, 0);
  }
  scheduleStoryUpdate();
}

async function openConsole(pushHistory = true) {
  if (transitionBusy || root.dataset.view === 'dashboard') return;
  transitionBusy = true;

  if (reducedMotion.matches) {
    setDashboardVisible(pushHistory);
    transitionBusy = false;
    return;
  }

  transitionLayer.hidden = false;
  transitionLayer.setAttribute('aria-hidden', 'false');
  transitionVideo.pause();
  await seekWhenReady(transitionVideo, 0);
  transitionVideo.playbackRate = 1;
  const started = await transitionVideo.play().then(() => true, () => false);
  if (started) await waitForVideoEnd(transitionVideo);
  setDashboardVisible(pushHistory);
  await fadeTransitionAway();
  transitionLayer.setAttribute('aria-hidden', 'true');
  transitionBusy = false;
}

async function returnToLanding(pushHistory = true) {
  if (transitionBusy || root.dataset.view === 'landing') return;
  transitionBusy = true;

  if (reducedMotion.matches) {
    setLandingVisible(pushHistory, true);
    transitionBusy = false;
    return;
  }

  transitionLayer.hidden = false;
  transitionLayer.setAttribute('aria-hidden', 'false');
  transitionVideo.pause();
  setLandingVisible(pushHistory, true);
  await scrubVideoReverse(transitionVideo);
  await fadeTransitionAway();
  transitionLayer.setAttribute('aria-hidden', 'true');
  transitionBusy = false;
}

function renderApproval(pending) {
  const entries = Object.entries(pending || {});
  byId('approvalArea').innerHTML = entries.map(([id, approval]) => `
    <article class="approval-card">
      <p class="eyebrow">Human gate · irreversible action</p>
      <h2>Approval required — ${esc(approval.tool)}</h2>
      <p>${esc(JSON.stringify(approval.args))}</p>
      <div class="approval-actions">
        <button type="button" data-approval-id="${esc(id)}" data-decision="allow">Approve</button>
        <button type="button" class="deny" data-approval-id="${esc(id)}" data-decision="deny">Deny</button>
      </div>
    </article>`).join('');
}

function showNotice(message, tone = 'info') {
  const area = byId('noticeArea');
  window.clearTimeout(noticeTimer);
  area.innerHTML = message ? `<p class="notice notice--${esc(tone)}">${esc(message)}</p>` : '';
  if (message && tone !== 'error') {
    noticeTimer = window.setTimeout(() => { area.innerHTML = ''; }, 4200);
  }
}

function renderContracts(authored) {
  const proposals = authored?.contracts || [];
  const board = byId('dashContracts');
  const nav = byId('contractNav');
  const hasContracts = proposals.length > 0;
  board.hidden = !hasContracts;
  nav.hidden = !hasContracts;
  byId('worldStepCount').textContent = `${authored?.worldSteps || 0} world steps`;

  byId('contractList').innerHTML = proposals.map(proposal => {
    const status = proposal.approved ? 'approved' : proposal.usable ? 'ready' : 'failed audit';
    const cls = proposal.approved ? 'good' : proposal.usable ? 'warn' : 'bad';
    const findings = [...(proposal.problems || []), ...(proposal.notes || [])];
    return `<article class="contract-card">
      <div class="contract-card__heading">
        <div><p class="eyebrow">${esc(proposal.id)}</p><h3>${esc(proposal.requirement)}</h3></div>
        <span class="contract-status ${cls}">${esc(status)}</span>
      </div>
      ${findings.length ? `<ul>${findings.map(finding => `<li>${esc(finding)}</li>`).join('')}</ul>` : '<p class="contract-note">Audit found no structural problems.</p>'}
      ${proposal.usable && !proposal.approved ? `<button type="button" class="contract-approve" data-contract-id="${esc(proposal.id)}">Approve contract</button>` : ''}
    </article>`;
  }).join('');
}

function renderBranches(state) {
  const branches = Object.values(state.branches || {});
  if (selectedBranch && !branches.some(branch => branch.id === selectedBranch)) selectedBranch = null;
  if (!selectedBranch && branches.length) selectedBranch = branches[0].id;

  byId('branchCount').textContent = String(branches.length);
  byId('branchList').innerHTML = branches.length ? branches.map(branch => {
    const cls = verdictClass(branch);
    const verdict = branch.verdict;
    return `<button class="branch-card ${cls} ${branch.id === selectedBranch ? 'is-selected' : ''}" type="button" role="listitem" data-branch-id="${esc(branch.id)}">
      <span class="branch-card__top"><span>${esc(branch.id)}</span><i class="verdict-dot" aria-label="${cls}"></i></span>
      <p>${esc(whyText(branch))}</p>
      <span class="branch-card__meta"><span>${branch.engineRuns || 0} runs</span><span>${verdict?.realizations || 0} realizations</span></span>
    </button>`;
  }).join('') : '<p class="empty-note">No branches yet. Independent candidates will grow here from one shared checkpoint.</p>';

  return branches;
}

function renderInspector(state, branches) {
  const branch = branches.find(candidate => candidate.id === selectedBranch);
  const prediction = branch ? (state.predictions || {})[branch.id] : null;

  if (!branch) {
    byId('inspectorTitle').textContent = 'No branch selected';
    byId('inspectorVerdict').textContent = 'pending';
    byId('inspectorVerdict').className = 'verdict-pill';
    byId('inspectorBody').innerHTML = '<p class="empty-note">When a branch reports, its treatment/control differences appear here.</p>';
    byId('deltaCount').textContent = '0';
    byId('experimentSummary').textContent = 'No branch selected. Choose a candidate to inspect its causal difference.';
    return;
  }

  const verdict = branch.verdict;
  const cls = verdictClass(branch);
  const observed = Object.entries(verdict?.observed || {});
  byId('inspectorTitle').textContent = branch.id;
  byId('inspectorVerdict').textContent = cls;
  byId('inspectorVerdict').className = `verdict-pill ${cls}`;
  byId('deltaCount').textContent = String(observed.length);
  byId('experimentSummary').textContent = whyText(branch);

  if (!verdict) {
    byId('inspectorBody').innerHTML = `<p class="empty-note">${esc(whyText(branch))}</p>${branch.patchLuau ? `<details class="patch-disclosure"><summary>Read proposed patch</summary><pre>${esc(branch.patchLuau.trim())}</pre></details>` : ''}`;
    return;
  }

  const rows = observed.length ? `<table class="evidence-table"><thead><tr><th>state key</th><th>control → treatment</th></tr></thead><tbody>${observed.map(([key, value]) => `<tr><td>${esc(key)}</td><td>${esc(value)}</td></tr>`).join('')}</tbody></table>` : '<p class="empty-note">No state difference was observed.</p>';
  const score = prediction?.scored ? `${prediction.correct}/${prediction.total}` : 'not scored';
  byId('inspectorBody').innerHTML = `
    <p class="evidence-note">${esc(whyText(branch))}</p>
    ${rows}
    <div class="prediction-score"><span>prediction fidelity</span><strong>${esc(score)}</strong></div>
    ${prediction?.wrong?.length ? `<p class="evidence-note">${esc(prediction.wrong.join(' · '))}</p>` : ''}
    ${branch.patchLuau ? `<details class="patch-disclosure"><summary>Read proposed patch</summary><pre>${esc(branch.patchLuau.trim())}</pre></details>` : ''}`;
}

function renderIntegrity(state, branches) {
  const branchHolding = branches.length > 1;
  const worldHolding = (state.contract?.controls || []).length > 0 && (state.contract?.realizations || []).length > 0;
  const completed = branches.filter(branch => branch.verdict);
  const regressionHolding = completed.length > 0 && completed.every(branch => branch.verdict.stable);
  const checks = [branchHolding, worldHolding, regressionHolding];

  byId('integrityScore').textContent = `${checks.filter(Boolean).length}/3 holding`;
  byId('branchIntegrityMark').textContent = branchHolding ? '✓' : '○';
  byId('branchIntegrityMark').classList.toggle('holding', branchHolding);
  byId('branchIntegrityText').textContent = branchHolding ? `${branches.length} isolated candidates started from shared state.` : 'Waiting for at least two independent candidates.';
  byId('worldIntegrityMark').textContent = worldHolding ? '✓' : '○';
  byId('worldIntegrityMark').classList.toggle('holding', worldHolding);
  byId('worldIntegrityText').textContent = worldHolding ? `${state.contract.realizations.length} realizations across treatment and ${state.contract.controls.length} controls.` : 'Waiting for the behavioral contract.';
  byId('regressionIntegrityMark').textContent = regressionHolding ? '✓' : '○';
  byId('regressionIntegrityMark').classList.toggle('holding', regressionHolding);
  byId('regressionIntegrityText').textContent = completed.length ? `${completed.length} verified branch${completed.length === 1 ? '' : 'es'}; ${regressionHolding ? 'all stable' : 'timing variance found'}.` : 'Waiting for repeated engine realizations.';
}

function renderTimeline(branches) {
  const ordered = [...branches].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  byId('timeline').innerHTML = ordered.length ? ordered.map(branch => {
    const verdict = verdictClass(branch);
    const time = new Date(branch.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `<li><time datetime="${esc(branch.createdAt)}">${esc(time)}</time><strong>${esc(branch.id)}</strong><span>${verdict === 'pending' ? 'candidate opened' : `${verdict} · ${branch.engineRuns} engine runs`}</span></li>`;
  }).join('') : '<li><time>now</time><strong>Waiting at the checkpoint</strong><span>The first branch will begin the record.</span></li>';
}

function renderState(state) {
  latestState = state;
  const signature = JSON.stringify(state);
  if (signature === lastRenderedSignature) {
    byId('lastSync').textContent = `synced ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    byId('lastSync').className = 'sync-state is-live';
    return;
  }
  lastRenderedSignature = signature;

  byId('dashContract').textContent = state.contract?.id || state.contractId || '—';
  byId('dashStatus').textContent = state.status || 'idle';
  byId('dashStatus').className = `dash-status ${state.status || ''}`;
  byId('dashHeadline').textContent = state.headline || 'Waiting for a run';
  byId('dashRequirement').textContent = state.contract?.requirement || 'The behavioral contract will appear here when a run begins.';
  byId('runId').textContent = state.runId || 'run —';
  byId('lastSync').textContent = `synced ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  byId('lastSync').className = 'sync-state is-live';
  byId('realizationCount').textContent = `${state.contract?.realizations?.length || 0} realizations`;

  renderApproval(state.pending);
  renderContracts(state.authored);
  const branches = renderBranches(state);
  renderInspector(state, branches);
  renderIntegrity(state, branches);
  renderTimeline(branches);
  byId('engineRuns').textContent = `${branches.reduce((sum, branch) => sum + (branch.engineRuns || 0), 0)} engine runs`;
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `${response.status} ${response.statusText}`);
  return payload;
}

async function runButtonAction(button, action) {
  if (button?.disabled) return;
  if (button) button.disabled = true;
  try {
    await action();
  } catch (error) {
    showNotice(error instanceof Error ? error.message : 'The action failed.', 'error');
  } finally {
    if (button?.isConnected) button.disabled = false;
  }
}

async function decideApproval(id, status) {
  await requestJson(`/api/approvals/${encodeURIComponent(id)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  showNotice(status === 'allow' ? 'Action approved.' : 'Action denied.', status === 'allow' ? 'success' : 'info');
  await pollState();
}

async function approveContract(id) {
  await requestJson(`/api/contracts/${encodeURIComponent(id)}/approve`, { method: 'POST' });
  showNotice(`Contract ${id} approved.`, 'success');
  lastRenderedSignature = '';
  await pollState();
}

async function resetRun() {
  const confirmed = window.confirm('Reset this run? Branches, pending approvals, and the authored world will be cleared.');
  if (!confirmed) return;
  await requestJson('/api/reset', { method: 'POST' });
  selectedBranch = null;
  lastRenderedSignature = '';
  showNotice('Run reset. The console is ready for a fresh experiment.', 'success');
  await pollState();
}

async function pollState() {
  if (pollInFlight) return;
  pollInFlight = true;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch('/api/state', { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(`state ${response.status}`);
    renderState(await response.json());
  } catch {
    byId('lastSync').textContent = 'reconnecting';
    byId('lastSync').className = 'sync-state is-offline';
  } finally {
    window.clearTimeout(timeout);
    pollInFlight = false;
  }
}

document.addEventListener('click', event => {
  const open = event.target.closest('[data-open-console]');
  if (open) {
    event.preventDefault();
    openConsole();
    return;
  }

  const back = event.target.closest('[data-back-landing]');
  if (back) {
    event.preventDefault();
    returnToLanding();
    return;
  }

  const branch = event.target.closest('[data-branch-id]');
  if (branch && latestState) {
    selectedBranch = branch.dataset.branchId;
    lastRenderedSignature = '';
    renderState(latestState);
    return;
  }

  const decision = event.target.closest('[data-approval-id]');
  if (decision) {
    void runButtonAction(decision, () => decideApproval(decision.dataset.approvalId, decision.dataset.decision));
    return;
  }

  const contractApproval = event.target.closest('[data-contract-id]');
  if (contractApproval) {
    void runButtonAction(contractApproval, () => approveContract(contractApproval.dataset.contractId));
    return;
  }

  const reset = event.target.closest('[data-reset-run]');
  if (reset) void runButtonAction(reset, resetRun);
});

window.addEventListener('scroll', scheduleStoryUpdate, { passive: true });
window.addEventListener('resize', scheduleStoryUpdate);
document.addEventListener('visibilitychange', scheduleStoryUpdate);
window.addEventListener('popstate', () => {
  if (location.pathname === '/console') openConsole(false);
  else returnToLanding(false);
});

storyVideos.forEach(video => {
  video.loop = false;
  video.addEventListener('loadedmetadata', scheduleStoryUpdate, { once: true });
});

reducedMotion.addEventListener?.('change', () => {
  if (reducedMotion.matches) ambientVideo.pause();
  else if (root.dataset.view === 'dashboard') ambientVideo.play().catch(() => {});
  scheduleStoryUpdate();
});

if (location.pathname === '/console') setDashboardVisible(false);
else setLandingVisible(false);

pollState();
window.setInterval(pollState, 1500);
