<p align="center">
  <img src="docs/logo.png" alt="Larder" width="128">
</p>

<h1 align="center">Larder</h1>

<p align="center">
  <strong>A calorie diary for your household that runs on your own computer. Type, paste or snap what you ate and Claude turns it into kcal and macros.</strong><br>
  Larder works out everything else itself, so you only spend tokens when there's food to read.<br>
  Your diary stays on your machine. No account, no ads, no tracking.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-c8441c?style=flat-square&labelColor=1f1b16"></a>
  <img alt="Docker" src="https://img.shields.io/badge/runs%20in-Docker-c8441c?style=flat-square&labelColor=1f1b16">
  <img alt="Node 22" src="https://img.shields.io/badge/node-22-c8441c?style=flat-square&labelColor=1f1b16">
  <img alt="Phone, tablet, desktop" src="https://img.shields.io/badge/phone%20%7C%20tablet%20%7C%20desktop-c8441c?style=flat-square&labelColor=1f1b16">
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#why-larder">Why Larder</a> ·
  <a href="#features">Features</a> ·
  <a href="#screenshots">Screenshots</a> ·
  <a href="#privacy-what-leaves-your-server">Privacy</a> ·
  <a href="#development">Development</a> ·
  <a href="SETUP.md">Full setup guide</a>
</p>

<p align="center">
  <img src="docs/images/hero.png" alt="Larder on a desktop: today's total, the meals logged so far, the week's bars and the weight trend" width="100%">
</p>

---

Most calorie apps want a barcode for everything and a subscription for the useful bits. **With Larder you write "two crumpets with butter and a tea" or send a photo of a label or your plate, and Claude reads it.** Larder then does the remembering and the maths: daily and weekly targets, a flex day, macros, a weight trend with a goal date, presets and suggestions. The AI is only used at the moment you send something.

## Quick start

You need a computer that stays on (a home server, an old laptop or a small cloud server) with [Docker](https://docs.docker.com/get-docker/) installed, and either a Claude Pro or Max subscription or an Anthropic API key.

```sh
git clone https://github.com/doolecg/larderTracker.git larder
cd larder
./install.sh
```

The installer asks how to sign in to Claude and where you'll use Larder, then builds and starts it. Open the address it prints, and the first person sets themselves up.

**New to all this?** [SETUP.md](SETUP.md) walks through every step in plain English, including Windows, Tailscale, cloud servers, updating and backups.

## Why Larder

**Log like you'd text a friend.** "Porridge with a spoon of honey", a photo of a sandwich label, a picture of your plate. Claude reads the label when it can see one, uses your saved foods when they match, and otherwise estimates from typical UK values. Every item is tagged with where its numbers came from.

**Cheap on tokens.** Typed messages go to Claude Haiku and photos to Claude Sonnet by default, and you can change that per person. Tapping a saved food, a preset or a suggestion, copying from someone else's log, editing amounts and converting units all happen in Larder itself and cost nothing.

**Built for a household.** Each person gets a profile with a PIN, plus their own targets, weigh-ins and saved foods. You can copy a meal or a whole day from someone else's log when you ate the same thing, and share preset meals between you.

**Yours.** Larder runs on your machine and keeps everything in one folder (an SQLite file and your photos). Back up the folder and you've backed up the lot.

## Features

- **Text, paste or photograph.** Type a message, paste a screenshot, drop in pictures, or use the camera on your phone. Up to five photos per message.
- **Every unit you could want.** g, kg, oz, lb and stone. Teaspoons, dessertspoons, tablespoons, UK and US cups. ml, litres, fl oz, pints, shots, glasses, mugs, cans and bottles. Slices, handfuls, scoops, bars, portions, bowls and packs. Change the amount and the kcal and macros rescale. Change the unit and the amount converts, so 250 ml of milk becomes 1 cup.
- **Where did that number come from?** The (i) on each item says whether it came from a label, a Claude estimate (and which model), a saved food, a preset, someone else's log or your own edit. It also shows the conversion and per-100 g figures.
- **The week, not just the day.** Monday to Sunday bars against your target, with one bigger day a week. That day is either the first one you go over or a fixed day you choose.
- **Weight trend.** Log a weigh-in by typing `w 92.4` or `14st 8lb`. Larder fits a trend over the last eight weeks and tells you roughly when you'll reach your goal.
- **Presets and suggestions.** Save a meal you have often, or long-press several items and save them as a meal. Larder suggests your usual breakfast in the morning from your own history, without calling Claude.
- **Installs like an app.** Add it to your phone's home screen. Light and dark themes follow your phone's.
- **Optional household password and HTTPS** for installs on the open internet.

## Screenshots

<p align="center">
  <img src="docs/images/phone-day.png" alt="Today's diary on a phone, with suggestion chips above the message box" width="24%">
  <img src="docs/images/phone-info.png" alt="The info panel explaining where an item's numbers came from" width="24%">
  <img src="docs/images/phone-edit.png" alt="Editing an item: amount, unit picker and grams" width="24%">
  <img src="docs/images/phone-weight.png" alt="Weight chart with the projected goal date" width="24%">
</p>
<p align="center">
  <img src="docs/images/phone-copy.png" alt="Copying a meal from someone else's log" width="24%">
  <img src="docs/images/phone-setup.png" alt="First-run setup: name, PIN, targets and goal" width="24%">
  <img src="docs/images/dark.png" alt="Larder in dark mode on a desktop" width="49%">
</p>

The people and food in these screenshots are made up. Run `npm run demo` against an empty data folder to get the same demo household.

## How it works

- `src/parse.js` is the only part that talks to Claude. It runs the [Claude Code](https://code.claude.com) CLI (`claude -p`, with every tool switched off) and sends your text, any photos (shrunk in the browser first), your saved foods and the time of day. It asks for structured JSON back: items with an amount, a unit, a weight in grams, kcal, macros and a source.
- `src/server.js` stores entries in SQLite and does all the sums. `src/meals.js` handles presets, copying and the suggestions, and `public/units.js` holds the unit tables shared by the browser and the server.
- The front end is plain JavaScript with no build step, served by the same Express app.

## Privacy: what leaves your server

Larder has no analytics, tracking or account of its own. The only outside connection it makes is to Claude:

- **When you send a message**, Larder sends that message's text and photos, the names and values of your saved foods, and the local time to Anthropic through the Claude Code CLI, under your own Claude subscription or API key and Anthropic's terms. Nothing is sent when you tap saved foods, presets or suggestions, or when you edit, copy or browse.
- **Fonts and scripts** are served by Larder itself. Pages make no requests to other sites.

Everyone with a profile in your Larder can see and copy from the other profiles' food logs, but not their weigh-ins or settings. PINs keep a household out of each other's diaries; for anything beyond your home network, set a household password (see [SETUP.md](SETUP.md)).

## Development

Needs Node.js 22.

```sh
npm install
DATA_DIR=./dev-data npm run demo   # optional: a made-up household to play with
DATA_DIR=./dev-data npm start      # http://localhost:8080
```

To read food you need `claude` on your `PATH` and `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` set. Without either, everything except reading new messages still works.

## License

Larder is released under the [MIT License](LICENSE). Copyright © 2026 doolecg.

Claude and Claude Code are products of Anthropic, used under your own account and Anthropic's terms. Larder is not made by, endorsed by or affiliated with Anthropic.

## Disclaimer

Larder is a diary, not medical advice. Its numbers are estimates: a label is only as good as the label, and an estimate from a photo of a plate can be out by a fair way, mostly on portion size. Talk to a doctor or dietitian before making big changes to what you eat, especially if you have a medical condition, are pregnant, or take medication that affects appetite or weight.

This software is provided "as is", without warranty of any kind, as set out in the [LICENSE](LICENSE). Back up your `data` folder; you use Larder at your own risk.
