require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || `http://localhost:${PORT}/callback`;

// Armazena tokens em memória (por simplicidade)
let accessToken = null;
let refreshToken = null;

// ─── ROTA 1: Link de autorização ─────────────────────────────────────────────
app.get("/auth", (req, res) => {
  const scope = "user-read-currently-playing user-read-playback-state";
  const authUrl =
    `https://accounts.spotify.com/authorize?` +
    `client_id=${CLIENT_ID}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=${encodeURIComponent(scope)}`;

  res.redirect(authUrl);
});

// ─── ROTA 2: Callback do Spotify ──────────────────────────────────────────────
app.get("/callback", async (req, res) => {
  const code = req.query.code;

  if (!code) {
    return res.send("❌ Autorização negada.");
  }

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

    accessToken = tokenRes.data.access_token;
    refreshToken = tokenRes.data.refresh_token;

    res.send(`
      <html>
        <body style="font-family:sans-serif;text-align:center;padding:60px;background:#191414;color:#fff;">
          <h2>✅ Autorização concedida!</h2>
          <p>Agora use o comando <strong>!musica</strong> no chat.</p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.send("❌ Erro ao obter token.");
  }
});

// ─── Refresh do token ─────────────────────────────────────────────────────────
async function refreshAccessToken() {
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
  accessToken = res.data.access_token;
}

// ─── ROTA 3: Comando !musica ───────────────────────────────────────────────────
app.get("/musica", async (req, res) => {
  if (!accessToken) {
    return res.send("❌ Nenhuma autorização ainda. Acesse /auth primeiro.");
  }

  try {
    const playing = await axios.get(
      "https://api.spotify.com/v1/me/player/currently-playing",
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!playing.data || !playing.data.item) {
      return res.send("🔇 Nenhuma música tocando no momento.");
    }

    const track = playing.data.item;
    const name = track.name;
    const artists = track.artists.map((a) => a.name).join(", ");
    const link = track.external_urls.spotify;

    const response = `🎵 Tocando agora: ${name} - ${artists} | ${link}`;
    res.send(response);
  } catch (err) {
    // Token expirado → tenta renovar
    if (err.response?.status === 401 && refreshToken) {
      try {
        await refreshAccessToken();
        return res.redirect("/musica");
      } catch {
        return res.send("❌ Erro ao renovar token. Reautorize em /auth");
      }
    }
    res.send("❌ Erro ao buscar música.");
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🎵 Servidor rodando em http://localhost:${PORT}`);
  console.log(`🔗 Link de autorização: http://localhost:${PORT}/auth`);
  console.log(`🎧 Comando !musica:     http://localhost:${PORT}/musica\n`);
});
