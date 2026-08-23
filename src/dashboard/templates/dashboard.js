function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toString();
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return d + 'd ' + (h % 24) + 'h';
  if (h > 0) return h + 'h ' + (m % 60) + 'm';
  if (m > 0) return m + 'm ' + (s % 60) + 's';
  return s + 's';
}

async function refresh() {
  try {
    const [metricsRes, daemonRes, maintenanceRes, chainResilienceRes, agentsRes, delegationsRes, consolidationRes, deploymentRes] = await Promise.all([
      fetch('/api/metrics'),
      fetch('/api/daemon').catch(function() { return null; }),
      fetch('/api/maintenance').catch(function() { return null; }),
      fetch('/api/chain-resilience').catch(function() { return null; }),
      fetch('/api/agents').catch(function() { return null; }),
      fetch('/api/delegations').catch(function() { return null; }),
      fetch('/api/consolidation').catch(function() { return null; }),
      fetch('/api/deployment').catch(function() { return null; })
    ]);
    const data = await metricsRes.json();

    // Read-only mode indicator
    const banner = document.getElementById('readonly-banner');
    const statusDot = document.getElementById('status-dot');
    if (data.readOnlyMode) {
      banner.classList.add('active');
      statusDot.classList.add('readonly');
    } else {
      banner.classList.remove('active');
      statusDot.classList.remove('readonly');
    }

    // Cards
    const cards = [
      card('Uptime', fmtDuration(data.uptime)),
      card('Messages', fmt(data.totalMessages)),
      card('Input Tokens', fmt(data.totalTokens.input)),
      card('Output Tokens', fmt(data.totalTokens.output)),
      card('Active Sessions', data.activeSessions),
      card('Provider', data.providerName, data.memoryStats ? 'Memory: ' + data.memoryStats.totalEntries + ' entries' : ''),
    ];

    // Add security stats if available
    if (data.securityStats && (data.securityStats.secretsSanitized > 0 || data.securityStats.toolsBlocked > 0)) {
      cards.push(card('Secrets Redacted', fmt(data.securityStats.secretsSanitized), data.securityStats.toolsBlocked > 0 ? data.securityStats.toolsBlocked + ' tools blocked' : ''));
    }

    // Add read-only indicator card
    if (data.readOnlyMode) {
      cards.push(card('Mode', '\\u{1F512} Read-Only', 'Write operations disabled'));
    }

    document.getElementById('cards').textContent = '';
    var cardsEl = document.getElementById('cards');
    cardsEl.textContent = '';
    var tmp = document.createElement('div');
    tmp.innerHTML = cards.join('');
    while (tmp.firstChild) cardsEl.appendChild(tmp.firstChild);

    // Tool table
    const tbody = document.querySelector('#tool-table tbody');
    const tools = Object.entries(data.toolCallCounts).sort((a,b) => b[1] - a[1]);
    const maxCalls = Math.max(...tools.map(t => t[1]), 1);
    var toolRows = tools.map(([name, calls]) => {
      const errors = data.toolErrorCounts[name] || 0;
      const pct = (calls / maxCalls * 100).toFixed(0);
      return '<tr><td>' + esc(name) + '</td><td>' + esc(calls) + '</td>'
        + '<td>' + (errors > 0 ? '<span class="badge badge-err">' + errors + '</span>' : '<span class="badge badge-ok">0</span>') + '</td>'
        + '<td><div class="bar-container"><div class="bar bar-input" style="width:' + pct + '%"></div></div></td></tr>';
    }).join('');
    tbody.textContent = '';
    var toolTmp = document.createElement('tbody');
    toolTmp.innerHTML = toolRows;
    while (toolTmp.firstChild) tbody.appendChild(toolTmp.firstChild);

    // Token chart (sparkline)
    const chart = document.getElementById('token-chart');
    const recent = data.recentTokenUsage.slice(-50);
    const maxTokens = Math.max(...recent.map(t => t.inputTokens + t.outputTokens), 1);
    var chartHtml = recent.map(t => {
      const total = t.inputTokens + t.outputTokens;
      const h = Math.max(4, (total / maxTokens) * 100);
      const inPct = t.inputTokens / (total || 1) * 100;
      return '<div style="flex:1;height:' + h + '%;display:flex;flex-direction:column;justify-content:flex-end">'
        + '<div class="bar-input" style="height:' + inPct + '%;border-radius:2px 2px 0 0"></div>'
        + '<div class="bar-output" style="height:' + (100-inPct) + '%;border-radius:0 0 2px 2px"></div>'
        + '</div>';
    }).join('');
    chart.textContent = '';
    var chartTmp = document.createElement('div');
    chartTmp.innerHTML = chartHtml;
    while (chartTmp.firstChild) chart.appendChild(chartTmp.firstChild);

    // Identity panel and trigger history (Plan 18-03)
    if (daemonRes) {
      var daemon = await daemonRes.json();
      renderIdentityPanel(daemon);
      renderTriggerHistory(daemon);
    }

    // Maintenance panel (Plan 21-03)
    if (maintenanceRes) {
      var maint = await maintenanceRes.json();
      renderMaintenance(maint);
    }

    // Chain Resilience panel (Plan 22-04)
    if (chainResilienceRes) {
      var chainData = await chainResilienceRes.json();
      renderChainResilience(chainData);
    }

    // Agents panel (Plan 23-03)
    if (agentsRes) {
      var agentsData = await agentsRes.json();
      renderAgents(agentsData);
    }

    // Delegations panel (Plan 24-03)
    if (delegationsRes) {
      var delegationsData = await delegationsRes.json();
      renderDelegations(delegationsData);
    }

    // Consolidation subsection in Maintenance (Plan 25-03)
    if (consolidationRes) {
      var consolidationData = await consolidationRes.json();
      renderConsolidation(consolidationData);
    }

    // Deployment panel (Plan 25-03)
    if (deploymentRes) {
      var deploymentData = await deploymentRes.json();
      renderDeployment(deploymentData);
    }

    document.getElementById('last-update').textContent = 'Last updated: ' + new Date().toLocaleTimeString();
  } catch (e) {
    document.getElementById('last-update').textContent = 'Error: ' + e.message;
  }
}

function renderIdentityPanel(daemon) {
  var panel = document.getElementById('identity-panel');
  if (!panel) return;
  if (!daemon.identity) {
    panel.textContent = '';
    var p = document.createElement('p');
    p.style.color = '#8b949e';
    p.textContent = 'Identity not available';
    panel.appendChild(p);
    return;
  }
  var id = daemon.identity;
  var crashStatus = id.cleanShutdown ? 'Clean' : 'Crash Detected';
  var crashColor = id.cleanShutdown ? '#3fb950' : '#f0883e';
  var html =
    '<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr))">'
    + card('Agent', esc(id.agentName), esc(id.agentUuid.substring(0, 8)) + '...')
    + card('Boot Count', id.bootCount)
    + card('Cumulative Uptime', fmtDuration(id.cumulativeUptimeMs))
    + card('Last Activity', id.lastActivityTs ? new Date(id.lastActivityTs).toLocaleString() : 'N/A')
    + card('Messages / Tasks', id.totalMessages + ' / ' + id.totalTasks)
    + '<div class="card"><div class="label">Shutdown Status</div><div class="value" style="font-size:1rem;color:' + crashColor + '">' + esc(crashStatus) + '</div></div>'
    + '</div>';
  panel.textContent = '';
  var tmp = document.createElement('div');
  tmp.innerHTML = html;
  while (tmp.firstChild) panel.appendChild(tmp.firstChild);
}

function renderTriggerHistory(daemon) {
  var container = document.getElementById('trigger-history');
  if (!container) return;
  var history = daemon.triggerHistory;
  if (!history || history.length === 0) {
    container.textContent = '';
    var p = document.createElement('p');
    p.style.color = '#8b949e';
    p.textContent = 'No triggers registered';
    container.appendChild(p);
    return;
  }
  var rows = '';
  for (var i = 0; i < history.length; i++) {
    var t = history[i];
    if (t.fires.length === 0) {
      rows += '<tr><td>' + esc(t.triggerName) + '</td><td>' + esc(t.type) + '</td><td colspan="3" style="color:#8b949e">No fire history</td></tr>';
    } else {
      for (var j = 0; j < t.fires.length; j++) {
        var f = t.fires[j];
        var badge = 'badge-info';
        if (f.result === 'success') badge = 'badge-ok';
        else if (f.result === 'failure') badge = 'badge-err';
        else if (f.result === 'deduplicated') badge = 'badge-warn';
        rows += '<tr><td>' + (j === 0 ? esc(t.triggerName) : '') + '</td>'
          + '<td>' + (j === 0 ? esc(t.type) : '') + '</td>'
          + '<td>' + (f.timestamp ? new Date(f.timestamp).toLocaleString() : 'N/A') + '</td>'
          + '<td><span class="badge ' + badge + '">' + esc(f.result) + '</span></td>'
          + '<td>' + (f.durationMs != null ? f.durationMs + 'ms' : 'N/A') + '</td></tr>';
      }
    }
  }
  container.textContent = '';
  var tbl = document.createElement('div');
  tbl.innerHTML = '<table><thead><tr><th>Trigger</th><th>Type</th><th>Time</th><th>Result</th><th>Duration</th></tr></thead><tbody>' + rows + '</tbody></table>';
  while (tbl.firstChild) container.appendChild(tbl.firstChild);
}

function renderMaintenance(maint) {
  var container = document.getElementById('maintenance-panel');
  if (!container) return;

  var decay = maint.decay;
  var pruning = maint.pruning;

  if (!decay || !decay.enabled) {
    container.textContent = '';
    var p = document.createElement('p');
    p.style.color = '#8b949e';
    p.textContent = 'Memory decay is disabled';
    container.appendChild(p);
    return;
  }

  var tiers = decay.tiers || {};
  var tierNames = ['working', 'ephemeral', 'persistent'];
  container.textContent = '';

  var tbl = document.createElement('table');
  var thead = document.createElement('thead');
  var headRow = document.createElement('tr');
  ['Tier', 'Entries', 'Avg Score', 'At Floor', 'Lambda'].forEach(function(h) {
    var th = document.createElement('th');
    th.textContent = h;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  tbl.appendChild(thead);

  var tbody = document.createElement('tbody');
  for (var i = 0; i < tierNames.length; i++) {
    var name = tierNames[i];
    var t = tiers[name];
    if (!t) continue;
    var avg = t.avgScore;
    var barColor = avg > 0.5 ? '#3fb950' : avg >= 0.2 ? '#f0883e' : '#da3633';
    var pct = Math.round(avg * 100);

    var row = document.createElement('tr');

    var tdName = document.createElement('td');
    tdName.style.textTransform = 'capitalize';
    tdName.textContent = name;
    row.appendChild(tdName);

    var tdEntries = document.createElement('td');
    tdEntries.style.textAlign = 'right';
    tdEntries.textContent = String(t.entries);
    row.appendChild(tdEntries);

    var tdScore = document.createElement('td');
    var barOuter = document.createElement('div');
    barOuter.className = 'bar-container';
    barOuter.style.position = 'relative';
    var barInner = document.createElement('div');
    barInner.style.background = barColor;
    barInner.style.height = '100%';
    barInner.style.width = pct + '%';
    barInner.style.borderRadius = '4px';
    barOuter.appendChild(barInner);
    var scoreLabel = document.createElement('span');
    scoreLabel.style.position = 'absolute';
    scoreLabel.style.right = '4px';
    scoreLabel.style.top = '0';
    scoreLabel.style.fontSize = '0.75rem';
    scoreLabel.style.color = '#e1e4e8';
    scoreLabel.textContent = avg.toFixed(2);
    barOuter.appendChild(scoreLabel);
    tdScore.appendChild(barOuter);
    row.appendChild(tdScore);

    var tdFloor = document.createElement('td');
    tdFloor.style.textAlign = 'right';
    tdFloor.textContent = String(t.atFloor);
    row.appendChild(tdFloor);

    var tdLambda = document.createElement('td');
    tdLambda.style.textAlign = 'right';
    tdLambda.textContent = t.lambda.toFixed(2);
    row.appendChild(tdLambda);

    tbody.appendChild(row);
  }
  tbl.appendChild(tbody);
  container.appendChild(tbl);

  if (decay.exemptDomains && decay.exemptDomains.length > 0) {
    var exemptP = document.createElement('p');
    exemptP.style.color = '#8b949e';
    exemptP.style.fontSize = '0.8rem';
    exemptP.style.marginTop = '8px';
    exemptP.textContent = 'Exempt domains: ' + decay.exemptDomains.join(', ') + ' (' + decay.totalExempt + ' entries)';
    container.appendChild(exemptP);
  }

  var pruneP = document.createElement('p');
  pruneP.style.color = '#8b949e';
  pruneP.style.fontSize = '0.8rem';
  pruneP.style.marginTop = '4px';
  var pruneText = 'Pruning: ' + pruning.retentionDays + ' day retention';
  if (pruning.lastPrunedCount > 0) pruneText += ', last pruned ' + pruning.lastPrunedCount + ' records';
  pruneP.textContent = pruneText;
  container.appendChild(pruneP);
}

function renderChainResilience(data) {
  var container = document.getElementById('chain-resilience-panel');
  if (!container) return;

  var chains = data.chains || [];
  var cfg = data.config || {};

  if (chains.length === 0) {
    container.textContent = '';
    var p = document.createElement('p');
    p.style.color = '#8b949e';
    p.textContent = 'No active chains';
    container.appendChild(p);

    // Still show config summary
    var cfgP = document.createElement('p');
    cfgP.style.color = '#8b949e';
    cfgP.style.fontSize = '0.8rem';
    cfgP.style.marginTop = '8px';
    cfgP.textContent = 'Rollback: ' + (cfg.rollbackEnabled ? 'enabled' : 'disabled')
      + ' | Parallel: ' + (cfg.parallelEnabled ? 'enabled' : 'disabled')
      + ' | Max Branches: ' + (cfg.maxParallelBranches || 4)
      + ' | Timeout: ' + (cfg.compensationTimeoutMs || 5000) + 'ms';
    container.appendChild(cfgP);
    return;
  }

  container.textContent = '';

  var tbl = document.createElement('table');
  var thead = document.createElement('thead');
  var headRow = document.createElement('tr');
  ['Name', 'Steps', 'Rollback', 'Parallel', 'Success Rate', 'Executions', 'Last Run'].forEach(function(h) {
    var th = document.createElement('th');
    th.textContent = h;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  tbl.appendChild(thead);

  var tbody = document.createElement('tbody');
  for (var i = 0; i < chains.length; i++) {
    var c = chains[i];
    var row = document.createElement('tr');

    var tdName = document.createElement('td');
    tdName.textContent = c.name;
    row.appendChild(tdName);

    var tdSteps = document.createElement('td');
    tdSteps.style.textAlign = 'right';
    tdSteps.textContent = String(c.steps);
    row.appendChild(tdSteps);

    var tdRollback = document.createElement('td');
    var rbBadge = document.createElement('span');
    rbBadge.className = 'badge ' + (c.rollbackCapable ? 'badge-ok' : 'badge-warn');
    rbBadge.textContent = c.rollbackCapable ? '<- Rollback-capable' : '-> Forward-recovery';
    tdRollback.appendChild(rbBadge);
    row.appendChild(tdRollback);

    var tdParallel = document.createElement('td');
    var parBadge = document.createElement('span');
    parBadge.className = 'badge ' + (c.parallelCapable ? 'badge-ok' : 'badge-warn');
    parBadge.textContent = c.parallelCapable ? 'Parallel' : 'Sequential';
    tdParallel.appendChild(parBadge);
    row.appendChild(tdParallel);

    var tdRate = document.createElement('td');
    tdRate.style.textAlign = 'right';
    tdRate.textContent = (c.successRate * 100).toFixed(1) + '%';
    row.appendChild(tdRate);

    var tdOcc = document.createElement('td');
    tdOcc.style.textAlign = 'right';
    tdOcc.textContent = String(c.occurrences);
    row.appendChild(tdOcc);

    var tdLast = document.createElement('td');
    tdLast.textContent = c.lastRun ? new Date(c.lastRun).toLocaleString() : '-';
    row.appendChild(tdLast);

    tbody.appendChild(row);
  }
  tbl.appendChild(tbody);
  container.appendChild(tbl);

  // Config summary row
  var cfgP = document.createElement('p');
  cfgP.style.color = '#8b949e';
  cfgP.style.fontSize = '0.8rem';
  cfgP.style.marginTop = '8px';
  cfgP.textContent = 'Rollback: ' + (cfg.rollbackEnabled ? 'enabled' : 'disabled')
    + ' | Parallel: ' + (cfg.parallelEnabled ? 'enabled' : 'disabled')
    + ' | Max Branches: ' + (cfg.maxParallelBranches || 4)
    + ' | Timeout: ' + (cfg.compensationTimeoutMs || 5000) + 'ms';
  container.appendChild(cfgP);
}

function renderAgents(data) {
  var section = document.getElementById('agents-section');
  var container = document.getElementById('agents-panel');
  if (!section || !container) return;

  if (!data || !data.enabled) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';

  var agents = data.agents || [];
  container.textContent = '';

  // Global budget bar
  var globalBudget = data.globalBudget || {};
  if (globalBudget.usedUsd !== undefined) {
    var budgetDiv = document.createElement('div');
    budgetDiv.style.marginBottom = '12px';
    var budgetLabel = document.createElement('div');
    budgetLabel.style.fontSize = '0.85rem';
    budgetLabel.style.color = '#8b949e';
    budgetLabel.style.marginBottom = '4px';
    var limitStr = globalBudget.limitUsd ? '$' + globalBudget.limitUsd.toFixed(2) : 'unlimited';
    budgetLabel.textContent = 'Global Budget: $' + globalBudget.usedUsd.toFixed(2) + ' / ' + limitStr;
    budgetDiv.appendChild(budgetLabel);

    if (globalBudget.limitUsd) {
      var barOuter = document.createElement('div');
      barOuter.className = 'bar-container';
      var pct = Math.min(globalBudget.pct * 100, 100);
      var barColor = pct > 90 ? '#da3633' : pct > 70 ? '#f0883e' : '#3fb950';
      var barInner = document.createElement('div');
      barInner.style.background = barColor;
      barInner.style.height = '100%';
      barInner.style.width = pct.toFixed(0) + '%';
      barInner.style.borderRadius = '4px';
      barOuter.appendChild(barInner);
      budgetDiv.appendChild(barOuter);
    }
    container.appendChild(budgetDiv);
  }

  if (agents.length === 0) {
    var p = document.createElement('p');
    p.style.color = '#8b949e';
    p.textContent = 'No agents active (' + (data.activeCount || 0) + ' in memory)';
    container.appendChild(p);
    return;
  }

  // Agent table
  var tbl = document.createElement('table');
  var thead = document.createElement('thead');
  var headRow = document.createElement('tr');
  ['ID', 'Channel', 'Status', 'Budget Used/Cap', 'Memory', 'Uptime'].forEach(function(h) {
    var th = document.createElement('th');
    th.textContent = h;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  tbl.appendChild(thead);

  var tbody = document.createElement('tbody');
  var now = Date.now();
  for (var i = 0; i < agents.length; i++) {
    var a = agents[i];
    var row = document.createElement('tr');

    var tdId = document.createElement('td');
    tdId.textContent = a.id.substring(0, 12) + '..';
    tdId.title = a.id;
    row.appendChild(tdId);

    var tdChan = document.createElement('td');
    tdChan.textContent = a.channelType + ':' + a.chatId.substring(0, 8);
    row.appendChild(tdChan);

    var tdStatus = document.createElement('td');
    var statusBadge = document.createElement('span');
    var statusClass = 'badge-info';
    if (a.status === 'active') statusClass = 'badge-ok';
    else if (a.status === 'stopped') statusClass = 'badge-warn';
    else if (a.status === 'budget_exceeded') statusClass = 'badge-err';
    statusBadge.className = 'badge ' + statusClass;
    statusBadge.textContent = a.status;
    tdStatus.appendChild(statusBadge);
    row.appendChild(tdStatus);

    var tdBudget = document.createElement('td');
    var used = a.budgetUsed || 0;
    tdBudget.textContent = '$' + used.toFixed(2) + ' / $' + a.budgetCapUsd.toFixed(2);
    row.appendChild(tdBudget);

    var tdMem = document.createElement('td');
    tdMem.style.textAlign = 'right';
    tdMem.textContent = String(a.memoryEntryCount);
    row.appendChild(tdMem);

    var tdUptime = document.createElement('td');
    tdUptime.textContent = fmtDuration(now - a.createdAt);
    row.appendChild(tdUptime);

    tbody.appendChild(row);
  }
  tbl.appendChild(tbody);
  container.appendChild(tbl);

  // Active count summary
  var summaryP = document.createElement('p');
  summaryP.style.color = '#8b949e';
  summaryP.style.fontSize = '0.8rem';
  summaryP.style.marginTop = '8px';
  summaryP.textContent = data.activeCount + ' live agent(s) in memory, ' + agents.length + ' total registered';
  container.appendChild(summaryP);
}

function renderDelegations(data) {
  var section = document.getElementById('delegations-section');
  var container = document.getElementById('delegations-panel');
  if (!section || !container) return;

  if (!data || !data.enabled) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';

  container.textContent = '';

  var active = data.active || [];
  var stats = data.stats || [];
  var history = data.history || [];

  // Active delegations table
  if (active.length > 0) {
    var activeH = document.createElement('h3');
    activeH.textContent = 'Active Delegations';
    activeH.style.color = '#c9d1d9';
    activeH.style.fontSize = '0.95rem';
    activeH.style.marginBottom = '8px';
    container.appendChild(activeH);

    var tbl = document.createElement('table');
    var thead = document.createElement('thead');
    var headRow = document.createElement('tr');
    ['Sub-Agent', 'Type', 'Elapsed'].forEach(function(h) {
      var th = document.createElement('th');
      th.textContent = h;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    tbl.appendChild(thead);

    var tbody = document.createElement('tbody');
    for (var i = 0; i < active.length; i++) {
      var d = active[i];
      var row = document.createElement('tr');

      var tdId = document.createElement('td');
      tdId.textContent = d.subAgentId.substring(0, 12) + '..';
      tdId.title = d.subAgentId;
      row.appendChild(tdId);

      var tdType = document.createElement('td');
      tdType.textContent = d.type;
      row.appendChild(tdType);

      var tdElapsed = document.createElement('td');
      tdElapsed.textContent = fmtDuration(d.elapsedMs || 0);
      row.appendChild(tdElapsed);

      tbody.appendChild(row);
    }
    tbl.appendChild(tbody);
    container.appendChild(tbl);
  } else {
    var noActive = document.createElement('p');
    noActive.style.color = '#8b949e';
    noActive.style.fontSize = '0.85rem';
    noActive.style.marginBottom = '12px';
    noActive.textContent = 'No active delegations';
    container.appendChild(noActive);
  }

  // Stats summary table
  if (stats.length > 0) {
    var statsH = document.createElement('h3');
    statsH.textContent = 'Delegation Statistics';
    statsH.style.color = '#c9d1d9';
    statsH.style.fontSize = '0.95rem';
    statsH.style.margin = '16px 0 8px 0';
    container.appendChild(statsH);

    var sTbl = document.createElement('table');
    var sThead = document.createElement('thead');
    var sHeadRow = document.createElement('tr');
    ['Type', 'Total', 'Success Rate', 'Avg Duration', 'Avg Cost'].forEach(function(h) {
      var th = document.createElement('th');
      th.textContent = h;
      sHeadRow.appendChild(th);
    });
    sThead.appendChild(sHeadRow);
    sTbl.appendChild(sThead);

    var sTbody = document.createElement('tbody');
    for (var j = 0; j < stats.length; j++) {
      var s = stats[j];
      var sRow = document.createElement('tr');

      var tdSType = document.createElement('td');
      tdSType.textContent = s.type;
      sRow.appendChild(tdSType);

      var tdCount = document.createElement('td');
      tdCount.style.textAlign = 'right';
      tdCount.textContent = String(s.count);
      sRow.appendChild(tdCount);

      var tdRate = document.createElement('td');
      var rateBadge = document.createElement('span');
      var rateVal = s.successRate * 100;
      rateBadge.className = 'badge ' + (rateVal >= 90 ? 'badge-ok' : rateVal >= 50 ? 'badge-warn' : 'badge-err');
      rateBadge.textContent = rateVal.toFixed(1) + '%';
      tdRate.appendChild(rateBadge);
      sRow.appendChild(tdRate);

      var tdDur = document.createElement('td');
      tdDur.style.textAlign = 'right';
      tdDur.textContent = Math.round(s.avgDurationMs) + 'ms';
      sRow.appendChild(tdDur);

      var tdCost = document.createElement('td');
      tdCost.style.textAlign = 'right';
      tdCost.textContent = '$' + s.avgCostUsd.toFixed(4);
      sRow.appendChild(tdCost);

      sTbody.appendChild(sRow);
    }
    sTbl.appendChild(sTbody);
    container.appendChild(sTbl);
  }

  // Recent history table (last 10)
  if (history.length > 0) {
    var histH = document.createElement('h3');
    histH.textContent = 'Recent History';
    histH.style.color = '#c9d1d9';
    histH.style.fontSize = '0.95rem';
    histH.style.margin = '16px 0 8px 0';
    container.appendChild(histH);

    var hTbl = document.createElement('table');
    var hThead = document.createElement('thead');
    var hHeadRow = document.createElement('tr');
    ['Type', 'Model', 'Duration', 'Cost', 'Status'].forEach(function(h) {
      var th = document.createElement('th');
      th.textContent = h;
      hHeadRow.appendChild(th);
    });
    hThead.appendChild(hHeadRow);
    hTbl.appendChild(hThead);

    var hTbody = document.createElement('tbody');
    var showCount = Math.min(history.length, 10);
    for (var k = 0; k < showCount; k++) {
      var e = history[k];
      var hRow = document.createElement('tr');

      var tdHType = document.createElement('td');
      tdHType.textContent = e.type;
      hRow.appendChild(tdHType);

      var tdModel = document.createElement('td');
      var modelStr = e.model || '-';
      tdModel.textContent = modelStr.length > 28 ? modelStr.substring(0, 26) + '..' : modelStr;
      tdModel.title = modelStr;
      hRow.appendChild(tdModel);

      var tdHDur = document.createElement('td');
      tdHDur.style.textAlign = 'right';
      tdHDur.textContent = e.durationMs != null ? e.durationMs + 'ms' : '-';
      hRow.appendChild(tdHDur);

      var tdHCost = document.createElement('td');
      tdHCost.style.textAlign = 'right';
      tdHCost.textContent = e.costUsd != null ? '$' + e.costUsd.toFixed(4) : '-';
      hRow.appendChild(tdHCost);

      var tdStatus = document.createElement('td');
      var statusBadge = document.createElement('span');
      var statusClass = 'badge-info';
      if (e.status === 'completed') statusClass = 'badge-ok';
      else if (e.status === 'failed') statusClass = 'badge-err';
      else if (e.status === 'timeout') statusClass = 'badge-warn';
      else if (e.status === 'running') statusClass = 'badge-info';
      statusBadge.className = 'badge ' + statusClass;
      statusBadge.textContent = e.status;
      tdStatus.appendChild(statusBadge);
      hRow.appendChild(tdStatus);

      hTbody.appendChild(hRow);
    }
    hTbl.appendChild(hTbody);
    container.appendChild(hTbl);
  }
}

function renderConsolidation(data) {
  var container = document.getElementById('consolidation-panel');
  if (!container) return;

  if (!data || !data.enabled) {
    container.textContent = '';
    var p = document.createElement('p');
    p.style.color = '#8b949e';
    p.textContent = 'Memory consolidation is disabled';
    container.appendChild(p);
    return;
  }

  container.textContent = '';

  // Per-tier breakdown table
  var perTier = data.perTier || {};
  var tierNames = ['working', 'ephemeral', 'persistent'];
  var hasTierData = false;

  var tbl = document.createElement('table');
  var thead = document.createElement('thead');
  var headRow = document.createElement('tr');
  ['Tier', 'Total', 'Clustered', 'Pending'].forEach(function(h) {
    var th = document.createElement('th');
    th.textContent = h;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  tbl.appendChild(thead);

  var tbody = document.createElement('tbody');
  for (var i = 0; i < tierNames.length; i++) {
    var name = tierNames[i];
    var t = perTier[name];
    if (!t) continue;
    hasTierData = true;

    var row = document.createElement('tr');

    var tdName = document.createElement('td');
    tdName.style.textTransform = 'capitalize';
    tdName.textContent = name;
    row.appendChild(tdName);

    var tdTotal = document.createElement('td');
    tdTotal.style.textAlign = 'right';
    tdTotal.textContent = String(t.total);
    row.appendChild(tdTotal);

    var tdClustered = document.createElement('td');
    tdClustered.style.textAlign = 'right';
    tdClustered.textContent = String(t.clustered);
    row.appendChild(tdClustered);

    var tdPending = document.createElement('td');
    tdPending.style.textAlign = 'right';
    tdPending.textContent = String(t.pending);
    row.appendChild(tdPending);

    tbody.appendChild(row);
  }
  tbl.appendChild(tbody);

  if (hasTierData) {
    container.appendChild(tbl);
  }

  // Lifetime stats summary
  var summary = document.createElement('p');
  summary.style.color = '#8b949e';
  summary.style.fontSize = '0.8rem';
  summary.style.marginTop = '8px';
  summary.textContent = data.totalRuns + ' run(s), ' + data.lifetimeSavings + ' entries saved, $' + (data.totalCostUsd || 0).toFixed(4) + ' total cost';
  container.appendChild(summary);
}

function renderDeployment(data) {
  var section = document.getElementById('deployment-section');
  var container = document.getElementById('deployment-panel');
  if (!section || !container) return;

  if (!data || !data.enabled) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';
  container.textContent = '';

  var stats = data.stats || {};

  // Status indicators
  var statusDiv = document.createElement('div');
  statusDiv.style.marginBottom = '12px';

  var cbState = stats.circuitBreakerState || 'CLOSED';
  var cbColor = cbState === 'CLOSED' ? '#3fb950' : cbState === 'HALF_OPEN' ? '#f0883e' : '#da3633';

  var statusP = document.createElement('p');
  statusP.style.margin = '4px 0';
  var cbDot = document.createElement('span');
  cbDot.style.display = 'inline-block';
  cbDot.style.width = '8px';
  cbDot.style.height = '8px';
  cbDot.style.borderRadius = '50%';
  cbDot.style.backgroundColor = cbColor;
  cbDot.style.marginRight = '6px';
  statusP.appendChild(cbDot);
  statusP.appendChild(document.createTextNode('Circuit breaker: ' + cbState));
  statusDiv.appendChild(statusP);

  var statsP = document.createElement('p');
  statsP.style.color = '#8b949e';
  statsP.style.fontSize = '0.8rem';
  statsP.style.margin = '4px 0';
  statsP.textContent = 'Total: ' + (stats.totalDeployments || 0) + ' | Success: ' + (stats.successful || 0) + ' | Failed: ' + (stats.failed || 0);
  statusDiv.appendChild(statsP);

  container.appendChild(statusDiv);

  // Check button
  var checkBtn = document.createElement('button');
  checkBtn.textContent = 'Run Readiness Check';
  checkBtn.style.padding = '6px 12px';
  checkBtn.style.background = '#238636';
  checkBtn.style.color = '#fff';
  checkBtn.style.border = 'none';
  checkBtn.style.borderRadius = '4px';
  checkBtn.style.cursor = 'pointer';
  checkBtn.style.marginBottom = '12px';
  checkBtn.style.fontSize = '0.85rem';
  checkBtn.onclick = function() {
    checkBtn.disabled = true;
    checkBtn.textContent = 'Checking...';
    fetch('/api/deployment/check', { method: 'POST' })
      .then(function(r) { return r.json(); })
      .then(function(result) {
        checkBtn.textContent = result.ready ? 'Ready' : 'Not Ready';
        checkBtn.style.background = result.ready ? '#238636' : '#6e7681';
        setTimeout(function() {
          checkBtn.disabled = false;
          checkBtn.textContent = 'Run Readiness Check';
          checkBtn.style.background = '#238636';
        }, 3000);
      })
      .catch(function() {
        checkBtn.disabled = false;
        checkBtn.textContent = 'Run Readiness Check';
      });
  };
  container.appendChild(checkBtn);

  // Deployment history table
  var history = data.history || [];
  if (history.length > 0) {
    var histH = document.createElement('h3');
    histH.textContent = 'Recent Deployments';
    histH.style.color = '#c9d1d9';
    histH.style.fontSize = '0.95rem';
    histH.style.margin = '8px 0';
    container.appendChild(histH);

    var hTbl = document.createElement('table');
    var hThead = document.createElement('thead');
    var hHeadRow = document.createElement('tr');
    ['Timestamp', 'Status', 'Duration', 'Approved By'].forEach(function(h) {
      var th = document.createElement('th');
      th.textContent = h;
      hHeadRow.appendChild(th);
    });
    hThead.appendChild(hHeadRow);
    hTbl.appendChild(hThead);

    var hTbody = document.createElement('tbody');
    for (var i = 0; i < history.length; i++) {
      var e = history[i];
      var hRow = document.createElement('tr');

      var tdTime = document.createElement('td');
      tdTime.textContent = new Date(e.proposedAt).toLocaleString();
      tdTime.style.fontSize = '0.8rem';
      hRow.appendChild(tdTime);

      var tdStatus = document.createElement('td');
      var statusBadge = document.createElement('span');
      var statusClass = 'badge-ok';
      if (e.status === 'failed' || e.status === 'post_verify_failed') statusClass = 'badge-err';
      else if (e.status === 'proposed' || e.status === 'executing') statusClass = 'badge-info';
      else if (e.status === 'cancelled') statusClass = 'badge-warn';
      statusBadge.className = 'badge ' + statusClass;
      statusBadge.textContent = e.status;
      tdStatus.appendChild(statusBadge);
      hRow.appendChild(tdStatus);

      var tdDuration = document.createElement('td');
      tdDuration.style.textAlign = 'right';
      tdDuration.textContent = e.duration != null ? e.duration + 'ms' : '-';
      hRow.appendChild(tdDuration);

      var tdApproved = document.createElement('td');
      tdApproved.textContent = e.approvedBy || '-';
      hRow.appendChild(tdApproved);

      hTbody.appendChild(hRow);
    }
    hTbl.appendChild(hTbody);
    container.appendChild(hTbl);
  } else {
    var noHist = document.createElement('p');
    noHist.style.color = '#8b949e';
    noHist.style.fontSize = '0.85rem';
    noHist.textContent = 'No deployment history';
    container.appendChild(noHist);
  }
}

function card(label, value, sub) {
  return '<div class="card"><div class="label">' + esc(label) + '</div><div class="value">' + esc(value) + '</div>'
    + (sub ? '<div class="sub">' + esc(sub) + '</div>' : '') + '</div>';
}

refresh();
setInterval(refresh, 3000);