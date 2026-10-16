// Renders the profile README art from the live GitHub contribution calendar: a snake that eats
// every active square, grows as it eats and shimmers in diffusion noise with each bite, above the
// telemetry meter from robinbinu.github.io, stepping in time with the snake.
//
// Usage: GITHUB_TOKEN=... node scripts/render.mjs [user]   (writes dist/snake.svg, dist/snake-light.svg)
//        CALENDAR=path/to/calendar.json node scripts/render.mjs   (render from a saved API response)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const USER = process.argv[2] ?? "Robinbinu";
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

// Geometry: GitHub's 53 × 7 calendar, square cells.
const CELL = 12, GAP = 3, STEP = CELL + GAP, PAD = 16;
const COLS = 53, ROWS = 7;
const BOARD_W = COLS * STEP - GAP, BOARD_H = ROWS * STEP - GAP;
const METER_TOP = PAD + BOARD_H + 22, METER_H = 40, METER_PAD = 16;
const WIDTH = BOARD_W + PAD * 2, HEIGHT = METER_TOP + METER_PAD + METER_H + 8;

const TICK = 0.05; // seconds per snake move; everything else steps on this beat
// A retro arcade palette, with no orange: orange belongs to the snake. Each day gets one colour;
// its contribution level sets the brightness.
const PALETTE = ["#ff4d79", "#a78bfa", "#4d9bff", "#00e0b0", "#3ddc84", "#fff36b"];
const LEVEL_OPACITY = [0, 0.62, 0.78, 0.9, 1];
const START_LEN = 3, HOLD = 24;
// Digestion: a bite is eaten at once, but the body grows by at most one square every DIGEST moves,
// so a run of squares on a straight line adds length steadily instead of all at once.
const DIGEST = 4;
const LEVEL = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };

const themes = {
  dark: {
    file: "snake.svg",
    dots: ["#161b22", "#4a2410", "#82391a", "#c4501a", "#ff6b1a"],
    accent: "#ff6b1a",
    bar: "#80858e",
    line: "#1d2025",
    text: "#ff6b1a",
  },
  light: {
    file: "snake-light.svg",
    dots: ["#ebedf0", "#ffd8c2", "#ffb088", "#ff8a4c", "#ff6b1a"],
    accent: "#ff6b1a",
    bar: "#8c959f",
    line: "#d0d7de",
    text: "#e8590c",
  },
};

// Deterministic pseudo-random so the same calendar always draws the same picture.
function rand(n) {
  const t = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return t - Math.floor(t);
}

async function calendar() {
  if (process.env.CALENDAR) return JSON.parse(readFileSync(process.env.CALENDAR, "utf8"));
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required (or CALENDAR=path to a saved response)");
  const query = `query($login:String!){user(login:$login){contributionsCollection{contributionCalendar{totalContributions weeks{contributionDays{date contributionCount contributionLevel weekday}}}}}}`;
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { authorization: `bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { login: USER } }),
  });
  if (!res.ok) throw new Error(`GitHub GraphQL ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(`GitHub GraphQL: ${JSON.stringify(json.errors)}`);
  return json;
}

const data = (await calendar()).data.user.contributionsCollection.contributionCalendar;
const days = data.weeks.flatMap((w, x) => w.contributionDays.map((d) => ({ x, y: d.weekday, level: LEVEL[d.contributionLevel] ?? 0 })));
if (data.weeks.length > COLS) throw new Error(`calendar has ${data.weeks.length} weeks, expected at most ${COLS}`);

// ---- Simulation -------------------------------------------------------------------------------
// The snake grows by one square per bite with no cap. It hunts random targets: for each, it finds
// a shortest path around its own body (accounting for the tail moving out of the way), replays
// that path exactly, and only commits if the head can still reach the tail afterwards, so it can
// never box itself in. When no target is safe it stalls by circling towards its tail and retries.
const key = (x, y) => `${x},${y}`;
const food = new Map(days.filter((d) => d.level > 0).map((d) => [key(d.x, d.y), d]));
const inside = (x, y) => x >= 0 && y >= 0 && x < COLS && y < ROWS;
const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// Seeded by the calendar's last day, so the hunt changes daily but each day renders identically.
const daySeed = Number(data.weeks.at(-1).contributionDays.at(-1).date.replaceAll("-", "")) % 100000;

// Breadth-first search from the head. `blocked(k, step)` says whether cell k is occupied when the
// head would arrive there on move `step`.
function search(start, isGoal, blocked) {
  const prev = new Map([[key(...start), null]]);
  let frontier = [start];
  for (let step = 1; frontier.length; step++) {
    const next = [];
    for (const [x, y] of frontier)
      for (const [dx, dy] of NEIGHBOURS) {
        const nx = x + dx, ny = y + dy, k = key(nx, ny);
        if (!inside(nx, ny) || prev.has(k) || blocked(k, step)) continue;
        prev.set(k, [x, y]);
        if (isGoal(k, step)) {
          const route = [];
          for (let c = [nx, ny]; key(...c) !== key(...start); c = prev.get(key(...c))) route.unshift(c);
          return route;
        }
        next.push([nx, ny]);
      }
    frontier = next;
  }
  return null;
}

// The head never touches the tail: once the snake is longer than its starting size there is always
// at least one empty square between them.
const gapOk = (b) => b.length <= START_LEN || Math.abs(b.at(-1)[0] - b[0][0]) + Math.abs(b.at(-1)[1] - b[0][1]) >= 2;

// Replays moves exactly. Bites join a digestion backlog; the tail holds still (the body grows)
// only when a backlog square is digested, otherwise it advances. Null if the head would hit the
// body or close the gap to the tail.
function replay(state, moves, meals) {
  const b = state.body.slice(), eaten = [], lengths = [];
  let { pending, since } = state;
  for (const cell of moves) {
    const k = key(...cell);
    if (meals.has(k) && !eaten.includes(k)) eaten.push(k), pending++;
    const grows = pending > 0 && since >= DIGEST - 1;
    const occupied = new Set((grows ? b : b.slice(1)).map((c) => key(...c)));
    if (occupied.has(k)) return null;
    b.push(cell);
    if (grows) pending--, (since = 0);
    else b.shift(), since++;
    if (!gapOk(b)) return null;
    lengths.push(b.length);
  }
  return { body: b, eaten, pending, since, lengths };
}

// Survival test: can the head reach a square of its current body after that square has been
// vacated, at least LAG moves behind the tail? If so the snake can always live by following its
// own trail without ever touching its tail, so the position is safe.
const LAG = 2;
function escapes(body) {
  const order = new Map(body.map((c, j) => [key(...c), j]));
  const near = nearTail(body);
  return !!search(
    body.at(-1),
    (k, step) => order.has(k) && step >= order.get(k) + LAG && !near(k, step),
    (k, step) => (order.has(k) && step < order.get(k) + LAG) || near(k, step),
  );
}

// Whether cell k would sit on or beside the tail after `step` moves (assuming no growth, the tail
// is then at body[step]). Planning around this keeps routes from closing the head-tail gap.
function nearTail(body) {
  return (k, step) => {
    if (body.length + 1 <= START_LEN || step >= body.length) return false;
    const [tx, ty] = body[step], [x, y] = k.split(",").map(Number);
    return Math.abs(x - tx) + Math.abs(y - ty) < 2;
  };
}

// Free squares reachable from the head, used to pick the roomiest move when stalling.
function room(body) {
  const walls = new Set(body.map((c) => key(...c)));
  let n = 0;
  search(body.at(-1), () => false, (k) => walls.has(k) || (n++, false));
  return n;
}

const tickOf = (i) => i - (START_LEN - 1); // path index -> tick at which the head is there

// One hunt from a given seed. A random hunt can box itself in before the board is clear, so
// several seeds are tried and the first run that eats every square is kept (else the best).
function hunt(seed) {
  const random = () => rand(seed++);
  let state = { body: [[0, 3], [1, 3], [2, 3]], pending: 0, since: 0 }; // body runs tail to head
  const path = state.body.slice(); // head positions; the first START_LEN form the starting body
  const lengths = [START_LEN]; // body length per tick
  const targets = []; // square being hunted per tick (null once everything is eaten)
  const eatenAt = new Map(); // food key -> tick
  const remaining = new Set(food.keys());
  // Squares under the starting body vanish at once but do not grow the snake.
  const underStart = new Set();
  for (const c of state.body) if (remaining.delete(key(...c))) eatenAt.set(key(...c), 0), underStart.add(key(...c));

  const pick = () => [...remaining][Math.floor(random() * remaining.size)];
  let target = pick(), stall = 0, stalls = 0;
  targets.push(target);
  // Hunt until every square is eaten, then keep moving until the backlog is digested.
  while ((remaining.size || state.pending) && stall < 400) {
    const body = state.body;
    const order = new Map(body.map((c, j) => [key(...c), j]));
    // A body segment j (0 = tail) has moved on by the time the head makes move j + 1.
    const near = nearTail(body);
    const blocked = (k, step) => (order.has(k) && order.get(k) >= step) || near(k, step);
    let committed = null;
    for (const goal of remaining.size ? [target, ...Array.from({ length: 10 }, pick)] : []) {
      if (!remaining.has(goal)) continue;
      const route = search(body.at(-1), (k) => k === goal, blocked);
      const after = route && replay(state, route, remaining);
      if (after && escapes(after.body)) {
        committed = { route, after, goal };
        target = goal;
        break;
      }
    }
    if (!committed) {
      // Stall: take the safe move that keeps the most room, then try again.
      let best = null;
      for (const [dx, dy] of NEIGHBOURS) {
        const cell = [body.at(-1)[0] + dx, body.at(-1)[1] + dy];
        if (!inside(...cell)) continue;
        const after = replay(state, [cell], remaining);
        if (!after) continue;
        const safe = escapes(after.body), space = room(after.body);
        if (!best || (safe && !best.safe) || (safe === best.safe && space > best.space)) best = { route: [cell], after, safe, space };
      }
      if (!best) break; // boxed in: the run ends here
      committed = { ...best, goal: remaining.size ? target : null };
      stall++, stalls++;
    } else stall = 0;
    for (const cell of committed.route) {
      path.push(cell);
      const k = key(...cell);
      if (committed.after.eaten.includes(k) && remaining.delete(k)) eatenAt.set(k, tickOf(path.length - 1));
    }
    lengths.push(...committed.after.lengths);
    targets.push(...committed.route.map(() => committed.goal));
    state = committed.after;
    if (!remaining.has(target) && remaining.size) target = pick();
  }
  return { path, eatenAt, underStart, stalls, lengths, targets, uneaten: remaining.size, undigested: state.pending };
}

// Prefer runs that eat everything, then runs that finish digesting it.
const shortfall = (r) => r.uneaten * 1000 + r.undigested;
let run;
for (let attempt = 0; attempt < 40; attempt++) {
  const r = hunt(daySeed + attempt * 7919);
  if (!run || shortfall(r) < shortfall(run)) run = r;
  if (!shortfall(run)) break;
}
const { path, eatenAt, underStart, stalls, lengths, targets, uneaten } = run;

const T = tickOf(path.length - 1) + 1; // ticks of movement
const TOTAL = T + HOLD;
const DUR = `${(TOTAL * TICK).toFixed(2)}s`;
const pct = (t) => `${((Math.max(0, t) / TOTAL) * 100).toFixed(3)}%`;

// Length per tick comes straight from the simulation (digestion included); bites drive the shimmer.
const bites = [...eatenAt].filter(([k]) => !underStart.has(k)).map(([, t]) => t).sort((a, b) => a - b);
const lengthAt = [], eatenAtTick = [];
for (let t = 0, b = 0; t < TOTAL; t++) {
  while (b < bites.length && bites[b] <= t) b++;
  lengthAt.push(lengths[Math.min(t, lengths.length - 1)]);
  eatenAtTick.push(b);
}
const eatenCountAt = (t) => eatenAtTick[t];

// Self-check: at every tick the body occupies distinct cells and the head keeps its gap to the tail.
for (let t = 0; t < T; t++) {
  const headIdx = t + START_LEN - 1;
  const seg = path.slice(Math.max(0, headIdx - lengthAt[t] + 1), headIdx + 1);
  const cells = seg.map((c) => key(...c));
  if (new Set(cells).size !== cells.length) throw new Error(`snake overlaps itself at tick ${t}`);
  if (!gapOk(seg)) throw new Error(`head touches tail at tick ${t}`);
}

// Shimmer strength per tick for two noise layers: each bite sets off a short, decaying flicker,
// stepping like the hero graph's diffusion intro.
const FLICKER_A = [1, 0.15, 0.8, 0.1, 0.45, 0, 0.2, 0];
const FLICKER_B = [0.2, 1, 0.1, 0.65, 0, 0.3, 0, 0];
const shimmerA = new Array(TOTAL).fill(0), shimmerB = new Array(TOTAL).fill(0);
for (const b of bites)
  FLICKER_A.forEach((v, i) => {
    if (b + i < TOTAL) {
      shimmerA[b + i] = Math.max(shimmerA[b + i], v);
      shimmerB[b + i] = Math.max(shimmerB[b + i], FLICKER_B[i]);
    }
  });

// ---- Drawing helpers ----------------------------------------------------------------------------
const cx = (x) => PAD + x * STEP + CELL / 2;
const cy = (y) => PAD + y * STEP + CELL / 2;
const trail = `M${path.map(([x, y]) => `${cx(x)} ${cy(y)}`).join(" L")}`;

// Steps through per-tick values, emitting a keyframe only when the value changes.
function keyframes(name, valueAt, render) {
  let frames = "", last;
  for (let t = 0; t < TOTAL; t++) {
    const v = valueAt(t);
    if (v !== last) frames += `${pct(t)}{${render(v)}}`;
    last = v;
  }
  return `@keyframes ${name}{${frames}100%{${render(valueAt(TOTAL - 1))}}}`;
}

// The snake is a square-dashed stroke along the head's trail (one dash per cell, mitred at
// corners), revealed through a mask whose dash spans exactly the cells the body occupies.
const bodyDash = (t) => {
  const head = Math.min(t, T - 1) + START_LEN - 1, n = lengthAt[t];
  const len = STEP * (n - 1) + CELL;
  const start = STEP * (head - n + 1) - CELL / 2;
  return `stroke-dasharray:${len} 100000;stroke-dashoffset:${-start}`;
};

// Orange-only noise for the shimmer: each cell is a deep, mid or bright orange, so a bite makes the
// body flicker in brightness like the hero graph, never towards white.
const SHIMMER = ["#82391a", "#c4501a", "#ff6b1a", "#ff8a3d"];
function noisePattern(id, seed) {
  let cells = "";
  for (let y = 0; y < 7; y++)
    for (let x = 0; x < 9; x++)
      cells += `<rect x="${x * STEP}" y="${y * STEP}" width="${CELL}" height="${CELL}" fill="${SHIMMER[Math.floor(rand(seed + y * 9 + x) * SHIMMER.length)]}"/>`;
  return `<pattern id="${id}" patternUnits="userSpaceOnUse" x="${PAD}" y="${PAD}" width="${9 * STEP}" height="${7 * STEP}">${cells}</pattern>`;
}

// Every board cell has a fixed colour; days show it at their level's brightness.
const colourOf = (x, y) => PALETTE[Math.floor(rand(x * 7 + y * 131 + 5) * PALETTE.length)];
// The body is orange, each square at a slightly different brightness, like the hero staircase.
function bodyPattern(accent) {
  let cells = "";
  for (let x = 0; x < COLS; x++)
    for (let y = 0; y < ROWS; y++)
      cells += `<rect x="${cx(x) - CELL / 2}" y="${cy(y) - CELL / 2}" width="${CELL}" height="${CELL}" fill="${accent}" fill-opacity="${(0.72 + rand(x * 13 + y * 71 + 3) * 0.28).toFixed(2)}"/>`;
  return `<pattern id="paint" patternUnits="userSpaceOnUse" x="0" y="0" width="${WIDTH}" height="${HEIGHT}">${cells}</pattern>`;
}

// Readout digits change only when their value does: one text element per value, shown for its span.
function readout(id, x, valueAt) {
  const spans = [];
  for (let t = 0; t < TOTAL; t++) {
    const v = valueAt(t);
    if (!spans.length || spans.at(-1).v !== v) spans.push({ v, from: t, to: t });
    else spans.at(-1).to = t;
  }
  if (spans.length === 1) return `<text x="${x}" y="${METER_TOP + 9}" class="ro">${String(spans[0].v).padStart(2, "0")}</text>`;
  return spans
    .map((s, i) => {
      const name = `${id}${i}`;
      return `<text x="${x}" y="${METER_TOP + 9}" class="ro" style="animation-name:${name}">${String(s.v).padStart(2, "0")}</text><style>@keyframes ${name}{0%{opacity:0}${pct(s.from)}{opacity:1}${s.to + 1 < TOTAL ? `${pct(s.to + 1)}{opacity:0}` : ""}100%{opacity:${s.to + 1 >= TOTAL ? 1 : 0}}}</style>`;
    })
    .join("\n");
}

function render(theme) {
  // Board: empty cells everywhere, active squares on top until eaten, back when the loop restarts.
  let board = "";
  for (let x = 0; x < COLS; x++)
    for (let y = 0; y < ROWS; y++)
      board += `<rect x="${cx(x) - CELL / 2}" y="${cy(y) - CELL / 2}" width="${CELL}" height="${CELL}"/>`;
  const foods = [...food.entries()]
    .map(([k, d], i) => {
      const t = eatenAt.get(k);
      return `<rect class="food" style="animation-name:f${i}" x="${cx(d.x) - CELL / 2}" y="${cy(d.y) - CELL / 2}" width="${CELL}" height="${CELL}" fill="${colourOf(d.x, d.y)}" fill-opacity="${LEVEL_OPACITY[d.level]}"/><style>@keyframes f${i}{0%{opacity:1}${pct(t)}{opacity:0}${pct(TOTAL - 1)}{opacity:0}100%{opacity:1}}</style>`;
    })
    .join("\n");

  // Meter: 96 bars stepping on the snake's beat, a beam advancing one bar per move.
  const n = Math.floor(BOARD_W / 8.25);
  let bars = "", hot = [];
  for (let i = 0; i < n; i++) {
    const h = Math.min(1, 0.2 + 0.55 * ((Math.sin(i / 6) + 1) / 2) * (0.5 + 0.5 * rand(i)) + 0.25 * rand(i + 31));
    const isHot = rand(i + 63) > 0.94;
    const x = (PAD + (i + 0.5) * (BOARD_W / n)).toFixed(1);
    if (isHot) hot.push(x);
    bars += `<line class="bar${isHot ? " hot" : ""}" style="animation-delay:${(-(i % 8) * TICK).toFixed(3)}s" x1="${x}" x2="${x}" y1="${METER_TOP + METER_PAD + METER_H}" y2="${(METER_TOP + METER_PAD + METER_H - h * METER_H).toFixed(1)}"/>`;
  }
  const beamW = 40;
  const ro = [
    ["len", (t) => lengthAt[t]],
    ["eat", (t) => eatenCountAt(t)],
    ["sum", () => data.totalContributions],
  ];
  const readouts = hot
    .slice(0, 3)
    .map((x, i) => `${readout(ro[i][0], x, ro[i][1])}<line x1="${x}" x2="${x}" y1="${METER_TOP + 12}" y2="${METER_TOP + 15}" stroke="${theme.accent}" stroke-opacity=".5"/>`)
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}">
<defs>
<clipPath id="board"><rect x="${PAD - 1}" y="${PAD - 1}" width="${BOARD_W + 2}" height="${BOARD_H + 2}"/></clipPath>
<mask id="body" maskUnits="userSpaceOnUse" x="0" y="0" width="${WIDTH}" height="${HEIGHT}"><path class="reveal" d="${trail}" fill="none" stroke="#fff" stroke-width="${CELL + 2}" stroke-linejoin="miter"/></mask>
${bodyPattern(theme.accent)}
${noisePattern("noiseA", 11)}
${noisePattern("noiseB", 97)}
<clipPath id="meter"><rect x="${PAD}" y="${METER_TOP + METER_PAD}" width="${BOARD_W}" height="${METER_H}"/></clipPath>
</defs>
<style>
.food{animation-duration:${DUR};animation-iteration-count:infinite;animation-timing-function:steps(1,end)}
.reveal{animation:reveal ${DUR} steps(1,end) infinite}
${keyframes("reveal", (t) => bodyDash(t), (v) => v)}
.snake{animation:fade ${DUR} steps(1,end) infinite}
@keyframes fade{0%{opacity:1}${pct(TOTAL - 4)}{opacity:.5}${pct(TOTAL - 2)}{opacity:0}100%{opacity:1}}
.head{filter:drop-shadow(0 0 4px ${theme.accent});animation:head ${DUR} steps(1,end) infinite}
.target{animation:target ${DUR} steps(1,end) infinite}
/* The hunted square strobes about three times a second, glowing in its own colour. */
.target rect{filter:drop-shadow(0 0 5px currentColor);animation:strobe .32s steps(1,end) infinite}
@keyframes strobe{0%{opacity:1}55%{opacity:0}}
${keyframes(
  "target",
  (t) => (t < T ? targets[t] : null),
  (k) => {
    if (!k) return "opacity:0";
    const [x, y] = k.split(",").map(Number);
    return `opacity:1;transform:translate(${cx(x) - CELL / 2}px,${cy(y) - CELL / 2}px);fill:${colourOf(x, y)};color:${colourOf(x, y)}`;
  },
)}
${keyframes("head", (t) => path[Math.min(t, T - 1) + START_LEN - 1], ([x, y]) => `transform:translate(${cx(x) - CELL / 2}px,${cy(y) - CELL / 2}px)`)}
.sa{animation:sa ${DUR} steps(1,end) infinite}.sb{animation:sb ${DUR} steps(1,end) infinite}
${keyframes("sa", (t) => shimmerA[t], (v) => `opacity:${v}`)}
${keyframes("sb", (t) => shimmerB[t], (v) => `opacity:${v}`)}
.bar{stroke:${theme.bar};stroke-opacity:.45;stroke-width:1;transform-box:fill-box;transform-origin:bottom;animation:sway ${(8 * TICK).toFixed(3)}s steps(4,end) infinite alternate}
.bar.hot{stroke:${theme.accent};stroke-opacity:1}
@keyframes sway{from{transform:scaleY(.72)}to{transform:scaleY(1)}}
.beam{animation:beam ${(n * TICK).toFixed(2)}s steps(${n},end) infinite}
@keyframes beam{from{transform:translateX(${-beamW}px)}to{transform:translateX(${BOARD_W}px)}}
.ro{font:500 9px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;fill:${theme.text};text-anchor:middle;letter-spacing:.06em;opacity:0;animation-duration:${DUR};animation-iteration-count:infinite;animation-timing-function:steps(1,end)}
text.ro:not([style]){opacity:1}
@media (prefers-reduced-motion:reduce){*{animation:none!important}.ro{opacity:1}}
</style>
<g fill="${theme.dots[0]}">${board}</g>
${foods}
<g class="target" opacity="0"><rect width="${CELL}" height="${CELL}"/></g>
<g class="snake" clip-path="url(#board)" mask="url(#body)">
<path d="${trail}" fill="none" stroke="url(#paint)" stroke-width="${CELL}" stroke-dasharray="${CELL} ${GAP}" stroke-dashoffset="${CELL / 2}" stroke-linejoin="miter"/>
<path class="sa" d="${trail}" fill="none" stroke="url(#noiseA)" stroke-width="${CELL}" stroke-dasharray="${CELL} ${GAP}" stroke-dashoffset="${CELL / 2}" stroke-linejoin="miter"/>
<path class="sb" d="${trail}" fill="none" stroke="url(#noiseB)" stroke-width="${CELL}" stroke-dasharray="${CELL} ${GAP}" stroke-dashoffset="${CELL / 2}" stroke-linejoin="miter"/>
<rect class="head" width="${CELL}" height="${CELL}" fill="${theme.accent}"/>
</g>
<line x1="${PAD}" x2="${PAD + BOARD_W}" y1="${METER_TOP + METER_PAD + METER_H + 0.5}" y2="${METER_TOP + METER_PAD + METER_H + 0.5}" stroke="${theme.line}"/>
<g clip-path="url(#meter)">${bars}<rect class="beam" x="${PAD}" y="${METER_TOP + METER_PAD}" width="${beamW}" height="${METER_H}" fill="${theme.accent}" fill-opacity=".07"/><line class="beam" x1="${PAD + beamW}" x2="${PAD + beamW}" y1="${METER_TOP + METER_PAD}" y2="${METER_TOP + METER_PAD + METER_H}" stroke="${theme.accent}" stroke-opacity=".6"/></g>
${readouts}
</svg>
`;
}

mkdirSync(out, { recursive: true });
for (const theme of Object.values(themes)) writeFileSync(join(out, theme.file), render(theme));
console.log(`${food.size} squares (${uneaten} uneaten), ${T} moves (${stalls} stalls), ${DUR} loop, max length ${Math.max(...lengthAt)}, ${data.totalContributions} contributions`);
