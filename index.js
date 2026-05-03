require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || `http://localhost:${PORT}/callback`;

// ─── Persistência em JSON ─────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, "tokens.json");

function loadDB() {
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, "{}");
  return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
}

function saveDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// ─── ROTA 1: Gerar link único de autorização ──────────────────────────────────
// Acesse /register para gerar seu link personalizado
app.get("/register", (req, res) => {
  const userId = uuidv4().replace(/-/g, "").slice(0, 12); // ex: a3f9k2m8p1c7
  const db = loadDB();

  db[userId] = { accessToken: null, refreshToken: null };
  saveDB(db);

  const authUrl = `https://accounts.spotify.com/authorize?` +
    `client_id=${CLIENT_ID}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=${encodeURIComponent("user-read-currently-playing user-read-playback-state")}` +
    `&state=${userId}`;

  res.send(`
    <html>
      <body style="font-family:sans-serif;text-align:center;padding:60px;background:#191414;color:#fff;">
        <h2>🎵 Spotify Now Playing</h2>
        <p>Seu ID único: <strong>${userId}</strong></p>
        <p style="margin:30px 0">
          <a href="${authUrl}" style="background:#1DB954;color:#000;padding:14px 28px;border-radius:30px;text-decoration:none;font-weight:bold;font-size:16px;">
            ✅ Autorizar Spotify
          </a>
        </p>
        <p style="color:#aaa;font-size:13px;">Após autorizar, use o comando abaixo no seu bot:</p>
        <code style="background:#333;padding:10px 20px;border-radius:6px;display:inline-block;margin-top:8px;">
          /musica/${userId}
        </code>
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

    const db = loadDB();
    db[userId] = {
      accessToken: tokenRes.data.access_token,
      refreshToken: tokenRes.data.refresh_token,
    };
    saveDB(db);

    const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

    res.send(`
      <html>
        <body style="font-family:sans-serif;text-align:center;padding:60px;background:#191414;color:#fff;">
          <h2>✅ Autorizado com sucesso!</h2>
          <p style="color:#aaa;">Use o link abaixo no seu bot:</p>
          <code style="background:#333;padding:12px 24px;border-radius:6px;display:inline-block;margin:16px 0;font-size:15px;">
            ${BASE_URL}/musica/${userId}
          </code>
          <br><br>
          <p style="color:#aaa;font-size:13px;">Nightbot: <code>$(urlfetch ${BASE_URL}/musica/${userId})</code></p>
          <p style="color:#aaa;font-size:13px;">StreamElements: <code>${"${customapi." + BASE_URL}/musica/${userId}}</code></p>
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
  const db = loadDB();
  const user = db[userId];
  if (!user?.refreshToken) throw new Error("Sem refresh token");

  const res = await axios.post(
    "https://accounts.spotify.com/api/token",
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: user.refreshToken,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  db[userId].accessToken = res.data.access_token;
  saveDB(db);
  return res.data.access_token;
}

// ─── ROTA 3: Música atual ─────────────────────────────────────────────────────
// Uso: /musica/:userId
app.get("/musica/:userId", async (req, res) => {
  const { userId } = req.params;
  const db = loadDB();
  const user = db[userId];

  if (!user || !user.accessToken) {
    return res.send("❌ ID inválido ou não autorizado.");
  }

  try {
    const playing = await axios.get(
      "https://api.spotify.com/v1/me/player/currently-playing",
      { headers: { Authorization: `Bearer ${user.accessToken}` } }
    );

    if (!playing.data || playing.status === 204 || !playing.data.item) {
      return res.send("😶 Não está sendo tocado nada agora.");
    }

    const track = playing.data.item;
    const name = track.name;
    const artists = track.artists.map((a) => a.name).join(", ");
    const link = track.external_urls.spotify;

    res.send(`🎵 Tocando agora: ${name} - ${artists} | ${link}`);
  } catch (err) {
    if (err.response?.status === 401) {
      try {
        const newToken = await refreshAccessToken(userId);
        const playing = await axios.get(
          "https://api.spotify.com/v1/me/player/currently-playing",
          { headers: { Authorization: `Bearer ${newToken}` } }
        );

        if (!playing.data || playing.status === 204 || !playing.data.item) {
          return res.send("😶 Não está sendo tocado nada agora.");
        }

        const track = playing.data.item;
        return res.send(`🎵 Tocando agora: ${track.name} - ${track.artists.map((a) => a.name).join(", ")} | ${track.external_urls.spotify}`);
      } catch {
        return res.send("❌ Sessão expirada. Registre-se novamente em /register");
      }
    }
    res.send("❌ Erro ao buscar música.");
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🎵 Servidor rodando na porta ${PORT}`);
  console.log(`🔗 Registrar novo usuário: http://localhost:${PORT}/register\n`);
});
