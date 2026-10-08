# Manual accessibility test (keyboard and screen reader)

The automatic scan in CI (axe, three browsers) checks what a machine can decide: contrast, labels, target size, ARIA rules. It cannot tell whether the **order makes sense**, whether a **screen reader says the right thing**, or whether you can **finish a task without a mouse**. This script covers that. It is the manual half of QA checklist rows A11Y-01 to A11Y-03, A11Y-05, A11Y-06 and A11Y-08, and it must be done before anyone states that the system meets WCAG 2.2 AA.

**Time:** about 2 hours for one person, once per release that changes screens. **Who:** anyone who can follow the steps; a person who uses a screen reader every day will find more, and their findings outrank this script.

## Set-up

- **Browsers and tools:** Windows, **NVDA** (free, nvaccess.org) with **Firefox**; repeat the keyboard part in **Chrome or Edge**. Optional: Narrator with Edge.
- **Where:** a development copy, or a test account created for this. Do not use a real nurse's record: the script creates and edits data.
- **Accounts:** one **HR Admin** (the longest path) and one **Employee**.
- **Mouse:** unplug it, or do not touch it, for Parts 1 and 2.
- **Record results** in the table at the end: what you did, what you heard or saw, and the page.

## Part 1. Keyboard only (A11Y-01, A11Y-02)

Keys: **Tab / Shift+Tab** move, **Enter / Space** activate, **Arrows** move inside menus, tabs and lists, **Esc** closes.

| # | Do this | Pass when | Watch for |
|---|---|---|---|
| K1 | Open the sign-in page. Press Tab once. | A visible focus ring appears on the first control. | Focus ring missing or hidden by the header. |
| K2 | Sign in with e-mail, password and the 6-digit code, using only the keyboard. | You reach the dashboard. Enter submits. | A control you cannot reach; focus lost after the code step. |
| K3 | **Skip to content.** After a page loads, press Tab once. Press Enter. | A "Skip to main content" link appears at the top and is the first Tab stop; Enter moves focus to the page content, past the side menu (WCAG 2.4.1). In Arabic it appears on the right. | The link not appearing, or focus staying in the menu. (CI checks that the link exists and works; you check that it is clear.) |
| K4 | Walk the side menu with Tab and Enter. | Every item is reachable, the current page is announced or marked, Enter opens it. | A collapsed menu hiding items from the keyboard. |
| K5 | **Onboard an employee:** Nurses → Onboard employee. Fill every field, choose from every dropdown, submit once with a required field missing, then correct it. | Dropdowns open with Enter or Down arrow and close with Esc; the error is reachable; the save works. | Focus jumping to the top of the page; a date picker you cannot operate. |
| K6 | Open a **dialog** (Edit unit). Tab through it. Press Esc. | Focus stays inside while it is open. Esc closes it, and focus **returns to the button that opened it**. | Focus escaping to the page behind; focus landing at the top of the page after closing. |
| K7 | **Credentials:** add a credential with a document upload, then open the review queue. | The file chooser opens from the keyboard; the new row is reachable. | An upload button that works only with a mouse. |
| K8 | **Roster:** open Scheduling, add a nurse to a shift, publish the week. | Every step can be done without a mouse. Any drag-and-drop has a button or menu alternative. | **Drag-only controls** (WCAG 2.5.7). |
| K9 | Open a table with many rows. Tab to a row's action menu. | Actions are reachable and named. | Hover-only actions. |
| K10 | With the keyboard, switch **language** to Arabic and back; toggle **dark mode**. | Both work; in Arabic the Tab order follows the right-to-left layout. | Focus order running against the reading direction. |
| K11 | Tab so the focus is near the top and bottom edges of the page. | The focused control is never fully hidden by the sticky header or a banner (2.4.11). | A focused field hidden behind the sticky header. |
| K12 | Sign out. | You return to sign-in and focus is on the page. | — |

## Part 2. Screen reader (A11Y-03)

Start NVDA (Ctrl+Alt+N). Useful keys: **Down arrow** reads the next line, **Tab** the next control, **H** the next heading, **D** the next landmark, **T** the next table, **F** the next form field, **NVDA+F7** lists headings, links and landmarks, **NVDA+Space** toggles browse and focus mode. Turn on the **Speech Viewer** (NVDA menu → Tools) to see exactly what was said.

| # | Do this | Pass when | Watch for |
|---|---|---|---|
| S1 | Load the sign-in page. | The page title is spoken; each field says its **name** ("Email, edit"), its type, and "required" if it is. | Fields announced as "edit" with no name. |
| S2 | Submit sign-in with a wrong password. | The error is **spoken without you moving** (live region) and says what to do. | Silence: the error is only visible. |
| S3 | On the dashboard, press **D**, then **H**. | Landmarks exist (header, navigation, main); headings give a sensible outline. | No main landmark; every heading the same level. |
| S4 | **Page changes.** Choose another menu item. | NVDA announces the new page (title or heading), not silence. | The page changes with no announcement: a common single-page-app failure. |
| S5 | Open Nurses and press **T**. Move through the table with Ctrl+Alt+arrows. | Column headers are announced with each cell; the row count is available. | Cells read with no header; a table used for layout. |
| S6 | Use the **filter dropdowns** above the table. | Each says what it filters ("Filter by unit, combo box"). | A bare "combo box". (The scan fixed six of these; check the rest.) |
| S7 | Open the **Edit unit** dialog. | NVDA says "dialog" and its title, focus is inside, and closing returns you to the button. | The dialog opens silently. |
| S8 | Save with a required field missing. | The field in error is named and the message is read ("Name is required"). | A red border with no spoken error. |
| S9 | Save successfully. | A **success message is announced** ("Saved"). | A message that is seen but not spoken. |
| S10 | Provoke the **"Someone else saved a change"** warning: edit the same unit in two windows, save both. | The warning is announced, and the dialog closing is not disorienting. | The message disappears before it is read. |
| S11 | Check **status tags** (Valid, Expired, Ineligible). | Meaning is spoken as text, not only shown by colour. | A coloured dot with no text. |
| S12 | Open Guidelines, search for a word, open a result. | Results are announced; the heading of the opened section is read. | — |
| S13 | Switch to Arabic. | NVDA reads Arabic text with an Arabic voice; layout is right-to-left. | English labels left behind in the Arabic view. |

## Part 3. Zoom, reflow and spacing (A11Y-05)

| # | Do this | Pass when |
|---|---|---|
| Z1 | Browser zoom to **200%**. Visit sign-in, Nurses, Scheduling, one dialog. | Nothing is cut off or overlapped; all controls remain usable. |
| Z2 | Zoom to **400%** (equal to a 320 px wide window). | The page reflows to one column; no sideways scrolling except for wide tables, which scroll inside their own area. |
| Z3 | Apply a text-spacing bookmarklet (line height 1.5, letter spacing 0.12 em, word spacing 0.16 em, paragraph spacing 2 em). | No text is clipped or overlaps. |
| Z4 | **Windows high contrast** (Left Alt + Left Shift + Print Screen) on the sign-in page and a table. | Text, borders and icons stay visible. |

## Part 4. Errors, sign-in and time (A11Y-06, A11Y-08)

| # | Do this | Pass when |
|---|---|---|
| E1 | Sign in with a **password manager**, and by **pasting** the password. | Both work; the 6-digit code accepts a paste, with or without the space. |
| E2 | Leave a page idle until the **session timeout warning** (60 minutes idle in production; shorten it in a development copy). | The warning is announced by the screen reader, and staying signed in is possible by keyboard. |
| E3 | Submit forms with wrong data: a bad date, an e-mail without "@", a file that is too big. | Each error says what is wrong **and how to fix it**. |
| E4 | Is the help (user guide link) in the same place on every page? | Yes. |

## Known gaps to confirm

- **Focus and announcement after a page change** (S4): confirm what NVDA says when you navigate.
- **Messages** (S9, S10): confirm they are in a live region.

## Record

| Date | Tester | Tools (NVDA version, browser) | Items that failed | Notes / issue link |
|---|---|---|---|---|
| | | | | |

## Reading the result

- **All pass:** record the date and tools in the QA checklist rows A11Y-01, A11Y-03, A11Y-05, A11Y-06 and A11Y-08.
- **Any fail:** open one issue per failure with the item number (for example "K6: focus is lost after closing Edit unit"). Fix it, then repeat only that item.
- **No claim of WCAG conformance** is made until this script and a dark-mode scan have passed.
