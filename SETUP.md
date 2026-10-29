# Setting up Larder

This guide takes you from nothing to a working Larder, step by step. You don't need to be technical. You do need about 20 minutes, a computer that can stay switched on, and a Claude account.

**Contents**

1. [What you need](#1-what-you-need)
2. [Choose how Larder signs in to Claude](#2-choose-how-larder-signs-in-to-claude)
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
- **A Claude account**, so Larder can read what you send. [Step 2](#2-choose-how-larder-signs-in-to-claude) explains the two options.
- **About 2 GB of free disk space** for Docker and Larder. Your diary itself takes very little.

You don't need a domain name, port forwarding or any coding.

## 2. Choose how Larder signs in to Claude

Each Larder signs in to Claude with its owner's account. Pick one:

### Option A: a Claude subscription (Pro or Max)

Best if you already pay for Claude. It costs nothing extra, and your Larder messages count towards your normal Claude usage limits. By default typed messages use Claude Haiku, which takes very little of your allowance.

Larder needs a long-lived sign-in token, which you make once:

- **If you have Claude Code on a computer**, open a terminal and run `claude setup-token`. It opens your browser, you sign in and approve, and it prints a token starting with `sk-ant-oat`. Copy it.
- **If you don't**, skip this. The installer can run it for you inside Larder: it prints a link, you open it in your browser, sign in, and paste back the code it shows.

Treat the token like a password. Anyone who has it can use your Claude subscription.

### Option B: an API key (pay per use)

Best if you don't have a subscription, or want Larder's use kept separate.

1. Go to [console.anthropic.com](https://console.anthropic.com) and sign up or sign in.
2. Add some credit under **Billing**. A few pounds lasts a long time for one household, since a typed message usually costs a fraction of a penny, but check Anthropic's current prices.
3. Go to **API keys**, press **Create key**, name it "Larder", and copy the key (it starts with `sk-ant-api`).

You can set a monthly spending limit in the console, which is a good idea.

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
2. Builds Larder. The first time takes a few minutes.
3. Asks which Claude option you picked in step 2, and for the token or key. It doesn't show what you paste.
4. Asks where you'll use it. Choose **At home** unless you're on a cloud server (step 8).
5. Asks your time zone, so "today" starts at your midnight, and which port to use (just press Enter for 8080).
6. Saves your answers in a file called `.env` in the Larder folder, starts Larder, and prints the address to open.

From now on Larder starts by itself whenever the machine or Docker restarts.

<details>
<summary>Doing it by hand instead (or on Windows without Ubuntu)</summary>

Copy `.env.example` to `.env` and open it in a text editor. Fill in **either** `CLAUDE_CODE_OAUTH_TOKEN` **or** `ANTHROPIC_API_KEY`, and set `TZ` to your time zone (for example `Europe/London` or `America/New_York`). Then, in a terminal in the Larder folder:

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

- **Targets, goal weight, flex day, which Claude model reads your food, your name and your PIN:** the sliders icon at the top right of Larder. Each person has their own.
- **Claude token or API key, time zone, port, household password:** edit `.env` in the Larder folder, then run `docker compose up -d` (add `--profile cloud` on a cloud install).
- **Forgotten PIN:** in the Larder folder, run `docker compose exec larder node scripts/reset-pin.js Sam` with the person's name. Next time they tap their name, they choose a new PIN.

## 12. When something goes wrong

**The page won't load.** Check Larder is running with `docker compose ps`; it should say `running` or `Up`. If not, start it with `docker compose up -d`. From another device, make sure you're on the same Wi-Fi (or Tailscale) and using the machine's address, not `localhost`.

**"Larder isn't signed in to Claude yet."** The token or key is missing from `.env`. Add it and run `docker compose up -d`.

**Messages fail with a sign-in or authentication error.** The token may have expired or been revoked, or the API key may be out of credit. Make a new token with `claude setup-token` (or check your balance in the console), put it in `.env`, and run `docker compose up -d`. Press **Retry** on the failed message.

**"Port is already allocated" during install.** Something else is using port 8080. Run the installer again and choose another port, such as 8081.

**Dates are a day out.** Set `TZ` in `.env` to your time zone and run `docker compose up -d`.

**Seeing what Larder is doing:** `docker compose logs -f larder` shows its log; press Ctrl+C to stop watching.

Still stuck? Open an issue on GitHub with what you did and what the log says. Take any tokens or keys out first.
