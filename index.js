require("dotenv").config();
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ─── Credenciais da Last.fm ───────────────────────────────────────────────────
const LASTFM_API_KEY = process.env.LASTFM_API_KEY;
const LASTFM_SECRET = process.env.LASTFM_SECRET;
const LASTFM_API = "https://ws.audioscrobbler.com/2.0/";

// ─── Banco de dados PostgreSQL ────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lastfm_users (
      lastfm_user   TEXT PRIMARY KEY,
      command_id    TEXT UNIQUE NOT NULL,
      session_key   TEXT,
      created_at    TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log("✅ Banco de dados pronto.");
}

async function getUserByLastfm(lastfmUser) {
  const res = await pool.query("SELECT * FROM lastfm_users WHERE lastfm_user = $1", [lastfmUser]);
  return res.rows[0] || null;
}

async function getUserByCommandId(commandId) {
  const res = await pool.query("SELECT * FROM lastfm_users WHERE command_id = $1", [commandId]);
  return res.rows[0] || null;
}

async function saveUser(lastfmUser, commandId, sessionKey) {
  await pool.query(`
    INSERT INTO lastfm_users (lastfm_user, command_id, session_key)
    VALUES ($1, $2, $3)
    ON CONFLICT (lastfm_user) DO UPDATE
    SET session_key = $3
  `, [lastfmUser, commandId, sessionKey]);
}

// ─── Assinatura de chamadas da Last.fm ────────────────────────────────────────
// A Last.fm exige um api_sig: md5 de todos os params ordenados + secret
function signRequest(params) {
  const sorted = Object.keys(params).sort();
  let signString = "";
  for (const key of sorted) {
    signString += key + params[key];
  }
  signString += LASTFM_SECRET;
  return crypto.createHash("md5").update(signString, "utf8").digest("hex");
}

// ─── ROTA 1: Link de autorização ──────────────────────────────────────────────
app.get("/register", (req, res) => {
  // A Last.fm redireciona de volta para o callback após autorizar
  const callbackUrl = `${BASE_URL}/callback`;
  const authUrl = `https://www.last.fm/api/auth/?api_key=${LASTFM_API_KEY}&cb=${encodeURIComponent(callbackUrl)}`;

  res.send(`
    <html>
      <body style="font-family:sans-serif;text-align:center;padding:60px;background:#191414;color:#fff;">
        <h2>🎵 Now Playing — Comando de Live</h2>
        <p style="color:#aaa;max-width:420px;margin:16px auto;">
          Conecte sua conta Last.fm. Se você ainda nao tem, crie uma e conecte seu Spotify nas configuracoes da Last.fm (scrobbling).
        </p>
        <p style="margin:30px 0">
          <a href="${authUrl}" style="background:#d51007;color:#fff;padding:14px 28px;border-radius:30px;text-decoration:none;font-weight:bold;font-size:16px;">
            ✅ Autorizar com Last.fm
          </a>
        </p>
      </body>
    </html>
  `);
});

// ─── ROTA 2: Callback da Last.fm ──────────────────────────────────────────────
app.get("/callback", async (req, res) => {
  const { token } = req.query;

  if (!token) return res.send("❌ Autorização negada.");

  try {
    // Troca o token por uma sessao permanente (auth.getSession)
    const params = {
      method: "auth.getSession",
      api_key: LASTFM_API_KEY,
      token: token,
    };
    const api_sig = signRequest(params);

    const sessionRes = await axios.get(LASTFM_API, {
      params: { ...params, api_sig, format: "json" },
    });

    const session = sessionRes.data.session;
    if (!session) {
      return res.send("❌ Erro ao criar sessao na Last.fm.");
    }

    const lastfmUser = session.name;
    const sessionKey = session.key;

    // Mantem o command_id se a conta ja existir
    const existing = await getUserByLastfm(lastfmUser);
    const commandId = existing ? existing.command_id : uuidv4().replace(/-/g, "").slice(0, 12);

    await saveUser(lastfmUser, commandId, sessionKey);

    res.send(`
      <html>
        <body style="font-family:sans-serif;text-align:center;padding:60px;background:#191414;color:#fff;">
          <h2>✅ Autorizado com sucesso!</h2>
          <p style="color:#aaa;">Conta Last.fm: <strong>${lastfmUser}</strong></p>
          <p style="color:#aaa;margin-top:24px;">Use o link abaixo no seu bot:</p>
          <code style="background:#333;padding:12px 24px;border-radius:6px;display:inline-block;margin:16px 0;font-size:15px;">
            ${BASE_URL}/musica/${commandId}
          </code>
          <br><br>
          <p style="color:#aaa;font-size:13px;">Nightbot:</p>
          <code style="background:#222;padding:8px 16px;border-radius:6px;display:inline-block;">$(urlfetch ${BASE_URL}/musica/${commandId})</code>
          <br><br>
          <p style="color:#aaa;font-size:13px;">StreamElements:</p>
          <code style="background:#222;padding:8px 16px;border-radius:6px;display:inline-block;">${"${customapi." + BASE_URL + "/musica/" + commandId + "}"}</code>
          <br><br>
          <p style="color:#d51007;font-size:13px;">⚠️ Lembre de conectar o Spotify a sua Last.fm para o scrobbling funcionar.</p>
        </body>
      </html>
    `);
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error("❌ Erro no callback:", JSON.stringify(detail));
    res.send(`❌ Erro ao obter sessao: ${JSON.stringify(detail)}`);
  }
});

// ─── Buscar musica atual (user.getRecentTracks) ───────────────────────────────
async function fetchNowPlaying(lastfmUser) {
  const res = await axios.get(LASTFM_API, {
    params: {
      method: "user.getRecentTracks",
      user: lastfmUser,
      api_key: LASTFM_API_KEY,
      format: "json",
      limit: 1,
    },
  });

  const tracks = res.data.recenttracks?.track;
  if (!tracks || tracks.length === 0) return null;

  const track = Array.isArray(tracks) ? tracks[0] : tracks;

  // A flag @attr.nowplaying indica se esta tocando agora
  const isNowPlaying = track["@attr"] && track["@attr"].nowplaying === "true";
  if (!isNowPlaying) return null;

  const name = track.name;
  const artist = track.artist["#text"] || track.artist.name;
  const url = track.url;

  return `🎵 Tocando agora: ${name} - ${artist} | ${url}`;
}

// ─── ROTA 3: Musica atual ─────────────────────────────────────────────────────
app.get("/musica/:commandId", async (req, res) => {
  const { commandId } = req.params;
  const user = await getUserByCommandId(commandId);

  if (!user) {
    return res.send("❌ ID invalido ou nao autorizado.");
  }

  try {
    const result = await fetchNowPlaying(user.lastfm_user);
    if (!result) return res.send("😶 Não está sendo tocado nada agora.");
    res.send(result);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.send("❌ Erro ao buscar música.");
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🎵 Servidor rodando na porta ${PORT}`);
  console.log(`🔗 Registrar: ${BASE_URL}/register\n`);
});

initDB().catch((err) => {
  console.error("❌ Erro ao conectar ao banco:", err.message);
});
