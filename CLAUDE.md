# GitGallery — working rules for Claude

## 1. Test it yourself. Never hand back untested work.

**You have full control of the emulator and simulator. Use it.** Do not report a feature as working because the code looks right — build it, install it, drive the UI, and watch it actually work. "It should work" is not an acceptable status.

### Tooling (verified present on this machine)

```bash
ADB=~/Library/Android/sdk/platform-tools/adb
$ADB devices -l                                   # emulator-5554 (Pixel 6 Pro) is usually already up
~/Library/Android/sdk/emulator/emulator -list-avds # Pixel_6_Pro, Pixel_6_Pro_Charles

$ADB -s emulator-5554 shell input tap X Y
$ADB -s emulator-5554 shell input swipe X1 Y1 X2 Y2 300
$ADB -s emulator-5554 shell input text "query"
$ADB -s emulator-5554 exec-out screencap -p > shot.png   # then Read the png to actually look at it
$ADB -s emulator-5554 logcat -d                          # crashes, stack traces
$ADB -s emulator-5554 shell am force-stop <pkg>
```

iOS: `xcrun simctl list devices available` (sims up to iOS 26.5), `xcrun simctl boot`, `io <udid> screenshot out.png`.

**Always look at the screenshots you take.** Read the PNG back — a screencap you never opened has verified nothing.

### What "tested" means

For every change, exercise the real flow end to end on a device:

- **Happy path** — the thing you built, from a cold app start
- **Edge cases** — empty library, one item, thousands of items, very tall/wide images, a 500 MB video
- **Failure modes** — airplane mode mid-upload, killed app with a queue pending, expired token, rate limit hit, a `.ptr` whose asset is missing
- **Lifecycle** — background the app, rotate, kill and relaunch, verify queue and cache survive
- **Both platforms** — Android first, iOS before calling anything done

### Visual parity with Immich is part of correctness

A screen that functions but looks wrong is **not done**. Immich's source is cloned at `reference/immich/` — it is the ground truth for spacing, radii, type scale, and color. Read the actual Dart widgets (`mobile/lib/presentation/widgets/timeline/`, `mobile/lib/theme/`) for exact values rather than eyeballing.

Process: screenshot our screen → compare against Immich's spec/rendering → fix the deltas → screenshot again. Chasing "close enough" is how it ends up looking like stock React Native Paper, which is the one outcome this project exists to avoid.

### Fix what you find

Finding a bug and reporting it is half a job. **Fix it, then re-test to prove the fix.** That includes bugs you didn't introduce, UI/UX drift from Immich, jank, layout shift, and slow frames. If a fix is genuinely out of scope, say so explicitly and log it — don't quietly leave it.

### Report honestly

If a test fails, say it failed and show the output. If something couldn't be tested, say which part and why. Never describe unverified work as verified — a false "working" is worse than an honest "untested."

### The two real guardrails

1. **Destructive storage operations** (squash, force-push, bulk delete) get tested against a **throwaway private repo with junk photos** — never against a real library. This is the top risk in the plan.
2. **GitHub Device Flow needs a human step** — the user enters the code in a browser. Drive everything up to and after it; hand off that one step.

---

## 2. Git: never commit or push unless explicitly asked

Write and edit files freely — but `git commit` and `git push` are **the user's call, every time**. The standing "don't ask, just execute" rule covers doing the work, not version control.

This repo is a **personal** project. Its identity is set locally and must stay that way:

```
user.name  = Avishisht Gupta
user.email = avishishtgupta@gmail.com
origin     = git@github-personal:labmember003/my-project.git
upstream   = Sumit189/GitGalleryApp (fork base, read-only)
```

⚠️ The machine's **global** git config is the work identity (`avishisht.gupta@zomato.com`). Any new repo silently inherits it. If you ever init another repo here, set the local identity **before** the first commit, and verify with `git log --format="%an <%ae>"`.

## 3. Keep the docs live (standing — never ask, just do it)

After **every** substantive exchange, update the docs in the same turn.

| File | Update when |
|---|---|
| `docs/CHAT-LOG.md` | **Every exchange.** Append the turn: user message verbatim, assistant reply faithfully. Keep the "Decisions reached" table current. |
| `docs/BIG-BRAIN-IDEAS.md` | An idea is added, promoted, demoted, or dropped |
| `docs/PROJECT-DOC.md` | Scope, architecture, constraints, or a decision (D-number) changes |
| `docs/IMPLEMENTATION-PLAN.md` | Phases, tasks, estimates, or risks change |
| `README.md` | The one-paragraph story or storage model changes |

## 4. Docs hold the *current* design, not the history

**Dropped ideas get deleted, not archived.** No strikethroughs, no "correction" blocks, no rejected-ideas tables. `CHAT-LOG.md` is the only place history is preserved.

Exception: keep a one-line rationale where a reader would otherwise re-propose the dropped idea (e.g. "assets are flat-namespaced, which is why bytes don't all live there"). One line, stated as a constraint — not a narrative of what we used to think.

## 5. Verification standard

Claims about GitHub's limits or behaviour must be checked against `docs.github.com` and marked ✅ verified / ⚠️ needs spike / 🧪 speculative. Never state an API limit from memory.

## 6. Reference clones

`reference/` holds read-only clones — `GitGalleryApp` (fork base) and `immich` (UI ground truth). Never edit them; they are for reading.
