# Hallucinated Dungeons

An AI-powered Dungeon Master experience built on D&D 5.5e (2024) rules.

## Project Structure

```
hallucinated-dungeons/
├── client/   # React (Vite) frontend — hosted on Vercel
└── server/   # Node.js + Express backend — hosted on Railway
```

## Development

### Backend
```bash
cd server
npm install
cp .env.example .env   # add your ANTHROPIC_API_KEY
npm run dev
```

### Frontend
```bash
cd client
npm install
npm run dev
```

## Environment Variables

### Server
- `ANTHROPIC_API_KEY` — your Anthropic API key
- `PORT` — port to run on (Railway sets this automatically)
- `CLIENT_URL` — the deployed Vercel frontend URL (for CORS)

### Client
- `VITE_SERVER_URL` — the deployed Railway backend URL
