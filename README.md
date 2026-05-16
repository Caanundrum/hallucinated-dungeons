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
cp .env.example .env   # add your OPENAI_API_KEY and Supabase settings
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
- `OPENAI_API_KEY` — your OpenAI API key
- `DM1_MODEL` — main Dungeon Master model
- `UTILITY_MODEL` — utility model for rules, summaries, and state extraction
- `SUPABASE_URL` — your Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` — your Supabase service role key
- `PORT` — port to run on (Railway sets this automatically)
- `CLIENT_URL` — the deployed Vercel frontend URL (for CORS)
- `ALLOWED_ORIGINS` — optional comma-separated extra browser origins for CORS, such as local QA URLs

### Client
- `VITE_SERVER_URL` — the deployed Railway backend URL
