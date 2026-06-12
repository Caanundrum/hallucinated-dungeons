# Hallucinated Dungeons

An AI-powered Game Master experience built on 2024 fantasy d20 rules.

This project is an original fantasy campaign tool. It is not affiliated with or endorsed by Wizards of the Coast, and public-facing rules text should stay in original SRD-style wording rather than quoted rulebook text.

Rules reference: This work includes material from the System Reference Document 5.2.1 ("SRD 5.2.1") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.

Architecture reference: [docs/referee-architecture.md](docs/referee-architecture.md)

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
- `DM1_MODEL` — main Game Master model
- `UTILITY_MODEL` — utility model for rules, summaries, and state extraction
- `SUPABASE_URL` — your Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` — your Supabase service role key
- `PORT` — port to run on (Railway sets this automatically)
- `CLIENT_URL` — the deployed Vercel frontend URL (for CORS)
- `ALLOWED_ORIGINS` — optional comma-separated extra browser origins for CORS, such as local QA URLs
- `QA_TOOLS_SECRET` — optional secret that enables locked production QA helpers, including the XP-ready level-up test endpoint

### Client
- `VITE_SERVER_URL` — the deployed Railway backend URL
