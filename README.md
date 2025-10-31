# AI Customer Support Chatbot (Gemini API)

This is a minimal full‑stack web app that serves a customer support chatbot using Google's Gemini API. It includes:

- Node.js + Express server with an API route that proxies requests to Gemini
- Static frontend with a modern chat UI
- Streaming responses and conversation history

## Prerequisites

- Node.js 18+ (already in the dev container)
- A Google AI Studio API key for Gemini

## Setup

1. Create an `.env` file in the project root:

```
PORT=3000
GEMINI_API_KEY=your_api_key_here
GEMINI_MODEL=gemini-1.5-flash
ORIGIN=http://localhost:3000
```

2. Install dependencies:

```
npm install
```

3. Start the server:

```
npm run dev
```

4. Open the app:

- It should print the local URL (e.g., http://localhost:3000)
- Or open in your host browser with:

```
$BROWSER http://localhost:3000
```

## Notes

- The server keeps conversation state per browser session via a session cookie; no database required.
- For production, set proper CORS origins and add rate limits.
- The server exposes these endpoints:
  - GET `/` serves the frontend
  - POST `/api/chat` sends user + history to Gemini and streams the reply
  - POST `/api/reset` clears the current session conversation