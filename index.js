require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || `http://localhost:${PORT}/callback`;

// Armazena tokens por usuário: { userId: { accessToken, refreshToken } }
const users = {};

// ─── ROTA 1: Link de autorização ─────────────────────────────────────────────
// Uso: /auth?user=thiagolive
app.get("/auth", (req, res) => {
  const userId = req.query.user;

  if (!userId) {
    return res.send("❌ Informe um usuário. Ex: /auth?user=thiagolive");
  }

  const scope = "user-read-currently-playing user-read-playback-state";
  const authUrl =
    `https://accounts.spotify.com/authorize?` +
    `client_id=${CLIENT_ID}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=${encodeURIComponent(scope)}` +
    `&state=${encodeURIComponent(userId)}`;

  res.redirect(authUrl);
});

// ─── ROTA 2: Callback do Spotify ──────────────────────────────────────────────
app.get("/callback", async (req, res) => {
  const code = req.query.code;
  const userId = req.query.state;

  if (!code || !userId) {
    return res.send("❌ Autorização negada ou usuário inválido.");
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

    users[userId] = {
      accessToken: tokenRes.data.access_token,
      refreshToken: tokenRes.data.refresh_token,
    };

    res.send(`
      <html>
        <body style="font-family:sans-serif;text-align:center;padding:60px;background:#191414;color:#fff;">
          <h2>✅ Autorização concedida!</h2>
          <p>Usuário: <strong>${userId}</strong></p>
          <p>Use o comando no chat com:</p>
          <code style="background:#333;padding:10px;border-radius:6px;display:inline-block;margin-top:10px;">
            /musica?user=${userId}
          </code>
        </body>
      </html>
    `);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.send("❌ Erro ao obter token.");
  }
});

// ─── Refresh do token por usuário ─────────────────────────────────────────────
async function refreshAccessToken(userId) {
  const user = users[userId];
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

  users[userId].accessToken = res.data.access_token;
}

// ─── ROTA 3: Música atual por usuário ─────────────────────────────────────────
// Uso: /musica?user=thiagolive
app.get("/musica", async (req, res) => {
  const userId = req.query.user;

  if (!userId) {
    return res.send("❌ Informe um usuário. Ex: /musica?user=thiagolive");
  }

  if (!users[userId]) {
    return res.send(`❌ Usuário "${userId}" não autorizou ainda. Acesse /auth?user=${userId}`);
  }

  try {
    const playing = await axios.get(
      "https://api.spotify.com/v1/me/player/currently-playing",
      { headers: { Authorization: `Bearer ${users[userId].accessToken}` } }
    );

    if (!playing.data || !playing.data.item) {
      return res.send("🔇 Nenhuma música tocando no momento.");
    }

    const track = playing.data.item;
    const name = track.name;
    const artists = track.artists.map((a) => a.name).join(", ");
    const link = track.external_urls.spotify;

    res.send(`🎵 Tocando agora: ${name} - ${artists} | ${link}`);
  } catch (err) {
    if (err.response?.status === 401) {
      try {
        await refreshAccessToken(userId);
        return res.redirect(`/musica?user=${userId}`);
      } catch {
        return res.send(`❌ Erro ao renovar token. Reautorize em /auth?user=${userId}`);
      }
    }
    res.send("❌ Erro ao buscar música.");
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🎵 Servidor rodando em http://localhost:${PORT}`);
  console.log(`🔗 Autorizar usuário: http://localhost:${PORT}/auth?user=SEU_NOME`);
  console.log(`🎧 Buscar música:     http://localhost:${PORT}/musica?user=SEU_NOME\n`);
});