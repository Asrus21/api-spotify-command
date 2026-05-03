require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || `http://localhost:${PORT}/callback`;

// ─── Banco de dados PostgreSQL ────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tokens (
      user_id     TEXT PRIMARY KEY,
      access_token  TEXT,
      refresh_token TEXT,
      created_at  TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log("✅ Banco de dados pronto.");
}

async function getUser(userId) {
  const res = await pool.query("SELECT * FROM tokens WHERE user_id = $1", [userId]);
  return res.rows[0] || null;
}

async function saveUser(userId, accessToken, refreshToken) {
  await pool.query(`
    INSERT INTO tokens (user_id, access_token, refresh_token)
    VALUES ($1, $2, $3)
    ON CONFLICT (user_id) DO UPDATE
    SET access_token = $2, refresh_token = $3
  `, [userId, accessToken, refreshToken]);
}

async function updateAccessToken(userId, accessToken) {
  await pool.query("UPDATE tokens SET access_token = $1 WHERE user_id = $2", [accessToken, userId]);
}

// ─── ROTA 1: Gerar link único de autorização ──────────────────────────────────
app.get("/register", (req, res) => {
  const userId = uuidv4().replace(/-/g, "").slice(0, 12);

  const authUrl =
    `https://accounts.spotify.com/authorize?` +
    `client_id=${CLIENT_ID}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=${encodeURIComponent("user-read-currently-playing user-read-playback-state")}` +
    `&state=${userId}`;

  res.send(`
    <html>
      <body style="font-family:sans-serif;text-align:center;padding:60px;background:#191414;color:#fff;">
        <h2>🎵 Spotify Now Playing</h2>
        <p style="margin:30px 0">
          <a href="${authUrl}" style="background:#1DB954;color:#000;padding:14px 28px;border-radius:30px;text-decoration:none;font-weight:bold;font-size:16px;">
            ✅ Autorizar Spotify
          </a>
        </p>
      </body>
    </html>
  `);
});

// ─── ROTA 2: Callback do Spotify ──────────────────────────────────────────────
app.get("/callback", async (req, res) => {
  const { code, state: userId } = req.query;

  if (!code || !userId) return res.send("❌ Autorização negada.");

  try {
    const tokenRes = await axios.post(
      "https://accounts.spotify.com/api/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    await saveUser(userId, tokenRes.data.access_token, tokenRes.data.refresh_token);

    res.send(`
      <html>
        <body style="font-family:sans-serif;text-align:center;padding:60px;background:#191414;color:#fff;">
          <h2>✅ Autorizado com sucesso!</h2>
          <p style="color:#aaa;">Use o link abaixo no seu bot:</p>
          <code style="background:#333;padding:12px 24px;border-radius:6px;display:inline-block;margin:16px 0;font-size:15px;">
            ${BASE_URL}/musica/${userId}
          </code>
          <br><br>
          <p style="color:#aaa;font-size:13px;">Nightbot:</p>
          <code style="background:#222;padding:8px 16px;border-radius:6px;display:inline-block;">$(urlfetch ${BASE_URL}/musica/${userId})</code>
          <br><br>
          <p style="color:#aaa;font-size:13px;">StreamElements:</p>
          <code style="background:#222;padding:8px 16px;border-radius:6px;display:inline-block;">${"${customapi." + BASE_URL + "/musica/" + userId + "}"}</code>
        </body>
      </html>
    `);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.send("❌ Erro ao obter token.");
  }
});

// ─── Refresh do token ─────────────────────────────────────────────────────────
async function refreshAccessToken(userId) {
  const user = await getUser(userId);
  if (!user?.refresh_token) throw new Error("Sem refresh token");

  const res = await axios.post(
    "https://accounts.spotify.com/api/token",
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: user.refresh_token,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  await updateAccessToken(userId, res.data.access_token);
  return res.data.access_token;
}

// ─── Buscar música atual ───────────────────────────────────────────────────────
async function fetchCurrentTrack(token) {
  const playing = await axios.get(
    "https://api.spotify.com/v1/me/player/currently-playing",
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!playing.data || playing.status === 204 || !playing.data.item) {
    return null;
  }

  const track = playing.data.item;
  return `🎵 Tocando agora: ${track.name} - ${track.artists.map((a) => a.name).join(", ")} | ${track.external_urls.spotify}`;
}

// ─── ROTA 3: Música atual ─────────────────────────────────────────────────────
app.get("/musica/:userId", async (req, res) => {
  const { userId } = req.params;
  const user = await getUser(userId);

  if (!user || !user.access_token) {
    return res.send("❌ ID inválido ou não autorizado.");
  }

  try {
    const result = await fetchCurrentTrack(user.access_token);
    if (!result) return res.send("😶 Não está sendo tocado nada agora.");
    res.send(result);
  } catch (err) {
    if (err.response?.status === 401) {
      try {
        const newToken = await refreshAccessToken(userId);
        const result = await fetchCurrentTrack(newToken);
        if (!result) return res.send("😶 Não está sendo tocado nada agora.");
        return res.send(result);
      } catch {
        return res.send("❌ Sessão expirada. Registre-se novamente em /register");
      }
    }
    console.error(err.message);
    res.send("❌ Erro ao buscar música.");
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🎵 Servidor rodando na porta ${PORT}`);
    console.log(`🔗 Registrar: ${BASE_URL}/register\n`);
  });
});

// Doing a little test on my code.
