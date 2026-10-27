/* Misfits scheduler engine v4 — exact min-cost-flow allocation.
   Graph: S -> slot (cap 1) -> PR(player,round) (cap 1, one game per round)
          -> P(player) -> T (cap = player's exact target games).
   Saturating the flow guarantees every slot is filled and every player hits
   their target exactly. Costs encode preference (higher score = cheaper),
   a change penalty (keeps the current schedule stable so proposed moves are
   short chains), and a per-player favourite bonus raised iteratively until
   every player who can have a favourite gets one. */

function waterfill(total, caps) {
  // Split `total` across players with upper bounds `caps`, as evenly as possible.
  const n = caps.length, t = new Array(n).fill(0);
  if (caps.reduce((a, b) => a + b, 0) < total) return null;
  let active = caps.map((_, i) => i), remaining = total;
  while (active.length) {
    const share = Math.floor(remaining / active.length);
    const capped = active.filter(i => caps[i] <= share);
    if (capped.length) {
      for (const i of capped) { t[i] = caps[i]; remaining -= caps[i]; }
      active = active.filter(i => caps[i] > share);
    } else {
      for (const i of active) t[i] = share;
      remaining -= share * active.length;
      const order = [...active].sort((a, b) => (caps[b] - t[b]) - (caps[a] - t[a]));
      for (let k = 0; k < remaining; k++) t[order[k]]++;
      break;
    }
  }
  return t;
}

class MCF {
  constructor(n) { this.n = n; this.g = Array.from({ length: n }, () => []); this.to = []; this.cap = []; this.cost = []; }
  add(u, v, cap, cost) {
    const id = this.to.length;
    this.to.push(v, u); this.cap.push(cap, 0); this.cost.push(cost, -cost);
    this.g[u].push(id); this.g[v].push(id + 1);
    return id;
  }
  run(s, t, need) {
    let flow = 0;
    while (flow < need) {
      const dist = new Array(this.n).fill(Infinity), inq = new Array(this.n).fill(false), pe = new Array(this.n).fill(-1);
      dist[s] = 0; const q = [s]; inq[s] = true; let h = 0;
      while (h < q.length) {
        const u = q[h++]; inq[u] = false;
        for (const e of this.g[u]) {
          const v = this.to[e];
          if (this.cap[e] > 0 && dist[u] + this.cost[e] < dist[v] - 1e-9) {
            dist[v] = dist[u] + this.cost[e]; pe[v] = e;
            if (!inq[v]) { inq[v] = true; q.push(v); }
          }
        }
      }
      if (dist[t] === Infinity) break;
      for (let v = t; v !== s; v = this.to[pe[v] ^ 1]) { this.cap[pe[v]]--; this.cap[pe[v] ^ 1]++; }
      flow++;
    }
    return flow;
  }
}

/* opts:
   players: [{ name, absentWeeks:Set<string>, cap:number|null }]
   slots:   [{ id, week, round, game }]
   score(player, game) -> number | null | undefined   (null = avoid, undefined = no response)
   fixed:   Map slotId -> player   (locked / user-forced)
   current: Map slotId -> player   (existing schedule, used for stability)
   changePenalty: number
   favourite: 100                  (score value that counts as a favourite)
*/
function solveSchedule(opts) {
  const { players, slots, score, fixed = new Map(), current = new Map(), changePenalty = 0, favourite = 100, pairPen = new Map() } = opts;
  const pIndex = new Map(players.map((p, i) => [p.name, i]));
  const roundsOf = slots.map(s => s.round);
  const allRounds = [...new Set(roundsOf)];
  const ok = (p, s) => !players[pIndex.get(p)].absentWeeks.has(s.week);
  const sc = (p, s) => score(p, s.game);
  const isElig = (p, s) => typeof sc(p, s) === 'number' && ok(p, s);

  // Validate fixed assignments before building anything.
  const slotById = new Map(slots.map(s => [s.id, s]));
  const fixedCount = new Map(players.map(p => [p.name, 0]));
  const fixedRounds = new Map(players.map(p => [p.name, new Set()]));
  const fixedIssues = [];
  for (const [sid, p] of fixed) {
    const s = slotById.get(sid); if (!s) continue;
    if (fixedRounds.get(p).has(s.round)) fixedIssues.push(`${p} is locked into two games in round ${s.round}`);
    if (!ok(p, s)) fixedIssues.push(`${p} is away in week ${s.week} but fixed into round ${s.round}`);
    fixedRounds.get(p).add(s.round);
    fixedCount.set(p, fixedCount.get(p) + 1);
  }
  const free = slots.filter(s => !fixed.has(s.id));

  // Exact targets: waterfill over each player's remaining capacity.
  const caps = players.map(p => {
    const avail = allRounds.filter(r => {
      const sample = slots.find(s => s.round === r);
      return sample && !p.absentWeeks.has(sample.week);
    }).length;
    const limit = p.cap == null ? avail : Math.min(avail, p.cap);
    return Math.max(0, limit - fixedCount.get(p.name));
  });
  const targets = waterfill(free.length, caps);
  if (!targets) fixedIssues.push('Not enough available rounds across the squad to fill every game.');

  const assignment = new Map(fixed);
  const scoreOf = new Map();
  let unfilled = [];

  function runOnce(bonus) {
    const N = 2 + free.length + players.length * allRounds.length + players.length;
    const g = new MCF(N);
    const S = 0, T = 1;
    const slotNode = new Map(free.map((s, i) => [s.id, 2 + i]));
    const base = 2 + free.length;
    const prNode = new Map(), pNode = new Map();
    players.forEach((p, i) => pNode.set(p.name, base + allRounds.length * players.length + i));
    players.forEach((p, pi) => allRounds.forEach((r, ri) => prNode.set(p.name + '|' + r, base + pi * allRounds.length + ri)));
    free.forEach(s => g.add(S, slotNode.get(s.id), 1, 0));
    const edges = [];
    for (const s of free) {
      for (const p of players) {
        if (!isElig(p.name, s)) continue;
        if (fixedRounds.get(p.name).has(s.round)) continue;
        const v = sc(p.name, s);
        let cost = -v - (v === favourite ? (bonus.get(p.name) || 0) : 0);
        cost += pairPen.get(p.name + '|' + s.game) || 0;
        if (current.get(s.id) !== undefined && current.get(s.id) !== p.name) cost += changePenalty;
        const id = g.add(slotNode.get(s.id), prNode.get(p.name + '|' + s.round), 1, cost);
        edges.push({ id, s, p: p.name });
      }
    }
    for (const p of players) {
      for (const r of allRounds) {
        if (fixedRounds.get(p.name).has(r)) continue;
        g.add(prNode.get(p.name + '|' + r), pNode.get(p.name), 1, 0);
      }
    }
    players.forEach((p, i) => {
      const cap = targets ? targets[i] : 0;
      g.add(pNode.get(p.name), T, cap, 0);
    });
    const need = free.length;
    g.run(S, T, need);
    const out = new Map(assignment);
    for (const e of edges) if (g.cap[e.id] === 0) out.set(e.s.id, e.p);
    unfilled = free.filter(s => !out.has(s.id)).map(s => s.id);
    return out;
  }

  function favMissing(map) {
    const missing = [];
    for (const p of players) {
      const hasFavAvail = slots.some(s => sc(p.name, s) === favourite && ok(p.name, s));
      if (!hasFavAvail) continue;
      const has = [...map.entries()].some(([sid, name]) => name === p.name && score(name, slotById.get(sid).game) === favourite);
      if (!has) missing.push(p.name);
    }
    return missing;
  }
  const totalScore = map => [...map.entries()].reduce((a, [sid, name]) => a + (score(name, slotById.get(sid).game) || 0), 0);

  let bonus = new Map(), best = null;
  if (!fixedIssues.length && targets) {
    for (let iter = 0; iter < 6; iter++) {
      const out = runOnce(bonus);
      const missing = favMissing(out);
      const cand = { map: out, missing, unfilled: unfilled.slice(), score: totalScore(out) };
      if (!best || cand.missing.length < best.missing.length ||
          (cand.missing.length === best.missing.length && cand.unfilled.length < best.unfilled.length) ||
          (cand.missing.length === best.missing.length && cand.unfilled.length === best.unfilled.length && cand.score > best.score)) best = cand;
      if (!missing.length || unfilled.length) break;
      for (const name of missing) bonus.set(name, (bonus.get(name) || 0) + (iter + 1) * 60);
    }
  } else {
    best = { map: assignment, missing: [], unfilled: free.map(s => s.id), score: 0 };
  }
  return {
    assignment: best.map,
    unfilled: best.unfilled,
    favMissing: best.missing,
    score: best.score,
    targets: targets ? Object.fromEntries(players.map((p, i) => [p.name, targets[i] + fixedCount.get(p.name)])) : null,
    issues: fixedIssues,
  };
}

/* Move proposal: force one or more (slot, player) moves, keep locks, and report every
   slot that changes. A single move can force a chain; a swap forces two slots at once. */
function proposeMoves(state, moves) {
  const fixed = new Map();
  for (const [sid, p] of state.current) if (state.locks.has(sid)) fixed.set(sid, p);
  for (const [sid, p] of moves) fixed.set(sid, p);
  const res = solveSchedule({ ...state.opts, fixed, current: state.current, changePenalty: state.changePenalty });
  const changes = [];
  for (const s of state.opts.slots) {
    const before = state.current.get(s.id), after = res.assignment.get(s.id);
    if (before !== after) changes.push({ slot: s, before, after });
  }
  return { res, changes };
}

/* Objective modes.
   happy:   maximise preference weights (favourites, then likes).
   nolearn: learning a new game (score 5) is penalised heavily, so the engine prefers known games.
   norepeat: iteratively penalise any player who gets the same game twice. */
const LEARN_PENALTY = -40, REPEAT_PENALTY = 40;
function repeatInfo(assignment, slots) {
  const count = new Map();
  for (const [sid, p] of assignment) {
    const s = slots.find(x => x.id === sid); if (!s) continue;
    const k = p + '|' + s.game; count.set(k, (count.get(k) || 0) + 1);
  }
  const pairs = [...count].filter(([, c]) => c > 1).map(([k]) => k);
  const total = [...count.values()].reduce((a, c) => a + Math.max(0, c - 1), 0);
  return { pairs, total };
}
const REPEAT_VALUE = 50; // one repeat is worth this many preference points when choosing swaps
function solveMode(opts, mode) {
  if (mode === 'nolearn') {
    return solveSchedule({ ...opts, score: (p, g) => { const v = opts.score(p, g); return v === 5 ? LEARN_PENALTY : v; } });
  }
  const r = solveSchedule(opts);
  if (mode !== 'norepeat') return r;
  // A penalty on each (player, game) pair cannot express "first time free, repeats costly",
  // so repeats are removed by a local search over swaps that keeps every rule intact.
  const locked = new Set(opts.fixed ? opts.fixed.keys() : []);
  return { ...r, assignment: reduceRepeats(r.assignment, opts, locked) };
}
function reduceRepeats(assign, opts, locked) {
  const slotById = new Map(opts.slots.map(s => [s.id, s]));
  const playerOf = new Map(opts.players.map(p => [p.name, p]));
  const map = new Map(assign);
  const val = (p, s) => { const v = opts.score(p, s.game); return typeof v === 'number' ? v : null; };
  const elig = (p, s) => val(p, s) !== null && !playerOf.get(p).absentWeeks.has(s.week);
  const inRound = (p, round, except) => [...map].some(([sid, q]) => sid !== except && q === p && slotById.get(sid).round === round);
  for (let step = 0; step < 500; step++) {
    const base = repeatInfo(map, opts.slots).total;
    if (base === 0) break;
    let best = null;
    const ids = [...map.keys()].filter(id => !locked.has(id));
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const a = slotById.get(ids[i]), b = slotById.get(ids[j]);
      const p = map.get(a.id), q = map.get(b.id);
      if (!p || !q || p === q) continue;
      if (!elig(p, b) || !elig(q, a)) continue;
      if (a.round !== b.round && (inRound(p, b.round, a.id) || inRound(q, a.round, b.id))) continue;
      const dScore = (val(p, b) + val(q, a)) - (val(p, a) + val(q, b));
      map.set(a.id, q); map.set(b.id, p);
      const saved = base - repeatInfo(map, opts.slots).total;
      map.set(a.id, p); map.set(b.id, q);
      if (saved <= 0) continue;
      const gain = saved * REPEAT_VALUE + dScore;
      if (gain > 0 && (!best || gain > best.gain)) best = { a: a.id, b: b.id, gain };
    }
    if (!best) break;
    const pa = map.get(best.a); map.set(best.a, map.get(best.b)); map.set(best.b, pa);
  }
  return map;
}
if (typeof module !== 'undefined') module.exports = { solveSchedule, proposeMoves, waterfill, solveMode, repeatInfo, reduceRepeats };
