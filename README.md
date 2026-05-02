# 🎵 Spotify Now Playing — Comando para Live

## Configuração

### 1. Criar App no Spotify
- Acesse https://developer.spotify.com/dashboard
- Clique em **Create App**
- Em **Redirect URIs**, adicione: `http://localhost:3000/callback`
- Copie o **Client ID** e **Client Secret**

### 2. Configurar o .env
```bash
cp .env.example .env
```
Preencha com suas credenciais:
```
SPOTIFY_CLIENT_ID=seu_client_id
SPOTIFY_CLIENT_SECRET=seu_client_secret
REDIRECT_URI=http://localhost:3000/callback
```

### 3. Instalar dependências e rodar
```bash
npm install
node index.js
```

---

## Como usar na Live

### Passo 1 — Autorizar
Acesse no navegador:
```
http://localhost:3000/auth
```
Autorize o app. Feito isso, o token fica salvo.

### Passo 2 — Comando !musica
Configure no seu bot (Nightbot, StreamElements, etc) uma URL customizada apontando para:
```
http://localhost:3000/musica
```

A resposta será:
```
🎵 Tocando agora: Nome da Música - Artista | https://open.spotify.com/track/...
```

---

## Usando com Nightbot (URL fetch)
No Nightbot, crie um comando com:
```
$(urlfetch http://SEU_IP:3000/musica)
```

## Usando com StreamElements
```
${customapi.http://SEU_IP:3000/musica}
```
