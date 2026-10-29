# Setting up Larder

This guide takes you from nothing to a working Larder, step by step. You don't need to be technical. You do need about 20 minutes, a computer that can stay switched on, and an AI account or a local model.

**Contents**

1. [What you need](#1-what-you-need)
2. [Choose an AI](#2-choose-an-ai)
3. [Install Docker](#3-install-docker)
4. [Get Larder and run the installer](#4-get-larder-and-run-the-installer)
5. [Open it and set yourself up](#5-open-it-and-set-yourself-up)
6. [Use it on your phone](#6-use-it-on-your-phone)
7. [Away from home: Tailscale (optional)](#7-away-from-home-tailscale-optional)
8. [On the internet: a cloud server (optional)](#8-on-the-internet-a-cloud-server-optional)
9. [Updating](#9-updating)
10. [Backing up](#10-backing-up)
11. [Changing settings later](#11-changing-settings-later)
12. [When something goes wrong](#12-when-something-goes-wrong)

---

## 1. What you need

- **A computer that stays on.** Larder is a small website that runs on your own machine, and your phone opens it in the browser. The machine needs to be on whenever you want to log food. Good choices are a home server or NAS that runs Docker, a spare laptop or desktop, a mini PC, or a cheap cloud server (see [step 8](#8-on-the-internet-a-cloud-server-optional)). A Raspberry Pi 4 or 5 should be able to run it too, though it hasn't been tested on one. Your everyday laptop works for trying it out, but Larder stops when the laptop sleeps.
- **An AI to read your food.** That can be Claude, ChatGPT/OpenAI or Gemini (an account or an API key), or a model running on your own machine. [Step 2](#2-choose-an-ai) helps you pick.
- **About 2 GB of free disk space** for Docker and Larder. Your diary itself takes very little.

You don't need a domain name, port forwarding or any coding.

## 2. Choose an AI

Larder turns what you type or photograph into calories by asking an AI. You can use whichever you already have; the installer asks which. If you're not sure, use the first one you have an account for.

| You have | Choose | Costs | Reads photos |
|---|---|---|---|
| Claude Pro or Max | **1** Claude subscription | Nothing extra | Yes |
| An Anthropic API key | **2** Claude API key | Pennies per message | Yes |
| ChatGPT or an OpenAI API key | **3** OpenAI Codex | Your plan, or per message | Yes |
| A Google account | **4** Gemini CLI | Free tier or per message | Yes |
| opencode, or a key for OpenRouter, Groq and so on | **5** opencode | Depends on provider | If the model can |
| A decent PC or Mac and some patience | **6** Ollama (local) | Free | With a vision model |
| llama.cpp, LM Studio, vLLM or another OpenAI-style server | **7** OpenAI-compatible | Free if local | With a vision model |
| A command-line tool not listed here | **8** Your own command | Up to you | If you pass it the photo |

Each option can use two models: a lighter one for typed messages and a stronger one for photos. Each person can switch to "the stronger one for everything" in Settings. If your AI can't see pictures, Larder reads the words you sent with a photo and tells you it couldn't look at it.

### 1. Claude subscription (Pro or Max)

Your Larder messages count towards your normal Claude usage. By default typed messages use Claude Haiku, which takes very little of it, and photos use Claude Sonnet.

Larder needs a long-lived sign-in token, which you make once:

- **If you have Claude Code on a computer**, run `claude setup-token` in a terminal. It opens your browser, you approve, and it prints a token starting with `sk-ant-oat`.
- **If you don't**, just press Enter when the installer asks. It runs the same thing inside Larder: you open the link it prints, sign in, and paste back the code it shows.

Treat the token like a password.

### 2. Claude API key

1. Go to [console.anthropic.com](https://console.anthropic.com), sign in, and add some credit under **Billing**. A typed message usually costs a fraction of a penny; check Anthropic's current prices.
2. Under **API keys**, create a key called "Larder" and copy it (it starts with `sk-ant-api`).
3. Set a monthly spending limit while you're there.

### 3. OpenAI, through the Codex CLI

Either:

- **An OpenAI API key** from [platform.openai.com](https://platform.openai.com/api-keys). Paste it when the installer asks; it's saved as `CODEX_API_KEY`.
- **Your ChatGPT plan.** Press Enter instead of pasting a key. Once Larder is running, sign in from the Larder folder with `docker compose exec -it larder codex login --device-auth`. It shows a code to enter at the address it prints. The sign-in is kept in `data/home`, so it survives updates.

Leave the model questions empty to use Codex's default, or name the models you want (for example a smaller one for typing).

### 4. Google Gemini, through the Gemini CLI

Get an API key from [aistudio.google.com](https://aistudio.google.com/apikey) and paste it when asked (it's saved as `GEMINI_API_KEY`). The models are Gemini CLI's own names: `flash` is quick and cheap, `pro` is stronger. Google has a free tier; check its terms, because on free plans Google may use what you send to improve its products.

### 5. opencode

[opencode](https://opencode.ai) can talk to most AI providers. Give the models as `provider/model`. After building, the installer runs `opencode auth login` so you can pick a provider and paste its key. To do it again later, run `docker compose exec -it larder opencode auth login`. The sign-in is kept in `data/home`.

### 6. Ollama (models on your own computer)

Nothing leaves your network, and it costs nothing, but you need a reasonably powerful machine and replies are slower.

1. Install [Ollama](https://ollama.com/download) on the Larder computer, or another computer at home.
2. Pull a model. For photos you need one that can see pictures, such as `ollama pull gemma3`.
3. When the installer asks where Ollama is, press Enter if it's on the same computer.

On Linux, Ollama only listens to the computer itself by default, so Larder (inside Docker) can't reach it. Start Ollama with `OLLAMA_HOST=0.0.0.0` set (its docs explain how for your system), then restart it. With Docker Desktop on Windows or Mac this isn't needed.

Small local models get portion sizes and labels wrong more often than the big hosted ones. If replies are slow, raise `LARDER_AI_TIMEOUT` in `.env` (seconds).

### 7. An OpenAI-compatible server (llama.cpp, LM Studio and others)

Anything that offers the OpenAI `/v1/chat/completions` API works: llama.cpp's `llama-server`, LM Studio, vLLM, LocalAI, or hosted services like OpenRouter (with `LARDER_AI_KEY`). For llama.cpp with a vision model, for example:

```sh
llama-server -m model.gguf --mmproj mmproj.gguf --host 0.0.0.0 --port 8081
```

Then give the installer `http://host.docker.internal:8081/v1` as the address. Larder asks the server for schema-checked JSON. If the server can't do that, Larder asks plainly and checks the answer itself.

### 8. Your own command

Larder can run any shell command that prints its answer. It fills in these placeholders, each already quoted:

- `{prompt_file}`: a file holding the whole request, including the exact JSON format wanted
- `{prompt}`: the same request as text
- `{image}`: the first photo's file, and `{images}` for all of them
- `{model}`: the text or photo model from `.env`

If the command has no `{prompt}` or `{prompt_file}`, the request arrives on its standard input. If it has no `{image}` or `{images}`, Larder treats it as unable to see photos. If the reply isn't the right JSON, Larder asks once more and says what was wrong. For example, with Simon Willison's [`llm`](https://llm.datasette.io) tool:

```sh
LARDER_AI=custom
LARDER_AI_COMMAND=llm -m {model} -a {image} < {prompt_file}
```

The command runs inside Larder's container, so the tool has to be installed there. Add it to the `Dockerfile`, or run Larder without Docker (see the README's Development section).

### Changing your mind later

Edit `LARDER_AI`, the models and the keys in `.env` (every option is listed in `.env.example`), and set `LARDER_CLIS` to the command-line tools to build in (`claude`, `codex`, `gemini`, `opencode` or `none`). Then run `docker compose up -d --build`. Settings in Larder shows which AI is in use.

## 3. Install Docker

Docker runs Larder in its own sealed box, so it doesn't tangle with anything else on your machine.

- **Windows:** install [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/). Let it set up WSL 2 when it asks, then restart. You'll also want **Ubuntu** from the Microsoft Store; in step 4, use the Ubuntu terminal, not PowerShell.
- **Mac:** install [Docker Desktop](https://docs.docker.com/desktop/setup/install/mac-install/) and open it once so it finishes setting up.
- **Linux (including most home servers):** run `curl -fsSL https://get.docker.com | sh`, then `sudo usermod -aG docker $USER`, and log out and back in.
- **A NAS** (Synology, Unraid, TrueNAS and so on): install its Docker or Container Manager app, then follow step 4 over SSH.

To check it worked, open a terminal and run `docker compose version`. You should see a version number, not an error.

## 4. Get Larder and run the installer

In a terminal on the machine that will run Larder:

```sh
git clone https://github.com/doolecg/larderTracker.git larder
cd larder
./install.sh
```

No `git`? Download the ZIP from the green **Code** button on GitHub, unzip it, and `cd` into the folder instead.

The installer:

1. Checks Docker is working.
2. Asks which AI you picked in step 2, and for its key or token. It doesn't show what you paste.
3. Builds Larder with that AI's tool built in. The first time takes a few minutes.
4. Asks where you'll use it. Choose **At home** unless you're on a cloud server (step 8).
5. Asks your time zone, so "today" starts at your midnight, and which port to use (just press Enter for 8080).
6. Saves your answers in a file called `.env` in the Larder folder, starts Larder, and prints the address to open.

From now on Larder starts by itself whenever the machine or Docker restarts.

<details>
<summary>Doing it by hand instead (or on Windows without Ubuntu)</summary>

Copy `.env.example` to `.env` and open it in a text editor. Set `LARDER_AI` and what that AI needs (the file explains each one), and set `TZ` to your time zone (for example `Europe/London` or `America/New_York`). Then, in a terminal in the Larder folder:

```sh
docker compose up -d --build
```

</details>

## 5. Open it and set yourself up

Open the address the installer printed, for example `http://localhost:8080` on the same machine, or `http://192.168.1.20:8080` from another device at home.

The first screen asks **who's first**. Enter:

- **Your name** and a **PIN** (4 to 8 digits). The PIN keeps other people in the house out of your diary.
- **Daily kcal**, your usual daily target. If you don't know it, 2,000 is a common starting point; an online TDEE calculator or your GP can give you a better number.
- **Weight now** and **Goal weight**, if you want the weight chart and a goal date. Both are optional. Larder works in kg; 1 stone is 6.35 kg.
- **One bigger day a week**: a higher target for one day (a meal out, a Sunday roast). Larder picks the first day you go over, or you can fix a day in Settings.

Press **Create and open** and you're in. Type what you ate, for example "two slices of toast with butter and a coffee with milk", and press send. Or tap the camera to photograph a label or your plate.

**Adding someone else:** on their phone, open the same address and tap **Add someone**. Everyone has their own targets, weigh-ins and saved foods. To switch person on a shared device, tap your initial at the top.

## 6. Use it on your phone

Open the address in your phone's browser while you're on your home Wi-Fi, then add it to your home screen so it opens like an app:

- **iPhone:** in Safari, tap **Share**, then **Add to Home Screen**.
- **Android:** in Chrome, tap the **⋮** menu, then **Install app** or **Add to Home screen**.

Over plain `http://` the home-screen icon still works, but Android only treats it as a full app (its own window, no browser bar) over HTTPS. Tailscale (next step) gives you HTTPS for free.

## 7. Away from home: Tailscale (optional)

[Tailscale](https://tailscale.com) is a free app that links your devices privately, so you can reach Larder from anywhere without opening anything to the internet. This is the recommended way to use Larder outside the house.

1. Make a free Tailscale account and install Tailscale on the machine running Larder ([instructions](https://tailscale.com/download)). On Linux it's `curl -fsSL https://tailscale.com/install.sh | sh` then `sudo tailscale up`.
2. Install the Tailscale app on your phone and sign in with the same account.
3. Open `http://<machine-name>:8080` on your phone, using the name the machine has in the Tailscale app.

**For HTTPS** (a proper home-screen app on Android, and a padlock in the browser), run this on the Larder machine:

```sh
sudo tailscale serve --bg 8080
```

Then open `https://<machine-name>.<your-tailnet>.ts.net` instead. Tailscale shows the exact address. The first time, it may ask you to enable HTTPS for your tailnet in the Tailscale admin page; follow the link it gives.

Other people in your household need to be on your tailnet too. Invite them from the Tailscale admin page, or share just the Larder machine with them.

## 8. On the internet: a cloud server (optional)

If you'd rather not keep a machine on at home, Larder can run on a small cloud server and be reachable at your own web address. This route is a bit more involved, and the server is open to the whole internet, so the installer insists on a household password.

You need:

- **A cloud server** running Ubuntu with at least 1 GB of memory. Small plans from Hetzner, DigitalOcean, Linode and others are fine.
- **A domain name** you control, for example `food.yourname.co.uk`. In your domain's DNS settings, add an **A record** pointing that name at the server's IP address.
- **Ports 80 and 443 open** in the server's firewall. Larder needs them to get a free HTTPS certificate.

Then:

1. Connect to the server with SSH and install Docker (the Linux line in [step 3](#3-install-docker)).
2. Follow [step 4](#4-get-larder-and-run-the-installer), and choose **On the internet** when asked.
3. Enter your domain name, and either choose a household password or let the installer make one up. **Write it down.**

The installer starts Larder with [Caddy](https://caddyserver.com) in front, and Caddy gets the HTTPS certificate automatically. Open `https://your-domain`, type the household password once on each device, and carry on from [step 5](#5-open-it-and-set-yourself-up).

The household password is the front door and PINs are the bedroom doors. Ten wrong passwords lock that address out for ten minutes, and five wrong PINs lock that profile for a minute. Use a long password: anyone who has it can create a profile in your Larder.

## 9. Updating

In the Larder folder:

```sh
git pull
./install.sh
```

When the installer asks, choose to keep your current settings. It rebuilds Larder and restarts it. Your diary, people and settings are kept, and Larder upgrades its own database when it starts.

If you used the ZIP, download the new one and copy its files over your Larder folder. Keep your `data` folder and `.env` file. Then run `./install.sh` (or `docker compose up -d --build`).

## 10. Backing up

Everything lives in the `data` folder inside your Larder folder: the diary database (`larder.db`) and the photos you've sent. Your settings are in `.env`.

To make a backup:

```sh
docker compose stop
cp -r data larder-backup-$(date +%F)
docker compose start
```

Stopping Larder first makes sure the database copy is complete. To restore, stop Larder, put the backed-up folder back as `data`, and start it again.

## 11. Changing settings later

- **Targets, goal weight, flex day, which model reads your food, your name and your PIN:** the sliders icon at the top right of Larder. Each person has their own.
- **Which AI, its keys and models, time zone, port, household password:** edit `.env` in the Larder folder, then run `docker compose up -d --build` (add `--profile cloud` on a cloud install).
- **Forgotten PIN:** in the Larder folder, run `docker compose exec larder node scripts/reset-pin.js Sam` with the person's name. Next time they tap their name, they choose a new PIN.

## 12. When something goes wrong

**The page won't load.** Check Larder is running with `docker compose ps`; it should say `running` or `Up`. If not, start it with `docker compose up -d`. From another device, make sure you're on the same Wi-Fi (or Tailscale) and using the machine's address, not `localhost`.

**"Larder's AI isn't set up yet."** Something that AI needs is missing from `.env`; the message says what. Add it and run `docker compose up -d`.

**"… isn't installed where Larder runs."** `.env` chooses an AI whose tool isn't built in. Add it to `LARDER_CLIS` (for example `LARDER_CLIS=codex`) and run `docker compose up -d --build`.

**"Couldn't reach host.docker.internal…"** Larder can't reach Ollama or your model server. Check it's running, and on Linux that it listens on `0.0.0.0` rather than only `127.0.0.1` (see [option 6](#6-ollama-models-on-your-own-computer)).

**Local model replies time out.** Raise `LARDER_AI_TIMEOUT` in `.env`, for example to `600`, or use a smaller model.

**Messages fail with a sign-in or key error.** Larder shows the AI tool's own complaint. The token may have expired, or the key may be wrong or out of credit. Fix it in `.env` (or sign in again, for Codex and opencode), run `docker compose up -d`, and press **Retry** on the failed message.

**"Port is already allocated" during install.** Something else is using port 8080. Run the installer again and choose another port, such as 8081.

**Dates are a day out.** Set `TZ` in `.env` to your time zone and run `docker compose up -d`.

**Seeing what Larder is doing:** `docker compose logs -f larder` shows its log; press Ctrl+C to stop watching.

Still stuck? Open an issue on GitHub with what you did and what the log says. Take any tokens or keys out first.
