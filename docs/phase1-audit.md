# Phase 1 audit: input focus, project deletion, customer sync

Scope: `web/youandme.html`, the single-file site (Arabic, cinematic intro, rotating
"&", super admin console). The React + Node app under `web/src` and `server/` is a
separate application and was not changed.

## What the site is today

All data lives in the visitor's own browser (`localStorage` key
`bizora_platform_v1`). There is no server, database or Firebase in this file.
The super admin login (`admin@youandme.com` / `admin123`) and every owner's
password are stored in plain text in the page and in `localStorage`.

## Problem C: new projects not appearing for customers

Two causes, one fixable here and one architectural.

1. **Saving silently stopped after about 27 projects.** Every project stored its
   own copy of a ~170KB section cover image. `localStorage` holds about 5MB, so
   after ~27 projects (fewer with product photos) `save()` threw
   `QuotaExceededError`. The throw happened before `renderDirectory()`, so the
   new project never showed in the list and was gone after a reload. Edits and
   status changes were lost the same way.
   Reproduced headlessly: project 28 onwards stayed in memory only, and a
   reload brought the count back to 27.
   **Fixed:** covers are stored as a short reference (`ym-section:gym`) and
   restored on load. 60 projects now take 70KB instead of hitting the quota at
   27. Existing saved data is compacted on first load with nothing dropped
   (tested: 1.85MB of old-format data became 11.6KB, all projects intact).
   `save()` now returns `false` and shows a clear message instead of throwing,
   and project creation rolls back if it could not be saved.

2. **Each browser has its own private copy of the data.** A project created on
   the owner's phone can never reach a customer's phone, whatever the code does,
   because there is no shared database. This needs a backend (see "Decision
   needed" below).
   **Partly fixed:** tabs on the same device now stay in step through the
   `storage` event instead of overwriting each other's saves.

## Problem B: projects cannot be deleted

There was no delete action anywhere in the code. The super admin could only
disable a project, and disabled projects still appeared in the public list.

**Fixed:**

- "أرشفة المشروع (حذف)" in the super admin's project control dialog, with a
  confirmation. The project leaves the public list, search, counters, hero
  stats and owner login, but its sales and invoices are kept.
- A "مؤرشف (محذوف)" filter in the projects table lists archived projects with
  "استرجاع" (restore) and "حذف نهائي" (permanent delete). Permanent delete asks
  the admin to type the project name.
- Disabled and archived projects are hidden from the public directory, and
  opening one by link shows "هذا المشروع غير متاح حاليًا".

## Problem A: inputs freezing after one character

Not reproduced in this version. Every visible text field in every view and
modal (directory, all owner dashboard sections, all 11 modals, public booking)
was typed into in headless Chromium at desktop and iPhone 13 sizes; every field
kept focus and received the full text.

Two related defects were fixed:

- The phone validator added another `input` listener each time the owner
  profile opened (`bindPhone`), so listeners piled up during a session.
- A `MutationObserver` on the whole page re-ran every button binding on every
  DOM change, including each animation frame of the effects. It now runs at
  most once per frame.

The quota bug above is a plausible source of the "frozen" feeling: when a save
threw, the create dialog stayed open with its fields uncleared and nothing
happened on click.

## Also fixed

`window.state` was always `undefined` (a top-level `let` is not a `window`
property), so the hero stats and counters that read it always showed 0. They
now show real numbers, counting public projects only.

## Decision needed: shared backend

Real cross-device sync, approval workflow, Google sign-in and secure admin
roles all need a server. Options:

- **Firebase** (Auth + Firestore + Hosting), as the master prompt asks. Needs a
  Firebase project created under the owner's Google account. The free Spark
  plan covers Auth, Firestore and Hosting; Cloud Functions need the paid Blaze
  plan.
- **The Node + SQLite/PostgreSQL API already in this repo** (`server/`), which
  already has JWT auth, roles, ownership checks and 126 tests, but needs a host.

## How this was tested

Headless Chromium (Playwright) against the file, external network blocked:

| Check | Result |
| --- | --- |
| Create 60 projects, reload | 60 kept, 70KB stored, no errors |
| Old-format data (1.85MB) opened in new version | 10/10 projects, 11.6KB, covers resolve |
| Archive in tab 1 | tab 2 list updates to 59 without reload |
| Open archived project by id | refused |
| Restore, archive again, permanent delete with wrong name | kept |
| Permanent delete with correct name, reload | gone |
| Disabled project | hidden from directory |
| Type into every visible field, desktop and iPhone 13 | no focus loss |
| Home and projects screenshots before/after | identical |
