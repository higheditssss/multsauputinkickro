import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import https from "https";

const app = express();
app.use(express.json({ limit: "300kb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");

// === Channels list (slugs) ===
const CHANNELS = [
  "hyghman",
  "w2ge",
  "roxanne_roxx",
  "ket_14",
  "godeanu",
  "poseidonn99",
  "anduu14",
  "stezyvr",
  "tedereu",
  "cartusu",
  "nicusor7gaming",
  "markoglasslive",
  "potrix",
  "zasami",
  "therealred",
  "bvcovia",
  "kopee",
  "kasimksm23",
];

// ===== Helpers =====
function safeSlug(input) {
  if (!input) return "";
  let s = String(input).trim();
  s = s.replace(/^https?:\/\/(www\.)?/i, "");
  s = s.replace(/^kick\.com\//i, "");
  s = s.split(/[?#/]/)[0];
  s = s.toLowerCase().replace(/[^a-z0-9_]/g, "");
  return s;
}

function fileExists(p) {
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function fetchJson(url, { headers = {}, timeoutMs = 12000 } = {}, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
          Accept: "application/json,text/plain,*/*",
          ...headers,
        },
      },
      (res) => {
        const status = res.statusCode || 0;

        if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
          const next = res.headers.location.startsWith("http")
            ? res.headers.location
            : new URL(res.headers.location, url).toString();
          res.resume();
          return resolve(fetchJson(next, { headers, timeoutMs }, redirectsLeft - 1));
        }

        let raw = "";
        res.on("data", (d) => (raw += d));
        res.on("end", () => {
          if (status < 200 || status >= 300) {
            return reject(new Error(`HTTP ${status} for ${url} :: ${raw.slice(0, 300)}`));
          }
          try {
            resolve(JSON.parse(raw));
          } catch {
            reject(new Error(`Bad JSON from ${url} :: ${raw.slice(0, 300)}`));
          }
        });
      }
    );

    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout after ${timeoutMs}ms for ${url}`)));
    req.end();
  });
}

function pickFirst(...vals) {
  for (const v of vals) {
    if (v === 0) return 0;
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

function extractKickProfile(obj, slug) {
  const user = obj?.user || obj?.channel?.user || obj?.data?.user || obj?.data || null;

  const displayName = pickFirst(
    obj?.display_name,
    obj?.displayName,
    obj?.username,
    user?.display_name,
    user?.displayName,
    user?.username,
    slug
  );

  const followers = pickFirst(
    obj?.followers_count,
    obj?.followersCount,
    obj?.followers,
    user?.followers_count,
    user?.followersCount,
    user?.followers
  );

  const profilePic = pickFirst(
    obj?.profile_image?.url,
    obj?.profile_pic,
    obj?.profilePic,
    user?.profile_image?.url,
    user?.profile_picture?.url,
    user?.profile_pic,
    user?.profilePic,
    user?.profile_image
  );

  return {
    slug,
    displayName: displayName || slug,
    followers: typeof followers === "number" ? followers : null,
    profilePic: profilePic || null,
    source: "kick",
  };
}

// ===== Optional: Piloterr for followers_count =====
async function fetchFromPiloterr(slug) {
  const key = process.env.PILOTERR_API_KEY;
  if (!key) return null;

  const url = `https://piloterr.com/api/v2/kick/user/info?query=${encodeURIComponent(slug)}`;
  const data = await fetchJson(url, {
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
    },
  });

  return {
    slug,
    displayName: data?.username || slug,
    followers: typeof data?.followers_count === "number" ? data.followers_count : null,
    profilePic: data?.profile_image?.url || null,
    source: "piloterr",
  };
}

// ===== Kick fetch (best-effort) =====
async function fetchFromKick(slug) {
  const tries = [
    `https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`,
    `https://kick.com/api/v1/channels/${encodeURIComponent(slug)}`,
  ];

  let lastErr = null;
  for (const url of tries) {
    try {
      const data = await fetchJson(url);
      const normalized = data?.channel ? data.channel : data;
      return extractKickProfile(normalized, slug);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Kick request failed");
}

// ===== Cache =====
const CACHE = new Map(); // slug -> { data, exp }
const CACHE_TTL_MS = 60_000;

async function getPlayerData(slug) {
  const now = Date.now();
  const cached = CACHE.get(slug);
  if (cached && cached.exp > now) return cached.data;

  let kick = null;
  try {
    kick = await fetchFromKick(slug);
  } catch (e) {
    kick = {
      slug,
      displayName: slug,
      followers: null,
      profilePic: null,
      source: "kick_error",
      error: String(e?.message || e),
    };
  }

  let pil = null;
  try {
    pil = await fetchFromPiloterr(slug);
  } catch {
    pil = null;
  }

  const merged = {
    slug,
    displayName: pickFirst(pil?.displayName, kick.displayName, slug),
    followers: pickFirst(pil?.followers, kick.followers),
    profilePic: pickFirst(pil?.profilePic, kick.profilePic),
    sources: { kick: kick.source, piloterr: pil ? pil.source : null },
    followersAvailable: typeof pickFirst(pil?.followers, kick.followers) === "number",
  };

  CACHE.set(slug, { data: merged, exp: now + CACHE_TTL_MS });
  return merged;
}

// ===== Static routes =====
app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));

function sendMissing(res, missingFile) {
  res.status(500).type("text").send(
    [
      `Missing file:\n${missingFile}\n`,
      `Fix:`,
      `- create folder "public"`,
      `- put "index.html" inside public`,
      ``,
      `Expected:`,
      `${path.join(__dirname, "public", "index.html")}`,
      ``,
    ].join("\n")
  );
}

app.get("/", (req, res) => {
  const p = path.join(PUBLIC_DIR, "index.html");
  if (!fileExists(p)) return sendMissing(res, p);
  res.sendFile(p);
});

// ✅ /game (URL clean)
app.get("/game", (req, res) => {
  const gameFile = path.join(PUBLIC_DIR, "game.html");
  const fallbackSolo = path.join(PUBLIC_DIR, "solo.html");

  if (fileExists(gameFile)) return res.sendFile(gameFile);
  if (fileExists(fallbackSolo)) return res.sendFile(fallbackSolo);

  return sendMissing(res, gameFile);
});

// Optional: dacă cineva intră pe vechiul /solo.html => redirect către /game
app.get("/solo.html", (req, res) => res.redirect(302, "/game"));

// ===== API =====
app.get("/api/players", (req, res) => {
  res.json({ ok: true, players: CHANNELS });
});

app.get("/api/kick", async (req, res) => {
  const slug = safeSlug(req.query.user);
  if (!slug) return res.status(400).json({ ok: false, error: "Missing ?user=" });

  try {
    const data = await getPlayerData(slug);
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/kick/batch", async (req, res) => {
  try {
    const users = Array.isArray(req.body?.users) ? req.body.users : [];
    const slugs = users.map(safeSlug).filter(Boolean);

    const results = [];
    for (const slug of slugs) {
      try {
        const data = await getPlayerData(slug);
        results.push({ ok: true, data });
      } catch (e) {
        results.push({ ok: false, slug, error: String(e?.message || e) });
      }
    }

    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/_debug", (req, res) => {
  const files = fileExists(PUBLIC_DIR) ? fs.readdirSync(PUBLIC_DIR) : [];
  res.json({
    cwd: process.cwd(),
    __dirname,
    publicDir: PUBLIC_DIR,
    filesInPublic: files,
    hasPiloterrKey: Boolean(process.env.PILOTERR_API_KEY),
  });
});

// ===== Start =====
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`   - Menu:  http://localhost:${PORT}/`);
  console.log(`   - Game:  http://localhost:${PORT}/game`);
  console.log(`   - Debug: http://localhost:${PORT}/_debug`);
});