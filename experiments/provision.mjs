// Provision the remote databases the experiments need, and mint a fresh
// rw group token (the old one is burned — it leaked into a chat transcript).
//
// Env: TURSO_PLATFORM_TOKEN, TURSO_ORG, TURSO_GROUP (default "default")
// Run:  node experiments/provision.mjs [--delete]

const TOKEN = process.env.TURSO_PLATFORM_TOKEN;
const ORG = process.env.TURSO_ORG;
const GROUP = process.env.TURSO_GROUP ?? "default";
if (!TOKEN || !ORG) {
  console.error("need TURSO_PLATFORM_TOKEN and TURSO_ORG");
  process.exit(1);
}

const API = `https://api.turso.tech/v1/organizations/${ORG}`;

const DATABASES = [
  "expa-lag",
  "expa-timeouts",
  ...Array.from({ length: 5 }, (_, i) => `expa-wf${i}`),
  "expb0-race",
  "expb0-timeouts",
  "expb1-race",
  "expb1-timeouts",
];

async function api(method, path, body) {
  const t0 = performance.now();
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ms = Math.round(performance.now() - t0);
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, ms, json };
}

if (process.argv.includes("--delete")) {
  for (const name of DATABASES) {
    const r = await api("DELETE", `/databases/${name}`);
    console.log(`delete ${name} -> ${r.status}`);
  }
  process.exit(0);
}

const times = [];
for (const name of DATABASES) {
  const r = await api("POST", "/databases", { name, group: GROUP });
  times.push(r.ms);
  console.log(`create ${name} -> ${r.status} in ${r.ms}ms ${r.status >= 300 ? JSON.stringify(r.json).slice(0, 150) : ""}`);
}
times.sort((a, b) => a - b);
console.log(`create latency: min=${times[0]}ms median=${times[Math.floor(times.length / 2)]}ms max=${times[times.length - 1]}ms`);

const mint = await api("POST", `/groups/${GROUP}/auth/tokens?expiration=8h&authorization=full-access`);
if (!mint.json?.jwt) {
  console.error(`token mint failed: ${mint.status} ${JSON.stringify(mint.json).slice(0, 200)}`);
  process.exit(1);
}
console.log("\nexport these for the experiments:");
console.log(`export TURSO_ORG='${ORG}'`);
console.log(`export TURSO_GROUP_TOKEN='${mint.json.jwt}'`);
