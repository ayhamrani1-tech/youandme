# you&me — design notes

## Brief

A Jordanian booking platform holding five unrelated worlds: a floodlit football
pitch at night, a men's barber shop, a women's salon, a dental clinic, a gym.
Audience: Arabic-first consumers on phones, plus small business owners running
their shop from a laptop. The job: find a place near you, see the price, take a
time.

Carried over from the previous prototype, at the client's request: Arabic RTL
default, the Cairo typeface, the deep-navy base, the you&me wordmark, and
Jordanian localisation (governorates, 077/078/079 numbers, GPS).

## The idea

**The five sections carry the colour; the platform is the quiet frame.** A
multi-section marketplace has one real design problem — knowing which world you
are in — so section identity does the work that decoration usually does. The
platform chrome stays navy, bone-white and a single brass accent; each section
owns one hue, used as a leading edge, an icon tint and a meter fill, never as a
full-bleed gradient wash.

## Tokens

### Colour

| Token | Value | Role |
| --- | --- | --- |
| `--ink` | `#0B1220` | page base — navy, slightly warmer than the prototype's near-black |
| `--ink-raise` | `#121C2E` | raised surfaces, tables, panels |
| `--ink-line` | `#1E2A3E` | hairlines and borders |
| `--paper` | `#EEF2F8` | primary text (15:1 on ink) |
| `--paper-dim` | `#93A1B8` | secondary text |
| `--brass` | `#D9A334` | the single interactive accent |

Brass on deep navy, rather than the prototype's blue→violet gradient on
everything: warmer, reads as Amman after dark, and leaves the spectrum free for
the sections to use.

Section hues — wayfinding, not decoration:

| Section | Hue | |
| --- | --- | --- |
| Sports fields | `#2E9E5B` | pitch green under floodlights |
| Barber | `#C9873D` | brass and leather |
| Salon | `#D4557F` | rose |
| Dental clinic | `#3EA8C4` | clinical cyan |
| Gyms | `#7C66E0` | violet |

### Type

Two families, clearly distinct in job:

- **Cairo** — Arabic and all UI text. Kept from the existing brand; humanist,
  reads well at small sizes in both scripts.
- **Space Grotesk** — Latin display and every number: prices, times, player
  counts, point balances, distances. Its slightly mechanical cut suits a
  scoreboard, and tabular figures keep columns of prices aligned.

Scale: 12 · 14 · 16 · 18 · 22 · 28 · 36 · 46 · 60. Body measure under 70
characters.

### Layout

Rows, not a grid of cards. Results are scannable lines with a hue leading edge
and the price set large in tabular figures — the two things someone actually
compares. Radii vary by role (chips 8, panels 16, the hero 24) rather than one
radius on everything.

```
┌──────────────────────────────────────────────────────────────┐
│  you&me                        [ع|EN]  [دخول]  [إنشاء حساب] │
├────────────────────────────────┬─────────────────────────────┤
│  احجز مكانك.                   │  ▎ملاعب        ١٢ حصة      │
│  خمس خدمات، منصة واحدة.         │  ▎حلاقة        ٣ كراسي     │
│                                │  ▎تجميل        ٥ مواعيد    │
│  ┌──────────────────────────┐  │  ▎أسنان        مفتوح       │
│  │ ملعب الأبطال · ٢١:٠٠     │  │  ▎نوادي        ٤ قريبة     │
│  │ ███████████▌░░░   ١١/١٤  │  │                            │
│  │ ٣ لاعبين وتبدأ المباراة   │  │                            │
│  │ ٤.٥٠ د.أ للفرد   [انضم]  │  │                            │
│  └──────────────────────────┘  │                            │
└────────────────────────────────┴─────────────────────────────┘
```

The hero's focal element is the **player-quota meter**, not a big number with a
gradient. Needing three more players for the match to happen is the most
characteristic thing this platform does, so it is the first thing shown.

## Principles

1. Sections own the colour. Chrome is navy, bone and brass.
2. Numbers are privileged: larger than their labels, tabular, in Space Grotesk.
3. Rows over cards. A hue edge instead of a box.
4. One unprompted motion: the quota meter filling on load. Everything else
   animates only in answer to something the person did.
5. RTL is the default. Logical properties throughout, so English costs nothing.

## Checked against the generic defaults

- Not cream + serif + terracotta.
- Not near-black + one acid accent: navy + brass, chosen for continuity and for
  leaving the spectrum to the sections.
- Not a broadsheet.
- Not the uniform-card kit: rows, varied radii, no blanket drop shadow, no
  glassmorphism blur.
- No all-caps eyebrow labels, no `A · B · C` meta strings, no `→` inside button
  text, no monospace micro-labels, no `01 / 02 / 03` markers (nothing here is a
  sequence except the gym explainer, which is genuinely stepped).
