# Baymax

The simplest AI you'll ever talk to.

Hold one key and ask out loud. Baymax looks it up on the web in the background while you keep working, then brings the answer to your screen.

## What it does

- Answers small questions right away, out loud.
- Works on bigger questions in the background while you stay in your app.
- Brings back a short spoken line and a card, with the full report and its sources behind a button.

Baymax finds and explains information. It takes no action for you, such as sending email or editing files.

## Requirements

- macOS. Baymax is built and tested on a MacBook with a notch. Other Mac sizes and external displays have not been checked, and Windows comes later.
- Node 22.22.1 or newer, Git 2.32 or newer, and npm.
- Your own Deepgram, Anthropic and Exa API keys.

## Setup

1. Clone the repository:

   ```bash
   git clone https://github.com/Adityalingwal/baymax.git
   cd baymax
   ```

2. Install the packages:

   ```bash
   npm install
   ```

3. Create your env file in the project root:

   ```bash
   cp .env.example .env
   ```

4. Fill in the three keys in `.env`. Only the Electron main process reads it.
   - `DEEPGRAM_API_KEY`: https://console.deepgram.com
   - `ANTHROPIC_API_KEY`: https://console.anthropic.com
   - `EXA_API_KEY`: https://dashboard.exa.ai

5. Start the app:

   ```bash
   npm start
   ```

6. The panel opens from the notch and walks you through Accessibility and the microphone. macOS lists the terminal app you ran `npm start` from, such as Terminal, so switch that one on. No restart is needed. If your terminal already has both permissions, the panel stays closed and you can go straight to the next step.

7. Hold the left Option key and say hello.

## Using it

- Hold the left Option key, speak and release.
- Rest the pointer on the notch to open the panel, where you can also type.
- Chat shows your conversation, and Tasks shows your running work and reports.
- Say "stop" to cancel a task.

How it is built is in [docs/architecture.md](docs/architecture.md).
