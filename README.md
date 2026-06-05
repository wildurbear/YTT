# YouTube Transcription
Summarizes YouTube videos.

## Solutions
### Runtime & Server
- Node.js  
- Express.js  
- Helmet (security headers)  
- express-rate-limit (brute-force protection)
### Auth
- jsonwebtoken (JWT session cookies)  
- bcrypt (password hashing)  
- cookie-parser
### AI Summarizer
- Anthropic SDK → claude-sonnet-4-6  
- OpenAI SDK → gpt-4o (optional, switchable via env var)
### Transcript Fetching
- [SupaData](https://supadata.ai/) API (third-party service)
### Frontend
- Vanilla HTML/CSS/JS  
- marked.js (CDN) — converts AI markdown output to rendered HTML
### Hosting & Infrastructure
- Railway (hosting)  
- GitHub (source control)

## Change AI Summary API
Change to OpenAI:  
`AI_PROVIDER=openai`  
`OPENAI_API_KEY=XXXXXXXXXXXXXXXX`

Change to Claude:  
`AI_PROVIDER=anthropic`  
`ANTHROPIC_API_KEY=XXXXXXXXXXXXXXXX`

Since I'm using Railway to host, those changes are made in the **VARIABLES** section of the VPS.

## Changing Password:
In CMD/PS (NodeJS required)  
`node -e "require('bcrypt').hash('YOURPASSWORDHERE', 12).then(console.log)"`  
Then add under **HASHED_PASSWORD** in Variables
