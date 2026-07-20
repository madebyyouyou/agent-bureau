// Lightweight per-session I/O counters. The old per-second stats broadcast was
// removed after frontend status tracking moved away from I/O heuristics.
const net = {}; // id -> byte counters

function ensure(id) {
  if (!net[id]) net[id] = { in: 0, out: 0 };
  return net[id];
}

function trackIn(id, bytes) {
  const n = ensure(id);
  n.in += bytes;
}

function trackOut(id, data) {
  const n = ensure(id);
  n.out += data.length;
}

function clear(id) { delete net[id]; }

module.exports = { trackIn, trackOut, clear };
