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
  // Cria a tabela se não existir
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tokens (
      spotify_id    TEXT PRIMARY KEY,
      command_id    TEXT UNIQUE NOT NULL,
      access_token  TEXT,
      refresh_token TEXT,
      created_at    TIMESTAMP DEFAULT NOW()
    )
  `);

  // Migração segura: adiciona colunas novas se ainda não existirem
  await pool.query(`
    ALTER TABLE tokens
    ADD COLUMN IF NOT EXISTS spotify_id TEXT,
    ADD COLUMN IF NOT EXISTS command_id TEXT
  `).catch(() => {}); // ignora se já existir

  console.log("✅ Banco de dados pronto.");
}

async function getUserBySpotifyId(spotifyId) {
  const res = await pool.query("SELECT * FROM tokens WHERE spotify_id = $1", [spotifyId]);
  return res.rows[0] || null;
}

async function getUserByCommandId(commandId) {
  const res = await pool.query("SELECT * FROM tokens WHERE command_id = $1", [commandId]);
  return res.rows[0] || null;
}

async function saveUser(spotifyId, commandId, accessToken, refreshToken) {
  await pool.query(`
    INSERT INTO tokens (spotify_id, command_id, access_token, refresh_token)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (spotify_id) DO UPDATE
    SET access_token = $3, refresh_token = $4
  `, [spotifyId, commandId, accessToken, refreshToken]);
}

async function updateAccessToken(spotifyId, accessToken) {
  await pool.query("UPDATE tokens SET access_token = $1 WHERE spotify_id = $2", [accessToken, spotifyId]);
}

// ─── ROTA 1: Gerar link de autorização ───────────────────────────────────────
app.get("/register", (req, res) => {
  // Gera um state temporário só para o fluxo OAuth
  const state = uuidv4().replace(/-/g, "").slice(0, 12);

  const authUrl =
    `https://accounts.spotify.com/authorize?` +
    `client_id=${CLIENT_ID}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=${encodeURIComponent("user-read-currently-playing user-read-playback-state")}` +
    `&state=${state}`;

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
  const { code } = req.query;

  if (!code) return res.send("❌ Autorização negada.");

  try {
    // 1. Pega os tokens
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

    const accessToken = tokenRes.data.access_token;
    const refreshToken = tokenRes.data.refresh_token;

    // 2. Busca o ID real do usuário no Spotify
    const profileRes = await axios.get("https://api.spotify.com/v1/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const spotifyId = profileRes.data.id;

    // 3. Verifica se já existe um command_id para essa conta
    const existing = await getUserBySpotifyId(spotifyId);
    const commandId = existing ? existing.command_id : uuidv4().replace(/-/g, "").slice(0, 12);

    // 4. Salva ou atualiza os tokens
    await saveUser(spotifyId, commandId, accessToken, refreshToken);

    res.send(`
      <html>
        <body style="font-family:sans-serif;text-align:center;padding:60px;background:#191414;color:#fff;">
          <h2>✅ Autorizado com sucesso!</h2>
          <p style="color:#aaa;">Conta Spotify: <strong>${profileRes.data.display_name || spotifyId}</strong></p>
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
          <p style="color:#1DB954;font-size:13px;">⚠️ Esse link é permanente — mesmo se você reautorizar, o comando não muda.</p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.send("❌ Erro ao obter token.");
  }
});

// ─── Refresh do token ─────────────────────────────────────────────────────────
async function refreshAccessToken(spotifyId, refreshToken) {
  const res = await axios.post(
    "https://accounts.spotify.com/api/token",
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  await updateAccessToken(spotifyId, res.data.access_token);
  return res.data.access_token;
}

// ─── Buscar música atual ───────────────────────────────────────────────────────
async function fetchCurrentTrack(token) {
  const playing = await axios.get(
    "https://api.spotify.com/v1/me/player/currently-playing",
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!playing.data || playing.status === 204 || !playing.data.item || !playing.data.is_playing) {
    return null;
  }

  // Suporte a músicas e podcasts
  const item = playing.data.item;
  if (playing.data.currently_playing_type === "episode") {
    return `🎙️ Ouvindo agora: ${item.name} - ${item.show?.name} | ${item.external_urls.spotify}`;
  }

  return `🎵 Tocando agora: ${item.name} - ${item.artists.map((a) => a.name).join(", ")} | ${item.external_urls.spotify}`;
}

// ─── ROTA 3: Música atual ─────────────────────────────────────────────────────
app.get("/musica/:commandId", async (req, res) => {
  const { commandId } = req.params;
  const user = await getUserByCommandId(commandId);

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
        const newToken = await refreshAccessToken(user.spotify_id, user.refresh_token);
        const result = await fetchCurrentTrack(newToken);
        if (!result) return res.send("😶 Não está sendo tocado nada agora.");
        return res.send(result);
      } catch {
        return res.send("❌ Sessão expirada. Reautorize em /register");
      }
    }
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
