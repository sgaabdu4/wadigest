# wadigest: handover

Read this first. It explains what we're building, everything decided so far, what works, what's been tested, and what's left. You can copy this whole folder to another computer and carry on from here.

_Last updated: Sunday 18 October 2026, around 18:25 (UK time). Fresh-Mac end-to-end run passed; demo video v2 done._ _Earlier: around 17:30 (UK time). Fourth pass: real WhatsApp test on real groups, summarise everything, built-in local AI, demo video._ _Previous: around 16:10 (UK time). Third pass: several groups, any schedule, Send now, a calm one-click setup page, one-command install, public GitHub repo (sections 2.3, 4, 5)._

---

## 1. Where we are, in 30 seconds

- **What it is:** a digest bot for one or more WhatsApp groups. On a schedule you choose (weekly by default) it reads every message each group sent in the period, summarises all of it (reactions only set the order), and per group **posts the summary**, **pins it** and **DMs it to every member** (each switch can be turned off). It runs on one person's computer through **wacli** (an open-source tool that links to WhatsApp like WhatsApp Web).
- **Where it lives:** public repo **https://github.com/sgaabdu4/wadigest**. Install with one command (README, Install).
- **State:** working end to end on the runner's Mac with a real WhatsApp account: one-command install, QR scan, three real groups posted, pinned and DM'd, background service running. 28 automated tests pass locally and in GitHub Actions.
- **Not done yet:** a Windows PC run, the Invite QR with a second phone, demo video v2 (being made with Kokoro voice).
- **Next step:** follow **[START-HERE.md](START-HERE.md)**. It's one page, written for someone who has never used a terminal: one command (or double-click `Start wadigest`), scan the QR code, tick groups, press Start. Section 7 has the extra checks for whoever built it.

---

## 2. The hackathon brief (everything the team asked for, in order)

### 2.1 Hackathon setup (context)
- Developer Bros group hackathon, about 4 hours. Teams were random and mixed-level (beginner, intermediate, advanced), and captains were picked at random to act as liaison and break ties between ideas. Levels reflect experience, not intelligence.
- Beginners go in teams of 3 so nobody is left alone. The one team of 2 pairs an advanced with an intermediate member. Captains can rename their team.
- Teams were generated with an app (animations, Convex backend). Timing allows for Salah; something finishes at 5:20.
- The topic was open on purpose: the project must **benefit this group**, picked from a pool of 6 ideas in the chat.

### 2.2 The idea we picked
- **Problem:** group chats get flooded with AI tool content and workflow links that are hard to keep up with.
- **Must stay inside WhatsApp.** A separate website was suggested and rejected: people won't leave WhatsApp. A separate chat platform tried by a similar community lasted only about a week, and clients the team works with also refuse anything that isn't WhatsApp.
- **Weekly summary:**
  - Every **Sunday**, summarise the **previous week** (for example the 11th to the 18th), **post it in the group and pin it**.
  - Rank the week's topics in tiers by **reactions, discussion volume and link content**, and keep the **top five**.
  - Keep it **short**: about **two sentences per item**, under a page, with **links to the tools mentioned**.
  - Video or image summaries were first rejected because WhatsApp media downloads take up space. Later steering asked for videos to be **watched/understood if possible**, ideally with a **local model**. That's now built as an optional add-on that deletes the files afterwards (section 4.6).
  - **Personal versions** go to members' own WhatsApp. Interests alone could miss things, so the **full summary is kept with that person's interests put first**.
  - The original idea was a form filled in when joining the group. The later decision was **no Google Form**: "We can send the same message to each individual member of the group, as well as to the group, and we pin it." The group is **up to 15 members**, so DMing everyone is fine.
- **Assessment:** an easy build; simple, high-value solutions preferred.

### 2.3 Steering from the build sessions (all of it)
1. Use **wacli** connected to one of our WhatsApps to build the whole application.
2. **Package it fully** so we can send it to other people and they can run it on their own device.
3. **No AI summaries for now**, but plan to connect **Claude** at the end: Claude sends the summarised info to our program, and our program pins it, posts it and DMs people.
4. Only summarise the **last 7 days**. If videos are posted, **watch them** and use what's in them if possible. A **local model** for that would be useful.
5. **One person** sets it running for a group, and everyone gets their summary on Sunday.
6. Build it **autonomously**. Ask for the WhatsApp **link code only at the very end**, once everything is set up and known to work.
7. The first build ran in a cloud session and couldn't link a real WhatsApp. "It didn't do a good job," so it was **rebuilt from scratch**, and this is that rebuild. The old handover is in git history (commit `84d89fa`).
8. The group is the **Developer Bros group chat**. Store the group's **ID**, not just its name, so **renaming the group doesn't break it**.
9. It must work for **any chat**, not just Developer Bros. **One command**: it **asks for the chat name** after WhatsApp is linked, and if the chat **doesn't exist** it says so.
10. A **small UI or pop-up** shows the **link code or a QR code** to scan. Everything else is automatic and runs in the background.
11. You can **change the group** later. Changing it **resets everything** for the new group, which then starts fresh from the next weekly run and covers the previous 7 days. It runs every 7 days.
12. Everything must look **"hella beautiful" and be idiot-proof**, the entire flow.
13. Setup must **ask which method** writes the summary: **(a)** install a local model and set everything up, **(b)** use Claude, **(c)** just a plain summary with no models.
14. **Terminal or UI:** if the computer has a screen, show the UI. If it's terminal-only (a server or SSH), run the terminal version.
15. **Windows, Linux and Mac**, with no manual setup. Everything automatic, including **checking whether Claude and everything else is installed**.
16. Group members: we can get them from WhatsApp (no form). Send everyone the same digest, plus personal ordering when they've set interests.
17. **Pinning:** "I thought we were creating a fork of wacli that can actually pin the messages." That's now **built as a fork patch** (section 4.7).
18. **Follow links:** the AI modes should read the linked page, not just its title. Now they read the page text (section 4.5).
19. Write a **handover document** with **every piece of information from the start**, so the folder can be **dragged and dropped onto another person's computer** and we know exactly where we are and what to do. **This file.**
20. **One click, UI setup.** Double-click, the page opens, and the page does the installing (no wall of terminal text first).
21. **Simplify it for anyone.** A one-page [START-HERE.md](START-HERE.md); no terminal needed.
22. **Public GitHub repo** with a README as polished as relaybar's, and **one command** that sets everything up.
23. **Send now** button, plus a schedule you can set: **how often** (every day up to every month) and when. Each summary reads the days since the last one by default (`schedule.readDays` changes that).
24. **The UI must be really simple:** the QR code first, then choices. Later: "looks like AI slop", so make it **calm, peaceful, beautiful**, easy for anyone, and **light only (no dark mode)**. Built from an agreed mockup: warm paper, sage green, serif headings, one thing per screen, settings as a sentence ("Send a summary every week on Sunday at 9:00, written simply").
25. **Several groups**, each with its own summary and its own switches: **post in the group**, **pin it**, **message each member**.
26. **Ubuntu server / no GUI** must keep working (terminal setup).
27. **Sign up with a QR code:** the **Invite** button shows a QR code members scan to open WhatsApp with `!digest join` ready to send. For the demo, someone else can link their own WhatsApp with **Change WhatsApp** (it unlinks the current number and shows a new QR code).
28. **Final real test** against the **Summarizer** and **Sammy family** groups, after the user scans the QR code.
29. Make sure it is idiot-proof and works.

---

## 3. How it works

```
 WhatsApp ⇄ wacli sync --follow (keeps a local copy of messages on this computer)
                 │
 wadigest daemon (background, starts at login)
   ├─ every minute: answers "!digest …" commands (DM reply)
   ├─ every 3 h: transcribes new group videos (optional)
   └─ at each slot (default every Sunday 09:00), for every chosen group:
        read the days since the last slot → rank → (optional AI write-up)
        → post in that group → pause sync → pin for 7 days → resume sync
        → DM that group's members (each step can be switched off per group)
```

- **Ranking (no AI):** `score = reactions×3 + replies×2 + re-shares×2 + up to 3 for reply volume`.
  - The same link shared twice is one item. Tracking junk is stripped and `youtu.be` = `youtube.com`, `twitter.com` = `x.com`.
  - Threads are any message with 2+ replies.
  - Reactions count one per person, their latest one wins, and removed reactions don't count.
  - Deleted messages, `!digest` commands and wadigest's own posts are ignored.
- **Reliability:**
  - If the computer was asleep, it catches up when it wakes, up to 72 h late.
  - It never posts twice for one slot in one group, and never posts for a slot before that group was added (or before the chosen first run).
  - A failed run retries 3 times, 30 minutes apart.
  - The group post is recorded the moment WhatsApp accepts it, so a crash during the DMs can't cause a double post.
- **DMs:** sent 8–20 s apart, at most 100 per run (the group has ~15 people). They're never sent to the linked number itself, because WhatsApp drops self-DMs, and never to anyone who sent `!digest stop`.
- **Member commands** (in the group, or by DM to the runner's number):
  - `!digest interests agents, n8n`: set interests, so that person's picks come first ⭐
  - `!digest join …`: opt in, or opt back in
  - `!digest status`
  - `!digest stop`: no more DMs (the group post carries on)
  - `!digest help`
- **Everything stays on the runner's computer** in `~/.wadigest` (Windows: `%USERPROFILE%\.wadigest`): config, the linked WhatsApp session, members, logs.

---

## 4. What's built (file by file)

| Area | Files | Notes |
|---|---|---|
| Entry | `bin/wadigest.js`, `src/cli.js` | Plain `wadigest` opens setup or the control panel. Also `preview`, `run`, `status`, `doctor`, `groups`, `members`, `config`, `export`, `service`, `daemon`. |
| Setup page (UI) | `src/webui.js`, `src/ui/index.html` | Local page on 127.0.0.1 with a secret URL token. Calm design, light only. Screens: **Getting ready** (first run only: runs the installer) → **Connect WhatsApp** (QR first; phone-number code as a fallback) → **Which groups?** (tick any number) → **How it works** (a sentence: how often, day, time, written simply / with local AI / with Claude; per-group dots for post, pin, message members) → **All set** (next send time, **Send now**, **Preview**, **Invite** QR, change links). Mobile-friendly. |
| Terminal setup | `src/cli.js` (`cmdSetup`) | Same steps as text: link, groups (add as many as you like, with post/pin/DM questions for each), summary style, how often/day/time, start. Used when there's no screen or over SSH (`src/setup-actions.js` → `hasUI()`), or forced with `--terminal`. `--ui` forces the page. |
| wacli wrapper | `src/wacli.js` | JSON envelope parsing, paging with `--cursor`, `send text` (retries while the store is locked), pairing with `--events` (pair code and QR events), `sync --follow`, media download, `messages pin`. **Checked against wacli 0.22's source code.** |
| Ranking | `src/rank.js`, `src/links.js` | Links, uploaded videos, threads. `links.js` also gets page title, description and page text (oEmbed for YouTube/TikTok). |
| Write-up | `src/summary.js` (contract + simple mode), `src/fullsummary.js` (reads every message; long chats summarised in parts, then the parts summarised; only real links kept; never invents topics), `src/local.js` (built-in llama.cpp model), `src/claude.js` (Claude Haiku via `claude -p` or API key) | Any AI failure falls back to the simple summary, so a post always goes out. |
| Formatting | `src/format.js` | WhatsApp `*bold*` / `_italic_`. Group post + personal DM (⭐ matches first, plus up to 3 extra matches). |
| Members/commands | `src/members.js`, `src/commands.js` | Interest matching (whole words, plurals). Phone vs `@lid` IDs of the same person match. |
| Who gets DMs | `src/pipeline.js` → `dmRecipients` | `everyone` (default; group member list from wacli minus opt-outs), `opted-in`, or `off`. |
| Schedule | `src/schedule.js` | Every N days (1–31; 7 = weekly on the chosen day; others start on the chosen day and repeat). Timezone/DST-safe (tested across the 25 Oct 2026 clock change), catch-up, retries. |
| Groups | `src/config.js` (`groups`, `groupConfig`), `src/reset.js` (`setGroups`) | `groups: [{jid, name, post, pin, dm, addedAt}]`. Old single-group configs are converted on load. A new group starts fresh from its next slot. |
| Background | `src/daemon.js`, `src/service.js` | Supervises `wacli sync --follow` (restart with backoff, cleans up a leftover sync, stops if WhatsApp unlinks). Service: **launchd** (Mac), **systemd user unit** (Linux), **Startup-folder launcher** (Windows). |
| Videos | `src/video.js`, `src/setup-actions.js` | ffmpeg + whisper.cpp (`brew install ffmpeg whisper-cpp` + `ggml-base.bin` model), first 10 minutes, files deleted after. **Not on Windows yet.** |
| Local AI | `src/local.js`, `src/setup-actions.js` | Ships with wadigest: llama.cpp `llama-server` (pinned build b11719, per OS) plus **Qwen3 1.7B** Q4_K_M (1.3 GB), both downloaded once into `~/.wadigest/llm` and checked against pinned SHA-256s. Started only while writing a summary. No Ollama. |
| Claude | `src/claude.js` | Uses Claude Code (`claude -p`) if installed, otherwise an API key saved in `~/.wadigest/secrets.json` (owner-only). Default API model `claude-sonnet-5-5`. |
| Claude hand-off | `wadigest export --out week.json --prompt` → Claude writes `summary.json` → `wadigest run --summary summary.json` | Or `config set mode summary-file` + `summary.path`. Format in README. |
| Pinning (fork) | `wacli-fork/messages_pin.go`, `wacli-fork/build.sh`, `.github/workflows/wacli-fork.yml` (builds Mac arm64/Intel, Linux amd64/arm64 and Windows, and publishes the release on pushes that touch `wacli-fork/`) | Adds `wacli messages pin --chat --id [--duration 7d] [--unpin]`, which sends WhatsApp's `PinInChatMessage` (24h/7d/30d). wadigest pauses sync, pins, and resumes. |
| One command | `get.sh`, `get.ps1` | `curl -fsSL https://raw.githubusercontent.com/sgaabdu4/wadigest/main/get.sh \| bash` (Windows: `irm …/get.ps1 \| iex`). Downloads the repo into `~/.wadigest/app` and runs the installer. |
| Installers | `scripts/install.sh` (Mac/Linux), `scripts/install.ps1` (Windows), `Start wadigest.command`, `Start wadigest.cmd` | wacli with pinning is downloaded ready-made from this repo's release `wacli-fork-v0.22.0` (checksum-checked); Homebrew/upstream wacli and a Go build are fallbacks. | **One click:** on a computer with a screen, `install.sh` only sets up Node and the `wadigest` command, then opens the page. The page's **Getting things ready** screen runs `install.sh --from-ui` for the rest and shows a checklist. When it finishes it writes `~/.wadigest/installed`, and the page skips that screen next time. Over SSH, or with `--terminal`, it all runs in the terminal as before. No manual setup: they download a private **Node 22** if needed (checksum-checked), install **wacli** (Homebrew, or a checksum-checked GitHub release), **build the pin fork** (installs Go via brew if needed; skip with `--no-pin`), add `wadigest` to PATH, and open setup. Flags: `--with-video`, `--no-setup`, `--no-pin`, `--group "Name"`, `--phone +44…`. |
| Packaging | `scripts/package.sh` | `release/wadigest-<ver>.zip/.tar.gz` to send to other people. |
| Tests | `test/*.test.js`, `test/fixtures/fake-wacli.js`, `.github/workflows/test.yml` | `npm test` (Node's built-in runner, no installs), also on every push. The fake wacli copies real wacli 0.22 JSON shapes and also simulates pairing, pinning and sync. |

No runtime dependencies: just Node 20+.

---

## 5. What's been tested, and what hasn't

**Verified on the runner's Mac (second pass, 18 Oct, 15:30):**
- **Automated tests:** `npm test` on Node 26.12: 22 passed, 0 failed. This covers the code changed after the interrupted run.
- **Pin fork compiles:** `wacli-fork/build.sh` run in a `golang:1.27` Docker container (Linux, arm64). It fetched wacli v0.22.0, added the command, built, and `wacli messages pin --help` shows `--chat`, `--id`, `--duration` (default 7d), `--unpin` and `--sender`. `wacli --version` says `0.22.0-wadigest`.
- **Mac installer (`install.sh --no-setup`)** in a throwaway home folder with the fake wacli, three ways:
  - Node already installed: used it, made the `wadigest` command, added the PATH line to `.zshrc`, ran `doctor`.
  - No Node on the PATH: downloaded Node 22.23.3, passed the checksum check, and the `wadigest` command points at that private copy.
  - wacli without pinning and no Go or Homebrew: printed the "Go isn't installed, pinning is skipped" warning and carried on.
- **One-click setup:** in a throwaway home folder with the fake wacli, `install.sh` (as the double-click runs it) set up Node and opened the page in about 2 seconds. The **Getting things ready** screen ran the installer, showed the checklist (pinning marked as skipped because there was no Go), then moved on to **Connect your WhatsApp** by itself. Linking with the fake number worked after that. Tests rerun after this change: 22 passed.
- **README.md** now matches this handover (install on all three systems, setup page, summary styles, DMs to everyone, pinning, Windows, privacy, code map).

**Verified in the build session (first pass, cloud):**
- **Automated tests:** 22 passed: ranking, dedupe, reactions, threads, commands, formatting, DST schedule, catch-up and retries, the full post → pin → DMs pipeline, DMs to all members minus opt-outs and self, and the Claude summary hand-off.
- **Setup page, in Chromium against the fake wacli:** phone code, linking, "group doesn't exist", group found, the summary-style screen, schedule, Start, control panel, Preview, the switch-group dialog, mobile and dark mode. No browser errors.
- **Terminal wizard:** run end to end with piped input, including "doesn't exist" and switching group.
- **Background loop:** it answered a `!digest join`, posted on schedule, sent the DM, and skipped the second post.
- **Installer (Mac/Linux script):** ran in a clean home folder with a fake wacli and set up the command and PATH.

**Verified on the runner's Mac with real WhatsApp (fourth pass, 18 Oct, 16:20 to 17:30):**
- **One-command install** (`curl … get.sh | bash`) from the public repo: Node found, page opened in about 2 s, "Getting ready" downloaded wacli with pinning from this repo's release (checksum-checked), no Homebrew or Go needed.
- **QR link** with the runner's phone: about 1,000 messages synced, then the page moved on by itself. (The progress count and the "you're linked" message were added after this, because it looked stuck.)
- **Real sends** (the runner approved posts, pins and DMs):
  - Summarizer: posted, pinned, 2 DMs.
  - SAMI family: posted, pinned, 10 DMs.
  - Family ❤️: posted, pinned, 5 DMs, each DM then deleted for the runner only.
  - Each group's summary went only to that group's members.
- **Summary styles on real chats:** Claude Haiku (about 35 s, short plain English, very accurate); built-in local AI Qwen3 1.7B (15 to 25 s, accurate topics, some repetition); LFM2.5 1.2B was tested and rejected (vague, invented topics).
- **History:** WhatsApp gives a newly linked device only a small slice of past messages. `wacli history backfill` fetched older messages (Everything Electric 150, Family ❤️ 148) but could not fill July to mid-October for Family ❤️. Everything after linking is captured live.
- **Bugs found and fixed during the real run:** sends failed while the service held the store lock (now the service pauses for the whole send, page and CLI); `launchctl kickstart` could hang (20 s limit, bootstrap retry); the page paused the service and so stopped member replies (now only during first setup or relinking); "All quiet" when a quiet chat had a short real message (now lists every message).
- **Ubuntu 24.04 container, no screen:** install, terminal setup with several groups, preview, run, config commands all pass (systemd itself not available in the container).

**Fresh-Mac end-to-end run (18 Oct, about 18:00):** empty home folder, fake WhatsApp tool, public one-line install from GitHub. Page opened by itself in about 2 s; Getting ready, QR, connected, Which groups? all automatic; ticked two groups, Start, All set (next Sunday 25 Oct 09:00); Preview showed both; Send now posted and pinned each group, sent private messages only to that group's members (2 and 1) and deleted each for the sender; typing `wadigest` reopened the page with the service running. Apple's `container` tool can't test this: it runs Linux only, and its guests have no internet on this Mac.

**Live setup on the runner's Mac right now:** groups Summarizer and Family ❤️ (post, pin and DMs on), every week on Sunday 09:00, written with the built-in local AI (Qwen3 1.7B, installed in `~/.wadigest/llm`). The background service is running. Ollama was removed from the code; a failed Homebrew `ollama` install may have left partial files (`brew list ollama` to check).

**Not verified:**
1. **Windows:** `get.ps1`, `install.ps1`, `Start wadigest.cmd`, the Startup-folder service and the Windows llama.cpp build were written carefully but never run on a real Windows PC.
2. **Invite QR with a second phone**, and a member's `!digest join` reply arriving within about 2 minutes.
3. **A real scheduled Sunday run** (the schedule logic is tested; the first real slot is Sunday 25 October 09:00).
4. **Linux with real systemd** (the "keep running after logout" step).
5. **Video transcription** (ffmpeg + whisper.cpp): written but not run.

---

## 6. Decisions and defaults (and how to change them)

| Setting | Default | Change |
|---|---|---|
| Groups | chosen during setup, stored by **ID** | Page, Change groups, or `config add-group/remove-group "Name"` |
| Per group | post **on**, pin **on**, message members **on** | Page, Change settings (tap the dots), or `config group "Name" post\|pin\|dm on\|off` |
| Schedule | **every 7 days, Sunday 09:00**, computer's timezone | Page sentence, or `config set schedule.everyDays/day/time/timezone` |
| Window | the days since the previous slot | `config set schedule.readDays N` (0 = same as how often) |
| Items | **everything** (simple style lists up to 40; AI styles cover every topic) | `config set topN 0` (0 = everything) |
| Write-up | **Simple summary (no AI)** | Page sentence ("written simply"), or `config set mode digest\|local\|claude\|summary-file` |
| DMs | **everyone in the group** (minus `!digest stop`) | Per-group switch; `config set dms.audience everyone\|opted-in` decides who counts |
| Pin | **auto** (when the fork is installed), **7 days** | `config set pin.enabled off`, `config set pin.duration 30d` |
| Videos | auto when installed; asked during setup | `config set video.enabled auto\|on\|off` |
| Local model | `qwen3-1.7b` (built in) | `config set local.model lfm2.5-1.2b` for a smaller, vaguer model |
| Claude | Claude Code login if found, else API key | `wadigest config set-key` |

**Risks we accepted:**
- **Unofficial client:** wacli isn't an official WhatsApp client, and automated sending can get numbers restricted. It's one post a week plus ~15 DMs spaced out, but a spare number is safest.
- **Pinning permission:** in groups where only admins can pin, the linked number must be an admin.

---

## 7. Next steps (in order)

1. **Demo video:** v2 is done: `demo/wadigest-demo-v2.mp4` (1920x1080, 3:08). It uses real footage of the full flow recorded with the fake WhatsApp tool and sample groups, a Kokoro voice (`bm_fable`, speed 1.08, free, runs locally) and a soft ffmpeg music bed. v1 (ElevenLabs "George") is `demo/wadigest-demo-v1.mp4`. `demo/` is not committed (gitignored). Rebuild steps are in `demo/NOTES.md`. Its build scripts live in the session scratch folder, so copy them somewhere safe if you want to edit the video later. Not checked: the voice by ear, including how it says "wa-dee-jest". The ElevenLabs account has about 1,170 characters left until its monthly reset.
2. **Before Sunday 25 October 09:00:** leave the runner's Mac on or asleep (it catches up within 3 days). Open the page (`wadigest`) and open each group's **Preview** to check it.
3. **Invite test:** on the page, press **Invite**; someone scans it and sends `!digest join`. They should get a reply within about 2 minutes.
4. **Windows:** run the one PowerShell line on a Windows PC and go through setup.
5. **Tell the groups:** *"You'll get a summary of this group here and by private message. Send `!digest interests agents, n8n` to get your picks first, or `!digest stop` for no private messages."*

---

## 8. Moving it to another computer

- Copy this **whole folder**, or zip it, or run `bash scripts/package.sh` and send `release/wadigest-2.0.0.zip`.
- On the new computer, double-click **`Start wadigest.command`** (Mac/Linux) or **`Start wadigest.cmd`** (Windows). It installs everything and opens setup.
- The linked WhatsApp session does **not** travel with the folder. It lives in `~/.wadigest` on the old computer, and each computer links its own. Run it on **one** computer per group, or the group gets two digests.
- To remove it from a computer, run `bash scripts/uninstall.sh` and delete the device under WhatsApp → Linked devices.

---

## 9. Handy commands

```bash
wadigest                 # the page (or the setup questions on a server)
wadigest preview         # build the summaries now, sends nothing
wadigest run             # send now (asks first; --group "Name" for one group)
wadigest status          # groups, schedule, next send, last send
wadigest doctor          # health check
wadigest groups [name]   # list your WhatsApp groups
wadigest config add-group "Name" / remove-group "Name" / group "Name" pin off
wadigest config set schedule.everyDays 3
wadigest config set mode digest|local|claude
npm test                 # tests
```

**Logs:** `~/.wadigest/logs/` (`wadigest.log`, `wacli-sync.log`, `link.log`, `wacli-build.log`).
**Data:** `~/.wadigest/` (`config.json`, `members.json`, `state.json`, `wacli-store/`, `archive/`).
