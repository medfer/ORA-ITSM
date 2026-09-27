// SLA due-date computation, in calendar time (24x7) or business hours.
// Business hours are expressed in the client's time zone as a fixed UTC offset
// in minutes (Iraq: UTC+3, no daylight saving).

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

function parseHM(hm) {
  const [h, m] = String(hm).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

// bh = { offset: 180, days: [0,1,2,3,4], start: '08:00', end: '16:00' }
function normalize(bh) {
  return {
    offset: Number(bh.offset) || 0,
    days: new Set((bh.days || []).map(Number)),
    start: parseHM(bh.start || '08:00'),
    end: parseHM(bh.end || '16:00'),
  };
}

// Start of the local day (UTC ms) containing instant t.
function localDayStart(t, offset) {
  const local = t + offset * MIN;
  return local - (((local % DAY) + DAY) % DAY) - offset * MIN;
}

function localWeekday(t, offset) {
  return new Date(t + offset * MIN).getUTCDay();
}

function addBusinessMinutes(startMs, minutes, bhRaw) {
  const bh = normalize(bhRaw);
  if (!bh.days.size || bh.end <= bh.start) return startMs + minutes * MIN;
  let t = startMs;
  let remaining = minutes;
  for (let guard = 0; guard < 5000; guard++) {
    const day = localDayStart(t, bh.offset);
    const open = day + bh.start * MIN;
    const close = day + bh.end * MIN;
    if (!bh.days.has(localWeekday(t, bh.offset)) || t >= close) {
      t = day + DAY + bh.start * MIN;
      continue;
    }
    if (t < open) t = open;
    const available = (close - t) / MIN;
    if (remaining <= available) return t + remaining * MIN;
    remaining -= available;
    t = day + DAY + bh.start * MIN;
  }
  return t;
}

function businessMinutesBetween(aMs, bMs, bhRaw) {
  if (bMs <= aMs) return 0;
  const bh = normalize(bhRaw);
  if (!bh.days.size || bh.end <= bh.start) return (bMs - aMs) / MIN;
  let total = 0;
  let day = localDayStart(aMs, bh.offset);
  for (let guard = 0; day < bMs && guard < 5000; guard++, day += DAY) {
    if (!bh.days.has(localWeekday(day, bh.offset))) continue;
    const from = Math.max(aMs, day + bh.start * MIN);
    const to = Math.min(bMs, day + bh.end * MIN);
    if (to > from) total += (to - from) / MIN;
  }
  return total;
}

function addMinutes(startMs, minutes, policy, bh) {
  return policy.business_hours ? addBusinessMinutes(startMs, minutes, bh) : startMs + minutes * MIN;
}

function minutesBetween(aMs, bMs, policy, bh) {
  return policy.business_hours ? businessMinutesBetween(aMs, bMs, bh) : Math.max(0, (bMs - aMs) / MIN);
}

// Ticket due dates from its SLA policy and the time spent paused.
function computeDues(ticket, policy, bh) {
  return {
    response_due: addMinutes(ticket.created_at, policy.response_min, policy, bh),
    resolution_due: addMinutes(ticket.created_at, policy.resolution_min + (ticket.paused_minutes || 0), policy, bh),
  };
}

// SLA state computed on read: 'met' | 'breached' | 'running' | 'at_risk' | 'paused'.
function slaState(ticket, policy, bh, now = Date.now()) {
  const res = {};
  const responseAt = ticket.first_response_at;
  if (responseAt) res.response = responseAt <= ticket.response_due ? 'met' : 'breached';
  else res.response = now > ticket.response_due ? 'breached' : riskOf(ticket.created_at, ticket.response_due, now);

  let due = ticket.resolution_due;
  if (ticket.paused_at && policy) {
    due = addMinutes(due, minutesBetween(ticket.paused_at, now, policy, bh), policy, bh);
  }
  const doneAt = ticket.resolved_at;
  if (doneAt) res.resolution = doneAt <= due ? 'met' : 'breached';
  else if (now > due) res.resolution = 'breached';
  else res.resolution = ticket.paused_at ? 'paused' : riskOf(ticket.created_at, due, now);
  res.effective_resolution_due = due;
  return res;
}

// "At risk" once more than 75% of the allowed time is used.
function riskOf(start, due, now) {
  const span = due - start;
  return span > 0 && (now - start) / span >= 0.75 ? 'at_risk' : 'running';
}

module.exports = {
  addBusinessMinutes,
  businessMinutesBetween,
  addMinutes,
  minutesBetween,
  computeDues,
  slaState,
};
