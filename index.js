require("dotenv").config();
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

app.use(express.urlencoded({ extended: true }));

// ─── Credenciais da Last.fm ───────────────────────────────────────────────────
const LASTFM_API_KEY = process.env.LASTFM_API_KEY;
const LASTFM_SECRET = process.env.LASTFM_SECRET;
const LASTFM_API = "https://ws.audioscrobbler.com/2.0/";

// ─── Credenciais do Spotify (apenas para busca publica) ───────────────────────
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

// ─── Formato padrao do comando ────────────────────────────────────────────────
const DEFAULT_FORMAT = "Tocando agora: {nome} - {artista} | {link}";

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
      format        TEXT,
      created_at    TIMESTAMP DEFAULT NOW()
    )
  `);

  // Migracao segura: adiciona a coluna format se ainda nao existir
  await pool.query(`
    ALTER TABLE lastfm_users
    ADD COLUMN IF NOT EXISTS format TEXT
  `).catch(() => {});

  console.log("Banco de dados pronto.");
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

async function saveFormat(commandId, format) {
  await pool.query("UPDATE lastfm_users SET format = $1 WHERE command_id = $2", [format, commandId]);
}

// ─── Assinatura de chamadas da Last.fm ────────────────────────────────────────
function signRequest(params) {
  const sorted = Object.keys(params).sort();
  let signString = "";
  for (const key of sorted) {
    signString += key + params[key];
  }
  signString += LASTFM_SECRET;
  return crypto.createHash("md5").update(signString, "utf8").digest("hex");
}

// ─── Token do Spotify (Client Credentials) ────────────────────────────────────
let spotifyToken = null;
let spotifyTokenExpiry = 0;

async function getSpotifyToken() {
  if (spotifyToken && Date.now() < spotifyTokenExpiry) {
    return spotifyToken;
  }

  const auth = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64");

  const res = await axios.post(
    "https://accounts.spotify.com/api/token",
    new URLSearchParams({ grant_type: "client_credentials" }),
    {
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );

  spotifyToken = res.data.access_token;
  spotifyTokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  return spotifyToken;
}

// ─── Busca o link do Spotify pela musica + artista ────────────────────────────
async function getSpotifyLink(trackName, artistName) {
  try {
    const token = await getSpotifyToken();
    const query = `track:${trackName} artist:${artistName}`;

    const res = await axios.get("https://api.spotify.com/v1/search", {
      headers: { Authorization: `Bearer ${token}` },
      params: { q: query, type: "track", limit: 1 },
    });

    const track = res.data.tracks?.items?.[0];
    return track ? track.external_urls.spotify : null;
  } catch (err) {
    console.error("Erro na busca do Spotify:", err.response?.data || err.message);
    return null;
  }
}

// ─── Aplica o formato escolhido pelo usuario ──────────────────────────────────
function applyFormat(format, data) {
  return (format || DEFAULT_FORMAT)
    .replace(/{nome}/g, data.nome)
    .replace(/{artista}/g, data.artista)
    .replace(/{link}/g, data.link);
}

// ─── ROTA 1: Link de autorizacao ──────────────────────────────────────────────
app.get("/register", (req, res) => {
  const callbackUrl = `${BASE_URL}/callback`;
  const authUrl = `https://www.last.fm/api/auth/?api_key=${LASTFM_API_KEY}&cb=${encodeURIComponent(callbackUrl)}`;

  res.send(`
    <html>
      <body style="font-family:sans-serif;text-align:center;padding:60px;background:#191414;color:#fff;">
        <h2>Now Playing - Comando de Live</h2>
        <p style="color:#aaa;max-width:420px;margin:16px auto;">
          Conecte sua conta Last.fm. Se voce ainda nao tem, crie uma e conecte seu Spotify nas configuracoes da Last.fm (scrobbling).
        </p>
        <p style="margin:30px 0">
          <a href="${authUrl}" style="background:#d51007;color:#fff;padding:14px 28px;border-radius:30px;text-decoration:none;font-weight:bold;font-size:16px;">
            Autorizar com Last.fm
          </a>
        </p>
      </body>
    </html>
  `);
});

// ─── ROTA 2: Callback da Last.fm ──────────────────────────────────────────────
app.get("/callback", async (req, res) => {
  const { token } = req.query;

  if (!token) return res.send("Autorizacao negada.");

  try {
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
      return res.send("Erro ao criar sessao na Last.fm.");
    }

    const lastfmUser = session.name;
    const sessionKey = session.key;

    const existing = await getUserByLastfm(lastfmUser);
    const commandId = existing ? existing.command_id : uuidv4().replace(/-/g, "").slice(0, 12);

    await saveUser(lastfmUser, commandId, sessionKey);

    // Redireciona para a pagina de escolha de formato
    res.redirect(`/formato/${commandId}`);
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error("Erro no callback:", JSON.stringify(detail));
    res.send(`Erro ao obter sessao: ${JSON.stringify(detail)}`);
  }
});

// ─── ROTA 3: Pagina de escolha de formato ─────────────────────────────────────
app.get("/formato/:commandId", async (req, res) => {
  const { commandId } = req.params;
  const user = await getUserByCommandId(commandId);

  if (!user) return res.send("ID invalido.");

  const currentFormat = user.format || DEFAULT_FORMAT;

  // Exemplo de preview com dados ficticios
  const exemplo = { nome: "Blinding Lights", artista: "The Weeknd", link: "https://open.spotify.com/track/..." };

  res.send(`
    <html>
      <head><meta charset="utf-8"></head>
      <body style="font-family:sans-serif;padding:50px;background:#191414;color:#fff;max-width:600px;margin:0 auto;">
        <h2 style="text-align:center;">🎵 Escolha o formato do comando</h2>
        <p style="color:#aaa;text-align:center;">Conta: <strong>${user.lastfm_user}</strong></p>

        <form method="POST" action="/formato/${commandId}">
          <p style="color:#aaa;font-size:14px;margin-top:30px;">Formatos prontos:</p>

          <label style="display:block;background:#282828;padding:14px;border-radius:8px;margin:8px 0;cursor:pointer;">
            <input type="radio" name="preset" value="Tocando agora: {nome} - {artista} | {link}" checked>
            Tocando agora: Blinding Lights - The Weeknd | link
          </label>

          <label style="display:block;background:#282828;padding:14px;border-radius:8px;margin:8px 0;cursor:pointer;">
            <input type="radio" name="preset" value="🎵 {nome} por {artista} 👉 {link}">
            🎵 Blinding Lights por The Weeknd 👉 link
          </label>

          <label style="display:block;background:#282828;padding:14px;border-radius:8px;margin:8px 0;cursor:pointer;">
            <input type="radio" name="preset" value="{artista} - {nome} | Ouca: {link}">
            The Weeknd - Blinding Lights | Ouca: link
          </label>

          <label style="display:block;background:#282828;padding:14px;border-radius:8px;margin:8px 0;cursor:pointer;">
            <input type="radio" name="preset" value="{nome} ({artista})">
            Blinding Lights (The Weeknd) — sem link
          </label>

          <label style="display:block;background:#282828;padding:14px;border-radius:8px;margin:8px 0;cursor:pointer;">
            <input type="radio" name="preset" value="custom">
            ✏️ Personalizar (escreva o seu abaixo)
          </label>

          <p style="color:#aaa;font-size:14px;margin-top:20px;">Formato personalizado:</p>
          <input type="text" name="custom_format" value="${currentFormat.replace(/"/g, "&quot;")}"
            style="width:100%;padding:12px;border-radius:8px;border:none;font-size:14px;box-sizing:border-box;">
          <p style="color:#777;font-size:12px;">
            Placeholders disponiveis: <code>{nome}</code> <code>{artista}</code> <code>{link}</code>
          </p>

          <button type="submit" style="background:#1DB954;color:#000;padding:14px 28px;border:none;border-radius:30px;font-weight:bold;font-size:15px;cursor:pointer;margin-top:20px;width:100%;">
            Salvar formato
          </button>
        </form>
      </body>
    </html>
  `);
});

// ─── ROTA 4: Salvar o formato escolhido ───────────────────────────────────────
app.post("/formato/:commandId", async (req, res) => {
  const { commandId } = req.params;
  const user = await getUserByCommandId(commandId);

  if (!user) return res.send("ID invalido.");

  // Se escolheu "custom", usa o campo de texto; senao usa o preset
  let format = req.body.preset;
  if (format === "custom") {
    format = req.body.custom_format || DEFAULT_FORMAT;
  }

  await saveFormat(commandId, format);

  res.send(`
    <html>
      <head><meta charset="utf-8"></head>
      <body style="font-family:sans-serif;text-align:center;padding:60px;background:#191414;color:#fff;">
        <h2>✅ Formato salvo!</h2>
        <p style="color:#aaa;">Seu comando vai aparecer assim:</p>
        <code style="background:#333;padding:12px 24px;border-radius:6px;display:inline-block;margin:16px 0;">
          ${applyFormat(format, { nome: "Blinding Lights", artista: "The Weeknd", link: "https://open.spotify.com/track/..." })}
        </code>
        <p style="color:#aaa;margin-top:24px;">Link do comando para o bot:</p>
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
        <a href="/formato/${commandId}" style="color:#1DB954;font-size:13px;">Alterar formato novamente</a>
      </body>
    </html>
  `);
});

// ─── Buscar musica atual (user.getRecentTracks) ───────────────────────────────
async function fetchNowPlaying(lastfmUser, format) {
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

  const isNowPlaying = track["@attr"] && track["@attr"].nowplaying === "true";
  if (!isNowPlaying) return null;

  const nome = track.name;
  const artista = track.artist["#text"] || track.artist.name;
  const lastfmUrl = track.url;

  const spotifyLink = await getSpotifyLink(nome, artista);
  const link = spotifyLink || lastfmUrl;

  return applyFormat(format, { nome, artista, link });
}

// ─── ROTA 5: Musica atual ─────────────────────────────────────────────────────
app.get("/musica/:commandId", async (req, res) => {
  const { commandId } = req.params;
  const user = await getUserByCommandId(commandId);

  if (!user) {
    return res.send("ID invalido ou nao autorizado.");
  }

  try {
    const result = await fetchNowPlaying(user.lastfm_user, user.format);
    if (!result) return res.send("😶 Nao esta sendo tocado nada agora.");
    res.send(result);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.send("Erro ao buscar musica.");
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Registrar: ${BASE_URL}/register`);
});

initDB().catch((err) => {
  console.error("Erro ao conectar ao banco:", err.message);
});
