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

// ─── Traducoes ────────────────────────────────────────────────────────────────
const T = {
  pt: {
    pageTitle: 'Comando "Tocando Agora"',
    heroTitle: '🎵 Comando "Tocando Agora"',
    heroSubtitle: "Siga os passos abaixo para liberar o comando que mostra a música que você está ouvindo na live.",
    step1Title: "Criar conta na Last.fm",
    step1Text: "Acesse o site da Last.fm e crie uma conta gratuita (pode usar e-mail ou login com Google).",
    step1Link: "➜ Criar conta na Last.fm",
    step2Title: "Confirmar o e-mail",
    step2Text: "A Last.fm envia um e-mail de confirmação. Abra sua caixa de entrada e clique no link para ativar a conta. Verifique também a pasta de spam.",
    step2Resend: "<strong>Não chegou em até 1 minuto?</strong> Solicite o reenvio da confirmação:",
    step2ResendLink: "➜ Reenviar e-mail de confirmação",
    step2Note: "Você precisa estar logado na Last.fm para reenviar. Aguarde mais alguns minutos e cheque a pasta de spam novamente.",
    step3Title: "Conectar o Spotify à Last.fm",
    step3Text: "Isso faz a Last.fm registrar tudo que você ouve no Spotify. Acesse as configurações de aplicativos da Last.fm, encontre o Spotify e clique em conectar.",
    step3Link: "➜ Abrir configurações de aplicativos da Last.fm",
    step3Note: "⚠️ Sem esse passo o comando não funciona, pois a Last.fm não saberá o que você está ouvindo.",
    step4Title: "Autorizar e gerar o comando",
    step4Text: "Com a conta criada e o Spotify conectado, clique no botão abaixo para autorizar e receber o link do seu comando.",
    authButton: "✅ Autorizar Spotify (via Last.fm)",
    authFooter: "Já tem conta na Last.fm com o Spotify conectado? É só clicar no botão acima.",
    fmtTitle: "🎵 Escolha o formato do comando",
    fmtAccount: "Conta",
    fmtPresets: "Formatos prontos:",
    fmtCustomLabel: "✏️ Personalizar (escreva o seu abaixo)",
    fmtCustomField: "Formato personalizado:",
    fmtPlaceholders: "Placeholders disponíveis:",
    fmtSave: "Salvar formato",
    fmtPresetNoLink: "Blinding Lights (The Weeknd) — sem link",
    okTitle: "✅ Formato salvo!",
    okPreview: "Seu comando vai aparecer assim:",
    okCmdLink: "Link do comando para o bot:",
    okChangeAgain: "Alterar formato novamente",
    nothingPlaying: "😶 Não está sendo tocado nada agora.",
    invalidId: "ID inválido ou não autorizado.",
    errorFetch: "Erro ao buscar música.",
  },
  en: {
    pageTitle: '"Now Playing" Command',
    heroTitle: '🎵 "Now Playing" Command',
    heroSubtitle: "Follow the steps below to set up the command that shows the song you are listening to on stream.",
    step1Title: "Create a Last.fm account",
    step1Text: "Go to the Last.fm website and create a free account (you can use e-mail or sign in with Google).",
    step1Link: "➜ Create a Last.fm account",
    step2Title: "Confirm your e-mail",
    step2Text: "Last.fm sends a confirmation e-mail. Open your inbox and click the link to activate the account. Also check your spam folder.",
    step2Resend: "<strong>Didn't arrive within 1 minute?</strong> Request the confirmation again:",
    step2ResendLink: "➜ Resend confirmation e-mail",
    step2Note: "You need to be logged in to Last.fm to resend. Wait a few more minutes and check your spam folder again.",
    step3Title: "Connect Spotify to Last.fm",
    step3Text: "This lets Last.fm track everything you listen to on Spotify. Open Last.fm's applications settings, find Spotify and click connect.",
    step3Link: "➜ Open Last.fm applications settings",
    step3Note: "⚠️ Without this step the command won't work, because Last.fm won't know what you are listening to.",
    step4Title: "Authorize and generate the command",
    step4Text: "With the account created and Spotify connected, click the button below to authorize and get your command link.",
    authButton: "✅ Authorize Spotify (via Last.fm)",
    authFooter: "Already have a Last.fm account with Spotify connected? Just click the button above.",
    fmtTitle: "🎵 Choose the command format",
    fmtAccount: "Account",
    fmtPresets: "Ready-made formats:",
    fmtCustomLabel: "✏️ Customize (write your own below)",
    fmtCustomField: "Custom format:",
    fmtPlaceholders: "Available placeholders:",
    fmtSave: "Save format",
    fmtPresetNoLink: "Blinding Lights (The Weeknd) — no link",
    okTitle: "✅ Format saved!",
    okPreview: "Your command will look like this:",
    okCmdLink: "Command link for your bot:",
    okChangeAgain: "Change format again",
    nothingPlaying: "😶 Nothing is playing right now.",
    invalidId: "Invalid ID or not authorized.",
    errorFetch: "Error fetching the song.",
  },
};

// Resolve o idioma a partir da query (?lang=). Padrao: pt
function getLang(req) {
  const lang = (req.query.lang || "").toLowerCase();
  return lang === "en" ? "en" : "pt";
}

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

function applyFormat(format, data) {
  return (format || DEFAULT_FORMAT)
    .replace(/{nome}/g, data.nome)
    .replace(/{artista}/g, data.artista)
    .replace(/{link}/g, data.link);
}

// ─── Componente: botao de troca de idioma ─────────────────────────────────────
function langSwitcher(currentPath, lang) {
  const ptActive = lang === "pt";
  const style = (active) =>
    `padding:6px 14px;border-radius:20px;text-decoration:none;font-size:13px;font-weight:bold;` +
    (active ? "background:#1DB954;color:#000;" : "background:#333;color:#fff;");
  return `
    <div style="text-align:right;margin-bottom:10px;">
      <a href="${currentPath}?lang=pt" style="${style(ptActive)}">PT</a>
      <a href="${currentPath}?lang=en" style="${style(!ptActive)}">EN</a>
    </div>
  `;
}

// ─── ROTA 1: Pagina de registro ───────────────────────────────────────────────
app.get("/register", (req, res) => {
  const lang = getLang(req);
  const t = T[lang];
  const callbackUrl = `${BASE_URL}/callback?lang=${lang}`;
  const authUrl = `https://www.last.fm/api/auth/?api_key=${LASTFM_API_KEY}&cb=${encodeURIComponent(callbackUrl)}`;

  res.send(`
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${t.pageTitle}</title>
      </head>
      <body style="font-family:sans-serif;background:#191414;color:#fff;margin:0;padding:40px 20px;">
        <div style="max-width:560px;margin:0 auto;">

          ${langSwitcher(`${BASE_URL}/register`, lang)}

          <h1 style="text-align:center;font-size:24px;">${t.heroTitle}</h1>
          <p style="color:#aaa;text-align:center;margin-bottom:36px;">${t.heroSubtitle}</p>

          <div style="background:#282828;border-radius:12px;padding:20px;margin-bottom:16px;">
            <h3 style="margin:0 0 8px;">
              <span style="background:#d51007;border-radius:50%;padding:2px 10px;margin-right:8px;">1</span>
              ${t.step1Title}
            </h3>
            <p style="color:#bbb;font-size:14px;margin:8px 0;">${t.step1Text}</p>
            <a href="https://www.last.fm/join" target="_blank"
              style="color:#d51007;font-size:14px;font-weight:bold;text-decoration:none;">${t.step1Link}</a>
          </div>

          <div style="background:#282828;border-radius:12px;padding:20px;margin-bottom:16px;">
            <h3 style="margin:0 0 8px;">
              <span style="background:#d51007;border-radius:50%;padding:2px 10px;margin-right:8px;">2</span>
              ${t.step2Title}
            </h3>
            <p style="color:#bbb;font-size:14px;margin:8px 0;">${t.step2Text}</p>
            <p style="color:#bbb;font-size:14px;margin:8px 0;">${t.step2Resend}</p>
            <a href="https://www.last.fm/settings/sendverification" target="_blank"
              style="color:#d51007;font-size:14px;font-weight:bold;text-decoration:none;">${t.step2ResendLink}</a>
            <p style="color:#777;font-size:12px;margin-top:10px;">${t.step2Note}</p>
          </div>

          <div style="background:#282828;border-radius:12px;padding:20px;margin-bottom:16px;">
            <h3 style="margin:0 0 8px;">
              <span style="background:#d51007;border-radius:50%;padding:2px 10px;margin-right:8px;">3</span>
              ${t.step3Title}
            </h3>
            <p style="color:#bbb;font-size:14px;margin:8px 0;">${t.step3Text}</p>
            <a href="https://www.last.fm/settings/applications" target="_blank"
              style="color:#d51007;font-size:14px;font-weight:bold;text-decoration:none;">${t.step3Link}</a>
            <p style="color:#777;font-size:12px;margin-top:10px;">${t.step3Note}</p>
          </div>

          <div style="background:#282828;border-radius:12px;padding:20px;margin-bottom:28px;">
            <h3 style="margin:0 0 8px;">
              <span style="background:#1DB954;border-radius:50%;padding:2px 10px;margin-right:8px;color:#000;">4</span>
              ${t.step4Title}
            </h3>
            <p style="color:#bbb;font-size:14px;margin:8px 0;">${t.step4Text}</p>
          </div>

          <div style="text-align:center;">
            <a href="${authUrl}"
              style="background:#d51007;color:#fff;padding:16px 36px;border-radius:30px;text-decoration:none;font-weight:bold;font-size:17px;display:inline-block;">
              ${t.authButton}
            </a>
          </div>

          <p style="color:#777;font-size:12px;text-align:center;margin-top:24px;">${t.authFooter}</p>

        </div>
      </body>
    </html>
  `);
});

// ─── ROTA 2: Callback da Last.fm ──────────────────────────────────────────────
app.get("/callback", async (req, res) => {
  const lang = getLang(req);
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

    res.redirect(`${BASE_URL}/formato/${commandId}?lang=${lang}`);
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error("Erro no callback:", JSON.stringify(detail));
    res.send(`Erro ao obter sessao: ${JSON.stringify(detail)}`);
  }
});

// ─── ROTA 3: Pagina de escolha de formato ─────────────────────────────────────
app.get("/formato/:commandId", async (req, res) => {
  const lang = getLang(req);
  const t = T[lang];
  const { commandId } = req.params;
  const user = await getUserByCommandId(commandId);

  if (!user) return res.send(t.invalidId);

  const currentFormat = user.format || DEFAULT_FORMAT;

  res.send(`
    <html>
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
      <body style="font-family:sans-serif;padding:50px 20px;background:#191414;color:#fff;">
        <div style="max-width:600px;margin:0 auto;">

          ${langSwitcher(`${BASE_URL}/formato/${commandId}`, lang)}

          <h2 style="text-align:center;">${t.fmtTitle}</h2>
          <p style="color:#aaa;text-align:center;">${t.fmtAccount}: <strong>${user.lastfm_user}</strong></p>

          <form method="POST" action="${BASE_URL}/formato/${commandId}?lang=${lang}">
            <p style="color:#aaa;font-size:14px;margin-top:30px;">${t.fmtPresets}</p>

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
              The Weeknd - Blinding Lights | Ouça: link
            </label>

            <label style="display:block;background:#282828;padding:14px;border-radius:8px;margin:8px 0;cursor:pointer;">
              <input type="radio" name="preset" value="{nome} ({artista})">
              ${t.fmtPresetNoLink}
            </label>

            <label style="display:block;background:#282828;padding:14px;border-radius:8px;margin:8px 0;cursor:pointer;">
              <input type="radio" name="preset" value="custom">
              ${t.fmtCustomLabel}
            </label>

            <p style="color:#aaa;font-size:14px;margin-top:20px;">${t.fmtCustomField}</p>
            <input type="text" name="custom_format" value="${currentFormat.replace(/"/g, "&quot;")}"
              style="width:100%;padding:12px;border-radius:8px;border:none;font-size:14px;box-sizing:border-box;">
            <p style="color:#777;font-size:12px;">
              ${t.fmtPlaceholders} <code>{nome}</code> <code>{artista}</code> <code>{link}</code>
            </p>

            <button type="submit" style="background:#1DB954;color:#000;padding:14px 28px;border:none;border-radius:30px;font-weight:bold;font-size:15px;cursor:pointer;margin-top:20px;width:100%;">
              ${t.fmtSave}
            </button>
          </form>

        </div>
      </body>
    </html>
  `);
});

// ─── ROTA 4: Salvar o formato escolhido ───────────────────────────────────────
app.post("/formato/:commandId", async (req, res) => {
  const lang = getLang(req);
  const t = T[lang];
  const { commandId } = req.params;
  const user = await getUserByCommandId(commandId);

  if (!user) return res.send(t.invalidId);

  let format = req.body.preset;
  if (format === "custom") {
    format = req.body.custom_format || DEFAULT_FORMAT;
  }

  await saveFormat(commandId, format);

  const preview = applyFormat(format, {
    nome: "Blinding Lights",
    artista: "The Weeknd",
    link: "https://open.spotify.com/track/...",
  });

  res.send(`
    <html>
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
      <body style="font-family:sans-serif;text-align:center;padding:60px 20px;background:#191414;color:#fff;">
        <div style="max-width:600px;margin:0 auto;">
          <h2>${t.okTitle}</h2>
          <p style="color:#aaa;">${t.okPreview}</p>
          <code style="background:#333;padding:12px 24px;border-radius:6px;display:inline-block;margin:16px 0;">
            ${preview}
          </code>
          <p style="color:#aaa;margin-top:24px;">${t.okCmdLink}</p>
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
          <a href="${BASE_URL}/formato/${commandId}?lang=${lang}" style="color:#1DB954;font-size:13px;">${t.okChangeAgain}</a>
        </div>
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
  const lang = getLang(req);
  const t = T[lang];
  const { commandId } = req.params;
  const user = await getUserByCommandId(commandId);

  if (!user) {
    return res.send(t.invalidId);
  }

  try {
    const result = await fetchNowPlaying(user.lastfm_user, user.format);
    if (!result) return res.send(t.nothingPlaying);
    res.send(result);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.send(t.errorFetch);
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
